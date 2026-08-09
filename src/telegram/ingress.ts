import { createHash } from "node:crypto";
import { hashSecret } from "../crypto";
import type { Job } from "../domain/models";
import type {
  OutboxInput,
  ProjectPolicyRecord,
  TelegramAgentStore,
} from "../storage/store";
import {
  telegramUpdateSchema,
  type SendMessagePayload,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramUpdate,
} from "./types";
import { parseCallbackData, renderJobStatus, renderProjectPicker, type CallbackAction } from "./view";

export type TelegramIngressTransport = {
  sendMessage(chatId: string, payload: SendMessagePayload): Promise<{ message_id: number }>;
  editMessage(chatId: string, messageId: number, payload: SendMessagePayload): Promise<void>;
  answerCallback(callbackQueryId: string, text: string): Promise<void>;
};

export type TelegramIngressOptions = {
  store: TelegramAgentStore;
  telegram: TelegramIngressTransport;
};

const PRIVATE_ID = /^[1-9][0-9]*$/;
const MAX_TASK_TEXT = 4_000;
const STATUS_LOGICAL_SUFFIX = ":status";

export function stableJobId(chatId: string, updateId: number): string {
  if (typeof chatId !== "string" || !PRIVATE_ID.test(chatId)) {
    throw new TypeError("chatId must be a canonical positive decimal string");
  }
  if (!Number.isInteger(updateId) || updateId < 0) {
    throw new TypeError("updateId must be a non-negative integer");
  }
  return createHash("sha256")
    .update(`telegram-job:${chatId}:${updateId}`, "utf8")
    .digest("base64url")
    .slice(0, 22);
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
  return ["merged", "cancelled", "blocked"].includes(job.state);
}

function callbackMessageMatches(job: Job, callback: TelegramCallbackQuery): boolean {
  if (!callback.message) return false;
  return job.statusMessageId === null || job.statusMessageId === callback.message.message_id;
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

export class TelegramIngress {
  private readonly store: TelegramAgentStore;
  private readonly telegram: TelegramIngressTransport;

  public constructor(options: TelegramIngressOptions);
  public constructor(store: TelegramAgentStore, telegram: TelegramIngressTransport);
  public constructor(
    optionsOrStore: TelegramIngressOptions | TelegramAgentStore,
    telegram?: TelegramIngressTransport,
  ) {
    if ("store" in optionsOrStore) {
      this.store = optionsOrStore.store;
      this.telegram = optionsOrStore.telegram;
    } else {
      if (!telegram) throw new TypeError("Telegram ingress requires a Telegram client");
      this.store = optionsOrStore;
      this.telegram = telegram;
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
      await this.handleCallback(parsed.data.callback_query, now);
    }
  }

  private async handleMessage(message: TelegramMessage, updateId: number, now: number): Promise<void> {
    const identity = privateHumanIdentity(message.from, message.chat);
    const text = message.text;
    if (text === undefined) return;

    const pairingCode = this.pairingCode(text);
    if (pairingCode !== null) {
      if (!identity) return;
      const result = this.store.pairOwnerWithPrivateChatCode(
        hashSecret(pairingCode),
        identity.userId,
        identity.chatId,
        now,
      );
      if (result.ok) {
        await this.telegram.sendMessage(identity.chatId, {
          text: "Telegram Agent paired. Send a task to begin.",
          disable_web_page_preview: true,
        });
      }
      return;
    }

    if (!identity || !ownerMatches(this.store, identity)) return;
    const normalized = boundedText(text);
    if (normalized === null) return;

    const command = /^\/(\w+)(?:\s|$)/.exec(normalized)?.[1]?.toLowerCase();
    if (command === "help") {
      await this.sendPlain(identity.chatId, "Send a task, reply to the active status message to steer it, or use /status, /projects, and /cancel.");
      return;
    }
    if (command === "projects") {
      await this.sendProjects(identity.chatId);
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

    if (active) {
      if (message.reply_to_message?.message_id === active.statusMessageId) {
        this.steer(active, normalized, updateId, now);
      } else {
        await this.sendPlain(identity.chatId, "Reply to the current job status message to steer it, or use its buttons.");
      }
      return;
    }

    const job = this.store.createJob({
      id: stableJobId(identity.chatId, updateId),
      sourceUpdateId: updateId,
      requestText: normalized,
      now,
    });
    const lastProject = await this.store.getLastProject();
    const projects = orderedProjects(this.store.listEnabledProjectPolicies(), lastProject);
    if (job.statusMessageId === null) {
      await this.deliverJobView(job, renderProjectPicker(job, projects), identity.chatId, undefined, now);
    }
  }

  private pairingCode(text: string): string | null {
    const match = /^\/start(?:@[A-Za-z0-9_]+)?\s+(\S+)$/.exec(text.trim());
    return match?.[1] ?? null;
  }

  private async handleCallback(callback: TelegramCallbackQuery, now: number): Promise<void> {
    if (!callback.message) return;
    const identity = privateHumanIdentity(callback.from, callback.message.chat);
    if (!identity || !ownerMatches(this.store, identity)) return;

    let action: CallbackAction;
    try {
      action = parseCallbackData(callback.data ?? "");
    } catch {
      return;
    }
    const jobId = callbackJobId(action);
    if (jobId === null) return;
    const job = this.store.getJob(jobId);
    if (!job || !callbackMessageMatches(job, callback)) return;

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
      case "merge":
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
    await this.finishCallback(callback.id, selected.id, "project", "accepted", now, "Project selected.");
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
    } else if (!this.hasSpawnEffect(job)) {
      await this.finishCallback(callback.id, job.id, "start", "rejected", now, "Start is no longer available.");
      return;
    }

    await this.deliverJobView(started, renderJobStatus(started), chatId, callback.message?.message_id, now);
    await this.finishCallback(callback.id, started.id, "start", "accepted", now, "Job started.");
  }

  private hasSpawnEffect(job: Job): boolean {
    return this.store.listEffectsForJob(job.id).some((effect) => effect.kind === "spawn_implementation");
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
      cancelled = this.store.applyJobEvent(job.id, job.version, { type: "CANCEL_REQUESTED", activeWorker: null }, now);
    }
    if (callback) {
      await this.deliverJobView(cancelled, renderJobStatus(cancelled), chatId, messageId, now);
      await this.finishCallback(callback.id, cancelled.id, "cancel", "accepted", now, "Cancellation requested.");
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
    if (callback) await this.finishCallback(callback.id, retried.id, "retry", "accepted", now, "Retry scheduled.");
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
    if (callback) await this.finishCallback(callback.id, reviewed.id, "review", "accepted", now, "Review continued.");
  }

  private steer(job: Job, text: string, updateId: number, now: number): void {
    if (!job.implementationThreadId || jobIsTerminal(job)) return;
    this.store.enqueueSteeringEffect(job.id, updateId, job.implementationThreadId, text, now);
  }

  private async finishCallback(
    callbackId: string,
    jobId: string,
    action: string,
    outcome: string,
    now: number,
    answer: string,
  ): Promise<void> {
    const recorded = this.store.recordCallback(callbackId, jobId, action, safeOutcome(outcome), now);
    if (recorded) await this.telegram.answerCallback(callbackId, answer);
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

  private async deliverJobView(
    job: Job,
    payload: SendMessagePayload,
    chatId: string,
    callbackMessageId: number | undefined,
    now: number,
  ): Promise<Job> {
    let current = this.store.getJob(job.id) ?? job;
    let messageId = current.statusMessageId;
    if (messageId !== null) {
      await this.telegram.editMessage(chatId, messageId, payload);
    } else if (callbackMessageId !== undefined) {
      await this.telegram.editMessage(chatId, callbackMessageId, payload);
      current = this.store.setJobStatusMessage(current.id, callbackMessageId, current.version, now);
      messageId = callbackMessageId;
    } else {
      const sent = await this.telegram.sendMessage(chatId, payload);
      current = this.store.setJobStatusMessage(current.id, sent.message_id, current.version, now);
      messageId = sent.message_id;
    }

    const outbox: OutboxInput = {
      logicalKey: `${current.id}${STATUS_LOGICAL_SUFFIX}`,
      chatId,
      messageId,
      payload: payload as unknown as Record<string, unknown>,
    };
    this.store.enqueueOutbox(outbox, now);
    return current;
  }
}
