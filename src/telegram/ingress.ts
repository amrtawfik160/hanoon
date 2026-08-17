import { createHash } from "node:crypto";
import { hashSecret } from "../crypto";
import {
  isResumablePermanentFailure,
  isResumablePlanBlock,
  isResumableReviewBlock,
  isReviewedPrCompletionBlock,
  isRetryableJob,
  type Job,
} from "../domain/models";
import type { MergeHandler } from "../services/merge-handler";
import {
  OWNER_MEMORY_SCOPE,
  type OutboxInput,
  type JobControlKind,
  type ProjectPolicyRecord,
  type TelegramAgentStore,
  type TelegramStatusOutboxStore,
} from "../storage/store";
import { detectStandingInstruction } from "../controller/context";
import { containsCredentialLikeText } from "../domain/state-machine";
import type { HealthReport } from "../services/health-report";
import { activationSummary } from "../services/runtime-identity";
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
  renderJobChoices,
  renderJobStatus,
  renderJobStatusSummary,
  type CallbackAction,
} from "./view";
import { TelegramRequestError } from "./client";
import { TelegramApiError } from "./errors";
import { MAX_CONTROLLER_IMAGE_BYTES, isMotionMedia } from "../controller/models";
import { captionlessPromptFor, clipTooLargeForDownload, controllerImageFromMessage } from "./image";
import { controllerVoiceFromMessage } from "./voice";

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
const CONTROL_JOB_ID = /^[A-Za-z0-9_-]{1,256}$/;
const STEERABLE_STATES = new Set<Job["state"]>(["implementing", "remediating"]);

type ControlResolution =
  | { outcome: "job"; job: Job }
  | { outcome: "none" }
  | { outcome: "choose"; jobs: Job[]; total: number };

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

/**
 * What the ingress did with the claim on the update it was handed. An answer
 * settles its own claim inside the answer's transaction, so the caller must not
 * settle it a second time; everything else leaves the claim for the caller.
 */
export type TelegramIngressOutcome = { updateSettled: boolean };

const UPDATE_STILL_CLAIMED: TelegramIngressOutcome = { updateSettled: false };

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

  public async handleClaimed(
    update: TelegramUpdate,
    now: number,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<TelegramIngressOutcome> {
    if (!Number.isInteger(now) || now < 0) throw new TypeError("now must be a non-negative integer");
    const parsed = telegramUpdateSchema.safeParse(update);
    if (!parsed.success) return UPDATE_STILL_CLAIMED;
    if (parsed.data.message) {
      // Only the answer path settles its own claim; every other message route
      // simply falls out, which is the ordinary "caller still owns it" case.
      return await this.handleMessage(parsed.data.message, parsed.data.update_id, now) ?? UPDATE_STILL_CLAIMED;
    }
    if (parsed.data.callback_query) {
      await this.handleCallback(parsed.data.callback_query, parsed.data.update_id, now);
    }
    return UPDATE_STILL_CLAIMED;
  }

  private async handleMessage(
    message: TelegramMessage,
    updateId: number,
    now: number,
  ): Promise<TelegramIngressOutcome | void> {
    const identity = privateHumanIdentity(message.from, message.chat);
    const image = controllerImageFromMessage(message);
    const voiceNote = controllerVoiceFromMessage(message);
    const text = message.text ?? (image ? message.caption ?? captionlessPromptFor(image) : undefined);
    // A recording carries no text yet, so it is the one message shape allowed
    // past here without one. Its words arrive below, after the sender is known
    // to be the owner: transcription is work, and a stranger does not get it.
    if (text === undefined && voiceNote === null) return;

    const pairingCode = text === undefined ? null : this.pairingCode(text);
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
    if (image && image.sizeBytes !== null && !isMotionMedia(image) && image.sizeBytes > MAX_CONTROLLER_IMAGE_BYTES) {
      await this.sendPlain(identity.chatId, "That image is larger than BB's 10 MB image limit. Please resend a smaller copy.");
      return;
    }
    if (image && isMotionMedia(image) && clipTooLargeForDownload(image) && !image.thumbnail) {
      await this.sendPlain(identity.chatId, "That clip is larger than Telegram lets me download. Please send a shorter video, a GIF, or a few screenshots.");
      return;
    }
    if (voiceNote !== null) {
      const controllerKey = stableControllerKey(identity.userId, identity.chatId);
      this.store.queueControllerVoice({
        updateId,
        controllerKey,
        telegramUserId: identity.userId,
        telegramChatId: identity.chatId,
        fileId: voiceNote.fileId,
        mimeType: voiceNote.mimeType,
        sizeBytes: voiceNote.sizeBytes,
        durationSeconds: voiceNote.durationSeconds,
        caption: message.caption?.trim() || null,
        now,
      });
      this.onWorkAvailable();
      return { updateSettled: true };
    }
    const said = text;
    if (said === undefined) return;

    const normalized = boundedText(said);
    if (normalized === null) return;

    const commandMatch = /^\/(\w+)(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/.exec(normalized);
    const command = commandMatch?.[1]?.toLowerCase();
    const commandArgument = commandMatch?.[2]?.trim() || null;
    if (command === "help") {
      await this.sendPlain(identity.chatId, "Talk naturally. Reply to a job status message to steer that implementation, or use /status, /projects, /health, /approvals, /resume, /retry, and /cancel for recovery.");
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
    // Granting standing approval is only ever a button tap, so it cannot be
    // produced by the agent misreading a sentence. Withdrawing it is the
    // fail-safe direction, so it is available here by name.
    if (command === "resume") {
      await this.sendPlain(identity.chatId, this.handleResumeCommand(commandArgument, now));
      return;
    }
    if (command === "approvals") {
      await this.sendPlain(identity.chatId, this.handleApprovalsCommand(commandArgument, identity, now));
      return;
    }

    if (command === "status" || command === "cancel" || command === "retry") {
      if (commandArgument !== null && !CONTROL_JOB_ID.test(commandArgument)) {
        await this.sendPlain(identity.chatId, "That job id is invalid.");
        return;
      }
      const replyMessageId = message.reply_to_message?.message_id ?? null;
      if (command === "status" && commandArgument === null && replyMessageId === null) {
        const jobs = this.store.listControlJobs("status", 8);
        await this.telegram.sendMessage(identity.chatId, this.withExecutorHealthWarning(renderJobStatusSummary({
          jobs: jobs.map((job) => ({ job, admission: this.store.getAdmission(job.id) })),
          total: this.store.countControlJobs("status"),
        }), now));
        return;
      }
      const resolution = this.resolveControlJob(command, commandArgument, replyMessageId);
      if (resolution.outcome === "choose") {
        if (command === "status") {
          await this.telegram.sendMessage(identity.chatId, this.withExecutorHealthWarning(renderJobStatusSummary({
            jobs: resolution.jobs.map((job) => ({ job, admission: this.store.getAdmission(job.id) })),
            total: resolution.total,
          }), now));
        } else {
          await this.telegram.sendMessage(
            identity.chatId,
            renderJobChoices(command, resolution.jobs, resolution.total),
          );
        }
        return;
      }
      if (resolution.outcome === "none") {
        await this.sendPlain(identity.chatId, command === "retry" ? "No retryable job." : "No matching job.");
        return;
      }
      if (command === "status") {
        await this.deliverJobView(resolution.job, this.renderStatus(resolution.job), identity.chatId, undefined, now);
      } else if (command === "cancel") {
        if (!this.controlEligible(resolution.job, "cancel")) {
          await this.sendPlain(identity.chatId, "That job cannot be cancelled.");
        } else {
          await this.cancelJob(resolution.job, identity.chatId, undefined, now);
        }
      } else if (!this.controlEligible(resolution.job, "retry")) {
        await this.sendPlain(identity.chatId, "That job is not retryable.");
      } else {
        await this.retryJob(resolution.job, identity.chatId, undefined, now);
      }
      return;
    }

    const replyMessageId = message.reply_to_message?.message_id;
    if (replyMessageId !== undefined) {
      const repliedJob = this.store.findJobByStatusMessageId(replyMessageId);
      if (repliedJob && this.canSteer(repliedJob, replyMessageId)) {
        this.steer(repliedJob, normalized, updateId, now);
        return;
      }
    }

    const controllerKey = stableControllerKey(identity.userId, identity.chatId);
    // The agent asked something and is blocked on it. A reply now is the answer,
    // not a new request to line up behind the answer it is waiting to give.
    if (this.store.getPendingControllerInteraction(controllerKey)) {
      const result = this.store.answerControllerInteractionTextUpdate({
        updateId,
        controllerKey,
        userId: identity.userId,
        chatId: identity.chatId,
        text: normalized,
        now,
      });
      if (result.outcome === "replay") return;
      const answered = result.answer;
      if (answered.ok) {
        this.rememberStandingInstruction(normalized, answered.turnId, now);
        this.onWorkAvailable();
        return { updateSettled: true };
      }
    }

    const turn = this.store.enqueueControllerTurn({
      controllerKey,
      telegramUserId: identity.userId,
      telegramChatId: identity.chatId,
      updateId,
      inputText: normalized,
      image,
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
    if (action.type === "merge" || action.type === "merge_always") {
      if (!this.mergeHandler) {
        this.audit("invalid_callback", updateId, callback.from, callback.message.chat);
        return;
      }
      const identity = privateHumanIdentity(callback.from, callback.message.chat);
      if (!identity) {
        this.audit("unauthorized_callback", updateId, callback.from, callback.message.chat);
        return;
      }
      // Resolved before the handler runs, because approving consumes the nonce
      // and the project can no longer be recovered from it afterwards.
      const grantProjectId = action.type === "merge_always"
        ? this.projectForApprovalNonce(action.nonce)
        : null;
      const result = await this.mergeHandler.handleApprovalCallback({
        callbackId: callback.id,
        nonce: action.nonce,
        userId: identity.userId,
        chatId: identity.chatId,
      });
      // The standing grant is only recorded when this merge was actually
      // approved: a stale button must not hand out lasting authority.
      const granted = result.outcome === "accepted" && grantProjectId !== null;
      if (granted) {
        this.store.grantMergeAuthority({
          projectId: grantProjectId,
          userId: identity.userId,
          chatId: identity.chatId,
          now,
        });
      }
      this.enqueueCallbackAnswer(
        callback.id,
        identity.chatId,
        result.outcome !== "accepted"
          ? "Approval is stale or no longer valid."
          : granted
            ? "Merge queued. I will not ask again for this project."
            : "Merge queued.",
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
    // `question` is the legacy `q:` prefix, still decodable for one release so a
    // migrated in-flight message stays answerable. Both settle the same durable
    // interaction: the answer, the callback record, and the acknowledgement all
    // commit together, and the executor is nudged only once they have.
    if (action.type === "controller_interaction" || action.type === "question") {
      const result = this.store.answerControllerInteractionByTokenAndRecordCallback({
        token: action.token,
        userId: identity.userId,
        chatId: identity.chatId,
        callbackId: callback.id,
        now,
      });
      if (result.answer.ok && result.recorded) this.onWorkAvailable();
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
      selected = this.store.selectProjectAndQueueAdmission({
        jobId: job.id,
        expectedVersion: job.version,
        projectId: record.policy.projectId,
        policyVersion: record.version,
        policy: record.policy,
        now,
      });
      await this.store.setLastProject(record.policy.projectId);
    } else if (
      job.state !== "awaiting_confirmation" ||
      job.projectId !== record.policy.projectId ||
      job.policyVersion !== record.version
    ) {
      return;
    }

    await this.deliverJobView(selected, this.renderStatus(selected), chatId, callback.message?.message_id, now);
    await this.finishCallback(callback.id, selected.id, chatId, "project", "accepted", now, "Project selected.");
    this.onWorkAvailable();
  }

  private async startJob(
    job: Job,
    callback: TelegramCallbackQuery,
    chatId: string,
    now: number,
  ): Promise<void> {
    let admission = this.store.getAdmission(job.id);
    if (job.state === "awaiting_confirmation" && admission === null) {
      admission = this.store.queueAdmission({
        jobId: job.id,
        expectedVersion: job.version,
        projectId: job.projectId ?? "",
        resumeEvent: "CONFIRMED",
        now,
      });
    }
    if (!admission || !["queued", "admitted"].includes(admission.state)) {
      await this.finishCallback(callback.id, job.id, chatId, "start", "rejected", now, "Start is no longer available.");
      return;
    }

    const queued = this.store.getJob(job.id) ?? job;
    await this.deliverJobView(queued, this.renderStatus(queued), chatId, callback.message?.message_id, now);
    await this.finishCallback(callback.id, queued.id, chatId, "start", "accepted", now, "Job queued.");
    this.onWorkAvailable();
  }

  private async cancelJob(
    job: Job,
    chatId: string,
    messageId: number | undefined,
    now: number,
    callback?: TelegramCallbackQuery,
  ): Promise<void> {
    let cancelled = job;
    if (job.cancelRequestedAt === null && !jobIsTerminal(job)) {
      const activeWorkers = this.store.getCurrentWorkerLiveness(job.id);
      cancelled = this.store.applyJobEvent(
        job.id,
        job.version,
        activeWorkers === null
          ? { type: "CANCEL_REQUESTED" }
          : { type: "CANCEL_REQUESTED", activeWorker: activeWorkers[0] ?? null, activeWorkers },
        now,
      );
      this.onWorkAvailable();
    }
    if (callback) {
      await this.deliverJobView(cancelled, this.renderStatus(cancelled), chatId, messageId, now);
      await this.finishCallback(callback.id, cancelled.id, chatId, "cancel", "accepted", now, "Cancellation requested.");
    } else {
      await this.deliverJobView(cancelled, this.renderStatus(cancelled), chatId, messageId, now);
    }
  }

  private async retryJob(
    job: Job,
    chatId: string,
    messageId: number | undefined,
    now: number,
    callback?: TelegramCallbackQuery,
  ): Promise<void> {
    if (isResumablePlanBlock(job) || isResumableReviewBlock(job) || isReviewedPrCompletionBlock(job)) {
      await this.reviewJob(job, chatId, messageId ?? job.statusMessageId ?? 0, now, callback);
      return;
    }
    if (job.state !== "failed" && !isResumablePermanentFailure(job)) return;
    const retryResult = this.store.retryFailedJob(job.id, job.version, now);
    if (retryResult.outcome === "unavailable") return;
    this.onWorkAvailable();
    await this.deliverJobView(retryResult.job, this.renderStatus(retryResult.job), chatId, messageId, now);
    if (callback) await this.finishCallback(callback.id, retryResult.job.id, chatId, "retry", "accepted", now, "Retry scheduled.");
  }

  private async reviewJob(
    job: Job,
    chatId: string,
    messageId: number,
    now: number,
    callback?: TelegramCallbackQuery,
  ): Promise<void> {
    if (job.state !== "blocked" ||
      (job.blockedReason !== "review_limit" && job.blockedReason !== "plan_limit" &&
        !isReviewedPrCompletionBlock(job))) return;
    const queued = this.store.requeueReviewAdmission(job.id, job.version, now);
    if (queued.outcome === "unavailable") return;
    const current = this.store.getJob(job.id) ?? job;
    const stillCleaningUp = queued.outcome === "still_cleaning_up";
    await this.deliverJobView(current, this.renderStatus(current), chatId, messageId, now);
    if (callback) {
      await this.finishCallback(
        callback.id,
        current.id,
        chatId,
        "review",
        stillCleaningUp ? "rejected" : "accepted",
        now,
        stillCleaningUp
          ? (isReviewedPrCompletionBlock(job)
            ? "Finish is still cleaning up."
            : isResumablePlanBlock(job) ? "Plan revision is still cleaning up." : "Review is still cleaning up.")
          : (isReviewedPrCompletionBlock(job)
            ? "Finish queued."
            : isResumablePlanBlock(job) ? "Plan revision queued." : "Review queued."),
      );
    }
    if (!stillCleaningUp) this.onWorkAvailable();
  }

  private steer(job: Job, text: string, updateId: number, now: number): void {
    if (!job.implementationThreadId || !this.canSteer(job, job.statusMessageId)) return;
    this.store.enqueueSteeringEffect(job.id, updateId, job.implementationThreadId, text, now);
  }

  private canSteer(job: Job, statusMessageId: number | null): boolean {
    const admission = this.store.getAdmission(job.id);
    return statusMessageId !== null && job.statusMessageId === statusMessageId &&
      admission?.state === "admitted" && job.cancelRequestedAt === null &&
      !jobIsTerminal(job) && STEERABLE_STATES.has(job.state) && job.implementationThreadId !== null;
  }

  private controlEligible(job: Job, kind: Exclude<JobControlKind, "status">): boolean {
    if (kind === "retry") return isRetryableJob(job);
    return !jobIsTerminal(job) && job.cancelRequestedAt === null;
  }

  private resolveControlJob(
    kind: JobControlKind,
    explicitJobId: string | null,
    replyMessageId: number | null,
  ): ControlResolution {
    if (explicitJobId !== null) {
      const job = this.store.getJob(explicitJobId);
      return job ? { outcome: "job", job } : { outcome: "none" };
    }
    if (replyMessageId !== null) {
      const job = this.store.findJobByStatusMessageId(replyMessageId);
      return job ? { outcome: "job", job } : { outcome: "none" };
    }
    const jobs = this.store.listControlJobs(kind, 8);
    if (jobs.length === 0) return { outcome: "none" };
    if (jobs.length === 1) return { outcome: "job", job: jobs[0] };
    return { outcome: "choose", jobs, total: this.store.countControlJobs(kind) };
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
  /**
   * `/approvals` lists which projects merge and deploy without asking;
   * `/approvals off <alias>` and `/approvals off` withdraw one or all of them.
   */
  private handleApprovalsCommand(
    argument: string | null,
    identity: { userId: string; chatId: string },
    now: number,
  ): string {
    const projects = this.store.listEnabledProjectPolicies();
    const live = projects.filter(({ policy }) => {
      const grant = this.store.getMergeAuthority(policy.projectId);
      return grant !== null && grant.revokedAt === null;
    });

    const offMatch = /^off(?:\s+(.+))?$/i.exec(argument ?? "");
    if (!offMatch) {
      if (live.length === 0) {
        return "No project merges without asking. I will request approval every time.\n\nTap \"Merge + deploy, and always from now on\" on an approval message to change that.";
      }
      const names = live.map(({ policy }) => `• ${policy.alias}`).join("\n");
      return `I merge and deploy these without asking:\n${names}\n\nSend /approvals off <name> to stop, or /approvals off for all of them.`;
    }

    const alias = offMatch[1]?.trim().toLowerCase() ?? null;
    const targets = alias === null ? live : live.filter(({ policy }) => policy.alias === alias);
    if (targets.length === 0) {
      return alias === null
        ? "Nothing to withdraw — no project merges without asking."
        : `No standing approval for "${alias}".`;
    }
    const withdrawn = targets.filter(({ policy }) => this.store.revokeMergeAuthority({
      projectId: policy.projectId,
      reason: "the owner withdrew it",
      now,
      userId: identity.userId,
      chatId: identity.chatId,
    }));
    return withdrawn.length === 1
      ? `Done. I will ask you before merging ${withdrawn[0].policy.alias} again.`
      : `Done. I will ask you before merging any of those ${withdrawn.length} projects again.`;
  }

  /**
   * `/resume` starts work again on a project the failure brake stopped.
   * This is the owner's manual override. The controller has a separate bounded
   * path that may clear one fingerprint once, but it cannot manufacture this
   * command or use it to erase the retained clear history.
   */
  private handleResumeCommand(argument: string | null, now: number): string {
    const paused = this.store.listPausedProjectAdmissions();
    if (paused.length === 0) return "Nothing is paused. All projects are taking work.";

    const aliases = new Map(
      this.store.listEnabledProjectPolicies().map(({ policy }) => [policy.projectId, policy.alias] as const),
    );
    const alias = argument?.trim().toLowerCase() || null;
    // A bare /resume always lists and never restarts, including when only one
    // project is paused. The brake tripped because something kept failing, so
    // restarting has to be something the owner asked for by name.
    if (alias === null) {
      const names = paused
        .map((entry) => `• ${aliases.get(entry.projectId) ?? entry.projectId} — ${entry.reason}`)
        .join("\n");
      return `These projects are paused:\n${names}\n\nSend /resume <name> to start one, or /resume all for every one of them.`;
    }

    if (alias === "all") {
      const cleared = this.store.clearProjectAdmissionPause({ now });
      return cleared === 1
        ? "Done. That project is taking work again."
        : `Done. Those ${cleared} projects are taking work again.`;
    }
    const target = paused.find((entry) => (aliases.get(entry.projectId) ?? entry.projectId) === alias);
    if (!target) return `"${alias}" is not paused.`;
    this.store.clearProjectAdmissionPause({ projectId: target.projectId, now });
    return `Done. ${alias} is taking work again.`;
  }

  private pausedLine(): string | null {
    const paused = this.store.listPausedProjectAdmissions();
    if (paused.length === 0) return null;
    const aliases = new Map(
      this.store.listEnabledProjectPolicies().map(({ policy }) => [policy.projectId, policy.alias] as const),
    );
    const names = paused.map((entry) => aliases.get(entry.projectId) ?? entry.projectId).join(", ");
    return `Paused after repeated failures: ${names} — send /resume to start again`;
  }

  private healthSummary(now: number): string {
    if (!this.health) return "Health reporting is unavailable.";
    const report = this.health(now);
    const paused = this.pausedLine();
    const activation = report.activation === null
      ? []
      : [`Activation: ${report.activation.ok ? "current" : "ACTIVATION MISMATCH"} (${activationSummary(report.activation)})`];
    if (report.ok && paused === null) {
      return [
        "All good.",
        ...activation,
        `Executor: running (generation ${report.executor.generation ?? "none"})`,
        `Queue: ${report.work.pendingEffects} job step(s), ${report.delivery.pendingOutbox} message(s) waiting`,
        `Watching: ${report.monitors.armed} monitor(s)`,
        `Memory: ${report.memory.live} kept`,
      ].join("\n");
    }
    return [
      ...activation,
      report.problems.length > 0
        ? `Problems:\n${report.problems.map((problem) => `- ${problem}`).join("\n")}`
        : "Running, but not everything is taking work.",
      ...(paused === null ? [] : [paused]),
      `Executor: ${report.executor.current ? "running" : "not running"}`,
      `Queue: ${report.work.pendingEffects} job step(s), ${report.delivery.pendingOutbox} message(s) waiting`,
    ].join("\n");
  }

  private withExecutorHealthWarning(payload: SendMessagePayload, now: number): SendMessagePayload {
    if (!this.health) return payload;
    try {
      const report = this.health(now);
      if (report.executor.current) return payload;
      const problem = report.executor.heartbeatStale
        ? "the executor heartbeat is stale"
        : report.problems.find((candidate) => candidate.startsWith("the executor "));
      return {
        ...payload,
        text: `Executor warning: ${problem ?? "the executor is not running"}.\n\n${payload.text}`,
      };
    } catch {
      // Status remains useful if the optional health probe itself is unavailable.
      return payload;
    }
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

  /**
   * The project a pending approval belongs to, or null when the nonce is
   * unknown, already spent, or its job has no project. Never throws: a bad
   * lookup must degrade to an ordinary merge, not lose the owner's tap.
   */
  private projectForApprovalNonce(nonce: string): string | null {
    try {
      const approval = this.store.getApproval(hashSecret(nonce));
      if (!approval || approval.consumedAt !== null) return null;
      return this.store.getJob(approval.jobId)?.projectId ?? null;
    } catch {
      return null;
    }
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

  private renderStatus(job: Job): SendMessagePayload {
    return renderJobStatus({ job, admission: this.store.getAdmission(job.id) });
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
