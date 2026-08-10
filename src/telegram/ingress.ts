import { createHash } from "node:crypto";
import { hashSecret } from "../crypto";
import type { Job } from "../domain/models";
import type { MergeHandler } from "../services/merge-handler";
import {
  OWNER_MEMORY_SCOPE,
  type OutboxInput,
  type ProjectPolicyRecord,
  type TelegramAgentStore,
  type TelegramStatusOutboxStore,
} from "../storage/store";
import { detectStandingInstruction } from "../controller/context";
import { containsCredentialLikeText } from "../domain/state-machine";
import type { HealthReport } from "../services/health-report";
import {
  telegramUpdateSchema,
  type SendMessagePayload,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramUpdate,
} from "./types";
import {
  ephemeralTelegramPayload,
  parseCallbackData,
  persistableJobStatusPayload,
  renderJobStatus,
  type CallbackAction,
} from "./view";
import { TelegramRequestError } from "./client";
import { TelegramApiError } from "./errors";

export type TelegramIngressTransport = {
  sendMessage(chatId: string, payload: SendMessagePayload): Promise<{ message_id: number }>;
  editMessage(chatId: string, messageId: number, payload: SendMessagePayload): Promise<void>;
  answerCallback(callbackQueryId: string, text: string): Promise<void>;
};

export type TelegramIngressAuditReason =
  | "unauthorized_message"
  | "unauthorized_callback"
  | "missing_callback_message"
  | "malformed_callback"
  | "invalid_callback"
  | "unknown_callback_job"
  | "callback_message_mismatch";

export type TelegramIngressAuditRecord = Readonly<{
  reason: TelegramIngressAuditReason;
  updateId: number;
  userId: string | null;
  chatId: string | null;
  chatType: "private" | "group" | "supergroup" | "channel" | "unknown";
  isBot: boolean;
}>;

export type TelegramIngressAuditLogger = (record: TelegramIngressAuditRecord) => void;

export type TelegramIngressOptions = {
  store: TelegramAgentStore;
  telegram: TelegramIngressTransport;
  auditLogger?: TelegramIngressAuditLogger;
  mergeHandler?: Pick<MergeHandler, "handleApprovalCallback">;
  onWorkAvailable?: () => void;
  health?: (now: number) => HealthReport;
};

const PRIVATE_ID = /^[1-9][0-9]*$/;
const MAX_TASK_TEXT = 4_000;
const MAX_AUDIT_RECORDS = 256;
const STATUS_LOGICAL_SUFFIX = ":status";

function stableControllerKey(userId: string, chatId: string): string {
  return createHash("sha256")
    .update(`telegram-controller:${userId}:${chatId}`, "utf8")
    .digest("base64url")
    .slice(0, 32);
}

function numericIdentity(value: number): string | null {
  if (!Number.isSafeInteger(value) || value < 1) return null;
  const identity = String(value);
  return PRIVATE_ID.test(identity) ? identity : null;
}

function privateHumanIdentity(
  from: { id: number; is_bot: boolean },
  chat: { id: number; type: string },
): { userId: string; chatId: string } | null {
  if (from.is_bot || chat.type !== "private") return null;
  const userId = numericIdentity(from.id);
  const chatId = numericIdentity(chat.id);
  return userId && chatId ? { userId, chatId } : null;
}

function ownerMatches(
  store: TelegramAgentStore,
  identity: { userId: string; chatId: string },
): boolean {
  const owner = store.getOwner();
  return owner !== null && owner.userId === identity.userId && owner.chatId === identity.chatId;
}

function boundedText(value: string): string | null {
  const text = value.trim();
  return text.length > 0 && text.length <= MAX_TASK_TEXT ? text : null;
}

function callbackJobId(action: CallbackAction): string | null {
  return "jobId" in action ? action.jobId : null;
}

function jobIsTerminal(job: Job): boolean {
  return ["merged", "cancelled", "blocked", "complete", "production_failed"].includes(job.state);
}

function callbackMessageMatches(job: Job, callback: TelegramCallbackQuery): boolean {
  if (!callback.message) return false;
  return job.statusMessageId !== null && job.statusMessageId === callback.message.message_id;
}

function safeAuditChatType(value: string | undefined): TelegramIngressAuditRecord["chatType"] {
  if (value === "private" || value === "group" || value === "supergroup" || value === "channel") {
    return value;
  }
  return "unknown";
}

function boundedAuditLogger(logger: TelegramIngressAuditLogger | undefined): TelegramIngressAuditLogger {
  let count = 0;
  return (record) => {
    if (count >= MAX_AUDIT_RECORDS) return;
    count += 1;
    if (!logger) return;
    logger({ ...record });
  };
}

function orderedProjects(
  projects: readonly ProjectPolicyRecord[],
  lastProject: string | null,
): ProjectPolicyRecord[] {
  if (!lastProject) return [...projects];
  return [...projects].sort((left, right) => {
    const leftLast = left.policy.projectId === lastProject ? 0 : 1;
    const rightLast = right.policy.projectId === lastProject ? 0 : 1;
    return leftLast - rightLast || left.policy.alias.localeCompare(right.policy.alias);
  });
}

function safeOutcome(value: string): string {
  return value.length <= 500 ? value : value.slice(0, 499) + "…";
}

function isTypedTelegramDeliveryError(error: unknown): boolean {
  return error instanceof TelegramApiError || error instanceof TelegramRequestError;
}

export class TelegramIngress {
  private readonly store: TelegramAgentStore;
  private readonly telegram: TelegramIngressTransport;
  private readonly auditLogger: TelegramIngressAuditLogger;
  private readonly mergeHandler: Pick<MergeHandler, "handleApprovalCallback"> | null;
  private readonly onWorkAvailable: () => void;
  private readonly health: ((now: number) => HealthReport) | null;

  public constructor(options: TelegramIngressOptions);
  public constructor(store: TelegramAgentStore, telegram: TelegramIngressTransport);
  public constructor(
    optionsOrStore: TelegramIngressOptions | TelegramAgentStore,
    telegram?: TelegramIngressTransport,
  ) {
    if ("store" in optionsOrStore) {
      this.store = optionsOrStore.store;
      this.telegram = optionsOrStore.telegram;
      this.auditLogger = boundedAuditLogger(optionsOrStore.auditLogger);
      this.mergeHandler = optionsOrStore.mergeHandler ?? null;
      this.onWorkAvailable = optionsOrStore.onWorkAvailable ?? (() => undefined);
      this.health = optionsOrStore.health ?? null;
    } else {
      if (!telegram) throw new TypeError("Telegram ingress requires a Telegram client");
      this.store = optionsOrStore;
      this.telegram = telegram;
      this.auditLogger = boundedAuditLogger(undefined);
      this.mergeHandler = null;
      this.onWorkAvailable = () => undefined;
      this.health = null;
    }
  }

  public async handleClaimed(update: TelegramUpdate, now: number): Promise<void> {
    if (!Number.isInteger(now) || now < 0) throw new TypeError("now must be a non-negative integer");
    const parsed = telegramUpdateSchema.safeParse(update);
    if (!parsed.success) return;
    if (parsed.data.message) {
      await this.handleMessage(parsed.data.message, parsed.data.update_id, now);
      return;
    }
    if (parsed.data.callback_query) {
      await this.handleCallback(parsed.data.callback_query, parsed.data.update_id, now);
    }
  }

  private async handleMessage(message: TelegramMessage, updateId: number, now: number): Promise<void> {
    const identity = privateHumanIdentity(message.from, message.chat);
    const text = message.text;
    if (text === undefined) return;

    const pairingCode = this.pairingCode(text);
    if (pairingCode !== null) {
      if (!identity) {
        this.audit("unauthorized_message", updateId, message.from, message.chat);
        return;
      }
      const result = this.store.pairOwnerWithPrivateChatCode(
        hashSecret(pairingCode),
        identity.userId,
        identity.chatId,
        now,
      );
      if (result.ok) {
        await this.telegram.sendMessage(identity.chatId, {
          text: "Telegram Agent paired. Talk naturally with Luna, or use /help for recovery controls.",
          disable_web_page_preview: true,
        });
      }
      return;
    }

    if (!identity || !ownerMatches(this.store, identity)) {
      this.audit("unauthorized_message", updateId, message.from, message.chat);
      return;
    }
    const normalized = boundedText(text);
    if (normalized === null) return;

    const command = /^\/(\w+)(?:\s|$)/.exec(normalized)?.[1]?.toLowerCase();
    if (command === "help") {
      await this.sendPlain(identity.chatId, "Talk naturally. Reply to the active status message to steer implementation, or use /status, /projects, /health, /retry, and /cancel for recovery.");
      return;
    }
    if (command === "projects") {
      await this.sendProjects(identity.chatId);
      return;
    }
    if (command === "health") {
      await this.sendPlain(identity.chatId, this.healthSummary(now));
      return;
    }

    const active = this.store.getActiveJob();
    if (command === "status") {
      if (active) await this.deliverJobView(active, renderJobStatus(active), identity.chatId, message.message_id, now);
      else await this.sendPlain(identity.chatId, "No active job.");
      return;
    }
    if (command === "cancel") {
      if (active) await this.cancelJob(active, identity.chatId, message.message_id, now);
      else await this.sendPlain(identity.chatId, "No active job.");
      return;
    }
    if (command === "retry") {
      if (active?.state === "failed") await this.retryJob(active, identity.chatId, message.message_id, now);
      else await this.sendPlain(identity.chatId, "No retryable job is active.");
      return;
    }

    if (active && message.reply_to_message?.message_id === active.statusMessageId) {
      this.steer(active, normalized, updateId, now);
      return;
    }

    const controllerKey = stableControllerKey(identity.userId, identity.chatId);
    // The agent asked something and is blocked on it. A reply now is the answer,
    // not a new request to line up behind the answer it is waiting to give.
    if (this.store.getPendingControllerQuestion(controllerKey)) {
      const answered = this.store.answerControllerQuestionWithText({ controllerKey, text: normalized, now });
      if (answered.ok) {
        this.rememberStandingInstruction(normalized, answered.turnId, now);
        this.onWorkAvailable();
        return;
      }
    }

    const turn = this.store.enqueueControllerTurn({
      controllerKey,
      telegramUserId: identity.userId,
      telegramChatId: identity.chatId,
      updateId,
      inputText: normalized,
      now,
    });
    this.rememberStandingInstruction(normalized, turn.id, now);
    this.onWorkAvailable();
  }

  // "Always ship on Fridays" is an instruction, not chatter. Capturing it at
  // intake means it outlives the turn even if the answer itself fails.
  private rememberStandingInstruction(text: string, turnId: string, now: number): void {
    const instruction = detectStandingInstruction(text);
    // Silently declining a secret keeps the message flowing; refusing the whole
    // update would cost the owner their answer as well.
    if (!instruction || containsCredentialLikeText(instruction.body)) return;
    this.store.rememberMemory({
      scope: OWNER_MEMORY_SCOPE,
      kind: instruction.kind,
      subject: instruction.subject,
      body: instruction.body,
      importance: 0.9,
      confidence: 0.9,
      source: "owner",
      sourceTurnId: turnId,
      now,
    });
  }

  private pairingCode(text: string): string | null {
    const match = /^\/start(?:@[A-Za-z0-9_]+)?\s+(\S+)$/.exec(text.trim());
    return match?.[1] ?? null;
  }

  private async handleCallback(callback: TelegramCallbackQuery, updateId: number, now: number): Promise<void> {
    if (!callback.message) {
      this.audit("missing_callback_message", updateId, callback.from, undefined);
      return;
    }
    const identity = privateHumanIdentity(callback.from, callback.message.chat);
    if (!identity || !ownerMatches(this.store, identity)) {
      this.audit("unauthorized_callback", updateId, callback.from, callback.message.chat);
      return;
    }

    let action: CallbackAction;
    try {
      action = parseCallbackData(callback.data ?? "");
    } catch {
      this.audit("malformed_callback", updateId, callback.from, callback.message.chat);
      return;
    }
    if (action.type === "merge") {
      if (!this.mergeHandler) {
        this.audit("invalid_callback", updateId, callback.from, callback.message.chat);
        return;
      }
      const identity = privateHumanIdentity(callback.from, callback.message.chat);
      if (!identity) {
        this.audit("unauthorized_callback", updateId, callback.from, callback.message.chat);
        return;
      }
      const result = await this.mergeHandler.handleApprovalCallback({
        callbackId: callback.id,
        nonce: action.nonce,
        userId: identity.userId,
        chatId: identity.chatId,
      });
      this.enqueueCallbackAnswer(
        callback.id,
        identity.chatId,
        result.outcome === "accepted" ? "Merge queued." : "Approval is stale or no longer valid.",
        now,
      );
      return;
    }
    if (action.type === "thread_interaction") {
      const answered = this.store.answerThreadInteraction({
        token: action.token,
        userId: identity.userId,
        chatId: identity.chatId,
        now,
      });
      const recorded = this.store.recordCallback(
        callback.id,
        null,
        "thread_interaction",
        answered.ok ? "accepted" : answered.reason,
        now,
      );
      if (recorded) {
        this.enqueueCallbackAnswer(
          callback.id,
          identity.chatId,
          answered.ok ? answered.label : "That thread is no longer waiting on you.",
          now,
        );
      }
      if (answered.ok && recorded) this.onWorkAvailable();
      return;
    }
    if (action.type === "question") {
      const answered = this.store.answerControllerQuestion({
        token: action.token,
        userId: identity.userId,
        chatId: identity.chatId,
        now,
      });
      const recorded = this.store.recordCallback(
        callback.id,
        null,
        "controller_question",
        answered.ok ? "accepted" : answered.reason,
        now,
      );
      if (recorded) {
        this.enqueueCallbackAnswer(
          callback.id,
          identity.chatId,
          answered.ok ? "Got it." : "That question is no longer open.",
          now,
        );
      }
      if (answered.ok && recorded) this.onWorkAvailable();
      return;
    }
    if (action.type === "operation") {
      const result = this.store.confirmThreadOperation({
        nonceHash: hashSecret(action.nonce),
        userId: identity.userId,
        chatId: identity.chatId,
        messageId: callback.message.message_id,
        now,
      });
      const outcome = result.ok ? "accepted" : result.reason;
      const recorded = this.store.recordCallback(
        callback.id,
        null,
        "thread_operation",
        outcome,
        now,
      );
      if (recorded) {
        this.enqueueCallbackAnswer(
          callback.id,
          identity.chatId,
          result.ok ? "Thread operation queued." : "Confirmation is stale or no longer valid.",
          now,
        );
      }
      if (result.ok && recorded) this.onWorkAvailable();
      return;
    }
    const jobId = callbackJobId(action);
    if (jobId === null) {
      this.audit("invalid_callback", updateId, callback.from, callback.message.chat);
      return;
    }
    const job = this.store.getJob(jobId);
    if (!job) {
      this.audit("unknown_callback_job", updateId, callback.from, callback.message.chat);
      return;
    }
    if (!callbackMessageMatches(job, callback)) {
      this.audit("callback_message_mismatch", updateId, callback.from, callback.message.chat);
      return;
    }

    switch (action.type) {
      case "project":
        await this.selectProject(job, action.alias, callback, identity.chatId, now);
        return;
      case "start":
        await this.startJob(job, callback, identity.chatId, now);
        return;
      case "cancel":
        await this.cancelJob(job, identity.chatId, callback.message.message_id, now, callback);
        return;
      case "retry":
        await this.retryJob(job, identity.chatId, callback.message.message_id, now, callback);
        return;
      case "review":
        await this.reviewJob(job, identity.chatId, callback.message.message_id, now, callback);
        return;
    }
  }

  private async selectProject(
    job: Job,
    alias: string,
    callback: TelegramCallbackQuery,
    chatId: string,
    now: number,
  ): Promise<void> {
    const record = this.store.getProjectPolicyByAlias(alias);
    if (!record || !record.policy.enabled) return;

    let selected = job;
    if (job.state === "awaiting_project") {
      selected = this.store.applyJobEvent(
        job.id,
        job.version,
        {
          type: "PROJECT_SELECTED",
          projectId: record.policy.projectId,
          policyVersion: record.version,
          policy: record.policy,
        },
        now,
      );
      await this.store.setLastProject(record.policy.projectId);
    } else if (
      job.state !== "awaiting_confirmation" ||
      job.projectId !== record.policy.projectId ||
      job.policyVersion !== record.version
    ) {
      return;
    }

    await this.deliverJobView(selected, renderJobStatus(selected), chatId, callback.message?.message_id, now);
    await this.finishCallback(callback.id, selected.id, chatId, "project", "accepted", now, "Project selected.");
  }

  private async startJob(
    job: Job,
    callback: TelegramCallbackQuery,
    chatId: string,
    now: number,
  ): Promise<void> {
    let started = job;
    if (job.state === "awaiting_confirmation") {
      started = this.store.applyJobEvent(job.id, job.version, { type: "CONFIRMED" }, now);
    } else if (!this.hasStartEffect(job)) {
      await this.finishCallback(callback.id, job.id, chatId, "start", "rejected", now, "Start is no longer available.");
      return;
    }

    await this.deliverJobView(started, renderJobStatus(started), chatId, callback.message?.message_id, now);
    await this.finishCallback(callback.id, started.id, chatId, "start", "accepted", now, "Job started.");
  }

  private hasStartEffect(job: Job): boolean {
    return this.store.listEffectsForJob(job.id).some((effect) =>
      effect.kind === "spawn_plan" || effect.kind === "spawn_implementation");
  }

  private async cancelJob(
    job: Job,
    chatId: string,
    messageId: number,
    now: number,
    callback?: TelegramCallbackQuery,
  ): Promise<void> {
    let cancelled = job;
    if (job.cancelRequestedAt === null && !jobIsTerminal(job)) {
      cancelled = this.store.applyJobEvent(
        job.id,
        job.version,
        { type: "CANCEL_REQUESTED", activeWorker: this.store.getWorkerLiveness(job.id) },
        now,
      );
    }
    if (callback) {
      await this.deliverJobView(cancelled, renderJobStatus(cancelled), chatId, messageId, now);
      await this.finishCallback(callback.id, cancelled.id, chatId, "cancel", "accepted", now, "Cancellation requested.");
    } else {
      await this.deliverJobView(cancelled, renderJobStatus(cancelled), chatId, messageId, now);
    }
  }

  private async retryJob(
    job: Job,
    chatId: string,
    messageId: number,
    now: number,
    callback?: TelegramCallbackQuery,
  ): Promise<void> {
    if (job.state !== "failed") return;
    const retried = this.store.applyJobEvent(job.id, job.version, { type: "RETRY" }, now);
    await this.deliverJobView(retried, renderJobStatus(retried), chatId, messageId, now);
    if (callback) await this.finishCallback(callback.id, retried.id, chatId, "retry", "accepted", now, "Retry scheduled.");
  }

  private async reviewJob(
    job: Job,
    chatId: string,
    messageId: number,
    now: number,
    callback?: TelegramCallbackQuery,
  ): Promise<void> {
    if (job.state !== "blocked" || job.blockedReason !== "review_limit") return;
    const reviewed = this.store.applyJobEvent(job.id, job.version, { type: "CONTINUE_REVIEW" }, now);
    await this.deliverJobView(reviewed, renderJobStatus(reviewed), chatId, messageId, now);
    if (callback) await this.finishCallback(callback.id, reviewed.id, chatId, "review", "accepted", now, "Review continued.");
  }

  private steer(job: Job, text: string, updateId: number, now: number): void {
    if (!job.implementationThreadId || jobIsTerminal(job)) return;
    this.store.enqueueSteeringEffect(job.id, updateId, job.implementationThreadId, text, now);
  }

  private async finishCallback(
    callbackId: string,
    jobId: string,
    chatId: string,
    action: string,
    outcome: string,
    now: number,
    answer: string,
  ): Promise<void> {
    const recorded = this.store.recordCallback(callbackId, jobId, action, safeOutcome(outcome), now);
    if (recorded || this.store.getOutbox(`callback:${callbackId}`)?.status !== "sent") {
      this.enqueueCallbackAnswer(callbackId, chatId, answer, now);
    }
  }

  private enqueueCallbackAnswer(callbackId: string, chatId: string, answer: string, now: number): void {
    this.store.enqueueOutbox({
      logicalKey: `callback:${callbackId}`,
      chatId,
      payload: { text: answer },
    }, now);
  }

  // Answered from durable state rather than from the agent, so it still works
  // when the agent itself is the thing that is stuck.
  private healthSummary(now: number): string {
    if (!this.health) return "Health reporting is unavailable.";
    const report = this.health(now);
    if (report.ok) {
      return [
        "All good.",
        `Executor: running (generation ${report.executor.generation ?? "none"})`,
        `Queue: ${report.work.pendingEffects} job step(s), ${report.delivery.pendingOutbox} message(s) waiting`,
        `Watching: ${report.monitors.armed} monitor(s)`,
        `Memory: ${report.memory.live} kept`,
      ].join("\n");
    }
    return [`Problems:\n${report.problems.map((problem) => `- ${problem}`).join("\n")}`,
      `Executor: ${report.executor.current ? "running" : "not running"}`,
      `Queue: ${report.work.pendingEffects} job step(s), ${report.delivery.pendingOutbox} message(s) waiting`,
    ].join("\n");
  }

  private async sendProjects(chatId: string): Promise<void> {
    const lastProject = await this.store.getLastProject();
    const projects = orderedProjects(this.store.listEnabledProjectPolicies(), lastProject);
    const aliases = projects.map((project) => project.policy.alias);
    const text = aliases.length > 0
      ? `Enabled projects:\n${aliases.join("\n")}`
      : "No enabled projects are configured.";
    await this.sendPlain(chatId, text);
  }

  private async sendPlain(chatId: string, text: string): Promise<void> {
    await this.telegram.sendMessage(chatId, { text, disable_web_page_preview: true });
  }

  private setStatusMessageAndOutbox(
    job: Job,
    messageId: number,
    outbox: OutboxInput,
    now: number,
  ): Job {
    const atomicStore = this.store as Partial<TelegramStatusOutboxStore>;
    if (typeof atomicStore.setJobStatusMessageAndOutbox === "function") {
      return atomicStore.setJobStatusMessageAndOutbox(job.id, messageId, job.version, outbox, now);
    }
    const updated = this.store.setJobStatusMessage(job.id, messageId, job.version, now);
    this.store.enqueueOutbox(outbox, now);
    return updated;
  }

  private audit(
    reason: TelegramIngressAuditReason,
    updateId: number,
    from: { id: number; is_bot: boolean },
    chat: { id: number; type: string } | undefined,
  ): void {
    this.auditLogger({
      reason,
      updateId,
      userId: numericIdentity(from.id),
      chatId: chat ? numericIdentity(chat.id) : null,
      chatType: safeAuditChatType(chat?.type),
      isBot: from.is_bot,
    });
  }

  private async deliverJobView(
    job: Job,
    payload: SendMessagePayload,
    chatId: string,
    callbackMessageId: number | undefined,
    now: number,
  ): Promise<Job> {
    let current = this.store.getJob(job.id) ?? job;
    let messageId = current.statusMessageId;
    const logicalKey = `job:${current.id}${STATUS_LOGICAL_SUFFIX}`;
    const outbox = (outboxMessageId: number | null): OutboxInput => ({
      logicalKey,
      chatId,
      messageId: outboxMessageId,
      payload: persistableJobStatusPayload(payload),
    });
    if (messageId !== null) {
      this.store.enqueueOutbox(outbox(messageId), now);
      try {
        await this.telegram.editMessage(chatId, messageId, ephemeralTelegramPayload(payload));
      } catch (error) {
        if (!isTypedTelegramDeliveryError(error)) throw error;
      }
    } else if (callbackMessageId !== undefined) {
      const intent = outbox(callbackMessageId);
      this.store.enqueueOutbox(intent, now);
      try {
        await this.telegram.editMessage(chatId, callbackMessageId, ephemeralTelegramPayload(payload));
      } catch (error) {
        if (!isTypedTelegramDeliveryError(error)) throw error;
        return current;
      }
      current = this.setStatusMessageAndOutbox(current, callbackMessageId, intent, now);
    } else {
      const intent = outbox(null);
      this.store.enqueueOutbox(intent, now);
      let sent: { message_id: number };
      try {
        sent = await this.telegram.sendMessage(chatId, ephemeralTelegramPayload(payload));
      } catch (error) {
        if (!isTypedTelegramDeliveryError(error)) throw error;
        return current;
      }
      current = this.setStatusMessageAndOutbox(
        current,
        sent.message_id,
        { ...intent, messageId: sent.message_id },
        now,
      );
    }
    return current;
  }
}
