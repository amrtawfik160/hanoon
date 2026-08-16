import { randomBytes as nodeRandomBytes } from "node:crypto";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { hashSecret } from "../crypto";
import type { EffectFence } from "../services/effect-runner";
import type {
  ControllerMutationFence,
  TelegramAgentStore,
  ThreadOperation,
  ThreadOperationKind,
} from "../storage/store";
import type { SendMessagePayload } from "../telegram/types";
import { encodeCallbackData } from "../telegram/view";

const OPERATION_TTL_MS = 15 * 60_000;
const STOPPABLE_STATUSES = new Set(["active", "starting", "stopping"]);

export type OperationRequest =
  | { kind: "steer_thread"; threadId: string; text: string; signal: AbortSignal }
  | { kind: "stop_thread" | "retry_thread"; threadId: string; signal: AbortSignal };

type Dependencies = {
  store: TelegramAgentStore;
  sdk: BbPluginApi["sdk"];
  telegram: { sendMessage(chatId: string, payload: SendMessagePayload): Promise<{ message_id: number }> };
  pluginId: string;
  clock: { now(): number };
  randomBytes?: (size: number) => Buffer;
};

export class ThreadOperationFenceLostError extends Error {
  public constructor() {
    super("The controller turn changed while preparing the thread operation");
    this.name = "ThreadOperationFenceLostError";
  }
}

function confirmationLabel(kind: ThreadOperationKind): string {
  if (kind === "steer_thread") return "Send steering";
  if (kind === "stop_thread") return "Stop thread";
  return "Retry thread";
}

function safeTitle(title: string | null, threadId: string): string {
  return (title ?? threadId).replace(/\s+/g, " ").trim().slice(0, 120);
}

function operationSecret(bytes: number, randomBytes: (size: number) => Buffer): string {
  return randomBytes(bytes).toString("base64url");
}

export class ThreadOperationService {
  private readonly randomBytes: (size: number) => Buffer;

  public constructor(private readonly dependencies: Dependencies) {
    this.randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
  }

  public async request(input: OperationRequest & { controllerFence: ControllerMutationFence }) {
    const owner = this.dependencies.store.getOwner();
    if (!owner) throw new Error("Thread operations require the paired Telegram owner");
    const thread = await this.dependencies.sdk.threads.get({ threadId: input.threadId, signal: input.signal });
    this.assertEligibleTarget(thread, input.kind);
    const nonce = operationSecret(24, this.randomBytes);
    const operation = this.runControllerMutation(input.controllerFence, (now) =>
      this.dependencies.store.createThreadOperation({
        id: operationSecret(16, this.randomBytes),
        nonceHash: hashSecret(nonce),
        ownerUserId: owner.userId,
        ownerChatId: owner.chatId,
        kind: input.kind,
        threadId: input.threadId,
        text: input.kind === "steer_thread" ? input.text : null,
        expiresAt: now + OPERATION_TTL_MS,
        now,
      }));
    try {
      const delivered = await this.dependencies.telegram.sendMessage(
        owner.chatId,
        this.confirmationPayload(operation, nonce, safeTitle(thread.title, thread.id)),
      );
      const awaiting = this.runControllerMutation(input.controllerFence, (now) =>
        this.dependencies.store.markThreadOperationConfirmationSent(operation.id, delivered.message_id, now));
      return { id: awaiting.id, kind: awaiting.kind, threadId: awaiting.threadId, state: awaiting.state, expiresAt: awaiting.expiresAt };
    } catch (error) {
      if (error instanceof ThreadOperationFenceLostError) throw error;
      this.runControllerMutation(input.controllerFence, (now) =>
        this.dependencies.store.failThreadOperationConfirmation(operation.id, now));
      throw error;
    }
  }

  private runControllerMutation<T>(
    fence: ControllerMutationFence,
    mutation: (now: number) => T,
  ): T {
    const mutationOutcome = this.dependencies.store.runControllerMutation(
      { ...fence, now: this.dependencies.clock.now() },
      mutation,
    );
    if (mutationOutcome.outcome === "stale") throw new ThreadOperationFenceLostError();
    return mutationOutcome.mutationValue;
  }

  public async processOne(fence: EffectFence, signal: AbortSignal): Promise<boolean> {
    const now = this.dependencies.clock.now();
    if (this.dependencies.store.failStaleThreadOperations({ ...fence, now })) return true;
    const operation = this.dependencies.store.claimNextThreadOperation({ ...fence, now });
    if (!operation) return false;
    try {
      const thread = await this.dependencies.sdk.threads.get({ threadId: operation.threadId, signal });
      this.assertEligibleTarget(thread, operation.kind);
      const result = await this.execute(operation);
      if (!this.dependencies.store.completeThreadOperation({ ...fence, id: operation.id, result, now: this.dependencies.clock.now() })) {
        throw new Error("Thread operation fence changed before completion");
      }
    } catch {
      this.dependencies.store.failThreadOperation({
        ...fence,
        id: operation.id,
        error: "Thread operation failed safely",
        now: this.dependencies.clock.now(),
      });
    }
    return true;
  }

  private assertEligibleTarget(
    thread: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>,
    kind: ThreadOperationKind,
  ): void {
    if (thread.visibility !== "visible" || thread.archivedAt !== null || thread.deletedAt !== null) {
      throw new Error("Thread operations require a current visible BB thread");
    }
    if (thread.originPluginId === this.dependencies.pluginId || this.dependencies.store.findJobByThreadId(thread.id)) {
      throw new Error("Telegram Agent managed threads must use their guarded job controls");
    }
    if (kind === "stop_thread" && !STOPPABLE_STATUSES.has(thread.status)) {
      throw new Error("Only a running BB thread can be stopped");
    }
    if (kind === "retry_thread" && thread.status !== "error") {
      throw new Error("Only an errored BB thread can be retried");
    }
    if (kind === "steer_thread" && thread.status === "error") {
      throw new Error("An errored BB thread must be retried before steering");
    }
  }

  private confirmationPayload(operation: ThreadOperation, nonce: string, title: string): SendMessagePayload {
    const label = confirmationLabel(operation.kind);
    return {
      text: `${label} for “${title}”?\nThis confirmation expires in 15 minutes.`,
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{
          text: `Confirm: ${label}`,
          callback_data: encodeCallbackData({ type: "operation", nonce }),
        }]],
      },
    };
  }

  private async execute(operation: ThreadOperation): Promise<string> {
    if (operation.kind === "steer_thread") {
      if (!operation.text) throw new Error("Steer operation has no text");
      await this.dependencies.sdk.threads.send({
        threadId: operation.threadId,
        mode: "auto",
        input: [{ type: "text", text: operation.text, mentions: [] }],
      });
      return "Steering sent";
    }
    if (operation.kind === "stop_thread") {
      await this.dependencies.sdk.threads.stop({ threadId: operation.threadId });
      return "Stop requested";
    }
    const recovery = await this.dependencies.sdk.threads.rateLimitRecovery({ threadId: operation.threadId });
    if (recovery.reason !== "eligible" || !recovery.candidate) {
      throw new Error("Thread is not eligible for a safe provider retry");
    }
    await this.dependencies.sdk.threads.continueAfterRateLimit({
      threadId: operation.threadId,
      failedRequestId: recovery.candidate.failedRequestId,
      // The owner asked for this retry, so it is theirs rather than the
      // provider-retry plugin's automatic resumption.
      mode: "manual",
    });
    return "Retry requested";
  }
}
