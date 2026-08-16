import { randomUUID } from "node:crypto";
import { abortableSleep, withAbortDeadline } from "../async";
import type { TelegramAgentStore, ControllerVoiceClaim } from "../storage/store";
import {
  MAX_CONTROLLER_VOICE_BYTES,
  voiceTooLargeToTranscribe,
  voiceUnavailableNotice,
  type VoiceTranscriber,
  type VoiceUnavailableReason,
} from "../telegram/voice";

const MAX_CONTROLLER_INPUT_CHARACTERS = 4_000;
const VOICE_DOWNLOAD_TIMEOUT_MS = 30_000;
const VOICE_TRANSCRIBE_TIMEOUT_MS = 120_000;
const VOICE_WORK_LEASE_MS = 300_000;
const IDLE_WAIT_MS = 1_000;

type ControllerVoiceStore = Pick<
  TelegramAgentStore,
  | "claimNextControllerVoice"
  | "completeControllerVoiceWithTurn"
  | "completeControllerVoiceWithNotice"
  | "releaseControllerVoice"
>;

export type ControllerVoiceServiceDependencies = Readonly<{
  store: ControllerVoiceStore;
  voice: Readonly<{
    download(fileId: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>;
    transcribe: VoiceTranscriber;
  }> | null;
  clock: Readonly<{ now(): number }>;
  onWorkAvailable?: () => void;
  waitForWork?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  warn?: (message: string) => void;
  ownerId?: string;
}>;

export class ControllerVoiceService {
  private readonly ownerId: string;

  public constructor(private readonly dependencies: ControllerVoiceServiceDependencies) {
    this.ownerId = dependencies.ownerId ?? `voice-${randomUUID()}`;
  }

  public async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const processed = await this.processOne(signal);
      if (processed || signal.aborted) continue;
      try {
        if (this.dependencies.waitForWork) {
          await this.dependencies.waitForWork(IDLE_WAIT_MS, signal);
        } else {
          await abortableSleep(IDLE_WAIT_MS, signal);
        }
      } catch {
        return;
      }
    }
  }

  public async processOne(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const claim = this.dependencies.store.claimNextControllerVoice({
      ownerId: this.ownerId,
      now: this.dependencies.clock.now(),
      leaseMs: VOICE_WORK_LEASE_MS,
    });
    if (!claim) return false;

    try {
      if (voiceTooLargeToTranscribe(claim)) {
        this.settleNotice(claim, "too_large");
        return true;
      }
      const voice = this.dependencies.voice;
      if (!voice) {
        this.settleNotice(claim, "no_service");
        return true;
      }

      let bytes: Uint8Array;
      try {
        bytes = await withAbortDeadline(
          signal,
          VOICE_DOWNLOAD_TIMEOUT_MS,
          (operationSignal) => voice.download(claim.fileId, MAX_CONTROLLER_VOICE_BYTES, operationSignal),
        );
      } catch {
        if (signal.aborted) return true;
        this.settleNotice(claim, "unreadable");
        return true;
      }

      let transcript: Awaited<ReturnType<VoiceTranscriber>>;
      try {
        transcript = await withAbortDeadline(
          signal,
          VOICE_TRANSCRIBE_TIMEOUT_MS,
          (operationSignal) => voice.transcribe({
            bytes,
            mimeType: claim.mimeType,
            signal: operationSignal,
          }),
        );
      } catch {
        if (signal.aborted) return true;
        this.settleNotice(claim, "unreadable");
        return true;
      }

      if (transcript.outcome !== "transcribed") {
        this.settleNotice(
          claim,
          transcript.outcome === "unavailable"
            ? "no_service"
            : transcript.outcome === "empty"
              ? "empty"
              : "unreadable",
        );
        return true;
      }

      const spoken = transcript.text.trim();
      const combined = claim.caption === null || claim.caption.trim().length === 0
        ? spoken
        : `${claim.caption.trim()}\n\n${spoken}`;
      if (combined.length === 0) {
        this.settleNotice(claim, "empty");
        return true;
      }
      if (combined.length > MAX_CONTROLLER_INPUT_CHARACTERS) {
        this.settleNotice(claim, "transcript_too_long");
        return true;
      }

      const settled = this.dependencies.store.completeControllerVoiceWithTurn({
        updateId: claim.updateId,
        ownerId: claim.claimOwner,
        generation: claim.claimGeneration,
        inputText: combined,
        now: this.dependencies.clock.now(),
      });
      if (settled.outcome === "completed" && settled.settlement !== "discarded") {
        this.dependencies.onWorkAvailable?.();
      }
      return true;
    } catch (error) {
      if (signal.aborted) return true;
      const message = error instanceof Error ? error.message : String(error);
      this.dependencies.store.releaseControllerVoice({
        updateId: claim.updateId,
        ownerId: claim.claimOwner,
        generation: claim.claimGeneration,
        error: message.slice(0, 500),
        now: this.dependencies.clock.now(),
      });
      this.dependencies.warn?.(`Controller voice ${claim.updateId} failed: ${message.slice(0, 500)}`);
      // Let the run loop pace an unexpected persistent failure instead of
      // reclaiming the same row in a hot loop.
      return false;
    }
  }

  private settleNotice(claim: ControllerVoiceClaim, reason: VoiceUnavailableReason): void {
    const settled = this.dependencies.store.completeControllerVoiceWithNotice({
      updateId: claim.updateId,
      ownerId: claim.claimOwner,
      generation: claim.claimGeneration,
      notice: voiceUnavailableNotice(reason),
      reason,
      now: this.dependencies.clock.now(),
    });
    if (settled.outcome === "completed" && settled.settlement !== "discarded") {
      this.dependencies.onWorkAvailable?.();
    }
  }
}
