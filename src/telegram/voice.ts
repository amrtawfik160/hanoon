import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TelegramMessage } from "./types";

/**
 * Telegram caps a bot download at 20 MB and a voice note is orders of magnitude
 * smaller, so this bound is about a mistaken send rather than a real note: an
 * hour-long recording is not a message and transcribing it would stall the turn
 * it arrived in.
 */
export const MAX_CONTROLLER_VOICE_BYTES = 20 * 1024 * 1024;

/** Long enough for anything spoken to a phone, short enough not to hang a turn. */
export const MAX_CONTROLLER_VOICE_SECONDS = 20 * 60;

export type ControllerVoiceNote = {
  fileId: string;
  /** What Telegram said it is; the transcriber needs it and guesses badly. */
  mimeType: string;
  sizeBytes: number | null;
  durationSeconds: number;
  /** A voice note is speech to the owner; an audio file may be music. */
  kind: "voice" | "audio";
};

export type VoiceTranscriber = (input: {
  bytes: Uint8Array;
  mimeType: string;
  signal: AbortSignal;
}) => Promise<string | null>;

/** Telegram omits the type on some clients; opus in ogg is what it sends. */
const DEFAULT_VOICE_MIME_TYPE = "audio/ogg";

export function controllerVoiceFromMessage(message: TelegramMessage): ControllerVoiceNote | null {
  const voice = message.voice;
  if (voice) {
    return {
      fileId: voice.file_id,
      mimeType: voice.mime_type ?? DEFAULT_VOICE_MIME_TYPE,
      sizeBytes: voice.file_size ?? null,
      durationSeconds: voice.duration,
      kind: "voice",
    };
  }
  const audio = message.audio;
  if (!audio) return null;
  return {
    fileId: audio.file_id,
    mimeType: audio.mime_type ?? DEFAULT_VOICE_MIME_TYPE,
    sizeBytes: audio.file_size ?? null,
    durationSeconds: audio.duration,
    kind: "audio",
  };
}

export function voiceTooLargeToTranscribe(note: ControllerVoiceNote): boolean {
  if (note.sizeBytes !== null && note.sizeBytes > MAX_CONTROLLER_VOICE_BYTES) return true;
  return note.durationSeconds > MAX_CONTROLLER_VOICE_SECONDS;
}

/**
 * What the owner is told when a recording arrives and nothing can read it. Each
 * case names what to do instead, because "I can't" with no next step is a dead
 * end in a chat the owner cannot leave.
 */
export type VoiceUnavailableReason = "too_large" | "no_service" | "empty" | "unreadable";

export function voiceUnavailableNotice(reason: VoiceUnavailableReason): string {
  switch (reason) {
    case "too_large":
      return "That recording is too long for me to transcribe. Please send a shorter one, or type it.";
    case "empty":
      return "I could not make out anything in that recording. Please try again, or type it.";
    case "unreadable":
      return "I could not read that recording. Please send it again, or type it.";
    case "no_service":
      return "I cannot transcribe voice notes on this install: BB has no voice service configured. Please type it instead.";
  }
}

type CommandResult = { code: number | null; stdout: string };

function runCommand(
  file: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const onAbort = () => {
      child.kill("SIGKILL");
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    // Drained and dropped: a transcriber's diagnostics are not the owner's
    // message, and an unread pipe stalls the child once it fills.
    child.stderr.on("data", () => undefined);
    child.once("error", (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      resolve({ code, stdout: Buffer.concat(stdout).toString("utf8") });
    });
  });
}

/** The one field of `bb voice transcribe --json` this needs. */
export function parseTranscript(stdout: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed === null || typeof parsed !== "object") return null;
    const text = (parsed as { text?: unknown }).text;
    if (typeof text !== "string") return null;
    const trimmed = text.trim();
    return trimmed.length === 0 ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * Transcribe through BB's own configured voice service rather than a service of
 * ours. This plugin ships to people who are not its author, and a required API
 * key is a fresh install that does not work; BB already owns this decision for
 * the whole app, so an installation that has voice configured gets it free and
 * one that has not is told plainly.
 */
export const transcribeWithBb: VoiceTranscriber = async (input) => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-agent-voice-"));
  const sourcePath = join(directory, "note.bin");
  try {
    await writeFile(sourcePath, input.bytes);
    const result = await runCommand(
      "bb",
      ["voice", "transcribe", sourcePath, "--type", input.mimeType, "--json"],
      input.signal,
    );
    return result.code === 0 ? parseTranscript(result.stdout) : null;
  } catch {
    // A missing `bb` on PATH and a failed transcription are the same answer to
    // the caller: nothing was heard, so say so rather than guessing at words.
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
};
