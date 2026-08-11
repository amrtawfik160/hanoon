import type { BbPluginApi } from "@bb/plugin-sdk";
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  projectPolicySchema,
  type Job,
  type JobEffect,
  type JobEvent,
  type JobState,
  type ProjectPolicy,
  type StoredEffect,
  type WorkerLiveness,
} from "../domain/models";
import { reviewVerdictSchema } from "../domain/review";
import { formattedMessage } from "../telegram/markdown";
import { ftsQuery, memoryScore } from "./memory-ranking";
import { assertSafeFailureSummary, containsCredentialLikeText, transition } from "../domain/state-machine";
import { ALL_MIGRATIONS } from "./migrations";
import {
  CONTROLLER_IMAGE_MIME_TYPES,
  MAX_CONTROLLER_IMAGE_BYTES,
  type ControllerImage,
  type ControllerLeaseFence,
  type ControllerThreadRecord,
  type ControllerThreadState,
  type ControllerTurnRecord,
  type ControllerTurnState,
} from "../controller/models";
import {
  nextUnansweredQuestion,
  questionOptionToken,
  renderQuestion,
  renderThreadInteraction,
  threadDecisionToken,
  type ControllerQuestion,
  type ControllerQuestionAnswers,
  type ThreadInteraction,
} from "../controller/questions";

type PluginStorage = BbPluginApi["storage"];
type SqliteDatabase = Database.Database;
type PluginKv = PluginStorage["kv"];

export type PairingResult =
  | { ok: true }
  | {
      ok: false;
      reason: "missing" | "expired" | "consumed" | "already_paired";
    };

export type Owner = { userId: string; chatId: string; pairedAt: number };
type TelegramIdentity = {
  botId: string;
  username: string;
  verifiedAt: number;
};
export type ProjectPolicyRecord = { policy: ProjectPolicy; version: number };

export type ThreadOperationKind = "steer_thread" | "stop_thread" | "retry_thread";
export type ThreadOperationState =
  | "confirmation_sending"
  | "awaiting_confirmation"
  | "confirmed"
  | "executing"
  | "completed"
  | "failed"
  | "expired";
export type ThreadOperation = {
  id: string;
  nonceHash: string;
  ownerUserId: string;
  ownerChatId: string;
  kind: ThreadOperationKind;
  threadId: string;
  text: string | null;
  state: ThreadOperationState;
  confirmationMessageId: number | null;
  expiresAt: number;
  confirmedAt: number | null;
  leaseOwner: string | null;
  leaseGeneration: number | null;
  leaseExpiresAt: number | null;
  result: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};
export type ThreadOperationConfirmResult =
  | { ok: true; operation: ThreadOperation }
  | { ok: false; reason: "missing" | "expired" | "consumed" };

export type OutboxInput = {
  logicalKey: string;
  chatId: string;
  messageId?: number | null;
  payload: Record<string, unknown>;
};

export type StoredOutbox = OutboxInput & {
  status: "pending" | "leased" | "sent" | "failed" | "dead";
  attempts: number;
  leaseOwner: string | null;
  leaseGeneration: number | null;
  leaseExpiresAt: number | null;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ApprovalIdentity = { userId: string; chatId: string };
export type ApprovalRecord = {
  jobId: string;
  headSha: string;
  expiresAt: number;
  jobVersion: number | null;
  ownerUserId: string | null;
  ownerChatId: string | null;
};
export type ApprovalState = ApprovalRecord & {
  consumedAt: number | null;
  outcome: string | null;
};
export type ApprovalConsumeResult =
  | { ok: true; jobId: string; headSha: string; expiresAt: number }
  | { ok: false; reason: "missing" | "expired" | "consumed" | "revoked" };
export type ApprovalAcceptResult =
  | { ok: true; jobId: string; headSha: string }
  | { ok: false; reason: "missing" | "expired" | "consumed" | "revoked" | "version_conflict" };
export type CallbackRecord = {
  callbackId: string;
  jobId: string | null;
  action: string;
  outcome: string;
  processedAt: number;
  approvalNonceHash: string | null;
  headSha: string | null;
  effectIdempotencyKey: string | null;
};

export type MergeCallbackIdentity = {
  approvalNonceHash: string;
  headSha: string;
  effectIdempotencyKey: string;
};

export type ToolReceiptKey = {
  turnId: string;
  toolName: string;
  argsSha256: string;
};

/**
 * `fresh` means nothing ran before. `completed` replays the previous result
 * instead of repeating the mutation. `interrupted` means an earlier attempt
 * started and never reported — the outcome is unknown and must be checked,
 * never blindly retried.
 */
export type ToolReceiptClaim =
  | { outcome: "fresh" }
  | { outcome: "completed"; result: string }
  | { outcome: "interrupted" };

export type ControllerGeneration = {
  id: string;
  controllerKey: string;
  threadId: string;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
};

export type MonitorKind = "thread_idle" | "schedule";
export type MonitorState = "armed" | "cancelled" | "done" | "failed";

export type MonitorRecord = {
  id: string;
  controllerKey: string;
  kind: MonitorKind;
  threadId: string | null;
  cron: string | null;
  instruction: string;
  state: MonitorState;
  dueAt: number | null;
  fireCount: number;
  lastFiredAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type MemoryKind = "preference" | "fact" | "decision" | "correction";

export type MemoryRecord = {
  id: string;
  scope: string;
  kind: MemoryKind;
  subject: string;
  body: string;
  importance: number;
  confidence: number;
  source: "owner" | "agent";
  sourceTurnId: string | null;
  useCount: number;
  lastUsedAt: number | null;
  supersededBy: string | null;
  forgottenAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type MemoryInput = {
  scope: string;
  kind: MemoryKind;
  subject: string;
  body: string;
  importance?: number;
  confidence?: number;
  source: "owner" | "agent";
  sourceTurnId?: string;
  now: number;
};

export type AttemptRecord = {
  id: string;
  jobId: string;
  kind: "implementation" | "review" | "validation";
  ordinal: number;
  threadId: string | null;
  headSha: string | null;
  handoffPath: string | null;
  handoffSha256: string | null;
  resultJson: string | null;
  completedAt: number | null;
};

export type PipelineStageRole =
  | "PLAN"
  | "CRITIQUE"
  | "BUILD"
  | "TEST"
  | "REVIEW"
  | "PATCH"
  | "DOCS"
  | "FINAL_TEST"
  | "FINAL_REVIEW"
  | "DEPLOY"
  | "CANARY";
export type PipelineStageAttemptState = "spawning" | "running" | "completed" | "failed";
export type PipelineStageAttempt = {
  id: string;
  jobId: string;
  role: PipelineStageRole;
  ordinal: number;
  state: PipelineStageAttemptState;
  threadId: string | null;
  environmentId: string | null;
  resourceKind: "bb_thread" | "bb_terminal" | null;
  resourceId: string | null;
  inputSha256: string;
  outputText: string | null;
  outputSha256: string | null;
  outcome: Record<string, unknown> | null;
  startSha: string | null;
  endSha: string | null;
  lastError: string | null;
  createdAt: number;
  completedAt: number | null;
  updatedAt: number;
};

export type MergeSuccessInput = {
  jobId: string;
  effectIdempotencyKey: string;
  message: string;
  result: Record<string, unknown>;
  outbox?: OutboxInput;
  now: number;
  leaseOwner: string;
  leaseGeneration: number;
};

export type MergeFailureInput = {
  jobId: string;
  effectIdempotencyKey: string;
  reason: string;
  now: number;
  leaseOwner: string;
  leaseGeneration: number;
};

export type MergeStaleInput = {
  jobId: string;
  effectIdempotencyKey: string;
  reason: string;
  now: number;
  leaseOwner: string;
  leaseGeneration: number;
};

export type DurableMergeReceipt = {
  jobId: string;
  effectIdempotencyKey: string;
  approvalNonceHash: string;
  approvalOwnerUserId: string;
  approvalOwnerChatId: string;
  jobVersion: number;
  approvalJobVersion: number;
  projectId: string;
  environmentId: string;
  prNumber: number;
  baseBranch: string;
  headSha: string;
  reviewAttemptId: string;
  validationCompletedAt: string;
  requiredCheckNames: string[];
  mergeMethod: "merge" | "rebase" | "squash";
  expiresAt: string;
};

export type PersistedMergeSuccessResult = {
  jobId: string;
  effectIdempotencyKey: string;
  approvalNonceHash: string;
  environmentId: string;
  prNumber: number;
  authoritativeHeadSha: string;
  baseContentVerified: boolean;
  mergedAt: string;
  mergeCommit: { oid: string };
  pullRequest: { number: number; url: string; state: "MERGED" };
  confirmedAt: string;
};

export type MergeEffectPayload = {
  headSha: string;
  receipt: DurableMergeReceipt;
  mergeCallStartedAt?: number;
  mergeCallOutcome?: "unknown";
  mergeOutcome?: "stale";
};

export type PendingMergeEffectPayload = {
  headSha: string;
  reviewAttemptId: string;
  approvalNonceHash: string;
  approvalOwnerUserId: string;
  approvalOwnerChatId: string;
  approvalJobVersion: number;
  approvalExpiresAt: number;
};

export type StaleMergeTombstone = {
  mergeOutcome: "stale";
  jobId: string;
  effectIdempotencyKey: string;
};

export type PersistedMergeEvidence =
  | {
      disposition: "failed" | "dead";
      status: "failed" | "dead";
      jobId: string;
      effectIdempotencyKey: string;
    }
  | {
      disposition: "stale";
      status: "done";
      jobId: string;
      effectIdempotencyKey: string;
      tombstone: StaleMergeTombstone;
    }
  | {
      disposition: "active";
      status: "pending" | "leased";
      jobId: string;
      effectIdempotencyKey: string;
      payload: MergeEffectPayload;
    }
  | {
      disposition: "success";
      status: "done";
      jobId: string;
      effectIdempotencyKey: string;
      payload: MergeEffectPayload;
      result: PersistedMergeSuccessResult;
    };

export type PersistedMergeEvidenceInput = {
  idempotencyKey: unknown;
  jobId: unknown;
  kind: unknown;
  status: unknown;
  payload: unknown;
};

export function isReplayableMergeEvidence(
  evidence: PersistedMergeEvidence,
): evidence is Extract<PersistedMergeEvidence, { disposition: "active" | "success" }> {
  return evidence.disposition === "active" || evidence.disposition === "success";
}

export type MergeCallPreparation =
  | {
      ok: true;
      shouldCallProvider: boolean;
      effect: StoredEffect;
      job: Job;
      receipt: DurableMergeReceipt;
    }
  | { ok: false; reason: string };

export type ApprovalRejectionResult = {
  outcome: "accepted" | "rejected";
  callbackRecorded: boolean;
};

type PairingCodeRow = {
  consumed_at: number | null;
  expires_at: number;
};
type OwnerRow = {
  telegram_user_id: string;
  telegram_chat_id: string;
  paired_at: number;
};
type ProjectPolicyRow = {
  policy_json: string;
  version: number;
};
type TelegramIdentityRow = {
  bot_id: string;
  username: string;
  verified_at: number;
};
type ApprovalRow = {
  nonce_hash: string;
  job_id: string;
  head_sha: string;
  expires_at: number;
  consumed_at: number | null;
  outcome: string | null;
  owner_user_id: string | null;
  owner_chat_id: string | null;
  job_version: number | null;
};
type CallbackRow = {
  callback_query_id: string;
  job_id: string | null;
  action: string;
  outcome: string;
  processed_at: number;
  approval_nonce_hash: string | null;
  head_sha: string | null;
  effect_idempotency_key: string | null;
};

type JobRow = {
  id: string;
  source_update_id: number;
  request_text: string;
  state: string;
  resume_state: string | null;
  project_id: string | null;
  policy_version: number | null;
  policy_json: string | null;
  environment_id: string | null;
  implementation_thread_id: string | null;
  review_thread_id: string | null;
  documentation_thread_id: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_head_sha: string | null;
  merge_message: string | null;
  merge_commit_sha: string | null;
  merged_at: string | null;
  deployment_summary: string | null;
  canary_summary: string | null;
  status_message_id: number | null;
  plan_cycle: number;
  review_cycle: number;
  review_block_at: number;
  cancel_requested_at: number | null;
  blocked_reason: Job["blockedReason"];
  last_error: string | null;
  version: number;
  created_at: number;
  updated_at: number;
};

type EffectRow = {
  idempotency_key: string;
  job_id: string;
  kind: StoredEffect["kind"];
  payload_json: string;
  status: StoredEffect["status"];
  attempts: number;
  lease_owner: string | null;
  lease_generation: number | null;
  lease_expires_at: number | null;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};
type OutboxRow = {
  logical_key: string;
  chat_id: string;
  message_id: number | null;
  payload_json: string;
  status: StoredOutbox["status"];
  attempts: number;
  lease_owner: string | null;
  lease_generation: number | null;
  lease_expires_at: number | null;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};
type ControllerThreadRow = {
  controller_key: string;
  telegram_user_id: string;
  telegram_chat_id: string;
  project_id: string | null;
  host_id: string | null;
  bb_thread_id: string | null;
  state: ControllerThreadState;
  pending_spawn_token: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};
type ControllerTurnRow = {
  id: string;
  telegram_update_id: number;
  controller_key: string;
  ordinal: number;
  input_text: string;
  image_file_id: string | null;
  image_file_name: string | null;
  image_mime_type: string | null;
  image_size_bytes: number | null;
  state: ControllerTurnState;
  lease_owner: string | null;
  lease_generation: number | null;
  dispatch_after_seq: number;
  retry_count: number;
  bb_event_seq: number;
  stream_text: string;
  telegram_message_id: number | null;
  stream_phase: ControllerTurnRecord["streamPhase"];
  response_text: string | null;
  last_error: string | null;
  submitted_at: number | null;
  completed_at: number | null;
  awaiting_interaction_id: string | null;
  created_at: number;
  updated_at: number;
};
type ControllerQuestionRow = {
  interaction_id: string;
  turn_id: string;
  controller_key: string;
  questions_json: string;
  state: "pending" | "answered";
  answers_json: string;
  asked_at: number;
  answered_at: number | null;
};
export type ControllerQuestionRecord = {
  interactionId: string;
  turnId: string;
  controllerKey: string;
  questions: ControllerQuestion[];
  answers: ControllerQuestionAnswers;
  askedAt: number;
};
type ObservedThreadRow = {
  thread_id: string;
  title: string;
  last_status: string;
  notified_status: string | null;
  notified_at: number | null;
  first_seen_at: number;
  updated_at: number;
};
type ThreadInteractionRow = {
  interaction_id: string;
  thread_id: string;
  title: string;
  kind: ThreadInteraction["kind"];
  payload_json: string;
  state: "pending" | "answered" | "delivered";
  answer_json: string | null;
  asked_at: number;
  answered_at: number | null;
};
export type ThreadInteractionAnswer =
  | { ok: true; interactionId: string; threadId: string; title: string; label: string }
  | { ok: false; reason: "stale" };
export type ThreadInteractionDelivery = {
  interactionId: string;
  threadId: string;
  title: string;
  resolution: Record<string, unknown>;
};
export type ControllerQuestionAnswer =
  | {
    ok: true;
    /** False while the same interaction still has questions the owner has not settled. */
    complete: boolean;
    turnId: string;
    interactionId: string;
    answers: ControllerQuestionAnswers;
  }
  | { ok: false; reason: "stale" };
type ThreadOperationRow = {
  id: string;
  nonce_hash: string;
  owner_user_id: string;
  owner_chat_id: string;
  kind: ThreadOperationKind;
  thread_id: string;
  operation_text: string | null;
  state: ThreadOperationState;
  confirmation_message_id: number | null;
  expires_at: number;
  confirmed_at: number | null;
  lease_owner: string | null;
  lease_generation: number | null;
  lease_expires_at: number | null;
  result: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};
type PipelineStageAttemptRow = {
  id: string;
  job_id: string;
  role: PipelineStageRole;
  ordinal: number;
  state: PipelineStageAttemptState;
  thread_id: string | null;
  environment_id: string | null;
  resource_kind: "bb_thread" | "bb_terminal" | null;
  resource_id: string | null;
  input_sha256: string;
  output_text: string | null;
  output_sha256: string | null;
  outcome_json: string | null;
  start_sha: string | null;
  end_sha: string | null;
  last_error: string | null;
  created_at: number;
  completed_at: number | null;
  updated_at: number;
};
type TelegramUpdateRow = {
  status: "processing" | "processed" | "failed";
  claim_owner: string | null;
  claim_generation: number | null;
  claim_expires_at: number | null;
};

const JOB_STATES: ReadonlySet<JobState> = new Set([
  "awaiting_project",
  "awaiting_confirmation",
  "planning",
  "critiquing",
  "creating_implementation",
  "implementing",
  "locating_pr",
  "resolving_pr_head",
  "reviewing",
  "remediating",
  "validating",
  "documenting",
  "resolving_docs_head",
  "final_validating",
  "final_reviewing",
  "awaiting_merge_approval",
  "merging",
  "deploying",
  "verifying_production",
  "production_failed",
  "complete",
  "failed",
  "blocked",
  "cancelled",
  "merged",
]);
const BLOCKED_REASONS: ReadonlySet<NonNullable<Job["blockedReason"]>> = new Set([
  "review_limit",
  "configuration",
  "cancellation_unconfirmed",
  "permanent_effect_failure",
]);
const THREAD_OPERATION_KINDS: ReadonlySet<ThreadOperationKind> = new Set([
  "steer_thread",
  "stop_thread",
  "retry_thread",
]);
const PIPELINE_STAGE_ROLES: ReadonlySet<PipelineStageRole> = new Set([
  "PLAN", "CRITIQUE", "BUILD", "TEST", "REVIEW", "PATCH", "DOCS",
  "FINAL_TEST", "FINAL_REVIEW", "DEPLOY", "CANARY",
]);

export class VersionConflictError extends Error {
  public constructor(jobId: string, expectedVersion: number) {
    super(`Job ${jobId} changed since version ${expectedVersion}`);
    this.name = "VersionConflictError";
  }
}

export class IdempotencyConflictError extends Error {
  public constructor(sourceUpdateId: number) {
    super(`Telegram update ${sourceUpdateId} was replayed with different job input`);
    this.name = "IdempotencyConflictError";
  }
}

export class ActiveJobConflictError extends Error {
  public constructor(jobId: string) {
    super(`Job ${jobId} cannot continue while another job is active`);
    this.name = "ActiveJobConflictError";
  }
}

export class UpdateClaimConflictError extends Error {
  public constructor(updateId: number) {
    super(`Telegram update ${updateId} is not owned by this store claim`);
    this.name = "UpdateClaimConflictError";
  }
}

const LAST_PROJECT_KEY = "telegram-agent:last-project";

const CANONICAL_POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const RAW_MERGE_CALLBACK = /m:[A-Za-z0-9_-]{32}/;
const ENCODED_MERGE_CALLBACK = /(?:m|%6d)%3a[A-Za-z0-9_-]{32}/i;
const TELEGRAM_UPDATE_LEASE_MS = 300_000;
/** Claims one update may cost before ingress gives up and moves the cursor on. */
export const MAX_TELEGRAM_UPDATE_ATTEMPTS = 3;
export const OWNER_MEMORY_SCOPE = "owner";
const MEMORY_KINDS = new Set<MemoryKind>(["preference", "fact", "decision", "correction"]);
const MAX_MEMORY_SUBJECT = 120;
const MAX_MEMORY_BODY = 1_000;
const MAX_LIVE_MEMORIES_PER_SCOPE = 10;
const DEFAULT_MEMORY_IMPORTANCE = 0.6;
const DEFAULT_MEMORY_CONFIDENCE = 0.7;
const MAX_DIGEST_TURNS = 12;
const MAX_DIGEST_TEXT = 600;
const MAX_MONITOR_INSTRUCTION = 1_000;
const MAX_ARMED_MONITORS = 20;
const MAX_RECEIPT_RESULT = 4_000;
const MAX_RECEIPT_STRING = 512;
const MAX_EFFECT_KEY = 256;
const MAX_MERGE_RESULT_JSON = 64_000;
const MAX_EXTERNAL_URL_LENGTH = 500;
const MAX_QUERY_DEPTH = 4;
const MAX_PIPELINE_OUTPUT_BYTES = 65_536;
const SAFE_MERGE_FAILURE_REASON = "Merge effect failed safely";
const UNKNOWN_MERGE_OUTCOME_REASON = "Merge outcome is unknown; provider truth requires reconciliation";
const SAFE_FAILED_MERGE_PAYLOAD = JSON.stringify({ mergeCleanup: "failed" });

function assertControllerKey(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new TypeError("controllerKey is invalid");
}

function assertControllerIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError(`${field} must be between 1 and 256 characters`);
  }
}

function assertControllerText(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 4_000) {
    throw new TypeError(`${field} must be between 1 and 4000 characters`);
  }
}

function assertControllerImage(value: ControllerImage): void {
  if (typeof value.fileId !== "string" || value.fileId.length === 0 || value.fileId.length > 1_024) {
    throw new TypeError("controller image fileId must be between 1 and 1024 characters");
  }
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(value.fileName)) {
    throw new TypeError("controller image fileName is invalid");
  }
  if (!CONTROLLER_IMAGE_MIME_TYPES.includes(value.mimeType)) {
    throw new TypeError("controller image mimeType is invalid");
  }
  if (value.sizeBytes !== null && (
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    value.sizeBytes > MAX_CONTROLLER_IMAGE_BYTES
  )) {
    throw new TypeError("controller image sizeBytes is invalid");
  }
}
const CREDENTIAL_QUERY_KEY = /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|auth(?:orization)?|auth[_-]?(?:token|key)|session[_-]?token|private[_-]?key|credentials?|password|passwd|secret|token|key|jwt|signature|sig)$/i;
const CREDENTIAL_QUERY_VALUE = /^(?:bearer\s+\S+|(?:sk|rk)-[A-Za-z0-9_-]{10,}|(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|password|secret|token|credential)\s*[:=]|(?:secret|password|token|credential|api[_-]?key)\b)/i;

function assertCanonicalPositiveDecimal(value: string, field: string): void {
  if (typeof value !== "string" || !CANONICAL_POSITIVE_DECIMAL.test(value)) {
    throw new TypeError(`${field} must be a canonical positive decimal string`);
  }
}

function assertSha256Hex(value: string): void {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new TypeError("Pairing code must be a lowercase 64-character SHA-256 hex string");
  }
}

function assertContentSha256(value: string, field: string): void {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new TypeError(`${field} must be a lowercase 64-character SHA-256 hex string`);
  }
}

function assertFullSha(value: string, field: string): void {
  if (typeof value !== "string" || !FULL_SHA.test(value)) {
    throw new TypeError(`${field} must be a 40-character lowercase SHA`);
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer`);
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer`);
}

function assertBoundedString(value: unknown, field: string, max = MAX_RECEIPT_STRING): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new TypeError(`${field} must be a bounded non-empty string`);
  }
}

function assertFiniteTimestamp(value: unknown, field: string): asserts value is string {
  assertBoundedString(value, field);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be a valid finite timestamp`);
}

function decodePercentLayers(value: string, field: string): string {
  let candidate = value;
  for (let layer = 0; layer < MAX_QUERY_DEPTH; layer += 1) {
    if (!candidate.includes("%")) return candidate;
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      throw new TypeError(`${field} contains malformed percent encoding`);
    }
    if (decoded === candidate) return candidate;
    candidate = decoded;
  }
  throw new TypeError(`${field} contains excessive percent encoding`);
}

function containsForbiddenCallbackMaterial(value: string): boolean {
  let candidate = value;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (RAW_MERGE_CALLBACK.test(candidate) || ENCODED_MERGE_CALLBACK.test(candidate)) return true;
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return true;
    }
    if (decoded === candidate) return false;
    candidate = decoded;
  }
  return RAW_MERGE_CALLBACK.test(candidate) || ENCODED_MERGE_CALLBACK.test(candidate);
}

function assertNoRawMergeCallback(value: string, field: string): void {
  if (containsForbiddenCallbackMaterial(value)) throw new TypeError(`${field} must not contain a raw merge callback nonce`);
}

function serializeBoundedJson(value: unknown, field: string, maxLength: number): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new TypeError(`${field} must be JSON serializable`);
  }
  if (json === undefined || json.length > maxLength) throw new TypeError(`${field} must be bounded JSON`);
  assertPersistedExternalUrls(JSON.parse(json) as unknown, field);
  assertNoRawMergeCallback(json, field);
  return json;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new TypeError(`${field} contains an unexpected field`);
  }
}

function assertExactObjectKeys(value: Record<string, unknown>, required: readonly string[], field: string): void {
  assertExactKeys(value, required, field);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new TypeError(`${field} is missing ${key}`);
  }
}

function assertCredentialFreeQueryMaterial(material: string, field: string, depth: number): void {
  if (depth >= MAX_QUERY_DEPTH || material.length > MAX_EXTERNAL_URL_LENGTH) {
    throw new TypeError(`${field} contains excessive nested query material`);
  }
  for (const part of material.replace(/^[?&]/, "").split("&")) {
    if (part.length === 0) continue;
    const separator = part.indexOf("=");
    const rawKey = separator < 0 ? part : part.slice(0, separator);
    const rawValue = separator < 0 ? "" : part.slice(separator + 1);
    const key = decodePercentLayers(rawKey, `${field} query key`);
    const queryValue = decodePercentLayers(rawValue, `${field} query value`);
    if (
      CREDENTIAL_QUERY_KEY.test(key) ||
      CREDENTIAL_QUERY_VALUE.test(queryValue) ||
      containsForbiddenCallbackMaterial(key) ||
      containsForbiddenCallbackMaterial(queryValue)
    ) {
      throw new TypeError(`${field} must not contain credential-bearing query data`);
    }
    if (key.includes("=") || key.includes("&") || queryValue.includes("=") || queryValue.includes("&")) {
      assertCredentialFreeQueryMaterial(key, `${field} nested query key`, depth + 1);
      assertCredentialFreeQueryMaterial(queryValue, `${field} nested query value`, depth + 1);
    }
  }
}

function assertCredentialFreeQuery(url: URL, field: string): void {
  const query = url.search.startsWith("?") ? url.search.slice(1) : "";
  assertCredentialFreeQueryMaterial(query, field, 0);
}

export function assertSafeExternalHttpsUrl(value: unknown, field = "external URL"): string {
  assertBoundedString(value, field, MAX_EXTERNAL_URL_LENGTH);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${field} must be a valid HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    containsForbiddenCallbackMaterial(value) ||
    containsForbiddenCallbackMaterial(parsed.href)
  ) {
    throw new TypeError(`${field} must be a credential-free HTTPS URL without callback material`);
  }
  assertCredentialFreeQuery(parsed, field);
  return value;
}

function assertPersistedExternalUrls(value: unknown, field: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPersistedExternalUrls(entry, `${field}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const path = `${field}.${key}`;
    if (entry !== null && entry !== undefined && /(?:url|uri|href)s?$/i.test(key)) {
      assertSafeExternalHttpsUrl(entry, path);
    }
    assertPersistedExternalUrls(entry, path);
  }
}

function parsePersistedMergeSuccessResultInternal(value: unknown): PersistedMergeSuccessResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("merge result must be a JSON object");
  }
  const json = serializeBoundedJson(value, "merge result", MAX_MERGE_RESULT_JSON);
  const result = value as Record<string, unknown>;
  assertExactObjectKeys(result, [
    "jobId",
    "effectIdempotencyKey",
    "approvalNonceHash",
    "environmentId",
    "prNumber",
    "authoritativeHeadSha",
    "baseContentVerified",
    "mergedAt",
    "mergeCommit",
    "pullRequest",
    "confirmedAt",
  ], "merge result");
  assertBoundedString(result.jobId, "merge result.jobId");
  assertBoundedString(result.effectIdempotencyKey, "merge result.effectIdempotencyKey", MAX_EFFECT_KEY);
  assertBoundedString(result.approvalNonceHash, "merge result.approvalNonceHash");
  if (!SHA256_HEX.test(result.approvalNonceHash)) throw new TypeError("merge result.approvalNonceHash must be SHA-256 hex");
  assertBoundedString(result.environmentId, "merge result.environmentId");
  assertPositiveInteger(result.prNumber as number, "merge result.prNumber");
  if ((result.prNumber as number) > 2_147_483_647) throw new TypeError("merge result.prNumber is too large");
  assertBoundedString(result.authoritativeHeadSha, "merge result.authoritativeHeadSha");
  if (!FULL_SHA.test(result.authoritativeHeadSha)) throw new TypeError("merge result head must be a full lowercase SHA");
  if (typeof result.baseContentVerified !== "boolean") throw new TypeError("merge result base-content verification must be boolean");
  assertFiniteTimestamp(result.mergedAt, "merge result.mergedAt");
  assertFiniteTimestamp(result.confirmedAt, "merge result.confirmedAt");

  if (result.mergeCommit === null || typeof result.mergeCommit !== "object" || Array.isArray(result.mergeCommit)) {
    throw new TypeError("merge result.mergeCommit must be an object");
  }
  const mergeCommit = result.mergeCommit as Record<string, unknown>;
  assertExactObjectKeys(mergeCommit, ["oid"], "merge result.mergeCommit");
  assertBoundedString(mergeCommit.oid, "merge result.mergeCommit.oid");
  if (!FULL_SHA.test(mergeCommit.oid)) {
    throw new TypeError("merge result merge commit must be a full lowercase SHA");
  }

  if (result.pullRequest === null || typeof result.pullRequest !== "object" || Array.isArray(result.pullRequest)) {
    throw new TypeError("merge result.pullRequest must be an object");
  }
  const pullRequest = result.pullRequest as Record<string, unknown>;
  assertExactObjectKeys(pullRequest, ["number", "url", "state"], "merge result.pullRequest");
  assertPositiveInteger(pullRequest.number as number, "merge result.pullRequest.number");
  if (pullRequest.number !== result.prNumber) throw new TypeError("merge result pull-request number does not match");
  const url = assertSafeExternalHttpsUrl(pullRequest.url, "merge result.pullRequest.url");
  if (pullRequest.state !== "MERGED") throw new TypeError("merge result pull-request state must be MERGED");

  if (json.length > MAX_MERGE_RESULT_JSON) throw new TypeError("merge result must be bounded JSON");
  return {
    jobId: result.jobId,
    effectIdempotencyKey: result.effectIdempotencyKey,
    approvalNonceHash: result.approvalNonceHash,
    environmentId: result.environmentId,
    prNumber: result.prNumber as number,
    authoritativeHeadSha: result.authoritativeHeadSha,
    baseContentVerified: result.baseContentVerified,
    mergedAt: result.mergedAt,
    mergeCommit: { oid: mergeCommit.oid },
    pullRequest: { number: pullRequest.number as number, url, state: "MERGED" },
    confirmedAt: result.confirmedAt,
  };
}

export function parsePersistedMergeSuccessResult(value: unknown): PersistedMergeSuccessResult {
  return parsePersistedMergeSuccessResultInternal(value);
}

function mergeSuccessResultMatchesDurable(
  result: PersistedMergeSuccessResult,
  effect: EffectRow,
  payload: MergeEffectPayload,
  job: Job,
  approval: ApprovalRow | undefined,
  expectedJobState: "merging" | "post_merge",
): boolean {
  const receipt = payload.receipt;
  const postMergeStates = new Set<JobState>(["deploying", "verifying_production", "production_failed", "complete", "merged"]);
  const expectedJobVersion = expectedJobState === "post_merge" ? receipt.jobVersion + 1 : receipt.jobVersion;
  const stateMatches = expectedJobState === "merging"
    ? job.state === "merging"
    : postMergeStates.has(job.state);
  const mergeFactMatches = expectedJobState === "merging" || job.state === "merged"
    ? true
    : job.mergeMessage !== null && job.mergeCommitSha === result.mergeCommit.oid && job.mergedAt === result.mergedAt;
  return effect.job_id === job.id &&
    result.jobId === job.id &&
    result.effectIdempotencyKey === effect.idempotency_key &&
    receipt.effectIdempotencyKey === effect.idempotency_key &&
    result.approvalNonceHash === receipt.approvalNonceHash &&
    result.environmentId === receipt.environmentId &&
    result.environmentId === job.environmentId &&
    result.prNumber === receipt.prNumber &&
    result.prNumber === job.prNumber &&
    result.authoritativeHeadSha === receipt.headSha &&
    result.authoritativeHeadSha === job.prHeadSha &&
    result.pullRequest.number === receipt.prNumber &&
    result.pullRequest.state === "MERGED" &&
    stateMatches &&
    mergeFactMatches &&
    job.cancelRequestedAt === null &&
    (expectedJobState === "post_merge" ? job.version >= expectedJobVersion : job.version === expectedJobVersion) &&
    job.projectId === receipt.projectId &&
    job.policy !== null &&
    job.policy.baseBranch === receipt.baseBranch &&
    job.policy.mergeMethod === receipt.mergeMethod &&
    JSON.stringify([...job.policy.requiredChecks].sort()) === JSON.stringify(receipt.requiredCheckNames) &&
    approval !== undefined &&
    approval.job_id === job.id &&
    approval.head_sha === receipt.headSha &&
    approval.consumed_at !== null &&
    approval.outcome === "accepted" &&
    approval.job_version === receipt.approvalJobVersion &&
    approval.owner_user_id === receipt.approvalOwnerUserId &&
    approval.owner_chat_id === receipt.approvalOwnerChatId &&
    approval.expires_at === Date.parse(receipt.expiresAt);
}

function isStrictPassReviewResult(value: unknown, headSha: string): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const parsed = value as Record<string, unknown>;
  const requiredKeys = ["outcome", "reasons", "findings", "reviewedHeadSha", "verdict"];
  if (
    Object.keys(parsed).some((key) => !requiredKeys.includes(key)) ||
    requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(parsed, key)) ||
    parsed.outcome !== "pass" ||
    parsed.reviewedHeadSha !== headSha ||
    !Array.isArray(parsed.reasons) ||
    parsed.reasons.length !== 0 ||
    !Array.isArray(parsed.findings) ||
    parsed.findings.length !== 0
  ) return false;
  const verdict = reviewVerdictSchema.safeParse(parsed.verdict);
  return verdict.success &&
    verdict.data.verdict === "pass" &&
    verdict.data.reviewedHeadSha === headSha &&
    verdict.data.findings.length === 0 &&
    verdict.data.checks.every((check) => check.outcome === "passed");
}

function isBoundedAttemptCompletion(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

export function isCompletedReviewAttempt(
  attempt: AttemptRecord | null,
  jobId: string,
  headSha: string,
): boolean {
  if (!attempt || attempt.jobId !== jobId || attempt.kind !== "review" || attempt.headSha !== headSha ||
      !isBoundedAttemptCompletion(attempt.completedAt) || typeof attempt.resultJson !== "string") return false;
  try {
    return isStrictPassReviewResult(JSON.parse(attempt.resultJson), headSha);
  } catch {
    return false;
  }
}

export function parseDurableMergeReceipt(value: unknown): DurableMergeReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("merge receipt must be a JSON object");
  }
  const receipt = value as Record<string, unknown>;
  assertExactKeys(receipt, [
    "jobId",
    "effectIdempotencyKey",
    "approvalNonceHash",
    "approvalOwnerUserId",
    "approvalOwnerChatId",
    "jobVersion",
    "approvalJobVersion",
    "projectId",
    "environmentId",
    "prNumber",
    "baseBranch",
    "headSha",
    "reviewAttemptId",
    "validationCompletedAt",
    "requiredCheckNames",
    "mergeMethod",
    "expiresAt",
  ], "merge receipt");
  assertBoundedString(receipt.jobId, "receipt.jobId");
  assertBoundedString(receipt.effectIdempotencyKey, "receipt.effectIdempotencyKey", MAX_EFFECT_KEY);
  assertBoundedString(receipt.approvalNonceHash, "receipt.approvalNonceHash");
  if (!SHA256_HEX.test(receipt.approvalNonceHash)) throw new TypeError("receipt.approvalNonceHash must be SHA-256 hex");
  assertBoundedString(receipt.approvalOwnerUserId, "receipt.approvalOwnerUserId");
  assertBoundedString(receipt.approvalOwnerChatId, "receipt.approvalOwnerChatId");
  assertCanonicalPositiveDecimal(receipt.approvalOwnerUserId, "receipt.approvalOwnerUserId");
  assertCanonicalPositiveDecimal(receipt.approvalOwnerChatId, "receipt.approvalOwnerChatId");
  assertPositiveInteger(receipt.jobVersion as number, "receipt.jobVersion");
  assertPositiveInteger(receipt.approvalJobVersion as number, "receipt.approvalJobVersion");
  assertBoundedString(receipt.projectId, "receipt.projectId");
  if (!receipt.projectId.startsWith("proj_")) throw new TypeError("receipt.projectId is invalid");
  assertBoundedString(receipt.environmentId, "receipt.environmentId");
  assertPositiveInteger(receipt.prNumber as number, "receipt.prNumber");
  if ((receipt.prNumber as number) > 2_147_483_647) throw new TypeError("receipt.prNumber is too large");
  assertBoundedString(receipt.baseBranch, "receipt.baseBranch");
  assertBoundedString(receipt.headSha, "receipt.headSha");
  if (!FULL_SHA.test(receipt.headSha)) throw new TypeError("receipt.headSha must be a full lowercase SHA");
  assertBoundedString(receipt.reviewAttemptId, "receipt.reviewAttemptId");
  assertFiniteTimestamp(receipt.validationCompletedAt, "receipt.validationCompletedAt");
  if (!Array.isArray(receipt.requiredCheckNames) || receipt.requiredCheckNames.length > 50) {
    throw new TypeError("receipt.requiredCheckNames must be a bounded array");
  }
  const requiredCheckNames = receipt.requiredCheckNames.map((name, index) => {
    assertBoundedString(name, `receipt.requiredCheckNames[${index}]`);
    return name;
  });
  if (new Set(requiredCheckNames).size !== requiredCheckNames.length ||
      JSON.stringify(requiredCheckNames) !== JSON.stringify([...requiredCheckNames].sort())) {
    throw new TypeError("receipt.requiredCheckNames must be unique and sorted");
  }
  if (receipt.mergeMethod !== "merge" && receipt.mergeMethod !== "rebase" && receipt.mergeMethod !== "squash") {
    throw new TypeError("receipt.mergeMethod is invalid");
  }
  assertFiniteTimestamp(receipt.expiresAt, "receipt.expiresAt");
  return {
    jobId: receipt.jobId,
    effectIdempotencyKey: receipt.effectIdempotencyKey,
    approvalNonceHash: receipt.approvalNonceHash,
    approvalOwnerUserId: receipt.approvalOwnerUserId,
    approvalOwnerChatId: receipt.approvalOwnerChatId,
    jobVersion: receipt.jobVersion as number,
    approvalJobVersion: receipt.approvalJobVersion as number,
    projectId: receipt.projectId,
    environmentId: receipt.environmentId,
    prNumber: receipt.prNumber as number,
    baseBranch: receipt.baseBranch,
    headSha: receipt.headSha,
    reviewAttemptId: receipt.reviewAttemptId,
    validationCompletedAt: receipt.validationCompletedAt,
    requiredCheckNames,
    mergeMethod: receipt.mergeMethod,
    expiresAt: receipt.expiresAt,
  };
}

export function parseMergeEffectPayload(value: unknown): MergeEffectPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("merge effect payload must be a JSON object");
  }
  const payload = value as Record<string, unknown>;
  assertExactKeys(payload, ["headSha", "receipt", "mergeCallStartedAt", "mergeCallOutcome", "mergeOutcome"], "merge effect payload");
  assertBoundedString(payload.headSha, "effect.headSha");
  if (!FULL_SHA.test(payload.headSha)) throw new TypeError("effect.headSha must be a full lowercase SHA");
  const receipt = parseDurableMergeReceipt(payload.receipt);
  if (receipt.headSha !== payload.headSha) throw new TypeError("effect head and receipt head do not match");
  if (payload.mergeCallStartedAt !== undefined) assertNonNegativeInteger(payload.mergeCallStartedAt as number, "effect.mergeCallStartedAt");
  if (payload.mergeCallOutcome !== undefined && payload.mergeCallOutcome !== "unknown") {
    throw new TypeError("effect.mergeCallOutcome is invalid");
  }
  if (payload.mergeCallStartedAt !== undefined && payload.mergeCallOutcome !== "unknown") {
    throw new TypeError("a started merge effect must have unknown outcome");
  }
  if (payload.mergeCallStartedAt === undefined && payload.mergeCallOutcome !== undefined) {
    throw new TypeError("an unknown merge effect must have a started-call timestamp");
  }
  if (payload.mergeOutcome !== undefined && payload.mergeOutcome !== "stale") {
    throw new TypeError("effect.mergeOutcome is invalid");
  }
  if (payload.mergeOutcome !== undefined && (payload.mergeCallStartedAt !== undefined || payload.mergeCallOutcome !== undefined)) {
    throw new TypeError("a stale merge effect cannot have an external-call fence");
  }
  return {
    headSha: payload.headSha,
    receipt,
    ...(payload.mergeCallStartedAt === undefined ? {} : { mergeCallStartedAt: payload.mergeCallStartedAt as number }),
    ...(payload.mergeCallOutcome === undefined ? {} : { mergeCallOutcome: "unknown" as const }),
    ...(payload.mergeOutcome === undefined ? {} : { mergeOutcome: "stale" as const }),
  };
}

export function parsePendingMergeEffectPayload(value: unknown): PendingMergeEffectPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("pending merge effect payload must be a JSON object");
  }
  const payload = value as Record<string, unknown>;
  assertExactKeys(payload, [
    "headSha",
    "reviewAttemptId",
    "approvalNonceHash",
    "approvalOwnerUserId",
    "approvalOwnerChatId",
    "approvalJobVersion",
    "approvalExpiresAt",
  ], "pending merge effect payload");
  assertBoundedString(payload.headSha, "pending.headSha");
  if (!FULL_SHA.test(payload.headSha)) throw new TypeError("pending.headSha must be a full lowercase SHA");
  assertBoundedString(payload.reviewAttemptId, "pending.reviewAttemptId");
  assertBoundedString(payload.approvalNonceHash, "pending.approvalNonceHash");
  if (!SHA256_HEX.test(payload.approvalNonceHash)) throw new TypeError("pending.approvalNonceHash must be SHA-256 hex");
  assertBoundedString(payload.approvalOwnerUserId, "pending.approvalOwnerUserId");
  assertBoundedString(payload.approvalOwnerChatId, "pending.approvalOwnerChatId");
  assertCanonicalPositiveDecimal(payload.approvalOwnerUserId, "pending.approvalOwnerUserId");
  assertCanonicalPositiveDecimal(payload.approvalOwnerChatId, "pending.approvalOwnerChatId");
  assertPositiveInteger(payload.approvalJobVersion as number, "pending.approvalJobVersion");
  assertPositiveInteger(payload.approvalExpiresAt as number, "pending.approvalExpiresAt");
  return {
    headSha: payload.headSha,
    reviewAttemptId: payload.reviewAttemptId,
    approvalNonceHash: payload.approvalNonceHash,
    approvalOwnerUserId: payload.approvalOwnerUserId,
    approvalOwnerChatId: payload.approvalOwnerChatId,
    approvalJobVersion: payload.approvalJobVersion as number,
    approvalExpiresAt: payload.approvalExpiresAt as number,
  };
}

export function parsePersistedMergeEffectPayload(
  value: unknown,
  status: StoredEffect["status"],
): MergeEffectPayload {
  if (status !== "done" || value === null || typeof value !== "object" || Array.isArray(value)) {
    return parseMergeEffectPayload(value);
  }
  const persisted = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(persisted, "mergeResult")) {
    return parseMergeEffectPayload(value);
  }
  const { mergeResult, ...activePayload } = persisted;
  parsePersistedMergeSuccessResult(mergeResult);
  return parseMergeEffectPayload(activePayload);
}

function parseActiveMergeEffectPayload(value: unknown): MergeEffectPayload {
  const payload = parseMergeEffectPayload(value);
  if (payload.mergeOutcome !== undefined) {
    throw new TypeError("an active merge effect cannot have a terminal stale outcome");
  }
  return payload;
}

function parseStaleMergeTombstone(
  value: unknown,
  jobId: string,
  effectIdempotencyKey: string,
): StaleMergeTombstone {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("stale merge tombstone must be a JSON object");
  }
  const tombstone = value as Record<string, unknown>;
  assertExactObjectKeys(
    tombstone,
    ["mergeOutcome", "jobId", "effectIdempotencyKey"],
    "stale merge tombstone",
  );
  if (tombstone.mergeOutcome !== "stale") {
    throw new TypeError("stale merge tombstone outcome is invalid");
  }
  assertBoundedString(tombstone.jobId, "stale merge tombstone.jobId");
  assertBoundedString(tombstone.effectIdempotencyKey, "stale merge tombstone.effectIdempotencyKey", MAX_EFFECT_KEY);
  assertNoRawMergeCallback(tombstone.jobId, "stale merge tombstone.jobId");
  assertNoRawMergeCallback(tombstone.effectIdempotencyKey, "stale merge tombstone.effectIdempotencyKey");
  if (tombstone.jobId !== jobId || tombstone.effectIdempotencyKey !== effectIdempotencyKey) {
    throw new TypeError("stale merge tombstone identity does not match its effect");
  }
  return {
    mergeOutcome: "stale",
    jobId: tombstone.jobId,
    effectIdempotencyKey: tombstone.effectIdempotencyKey,
  };
}

type PersistedMergeStatus = "pending" | "leased" | "done" | "failed" | "dead";

function parseMergeEvidenceIdentity(input: PersistedMergeEvidenceInput): {
  jobId: string;
  effectIdempotencyKey: string;
  status: PersistedMergeStatus;
} {
  assertBoundedString(input.jobId, "merge effect.jobId");
  assertBoundedString(input.idempotencyKey, "merge effect.idempotencyKey", MAX_EFFECT_KEY);
  assertNoRawMergeCallback(input.jobId, "merge effect.jobId");
  assertNoRawMergeCallback(input.idempotencyKey, "merge effect.idempotencyKey");
  if (input.kind !== "merge_pr") throw new TypeError("merge evidence kind is not merge_pr");
  if (input.status !== "pending" && input.status !== "leased" && input.status !== "done" &&
      input.status !== "failed" && input.status !== "dead") {
    throw new TypeError("merge evidence status is invalid");
  }
  return {
    jobId: input.jobId,
    effectIdempotencyKey: input.idempotencyKey,
    status: input.status,
  };
}

function parseTerminalMergeEvidence(
  payload: unknown,
  status: "failed" | "dead",
  jobId: string,
  effectIdempotencyKey: string,
): PersistedMergeEvidence {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("failed merge effect payload must be a JSON object");
  }
  const cleanupPayload = payload as Record<string, unknown>;
  assertExactObjectKeys(cleanupPayload, ["mergeCleanup"], `${status} merge effect payload`);
  if (cleanupPayload.mergeCleanup !== "failed") {
    throw new TypeError(`${status} merge effect cleanup outcome is invalid`);
  }
  return { disposition: status, status, jobId, effectIdempotencyKey };
}

function parseStaleMergeEvidence(
  payload: unknown,
  jobId: string,
  effectIdempotencyKey: string,
): PersistedMergeEvidence {
  return {
    disposition: "stale",
    status: "done",
    jobId,
    effectIdempotencyKey,
    tombstone: parseStaleMergeTombstone(payload, jobId, effectIdempotencyKey),
  };
}

function assertMergeReceiptRowBinding(
  payload: MergeEffectPayload,
  jobId: string,
  effectIdempotencyKey: string,
): void {
  if (payload.receipt.jobId !== jobId || payload.receipt.effectIdempotencyKey !== effectIdempotencyKey) {
    throw new TypeError("merge receipt identity does not match its effect");
  }
}

function parseSuccessfulMergeEvidence(
  payload: unknown,
  jobId: string,
  effectIdempotencyKey: string,
): PersistedMergeEvidence {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("done merge effect payload must be a JSON object");
  }
  const persisted = payload as Record<string, unknown>;
  assertExactObjectKeys(
    persisted,
    ["headSha", "receipt", "mergeCallStartedAt", "mergeCallOutcome", "mergeResult"],
    "done merge effect payload",
  );
  const { mergeResult, ...activePayload } = persisted;
  const mergePayload = parseActiveMergeEffectPayload(activePayload);
  const successResult = parsePersistedMergeSuccessResult(mergeResult);
  assertMergeReceiptRowBinding(mergePayload, jobId, effectIdempotencyKey);
  if (
    successResult.jobId !== jobId ||
    successResult.effectIdempotencyKey !== effectIdempotencyKey ||
    successResult.approvalNonceHash !== mergePayload.receipt.approvalNonceHash ||
    successResult.environmentId !== mergePayload.receipt.environmentId ||
    successResult.prNumber !== mergePayload.receipt.prNumber ||
    successResult.authoritativeHeadSha !== mergePayload.receipt.headSha ||
    successResult.pullRequest.number !== mergePayload.receipt.prNumber ||
    successResult.pullRequest.state !== "MERGED"
  ) throw new TypeError("done merge result does not match its durable receipt");
  return {
    disposition: "success",
    status: "done",
    jobId,
    effectIdempotencyKey,
    payload: mergePayload,
    result: successResult,
  };
}

export function parsePersistedMergeEvidence(
  input: PersistedMergeEvidenceInput,
): PersistedMergeEvidence {
  const identity = parseMergeEvidenceIdentity(input);
  if (identity.status === "failed" || identity.status === "dead") {
    return parseTerminalMergeEvidence(input.payload, identity.status, identity.jobId, identity.effectIdempotencyKey);
  }
  if (identity.status === "done" && input.payload !== null && typeof input.payload === "object" &&
      !Array.isArray(input.payload) && Object.prototype.hasOwnProperty.call(input.payload, "mergeOutcome")) {
    return parseStaleMergeEvidence(input.payload, identity.jobId, identity.effectIdempotencyKey);
  }
  if (identity.status === "done") {
    return parseSuccessfulMergeEvidence(input.payload, identity.jobId, identity.effectIdempotencyKey);
  }
  const mergePayload = parseActiveMergeEffectPayload(input.payload);
  assertMergeReceiptRowBinding(mergePayload, identity.jobId, identity.effectIdempotencyKey);
  return {
    disposition: "active",
    status: identity.status,
    jobId: identity.jobId,
    effectIdempotencyKey: identity.effectIdempotencyKey,
    payload: mergePayload,
  };
}

function mergeEvidenceJobBindingError(
  evidence: Extract<PersistedMergeEvidence, { disposition: "active" | "success" }>,
  job: Job,
): string | null {
  const receipt = evidence.payload.receipt;
  if (evidence.jobId !== job.id || receipt.jobId !== job.id) {
    return "merge evidence job binding does not match the selected job";
  }
  if (receipt.jobVersion !== receipt.approvalJobVersion + 1) {
    return "merge evidence job-version binding is invalid";
  }
  if (job.projectId !== receipt.projectId || job.environmentId !== receipt.environmentId ||
      job.prNumber !== receipt.prNumber || job.policy === null ||
      job.policy.baseBranch !== receipt.baseBranch || job.policy.mergeMethod !== receipt.mergeMethod ||
      JSON.stringify([...job.policy.requiredChecks].sort()) !== JSON.stringify(receipt.requiredCheckNames)) {
    return "merge evidence does not match the immutable job policy";
  }
  return null;
}

function mergeEvidenceApprovalBindingError(
  evidence: Extract<PersistedMergeEvidence, { disposition: "active" | "success" }>,
  job: Job,
  approval: ApprovalState | null,
): string | null {
  const receipt = evidence.payload.receipt;
  if (
    approval === null ||
    approval.jobId !== job.id ||
    approval.headSha !== receipt.headSha ||
    approval.consumedAt === null ||
    approval.outcome !== "accepted" ||
    approval.jobVersion !== receipt.approvalJobVersion ||
    approval.ownerUserId !== receipt.approvalOwnerUserId ||
    approval.ownerChatId !== receipt.approvalOwnerChatId ||
    approval.expiresAt !== Date.parse(receipt.expiresAt)
  ) {
    return "merge evidence does not match its approval";
  }
  return null;
}

function mergeEvidenceAttemptBindingError(
  evidence: Extract<PersistedMergeEvidence, { disposition: "active" | "success" }>,
  job: Job,
  attempt: AttemptRecord | null,
): string | null {
  const receipt = evidence.payload.receipt;
  if (
    attempt === null ||
    attempt.id !== receipt.reviewAttemptId ||
    attempt.jobId !== evidence.jobId ||
    attempt.jobId !== receipt.jobId ||
    attempt.kind !== "review" ||
    attempt.headSha !== receipt.headSha ||
    !isBoundedAttemptCompletion(attempt.completedAt) ||
    typeof attempt.resultJson !== "string"
  ) {
    return "merge evidence owning review attempt is not a strict completed pass";
  }
  if (evidence.disposition === "active" && !isCompletedReviewAttempt(attempt, job.id, receipt.headSha)) {
    return "merge evidence owning review attempt is not a strict completed pass";
  }
  if (evidence.disposition === "success") {
    try {
      const attemptResult = parsePersistedMergeSuccessResult(JSON.parse(attempt.resultJson));
      if (JSON.stringify(attemptResult) !== JSON.stringify(evidence.result)) {
        return "merge success evidence does not match its owning attempt result";
      }
    } catch {
      return "merge success evidence owning attempt result is invalid";
    }
  }
  return null;
}

export function mergeEvidenceBindingError(
  evidence: PersistedMergeEvidence,
  job: Job,
  approval: ApprovalState | null,
  attempt: AttemptRecord | null,
): string | null {
  if (!isReplayableMergeEvidence(evidence)) return null;
  return mergeEvidenceJobBindingError(evidence, job) ??
    mergeEvidenceApprovalBindingError(evidence, job, approval) ??
    mergeEvidenceAttemptBindingError(evidence, job, attempt);
}

function ensureTask9ApprovalColumns(db: SqliteDatabase): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(approvals)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has("owner_user_id")) db.exec("ALTER TABLE approvals ADD COLUMN owner_user_id TEXT");
  if (!columns.has("owner_chat_id")) db.exec("ALTER TABLE approvals ADD COLUMN owner_chat_id TEXT");
  if (!columns.has("job_version")) db.exec("ALTER TABLE approvals ADD COLUMN job_version INTEGER");
}

export interface TelegramAgentStore {
  createPairingCode(codeHash: string, createdAt: number, expiresAt: number): void;
  pairOwnerWithCode(
    codeHash: string,
    userId: string,
    chatId: string,
    now: number,
  ): PairingResult;
  pairOwnerWithPrivateChatCode(
    codeHash: string,
    userId: string,
    chatId: string,
    now: number,
  ): PairingResult;
  getOwner(): Owner | null;
  revokeOwner(now: number): boolean;
  enqueueControllerTurn(input: {
    controllerKey: string;
    telegramUserId: string;
    telegramChatId: string;
    updateId: number;
    inputText: string;
    image?: ControllerImage | null;
    now: number;
  }): ControllerTurnRecord;
  getControllerByThreadId(threadId: string): ControllerThreadRecord | null;
  getControllerForOwner(userId: string, chatId: string): ControllerThreadRecord | null;
  getControllerTurn(turnId: string): ControllerTurnRecord | null;
  claimNextControllerTurn(fence: ControllerLeaseFence & { leaseMs?: number }): ControllerTurnRecord | null;
  requeueControllerTurn(input: ControllerLeaseFence & { turnId: string }): boolean;
  recordControllerImagePreparationFailure(input: ControllerLeaseFence & { turnId: string }): boolean;
  failStaleControllerDispatches(fence: ControllerLeaseFence): boolean;
  markControllerSpawned(input: ControllerLeaseFence & {
    turnId: string;
    projectId: string;
    hostId: string;
    threadId: string;
    leaseMs?: number;
  }): boolean;
  markControllerTurnSubmitted(input: ControllerLeaseFence & {
    turnId: string;
    dispatchAfterSeq?: number;
    leaseMs?: number;
  }): boolean;
  retryUnacceptedControllerTurn(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    expectedThreadId: string;
  }): boolean;
  updateControllerStream(input: ControllerLeaseFence & {
    turnId: string;
    cursor: number;
    text: string;
    phase: ControllerTurnRecord["streamPhase"];
  }): boolean;
  refreshControllerDraft(input: ControllerLeaseFence & {
    turnId: string;
    sentBefore: number;
  }): boolean;
  recordControllerQuestion(input: ControllerLeaseFence & {
    turnId: string;
    interactionId: string;
    questions: readonly ControllerQuestion[];
  }): boolean;
  answerControllerQuestion(input: {
    token: string;
    userId: string;
    chatId: string;
    now: number;
  }): ControllerQuestionAnswer;
  answerControllerQuestionWithText(input: {
    controllerKey: string;
    text: string;
    now: number;
  }): ControllerQuestionAnswer;
  observeThread(input: {
    threadId: string;
    title: string;
    status: string;
    chatId: string;
    now: number;
  }): "finished" | "failed" | null;
  recordThreadInteraction(input: {
    interactionId: string;
    threadId: string;
    title: string;
    interaction: ThreadInteraction;
    chatId: string;
    now: number;
  }): boolean;
  answerThreadInteraction(input: {
    token: string;
    userId: string;
    chatId: string;
    now: number;
  }): ThreadInteractionAnswer;
  getAnsweredThreadInteraction(): ThreadInteractionDelivery | null;
  markThreadInteractionDelivered(interactionId: string, now: number): boolean;
  discardThreadInteractions(threadId: string, keep: readonly string[]): number;
  getPendingControllerQuestion(controllerKey: string): ControllerQuestionRecord | null;
  getAnsweredControllerQuestion(controllerKey: string): ControllerQuestionRecord | null;
  markControllerQuestionDelivered(input: ControllerLeaseFence & { interactionId: string }): boolean;
  getQueuedControllerTurn(controllerKey: string): ControllerTurnRecord | null;
  recordControllerSteerFailure(input: ControllerLeaseFence & { turnId: string }): boolean;
  foldControllerTurnIntoRunning(input: ControllerLeaseFence & { turnId: string }): boolean;
  resetControllerThread(input: ControllerLeaseFence & {
    controllerKey: string;
    expectedThreadId: string;
    reason?: string;
  }): boolean;
  completeControllerTurn(input: ControllerLeaseFence & {
    turnId: string;
    responseText: string;
    leaseMs?: number;
  }): boolean;
  failControllerTurn(input: ControllerLeaseFence & {
    turnId: string;
    error: string;
    ownerMessage?: string;
    leaseMs?: number;
  }): boolean;
  listControllerTurns(controllerKey: string, limit: number): ControllerTurnRecord[];
  getPendingControllerTurn(controllerKey: string): ControllerTurnRecord | null;
  claimToolReceipt(input: ToolReceiptKey & { controllerKey: string; now: number }): ToolReceiptClaim;
  completeToolReceipt(input: ToolReceiptKey & { result: string; now: number }): void;
  failToolReceipt(input: ToolReceiptKey & { error: string; now: number }): void;
  listToolReceipts(turnId: string): { toolName: string; state: string; result: string | null }[];
  listControllerGenerations(controllerKey: string, limit: number): ControllerGeneration[];
  createMonitor(input: {
    controllerKey: string;
    kind: MonitorKind;
    threadId?: string;
    cron?: string;
    instruction: string;
    dueAt: number | null;
    now: number;
  }): MonitorRecord;
  listMonitors(controllerKey: string, includeFinished: boolean): MonitorRecord[];
  listArmedMonitors(limit: number): MonitorRecord[];
  cancelMonitor(id: string, now: number): boolean;
  recordMonitorFired(input: { id: string; nextDueAt: number | null; now: number }): boolean;
  failMonitor(input: { id: string; error: string; now: number }): boolean;
  rememberMemory(input: MemoryInput): MemoryRecord;
  recallMemories(input: { scope: string; query?: string; limit: number; now: number }): MemoryRecord[];
  getMemory(id: string): MemoryRecord | null;
  forgetMemory(input: { id: string; now: number }): boolean;
  countMemories(scope: string): number;
  appendControllerDigest(input: {
    controllerKey: string;
    ordinal: number;
    ownerText: string;
    agentText: string;
    now: number;
  }): void;
  readControllerDigest(controllerKey: string, limit: number): { ownerText: string; agentText: string }[];
  createThreadOperation(input: {
    id: string;
    nonceHash: string;
    ownerUserId: string;
    ownerChatId: string;
    kind: ThreadOperationKind;
    threadId: string;
    text: string | null;
    expiresAt: number;
    now: number;
  }): ThreadOperation;
  markThreadOperationConfirmationSent(id: string, messageId: number, now: number): ThreadOperation;
  failThreadOperationConfirmation(id: string, now: number): boolean;
  confirmThreadOperation(input: {
    nonceHash: string;
    userId: string;
    chatId: string;
    messageId: number;
    now: number;
  }): ThreadOperationConfirmResult;
  getThreadOperation(id: string): ThreadOperation | null;
  failStaleThreadOperations(fence: ControllerLeaseFence): boolean;
  claimNextThreadOperation(fence: ControllerLeaseFence & { leaseMs?: number }): ThreadOperation | null;
  completeThreadOperation(input: ControllerLeaseFence & { id: string; result: string }): boolean;
  failThreadOperation(input: ControllerLeaseFence & { id: string; error: string }): boolean;
  bindTelegramIdentity(input: {
    botId: string;
    username: string;
    now: number;
    hasActiveJob: boolean;
  }): "created" | "same" | "changed" | "active_job_conflict";
  getTelegramIdentity(): TelegramIdentity | null;
  upsertProjectPolicy(policy: ProjectPolicy, now: number): ProjectPolicyRecord;
  getProjectPolicy(projectId: string): ProjectPolicyRecord | null;
  getProjectPolicyByAlias(alias: string): ProjectPolicyRecord | null;
  listEnabledProjectPolicies(): ProjectPolicyRecord[];
  createConfirmedControllerJob(input: {
    controllerThreadId: string;
    projectId: string;
    task: string;
    now: number;
  }): Job;
  createJob(input: {
    id: string;
    sourceUpdateId: number;
    requestText: string;
    now: number;
  }): Job;
  setJobStatusMessage(jobId: string, messageId: number, expectedVersion: number, now: number): Job;
  enqueueSteeringEffect(
    jobId: string,
    updateId: number,
    threadId: string,
    text: string,
    now: number,
  ): boolean;
  enqueueOutbox(item: OutboxInput, now: number): void;
  setLastProject(projectId: string): Promise<void>;
  getLastProject(): Promise<string | null>;
  getJob(jobId: string): Job | null;
  getActiveJob(): Job | null;
  findJobByThreadId(threadId: string): Job | null;
  listJobs(limit: number): Job[];
  applyJobEvent(jobId: string, expectedVersion: number, event: JobEvent, now: number): Job;
  listEffectsForJob(jobId: string): StoredEffect[];
  getEffect(jobId: string, idempotencyKey: string): StoredEffect | null;
  getAttempt(attemptId: string): AttemptRecord | null;
  getAttemptByThreadId(threadId: string): AttemptRecord | null;
  nextAttemptOrdinal(jobId: string, kind: AttemptRecord["kind"]): number;
  createAttempt(input: {
    id: string;
    jobId: string;
    kind: AttemptRecord["kind"];
    ordinal: number;
    headSha?: string | null;
    now: number;
  }): AttemptRecord;
  createPipelineStageAttempt(input: ControllerLeaseFence & {
    id: string;
    jobId: string;
    role: PipelineStageRole;
    ordinal: number;
    inputSha256: string;
  }): PipelineStageAttempt;
  bindPipelineStageThread(input: ControllerLeaseFence & {
    id: string;
    threadId: string;
    environmentId: string;
  }): boolean;
  bindPipelineStageResource(input: ControllerLeaseFence & {
    id: string;
    resourceKind: "bb_thread" | "bb_terminal";
    resourceId: string;
    environmentId: string;
  }): boolean;
  completePipelineStageAttempt(input: ControllerLeaseFence & {
    id: string;
    outputText: string;
    outputSha256: string;
    outcome: Record<string, unknown>;
    startSha?: string | null;
    endSha?: string | null;
  }): boolean;
  failPipelineStageAttempt(input: ControllerLeaseFence & {
    id: string;
    error: string;
  }): boolean;
  getPipelineStageAttempt(id: string): PipelineStageAttempt | null;
  getPipelineStageAttemptByThreadId(threadId: string): PipelineStageAttempt | null;
  getLatestPipelineStageAttempt(jobId: string, role: PipelineStageRole): PipelineStageAttempt | null;
  nextPipelineStageOrdinal(jobId: string, role: PipelineStageRole): number;
  updateAttempt(attemptId: string, patch: {
    threadId?: string | null;
    headSha?: string | null;
    handoffPath?: string | null;
    handoffSha256?: string | null;
    result?: Record<string, unknown> | null;
    completedAt?: number | null;
  }): AttemptRecord;
  claimReviewFormatCorrection(attemptId: string, threadId: string, headSha: string): boolean;
  registerReviewThread(jobId: string, expectedVersion: number, threadId: string, now: number): Job;
  acquireExecutorLease(
    ownerId: string,
    now: number,
    leaseMs: number,
  ): { acquired: true; generation: number } | { acquired: false };
  renewExecutorLease(ownerId: string, generation: number, now: number, leaseMs: number): boolean;
  releaseExecutorLease(ownerId: string, generation: number, now: number): boolean;
  isExecutorLeaseCurrent(ownerId: string, generation: number, now: number): boolean;
  leaseEffects(ownerId: string, generation: number, now: number, limit: number, leaseMs: number): StoredEffect[];
  leaseOutbox(ownerId: string, generation: number, now: number, limit: number, leaseMs: number): StoredOutbox[];
  completeEffect(key: string, ownerId: string, generation: number, now: number): boolean;
  completeOutbox(key: string, ownerId: string, generation: number, messageId: number | null, now: number): boolean;
  completeStatusOutbox(
    key: string,
    ownerId: string,
    generation: number,
    jobId: string,
    expectedVersion: number,
    messageId: number,
    now: number,
  ): boolean;
  replaceStatusOutboxMessage(
    key: string,
    ownerId: string,
    generation: number,
    jobId: string,
    expectedVersion: number,
    messageId: number,
    now: number,
  ): boolean;
  failEffect(key: string, ownerId: string, generation: number, error: string, nextAttemptAt: number, now: number): boolean;
  failOutbox(key: string, ownerId: string, generation: number, error: string, nextAttemptAt: number, now: number): boolean;
  deadLetterEffect(key: string, ownerId: string, generation: number, error: string, now: number): boolean;
  deadLetterOutbox(key: string, ownerId: string, generation: number, error: string, now: number): boolean;
  getOutbox(logicalKey: string): StoredOutbox | null;
  listOutbox(limit: number): StoredOutbox[];
  upsertWorkerLiveness(value: WorkerLiveness): void;
  getWorkerLiveness(jobId: string): WorkerLiveness | null;
  markWorkerLivenessNotified(jobId: string, generation: number, now: number): boolean;
  clearWorkerLiveness(jobId: string, generation: number): boolean;
  leaseMergeEffect(input: {
    jobId: string;
    effectIdempotencyKey: string;
    leaseOwner: string;
    leaseGeneration: number;
    now: number;
    leaseDurationMs: number;
  }): boolean;
  bindMergeEffectReceipt(input: {
    jobId: string;
    effectIdempotencyKey: string;
    receipt: DurableMergeReceipt;
    leaseOwner: string;
    leaseGeneration: number;
    now: number;
  }): boolean;
  prepareMergeCall(input: {
    jobId: string;
    effectIdempotencyKey: string;
    leaseOwner: string;
    leaseGeneration: number;
    now: number;
  }): MergeCallPreparation;
  rejectApprovalAndRecordCallback(input: {
    nonceHash: string;
    callbackId: string;
    jobId: string | null;
    now: number;
    headSha?: string;
  }): ApprovalRejectionResult;
  createApproval(input: {
    nonceHash: string;
    jobId: string;
    headSha: string;
    expiresAt: number;
    now: number;
    ownerUserId?: string | null;
    ownerChatId?: string | null;
    jobVersion?: number | null;
  }): void;
  getUsableApproval(nonceHash: string, now: number): ApprovalRecord | null;
  getApproval(nonceHash: string): ApprovalState | null;
  consumeApproval(input: {
    nonceHash: string;
    now: number;
    identity?: ApprovalIdentity;
  }): ApprovalConsumeResult;
  acceptApprovalAndEnqueueMerge(input: {
    nonceHash: string;
    expectedJobVersion: number;
    effect: JobEffect;
    now: number;
    identity?: ApprovalIdentity;
  }): ApprovalAcceptResult;
  revokeApprovals(jobId: string, reason: string, now: number): number;
  beginTelegramUpdate(updateId: number, now: number): "process" | "processed";
  completeTelegramUpdate(updateId: number, outcome: string, now: number): void;
  failTelegramUpdate(updateId: number, error: string, now: number): void;
  abandonTelegramUpdate(updateId: number, error: string, now: number): void;
  getTelegramUpdateAttempts(updateId: number): number;
  reconcileTelegramCursor(): void;
  getNextTelegramOffset(): number;
  recordCallback(
    callbackId: string,
    jobId: string | null,
    action: string,
    outcome: string,
    now: number,
    completion?: MergeCallbackIdentity,
  ): boolean;
  getCallback(callbackId: string): CallbackRecord | null;
  completeMergeSuccess(input: MergeSuccessInput): boolean;
  preserveUnknownMergeEffect(input: {
    jobId: string;
    effectIdempotencyKey: string;
    now: number;
    leaseOwner: string;
    leaseGeneration: number;
  }): boolean;
  failLeasedMergeEffect(input: MergeFailureInput): boolean;
  failMergeEffect(input: MergeFailureInput): boolean;
  staleMergeEffect(input: MergeStaleInput): boolean;
  enqueueReconcileForThread(threadId: string, now: number): boolean;
}

export type TelegramStatusOutboxStore = TelegramAgentStore & {
  setJobStatusMessageAndOutbox(
    jobId: string,
    messageId: number,
    expectedVersion: number,
    outbox: OutboxInput,
    now: number,
  ): Job;
};

function parsePolicy(row: ProjectPolicyRow): ProjectPolicyRecord {
  return {
    policy: projectPolicySchema.parse(JSON.parse(row.policy_json)),
    version: row.version,
  };
}

function parseControllerThread(row: ControllerThreadRow): ControllerThreadRecord {
  return {
    controllerKey: row.controller_key,
    telegramUserId: row.telegram_user_id,
    telegramChatId: row.telegram_chat_id,
    projectId: row.project_id,
    hostId: row.host_id,
    threadId: row.bb_thread_id,
    state: row.state,
    pendingSpawnToken: row.pending_spawn_token,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseControllerTurn(row: ControllerTurnRow): ControllerTurnRecord {
  const image = parseControllerImage(row);
  return {
    id: row.id,
    updateId: row.telegram_update_id,
    controllerKey: row.controller_key,
    ordinal: row.ordinal,
    inputText: row.input_text,
    image,
    state: row.state,
    leaseOwner: row.lease_owner,
    leaseGeneration: row.lease_generation,
    dispatchAfterSeq: row.dispatch_after_seq,
    retryCount: row.retry_count,
    bbEventSeq: row.bb_event_seq,
    streamText: row.stream_text,
    telegramMessageId: row.telegram_message_id,
    streamPhase: row.stream_phase,
    responseText: row.response_text,
    lastError: row.last_error,
    submittedAt: row.submitted_at,
    completedAt: row.completed_at,
    awaitingInteractionId: row.awaiting_interaction_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseControllerImage(row: ControllerTurnRow): ControllerImage | null {
  if (
    row.image_file_id === null &&
    row.image_file_name === null &&
    row.image_mime_type === null &&
    row.image_size_bytes === null
  ) return null;
  if (row.image_file_id === null || row.image_file_name === null || row.image_mime_type === null) {
    throw new Error("Persisted controller image is incomplete");
  }
  const image = {
    fileId: row.image_file_id,
    fileName: row.image_file_name,
    mimeType: row.image_mime_type,
    sizeBytes: row.image_size_bytes,
  } as ControllerImage;
  assertControllerImage(image);
  return image;
}

function parseThreadOperation(row: ThreadOperationRow): ThreadOperation {
  return {
    id: row.id,
    nonceHash: row.nonce_hash,
    ownerUserId: row.owner_user_id,
    ownerChatId: row.owner_chat_id,
    kind: row.kind,
    threadId: row.thread_id,
    text: row.operation_text,
    state: row.state,
    confirmationMessageId: row.confirmation_message_id,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at,
    leaseOwner: row.lease_owner,
    leaseGeneration: row.lease_generation,
    leaseExpiresAt: row.lease_expires_at,
    result: row.result,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type MonitorRow = {
  id: string;
  controller_key: string;
  kind: string;
  thread_id: string | null;
  cron: string | null;
  instruction: string;
  state: string;
  due_at: number | null;
  fire_count: number;
  last_fired_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

function parseMonitor(row: MonitorRow): MonitorRecord {
  if (row.kind !== "thread_idle" && row.kind !== "schedule") {
    throw new Error(`Unknown persisted monitor kind: ${row.kind}`);
  }
  if (!["armed", "cancelled", "done", "failed"].includes(row.state)) {
    throw new Error(`Unknown persisted monitor state: ${row.state}`);
  }
  return {
    id: row.id,
    controllerKey: row.controller_key,
    kind: row.kind,
    threadId: row.thread_id,
    cron: row.cron,
    instruction: row.instruction,
    state: row.state as MonitorState,
    dueAt: row.due_at,
    fireCount: row.fire_count,
    lastFiredAt: row.last_fired_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type MemoryRow = {
  id: string;
  scope: string;
  kind: string;
  subject: string;
  body: string;
  importance: number;
  confidence: number;
  source: string;
  source_turn_id: string | null;
  use_count: number;
  last_used_at: number | null;
  superseded_by: string | null;
  forgotten_at: number | null;
  created_at: number;
  updated_at: number;
};

function assertMemoryScope(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError("memory scope must be between 1 and 256 characters");
  }
}

function assertMemoryText(value: string, limit: number, field: string): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (text.length === 0 || text.length > limit) {
    throw new TypeError(`${field} must be between 1 and ${limit} characters`);
  }
  return text;
}

function assertUnitInterval(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${field} must be between 0 and 1`);
  }
  return value;
}

function parseMemory(row: MemoryRow): MemoryRecord {
  if (!MEMORY_KINDS.has(row.kind as MemoryKind)) throw new Error(`Unknown persisted memory kind: ${row.kind}`);
  if (row.source !== "owner" && row.source !== "agent") {
    throw new Error(`Unknown persisted memory source: ${row.source}`);
  }
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind as MemoryKind,
    subject: row.subject,
    body: row.body,
    importance: row.importance,
    confidence: row.confidence,
    source: row.source,
    sourceTurnId: row.source_turn_id,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    supersededBy: row.superseded_by,
    forgottenAt: row.forgotten_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Recovers which button was tapped. Callback data carries only a digest, so the
 * candidates are re-derived from the stored interaction and compared.
 */
// Statuses a thread can stop working *from*. Reaching idle or error from
// anything else is bookkeeping, not news.
const WORKING_THREAD_STATUSES = new Set(["active", "starting", "stopping"]);
const NOTICE_COOLDOWN_MS = 10 * 60_000;

function matchThreadInteractionToken(
  interaction: ThreadInteraction,
  token: string,
): { label: string; resolution: Record<string, unknown> } | null {
  if (interaction.kind === "unsupported") return null;
  if (interaction.kind === "approval") {
    for (const decision of interaction.decisions) {
      if (threadDecisionToken(interaction.interactionId, decision) !== token) continue;
      return {
        label: decision === "deny" ? "Denied" : "Allowed",
        resolution: decision === "deny"
          ? { decision }
          : { decision, grantedPermissions: null },
      };
    }
    return null;
  }
  for (const question of interaction.questions) {
    for (const option of question.options) {
      if (questionOptionToken(interaction.interactionId, question.id, option.value) !== token) continue;
      return {
        label: option.label,
        resolution: { kind: "user_answer", answers: { [question.id]: { selected: [option.value] } } },
      };
    }
  }
  return null;
}

function controllerFailureOutbox(turnId: string, chatId: string, ownerMessage?: string): OutboxInput {
  return {
    logicalKey: `controller:${turnId}:reply`,
    chatId,
    payload: {
      text: ownerMessage ?? "I couldn't complete that controller turn safely. Please resend your request.",
      disable_web_page_preview: true,
    },
  };
}

function parseJob(row: JobRow): Job {
  if (!JOB_STATES.has(row.state as JobState)) throw new Error(`Unknown persisted job state: ${row.state}`);
  if (row.resume_state !== null && !JOB_STATES.has(row.resume_state as JobState)) {
    throw new Error(`Unknown persisted resume state: ${row.resume_state}`);
  }
  if (row.blocked_reason !== null && !BLOCKED_REASONS.has(row.blocked_reason)) {
    throw new Error(`Unknown persisted blocked reason: ${row.blocked_reason}`);
  }
  return {
    id: row.id,
    sourceUpdateId: row.source_update_id,
    requestText: row.request_text,
    state: row.state as JobState,
    resumeState: row.resume_state as JobState | null,
    projectId: row.project_id,
    policyVersion: row.policy_version,
    policy: row.policy_json === null
      ? null
      : projectPolicySchema.parse(JSON.parse(row.policy_json)),
    environmentId: row.environment_id,
    implementationThreadId: row.implementation_thread_id,
    reviewThreadId: row.review_thread_id,
    documentationThreadId: row.documentation_thread_id,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    prHeadSha: row.pr_head_sha,
    mergeMessage: row.merge_message,
    mergeCommitSha: row.merge_commit_sha,
    mergedAt: row.merged_at,
    deploymentSummary: row.deployment_summary,
    canarySummary: row.canary_summary,
    statusMessageId: row.status_message_id,
    planCycle: row.plan_cycle,
    reviewCycle: row.review_cycle,
    reviewBlockAt: row.review_block_at,
    cancelRequestedAt: row.cancel_requested_at,
    blockedReason: row.blocked_reason,
    lastError: row.last_error,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parsePipelineStageAttempt(row: PipelineStageAttemptRow): PipelineStageAttempt {
  return {
    id: row.id,
    jobId: row.job_id,
    role: row.role,
    ordinal: row.ordinal,
    state: row.state,
    threadId: row.thread_id,
    environmentId: row.environment_id,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    inputSha256: row.input_sha256,
    outputText: row.output_text,
    outputSha256: row.output_sha256,
    outcome: row.outcome_json === null ? null : JSON.parse(row.outcome_json) as Record<string, unknown>,
    startSha: row.start_sha,
    endSha: row.end_sha,
    lastError: row.last_error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function parseEffect(row: EffectRow): StoredEffect {
  return {
    idempotencyKey: row.idempotency_key,
    jobId: row.job_id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status,
    attempts: row.attempts,
    leaseOwner: row.lease_owner,
    leaseGeneration: row.lease_generation,
    leaseExpiresAt: row.lease_expires_at,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseOutbox(row: OutboxRow): StoredOutbox {
  return {
    logicalKey: row.logical_key,
    chatId: row.chat_id,
    messageId: row.message_id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status,
    attempts: row.attempts,
    leaseOwner: row.lease_owner,
    leaseGeneration: row.lease_generation,
    leaseExpiresAt: row.lease_expires_at,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseAttempt(row: {
  id: string;
  job_id: string;
  kind: AttemptRecord["kind"];
  ordinal: number;
  thread_id: string | null;
  head_sha: string | null;
  handoff_path: string | null;
  handoff_sha256: string | null;
  result_json: string | null;
  completed_at: number | null;
}): AttemptRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    kind: row.kind,
    ordinal: row.ordinal,
    threadId: row.thread_id,
    headSha: row.head_sha,
    handoffPath: row.handoff_path,
    handoffSha256: row.handoff_sha256,
    resultJson: row.result_json,
    completedAt: row.completed_at,
  };
}

function persistJobTransition(
  db: SqliteDatabase,
  jobId: string,
  expectedVersion: number,
  transitionedJob: Job,
): void {
  if (transitionedJob.lastError !== null) assertNoRawMergeCallback(transitionedJob.lastError, "job error");
  if (transitionedJob.prUrl !== null) {
    assertSafeExternalHttpsUrl(transitionedJob.prUrl, "job.prUrl");
  }
  const updated = db
    .prepare(
      `UPDATE jobs SET
         request_text = ?, state = ?, resume_state = ?, project_id = ?,
         policy_version = ?, policy_json = ?, environment_id = ?,
         implementation_thread_id = ?, review_thread_id = ?, documentation_thread_id = ?, pr_number = ?,
         pr_url = ?, pr_head_sha = ?, merge_message = ?, merge_commit_sha = ?, merged_at = ?,
         deployment_summary = ?, canary_summary = ?, status_message_id = ?, plan_cycle = ?, review_cycle = ?,
         review_block_at = ?, cancel_requested_at = ?, blocked_reason = ?,
         last_error = ?, version = ?, updated_at = ?
       WHERE id = ? AND version = ?`,
    )
    .run(
      transitionedJob.requestText,
      transitionedJob.state,
      transitionedJob.resumeState,
      transitionedJob.projectId,
      transitionedJob.policyVersion,
      transitionedJob.policy ? JSON.stringify(transitionedJob.policy) : null,
      transitionedJob.environmentId,
      transitionedJob.implementationThreadId,
      transitionedJob.reviewThreadId,
      transitionedJob.documentationThreadId,
      transitionedJob.prNumber,
      transitionedJob.prUrl,
      transitionedJob.prHeadSha,
      transitionedJob.mergeMessage,
      transitionedJob.mergeCommitSha,
      transitionedJob.mergedAt,
      transitionedJob.deploymentSummary,
      transitionedJob.canarySummary,
      transitionedJob.statusMessageId,
      transitionedJob.planCycle,
      transitionedJob.reviewCycle,
      transitionedJob.reviewBlockAt,
      transitionedJob.cancelRequestedAt,
      transitionedJob.blockedReason,
      transitionedJob.lastError,
      transitionedJob.version,
      transitionedJob.updatedAt,
      jobId,
      expectedVersion,
    );
  if (updated.changes !== 1) throw new VersionConflictError(jobId, expectedVersion);
}

function persistPendingEffects(
  db: SqliteDatabase,
  effects: JobEffect[],
  now: number,
): void {
  const insertEffect = db.prepare(
    `INSERT OR IGNORE INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
  );
  for (const effect of effects) {
    const payloadJson = serializeBoundedJson(effect.payload, "effect payload", MAX_MERGE_RESULT_JSON);
    insertEffect.run(
      effect.idempotencyKey,
      effect.jobId,
      effect.kind,
      payloadJson,
      now,
      now,
      now,
    );
  }
}

const JOB_SELECT = `
  SELECT id, source_update_id, request_text, state, resume_state, project_id,
         policy_version, policy_json, environment_id, implementation_thread_id,
         review_thread_id, documentation_thread_id, pr_number, pr_url, pr_head_sha,
         merge_message, merge_commit_sha, merged_at, deployment_summary, canary_summary, status_message_id,
         plan_cycle, review_cycle, review_block_at, cancel_requested_at, blocked_reason,
         last_error, version, created_at, updated_at
    FROM jobs`;

function serializeOutbox(item: OutboxInput, now: number): string {
  if (!item.logicalKey || !item.chatId) throw new TypeError("outbox identity is required");
  if (!Number.isInteger(now) || now < 0) throw new TypeError("now must be a non-negative integer");
  assertNoRawMergeCallback(item.logicalKey, "outbox logical key");
  assertNoRawMergeCallback(item.chatId, "outbox chat id");
  const payloadJson = serializeBoundedJson(item.payload, "outbox payload", MAX_MERGE_RESULT_JSON);
  if (
    item.messageId !== undefined &&
    item.messageId !== null &&
    (!Number.isInteger(item.messageId) || item.messageId < 1)
  ) {
    throw new TypeError("outbox messageId must be a positive integer");
  }
  return payloadJson;
}

function sanitizedUnknownMergePayload(payloadJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  if (!Number.isInteger(raw.mergeCallStartedAt) || raw.mergeCallOutcome !== "unknown") return null;
  try {
    const payload = parseMergeEffectPayload(raw);
    return serializeBoundedJson(payload, "unknown merge effect payload", MAX_MERGE_RESULT_JSON);
  } catch {
    return serializeBoundedJson({
      mergeCallStartedAt: raw.mergeCallStartedAt,
      mergeCallOutcome: "unknown",
    }, "unknown merge fence", MAX_MERGE_RESULT_JSON);
  }
}

function persistOutbox(
  db: SqliteDatabase,
  item: OutboxInput,
  payloadJson: string,
  now: number,
): void {
  db
    .prepare(
      `INSERT INTO outbox (
         logical_key, chat_id, message_id, payload_json, status, attempts,
         next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)
       ON CONFLICT(logical_key) DO UPDATE SET
         chat_id = excluded.chat_id,
         message_id = COALESCE(excluded.message_id, outbox.message_id),
         payload_json = excluded.payload_json,
         status = 'pending',
         next_attempt_at = excluded.next_attempt_at,
         last_error = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(
      item.logicalKey,
      item.chatId,
      item.messageId ?? null,
      payloadJson,
      now,
      now,
      now,
    );
}

function persistControllerOutbox(
  db: SqliteDatabase,
  item: OutboxInput,
  now: number,
): void {
  persistOutbox(db, item, serializeOutbox(item, now), now);
  db.prepare("UPDATE outbox SET attempts = 0 WHERE logical_key = ?").run(item.logicalKey);
}

function advanceTelegramCursor(db: SqliteDatabase): void {
  const cursor = db
    .prepare("SELECT next_offset FROM telegram_cursor WHERE singleton = 1")
    .get() as { next_offset: number } | undefined;
  if (!cursor) throw new Error("Telegram cursor was not initialized");

  // An update that has burned its retry budget no longer holds the cursor: one
  // undeliverable update must not stall every later update behind it forever.
  const firstUnprocessed = db
    .prepare(
      `SELECT MIN(update_id) AS update_id FROM telegram_updates
        WHERE update_id >= ? AND status <> 'processed' AND attempts < ?`,
    )
    .get(cursor.next_offset, MAX_TELEGRAM_UPDATE_ATTEMPTS) as { update_id: number | null };
  const highest = db
    .prepare(
      "SELECT MAX(update_id) AS update_id FROM telegram_updates WHERE update_id >= ? AND status = 'processed'",
    )
    .get(cursor.next_offset) as { update_id: number | null };

  const nextOffset =
    firstUnprocessed.update_id ??
    (highest.update_id === null ? null : highest.update_id + 1);
  if (nextOffset === null || nextOffset <= cursor.next_offset) return;
  db
    .prepare(
      `UPDATE telegram_cursor
          SET next_offset = CASE WHEN next_offset < ? THEN ? ELSE next_offset END
        WHERE singleton = 1`,
    )
    .run(nextOffset, nextOffset);
}

class SqliteTelegramAgentStore implements TelegramAgentStore {
  private readonly claimOwner = randomUUID();
  private readonly claimedUpdates = new Map<number, number>();

  public constructor(
    private readonly db: SqliteDatabase,
    private readonly kv: PluginKv,
    private readonly clock: () => number,
  ) {}

  private currentNow(): number {
    const now = this.clock();
    assertNonNegativeInteger(now, "store clock");
    return now;
  }

  public createPairingCode(
    codeHash: string,
    createdAt: number,
    expiresAt: number,
  ): void {
    assertSha256Hex(codeHash);
    this.db
      .prepare(
        "INSERT INTO pairing_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)",
      )
      .run(codeHash, createdAt, expiresAt);
  }

  public pairOwnerWithCode(
    codeHash: string,
    userId: string,
    chatId: string,
    now: number,
  ): PairingResult {
    return this.pairOwnerWithCodeInternal(codeHash, userId, chatId, now, true);
  }

  public pairOwnerWithPrivateChatCode(
    codeHash: string,
    userId: string,
    chatId: string,
    now: number,
  ): PairingResult {
    return this.pairOwnerWithCodeInternal(codeHash, userId, chatId, now, false);
  }

  private pairOwnerWithCodeInternal(
    codeHash: string,
    userId: string,
    chatId: string,
    now: number,
    requireMatchingIdentity: boolean,
  ): PairingResult {
    assertSha256Hex(codeHash);
    assertCanonicalPositiveDecimal(userId, "userId");
    assertCanonicalPositiveDecimal(chatId, "chatId");
    if (requireMatchingIdentity && userId !== chatId) {
      throw new TypeError("V1 owner pairing requires userId to equal chatId for a private chat");
    }

    const pair = this.db.transaction((): PairingResult => {
      const code = this.db
        .prepare(
          "SELECT consumed_at, expires_at FROM pairing_codes WHERE code_hash = ?",
        )
        .get(codeHash) as PairingCodeRow | undefined;

      if (!code) return { ok: false, reason: "missing" };
      if (code.consumed_at !== null) return { ok: false, reason: "consumed" };
      if (now >= code.expires_at) return { ok: false, reason: "expired" };

      const owner = this.db
        .prepare(
          "SELECT telegram_user_id, telegram_chat_id, paired_at FROM owners WHERE singleton = 1 AND revoked_at IS NULL",
        )
        .get() as OwnerRow | undefined;
      if (owner) return { ok: false, reason: "already_paired" };

      const consumed = this.db
        .prepare(
          "UPDATE pairing_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?",
        )
        .run(now, codeHash, now);
      if (consumed.changes !== 1) {
        return { ok: false, reason: "consumed" };
      }

      this.db
        .prepare(
          `INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at)
           VALUES (1, ?, ?, ?, NULL)
           ON CONFLICT(singleton) DO UPDATE SET
             telegram_user_id = excluded.telegram_user_id,
             telegram_chat_id = excluded.telegram_chat_id,
             paired_at = excluded.paired_at,
             revoked_at = NULL`,
        )
        .run(userId, chatId, now);

      return { ok: true };
    });

    return pair();
  }

  public getOwner(): Owner | null {
    const row = this.db
      .prepare(
        "SELECT telegram_user_id, telegram_chat_id, paired_at FROM owners WHERE singleton = 1 AND revoked_at IS NULL",
      )
      .get() as OwnerRow | undefined;
    if (!row) return null;
    return {
      userId: row.telegram_user_id,
      chatId: row.telegram_chat_id,
      pairedAt: row.paired_at,
    };
  }

  public revokeOwner(now: number): boolean {
    return this.db.transaction((): boolean => {
      this.revokeControllerAccess(now);
      return this.db
        .prepare("UPDATE owners SET revoked_at = ? WHERE singleton = 1 AND revoked_at IS NULL")
        .run(now).changes === 1;
    }).immediate();
  }

  public enqueueControllerTurn(input: {
    controllerKey: string;
    telegramUserId: string;
    telegramChatId: string;
    updateId: number;
    inputText: string;
    image?: ControllerImage | null;
    now: number;
  }): ControllerTurnRecord {
    assertControllerKey(input.controllerKey);
    assertCanonicalPositiveDecimal(input.telegramUserId, "telegramUserId");
    assertCanonicalPositiveDecimal(input.telegramChatId, "telegramChatId");
    assertNonNegativeInteger(input.updateId, "updateId");
    assertControllerText(input.inputText, "controller input");
    const image = input.image ?? null;
    if (image) assertControllerImage(image);
    assertNonNegativeInteger(input.now, "now");

    return this.db.transaction((): ControllerTurnRecord => {
      const owner = this.getOwner();
      if (!owner || owner.userId !== input.telegramUserId || owner.chatId !== input.telegramChatId) {
        throw new TypeError("controller owner is not the active paired owner");
      }

      const existing = this.db
        .prepare("SELECT * FROM controller_turns WHERE telegram_update_id = ?")
        .get(input.updateId) as ControllerTurnRow | undefined;
      if (existing) {
        if (
          existing.controller_key !== input.controllerKey ||
          existing.input_text !== input.inputText ||
          existing.image_file_id !== (image?.fileId ?? null) ||
          existing.image_file_name !== (image?.fileName ?? null) ||
          existing.image_mime_type !== (image?.mimeType ?? null) ||
          existing.image_size_bytes !== (image?.sizeBytes ?? null)
        ) {
          throw new IdempotencyConflictError(input.updateId);
        }
        return parseControllerTurn(existing);
      }

      const controller = this.db
        .prepare("SELECT * FROM controller_threads WHERE controller_key = ?")
        .get(input.controllerKey) as ControllerThreadRow | undefined;
      if (controller && (
        controller.telegram_user_id !== input.telegramUserId ||
        controller.telegram_chat_id !== input.telegramChatId
      )) {
        throw new TypeError("controller key belongs to a different Telegram owner");
      }
      if (controller?.state === "revoked") {
        this.db.prepare(
          `UPDATE controller_threads
              SET project_id = NULL, host_id = NULL, bb_thread_id = NULL,
                  state = 'pending_spawn', pending_spawn_token = NULL,
                  last_error = NULL, updated_at = ?
            WHERE controller_key = ? AND state = 'revoked'`,
        ).run(input.now, input.controllerKey);
      }
      if (!controller) {
        this.db.prepare(
          `INSERT INTO controller_threads (
             controller_key, telegram_user_id, telegram_chat_id, state, created_at, updated_at
           ) VALUES (?, ?, ?, 'pending_spawn', ?, ?)`,
        ).run(input.controllerKey, input.telegramUserId, input.telegramChatId, input.now, input.now);
      }

      const next = this.db
        .prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM controller_turns WHERE controller_key = ?")
        .get(input.controllerKey) as { ordinal: number };
      const id = `controller-turn-${input.updateId}`;
      this.db.prepare(
        `INSERT INTO controller_turns (
           id, telegram_update_id, controller_key, ordinal, input_text,
           image_file_id, image_file_name, image_mime_type, image_size_bytes,
           state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      ).run(
        id,
        input.updateId,
        input.controllerKey,
        next.ordinal,
        input.inputText,
        image?.fileId ?? null,
        image?.fileName ?? null,
        image?.mimeType ?? null,
        image?.sizeBytes ?? null,
        input.now,
        input.now,
      );
      const stored = this.db.prepare("SELECT * FROM controller_turns WHERE id = ?").get(id) as ControllerTurnRow;
      return parseControllerTurn(stored);
    }).immediate();
  }

  public getControllerByThreadId(threadId: string): ControllerThreadRecord | null {
    assertControllerIdentifier(threadId, "threadId");
    const row = this.db.prepare(
      `SELECT controller_threads.* FROM controller_threads
         JOIN owners ON owners.singleton = 1
          AND owners.revoked_at IS NULL
          AND owners.telegram_user_id = controller_threads.telegram_user_id
          AND owners.telegram_chat_id = controller_threads.telegram_chat_id
        WHERE controller_threads.bb_thread_id = ? AND controller_threads.state <> 'revoked'`,
    ).get(threadId) as ControllerThreadRow | undefined;
    return row ? parseControllerThread(row) : null;
  }

  public getControllerForOwner(userId: string, chatId: string): ControllerThreadRecord | null {
    assertCanonicalPositiveDecimal(userId, "userId");
    assertCanonicalPositiveDecimal(chatId, "chatId");
    const row = this.db.prepare(
      `SELECT controller_threads.* FROM controller_threads
         JOIN owners ON owners.singleton = 1
          AND owners.revoked_at IS NULL
          AND owners.telegram_user_id = controller_threads.telegram_user_id
          AND owners.telegram_chat_id = controller_threads.telegram_chat_id
        WHERE controller_threads.telegram_user_id = ? AND controller_threads.telegram_chat_id = ?
          AND controller_threads.state <> 'revoked'`,
    ).get(userId, chatId) as ControllerThreadRow | undefined;
    return row ? parseControllerThread(row) : null;
  }

  public getControllerTurn(turnId: string): ControllerTurnRecord | null {
    assertControllerIdentifier(turnId, "turnId");
    const row = this.db.prepare("SELECT * FROM controller_turns WHERE id = ?").get(turnId) as ControllerTurnRow | undefined;
    return row ? parseControllerTurn(row) : null;
  }

  public claimNextControllerTurn(
    fence: ControllerLeaseFence & { leaseMs?: number },
  ): ControllerTurnRecord | null {
    this.assertLeaseIdentity("controller-turn", fence.ownerId, fence.generation, fence.now);
    return this.db.transaction((): ControllerTurnRecord | null => {
      if (!this.executorLeaseIsCurrent(fence.ownerId, fence.generation, fence.now)) return null;
      const row = this.db.prepare(
        `SELECT turn.* FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
           JOIN owners ON owners.singleton = 1
            AND owners.revoked_at IS NULL
            AND owners.telegram_user_id = controller.telegram_user_id
            AND owners.telegram_chat_id = controller.telegram_chat_id
          WHERE turn.state = 'queued'
            AND NOT EXISTS (
              SELECT 1 FROM controller_turns AS active
               WHERE active.controller_key = turn.controller_key
                 AND active.state IN ('dispatching', 'submitted')
            )
          ORDER BY turn.created_at ASC, turn.ordinal ASC LIMIT 1`,
      ).get() as ControllerTurnRow | undefined;
      if (!row) return null;
      const updated = this.db.prepare(
        `UPDATE controller_turns
            SET state = 'dispatching', lease_owner = ?, lease_generation = ?, updated_at = ?
          WHERE id = ? AND state = 'queued'`,
      ).run(fence.ownerId, fence.generation, fence.now, row.id);
      if (updated.changes !== 1) return null;
      this.db.prepare(
        `UPDATE controller_threads
            SET pending_spawn_token = COALESCE(pending_spawn_token, ?), updated_at = ?
          WHERE controller_key = ? AND bb_thread_id IS NULL`,
      ).run(row.id, fence.now, row.controller_key);
      const claimed = this.db.prepare("SELECT * FROM controller_turns WHERE id = ?").get(row.id) as ControllerTurnRow;
      return parseControllerTurn(claimed);
    }).immediate();
  }

  // A claim taken while the BB thread is still answering is returned to the
  // queue rather than failed, so the message is still delivered a moment later.
  public requeueControllerTurn(input: ControllerLeaseFence & { turnId: string }): boolean {
    this.assertControllerMutation(input);
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const requeued = this.db.prepare(
        `UPDATE controller_turns
            SET state = 'queued', lease_owner = NULL, lease_generation = NULL, updated_at = ?
          WHERE id = ? AND state = 'dispatching' AND lease_owner = ? AND lease_generation = ?`,
      ).run(input.now, input.turnId, input.ownerId, input.generation);
      if (requeued.changes !== 1) return false;
      this.db.prepare(
        `UPDATE controller_threads SET pending_spawn_token = NULL, updated_at = ?
          WHERE controller_key = (SELECT controller_key FROM controller_turns WHERE id = ?)
            AND bb_thread_id IS NULL AND pending_spawn_token = ?`,
      ).run(input.now, input.turnId, input.turnId);
      return true;
    }).immediate();
  }

  public recordControllerImagePreparationFailure(
    input: ControllerLeaseFence & { turnId: string },
  ): boolean {
    this.assertControllerMutation(input);
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const requeued = this.db.prepare(
        `UPDATE controller_turns
            SET state = 'queued', retry_count = retry_count + 1,
                lease_owner = NULL, lease_generation = NULL, updated_at = ?
          WHERE id = ? AND state = 'dispatching' AND lease_owner = ? AND lease_generation = ?`,
      ).run(input.now, input.turnId, input.ownerId, input.generation);
      if (requeued.changes !== 1) return false;
      this.db.prepare(
        `UPDATE controller_threads SET pending_spawn_token = NULL, updated_at = ?
          WHERE controller_key = (SELECT controller_key FROM controller_turns WHERE id = ?)
            AND bb_thread_id IS NULL AND pending_spawn_token = ?`,
      ).run(input.now, input.turnId, input.turnId);
      return true;
    }).immediate();
  }

  public failStaleControllerDispatches(fence: ControllerLeaseFence): boolean {
    this.assertLeaseIdentity("controller-turn", fence.ownerId, fence.generation, fence.now);
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(fence.ownerId, fence.generation, fence.now)) return false;
      const stale = this.db.prepare(
        `SELECT turn.*, controller.telegram_chat_id FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
           JOIN owners ON owners.singleton = 1 AND owners.revoked_at IS NULL
            AND owners.telegram_user_id = controller.telegram_user_id
            AND owners.telegram_chat_id = controller.telegram_chat_id
          WHERE turn.state = 'dispatching'
            AND (turn.lease_owner <> ? OR turn.lease_generation <> ?)
          ORDER BY turn.created_at ASC, turn.ordinal ASC LIMIT 1`,
      ).get(fence.ownerId, fence.generation) as (ControllerTurnRow & { telegram_chat_id: string }) | undefined;
      if (!stale) return false;
      const error = "Controller dispatch ownership was lost before submission was confirmed";
      const updated = this.db.prepare(
        `UPDATE controller_turns
            SET state = 'failed', last_error = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND state = 'dispatching'`,
      ).run(error, fence.now, fence.now, stale.id);
      if (updated.changes !== 1) return false;
      this.db.prepare(
        `UPDATE controller_threads SET pending_spawn_token = NULL, updated_at = ?
          WHERE controller_key = ? AND bb_thread_id IS NULL AND pending_spawn_token = ?`,
      ).run(fence.now, stale.controller_key, stale.id);
      const outbox = controllerFailureOutbox(stale.id, stale.telegram_chat_id);
      persistControllerOutbox(this.db, outbox, fence.now);
      return true;
    }).immediate();
  }

  public markControllerSpawned(input: ControllerLeaseFence & {
    turnId: string;
    projectId: string;
    hostId: string;
    threadId: string;
    leaseMs?: number;
  }): boolean {
    this.assertControllerMutation(input);
    assertControllerIdentifier(input.projectId, "projectId");
    assertControllerIdentifier(input.hostId, "hostId");
    assertControllerIdentifier(input.threadId, "threadId");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const turn = this.db.prepare("SELECT * FROM controller_turns WHERE id = ?").get(input.turnId) as ControllerTurnRow | undefined;
      if (
        !turn || turn.state !== "dispatching" ||
        turn.lease_owner !== input.ownerId || turn.lease_generation !== input.generation
      ) return false;
      const spawned = this.db.prepare(
        `UPDATE controller_threads
            SET project_id = ?, host_id = ?, bb_thread_id = ?, state = 'active',
                pending_spawn_token = NULL, last_error = NULL, updated_at = ?
          WHERE controller_key = ?`,
      ).run(input.projectId, input.hostId, input.threadId, input.now, turn.controller_key).changes === 1;
      if (spawned) {
        this.db.prepare(
          `INSERT INTO controller_generations (id, controller_key, thread_id, started_at, ended_at, end_reason)
           VALUES (?, ?, ?, ?, NULL, NULL)`,
        ).run(`gen-${randomUUID()}`, turn.controller_key, input.threadId, input.now);
      }
      return spawned;
    }).immediate();
  }

  public markControllerTurnSubmitted(
    input: ControllerLeaseFence & {
      turnId: string;
      dispatchAfterSeq?: number;
      leaseMs?: number;
    },
  ): boolean {
    this.assertControllerMutation(input);
    const dispatchAfterSeq = input.dispatchAfterSeq ?? 0;
    assertNonNegativeInteger(dispatchAfterSeq, "dispatchAfterSeq");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const updated = this.db.prepare(
        `UPDATE controller_turns
            SET state = 'submitted', dispatch_after_seq = ?, bb_event_seq = ?,
                stream_phase = 'connecting', submitted_at = ?, updated_at = ?
          WHERE id = ? AND state = 'dispatching' AND lease_owner = ? AND lease_generation = ?
            AND EXISTS (
              SELECT 1 FROM controller_threads
               WHERE controller_key = controller_turns.controller_key
                 AND state = 'active' AND bb_thread_id IS NOT NULL
            )`,
      ).run(
        dispatchAfterSeq,
        dispatchAfterSeq,
        input.now,
        input.now,
        input.turnId,
        input.ownerId,
        input.generation,
      );
      if (updated.changes !== 1) return false;
      const row = this.db.prepare(
        `SELECT turn.id, controller.telegram_chat_id
           FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
          WHERE turn.id = ? AND turn.state = 'submitted'`,
      ).get(input.turnId) as { id: string; telegram_chat_id: string } | undefined;
      if (!row) throw new Error("Submitted controller turn disappeared before placeholder creation");
      const outbox: OutboxInput = {
        logicalKey: `controller:${row.id}:reply`,
        chatId: row.telegram_chat_id,
        payload: { text: "Connecting to Luna Max…", disable_web_page_preview: true },
      };
      persistControllerOutbox(this.db, outbox, input.now);
      return true;
    }).immediate();
  }

  public retryUnacceptedControllerTurn(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    expectedThreadId: string;
  }): boolean {
    this.assertControllerMutation(input);
    assertControllerKey(input.controllerKey);
    assertControllerIdentifier(input.expectedThreadId, "expectedThreadId");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const eligible = this.db.prepare(
        `SELECT 1 FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
          WHERE turn.id = ? AND turn.controller_key = ? AND turn.state = 'submitted'
            AND turn.retry_count = 0 AND controller.bb_thread_id = ? AND controller.state = 'active'`,
      ).get(input.turnId, input.controllerKey, input.expectedThreadId);
      if (!eligible) return false;
      const turn = this.db.prepare(
        `UPDATE controller_turns
            SET state = 'queued', lease_owner = NULL, lease_generation = NULL,
                dispatch_after_seq = 0, bb_event_seq = 0, retry_count = retry_count + 1,
                stream_text = '', stream_phase = 'queued', submitted_at = NULL,
                last_error = NULL, updated_at = ?
          WHERE id = ? AND controller_key = ? AND state = 'submitted' AND retry_count = 0`,
      ).run(input.now, input.turnId, input.controllerKey);
      if (turn.changes !== 1) throw new Error("Controller turn changed during unaccepted retry");
      const controller = this.db.prepare(
        `UPDATE controller_threads
            SET project_id = NULL, host_id = NULL, bb_thread_id = NULL,
                state = 'pending_spawn', pending_spawn_token = NULL,
                last_error = NULL, updated_at = ?
          WHERE controller_key = ? AND bb_thread_id = ? AND state = 'active'`,
      ).run(input.now, input.controllerKey, input.expectedThreadId);
      if (controller.changes !== 1) throw new Error("Controller generation changed during unaccepted retry");
      return true;
    }).immediate();
  }

  public updateControllerStream(input: ControllerLeaseFence & {
    turnId: string;
    cursor: number;
    text: string;
    phase: ControllerTurnRecord["streamPhase"];
  }): boolean {
    this.assertControllerMutation(input);
    assertNonNegativeInteger(input.cursor, "cursor");
    assertControllerText(input.text || "Controller stream is empty", "controller stream");
    const phases = new Set<ControllerTurnRecord["streamPhase"]>([
      "queued", "connecting", "thinking", "using_tools", "responding", "complete", "failed",
    ]);
    if (!phases.has(input.phase)) throw new TypeError("Unknown controller stream phase");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const row = this.db.prepare(
        `SELECT turn.*, controller.telegram_chat_id
           FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
          WHERE turn.id = ? AND turn.state = 'submitted' AND turn.bb_event_seq < ?`,
      ).get(input.turnId, input.cursor) as (ControllerTurnRow & { telegram_chat_id: string }) | undefined;
      if (!row) return false;
      const updated = this.db.prepare(
        `UPDATE controller_turns
            SET bb_event_seq = ?, stream_text = ?, stream_phase = ?, updated_at = ?
          WHERE id = ? AND state = 'submitted' AND bb_event_seq < ?`,
      ).run(input.cursor, input.text, input.phase, input.now, input.turnId, input.cursor);
      if (updated.changes !== 1) return false;
      const displayText = input.text || (input.phase === "thinking" ? "Luna Max is thinking…" : "Connecting to Luna Max…");
      const outbox: OutboxInput = {
        logicalKey: `controller:${input.turnId}:reply`,
        chatId: row.telegram_chat_id,
        messageId: row.telegram_message_id,
        payload: { ...formattedMessage(displayText), disable_web_page_preview: true },
      };
      persistControllerOutbox(this.db, outbox, input.now);
      return true;
    }).immediate();
  }

  /**
   * Parks a submitted turn on a question only the owner can settle and asks it
   * in Telegram. The turn stays submitted because the BB turn really is still
   * open — it is waiting on a person, not on the model.
   */
  public recordControllerQuestion(input: ControllerLeaseFence & {
    turnId: string;
    interactionId: string;
    questions: readonly ControllerQuestion[];
  }): boolean {
    this.assertControllerMutation(input);
    assertControllerIdentifier(input.interactionId, "interactionId");
    if (input.questions.length === 0) throw new TypeError("a controller question must have questions");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const row = this.db.prepare(
        `SELECT turn.*, controller.telegram_chat_id FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
          WHERE turn.id = ? AND turn.state = 'submitted'`,
      ).get(input.turnId) as (ControllerTurnRow & { telegram_chat_id: string }) | undefined;
      if (!row) return false;
      // Seeing the same question again on a later poll must not re-ask it.
      const known = this.db.prepare("SELECT 1 FROM controller_questions WHERE interaction_id = ?")
        .get(input.interactionId);
      if (known) return false;
      this.db.prepare(
        `INSERT INTO controller_questions
           (interaction_id, turn_id, controller_key, questions_json, state, answers_json, asked_at, answered_at)
         VALUES (?, ?, ?, ?, 'pending', '{}', ?, NULL)`,
      ).run(
        input.interactionId,
        row.id,
        row.controller_key,
        JSON.stringify(input.questions),
        input.now,
      );
      this.db.prepare(
        `UPDATE controller_turns SET awaiting_interaction_id = ?, updated_at = ?
          WHERE id = ? AND state = 'submitted'`,
      ).run(input.interactionId, input.now, input.turnId);
      this.askControllerQuestion(input.interactionId, row.telegram_chat_id, input.questions, {}, input.now);
      return true;
    }).immediate();
  }

  private askControllerQuestion(
    interactionId: string,
    chatId: string,
    questions: readonly ControllerQuestion[],
    answers: ControllerQuestionAnswers,
    now: number,
  ): void {
    const next = nextUnansweredQuestion(questions, answers);
    if (!next) return;
    const rendered = renderQuestion(interactionId, next.question);
    persistControllerOutbox(this.db, {
      logicalKey: `controller-question:${interactionId}:${next.index}`,
      chatId,
      payload: {
        ...formattedMessage(rendered.text),
        reply_markup: rendered.reply_markup,
        disable_web_page_preview: true,
      },
    }, now);
  }

  private settleControllerQuestion(
    row: ControllerQuestionRow,
    questionId: string,
    answer: { selected: string[]; freeText?: string },
    now: number,
  ): ControllerQuestionAnswer {
    const questions = JSON.parse(row.questions_json) as ControllerQuestion[];
    const answers = { ...JSON.parse(row.answers_json) as ControllerQuestionAnswers, [questionId]: answer };
    const complete = nextUnansweredQuestion(questions, answers) === null;
    const updated = this.db.prepare(
      `UPDATE controller_questions
          SET answers_json = ?, state = ?, answered_at = ?
        WHERE interaction_id = ? AND state = 'pending'`,
    ).run(
      JSON.stringify(answers),
      complete ? "answered" : "pending",
      complete ? now : null,
      row.interaction_id,
    );
    if (updated.changes !== 1) return { ok: false, reason: "stale" };
    if (complete) {
      this.db.prepare(
        `UPDATE controller_turns SET awaiting_interaction_id = NULL, updated_at = ?
          WHERE id = ? AND awaiting_interaction_id = ?`,
      ).run(now, row.turn_id, row.interaction_id);
    } else {
      const chatId = this.db.prepare(
        "SELECT telegram_chat_id FROM controller_threads WHERE controller_key = ?",
      ).get(row.controller_key) as { telegram_chat_id: string } | undefined;
      if (chatId) this.askControllerQuestion(row.interaction_id, chatId.telegram_chat_id, questions, answers, now);
    }
    return {
      ok: true,
      complete,
      turnId: row.turn_id,
      interactionId: row.interaction_id,
      answers,
    };
  }

  /** Answers whichever question a tapped button stands for. */
  public answerControllerQuestion(input: {
    token: string;
    userId: string;
    chatId: string;
    now: number;
  }): ControllerQuestionAnswer {
    assertCanonicalPositiveDecimal(input.userId, "userId");
    assertCanonicalPositiveDecimal(input.chatId, "chatId");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): ControllerQuestionAnswer => {
      const row = this.db.prepare(
        `SELECT question.* FROM controller_questions AS question
           JOIN controller_threads AS controller ON controller.controller_key = question.controller_key
           JOIN owners ON owners.singleton = 1 AND owners.revoked_at IS NULL
            AND owners.telegram_user_id = controller.telegram_user_id
            AND owners.telegram_chat_id = controller.telegram_chat_id
           JOIN controller_turns AS turn ON turn.id = question.turn_id AND turn.state = 'submitted'
          WHERE question.state = 'pending'
            AND controller.telegram_user_id = ? AND controller.telegram_chat_id = ?
          ORDER BY question.asked_at DESC LIMIT 1`,
      ).get(input.userId, input.chatId) as ControllerQuestionRow | undefined;
      if (!row) return { ok: false, reason: "stale" };
      const questions = JSON.parse(row.questions_json) as ControllerQuestion[];
      const answers = JSON.parse(row.answers_json) as ControllerQuestionAnswers;
      for (const question of questions) {
        if (question.id in answers) continue;
        for (const option of question.options) {
          if (questionOptionToken(row.interaction_id, question.id, option.value) !== input.token) continue;
          return this.settleControllerQuestion(row, question.id, { selected: [option.value] }, input.now);
        }
      }
      return { ok: false, reason: "stale" };
    }).immediate();
  }

  /**
   * A plain reply answers the open question. The owner is having a conversation,
   * not filling in a form, so "in review i mean not in progress" is an answer.
   */
  public answerControllerQuestionWithText(input: {
    controllerKey: string;
    text: string;
    now: number;
  }): ControllerQuestionAnswer {
    assertControllerKey(input.controllerKey);
    assertControllerText(input.text, "controller question answer");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): ControllerQuestionAnswer => {
      const row = this.db.prepare(
        `SELECT question.* FROM controller_questions AS question
           JOIN controller_turns AS turn ON turn.id = question.turn_id AND turn.state = 'submitted'
          WHERE question.controller_key = ? AND question.state = 'pending'
          ORDER BY question.asked_at DESC LIMIT 1`,
      ).get(input.controllerKey) as ControllerQuestionRow | undefined;
      if (!row) return { ok: false, reason: "stale" };
      const questions = JSON.parse(row.questions_json) as ControllerQuestion[];
      const answers = JSON.parse(row.answers_json) as ControllerQuestionAnswers;
      const next = nextUnansweredQuestion(questions, answers);
      if (!next) return { ok: false, reason: "stale" };
      return this.settleControllerQuestion(row, next.question.id, { selected: [], freeText: input.text }, input.now);
    }).immediate();
  }

  /**
   * Counts a steer BB would not take. The reconcile loop runs at draft speed
   * while an answer streams, so an unbounded retry here would be a hot loop
   * against BB rather than a recovery.
   */
  public recordControllerSteerFailure(input: ControllerLeaseFence & { turnId: string }): boolean {
    this.assertControllerMutation(input);
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      return this.db.prepare(
        `UPDATE controller_turns SET retry_count = retry_count + 1, updated_at = ?
          WHERE id = ? AND state = 'queued'`,
      ).run(input.now, input.turnId).changes === 1;
    }).immediate();
  }

  /** The oldest message still waiting behind an answer that is being written. */
  public getQueuedControllerTurn(controllerKey: string): ControllerTurnRecord | null {
    assertControllerKey(controllerKey);
    const row = this.db.prepare(
      `SELECT * FROM controller_turns WHERE controller_key = ? AND state = 'queued'
        ORDER BY created_at ASC, ordinal ASC LIMIT 1`,
    ).get(controllerKey) as ControllerTurnRow | undefined;
    return row ? parseControllerTurn(row) : null;
  }

  /**
   * Retires a queued message that was handed to the turn already running. It
   * gets no reply of its own because the answer in flight now covers it —
   * a correction like "I meant in review" wants the first answer fixed, not a
   * second answer written.
   */
  public foldControllerTurnIntoRunning(input: ControllerLeaseFence & { turnId: string }): boolean {
    this.assertControllerMutation(input);
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const row = this.db.prepare(
        "SELECT * FROM controller_turns WHERE id = ? AND state = 'queued'",
      ).get(input.turnId) as ControllerTurnRow | undefined;
      if (!row) return false;
      const folded = "(sent to the answer already in progress)";
      const updated = this.db.prepare(
        `UPDATE controller_turns
            SET state = 'completed', response_text = ?, stream_phase = 'complete',
                completed_at = ?, updated_at = ?
          WHERE id = ? AND state = 'queued'`,
      ).run(folded, input.now, input.now, input.turnId);
      if (updated.changes !== 1) return false;
      this.appendControllerDigestRow({
        controllerKey: row.controller_key,
        ordinal: row.ordinal,
        ownerText: row.input_text,
        agentText: folded,
        now: input.now,
      });
      return true;
    }).immediate();
  }

  /**
   * Records where a watched thread stands and returns the notice the owner is
   * owed, if any. A thread first seen already finished is recorded silently:
   * the owner wants to hear about threads that finish while they are watching,
   * not a backlog of every thread that ever ran.
   */
  public observeThread(input: {
    threadId: string;
    title: string;
    status: string;
    chatId: string;
    now: number;
  }): "finished" | "failed" | null {
    assertControllerIdentifier(input.threadId, "threadId");
    assertControllerText(input.title, "thread title");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): "finished" | "failed" | null => {
      const known = this.db.prepare("SELECT * FROM observed_threads WHERE thread_id = ?")
        .get(input.threadId) as ObservedThreadRow | undefined;
      if (!known) {
        this.db.prepare(
          `INSERT INTO observed_threads
             (thread_id, title, last_status, notified_status, first_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(input.threadId, input.title, input.status, input.status, input.now, input.now);
        return null;
      }
      this.db.prepare(
        "UPDATE observed_threads SET title = ?, last_status = ?, updated_at = ? WHERE thread_id = ?",
      ).run(input.title, input.status, input.now, input.threadId);
      if (input.status === known.last_status) return null;
      const notice = input.status === "idle" ? "finished" : input.status === "error" ? "failed" : null;
      if (notice === null) return null;
      // Only a thread that was working can stop working. A thread that finished
      // and is marked failed afterwards has already had its say, and repeating
      // it as a failure would contradict what the owner just read.
      if (!WORKING_THREAD_STATUSES.has(known.last_status)) return null;
      // A thread being steered turn by turn would otherwise narrate every reply.
      if (known.notified_at !== null && input.now - known.notified_at < NOTICE_COOLDOWN_MS) return null;
      this.db.prepare("UPDATE observed_threads SET notified_status = ?, notified_at = ? WHERE thread_id = ?")
        .run(input.status, input.now, input.threadId);
      persistControllerOutbox(this.db, {
        logicalKey: `thread:${input.threadId}:${input.status}`,
        chatId: input.chatId,
        payload: {
          ...formattedMessage(`*${input.title}* ${notice}.`),
          disable_web_page_preview: true,
        },
      }, input.now);
      return notice;
    }).immediate();
  }

  /** Asks the owner to unblock a thread that is waiting on a decision. */
  public recordThreadInteraction(input: {
    interactionId: string;
    threadId: string;
    title: string;
    interaction: ThreadInteraction;
    chatId: string;
    now: number;
  }): boolean {
    assertControllerIdentifier(input.interactionId, "interactionId");
    assertControllerIdentifier(input.threadId, "threadId");
    assertControllerText(input.title, "thread title");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): boolean => {
      const known = this.db.prepare("SELECT 1 FROM thread_interactions WHERE interaction_id = ?")
        .get(input.interactionId);
      if (known) return false;
      this.db.prepare(
        `INSERT INTO thread_interactions
           (interaction_id, thread_id, title, kind, payload_json, state, answer_json, asked_at, answered_at)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
      ).run(
        input.interactionId,
        input.threadId,
        input.title,
        input.interaction.kind,
        JSON.stringify(input.interaction),
        input.now,
      );
      const rendered = renderThreadInteraction(input.title, input.interaction);
      persistControllerOutbox(this.db, {
        logicalKey: `thread-interaction:${input.interactionId}`,
        chatId: input.chatId,
        payload: {
          ...formattedMessage(rendered.text),
          ...("reply_markup" in rendered ? { reply_markup: rendered.reply_markup } : {}),
          disable_web_page_preview: true,
        },
      }, input.now);
      return true;
    }).immediate();
  }

  /** Resolves a watched thread's block from a tapped button. */
  public answerThreadInteraction(input: {
    token: string;
    userId: string;
    chatId: string;
    now: number;
  }): ThreadInteractionAnswer {
    assertCanonicalPositiveDecimal(input.userId, "userId");
    assertCanonicalPositiveDecimal(input.chatId, "chatId");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): ThreadInteractionAnswer => {
      const owner = this.db.prepare(
        `SELECT 1 FROM owners WHERE singleton = 1 AND revoked_at IS NULL
          AND telegram_user_id = ? AND telegram_chat_id = ?`,
      ).get(input.userId, input.chatId);
      if (!owner) return { ok: false, reason: "stale" };
      const rows = this.db.prepare(
        "SELECT * FROM thread_interactions WHERE state = 'pending' ORDER BY asked_at DESC LIMIT 20",
      ).all() as ThreadInteractionRow[];
      for (const row of rows) {
        const interaction = JSON.parse(row.payload_json) as ThreadInteraction;
        const matched = matchThreadInteractionToken(interaction, input.token);
        if (!matched) continue;
        const updated = this.db.prepare(
          `UPDATE thread_interactions SET state = 'answered', answer_json = ?, answered_at = ?
            WHERE interaction_id = ? AND state = 'pending'`,
        ).run(JSON.stringify(matched.resolution), input.now, row.interaction_id);
        if (updated.changes !== 1) return { ok: false, reason: "stale" };
        return {
          ok: true,
          interactionId: row.interaction_id,
          threadId: row.thread_id,
          title: row.title,
          label: matched.label,
        };
      }
      return { ok: false, reason: "stale" };
    }).immediate();
  }

  public getAnsweredThreadInteraction(): ThreadInteractionDelivery | null {
    const row = this.db.prepare(
      "SELECT * FROM thread_interactions WHERE state = 'answered' ORDER BY answered_at ASC LIMIT 1",
    ).get() as ThreadInteractionRow | undefined;
    if (!row || row.answer_json === null) return null;
    return {
      interactionId: row.interaction_id,
      threadId: row.thread_id,
      title: row.title,
      resolution: JSON.parse(row.answer_json) as Record<string, unknown>,
    };
  }

  public markThreadInteractionDelivered(interactionId: string, now: number): boolean {
    assertControllerIdentifier(interactionId, "interactionId");
    assertNonNegativeInteger(now, "now");
    return this.db.prepare(
      "UPDATE thread_interactions SET state = 'delivered' WHERE interaction_id = ? AND state = 'answered'",
    ).run(interactionId).changes === 1;
  }

  /** Forgets a block the thread resolved without the owner, so it stops being offered. */
  public discardThreadInteractions(threadId: string, keep: readonly string[]): number {
    assertControllerIdentifier(threadId, "threadId");
    const placeholders = keep.map(() => "?").join(", ");
    const sql = keep.length === 0
      ? "DELETE FROM thread_interactions WHERE thread_id = ? AND state = 'pending'"
      : `DELETE FROM thread_interactions WHERE thread_id = ? AND state = 'pending' AND interaction_id NOT IN (${placeholders})`;
    return this.db.prepare(sql).run(threadId, ...keep).changes;
  }

  /** An answer the owner has given that BB has not been told about yet. */
  public getAnsweredControllerQuestion(controllerKey: string): ControllerQuestionRecord | null {
    return this.readControllerQuestion(controllerKey, "answered");
  }

  public getPendingControllerQuestion(controllerKey: string): ControllerQuestionRecord | null {
    return this.readControllerQuestion(controllerKey, "pending");
  }

  // Delivery is recorded separately from the answer so a crash between the two
  // re-sends the answer rather than losing it.
  public markControllerQuestionDelivered(input: ControllerLeaseFence & { interactionId: string }): boolean {
    assertControllerIdentifier(input.interactionId, "interactionId");
    this.assertLeaseIdentity("controller-question", input.ownerId, input.generation, input.now);
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      return this.db.prepare(
        "UPDATE controller_questions SET state = 'delivered' WHERE interaction_id = ? AND state = 'answered'",
      ).run(input.interactionId).changes === 1;
    }).immediate();
  }

  // A question outlives its turn only on paper. Once that turn is gone the
  // answer has nowhere to land, and reading the owner's next message as an
  // answer to it would swallow the message outright.
  private readControllerQuestion(
    controllerKey: string,
    state: ControllerQuestionRow["state"],
  ): ControllerQuestionRecord | null {
    assertControllerKey(controllerKey);
    const row = this.db.prepare(
      `SELECT question.* FROM controller_questions AS question
         JOIN controller_turns AS turn ON turn.id = question.turn_id AND turn.state = 'submitted'
        WHERE question.controller_key = ? AND question.state = ?
        ORDER BY question.asked_at DESC LIMIT 1`,
    ).get(controllerKey, state) as ControllerQuestionRow | undefined;
    if (!row) return null;
    return {
      interactionId: row.interaction_id,
      turnId: row.turn_id,
      controllerKey: row.controller_key,
      questions: JSON.parse(row.questions_json) as ControllerQuestion[],
      answers: JSON.parse(row.answers_json) as ControllerQuestionAnswers,
      askedAt: row.asked_at,
    };
  }

  public refreshControllerDraft(input: ControllerLeaseFence & {
    turnId: string;
    sentBefore: number;
  }): boolean {
    this.assertControllerMutation(input);
    assertNonNegativeInteger(input.sentBefore, "sentBefore");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      return this.db.prepare(
        `UPDATE outbox
            SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL, updated_at = ?
          WHERE logical_key = ? AND status = 'sent' AND message_id IS NULL
            AND updated_at <= ?
            AND EXISTS (
              SELECT 1 FROM controller_turns
               WHERE id = ? AND state = 'submitted' AND telegram_message_id IS NULL
            )`,
      ).run(
        input.now,
        input.now,
        `controller:${input.turnId}:reply`,
        input.sentBefore,
        input.turnId,
      ).changes === 1;
    }).immediate();
  }

  /**
   * Retires the live thread. The thread id is kept as a closed generation
   * rather than erased, so a failure that cost the owner a conversation stays
   * answerable afterwards.
   */
  public resetControllerThread(input: ControllerLeaseFence & {
    controllerKey: string;
    expectedThreadId: string;
    reason?: string;
  }): boolean {
    assertControllerKey(input.controllerKey);
    assertControllerIdentifier(input.expectedThreadId, "expectedThreadId");
    if (!input.ownerId) throw new TypeError("ownerId must not be empty");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const retired = this.db.prepare(
        `UPDATE controller_threads
            SET project_id = NULL, host_id = NULL, bb_thread_id = NULL,
                state = 'pending_spawn', pending_spawn_token = NULL,
                last_error = NULL, updated_at = ?
          WHERE controller_key = ? AND bb_thread_id = ?`,
      ).run(input.now, input.controllerKey, input.expectedThreadId).changes === 1;
      if (retired) {
        this.db.prepare(
          `UPDATE controller_generations SET ended_at = ?, end_reason = ?
            WHERE controller_key = ? AND thread_id = ? AND ended_at IS NULL`,
        ).run(input.now, (input.reason ?? "retired").slice(0, 200), input.controllerKey, input.expectedThreadId);
      }
      return retired;
    }).immediate();
  }

  public completeControllerTurn(input: ControllerLeaseFence & {
    turnId: string;
    responseText: string;
    leaseMs?: number;
  }): boolean {
    this.assertControllerMutation(input);
    assertControllerText(input.responseText, "controller response");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const row = this.db.prepare(
        `SELECT turn.*, controller.telegram_chat_id FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
           JOIN owners ON owners.singleton = 1 AND owners.revoked_at IS NULL
            AND owners.telegram_user_id = controller.telegram_user_id
            AND owners.telegram_chat_id = controller.telegram_chat_id
          WHERE turn.id = ? AND turn.state = 'submitted'`,
      ).get(input.turnId) as (ControllerTurnRow & { telegram_chat_id: string }) | undefined;
      if (!row) return false;
      const updated = this.db.prepare(
        `UPDATE controller_turns
            SET state = 'completed', response_text = ?, stream_text = ?,
                stream_phase = 'complete', last_error = NULL,
                completed_at = ?, updated_at = ?
          WHERE id = ? AND state = 'submitted'`,
      ).run(input.responseText, input.responseText, input.now, input.now, input.turnId);
      if (updated.changes !== 1) return false;
      // The digest commits with the turn, so a crash can never leave a delivered
      // answer that the next thread has no record of.
      this.appendControllerDigestRow({
        controllerKey: row.controller_key,
        ordinal: row.ordinal,
        ownerText: row.input_text,
        agentText: input.responseText,
        now: input.now,
      });
      const outbox: OutboxInput = {
        logicalKey: `controller:${input.turnId}:reply`,
        chatId: row.telegram_chat_id,
        payload: { ...formattedMessage(input.responseText), disable_web_page_preview: true },
      };
      persistControllerOutbox(this.db, outbox, input.now);
      return true;
    }).immediate();
  }

  public failControllerTurn(input: ControllerLeaseFence & {
    turnId: string;
    error: string;
    ownerMessage?: string;
    leaseMs?: number;
  }): boolean {
    this.assertControllerMutation(input);
    assertSafeFailureSummary(input.error);
    assertNoRawMergeCallback(input.error, "controller error");
    if (input.ownerMessage !== undefined) {
      assertControllerText(input.ownerMessage, "controller failure message");
      assertNoRawMergeCallback(input.ownerMessage, "controller failure message");
    }
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const row = this.db.prepare(
        `SELECT turn.*, controller.telegram_chat_id FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
           JOIN owners ON owners.singleton = 1 AND owners.revoked_at IS NULL
            AND owners.telegram_user_id = controller.telegram_user_id
            AND owners.telegram_chat_id = controller.telegram_chat_id
          WHERE turn.id = ? AND turn.state IN ('dispatching', 'submitted')`,
      ).get(input.turnId) as (ControllerTurnRow & { telegram_chat_id: string }) | undefined;
      if (!row) return false;
      const updated = this.db.prepare(
        `UPDATE controller_turns
            SET state = 'failed', last_error = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND state IN ('dispatching', 'submitted')`,
      ).run(input.error, input.now, input.now, input.turnId);
      if (updated.changes !== 1) return false;
      this.db.prepare(
        `UPDATE controller_threads SET pending_spawn_token = NULL, updated_at = ?
          WHERE controller_key = ? AND bb_thread_id IS NULL AND pending_spawn_token = ?`,
      ).run(input.now, row.controller_key, input.turnId);
      const outbox = controllerFailureOutbox(input.turnId, row.telegram_chat_id, input.ownerMessage);
      persistControllerOutbox(this.db, outbox, input.now);
      return true;
    }).immediate();
  }

  public listControllerTurns(controllerKey: string, limit: number): ControllerTurnRecord[] {
    assertControllerKey(controllerKey);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError("limit must be between 1 and 1000");
    }
    const rows = this.db.prepare(
      "SELECT * FROM controller_turns WHERE controller_key = ? ORDER BY ordinal ASC LIMIT ?",
    ).all(controllerKey, limit) as ControllerTurnRow[];
    return rows.map(parseControllerTurn);
  }

  // The in-flight turn is looked up directly: scanning a bounded prefix of the
  // conversation loses it once the history outgrows that bound.
  public getPendingControllerTurn(controllerKey: string): ControllerTurnRecord | null {
    assertControllerKey(controllerKey);
    const row = this.db.prepare(
      `SELECT * FROM controller_turns
        WHERE controller_key = ? AND state IN ('dispatching', 'submitted')
        ORDER BY ordinal ASC LIMIT 1`,
    ).get(controllerKey) as ControllerTurnRow | undefined;
    return row ? parseControllerTurn(row) : null;
  }

  // Reserving before the call is what makes replay safe: a crash mid-tool leaves
  // a 'started' receipt, which is reported as uncertain rather than repeated.
  public claimToolReceipt(input: ToolReceiptKey & { controllerKey: string; now: number }): ToolReceiptClaim {
    assertControllerKey(input.controllerKey);
    assertControllerIdentifier(input.turnId, "turnId");
    assertControllerIdentifier(input.toolName, "toolName");
    assertSha256Hex(input.argsSha256);
    assertNonNegativeInteger(input.now, "now");

    return this.db.transaction((): ToolReceiptClaim => {
      const existing = this.db.prepare(
        "SELECT state, result_text FROM tool_receipts WHERE turn_id = ? AND tool_name = ? AND args_sha256 = ?",
      ).get(input.turnId, input.toolName, input.argsSha256) as
        { state: string; result_text: string | null } | undefined;
      if (existing?.state === "completed") {
        return { outcome: "completed", result: existing.result_text ?? "" };
      }
      if (existing?.state === "started") return { outcome: "interrupted" };
      if (existing) {
        this.db.prepare(
          `UPDATE tool_receipts SET state = 'started', last_error = NULL, updated_at = ?
            WHERE turn_id = ? AND tool_name = ? AND args_sha256 = ?`,
        ).run(input.now, input.turnId, input.toolName, input.argsSha256);
        return { outcome: "fresh" };
      }
      this.db.prepare(
        `INSERT INTO tool_receipts (
           turn_id, tool_name, args_sha256, controller_key, state, result_text, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'started', NULL, NULL, ?, ?)`,
      ).run(input.turnId, input.toolName, input.argsSha256, input.controllerKey, input.now, input.now);
      return { outcome: "fresh" };
    }).immediate();
  }

  public completeToolReceipt(input: ToolReceiptKey & { result: string; now: number }): void {
    assertNonNegativeInteger(input.now, "now");
    this.db.prepare(
      `UPDATE tool_receipts SET state = 'completed', result_text = ?, last_error = NULL, updated_at = ?
        WHERE turn_id = ? AND tool_name = ? AND args_sha256 = ? AND state = 'started'`,
    ).run(input.result.slice(0, MAX_RECEIPT_RESULT), input.now, input.turnId, input.toolName, input.argsSha256);
  }

  public failToolReceipt(input: ToolReceiptKey & { error: string; now: number }): void {
    assertNonNegativeInteger(input.now, "now");
    this.db.prepare(
      `UPDATE tool_receipts SET state = 'failed', last_error = ?, updated_at = ?
        WHERE turn_id = ? AND tool_name = ? AND args_sha256 = ? AND state = 'started'`,
    ).run(input.error.slice(0, 500), input.now, input.turnId, input.toolName, input.argsSha256);
  }

  public listToolReceipts(turnId: string): { toolName: string; state: string; result: string | null }[] {
    assertControllerIdentifier(turnId, "turnId");
    return this.db.prepare(
      `SELECT tool_name AS toolName, state, result_text AS result FROM tool_receipts
        WHERE turn_id = ? ORDER BY created_at ASC LIMIT 50`,
    ).all(turnId) as { toolName: string; state: string; result: string | null }[];
  }

  public listControllerGenerations(controllerKey: string, limit: number): ControllerGeneration[] {
    assertControllerKey(controllerKey);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be between 1 and 100");
    const rows = this.db.prepare(
      `SELECT id, controller_key, thread_id, started_at, ended_at, end_reason
         FROM controller_generations WHERE controller_key = ? ORDER BY started_at DESC LIMIT ?`,
    ).all(controllerKey, limit) as {
      id: string;
      controller_key: string;
      thread_id: string;
      started_at: number;
      ended_at: number | null;
      end_reason: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      controllerKey: row.controller_key,
      threadId: row.thread_id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      endReason: row.end_reason,
    }));
  }

  public createMonitor(input: {
    controllerKey: string;
    kind: MonitorKind;
    threadId?: string;
    cron?: string;
    instruction: string;
    dueAt: number | null;
    now: number;
  }): MonitorRecord {
    assertControllerKey(input.controllerKey);
    if (input.kind !== "thread_idle" && input.kind !== "schedule") throw new TypeError("monitor kind is invalid");
    if (input.kind === "thread_idle") assertControllerIdentifier(input.threadId ?? "", "threadId");
    if (input.kind === "schedule" && !input.cron) throw new TypeError("a scheduled monitor requires a cron expression");
    const instruction = assertMemoryText(input.instruction, MAX_MONITOR_INSTRUCTION, "monitor instruction");
    if (input.dueAt !== null) assertNonNegativeInteger(input.dueAt, "dueAt");
    assertNonNegativeInteger(input.now, "now");
    if (this.countArmedMonitors(input.controllerKey) >= MAX_ARMED_MONITORS) {
      throw new TypeError(`at most ${MAX_ARMED_MONITORS} monitors can be armed at once`);
    }

    const id = `mon-${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO monitors (
         id, controller_key, kind, thread_id, cron, instruction, state, due_at,
         fire_count, last_fired_at, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'armed', ?, 0, NULL, NULL, ?, ?)`,
    ).run(
      id,
      input.controllerKey,
      input.kind,
      input.threadId ?? null,
      input.cron ?? null,
      instruction,
      input.dueAt,
      input.now,
      input.now,
    );
    return this.requireMonitor(id);
  }

  public listMonitors(controllerKey: string, includeFinished: boolean): MonitorRecord[] {
    assertControllerKey(controllerKey);
    const rows = this.db.prepare(
      `SELECT * FROM monitors
        WHERE controller_key = ? AND (? = 1 OR state = 'armed')
        ORDER BY created_at DESC LIMIT ?`,
    ).all(controllerKey, includeFinished ? 1 : 0, MAX_ARMED_MONITORS * 4) as MonitorRow[];
    return rows.map(parseMonitor);
  }

  public listArmedMonitors(limit: number): MonitorRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be between 1 and 100");
    const rows = this.db.prepare(
      "SELECT * FROM monitors WHERE state = 'armed' ORDER BY created_at ASC LIMIT ?",
    ).all(limit) as MonitorRow[];
    return rows.map(parseMonitor);
  }

  public cancelMonitor(id: string, now: number): boolean {
    assertNonNegativeInteger(now, "now");
    return this.db.prepare(
      "UPDATE monitors SET state = 'cancelled', updated_at = ? WHERE id = ? AND state = 'armed'",
    ).run(now, id).changes === 1;
  }

  // A one-shot watch retires when it fires; a schedule re-arms for its next due
  // time, so a restart never loses or double-books a recurring job.
  public recordMonitorFired(input: { id: string; nextDueAt: number | null; now: number }): boolean {
    assertNonNegativeInteger(input.now, "now");
    if (input.nextDueAt !== null) assertNonNegativeInteger(input.nextDueAt, "nextDueAt");
    return this.db.prepare(
      `UPDATE monitors
          SET state = CASE WHEN ? IS NULL THEN 'done' ELSE 'armed' END,
              due_at = ?, fire_count = fire_count + 1, last_fired_at = ?, updated_at = ?
        WHERE id = ? AND state = 'armed'`,
    ).run(input.nextDueAt, input.nextDueAt, input.now, input.now, input.id).changes === 1;
  }

  public failMonitor(input: { id: string; error: string; now: number }): boolean {
    assertSafeFailureSummary(input.error);
    assertNonNegativeInteger(input.now, "now");
    return this.db.prepare(
      "UPDATE monitors SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND state = 'armed'",
    ).run(input.error, input.now, input.id).changes === 1;
  }

  private countArmedMonitors(controllerKey: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM monitors WHERE controller_key = ? AND state = 'armed'",
    ).get(controllerKey) as { count: number };
    return row.count;
  }

  private requireMonitor(id: string): MonitorRecord {
    const row = this.db.prepare("SELECT * FROM monitors WHERE id = ?").get(id) as MonitorRow | undefined;
    if (!row) throw new Error("stored monitor disappeared before it could be read");
    return parseMonitor(row);
  }

  public rememberMemory(input: MemoryInput): MemoryRecord {
    assertMemoryScope(input.scope);
    if (!MEMORY_KINDS.has(input.kind)) throw new TypeError("memory kind is invalid");
    const subject = assertMemoryText(input.subject, MAX_MEMORY_SUBJECT, "memory subject");
    const body = assertMemoryText(input.body, MAX_MEMORY_BODY, "memory body");
    // A memory is long-lived, searchable, and replayed into later conversations,
    // so a pasted secret would outlive the message that carried it.
    if (containsCredentialLikeText(subject) || containsCredentialLikeText(body)) {
      throw new TypeError("memory must not contain credential-like text");
    }
    const importance = assertUnitInterval(input.importance ?? DEFAULT_MEMORY_IMPORTANCE, "importance");
    const confidence = assertUnitInterval(input.confidence ?? DEFAULT_MEMORY_CONFIDENCE, "confidence");
    if (input.source !== "owner" && input.source !== "agent") throw new TypeError("memory source is invalid");
    assertNonNegativeInteger(input.now, "now");

    return this.db.transaction((): MemoryRecord => {
      const id = `mem-${randomUUID()}`;
      // A restated subject replaces its predecessor, so a correction reads as one
      // current belief while the superseded row stays as history.
      const previous = this.db.prepare(
        `SELECT id FROM memories
          WHERE scope = ? AND subject = ? AND forgotten_at IS NULL AND superseded_by IS NULL`,
      ).get(input.scope, subject) as { id: string } | undefined;
      if (previous) {
        this.db.prepare("UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ?")
          .run(id, input.now, previous.id);
      }
      this.db.prepare(
        `INSERT INTO memories (
           id, scope, kind, subject, body, importance, confidence, source, source_turn_id,
           use_count, last_used_at, superseded_by, forgotten_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?, ?)`,
      ).run(
        id,
        input.scope,
        input.kind,
        subject,
        body,
        importance,
        confidence,
        input.source,
        input.sourceTurnId ?? null,
        input.now,
        input.now,
      );
      this.evictWeakestMemories(input.scope, input.now);
      return this.requireMemory(id);
    }).immediate();
  }

  public recallMemories(input: {
    scope: string;
    query?: string;
    limit: number;
    now: number;
  }): MemoryRecord[] {
    assertMemoryScope(input.scope);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new TypeError("limit must be between 1 and 100");
    }
    assertNonNegativeInteger(input.now, "now");

    return this.db.transaction((): MemoryRecord[] => {
      // Owner-scoped memories are always in play; project memories only inside
      // their own project, so one project's conventions cannot leak into another.
      const scopes = input.scope === OWNER_MEMORY_SCOPE ? [OWNER_MEMORY_SCOPE] : [OWNER_MEMORY_SCOPE, input.scope];
      const placeholders = scopes.map(() => "?").join(", ");
      const live = this.db.prepare(
        `SELECT * FROM memories
          WHERE scope IN (${placeholders}) AND forgotten_at IS NULL AND superseded_by IS NULL`,
      ).all(...scopes) as MemoryRow[];
      if (live.length === 0) return [];

      const lexicalRanks = new Map<string, number>();
      const match = input.query === undefined ? null : ftsQuery(input.query);
      if (match !== null) {
        const matched = this.db.prepare(
          `SELECT memories.id AS id FROM memories_fts
             JOIN memories ON memories.rowid = memories_fts.rowid
            WHERE memories_fts MATCH ?
              AND memories.scope IN (${placeholders})
              AND memories.forgotten_at IS NULL AND memories.superseded_by IS NULL
            ORDER BY bm25(memories_fts, 2.0, 1.0)
            LIMIT 100`,
        ).all(match, ...scopes) as { id: string }[];
        matched.forEach((row, index) => lexicalRanks.set(row.id, index));
      }

      const ranked = live
        .map((row) => ({
          row,
          score: memoryScore({
            lexicalRank: lexicalRanks.get(row.id) ?? null,
            importance: row.importance,
            confidence: row.confidence,
            ageMs: input.now - row.created_at,
          }),
        }))
        // An explicit question only surfaces memories that actually mention it;
        // an empty question falls back to the strongest standing memories.
        .filter((candidate) => match === null || lexicalRanks.has(candidate.row.id))
        .sort((left, right) => right.score - left.score || right.row.created_at - left.row.created_at)
        .slice(0, input.limit);

      const use = this.db.prepare(
        "UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?",
      );
      for (const candidate of ranked) use.run(input.now, candidate.row.id);
      return ranked.map((candidate) => this.requireMemory(candidate.row.id));
    }).immediate();
  }

  public getMemory(id: string): MemoryRecord | null {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
    return row ? parseMemory(row) : null;
  }

  public forgetMemory(input: { id: string; now: number }): boolean {
    assertNonNegativeInteger(input.now, "now");
    return this.db.prepare(
      "UPDATE memories SET forgotten_at = ?, updated_at = ? WHERE id = ? AND forgotten_at IS NULL",
    ).run(input.now, input.now, input.id).changes === 1;
  }

  public countMemories(scope: string): number {
    assertMemoryScope(scope);
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM memories
        WHERE scope = ? AND forgotten_at IS NULL AND superseded_by IS NULL`,
    ).get(scope) as { count: number };
    return row.count;
  }

  private evictWeakestMemories(scope: string, now: number): void {
    const live = this.db.prepare(
      `SELECT id, importance, confidence, created_at FROM memories
        WHERE scope = ? AND forgotten_at IS NULL AND superseded_by IS NULL`,
    ).all(scope) as Pick<MemoryRow, "id" | "importance" | "confidence" | "created_at">[];
    if (live.length <= MAX_LIVE_MEMORIES_PER_SCOPE) return;
    const weakest = live
      .map((row) => ({
        id: row.id,
        score: memoryScore({
          lexicalRank: null,
          importance: row.importance,
          confidence: row.confidence,
          ageMs: now - row.created_at,
        }),
      }))
      .sort((left, right) => left.score - right.score)
      .slice(0, live.length - MAX_LIVE_MEMORIES_PER_SCOPE);
    const forget = this.db.prepare("UPDATE memories SET forgotten_at = ?, updated_at = ? WHERE id = ?");
    for (const candidate of weakest) forget.run(now, now, candidate.id);
  }

  private requireMemory(id: string): MemoryRecord {
    const memory = this.getMemory(id);
    if (!memory) throw new Error("stored memory disappeared before it could be read");
    return memory;
  }

  // The conversation outlives the BB thread that hosted it: a provider failure
  // retires the thread, and this digest is what re-seeds its replacement.
  public appendControllerDigest(input: {
    controllerKey: string;
    ordinal: number;
    ownerText: string;
    agentText: string;
    now: number;
  }): void {
    assertControllerKey(input.controllerKey);
    assertNonNegativeInteger(input.ordinal, "ordinal");
    assertNonNegativeInteger(input.now, "now");
    this.db.transaction(() => this.appendControllerDigestRow(input)).immediate();
  }

  private appendControllerDigestRow(input: {
    controllerKey: string;
    ordinal: number;
    ownerText: string;
    agentText: string;
    now: number;
  }): void {
    {
      this.db.prepare(
        `INSERT INTO controller_digest (controller_key, ordinal, owner_text, agent_text, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (controller_key, ordinal) DO UPDATE
           SET owner_text = excluded.owner_text, agent_text = excluded.agent_text`,
      ).run(
        input.controllerKey,
        input.ordinal,
        input.ownerText.slice(0, MAX_DIGEST_TEXT),
        input.agentText.slice(0, MAX_DIGEST_TEXT),
        input.now,
      );
      this.db.prepare(
        `DELETE FROM controller_digest
          WHERE controller_key = ? AND ordinal <= (
            SELECT MAX(ordinal) - ? FROM controller_digest WHERE controller_key = ?
          )`,
      ).run(input.controllerKey, MAX_DIGEST_TURNS, input.controllerKey);
    }
  }

  public readControllerDigest(
    controllerKey: string,
    limit: number,
  ): { ownerText: string; agentText: string }[] {
    assertControllerKey(controllerKey);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DIGEST_TURNS) {
      throw new TypeError(`limit must be between 1 and ${MAX_DIGEST_TURNS}`);
    }
    const rows = this.db.prepare(
      `SELECT owner_text, agent_text FROM controller_digest
        WHERE controller_key = ? ORDER BY ordinal DESC LIMIT ?`,
    ).all(controllerKey, limit) as { owner_text: string; agent_text: string }[];
    return rows
      .reverse()
      .map((row) => ({ ownerText: row.owner_text, agentText: row.agent_text }));
  }

  public createThreadOperation(input: {
    id: string;
    nonceHash: string;
    ownerUserId: string;
    ownerChatId: string;
    kind: ThreadOperationKind;
    threadId: string;
    text: string | null;
    expiresAt: number;
    now: number;
  }): ThreadOperation {
    assertControllerIdentifier(input.id, "operation id");
    if (!SHA256_HEX.test(input.nonceHash)) throw new TypeError("operation nonce hash must be SHA-256 hex");
    assertCanonicalPositiveDecimal(input.ownerUserId, "ownerUserId");
    assertCanonicalPositiveDecimal(input.ownerChatId, "ownerChatId");
    if (!THREAD_OPERATION_KINDS.has(input.kind)) throw new TypeError("thread operation kind is invalid");
    assertControllerIdentifier(input.threadId, "threadId");
    if (input.kind === "steer_thread") assertControllerText(input.text ?? "", "operation text");
    if (input.kind !== "steer_thread" && input.text !== null) throw new TypeError("only steer operations accept text");
    assertNonNegativeInteger(input.now, "now");
    if (!Number.isInteger(input.expiresAt) || input.expiresAt <= input.now) {
      throw new TypeError("operation expiry must be after creation");
    }
    const inserted = this.db.prepare(
      `INSERT INTO thread_operations (
         id, nonce_hash, owner_user_id, owner_chat_id, kind, thread_id, operation_text,
         state, expires_at, created_at, updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, 'confirmation_sending', ?, ?, ?
         FROM owners
        WHERE singleton = 1 AND revoked_at IS NULL
          AND telegram_user_id = ? AND telegram_chat_id = ?`,
    ).run(
      input.id,
      input.nonceHash,
      input.ownerUserId,
      input.ownerChatId,
      input.kind,
      input.threadId,
      input.text,
      input.expiresAt,
      input.now,
      input.now,
      input.ownerUserId,
      input.ownerChatId,
    );
    if (inserted.changes !== 1) throw new Error("Thread operation requires the current paired owner");
    return this.getThreadOperation(input.id)!;
  }

  public markThreadOperationConfirmationSent(id: string, messageId: number, now: number): ThreadOperation {
    assertControllerIdentifier(id, "operation id");
    assertPositiveInteger(messageId, "messageId");
    assertNonNegativeInteger(now, "now");
    const updated = this.db.prepare(
      `UPDATE thread_operations
          SET state = 'awaiting_confirmation', confirmation_message_id = ?, updated_at = ?
        WHERE id = ? AND state = 'confirmation_sending' AND expires_at > ?`,
    ).run(messageId, now, id, now);
    if (updated.changes !== 1) throw new Error("Thread operation confirmation changed before delivery was recorded");
    return this.getThreadOperation(id)!;
  }

  public failThreadOperationConfirmation(id: string, now: number): boolean {
    assertControllerIdentifier(id, "operation id");
    assertNonNegativeInteger(now, "now");
    return this.db.prepare(
      `UPDATE thread_operations
          SET state = 'failed', last_error = 'Confirmation delivery outcome is uncertain', updated_at = ?
        WHERE id = ? AND state = 'confirmation_sending'`,
    ).run(now, id).changes === 1;
  }

  public confirmThreadOperation(input: {
    nonceHash: string;
    userId: string;
    chatId: string;
    messageId: number;
    now: number;
  }): ThreadOperationConfirmResult {
    if (!SHA256_HEX.test(input.nonceHash)) throw new TypeError("operation nonce hash must be SHA-256 hex");
    assertCanonicalPositiveDecimal(input.userId, "userId");
    assertCanonicalPositiveDecimal(input.chatId, "chatId");
    assertPositiveInteger(input.messageId, "messageId");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): ThreadOperationConfirmResult => {
      const owner = this.db.prepare(
        `SELECT 1 FROM owners WHERE singleton = 1 AND revoked_at IS NULL
          AND telegram_user_id = ? AND telegram_chat_id = ?`,
      ).get(input.userId, input.chatId);
      if (!owner) return { ok: false, reason: "missing" };
      const row = this.db.prepare("SELECT * FROM thread_operations WHERE nonce_hash = ?")
        .get(input.nonceHash) as ThreadOperationRow | undefined;
      if (!row || row.owner_user_id !== input.userId || row.owner_chat_id !== input.chatId ||
        row.confirmation_message_id !== input.messageId) return { ok: false, reason: "missing" };
      if (row.state !== "awaiting_confirmation") return { ok: false, reason: "consumed" };
      if (row.expires_at <= input.now) {
        this.db.prepare(
          "UPDATE thread_operations SET state = 'expired', updated_at = ? WHERE id = ? AND state = 'awaiting_confirmation'",
        ).run(input.now, row.id);
        return { ok: false, reason: "expired" };
      }
      const updated = this.db.prepare(
        `UPDATE thread_operations SET state = 'confirmed', confirmed_at = ?, updated_at = ?
          WHERE id = ? AND state = 'awaiting_confirmation'`,
      ).run(input.now, input.now, row.id);
      if (updated.changes !== 1) return { ok: false, reason: "consumed" };
      return { ok: true, operation: this.getThreadOperation(row.id)! };
    }).immediate();
  }

  public getThreadOperation(id: string): ThreadOperation | null {
    assertControllerIdentifier(id, "operation id");
    const row = this.db.prepare("SELECT * FROM thread_operations WHERE id = ?")
      .get(id) as ThreadOperationRow | undefined;
    return row ? parseThreadOperation(row) : null;
  }

  public failStaleThreadOperations(fence: ControllerLeaseFence): boolean {
    if (!fence.ownerId) throw new TypeError("ownerId must not be empty");
    assertPositiveInteger(fence.generation, "generation");
    assertNonNegativeInteger(fence.now, "now");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(fence.ownerId, fence.generation, fence.now)) return false;
      const expired = this.db.prepare(
        `UPDATE thread_operations SET state = 'expired', updated_at = ?
          WHERE state IN ('awaiting_confirmation', 'confirmed') AND expires_at <= ?`,
      ).run(fence.now, fence.now).changes;
      const uncertain = this.db.prepare(
        `UPDATE thread_operations
            SET state = 'failed', last_error = 'Thread operation outcome is uncertain',
                lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE state = 'executing' AND lease_expires_at <= ?`,
      ).run(fence.now, fence.now).changes;
      return expired + uncertain > 0;
    }).immediate();
  }

  public claimNextThreadOperation(
    fence: ControllerLeaseFence & { leaseMs?: number },
  ): ThreadOperation | null {
    const leaseMs = fence.leaseMs ?? 30_000;
    if (!fence.ownerId) throw new TypeError("ownerId must not be empty");
    assertPositiveInteger(fence.generation, "generation");
    assertNonNegativeInteger(fence.now, "now");
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw new TypeError("leaseMs must be between 1000 and 300000");
    }
    return this.db.transaction((): ThreadOperation | null => {
      if (!this.executorLeaseIsCurrent(fence.ownerId, fence.generation, fence.now)) return null;
      const candidate = this.db.prepare(
        `SELECT * FROM thread_operations
          WHERE state = 'confirmed' AND expires_at > ? ORDER BY created_at, id LIMIT 1`,
      ).get(fence.now) as ThreadOperationRow | undefined;
      if (!candidate) return null;
      const updated = this.db.prepare(
        `UPDATE thread_operations
            SET state = 'executing', lease_owner = ?, lease_generation = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND state = 'confirmed'`,
      ).run(fence.ownerId, fence.generation, fence.now + leaseMs, fence.now, candidate.id);
      if (updated.changes !== 1) return null;
      return this.getThreadOperation(candidate.id);
    }).immediate();
  }

  public completeThreadOperation(input: ControllerLeaseFence & { id: string; result: string }): boolean {
    assertControllerIdentifier(input.id, "operation id");
    assertControllerText(input.result, "operation result");
    return this.finishThreadOperation(input, "completed", input.result);
  }

  public failThreadOperation(input: ControllerLeaseFence & { id: string; error: string }): boolean {
    assertControllerIdentifier(input.id, "operation id");
    assertSafeFailureSummary(input.error);
    return this.finishThreadOperation(input, "failed", input.error);
  }

  private finishThreadOperation(
    input: ControllerLeaseFence & { id: string },
    state: "completed" | "failed",
    summary: string,
  ): boolean {
    if (!input.ownerId) throw new TypeError("ownerId must not be empty");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
    const resultColumn = state === "completed" ? "result" : "last_error";
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const updated = this.db.prepare(
        `UPDATE thread_operations
            SET state = ?, ${resultColumn} = ?, lease_owner = NULL, lease_generation = NULL,
                lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND state = 'executing' AND lease_owner = ? AND lease_generation = ?
            AND lease_expires_at > ?`,
      ).run(state, summary, input.now, input.id, input.ownerId, input.generation, input.now);
      if (updated.changes !== 1) return false;
      const operation = this.getThreadOperation(input.id);
      if (!operation?.confirmationMessageId) {
        throw new Error("Completed thread operation has no confirmation message");
      }
      const outbox: OutboxInput = {
        logicalKey: `thread-operation:${operation.id}:status`,
        chatId: operation.ownerChatId,
        messageId: operation.confirmationMessageId,
        payload: {
          text: state === "completed" ? `Thread operation completed: ${summary}.` : "Thread operation failed safely.",
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [] },
        },
      };
      persistOutbox(this.db, outbox, serializeOutbox(outbox, input.now), input.now);
      return true;
    }).immediate();
  }

  public bindTelegramIdentity(input: {
    botId: string;
    username: string;
    now: number;
    hasActiveJob: boolean;
  }): "created" | "same" | "changed" | "active_job_conflict" {
    assertCanonicalPositiveDecimal(input.botId, "botId");

    const bind = this.db.transaction((): "created" | "same" | "changed" | "active_job_conflict" => {
      const current = this.db
        .prepare(
          "SELECT bot_id, username, verified_at FROM telegram_identity WHERE singleton = 1",
        )
        .get() as TelegramIdentityRow | undefined;

      if (!current) {
        if (input.hasActiveJob || this.hasActiveJob()) return "active_job_conflict";
        this.db
          .prepare(
            "INSERT INTO telegram_identity (singleton, bot_id, username, verified_at) VALUES (1, ?, ?, ?)",
          )
          .run(input.botId, input.username, input.now);
        return "created";
      }

      if (current.bot_id === input.botId) {
        this.db
          .prepare(
            "UPDATE telegram_identity SET username = ?, verified_at = ? WHERE singleton = 1",
          )
          .run(input.username, input.now);
        return "same";
      }

      if (input.hasActiveJob || this.hasActiveJob()) return "active_job_conflict";

      this.revokeControllerAccess(input.now);
      this.db
        .prepare(
          "UPDATE owners SET revoked_at = ? WHERE singleton = 1 AND revoked_at IS NULL",
        )
        .run(input.now);
      this.db.prepare("DELETE FROM pairing_codes").run();
      this.db.prepare("DELETE FROM approvals").run();
      this.db.prepare("DELETE FROM telegram_updates").run();
      this.db.prepare("DELETE FROM callbacks").run();
      this.db.prepare("DELETE FROM outbox").run();
      this.db
        .prepare("UPDATE telegram_cursor SET next_offset = 0 WHERE singleton = 1")
        .run();
      this.db
        .prepare(
          "UPDATE telegram_identity SET bot_id = ?, username = ?, verified_at = ? WHERE singleton = 1",
        )
        .run(input.botId, input.username, input.now);

      return "changed";
    });
    return bind();
  }

  private hasActiveJob(): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM jobs WHERE state NOT IN ('merged', 'cancelled', 'blocked', 'complete', 'production_failed') LIMIT 1",
        )
        .get() !== undefined
    );
  }

  private revokeControllerAccess(now: number): void {
    this.db.prepare(
      `UPDATE controller_turns
          SET state = 'failed', last_error = 'Controller owner was revoked',
              completed_at = ?, updated_at = ?
        WHERE state IN ('queued', 'dispatching', 'submitted')`,
    ).run(now, now);
    this.db.prepare(
      `UPDATE controller_threads
          SET project_id = NULL, host_id = NULL, bb_thread_id = NULL,
              state = 'revoked', pending_spawn_token = NULL,
              last_error = 'Controller owner was revoked', updated_at = ?
        WHERE state <> 'revoked'`,
    ).run(now);
    this.db.prepare(
      `UPDATE thread_operations
          SET state = 'failed', last_error = 'Controller owner was revoked',
              lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL,
              updated_at = ?
        WHERE state IN ('confirmation_sending', 'awaiting_confirmation', 'confirmed', 'executing')`,
    ).run(now);
  }

  public getTelegramIdentity(): TelegramIdentity | null {
    const row = this.db
      .prepare(
        "SELECT bot_id, username, verified_at FROM telegram_identity WHERE singleton = 1",
      )
      .get() as TelegramIdentityRow | undefined;
    if (!row) return null;
    return {
      botId: row.bot_id,
      username: row.username,
      verifiedAt: row.verified_at,
    };
  }

  public upsertProjectPolicy(
    policy: ProjectPolicy,
    now: number,
  ): ProjectPolicyRecord {
    const validated = projectPolicySchema.parse(policy);
    this.db
      .prepare(
        `INSERT INTO project_policies (
           project_id, alias, enabled, policy_json, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           alias = excluded.alias,
           enabled = excluded.enabled,
           policy_json = excluded.policy_json,
           version = project_policies.version + 1,
           updated_at = excluded.updated_at`,
      )
      .run(
        validated.projectId,
        validated.alias,
        validated.enabled ? 1 : 0,
        JSON.stringify(validated),
        now,
        now,
      );

    const stored = this.getProjectPolicy(validated.projectId);
    if (!stored) throw new Error("Project policy was not stored");
    return stored;
  }

  public getProjectPolicy(projectId: string): ProjectPolicyRecord | null {
    const row = this.db
      .prepare(
        "SELECT policy_json, version FROM project_policies WHERE project_id = ?",
      )
      .get(projectId) as ProjectPolicyRow | undefined;
    return row ? parsePolicy(row) : null;
  }

  public getProjectPolicyByAlias(alias: string): ProjectPolicyRecord | null {
    const row = this.db
      .prepare(
        "SELECT policy_json, version FROM project_policies WHERE alias = ?",
      )
      .get(alias) as ProjectPolicyRow | undefined;
    return row ? parsePolicy(row) : null;
  }

  public listEnabledProjectPolicies(): ProjectPolicyRecord[] {
    const rows = this.db
      .prepare(
        "SELECT policy_json, version FROM project_policies WHERE enabled = 1 ORDER BY alias",
      )
      .all() as ProjectPolicyRow[];
    return rows.map(parsePolicy);
  }

  public createConfirmedControllerJob(input: {
    controllerThreadId: string;
    projectId: string;
    task: string;
    now: number;
  }): Job {
    assertControllerIdentifier(input.controllerThreadId, "controllerThreadId");
    assertControllerIdentifier(input.projectId, "projectId");
    assertControllerText(input.task, "task");
    assertNonNegativeInteger(input.now, "now");

    return this.db.transaction((): Job => {
      const turn = this.db.prepare(
        `SELECT turn.* FROM controller_turns AS turn
           JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
           JOIN owners ON owners.singleton = 1 AND owners.revoked_at IS NULL
            AND owners.telegram_user_id = controller.telegram_user_id
            AND owners.telegram_chat_id = controller.telegram_chat_id
          WHERE controller.bb_thread_id = ? AND controller.state = 'active'
            AND turn.state = 'submitted'
          ORDER BY turn.ordinal ASC LIMIT 1`,
      ).get(input.controllerThreadId) as ControllerTurnRow | undefined;
      if (!turn) throw new TypeError("Controller thread has no authorized submitted turn");

      const existing = this.readJobBySourceUpdate(turn.telegram_update_id);
      if (existing) {
        if (existing.requestText !== input.task || existing.projectId !== input.projectId) {
          throw new IdempotencyConflictError(turn.telegram_update_id);
        }
        return existing;
      }

      const policyRecord = this.getProjectPolicy(input.projectId);
      if (!policyRecord?.policy.enabled) throw new TypeError("Selected project is not enabled");
      const active = this.getActiveJob();
      if (active) throw new ActiveJobConflictError(active.id);

      const jobId = createHash("sha256")
        .update(`controller-job:${turn.controller_key}:${turn.telegram_update_id}`, "utf8")
        .digest("base64url")
        .slice(0, 22);
      this.db.prepare(
        `INSERT INTO jobs (
           id, source_update_id, request_text, state, review_cycle,
           review_block_at, version, created_at, updated_at
         ) VALUES (?, ?, ?, 'awaiting_project', 0, 3, 1, ?, ?)`,
      ).run(jobId, turn.telegram_update_id, input.task, input.now, input.now);
      const created = this.readJobById(jobId);
      if (!created) throw new Error("Controller job was not stored");

      const selected = transition(created, {
        type: "PROJECT_SELECTED",
        projectId: policyRecord.policy.projectId,
        policyVersion: policyRecord.version,
        policy: policyRecord.policy,
      }, input.now);
      persistJobTransition(this.db, jobId, created.version, selected.job);
      persistPendingEffects(this.db, selected.effects, input.now);

      const confirmed = transition(selected.job, { type: "CONFIRMED" }, input.now);
      persistJobTransition(this.db, jobId, selected.job.version, confirmed.job);
      persistPendingEffects(this.db, confirmed.effects, input.now);
      return confirmed.job;
    }).immediate();
  }

  public createJob(input: {
    id: string;
    sourceUpdateId: number;
    requestText: string;
    now: number;
  }): Job {
    if (!input.id || !input.requestText) throw new TypeError("Job id and request text are required");
    if (!Number.isInteger(input.sourceUpdateId) || input.sourceUpdateId < 0) {
      throw new TypeError("sourceUpdateId must be a non-negative integer");
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs (
           id, source_update_id, request_text, state, review_cycle,
           review_block_at, version, created_at, updated_at
         ) VALUES (?, ?, ?, 'awaiting_project', 0, 3, 1, ?, ?)`,
      )
      .run(input.id, input.sourceUpdateId, input.requestText, input.now, input.now);

    const byId = this.readJobById(input.id);
    const existing = byId ?? this.readJobBySourceUpdate(input.sourceUpdateId);
    if (!existing) throw new Error("Job was not stored");
    if (
      existing.sourceUpdateId !== input.sourceUpdateId ||
      existing.requestText !== input.requestText
    ) {
      throw new IdempotencyConflictError(input.sourceUpdateId);
    }
    return existing;
  }

  public setJobStatusMessage(
    jobId: string,
    messageId: number,
    expectedVersion: number,
    now: number,
  ): Job {
    if (!jobId) throw new TypeError("jobId must not be empty");
    if (!Number.isInteger(messageId) || messageId < 1) {
      throw new TypeError("messageId must be a positive integer");
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("expectedVersion must be a positive integer");
    }
    const current = this.readJobById(jobId);
    if (!current) throw new Error(`Job ${jobId} was not found`);
    if (current.version !== expectedVersion) throw new VersionConflictError(jobId, expectedVersion);

    const updated = this.db
      .prepare(
        `UPDATE jobs
            SET status_message_id = ?, version = ?, updated_at = ?
          WHERE id = ? AND version = ?`,
      )
      .run(messageId, expectedVersion + 1, now, jobId, expectedVersion);
    if (updated.changes !== 1) throw new VersionConflictError(jobId, expectedVersion);
    const stored = this.readJobById(jobId);
    if (!stored) throw new Error(`Job ${jobId} was not found after status-message update`);
    return stored;
  }

  public setJobStatusMessageAndOutbox(
    jobId: string,
    messageId: number,
    expectedVersion: number,
    outbox: OutboxInput,
    now: number,
  ): Job {
    if (!jobId) throw new TypeError("jobId must not be empty");
    if (!Number.isInteger(messageId) || messageId < 1) {
      throw new TypeError("messageId must be a positive integer");
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("expectedVersion must be a positive integer");
    }
    if (outbox.messageId !== messageId) {
      throw new TypeError("outbox messageId must match status message");
    }
    const payloadJson = serializeOutbox(outbox, now);

    const persist = this.db.transaction((): Job => {
      const current = this.readJobById(jobId);
      if (!current) throw new Error(`Job ${jobId} was not found`);
      if (current.version !== expectedVersion) throw new VersionConflictError(jobId, expectedVersion);

      const updated = this.db
        .prepare(
          `UPDATE jobs
              SET status_message_id = ?, version = ?, updated_at = ?
            WHERE id = ? AND version = ?`,
        )
        .run(messageId, expectedVersion + 1, now, jobId, expectedVersion);
      if (updated.changes !== 1) throw new VersionConflictError(jobId, expectedVersion);

      persistOutbox(this.db, outbox, payloadJson, now);
      const stored = this.readJobById(jobId);
      if (!stored) throw new Error(`Job ${jobId} was not found after status-message update`);
      return stored;
    });
    return persist();
  }

  public enqueueSteeringEffect(
    jobId: string,
    updateId: number,
    threadId: string,
    text: string,
    now: number,
  ): boolean {
    if (!jobId || !threadId) throw new TypeError("jobId and threadId must not be empty");
    if (!Number.isInteger(updateId) || updateId < 0) {
      throw new TypeError("updateId must be a non-negative integer");
    }
    if (typeof text !== "string" || text.length === 0 || text.length > 4_000) {
      throw new TypeError("steering text must be between 1 and 4000 characters");
    }

    const enqueue = this.db.transaction((): boolean => {
      const job = this.readJobById(jobId);
      if (!job || job.implementationThreadId !== threadId || ["merged", "cancelled", "blocked", "complete", "production_failed"].includes(job.state)) {
        return false;
      }
      const steeringPayloadJson = serializeBoundedJson({ text, threadId }, "steering effect payload", 64_000);
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO effects (
             idempotency_key, job_id, kind, payload_json, status, attempts,
             next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, 'steer_implementation', ?, 'pending', 0, ?, ?, ?)`,
        )
        .run(
          `${jobId}:telegram:${updateId}:steer_implementation`,
          jobId,
          steeringPayloadJson,
          now,
          now,
          now,
        );
      return result.changes === 1;
    });
    return enqueue();
  }

  public enqueueOutbox(item: OutboxInput, now: number): void {
    const payloadJson = serializeOutbox(item, now);
    persistOutbox(this.db, item, payloadJson, now);
  }

  public async setLastProject(projectId: string): Promise<void> {
    if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 200) {
      throw new TypeError("projectId must be a bounded non-empty string");
    }
    await this.kv.set(LAST_PROJECT_KEY, projectId);
  }

  public async getLastProject(): Promise<string | null> {
    const value = await this.kv.get<unknown>(LAST_PROJECT_KEY);
    return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
  }

  public getJob(jobId: string): Job | null {
    return this.readJobById(jobId);
  }

  public getActiveJob(): Job | null {
    const row = this.db
      .prepare(`${JOB_SELECT} WHERE state NOT IN ('merged', 'cancelled', 'blocked', 'complete', 'production_failed') ORDER BY updated_at DESC, id DESC LIMIT 1`)
      .get() as JobRow | undefined;
    return row ? parseJob(row) : null;
  }

  public findJobByThreadId(threadId: string): Job | null {
    const row = this.db
      .prepare(`${JOB_SELECT} WHERE implementation_thread_id = ? OR review_thread_id = ?
        OR id IN (SELECT job_id FROM pipeline_stage_attempts WHERE thread_id = ?)
        ORDER BY updated_at DESC LIMIT 1`)
      .get(threadId, threadId, threadId) as JobRow | undefined;
    return row ? parseJob(row) : null;
  }

  public listJobs(limit: number): Job[] {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError("limit must be a positive integer");
    const rows = this.db
      .prepare(`${JOB_SELECT} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(limit) as JobRow[];
    return rows.map(parseJob);
  }

  public applyJobEvent(
    jobId: string,
    expectedVersion: number,
    event: JobEvent,
    now: number,
  ): Job {
    const apply = this.db.transaction((): Job => {
      const current = this.readJobById(jobId);
      if (!current) throw new Error(`Job ${jobId} was not found`);
      if (current.version !== expectedVersion) throw new VersionConflictError(jobId, expectedVersion);
      if (current.state === "blocked" && event.type === "CONTINUE_REVIEW" && this.hasActiveJobExcluding(jobId)) {
        throw new ActiveJobConflictError(jobId);
      }

      const transitioned = transition(current, event, now);
      persistJobTransition(this.db, jobId, expectedVersion, transitioned.job);
      persistPendingEffects(this.db, transitioned.effects, now);
      return transitioned.job;
    });
    return apply();
  }

  public listEffectsForJob(jobId: string): StoredEffect[] {
    const rows = this.db
      .prepare("SELECT * FROM effects WHERE job_id = ? ORDER BY created_at ASC, idempotency_key ASC")
      .all(jobId) as EffectRow[];
    return rows.map(parseEffect);
  }

  public getEffect(jobId: string, idempotencyKey: string): StoredEffect | null {
    const row = this.db
      .prepare("SELECT * FROM effects WHERE job_id = ? AND idempotency_key = ?")
      .get(jobId, idempotencyKey) as EffectRow | undefined;
    return row ? parseEffect(row) : null;
  }

  public getAttempt(attemptId: string): AttemptRecord | null {
    if (!attemptId) throw new TypeError("attemptId must not be empty");
    const row = this.db
      .prepare(
        "SELECT id, job_id, kind, ordinal, thread_id, head_sha, handoff_path, handoff_sha256, result_json, completed_at FROM attempts WHERE id = ?",
      )
      .get(attemptId) as {
        id: string;
        job_id: string;
        kind: AttemptRecord["kind"];
        ordinal?: number;
        thread_id?: string | null;
        head_sha: string | null;
        handoff_path?: string | null;
        handoff_sha256?: string | null;
        result_json: string | null;
        completed_at: number | null;
      } | undefined;
    return row
      ? parseAttempt({
          id: row.id,
          job_id: row.job_id,
          kind: row.kind,
          ordinal: row.ordinal ?? 0,
          thread_id: row.thread_id ?? null,
          head_sha: row.head_sha,
          handoff_path: row.handoff_path ?? null,
          handoff_sha256: row.handoff_sha256 ?? null,
          result_json: row.result_json,
          completed_at: row.completed_at,
        })
      : null;
  }

  public getAttemptByThreadId(threadId: string): AttemptRecord | null {
    if (!threadId) throw new TypeError("threadId must not be empty");
    const row = this.db
      .prepare(
        "SELECT id, job_id, kind, ordinal, thread_id, head_sha, handoff_path, handoff_sha256, result_json, completed_at FROM attempts WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(threadId) as {
        id: string;
        job_id: string;
        kind: AttemptRecord["kind"];
        ordinal?: number;
        thread_id?: string | null;
        head_sha: string | null;
        handoff_path?: string | null;
        handoff_sha256?: string | null;
        result_json: string | null;
        completed_at: number | null;
      } | undefined;
    return row
      ? parseAttempt({
          id: row.id,
          job_id: row.job_id,
          kind: row.kind,
          ordinal: row.ordinal ?? 0,
          thread_id: row.thread_id ?? null,
          head_sha: row.head_sha,
          handoff_path: row.handoff_path ?? null,
          handoff_sha256: row.handoff_sha256 ?? null,
          result_json: row.result_json,
          completed_at: row.completed_at,
        })
      : null;
  }

  public nextAttemptOrdinal(jobId: string, kind: AttemptRecord["kind"]): number {
    if (!jobId) throw new TypeError("jobId must not be empty");
    const row = this.db
      .prepare("SELECT COALESCE(MAX(ordinal), 0) AS max_ordinal FROM attempts WHERE job_id = ? AND kind = ?")
      .get(jobId, kind) as { max_ordinal: number };
    return row.max_ordinal + 1;
  }

  public createAttempt(input: {
    id: string;
    jobId: string;
    kind: AttemptRecord["kind"];
    ordinal: number;
    headSha?: string | null;
    now: number;
  }): AttemptRecord {
    if (!input.id || !input.jobId) throw new TypeError("attempt identity is required");
    if (!Number.isInteger(input.ordinal) || input.ordinal < 1) {
      throw new TypeError("attempt ordinal must be a positive integer");
    }
    assertNonNegativeInteger(input.now, "now");
    if (input.headSha !== undefined && input.headSha !== null) assertFullSha(input.headSha, "headSha");
    this.db
      .prepare(
        `INSERT OR IGNORE INTO attempts (
           id, job_id, kind, ordinal, head_sha, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.jobId, input.kind, input.ordinal, input.headSha ?? null, input.now);
    const stored = this.getAttempt(input.id);
    if (!stored) throw new Error("Attempt was not stored");
    if (stored.jobId !== input.jobId || stored.kind !== input.kind || stored.ordinal !== input.ordinal) {
      throw new IdempotencyConflictError(input.ordinal);
    }
    return stored;
  }

  public updateAttempt(attemptId: string, patch: {
    threadId?: string | null;
    headSha?: string | null;
    handoffPath?: string | null;
    handoffSha256?: string | null;
    result?: Record<string, unknown> | null;
    completedAt?: number | null;
  }): AttemptRecord {
    if (!attemptId) throw new TypeError("attemptId must not be empty");
    if (patch.headSha !== undefined && patch.headSha !== null) assertFullSha(patch.headSha, "headSha");
    if (patch.handoffSha256 !== undefined && patch.handoffSha256 !== null) assertSha256Hex(patch.handoffSha256);
    if (patch.completedAt !== undefined && patch.completedAt !== null) assertNonNegativeInteger(patch.completedAt, "completedAt");
    const fields: string[] = [];
    const values: unknown[] = [];
    if (patch.threadId !== undefined) { fields.push("thread_id = ?"); values.push(patch.threadId); }
    if (patch.headSha !== undefined) { fields.push("head_sha = ?"); values.push(patch.headSha); }
    if (patch.handoffPath !== undefined) { fields.push("handoff_path = ?"); values.push(patch.handoffPath); }
    if (patch.handoffSha256 !== undefined) { fields.push("handoff_sha256 = ?"); values.push(patch.handoffSha256); }
    if (patch.result !== undefined) {
      fields.push("result_json = ?");
      values.push(patch.result === null ? null : serializeBoundedJson(patch.result, "attempt result", MAX_MERGE_RESULT_JSON));
    }
    if (patch.completedAt !== undefined) { fields.push("completed_at = ?"); values.push(patch.completedAt); }
    if (fields.length > 0) {
      values.push(attemptId);
      this.db.prepare(`UPDATE attempts SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    }
    const stored = this.getAttempt(attemptId);
    if (!stored) throw new Error(`Attempt ${attemptId} was not found`);
    return stored;
  }

  public createPipelineStageAttempt(input: ControllerLeaseFence & {
    id: string;
    jobId: string;
    role: PipelineStageRole;
    ordinal: number;
    inputSha256: string;
  }): PipelineStageAttempt {
    if (!input.id || !input.jobId) throw new TypeError("pipeline stage identity is required");
    if (!PIPELINE_STAGE_ROLES.has(input.role)) throw new TypeError("pipeline stage role is invalid");
    assertPositiveInteger(input.ordinal, "ordinal");
    assertContentSha256(input.inputSha256, "inputSha256");
    assertNonNegativeInteger(input.now, "now");
    if (!input.ownerId || !Number.isInteger(input.generation) || input.generation < 1) {
      throw new TypeError("executor fence is invalid");
    }
    return this.db.transaction((): PipelineStageAttempt => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) {
        throw new Error("executor lease was lost");
      }
      this.db.prepare(
        `INSERT OR IGNORE INTO pipeline_stage_attempts (
           id, job_id, role, ordinal, state, input_sha256, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'spawning', ?, ?, ?)`,
      ).run(input.id, input.jobId, input.role, input.ordinal, input.inputSha256, input.now, input.now);
      const stored = this.getPipelineStageAttempt(input.id);
      if (!stored) throw new Error("Pipeline stage attempt was not stored");
      if (
        stored.jobId !== input.jobId || stored.role !== input.role ||
        stored.ordinal !== input.ordinal || stored.inputSha256 !== input.inputSha256
      ) throw new Error("Pipeline stage attempt idempotency conflict");
      return stored;
    }).immediate();
  }

  public bindPipelineStageThread(input: ControllerLeaseFence & {
    id: string;
    threadId: string;
    environmentId: string;
  }): boolean {
    if (!input.id || !input.threadId || !input.environmentId) throw new TypeError("pipeline thread identity is required");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const current = this.getPipelineStageAttempt(input.id);
      if (!current) return false;
      if (current.threadId !== null || current.environmentId !== null) {
        return current.threadId === input.threadId && current.environmentId === input.environmentId &&
          (current.state === "running" || current.state === "completed");
      }
      return this.db.prepare(
        `UPDATE pipeline_stage_attempts
           SET thread_id = ?, environment_id = ?, resource_kind = 'bb_thread', resource_id = ?,
               state = 'running', updated_at = ?
         WHERE id = ? AND state = 'spawning'
           AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1
             AND owner_id = ? AND generation = ? AND lease_expires_at > ?)`,
      ).run(
        input.threadId,
        input.environmentId,
        input.threadId,
        input.now,
        input.id,
        input.ownerId,
        input.generation,
        input.now,
      ).changes === 1;
    }).immediate();
  }

  public bindPipelineStageResource(input: ControllerLeaseFence & {
    id: string;
    resourceKind: "bb_thread" | "bb_terminal";
    resourceId: string;
    environmentId: string;
  }): boolean {
    if (!input.id || !input.resourceId || !input.environmentId) throw new TypeError("pipeline resource identity is required");
    if (input.resourceKind !== "bb_thread" && input.resourceKind !== "bb_terminal") {
      throw new TypeError("pipeline resource kind is invalid");
    }
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const current = this.getPipelineStageAttempt(input.id);
      if (!current) return false;
      if (current.resourceKind !== null || current.resourceId !== null) {
        return current.resourceKind === input.resourceKind && current.resourceId === input.resourceId &&
          current.environmentId === input.environmentId && (current.state === "running" || current.state === "completed");
      }
      return this.db.prepare(
        `UPDATE pipeline_stage_attempts
           SET resource_kind = ?, resource_id = ?, environment_id = ?, state = 'running', updated_at = ?
         WHERE id = ? AND state = 'spawning'
           AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1
             AND owner_id = ? AND generation = ? AND lease_expires_at > ?)`,
      ).run(
        input.resourceKind,
        input.resourceId,
        input.environmentId,
        input.now,
        input.id,
        input.ownerId,
        input.generation,
        input.now,
      ).changes === 1;
    }).immediate();
  }

  public completePipelineStageAttempt(input: ControllerLeaseFence & {
    id: string;
    outputText: string;
    outputSha256: string;
    outcome: Record<string, unknown>;
    startSha?: string | null;
    endSha?: string | null;
  }): boolean {
    if (!input.id) throw new TypeError("pipeline stage id is required");
    if (
      typeof input.outputText !== "string" || input.outputText.length === 0 ||
      new TextEncoder().encode(input.outputText).byteLength > MAX_PIPELINE_OUTPUT_BYTES
    ) {
      throw new TypeError("pipeline stage output must be bounded to 65536 bytes");
    }
    assertContentSha256(input.outputSha256, "outputSha256");
    if (input.startSha !== undefined && input.startSha !== null) assertFullSha(input.startSha, "startSha");
    if (input.endSha !== undefined && input.endSha !== null) assertFullSha(input.endSha, "endSha");
    assertNonNegativeInteger(input.now, "now");
    const outcomeJson = serializeBoundedJson(input.outcome, "pipeline stage outcome", MAX_MERGE_RESULT_JSON);
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const current = this.getPipelineStageAttempt(input.id);
      if (!current) return false;
      if (current.state === "completed") {
        return current.outputText === input.outputText && current.outputSha256 === input.outputSha256 &&
          JSON.stringify(current.outcome) === outcomeJson;
      }
      return this.db.prepare(
        `UPDATE pipeline_stage_attempts
           SET state = 'completed', output_text = ?, output_sha256 = ?, outcome_json = ?,
               start_sha = ?, end_sha = ?, last_error = NULL, completed_at = ?, updated_at = ?
         WHERE id = ? AND state IN ('spawning', 'running')
           AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1
             AND owner_id = ? AND generation = ? AND lease_expires_at > ?)`,
      ).run(
        input.outputText,
        input.outputSha256,
        outcomeJson,
        input.startSha ?? null,
        input.endSha ?? null,
        input.now,
        input.now,
        input.id,
        input.ownerId,
        input.generation,
        input.now,
      ).changes === 1;
    }).immediate();
  }

  public failPipelineStageAttempt(input: ControllerLeaseFence & { id: string; error: string }): boolean {
    if (!input.id) throw new TypeError("pipeline stage id is required");
    assertSafeFailureSummary(input.error);
    assertNonNegativeInteger(input.now, "now");
    return this.db.prepare(
      `UPDATE pipeline_stage_attempts
         SET state = 'failed', last_error = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND state IN ('spawning', 'running')
         AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1
           AND owner_id = ? AND generation = ? AND lease_expires_at > ?)`,
    ).run(
      input.error,
      input.now,
      input.now,
      input.id,
      input.ownerId,
      input.generation,
      input.now,
    ).changes === 1;
  }

  public getPipelineStageAttempt(id: string): PipelineStageAttempt | null {
    if (!id) return null;
    const row = this.db.prepare("SELECT * FROM pipeline_stage_attempts WHERE id = ?").get(id) as PipelineStageAttemptRow | undefined;
    return row ? parsePipelineStageAttempt(row) : null;
  }

  public getPipelineStageAttemptByThreadId(threadId: string): PipelineStageAttempt | null {
    if (!threadId) return null;
    const row = this.db.prepare("SELECT * FROM pipeline_stage_attempts WHERE thread_id = ?").get(threadId) as PipelineStageAttemptRow | undefined;
    return row ? parsePipelineStageAttempt(row) : null;
  }

  public getLatestPipelineStageAttempt(jobId: string, role: PipelineStageRole): PipelineStageAttempt | null {
    if (!jobId) throw new TypeError("jobId must not be empty");
    if (!PIPELINE_STAGE_ROLES.has(role)) throw new TypeError("pipeline stage role is invalid");
    const row = this.db.prepare(
      "SELECT * FROM pipeline_stage_attempts WHERE job_id = ? AND role = ? ORDER BY ordinal DESC LIMIT 1",
    ).get(jobId, role) as PipelineStageAttemptRow | undefined;
    return row ? parsePipelineStageAttempt(row) : null;
  }

  public nextPipelineStageOrdinal(jobId: string, role: PipelineStageRole): number {
    if (!jobId) throw new TypeError("jobId must not be empty");
    if (!PIPELINE_STAGE_ROLES.has(role)) throw new TypeError("pipeline stage role is invalid");
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(ordinal), 0) AS max_ordinal FROM pipeline_stage_attempts WHERE job_id = ? AND role = ?",
    ).get(jobId, role) as { max_ordinal: number };
    return row.max_ordinal + 1;
  }

  public claimReviewFormatCorrection(attemptId: string, threadId: string, headSha: string): boolean {
    if (!attemptId || !threadId) throw new TypeError("review correction identity is required");
    assertFullSha(headSha, "headSha");
    const claim = this.db.transaction((): boolean => {
      const attempt = this.getAttempt(attemptId);
      if (!attempt || attempt.kind !== "review" || attempt.threadId !== threadId || attempt.headSha !== headSha) return false;
      let current: Record<string, unknown> = {};
      if (attempt.resultJson !== null) {
        try {
          const parsed = JSON.parse(attempt.resultJson);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
          current = parsed as Record<string, unknown>;
        } catch {
          return false;
        }
      }
      if (current.formatCorrectionSent === true) return false;
      const updated = this.db
        .prepare("UPDATE attempts SET result_json = ? WHERE id = ? AND thread_id = ? AND head_sha = ?")
        .run(serializeBoundedJson({ ...current, formatCorrectionSent: true }, "attempt result", MAX_MERGE_RESULT_JSON), attemptId, threadId, headSha);
      return updated.changes === 1;
    });
    return claim();
  }

  public registerReviewThread(jobId: string, expectedVersion: number, threadId: string, now: number): Job {
    if (!jobId || !threadId) throw new TypeError("jobId and threadId are required");
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new TypeError("expectedVersion must be a positive integer");
    assertNonNegativeInteger(now, "now");
    const update = this.db
      .prepare(
        `UPDATE jobs SET review_thread_id = ?, version = ?, updated_at = ?
           WHERE id = ? AND version = ?`,
      )
      .run(threadId, expectedVersion + 1, now, jobId, expectedVersion);
    if (update.changes !== 1) throw new VersionConflictError(jobId, expectedVersion);
    const stored = this.readJobById(jobId);
    if (!stored) throw new Error(`Job ${jobId} was not found after review-thread registration`);
    return stored;
  }

  public acquireExecutorLease(
    ownerId: string,
    now: number,
    leaseMs: number,
  ): { acquired: true; generation: number } | { acquired: false } {
    this.assertLeaseInput(ownerId, now, leaseMs);
    return this.db.transaction(() => {
      const current = this.executorLeaseRow();
      if (current.owner_id !== null && current.lease_expires_at !== null && current.lease_expires_at > now) {
        return { acquired: false } as const;
      }
      const generation = current.generation + 1;
      const updated = this.db
        .prepare(
          `UPDATE executor_lease SET owner_id = ?, generation = ?, heartbeat_at = ?, lease_expires_at = ?
             WHERE singleton = 1 AND generation = ?`,
        )
        .run(ownerId, generation, now, now + leaseMs, current.generation);
      if (updated.changes !== 1) return { acquired: false } as const;
      return { acquired: true, generation } as const;
    }).immediate();
  }

  public renewExecutorLease(ownerId: string, generation: number, now: number, leaseMs: number): boolean {
    this.assertLeaseInput(ownerId, now, leaseMs);
    assertPositiveInteger(generation, "generation");
    return this.db.transaction(() => this.db
      .prepare(
        `UPDATE executor_lease SET heartbeat_at = ?, lease_expires_at = ?
           WHERE singleton = 1 AND owner_id = ? AND generation = ? AND lease_expires_at > ?`,
      )
      .run(now, now + leaseMs, ownerId, generation, now).changes === 1).immediate();
  }

  public releaseExecutorLease(ownerId: string, generation: number, now: number): boolean {
    if (!ownerId) throw new TypeError("ownerId must not be empty");
    assertPositiveInteger(generation, "generation");
    assertNonNegativeInteger(now, "now");
    return this.db.transaction(() => this.db
      .prepare(
        `UPDATE executor_lease SET owner_id = NULL, heartbeat_at = ?, lease_expires_at = NULL
           WHERE singleton = 1 AND owner_id = ? AND generation = ?`,
      )
      .run(now, ownerId, generation).changes === 1).immediate();
  }

  public isExecutorLeaseCurrent(ownerId: string, generation: number, now: number): boolean {
    if (!ownerId) return false;
    if (!Number.isInteger(generation) || generation < 1) return false;
    if (!Number.isInteger(now) || now < 0) return false;
    return this.executorLeaseIsCurrent(ownerId, generation, now);
  }

  public leaseEffects(ownerId: string, generation: number, now: number, limit: number, leaseMs: number): StoredEffect[] {
    this.assertLeaseInput(ownerId, now, leaseMs);
    assertPositiveInteger(generation, "generation");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be between 1 and 100");
    return this.db.transaction((): StoredEffect[] => {
      if (!this.executorLeaseIsCurrent(ownerId, generation, now)) return [];
      const rows = this.db
        .prepare(
          `SELECT * FROM effects
             WHERE (status IN ('pending', 'failed') AND next_attempt_at <= ?)
                OR (status = 'leased' AND lease_expires_at <= ?)
             ORDER BY created_at ASC, idempotency_key ASC LIMIT ?`,
        )
        .all(now, now, limit) as EffectRow[];
      const result: StoredEffect[] = [];
      for (const row of rows) {
        if (!this.executorLeaseIsCurrent(ownerId, generation, now)) break;
        const updated = this.db
          .prepare(
            `UPDATE effects SET status = 'leased', lease_owner = ?, lease_generation = ?,
               lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
             WHERE idempotency_key = ? AND (
               (status IN ('pending', 'failed') AND next_attempt_at <= ?)
               OR (status = 'leased' AND lease_expires_at <= ?)
             )`,
          )
          .run(ownerId, generation, now + leaseMs, now, row.idempotency_key, now, now);
        if (updated.changes !== 1) continue;
        const claimed = this.db.prepare("SELECT * FROM effects WHERE idempotency_key = ?").get(row.idempotency_key) as EffectRow;
        result.push(parseEffect(claimed));
      }
      return result;
    }).immediate();
  }

  public leaseOutbox(ownerId: string, generation: number, now: number, limit: number, leaseMs: number): StoredOutbox[] {
    this.assertLeaseInput(ownerId, now, leaseMs);
    assertPositiveInteger(generation, "generation");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("limit must be between 1 and 100");
    return this.db.transaction((): StoredOutbox[] => {
      if (!this.executorLeaseIsCurrent(ownerId, generation, now)) return [];
      const rows = this.db
        .prepare(
          `SELECT * FROM outbox
             WHERE (status IN ('pending', 'failed') AND next_attempt_at <= ?)
                OR (status = 'leased' AND lease_expires_at <= ?)
             ORDER BY created_at ASC, logical_key ASC LIMIT ?`,
        )
        .all(now, now, limit) as OutboxRow[];
      const result: StoredOutbox[] = [];
      for (const row of rows) {
        if (!this.executorLeaseIsCurrent(ownerId, generation, now)) break;
        const updated = this.db
          .prepare(
            `UPDATE outbox SET status = 'leased', lease_owner = ?, lease_generation = ?,
               lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
             WHERE logical_key = ? AND (
               (status IN ('pending', 'failed') AND next_attempt_at <= ?)
               OR (status = 'leased' AND lease_expires_at <= ?)
             )`,
          )
          .run(ownerId, generation, now + leaseMs, now, row.logical_key, now, now);
        if (updated.changes !== 1) continue;
        const claimed = this.db.prepare("SELECT * FROM outbox WHERE logical_key = ?").get(row.logical_key) as OutboxRow;
        result.push(parseOutbox(claimed));
      }
      return result;
    }).immediate();
  }

  public completeEffect(key: string, ownerId: string, generation: number, now: number): boolean {
    this.assertLeaseIdentity(key, ownerId, generation, now);
    return this.db
      .prepare(
        `UPDATE effects SET status = 'done', lease_owner = NULL, lease_generation = NULL,
           lease_expires_at = NULL, last_error = NULL, updated_at = ?
         WHERE idempotency_key = ? AND status = 'leased' AND lease_owner = ?
           AND lease_generation = ? AND lease_expires_at > ?
           AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1 AND owner_id = ?
             AND generation = ? AND lease_expires_at > ?)`,
      )
      .run(now, key, ownerId, generation, now, ownerId, generation, now).changes === 1;
  }

  public completeOutbox(key: string, ownerId: string, generation: number, messageId: number | null, now: number): boolean {
    this.assertLeaseIdentity(key, ownerId, generation, now);
    if (messageId !== null && (!Number.isInteger(messageId) || messageId < 1)) throw new TypeError("messageId must be positive or null");
    return this.db.transaction((): boolean => {
      const updated = this.db.prepare(
        `UPDATE outbox SET status = 'sent', message_id = COALESCE(?, message_id),
           lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL,
           last_error = NULL, updated_at = ?
         WHERE logical_key = ? AND status = 'leased' AND lease_owner = ?
           AND lease_generation = ? AND lease_expires_at > ?
           AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1 AND owner_id = ?
             AND generation = ? AND lease_expires_at > ?)`,
      ).run(messageId, now, key, ownerId, generation, now, ownerId, generation, now);
      if (updated.changes !== 1) return false;
      const controllerReply = /^controller:(controller-turn-[^:]+):reply$/.exec(key);
      if (controllerReply && messageId !== null) {
        const linked = this.db.prepare(
          `UPDATE controller_turns SET telegram_message_id = ?, updated_at = ?
            WHERE id = ? AND (telegram_message_id IS NULL OR telegram_message_id = ?)`,
        ).run(messageId, now, controllerReply[1], messageId);
        if (linked.changes !== 1) throw new Error("Controller reply message changed before completion");
      }
      return true;
    }).immediate();
  }

  public completeStatusOutbox(
    key: string,
    ownerId: string,
    generation: number,
    jobId: string,
    expectedVersion: number,
    messageId: number,
    now: number,
  ): boolean {
    this.assertLeaseIdentity(key, ownerId, generation, now);
    if (!jobId) throw new TypeError("jobId must not be empty");
    assertPositiveInteger(expectedVersion, "expectedVersion");
    if (!Number.isInteger(messageId) || messageId < 1) throw new TypeError("messageId must be positive");
    return this.db.transaction(() => {
      const updatedJob = this.db
        .prepare(
          `UPDATE jobs SET status_message_id = ?, version = ?, updated_at = ?
             WHERE id = ? AND version = ?`,
        )
        .run(messageId, expectedVersion + 1, now, jobId, expectedVersion);
      if (updatedJob.changes !== 1) return false;
      const updatedOutbox = this.db
        .prepare(
          `UPDATE outbox SET status = 'sent', message_id = ?, lease_owner = NULL,
             lease_generation = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ?
             WHERE logical_key = ? AND status = 'leased' AND lease_owner = ?
               AND lease_generation = ? AND lease_expires_at > ?
               AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1 AND owner_id = ?
                 AND generation = ? AND lease_expires_at > ?)`,
        )
        .run(messageId, now, key, ownerId, generation, now, ownerId, generation, now);
      if (updatedOutbox.changes !== 1) throw new Error("status outbox lease changed before atomic completion");
      return true;
    }).immediate();
  }

  public replaceStatusOutboxMessage(
    key: string,
    ownerId: string,
    generation: number,
    jobId: string,
    expectedVersion: number,
    messageId: number,
    now: number,
  ): boolean {
    return this.completeStatusOutbox(key, ownerId, generation, jobId, expectedVersion, messageId, now);
  }

  public failEffect(key: string, ownerId: string, generation: number, error: string, nextAttemptAt: number, now: number): boolean {
    this.assertLeaseIdentity(key, ownerId, generation, now);
    assertSafeFailureSummary(error);
    assertNoRawMergeCallback(error, "effect error");
    assertNonNegativeInteger(nextAttemptAt, "nextAttemptAt");
    return this.db.transaction(() => {
      const effect = this.effectByKey(key);
      if (!effect || !this.effectLeaseIsActiveForRow(effect, ownerId, generation, now)) return false;
      if (effect.attempts >= 20) {
        const updated = this.db
          .prepare(
            `UPDATE effects SET status = 'dead', lease_owner = NULL, lease_generation = NULL,
               lease_expires_at = NULL, last_error = ?, updated_at = ?
             WHERE idempotency_key = ? AND status = 'leased' AND lease_owner = ?
               AND lease_generation = ? AND lease_expires_at > ?`,
          )
          .run(error, now, key, ownerId, generation, now);
        if (updated.changes === 1) this.markJobPermanentFailure(effect.job_id, error, now);
        return updated.changes === 1;
      }
      return this.db
        .prepare(
          `UPDATE effects SET status = 'failed', lease_owner = NULL, lease_generation = NULL,
             lease_expires_at = NULL, last_error = ?, next_attempt_at = ?, updated_at = ?
           WHERE idempotency_key = ? AND status = 'leased' AND lease_owner = ?
             AND lease_generation = ? AND lease_expires_at > ?`,
        )
        .run(error, nextAttemptAt, now, key, ownerId, generation, now).changes === 1;
    }).immediate();
  }

  public failOutbox(key: string, ownerId: string, generation: number, error: string, nextAttemptAt: number, now: number): boolean {
    this.assertLeaseIdentity(key, ownerId, generation, now);
    assertSafeFailureSummary(error);
    assertNoRawMergeCallback(error, "outbox error");
    assertNonNegativeInteger(nextAttemptAt, "nextAttemptAt");
    return this.db.transaction(() => {
      const outbox = this.outboxByKey(key);
      if (!outbox || !this.outboxLeaseIsActiveForRow(outbox, ownerId, generation, now)) return false;
      const status = outbox.attempts >= 20 ? "dead" : "failed";
      const updated = this.db
        .prepare(
          `UPDATE outbox SET status = ?, lease_owner = NULL, lease_generation = NULL,
             lease_expires_at = NULL, last_error = ?, next_attempt_at = ?, updated_at = ?
           WHERE logical_key = ? AND status = 'leased' AND lease_owner = ?
             AND lease_generation = ? AND lease_expires_at > ?`,
        )
        .run(status, error, nextAttemptAt, now, key, ownerId, generation, now);
      if (updated.changes === 1 && status === "dead") this.markJobPermanentFailureFromOutbox(key, error, now);
      return updated.changes === 1;
    }).immediate();
  }

  public deadLetterEffect(key: string, ownerId: string, generation: number, error: string, now: number): boolean {
    this.assertLeaseIdentity(key, ownerId, generation, now);
    assertSafeFailureSummary(error);
    assertNoRawMergeCallback(error, "effect error");
    return this.db.transaction(() => {
      const effect = this.effectByKey(key);
      if (!effect || !this.effectLeaseIsActiveForRow(effect, ownerId, generation, now)) return false;
      const updated = this.db
        .prepare(
          `UPDATE effects SET status = 'dead', lease_owner = NULL, lease_generation = NULL,
             lease_expires_at = NULL, last_error = ?, updated_at = ?
           WHERE idempotency_key = ? AND status = 'leased' AND lease_owner = ?
             AND lease_generation = ? AND lease_expires_at > ?`,
        )
        .run(error, now, key, ownerId, generation, now);
      if (updated.changes === 1) this.markJobPermanentFailure(effect.job_id, error, now);
      return updated.changes === 1;
    }).immediate();
  }

  public deadLetterOutbox(key: string, ownerId: string, generation: number, error: string, now: number): boolean {
    this.assertLeaseIdentity(key, ownerId, generation, now);
    assertSafeFailureSummary(error);
    assertNoRawMergeCallback(error, "outbox error");
    return this.db.transaction(() => {
      const outbox = this.outboxByKey(key);
      if (!outbox || !this.outboxLeaseIsActiveForRow(outbox, ownerId, generation, now)) return false;
      const updated = this.db
        .prepare(
          `UPDATE outbox SET status = 'dead', lease_owner = NULL, lease_generation = NULL,
             lease_expires_at = NULL, last_error = ?, updated_at = ?
           WHERE logical_key = ? AND status = 'leased' AND lease_owner = ?
             AND lease_generation = ? AND lease_expires_at > ?`,
        )
        .run(error, now, key, ownerId, generation, now);
      if (updated.changes === 1) this.markJobPermanentFailureFromOutbox(key, error, now);
      return updated.changes === 1;
    }).immediate();
  }

  public getOutbox(logicalKey: string): StoredOutbox | null {
    if (!logicalKey) throw new TypeError("logicalKey must not be empty");
    const row = this.db.prepare("SELECT * FROM outbox WHERE logical_key = ?").get(logicalKey) as OutboxRow | undefined;
    return row ? parseOutbox(row) : null;
  }

  public listOutbox(limit: number): StoredOutbox[] {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError("limit must be a positive integer");
    const rows = this.db
      .prepare("SELECT * FROM outbox ORDER BY created_at ASC, logical_key ASC LIMIT ?")
      .all(limit) as OutboxRow[];
    return rows.map(parseOutbox);
  }

  public upsertWorkerLiveness(value: WorkerLiveness): void {
    if (!value.jobId || !value.resourceId) throw new TypeError("worker liveness identity is required");
    assertPositiveInteger(value.generation, "generation");
    assertNonNegativeInteger(value.sourceUpdatedAt, "sourceUpdatedAt");
    assertNonNegativeInteger(value.observedAt, "observedAt");
    if (value.staleNotifiedAt !== null) assertNonNegativeInteger(value.staleNotifiedAt, "staleNotifiedAt");
    this.db
      .prepare(
        `INSERT INTO worker_liveness (
           job_id, worker_kind, resource_kind, resource_id, generation, state,
           source_updated_at, observed_at, stale_notified_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           worker_kind = excluded.worker_kind,
           resource_kind = excluded.resource_kind,
           resource_id = excluded.resource_id,
           generation = excluded.generation,
           state = excluded.state,
           source_updated_at = excluded.source_updated_at,
           observed_at = excluded.observed_at,
           stale_notified_at = excluded.stale_notified_at
         WHERE worker_liveness.generation <= excluded.generation`,
      )
      .run(
        value.jobId,
        value.workerKind,
        value.resourceKind,
        value.resourceId,
        value.generation,
        value.state,
        value.sourceUpdatedAt,
        value.observedAt,
        value.staleNotifiedAt,
      );
  }

  public getWorkerLiveness(jobId: string): WorkerLiveness | null {
    if (!jobId) throw new TypeError("jobId must not be empty");
    const row = this.db
      .prepare(
        `SELECT job_id, worker_kind, resource_kind, resource_id, generation, state,
                source_updated_at, observed_at, stale_notified_at
           FROM worker_liveness WHERE job_id = ?`,
      )
      .get(jobId) as {
        job_id: string;
        worker_kind: WorkerLiveness["workerKind"];
        resource_kind: WorkerLiveness["resourceKind"];
        resource_id: string;
        generation: number;
        state: WorkerLiveness["state"];
        source_updated_at: number;
        observed_at: number;
        stale_notified_at: number | null;
      } | undefined;
    return row
      ? {
          jobId: row.job_id,
          workerKind: row.worker_kind,
          resourceKind: row.resource_kind,
          resourceId: row.resource_id,
          generation: row.generation,
          state: row.state,
          sourceUpdatedAt: row.source_updated_at,
          observedAt: row.observed_at,
          staleNotifiedAt: row.stale_notified_at,
        }
      : null;
  }

  public markWorkerLivenessNotified(jobId: string, generation: number, now: number): boolean {
    if (!jobId) throw new TypeError("jobId must not be empty");
    assertPositiveInteger(generation, "generation");
    assertNonNegativeInteger(now, "now");
    return this.db
      .prepare(
        `UPDATE worker_liveness SET stale_notified_at = ?
           WHERE job_id = ? AND generation = ? AND state IN ('stale', 'unknown') AND stale_notified_at IS NULL`,
      )
      .run(now, jobId, generation).changes === 1;
  }

  public clearWorkerLiveness(jobId: string, generation: number): boolean {
    if (!jobId) throw new TypeError("jobId must not be empty");
    assertPositiveInteger(generation, "generation");
    return this.db
      .prepare("DELETE FROM worker_liveness WHERE job_id = ? AND generation = ?")
      .run(jobId, generation).changes === 1;
  }

  public leaseMergeEffect(input: {
    jobId: string;
    effectIdempotencyKey: string;
    leaseOwner: string;
    leaseGeneration: number;
    now: number;
    leaseDurationMs: number;
  }): boolean {
    if (!input.jobId || !input.effectIdempotencyKey || !input.leaseOwner) {
      throw new TypeError("merge effect lease identity is required");
    }
    assertPositiveInteger(input.leaseGeneration, "leaseGeneration");
    assertNonNegativeInteger(input.now, "now");
    if (!Number.isInteger(input.leaseDurationMs) || input.leaseDurationMs < 1) {
      throw new TypeError("leaseDurationMs must be a positive integer");
    }
    const lease = this.db.transaction(() => {
      const row = this.readEffect(input.jobId, input.effectIdempotencyKey);
      if (!row || row.kind !== "merge_pr") return false;
      if (!["pending", "leased"].includes(row.status)) return false;
      if (row.status === "leased" && row.lease_expires_at !== null && row.lease_expires_at > input.now) {
        return false;
      }
      const updated = this.db
        .prepare(
          `UPDATE effects
              SET status = 'leased', attempts = attempts + 1,
                  lease_owner = ?, lease_generation = ?, lease_expires_at = ?,
                  next_attempt_at = ?, updated_at = ?
            WHERE job_id = ? AND idempotency_key = ?
              AND (status = 'pending' OR (status = 'leased' AND lease_expires_at <= ?))`,
        )
        .run(
          input.leaseOwner,
          input.leaseGeneration,
          input.now + input.leaseDurationMs,
          input.now,
          input.now,
          input.jobId,
          input.effectIdempotencyKey,
          input.now,
        );
      return updated.changes === 1;
    });
    return lease();
  }

  public bindMergeEffectReceipt(input: {
    jobId: string;
    effectIdempotencyKey: string;
    receipt: DurableMergeReceipt;
    leaseOwner: string;
    leaseGeneration: number;
    now: number;
  }): boolean {
    if (!input.jobId || !input.effectIdempotencyKey || !input.leaseOwner) {
      throw new TypeError("merge receipt binding identity is required");
    }
    assertPositiveInteger(input.leaseGeneration, "leaseGeneration");
    assertNonNegativeInteger(input.now, "now");
    const receipt = parseDurableMergeReceipt(input.receipt);
    const bind = this.db.transaction((): boolean => {
      const boundaryNow = this.currentNow();
      const effect = this.readEffect(input.jobId, input.effectIdempotencyKey);
      if (!effect || effect.kind !== "merge_pr" || !this.effectLeaseIsActive(effect, input.leaseOwner, input.leaseGeneration, boundaryNow)) return false;
      let pending: PendingMergeEffectPayload;
      try {
        pending = parsePendingMergeEffectPayload(JSON.parse(effect.payload_json));
      } catch {
        return false;
      }
      const job = this.readJobById(input.jobId);
      const approval = this.readApproval(pending.approvalNonceHash);
      if (!job || job.state !== "merging" || job.cancelRequestedAt !== null || !approval) return false;
      if (
        receipt.jobId !== input.jobId ||
        receipt.effectIdempotencyKey !== input.effectIdempotencyKey ||
        receipt.headSha !== pending.headSha ||
        receipt.reviewAttemptId !== pending.reviewAttemptId ||
        receipt.approvalNonceHash !== pending.approvalNonceHash ||
        receipt.approvalOwnerUserId !== pending.approvalOwnerUserId ||
        receipt.approvalOwnerChatId !== pending.approvalOwnerChatId ||
        receipt.approvalJobVersion !== pending.approvalJobVersion ||
        Date.parse(receipt.expiresAt) !== pending.approvalExpiresAt
      ) return false;
      if (this.mergeReceiptBindingError(effect, { headSha: receipt.headSha, receipt }, job, approval, boundaryNow) !== null) return false;
      const updated = this.db
        .prepare(
          `UPDATE effects SET payload_json = ?, updated_at = ?
             WHERE job_id = ? AND idempotency_key = ? AND status = 'leased'
               AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?`,
        )
        .run(
          serializeBoundedJson({ headSha: receipt.headSha, receipt }, "merge effect payload", MAX_MERGE_RESULT_JSON),
          boundaryNow,
          input.jobId,
          input.effectIdempotencyKey,
          input.leaseOwner,
          input.leaseGeneration,
          boundaryNow,
        );
      return updated.changes === 1;
    });
    return bind();
  }

  public prepareMergeCall(input: {
    jobId: string;
    effectIdempotencyKey: string;
    leaseOwner: string;
    leaseGeneration: number;
    now: number;
  }): MergeCallPreparation {
    if (!input.jobId || !input.effectIdempotencyKey || !input.leaseOwner) {
      throw new TypeError("merge call fence identity is required");
    }
    assertPositiveInteger(input.leaseGeneration, "leaseGeneration");
    assertNonNegativeInteger(input.now, "now");

    const prepare = this.db.transaction((): MergeCallPreparation => {
      const boundaryNow = this.currentNow();
      const row = this.readEffect(input.jobId, input.effectIdempotencyKey);
      if (!row) return { ok: false, reason: "durable merge effect was not found" };
      if (row.kind !== "merge_pr") return { ok: false, reason: "durable effect is not merge_pr" };
      if (
        row.status !== "leased" ||
        row.lease_owner !== input.leaseOwner ||
        row.lease_generation !== input.leaseGeneration ||
        row.lease_expires_at === null ||
        row.lease_expires_at <= boundaryNow
      ) {
        return { ok: false, reason: "merge effect lease is missing, stale, or expired" };
      }

      let payload: MergeEffectPayload;
      try {
        payload = parseMergeEffectPayload(JSON.parse(row.payload_json));
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? `invalid durable merge effect: ${error.message}` : "invalid durable merge effect" };
      }
      const job = this.readJobById(row.job_id);
      if (!job) return { ok: false, reason: "merge effect job was not found" };
      const approval = this.readApproval(payload.receipt.approvalNonceHash);
      const bindingError = this.mergeReceiptBindingError(row, payload, job, approval, boundaryNow);
      if (bindingError) return { ok: false, reason: bindingError };

      if (payload.mergeCallStartedAt !== undefined) {
        return {
          ok: true,
          shouldCallProvider: false,
          effect: parseEffect(row),
          job,
          receipt: payload.receipt,
        };
      }

      const markedPayload: MergeEffectPayload = {
        ...payload,
        mergeCallStartedAt: boundaryNow,
        mergeCallOutcome: "unknown",
      };
      const payloadJson = serializeBoundedJson(markedPayload, "merge effect payload", MAX_MERGE_RESULT_JSON);
      const marked = this.db
        .prepare(
          `UPDATE effects SET payload_json = ?, updated_at = ?
             WHERE job_id = ? AND idempotency_key = ? AND status = 'leased'
               AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?`,
        )
        .run(
          payloadJson,
          boundaryNow,
          input.jobId,
          input.effectIdempotencyKey,
          input.leaseOwner,
          input.leaseGeneration,
          boundaryNow,
        );
      if (marked.changes !== 1) return { ok: false, reason: "merge effect lease changed before provider call" };
      const markedRow = this.readEffect(input.jobId, input.effectIdempotencyKey);
      if (!markedRow) return { ok: false, reason: "merge effect fence was not persisted" };
      return {
        ok: true,
        shouldCallProvider: true,
        effect: parseEffect(markedRow),
        job,
        receipt: payload.receipt,
      };
    });
    return prepare();
  }

  public rejectApprovalAndRecordCallback(input: {
    nonceHash: string;
    callbackId: string;
    jobId: string | null;
    now: number;
    headSha?: string;
  }): ApprovalRejectionResult {
    assertSha256Hex(input.nonceHash);
    if (!input.callbackId) throw new TypeError("callbackId must not be empty");
    assertNonNegativeInteger(input.now, "now");
    if (input.headSha !== undefined) assertFullSha(input.headSha, "headSha");
    assertNoRawMergeCallback(input.callbackId, "callbackId");
    if (input.jobId !== null) assertNoRawMergeCallback(input.jobId, "callback job id");
    const reject = this.db.transaction((): ApprovalRejectionResult => {
      const boundaryNow = this.currentNow();
      const previous = this.db
        .prepare("SELECT outcome FROM callbacks WHERE callback_query_id = ?")
        .get(input.callbackId) as { outcome: string } | undefined;
      if (previous) {
        return { outcome: previous.outcome === "accepted" ? "accepted" : "rejected", callbackRecorded: false };
      }

      const approval = this.readApproval(input.nonceHash);
      const acceptedIdentity = approval?.outcome === "accepted" && approval.consumed_at !== null
        ? this.findAcceptedMergeCallbackIdentity(approval.job_id, approval.head_sha, input.nonceHash)
        : null;
      if (approval && acceptedIdentity) {
        const recorded = this.insertCallback(
          input.callbackId,
          approval.job_id,
          "merge",
          "accepted",
          boundaryNow,
          acceptedIdentity,
        );
        return { outcome: "accepted", callbackRecorded: recorded };
      }

      const jobId = input.jobId ?? approval?.job_id ?? null;
      if (approval?.consumed_at === null) {
        this.db
          .prepare(
            `UPDATE approvals SET consumed_at = ?, outcome = 'revoked'
               WHERE nonce_hash = ? AND consumed_at IS NULL`,
          )
          .run(boundaryNow, input.nonceHash);
        const job = approval ? this.readJobById(approval.job_id) : null;
        if (job?.state === "awaiting_merge_approval") {
          const transitioned = transition(job, {
            type: "APPROVAL_STALE",
            ...(input.headSha === undefined ? {} : { headSha: input.headSha }),
          }, boundaryNow);
          persistJobTransition(this.db, job.id, job.version, transitioned.job);
          persistPendingEffects(this.db, transitioned.effects, boundaryNow);
        }
      } else if (approval?.outcome === "accepted") {
        this.db
          .prepare("UPDATE approvals SET outcome = 'revoked' WHERE nonce_hash = ?")
          .run(input.nonceHash);
      }

      const recorded = this.insertCallback(input.callbackId, jobId, "merge", "rejected", boundaryNow);
      return { outcome: "rejected", callbackRecorded: recorded };
    });
    return reject();
  }

  public createApproval(input: {
    nonceHash: string;
    jobId: string;
    headSha: string;
    expiresAt: number;
    now: number;
    ownerUserId?: string | null;
    ownerChatId?: string | null;
    jobVersion?: number | null;
  }): void {
    assertSha256Hex(input.nonceHash);
    assertFullSha(input.headSha, "headSha");
    assertNonNegativeInteger(input.now, "now");
    assertNonNegativeInteger(input.expiresAt, "expiresAt");
    if (input.expiresAt <= input.now) throw new TypeError("expiresAt must be after now");
    if (!input.jobId) throw new TypeError("jobId must not be empty");
    if (input.jobVersion !== null && input.jobVersion !== undefined) {
      if (!Number.isInteger(input.jobVersion) || input.jobVersion < 1) {
        throw new TypeError("jobVersion must be a positive integer");
      }
    }

    const create = this.db.transaction(() => {
      const job = this.readJobById(input.jobId);
      if (!job) throw new Error(`Job ${input.jobId} was not found`);
      if (job.prHeadSha !== input.headSha) throw new VersionConflictError(input.jobId, job.version);

      const owner = this.getOwner();
      const ownerUserId = input.ownerUserId ?? owner?.userId ?? null;
      const ownerChatId = input.ownerChatId ?? owner?.chatId ?? null;
      if ((ownerUserId === null) !== (ownerChatId === null)) {
        throw new TypeError("Approval owner identity must include both user and chat ids");
      }
      if (ownerUserId !== null) assertCanonicalPositiveDecimal(ownerUserId, "ownerUserId");
      if (ownerChatId !== null) assertCanonicalPositiveDecimal(ownerChatId, "ownerChatId");

      this.db
        .prepare(
          `UPDATE approvals
              SET consumed_at = ?, outcome = 'superseded'
            WHERE job_id = ? AND consumed_at IS NULL`,
        )
        .run(input.now, input.jobId);
      this.db
        .prepare(
          `INSERT INTO approvals (
             nonce_hash, job_id, head_sha, expires_at, consumed_at, outcome,
             owner_user_id, owner_chat_id, job_version
           ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          input.nonceHash,
          input.jobId,
          input.headSha,
          input.expiresAt,
          ownerUserId,
          ownerChatId,
          input.jobVersion ?? job.version,
        );
    });
    create();
  }

  public getUsableApproval(nonceHash: string, now: number): ApprovalRecord | null {
    assertSha256Hex(nonceHash);
    assertNonNegativeInteger(now, "now");
    const usable = this.db.transaction((): ApprovalRecord | null => {
      const boundaryNow = this.currentNow();
      const row = this.readApproval(nonceHash);
      if (!row || row.consumed_at !== null || boundaryNow >= row.expires_at) return null;
      if (!this.approvalIsCurrent(row, undefined)) {
        this.db
          .prepare(
            `UPDATE approvals SET consumed_at = ?, outcome = 'revoked'
               WHERE nonce_hash = ? AND consumed_at IS NULL`,
          )
          .run(boundaryNow, nonceHash);
        return null;
      }
      return {
        jobId: row.job_id,
        headSha: row.head_sha,
        expiresAt: row.expires_at,
        jobVersion: row.job_version,
        ownerUserId: row.owner_user_id,
        ownerChatId: row.owner_chat_id,
      };
    });
    return usable();
  }

  public getApproval(nonceHash: string): ApprovalState | null {
    assertSha256Hex(nonceHash);
    const row = this.readApproval(nonceHash);
    return row
      ? {
          jobId: row.job_id,
          headSha: row.head_sha,
          expiresAt: row.expires_at,
          jobVersion: row.job_version,
          ownerUserId: row.owner_user_id,
          ownerChatId: row.owner_chat_id,
          consumedAt: row.consumed_at,
          outcome: row.outcome,
        }
      : null;
  }

  public consumeApproval(input: {
    nonceHash: string;
    now: number;
    identity?: ApprovalIdentity;
  }): ApprovalConsumeResult {
    assertSha256Hex(input.nonceHash);
    assertNonNegativeInteger(input.now, "now");
    const consume = this.db.transaction((): ApprovalConsumeResult => {
      const boundaryNow = this.currentNow();
      const row = this.readApproval(input.nonceHash);
      if (!row) return { ok: false, reason: "missing" };
      if (row.consumed_at !== null) {
        return row.outcome !== null && row.outcome !== "consumed" && row.outcome !== "accepted"
          ? { ok: false, reason: "revoked" }
          : { ok: false, reason: "consumed" };
      }
      if (boundaryNow >= row.expires_at) return { ok: false, reason: "expired" };
      if (!this.approvalIsCurrent(row, input.identity)) {
        this.db
          .prepare(
            `UPDATE approvals SET consumed_at = ?, outcome = 'revoked'
               WHERE nonce_hash = ? AND consumed_at IS NULL`,
          )
          .run(boundaryNow, input.nonceHash);
        return { ok: false, reason: "revoked" };
      }

      const updated = this.db
        .prepare(
          `UPDATE approvals
              SET consumed_at = ?, outcome = 'consumed'
            WHERE nonce_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
        )
        .run(boundaryNow, input.nonceHash, boundaryNow);
      if (updated.changes !== 1) {
        const current = this.readApproval(input.nonceHash);
        return current?.consumed_at !== null
          ? { ok: false, reason: "consumed" }
          : { ok: false, reason: "expired" };
      }
      return { ok: true, jobId: row.job_id, headSha: row.head_sha, expiresAt: row.expires_at };
    });
    return consume();
  }

  public acceptApprovalAndEnqueueMerge(input: {
    nonceHash: string;
    expectedJobVersion: number;
    effect: JobEffect;
    now: number;
    identity?: ApprovalIdentity;
  }): ApprovalAcceptResult {
    assertSha256Hex(input.nonceHash);
    if (!Number.isInteger(input.expectedJobVersion) || input.expectedJobVersion < 1) {
      throw new TypeError("expectedJobVersion must be a positive integer");
    }
    assertNonNegativeInteger(input.now, "now");
    if (
      input.effect.kind !== "merge_pr" ||
      input.effect.jobId.length === 0 ||
      input.effect.idempotencyKey.length === 0
    ) {
      throw new TypeError("approval acceptance requires one merge_pr effect");
    }

    const accept = this.db.transaction((): ApprovalAcceptResult => {
      const boundaryNow = this.currentNow();
      const row = this.readApproval(input.nonceHash);
      if (!row) return { ok: false, reason: "missing" };
      if (row.consumed_at !== null) {
        if (row.outcome === "accepted") {
          const current = this.readJobById(row.job_id);
          const expectedKey = `${row.job_id}:${(row.job_version ?? input.expectedJobVersion) + 1}:merge_pr`;
          const existing = this.readEffect(row.job_id, expectedKey);
          if (!current || !existing) throw new Error("accepted approval is missing its durable merge effect");
          if (input.effect.idempotencyKey !== expectedKey || input.effect.jobId !== row.job_id) {
            throw new Error("accepted merge effect idempotency key does not match the generated key");
          }
          let existingPayload: MergeEffectPayload | PendingMergeEffectPayload;
          let suppliedPayload: MergeEffectPayload | PendingMergeEffectPayload;
          try {
            const existingRaw = JSON.parse(existing.payload_json) as Record<string, unknown>;
            existingPayload = Object.prototype.hasOwnProperty.call(existingRaw, "receipt")
              ? parseMergeEffectPayload(existingRaw)
              : parsePendingMergeEffectPayload(existingRaw);
            const suppliedRaw = input.effect.payload as Record<string, unknown>;
            if (Object.prototype.hasOwnProperty.call(suppliedRaw, "receipt")) {
              suppliedPayload = parseMergeEffectPayload(suppliedRaw);
            } else if (Object.keys(suppliedRaw).length === 1 && Object.prototype.hasOwnProperty.call(suppliedRaw, "headSha")) {
              if ("receipt" in existingPayload) throw new TypeError("accepted merge effect payload shape changed");
              suppliedPayload = {
                headSha: suppliedRaw.headSha as string,
                reviewAttemptId: existingPayload.reviewAttemptId,
                approvalNonceHash: input.nonceHash,
                approvalOwnerUserId: row.owner_user_id ?? "",
                approvalOwnerChatId: row.owner_chat_id ?? "",
                approvalJobVersion: row.job_version ?? input.expectedJobVersion,
                approvalExpiresAt: row.expires_at,
              };
            } else {
              suppliedPayload = parsePendingMergeEffectPayload(suppliedRaw);
            }
          } catch (error) {
            throw new Error(error instanceof Error ? `accepted merge effect is invalid: ${error.message}` : "accepted merge effect is invalid");
          }
          const existingMatches = "receipt" in existingPayload
            ? existingPayload.receipt.approvalNonceHash === input.nonceHash &&
              existingPayload.receipt.headSha === row.head_sha
            : existingPayload.approvalNonceHash === input.nonceHash &&
              existingPayload.headSha === row.head_sha &&
              existingPayload.reviewAttemptId.length > 0 &&
              existingPayload.approvalJobVersion === (row.job_version ?? input.expectedJobVersion);
          const suppliedMatches = "receipt" in suppliedPayload
            ? suppliedPayload.receipt.approvalNonceHash === input.nonceHash && suppliedPayload.receipt.headSha === row.head_sha
            : suppliedPayload.approvalNonceHash === input.nonceHash && suppliedPayload.headSha === row.head_sha;
          if (!existingMatches || !suppliedMatches || JSON.stringify(suppliedPayload) !== JSON.stringify(existingPayload)) {
            throw new Error("accepted merge effect payload does not match the approval");
          }
          return { ok: true, jobId: row.job_id, headSha: row.head_sha };
        }
        return row.outcome !== null && row.outcome !== "consumed"
          ? { ok: false, reason: "revoked" }
          : { ok: false, reason: "consumed" };
      }
      if (boundaryNow >= row.expires_at) return { ok: false, reason: "expired" };
      const current = this.readJobById(row.job_id);
      if (!current || current.version !== input.expectedJobVersion || row.job_version !== null && row.job_version !== input.expectedJobVersion) {
        return { ok: false, reason: "version_conflict" };
      }
      if (!this.approvalIsCurrent(row, input.identity)) {
        this.db
          .prepare(
            `UPDATE approvals SET consumed_at = ?, outcome = 'revoked'
               WHERE nonce_hash = ? AND consumed_at IS NULL`,
          )
          .run(boundaryNow, input.nonceHash);
        return { ok: false, reason: "revoked" };
      }
      if (current.state !== "awaiting_merge_approval" || input.effect.jobId !== row.job_id) {
        return { ok: false, reason: "version_conflict" };
      }

      const transitioned = transition(
        current,
        { type: "APPROVAL_ACCEPTED", headSha: row.head_sha },
        boundaryNow,
      );
      const generated = transitioned.effects.filter((effect) => effect.kind === "merge_pr");
      if (generated.length !== 1) throw new Error("approval acceptance did not generate exactly one merge effect");
      const generatedEffect = generated[0];
      if (
        input.effect.idempotencyKey !== generatedEffect.idempotencyKey ||
        input.effect.jobId !== generatedEffect.jobId ||
        input.effect.kind !== generatedEffect.kind
      ) {
        throw new Error("caller-supplied merge effect does not use the exact generated identity");
      }
      const rawPayload = input.effect.payload as Record<string, unknown>;
      let persistedPayload: MergeEffectPayload | PendingMergeEffectPayload;
      if (Object.prototype.hasOwnProperty.call(rawPayload, "receipt")) {
        const payload = parseMergeEffectPayload(rawPayload);
        if (payload.mergeCallStartedAt !== undefined || payload.mergeCallOutcome !== undefined) {
          throw new TypeError("a new merge effect cannot already have an external-call fence");
        }
        if (JSON.stringify(generatedEffect.payload) !== JSON.stringify({ headSha: payload.headSha })) {
          throw new TypeError("caller-supplied merge effect does not use the exact generated payload");
        }
        const receiptError = this.approvalReceiptBindingError(
          input.effect,
          payload,
          generatedEffect.idempotencyKey,
          current,
          row,
          input.nonceHash,
          boundaryNow,
        );
        if (receiptError) throw new TypeError(receiptError);
        persistedPayload = payload;
      } else {
        const headSha = rawPayload.headSha;
        if (Object.keys(rawPayload).length !== 1 || typeof headSha !== "string" || headSha !== row.head_sha) {
          throw new TypeError("caller-supplied pending merge effect does not use the exact generated head");
        }
        const reviewAttempt = this.db
          .prepare("SELECT id FROM attempts WHERE job_id = ? AND kind = 'review' AND head_sha = ? ORDER BY created_at DESC, id DESC LIMIT 1")
          .get(row.job_id, row.head_sha) as { id?: string } | undefined;
        persistedPayload = {
          headSha: row.head_sha,
          reviewAttemptId: reviewAttempt?.id ?? `review:${row.job_id}`,
          approvalNonceHash: input.nonceHash,
          approvalOwnerUserId: row.owner_user_id ?? input.identity?.userId ?? "",
          approvalOwnerChatId: row.owner_chat_id ?? input.identity?.chatId ?? "",
          approvalJobVersion: row.job_version ?? input.expectedJobVersion,
          approvalExpiresAt: row.expires_at,
        };
        parsePendingMergeEffectPayload(persistedPayload);
      }

      const consumed = this.db
        .prepare(
          `UPDATE approvals
              SET consumed_at = ?, outcome = 'accepted'
            WHERE nonce_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
        )
        .run(boundaryNow, input.nonceHash, boundaryNow);
      if (consumed.changes !== 1) return { ok: false, reason: "consumed" };

      persistJobTransition(this.db, current.id, input.expectedJobVersion, transitioned.job);
      const effectPayloadJson = serializeBoundedJson(persistedPayload, "merge effect payload", MAX_MERGE_RESULT_JSON);
      const inserted = this.db
        .prepare(
          `INSERT INTO effects (
             idempotency_key, job_id, kind, payload_json, status, attempts,
             next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, 'merge_pr', ?, 'pending', 0, ?, ?, ?)`,
        )
        .run(
          generatedEffect.idempotencyKey,
          generatedEffect.jobId,
          effectPayloadJson,
          boundaryNow,
          boundaryNow,
          boundaryNow,
        );
      if (inserted.changes !== 1) throw new Error("durable merge effect insertion did not insert exactly one row");
      const otherEffects = transitioned.effects.filter((effect) => effect.kind !== "merge_pr");
      persistPendingEffects(this.db, otherEffects, boundaryNow);
      return { ok: true, jobId: row.job_id, headSha: row.head_sha };
    });
    return accept();
  }

  public revokeApprovals(jobId: string, reason: string, now: number): number {
    if (!jobId) throw new TypeError("jobId must not be empty");
    assertSafeFailureSummary(reason);
    assertNoRawMergeCallback(reason, "approval outcome");
    assertNonNegativeInteger(now, "now");
    return this.db
      .prepare(
        `UPDATE approvals
            SET consumed_at = ?, outcome = ?
          WHERE job_id = ? AND consumed_at IS NULL`,
      )
      .run(now, reason, jobId).changes;
  }

  private releaseUnknownMergeFence(input: {
    effect: EffectRow;
    payloadJson: string;
    boundaryNow: number;
    leaseOwner: string;
    leaseGeneration: number;
  }): boolean {
    const updated = this.db
      .prepare(
        `UPDATE effects SET payload_json = ?, status = 'pending', lease_owner = NULL,
           lease_generation = NULL, lease_expires_at = NULL, last_error = ?,
           next_attempt_at = ?, updated_at = ?
         WHERE job_id = ? AND idempotency_key = ? AND status = 'leased'
           AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?`,
      )
      .run(
        input.payloadJson,
        UNKNOWN_MERGE_OUTCOME_REASON,
        input.boundaryNow,
        input.boundaryNow,
        input.effect.job_id,
        input.effect.idempotency_key,
        input.leaseOwner,
        input.leaseGeneration,
        input.boundaryNow,
      );
    if (updated.changes !== 1) return false;

    this.cancelUnknownMergeJob(input.effect.job_id, input.boundaryNow);
    return true;
  }

  private cancelUnknownMergeJob(jobId: string, boundaryNow: number): void {
    const job = this.db
      .prepare("SELECT state, cancel_requested_at, version FROM jobs WHERE id = ?")
      .get(jobId) as { state: string; cancel_requested_at: number | null; version: number } | undefined;
    if (job?.state === "merging" && job.cancel_requested_at !== null) {
      const cancelled = this.db
        .prepare(
          `UPDATE jobs SET state = 'cancelled', resume_state = NULL, last_error = NULL,
             version = ?, updated_at = ? WHERE id = ? AND state = 'merging' AND version = ?`,
        )
        .run(job.version + 1, boundaryNow, jobId, job.version);
      if (cancelled.changes === 1) {
        persistPendingEffects(this.db, [{
          idempotencyKey: `${jobId}:${job.version + 1}:render_status`,
          jobId,
          kind: "render_status",
          payload: {},
        }], boundaryNow);
      }
      this.db
        .prepare(
          `UPDATE approvals SET consumed_at = COALESCE(consumed_at, ?), outcome = 'revoked'
             WHERE job_id = ? AND (outcome IS NULL OR outcome = 'accepted')`,
        )
        .run(boundaryNow, jobId);
    }
  }

  public completeMergeSuccess(input: MergeSuccessInput): boolean {
    assertSafeFailureSummary(input.message);
    assertNonNegativeInteger(input.now, "now");
    const persistedResult = parsePersistedMergeSuccessResult(input.result);
    const resultJson = serializeBoundedJson(persistedResult, "merge result", MAX_MERGE_RESULT_JSON);
    const complete = this.db.transaction((): boolean => {
      const boundaryNow = this.currentNow();
      const effect = this.readEffect(input.jobId, input.effectIdempotencyKey);
      if (!effect) return false;
      if (effect.status === "done") {
        try {
          const persistedPayload = JSON.parse(effect.payload_json) as Record<string, unknown>;
          const payload = parsePersistedMergeEffectPayload(persistedPayload, "done");
          const storedResult = parsePersistedMergeSuccessResult(persistedPayload.mergeResult);
          const current = this.readJobById(input.jobId);
          if (!current || !mergeSuccessResultMatchesDurable(
            storedResult,
            effect,
            payload,
            current,
            this.readApproval(payload.receipt.approvalNonceHash),
            "post_merge",
          ) || !this.attemptResultMatches(
            payload.receipt.reviewAttemptId,
            input.jobId,
            payload.receipt.headSha,
            storedResult,
          )) return false;
        } catch {
          return false;
        }
        if (input.outbox) persistOutbox(this.db, input.outbox, serializeOutbox(input.outbox, boundaryNow), boundaryNow);
        return true;
      }
      if (!this.effectLeaseIsActive(effect, input.leaseOwner, input.leaseGeneration, boundaryNow)) return false;
      const current = this.readJobById(input.jobId);
      if (!current || current.state !== "merging" || current.cancelRequestedAt !== null) return false;
      let storedPayload: MergeEffectPayload;
      try {
        storedPayload = parseMergeEffectPayload(JSON.parse(effect.payload_json));
      } catch {
        return false;
      }
      const bindingError = this.mergeReceiptBindingError(
        effect,
        storedPayload,
        current,
        this.readApproval(storedPayload.receipt.approvalNonceHash),
        boundaryNow,
      );
      if (bindingError) return false;
      if (storedPayload.mergeCallStartedAt === undefined || storedPayload.mergeCallOutcome !== "unknown") return false;
      if (!mergeSuccessResultMatchesDurable(
        persistedResult,
        effect,
        storedPayload,
        current,
        this.readApproval(storedPayload.receipt.approvalNonceHash),
        "merging",
      )) return false;

      const attempt = this.getAttempt(storedPayload.receipt.reviewAttemptId);
      if (
        !attempt ||
        attempt.jobId !== input.jobId ||
        attempt.kind !== "review" ||
        attempt.headSha !== storedPayload.receipt.headSha
      ) return false;
      const updatedAttempt = this.db
        .prepare(
          `UPDATE attempts SET result_json = ?, completed_at = ?
             WHERE id = ? AND job_id = ? AND kind = 'review'`,
        )
        .run(resultJson, boundaryNow, storedPayload.receipt.reviewAttemptId, input.jobId);
      if (updatedAttempt.changes !== 1) throw new Error("merge result owning attempt was not updated");

      const transitioned = transition(current, {
        type: "MERGE_SUCCEEDED",
        message: input.message,
        mergeCommitSha: persistedResult.mergeCommit.oid,
        mergedAt: persistedResult.mergedAt,
        baseContentVerified: persistedResult.baseContentVerified,
      }, boundaryNow);
      const payloadJson = serializeBoundedJson({
        ...storedPayload,
        mergeResult: persistedResult,
      }, "merge effect result", MAX_MERGE_RESULT_JSON);

      persistJobTransition(this.db, input.jobId, current.version, transitioned.job);
      const updated = this.db
        .prepare(
          `UPDATE effects SET payload_json = ?, status = 'done', lease_owner = NULL,
             lease_generation = NULL, lease_expires_at = NULL, last_error = NULL,
             updated_at = ? WHERE job_id = ? AND idempotency_key = ?
               AND status = 'leased' AND lease_owner = ? AND lease_generation = ?
               AND lease_expires_at > ?`,
        )
        .run(
          payloadJson,
          boundaryNow,
          input.jobId,
          input.effectIdempotencyKey,
          input.leaseOwner,
          input.leaseGeneration,
          boundaryNow,
        );
      if (updated.changes !== 1) throw new Error("Merge effect completion lost its durable row");
      if (input.outbox) persistOutbox(this.db, input.outbox, serializeOutbox(input.outbox, boundaryNow), boundaryNow);
      persistPendingEffects(this.db, transitioned.effects, boundaryNow);
      return true;
    });
    return complete();
  }

  public preserveUnknownMergeEffect(input: {
    jobId: string;
    effectIdempotencyKey: string;
    now: number;
    leaseOwner: string;
    leaseGeneration: number;
  }): boolean {
    if (!input.jobId || !input.effectIdempotencyKey || !input.leaseOwner) {
      throw new TypeError("merge effect unknown-outcome identity is required");
    }
    assertPositiveInteger(input.leaseGeneration, "leaseGeneration");
    assertNonNegativeInteger(input.now, "now");
    const preserve = this.db.transaction((): boolean => {
      const boundaryNow = this.currentNow();
      const updated = this.db
        .prepare(
          `UPDATE effects SET status = 'pending', lease_owner = NULL,
             lease_generation = NULL, lease_expires_at = NULL,
             last_error = ?, next_attempt_at = ?, updated_at = ?
           WHERE job_id = ? AND idempotency_key = ? AND status = 'leased'
             AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?`,
        )
        .run(
          UNKNOWN_MERGE_OUTCOME_REASON,
          boundaryNow,
          boundaryNow,
          input.jobId,
          input.effectIdempotencyKey,
          input.leaseOwner,
          input.leaseGeneration,
          boundaryNow,
        );
      return updated.changes === 1;
    });
    return preserve();
  }

  public failLeasedMergeEffect(input: MergeFailureInput): boolean {
    if (!input.jobId || !input.effectIdempotencyKey || !input.leaseOwner) {
      throw new TypeError("merge effect failure identity is required");
    }
    assertPositiveInteger(input.leaseGeneration, "leaseGeneration");
    assertNonNegativeInteger(input.now, "now");
    void input.reason;

    const fail = this.db.transaction((): boolean => {
      const effect = this.readEffect(input.jobId, input.effectIdempotencyKey);
      if (!effect || effect.kind !== "merge_pr") return false;
      const boundaryNow = this.currentNow();
      if (!this.effectLeaseIsActive(effect, input.leaseOwner, input.leaseGeneration, boundaryNow)) return false;
      const unknownPayloadJson = sanitizedUnknownMergePayload(effect.payload_json);
      if (unknownPayloadJson !== null) {
        return this.releaseUnknownMergeFence({
          effect,
          payloadJson: unknownPayloadJson,
          boundaryNow,
          leaseOwner: input.leaseOwner,
          leaseGeneration: input.leaseGeneration,
        });
      }
      const updated = this.db
        .prepare(
          `UPDATE effects SET payload_json = ?, status = 'failed', lease_owner = NULL,
             lease_generation = NULL, lease_expires_at = NULL, last_error = ?,
             next_attempt_at = ?, updated_at = ?
           WHERE job_id = ? AND idempotency_key = ? AND status = 'leased'
             AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?`,
        )
        .run(
          SAFE_FAILED_MERGE_PAYLOAD,
          SAFE_MERGE_FAILURE_REASON,
          boundaryNow,
          boundaryNow,
          input.jobId,
          input.effectIdempotencyKey,
          input.leaseOwner,
          input.leaseGeneration,
          boundaryNow,
        );
      if (updated.changes !== 1) return false;

      this.db
        .prepare(
          `UPDATE approvals SET consumed_at = COALESCE(consumed_at, ?), outcome = 'revoked'
             WHERE job_id = ? AND (outcome IS NULL OR outcome = 'accepted')`,
        )
        .run(boundaryNow, input.jobId);

      const job = this.db
        .prepare("SELECT state, cancel_requested_at, version FROM jobs WHERE id = ?")
        .get(input.jobId) as { state: string; cancel_requested_at: number | null; version: number } | undefined;
      if (job?.state === "merging") {
        const cancelled = job.cancel_requested_at !== null;
        const nextVersion = job.version + 1;
        const changed = this.db
          .prepare(
            `UPDATE jobs SET state = ?, resume_state = ?, last_error = ?, version = ?, updated_at = ?
               WHERE id = ? AND state = 'merging' AND version = ?`,
          )
          .run(
            cancelled ? "cancelled" : "failed",
            cancelled ? null : "merging",
            cancelled ? null : SAFE_MERGE_FAILURE_REASON,
            nextVersion,
            boundaryNow,
            input.jobId,
            job.version,
          );
        if (changed.changes === 1) {
          this.db
            .prepare(
              `INSERT OR IGNORE INTO effects (
                 idempotency_key, job_id, kind, payload_json, status, attempts,
               next_attempt_at, created_at, updated_at
             ) VALUES (?, ?, 'render_status', '{}', 'pending', 0, ?, ?, ?)`,
            )
            .run(`${input.jobId}:${nextVersion}:render_status`, input.jobId, boundaryNow, boundaryNow, boundaryNow);
        }
      }
      return true;
    });
    return fail();
  }

  public failMergeEffect(input: MergeFailureInput): boolean {
    return this.failLeasedMergeEffect(input);
  }

  public staleMergeEffect(input: MergeStaleInput): boolean {
    assertSafeFailureSummary(input.reason);
    assertNoRawMergeCallback(input.reason, "merge stale reason");
    assertNonNegativeInteger(input.now, "now");
    const stale = this.db.transaction((): boolean => {
      const boundaryNow = this.currentNow();
      const effect = this.readEffect(input.jobId, input.effectIdempotencyKey);
      if (!effect || effect.kind !== "merge_pr" || effect.status === "done") return false;
      if (!this.effectLeaseIsActive(effect, input.leaseOwner, input.leaseGeneration, boundaryNow)) return false;
      const unknownPayloadJson = sanitizedUnknownMergePayload(effect.payload_json);
      if (unknownPayloadJson !== null) {
        return this.releaseUnknownMergeFence({
          effect,
          payloadJson: unknownPayloadJson,
          boundaryNow,
          leaseOwner: input.leaseOwner,
          leaseGeneration: input.leaseGeneration,
        });
      }
      const current = this.readJobById(input.jobId);
      if (!current || current.state !== "merging") return false;
      if (current.prNumber === null) return false;

      let validPrUrl: string;
      try {
        validPrUrl = assertSafeExternalHttpsUrl(current.prUrl, "job.prUrl");
      } catch {
        const transitioned = current.cancelRequestedAt !== null
          ? transition(current, { type: "CANCEL_CONFIRMED" }, boundaryNow)
          : transition(current, { type: "FAILED", error: SAFE_MERGE_FAILURE_REASON }, boundaryNow);
        transitioned.job.prUrl = null;
        persistJobTransition(this.db, input.jobId, current.version, transitioned.job);
        this.db
          .prepare(
            `UPDATE approvals SET consumed_at = COALESCE(consumed_at, ?), outcome = 'revoked'
               WHERE job_id = ? AND (outcome IS NULL OR outcome = 'accepted')`,
          )
          .run(boundaryNow, input.jobId);
        persistPendingEffects(this.db, transitioned.effects, boundaryNow);
        const cleaned = this.db
          .prepare(
            `UPDATE effects SET payload_json = ?, status = 'failed', lease_owner = NULL,
               lease_generation = NULL, lease_expires_at = NULL, last_error = ?,
               updated_at = ? WHERE job_id = ? AND idempotency_key = ?
               AND status = 'leased' AND lease_owner = ? AND lease_generation = ?
               AND lease_expires_at > ?`,
          )
          .run(
            SAFE_FAILED_MERGE_PAYLOAD,
            SAFE_MERGE_FAILURE_REASON,
            boundaryNow,
            input.jobId,
            input.effectIdempotencyKey,
            input.leaseOwner,
            input.leaseGeneration,
            boundaryNow,
          );
        if (cleaned.changes !== 1) throw new Error("Stale merge effect lost its durable row");
        return true;
      }

      const next = structuredClone(current);
      const cancelled = current.cancelRequestedAt !== null;
      if (cancelled) {
        next.state = "cancelled";
        next.resumeState = null;
        next.lastError = null;
      } else {
        next.prHeadSha = null;
        next.state = "resolving_pr_head";
        next.lastError = input.reason;
      }
      next.version += 1;
      next.updatedAt = boundaryNow;
      persistJobTransition(this.db, input.jobId, current.version, next);
      this.db
        .prepare(
          `UPDATE approvals SET consumed_at = COALESCE(consumed_at, ?), outcome = 'revoked'
             WHERE job_id = ? AND (outcome IS NULL OR outcome = 'accepted')`,
        )
        .run(boundaryNow, input.jobId);
      const effects: JobEffect[] = cancelled
        ? [{ idempotencyKey: `${input.jobId}:${next.version}:render_status`, jobId: input.jobId, kind: "render_status", payload: {} }]
        : [{
            idempotencyKey: `${input.jobId}:${next.version}:resolve_pr_head`,
            jobId: input.jobId,
            kind: "resolve_pr_head",
            payload: { number: current.prNumber, url: validPrUrl },
          }, {
            idempotencyKey: `${input.jobId}:${next.version}:render_status`,
            jobId: input.jobId,
            kind: "render_status",
            payload: {},
          }];
      persistPendingEffects(this.db, effects, boundaryNow);
      const stalePayloadJson = serializeBoundedJson({
        mergeOutcome: "stale",
        jobId: input.jobId,
        effectIdempotencyKey: input.effectIdempotencyKey,
      }, "stale merge effect payload", MAX_MERGE_RESULT_JSON);
      const updated = this.db
        .prepare(
          `UPDATE effects SET payload_json = ?, status = 'done', lease_owner = NULL,
             lease_generation = NULL, lease_expires_at = NULL, last_error = ?,
             updated_at = ? WHERE job_id = ? AND idempotency_key = ?
               AND status = 'leased' AND lease_owner = ? AND lease_generation = ?
               AND lease_expires_at > ?`,
        )
        .run(
          stalePayloadJson,
          input.reason,
          boundaryNow,
          input.jobId,
          input.effectIdempotencyKey,
          input.leaseOwner,
          input.leaseGeneration,
          boundaryNow,
        );
      if (updated.changes !== 1) throw new Error("Stale merge effect lost its durable row");
      return true;
    });
    return stale();
  }

  public beginTelegramUpdate(updateId: number, now: number): "process" | "processed" {
    if (!Number.isInteger(updateId) || updateId < 0) throw new TypeError("updateId must be a non-negative integer");
    const begin = this.db.transaction((): "process" | "processed" => {
      const existing = this.db
        .prepare(
          "SELECT status, claim_owner, claim_generation, claim_expires_at FROM telegram_updates WHERE update_id = ?",
        )
        .get(updateId) as TelegramUpdateRow | undefined;
      if (existing?.status === "processed") return "processed";

      // Sequential ingress keeps this store's claimed handler in flight; tokenless
      // completion cannot safely distinguish a same-store reclaim from that handler.
      if (this.claimedUpdates.has(updateId)) return "processed";

      if (
        existing?.status === "processing" &&
        existing.claim_expires_at !== null &&
        existing.claim_expires_at > now
      ) {
        return "processed";
      }

      const generation = (existing?.claim_generation ?? 0) + 1;
      const expiresAt = now + TELEGRAM_UPDATE_LEASE_MS;
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO telegram_updates (
               update_id, status, attempts, outcome, last_error, processed_at,
               claim_owner, claim_generation, claim_expires_at
             ) VALUES (?, 'processing', 1, NULL, NULL, NULL, ?, ?, ?)`,
          )
          .run(updateId, this.claimOwner, generation, expiresAt);
      } else {
        this.db
          .prepare(
            `UPDATE telegram_updates
                SET status = 'processing', attempts = attempts + 1,
                    outcome = NULL, last_error = NULL, processed_at = NULL,
                    claim_owner = ?, claim_generation = ?, claim_expires_at = ?
              WHERE update_id = ?`,
          )
          .run(this.claimOwner, generation, expiresAt, updateId);
      }
      this.claimedUpdates.set(updateId, generation);
      return "process";
    });
    return begin();
  }

  public completeTelegramUpdate(updateId: number, outcome: string, now: number): void {
    assertSafeFailureSummary(outcome);
    assertNoRawMergeCallback(outcome, "Telegram update outcome");
    const claimGeneration = this.claimedUpdates.get(updateId);
    if (claimGeneration === undefined) throw new UpdateClaimConflictError(updateId);

    const complete = this.db.transaction(() => {
      const updated = this.db
        .prepare(
          `UPDATE telegram_updates
              SET status = 'processed', outcome = ?, last_error = NULL, processed_at = ?,
                  claim_owner = NULL, claim_expires_at = NULL
            WHERE update_id = ?
              AND status = 'processing'
              AND claim_owner = ?
              AND claim_generation = ?
              AND claim_expires_at > ?`,
        )
        .run(outcome, now, updateId, this.claimOwner, claimGeneration, now);
      if (updated.changes !== 1) {
        this.claimedUpdates.delete(updateId);
        throw new UpdateClaimConflictError(updateId);
      }
      advanceTelegramCursor(this.db);
    });
    complete();
    this.claimedUpdates.delete(updateId);
  }

  public failTelegramUpdate(updateId: number, error: string, now: number): void {
    assertSafeFailureSummary(error);
    assertNoRawMergeCallback(error, "Telegram update error");
    const claimGeneration = this.claimedUpdates.get(updateId);
    if (claimGeneration === undefined) throw new UpdateClaimConflictError(updateId);

    const fail = this.db.transaction(() => {
      const failed = this.db
        .prepare(
          `UPDATE telegram_updates
              SET status = 'failed', outcome = NULL, last_error = ?, processed_at = ?,
                  claim_owner = NULL, claim_expires_at = NULL
            WHERE update_id = ?
              AND status = 'processing'
              AND claim_owner = ?
              AND claim_generation = ?
              AND claim_expires_at > ?`,
        )
        .run(error, now, updateId, this.claimOwner, claimGeneration, now);
      if (failed.changes !== 1) {
        this.claimedUpdates.delete(updateId);
        throw new UpdateClaimConflictError(updateId);
      }
    });
    fail();
    this.claimedUpdates.delete(updateId);
  }

  // A durably failed update pins the cursor, so an update that cannot ever be
  // handled must be retired: the failure stays readable, but polling moves on.
  public abandonTelegramUpdate(updateId: number, error: string, now: number): void {
    assertSafeFailureSummary(error);
    assertNoRawMergeCallback(error, "Telegram update error");
    const claimGeneration = this.claimedUpdates.get(updateId);
    if (claimGeneration === undefined) throw new UpdateClaimConflictError(updateId);

    const abandon = this.db.transaction(() => {
      const abandoned = this.db
        .prepare(
          `UPDATE telegram_updates
              SET status = 'processed', outcome = 'abandoned', last_error = ?, processed_at = ?,
                  claim_owner = NULL, claim_expires_at = NULL
            WHERE update_id = ?
              AND status = 'processing'
              AND claim_owner = ?
              AND claim_generation = ?
              AND claim_expires_at > ?`,
        )
        .run(error, now, updateId, this.claimOwner, claimGeneration, now);
      if (abandoned.changes !== 1) {
        this.claimedUpdates.delete(updateId);
        throw new UpdateClaimConflictError(updateId);
      }
      advanceTelegramCursor(this.db);
    });
    abandon();
    this.claimedUpdates.delete(updateId);
  }

  public getTelegramUpdateAttempts(updateId: number): number {
    if (!Number.isInteger(updateId) || updateId < 0) throw new TypeError("updateId must be a non-negative integer");
    const row = this.db
      .prepare("SELECT attempts FROM telegram_updates WHERE update_id = ?")
      .get(updateId) as { attempts: number } | undefined;
    return row?.attempts ?? 0;
  }

  // Recovers a cursor left pinned by an update that failed under an earlier
  // build, so polling stops replaying a backlog it has already handled.
  public reconcileTelegramCursor(): void {
    this.db.transaction(() => advanceTelegramCursor(this.db)).immediate();
  }

  public getNextTelegramOffset(): number {
    const row = this.db
      .prepare("SELECT next_offset FROM telegram_cursor WHERE singleton = 1")
      .get() as { next_offset: number } | undefined;
    if (!row) throw new Error("Telegram cursor was not initialized");
    return row.next_offset;
  }

  public recordCallback(
    callbackId: string,
    jobId: string | null,
    action: string,
    outcome: string,
    now: number,
    completion?: MergeCallbackIdentity,
  ): boolean {
    if (!callbackId || !action || !outcome) throw new TypeError("Callback identity and outcome are required");
    assertNonNegativeInteger(now, "now");
    assertNoRawMergeCallback(callbackId, "callbackId");
    if (jobId !== null) assertNoRawMergeCallback(jobId, "callback job id");
    assertNoRawMergeCallback(action, "callback action");
    assertNoRawMergeCallback(outcome, "callback outcome");
    return this.insertCallback(callbackId, jobId, action, outcome, now, completion);
  }

  public getCallback(callbackId: string): CallbackRecord | null {
    if (!callbackId) throw new TypeError("callbackId must not be empty");
    const row = this.db
      .prepare(
        `SELECT callback_query_id, job_id, action, outcome, processed_at,
                approval_nonce_hash, head_sha, effect_idempotency_key
           FROM callbacks WHERE callback_query_id = ?`,
      )
      .get(callbackId) as CallbackRow | undefined;
    if (!row) return null;
    const callback: CallbackRecord = {
      callbackId: row.callback_query_id,
      jobId: row.job_id,
      action: row.action,
      outcome: row.outcome,
      processedAt: row.processed_at,
      approvalNonceHash: row.approval_nonce_hash,
      headSha: row.head_sha,
      effectIdempotencyKey: row.effect_idempotency_key,
    };
    if (
      callback.action !== "merge" ||
      callback.outcome !== "accepted" ||
      callback.approvalNonceHash !== null ||
      callback.headSha !== null ||
      callback.effectIdempotencyKey !== null ||
      callback.jobId === null
    ) return callback;
    try {
      const identity = this.findUniqueLegacyAcceptedCallbackIdentity(callback.jobId);
      return identity ? { ...callback, ...identity } : callback;
    } catch {
      return callback;
    }
  }

  public enqueueReconcileForThread(threadId: string, now: number): boolean {
    if (!threadId) throw new TypeError("threadId must not be empty");
    const enqueue = this.db.transaction((): boolean => {
      const job = this.db
        .prepare(`${JOB_SELECT} WHERE implementation_thread_id = ? OR review_thread_id = ?
          OR id IN (SELECT job_id FROM pipeline_stage_attempts WHERE thread_id = ?)
          ORDER BY updated_at DESC LIMIT 1`)
        .get(threadId, threadId, threadId) as JobRow | undefined;
      if (!job) return false;
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO effects (
             idempotency_key, job_id, kind, payload_json, status, attempts,
             next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, 'reconcile_job', ?, 'pending', 0, ?, ?, ?)`,
        )
        .run(
          `reconcile:${job.id}:${threadId}`,
          job.id,
          serializeBoundedJson({ threadId }, "reconcile effect payload", MAX_MERGE_RESULT_JSON),
          now,
          now,
          now,
        );
      return result.changes === 1;
    });
    return enqueue();
  }

  private assertLeaseInput(ownerId: string, now: number, leaseMs: number): void {
    if (!ownerId) throw new TypeError("ownerId must not be empty");
    assertNonNegativeInteger(now, "now");
    if (!Number.isInteger(leaseMs) || leaseMs < 1) throw new TypeError("leaseMs must be a positive integer");
  }

  private assertControllerMutation(input: ControllerLeaseFence & { turnId: string }): void {
    assertControllerIdentifier(input.turnId, "turnId");
    if (!input.ownerId) throw new TypeError("ownerId must not be empty");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
  }

  private assertLeaseIdentity(key: string, ownerId: string, generation: number, now: number): void {
    if (!key) throw new TypeError("lease key must not be empty");
    if (!ownerId) throw new TypeError("ownerId must not be empty");
    assertPositiveInteger(generation, "generation");
    assertNonNegativeInteger(now, "now");
  }

  private executorLeaseRow(): {
    owner_id: string | null;
    generation: number;
    heartbeat_at: number | null;
    lease_expires_at: number | null;
  } {
    const row = this.db
      .prepare("SELECT owner_id, generation, heartbeat_at, lease_expires_at FROM executor_lease WHERE singleton = 1")
      .get() as {
        owner_id: string | null;
        generation: number;
        heartbeat_at: number | null;
        lease_expires_at: number | null;
      } | undefined;
    if (!row) throw new Error("Executor lease was not initialized");
    return row;
  }

  private executorLeaseIsCurrent(ownerId: string, generation: number, now: number): boolean {
    const row = this.executorLeaseRow();
    return row.owner_id === ownerId && row.generation === generation &&
      row.lease_expires_at !== null && row.lease_expires_at > now;
  }

  private effectByKey(key: string): EffectRow | undefined {
    return this.db.prepare("SELECT * FROM effects WHERE idempotency_key = ?").get(key) as EffectRow | undefined;
  }

  private outboxByKey(key: string): OutboxRow | undefined {
    return this.db.prepare("SELECT * FROM outbox WHERE logical_key = ?").get(key) as OutboxRow | undefined;
  }

  private effectLeaseIsActiveForRow(
    effect: EffectRow,
    ownerId: string,
    generation: number,
    now: number,
  ): boolean {
    return effect.status === "leased" && effect.lease_owner === ownerId &&
      effect.lease_generation === generation && effect.lease_expires_at !== null && effect.lease_expires_at > now &&
      this.executorLeaseIsCurrent(ownerId, generation, now);
  }

  private outboxLeaseIsActiveForRow(
    outbox: OutboxRow,
    ownerId: string,
    generation: number,
    now: number,
  ): boolean {
    return outbox.status === "leased" && outbox.lease_owner === ownerId &&
      outbox.lease_generation === generation && outbox.lease_expires_at !== null && outbox.lease_expires_at > now &&
      this.executorLeaseIsCurrent(ownerId, generation, now);
  }

  private markJobPermanentFailure(jobId: string, error: string, now: number): void {
    const job = this.readJobById(jobId);
    if (!job || ["merged", "cancelled", "blocked", "complete", "production_failed"].includes(job.state)) return;
    const isProductionIncident = job.mergeCommitSha !== null &&
      (job.state === "deploying" || job.state === "verifying_production");
    const changed = this.db
      .prepare(
        `UPDATE jobs SET state = ?, resume_state = ?, blocked_reason = ?,
           last_error = ?, version = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
      )
      .run(
        isProductionIncident ? "production_failed" : "blocked",
        isProductionIncident ? null : job.state,
        isProductionIncident ? null : "permanent_effect_failure",
        error,
        job.version + 1,
        now,
        job.id,
        job.version,
      );
    if (changed.changes === 1) {
      this.db
        .prepare(
          `UPDATE approvals SET consumed_at = COALESCE(consumed_at, ?), outcome = 'revoked'
             WHERE job_id = ? AND consumed_at IS NULL`,
        )
        .run(now, job.id);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO effects (
             idempotency_key, job_id, kind, payload_json, status, attempts,
             next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, 'render_status', '{}', 'pending', 0, ?, ?, ?)`,
        )
        .run(`${job.id}:${job.version + 1}:render_status`, job.id, now, now, now);
    }
  }

  private markJobPermanentFailureFromOutbox(key: string, error: string, now: number): void {
    const match = /^job:([^:]+):status$/.exec(key);
    if (match) this.markJobPermanentFailure(match[1], error, now);
  }

  private readJobById(jobId: string): Job | null {
    const row = this.db
      .prepare(`${JOB_SELECT} WHERE id = ?`)
      .get(jobId) as JobRow | undefined;
    return row ? parseJob(row) : null;
  }

  private readApproval(nonceHash: string): ApprovalRow | undefined {
    return this.db
      .prepare(
        `SELECT nonce_hash, job_id, head_sha, expires_at, consumed_at, outcome,
                owner_user_id, owner_chat_id, job_version
           FROM approvals WHERE nonce_hash = ?`,
      )
      .get(nonceHash) as ApprovalRow | undefined;
  }

  private readEffect(jobId: string, idempotencyKey: string): EffectRow | undefined {
    return this.db
      .prepare("SELECT * FROM effects WHERE job_id = ? AND idempotency_key = ?")
      .get(jobId, idempotencyKey) as EffectRow | undefined;
  }

  private findUniqueLegacyAcceptedCallbackIdentity(jobId: string): MergeCallbackIdentity | null {
    const rows = this.db
      .prepare("SELECT * FROM effects WHERE job_id = ? AND kind = 'merge_pr'")
      .all(jobId) as EffectRow[];
    let candidate: MergeCallbackIdentity | null = null;
    const job = this.readJobById(jobId);
    if (!job) return null;
    const owner = this.getOwner();
    for (const row of rows) {
      let evidence: PersistedMergeEvidence;
      try {
        evidence = parsePersistedMergeEvidence({
          idempotencyKey: row.idempotency_key,
          jobId: row.job_id,
          kind: row.kind,
          status: row.status,
          payload: JSON.parse(row.payload_json),
        });
      } catch {
        return null;
      }
      if (!isReplayableMergeEvidence(evidence)) continue;
      const receipt = evidence.payload.receipt;
      const approval = this.readApproval(receipt.approvalNonceHash);
      const bindingError = mergeEvidenceBindingError(
        evidence,
        job,
        this.getApproval(receipt.approvalNonceHash),
        this.getAttempt(receipt.reviewAttemptId),
      );
      if (bindingError !== null) return null;
      if (evidence.disposition === "success") {
        if (
          !mergeSuccessResultMatchesDurable(evidence.result, row, evidence.payload, job, approval, "post_merge") ||
          !this.attemptResultMatches(receipt.reviewAttemptId, jobId, receipt.headSha, evidence.result) ||
          owner === null ||
          owner.userId !== receipt.approvalOwnerUserId ||
          owner.chatId !== receipt.approvalOwnerChatId
        ) return null;
      } else if (this.acceptedMergeReceiptBindingError(row, evidence.payload, job, approval) !== null) {
        return null;
      }
      const identity = {
        approvalNonceHash: receipt.approvalNonceHash,
        headSha: receipt.headSha,
        effectIdempotencyKey: row.idempotency_key,
      };
      if (candidate !== null) return null;
      candidate = identity;
    }
    return candidate;
  }

  private findAcceptedMergeCallbackIdentity(
    jobId: string,
    headSha: string,
    approvalNonceHash: string,
  ): MergeCallbackIdentity | null {
    const rows = this.db
      .prepare("SELECT * FROM effects WHERE job_id = ? AND kind = 'merge_pr'")
      .all(jobId) as EffectRow[];
    let candidate: MergeCallbackIdentity | null = null;
    const job = this.readJobById(jobId);
    if (!job) return null;
    const owner = this.getOwner();
    for (const row of rows) {
      let evidence: PersistedMergeEvidence;
      try {
        evidence = parsePersistedMergeEvidence({
          idempotencyKey: row.idempotency_key,
          jobId: row.job_id,
          kind: row.kind,
          status: row.status,
          payload: JSON.parse(row.payload_json),
        });
      } catch {
        return null;
      }
      if (!isReplayableMergeEvidence(evidence)) continue;
      const receipt = evidence.payload.receipt;
      const approval = this.readApproval(receipt.approvalNonceHash);
      const bindingError = mergeEvidenceBindingError(
        evidence,
        job,
        this.getApproval(receipt.approvalNonceHash),
        this.getAttempt(receipt.reviewAttemptId),
      );
      if (bindingError !== null) return null;
      if (receipt.headSha !== headSha || receipt.approvalNonceHash !== approvalNonceHash) continue;
      if (evidence.disposition === "success") {
        if (
          !mergeSuccessResultMatchesDurable(
            evidence.result,
            row,
            evidence.payload,
            job,
            approval,
            "post_merge",
          ) || !this.attemptResultMatches(receipt.reviewAttemptId, jobId, receipt.headSha, evidence.result) ||
          owner === null ||
          owner.userId !== receipt.approvalOwnerUserId ||
          owner.chatId !== receipt.approvalOwnerChatId
        ) return null;
      } else if (this.acceptedMergeReceiptBindingError(row, evidence.payload, job, approval) !== null) {
        return null;
      }
      const identity = {
        approvalNonceHash,
        headSha,
        effectIdempotencyKey: row.idempotency_key,
      };
      if (candidate !== null) return null;
      candidate = identity;
    }
    return candidate;
  }

  private attemptResultMatches(
    attemptId: string,
    jobId: string,
    headSha: string,
    result: PersistedMergeSuccessResult,
  ): boolean {
    const attempt = this.getAttempt(attemptId);
    if (
      !attempt ||
      attempt.jobId !== jobId ||
      attempt.kind !== "review" ||
      attempt.headSha !== headSha ||
      attempt.completedAt === null ||
      attempt.resultJson === null
    ) return false;
    try {
      const stored = parsePersistedMergeSuccessResult(JSON.parse(attempt.resultJson));
      return JSON.stringify(stored) === JSON.stringify(result);
    } catch {
      return false;
    }
  }

  private approvalIsCurrent(
    row: ApprovalRow,
    identity: ApprovalIdentity | undefined,
  ): boolean {
    const job = this.readJobById(row.job_id);
    if (!job || job.state !== "awaiting_merge_approval" || job.cancelRequestedAt !== null) return false;
    if (job.prHeadSha !== row.head_sha) return false;
    if (row.job_version !== null && job.version !== row.job_version) return false;

    const owner = this.getOwner();
    const expectedUserId = row.owner_user_id ?? identity?.userId ?? null;
    const expectedChatId = row.owner_chat_id ?? identity?.chatId ?? null;
    if (row.owner_user_id === null && row.owner_chat_id === null && identity === undefined) return true;
    if (!owner || expectedUserId === null || expectedChatId === null) return false;
    if (owner.userId !== expectedUserId || owner.chatId !== expectedChatId) return false;
    if (identity && (identity.userId !== expectedUserId || identity.chatId !== expectedChatId)) return false;
    return true;
  }

  private effectLeaseMatches(
    effect: EffectRow,
    leaseOwner: string,
    leaseGeneration: number,
  ): boolean {
    return effect.status === "leased" &&
      effect.lease_owner === leaseOwner &&
      effect.lease_generation === leaseGeneration;
  }

  private effectLeaseIsActive(
    effect: EffectRow,
    leaseOwner: string,
    leaseGeneration: number,
    now: number,
  ): boolean {
    return this.effectLeaseMatches(effect, leaseOwner, leaseGeneration) &&
      effect.lease_expires_at !== null && effect.lease_expires_at > now;
  }

  private mergeReceiptBindingError(
    effect: EffectRow,
    payload: MergeEffectPayload,
    job: Job,
    approval: ApprovalRow | undefined,
    now: number,
  ): string | null {
    const identityError = this.mergeReceiptIdentityError(effect, payload, job, approval);
    if (identityError) return identityError;
    if (!approval) return "durable merge receipt approval binding is missing";
    const receipt = payload.receipt;
    if (now >= approval.expires_at || now >= Date.parse(receipt.expiresAt)) {
      return "durable merge approval has expired";
    }
    return null;
  }

  private acceptedMergeReceiptBindingError(
    effect: EffectRow,
    payload: MergeEffectPayload,
    job: Job,
    approval: ApprovalRow | undefined,
  ): string | null {
    return this.mergeReceiptIdentityError(effect, payload, job, approval);
  }

  private mergeReceiptIdentityError(
    effect: EffectRow,
    payload: MergeEffectPayload,
    job: Job,
    approval: ApprovalRow | undefined,
  ): string | null {
    const receipt = payload.receipt;
    if (effect.job_id !== job.id || receipt.jobId !== job.id || receipt.effectIdempotencyKey !== effect.idempotency_key) {
      return "durable merge receipt identity does not match its effect";
    }
    if (payload.headSha !== receipt.headSha || job.prHeadSha !== receipt.headSha) {
      return "durable merge receipt head does not match the job";
    }
    if (job.state !== "merging" || job.cancelRequestedAt !== null) {
      return "job is no longer an uncancelled merging job";
    }
    if (job.version !== receipt.jobVersion || receipt.jobVersion !== receipt.approvalJobVersion + 1) {
      return "durable merge receipt job version is stale";
    }
    if (
      job.projectId !== receipt.projectId ||
      job.environmentId !== receipt.environmentId ||
      job.prNumber !== receipt.prNumber ||
      job.policy === null ||
      job.policy.baseBranch !== receipt.baseBranch ||
      job.policy.mergeMethod !== receipt.mergeMethod ||
      JSON.stringify([...job.policy.requiredChecks].sort()) !== JSON.stringify(receipt.requiredCheckNames)
    ) {
      return "durable merge receipt does not match the immutable job policy";
    }
    if (!approval || approval.job_id !== job.id || approval.head_sha !== receipt.headSha) {
      return "durable merge receipt approval binding is missing";
    }
    if (approval.consumed_at === null || approval.outcome !== "accepted") {
      return "durable merge approval is not accepted";
    }
    if (
      approval.job_version !== receipt.approvalJobVersion ||
      approval.owner_user_id !== receipt.approvalOwnerUserId ||
      approval.owner_chat_id !== receipt.approvalOwnerChatId ||
      approval.expires_at !== Date.parse(receipt.expiresAt)
    ) {
      return "durable merge receipt does not match the approval row";
    }
    const owner = this.getOwner();
    if (!owner || owner.userId !== receipt.approvalOwnerUserId || owner.chatId !== receipt.approvalOwnerChatId) {
      return "paired Telegram owner changed";
    }
    return null;
  }

  private approvalReceiptBindingError(
    effect: JobEffect,
    payload: MergeEffectPayload,
    generatedKey: string,
    job: Job,
    approval: ApprovalRow,
    nonceHash: string,
    now: number,
  ): string | null {
    const receipt = payload.receipt;
    const owner = this.getOwner();
    if (effect.jobId !== job.id || receipt.jobId !== job.id || receipt.effectIdempotencyKey !== generatedKey) {
      return "merge effect identity is not the exact generated identity";
    }
    if (payload.headSha !== receipt.headSha || receipt.headSha !== approval.head_sha || receipt.headSha !== job.prHeadSha) {
      return "merge effect head is not bound to the approval and job";
    }
    if (
      receipt.approvalNonceHash !== nonceHash ||
      approval.job_id !== job.id ||
      approval.consumed_at !== null ||
      approval.outcome !== null ||
      approval.job_version !== job.version ||
      approval.owner_user_id !== receipt.approvalOwnerUserId ||
      approval.owner_chat_id !== receipt.approvalOwnerChatId ||
      !owner ||
      owner.userId !== receipt.approvalOwnerUserId ||
      owner.chatId !== receipt.approvalOwnerChatId
    ) {
      return "merge effect approval binding does not match durable state";
    }
    if (
      receipt.jobVersion !== job.version + 1 ||
      receipt.approvalJobVersion !== job.version ||
      job.projectId !== receipt.projectId ||
      job.environmentId !== receipt.environmentId ||
      job.prNumber !== receipt.prNumber ||
      job.policy === null ||
      job.policy.baseBranch !== receipt.baseBranch ||
      job.policy.mergeMethod !== receipt.mergeMethod ||
      JSON.stringify([...job.policy.requiredChecks].sort()) !== JSON.stringify(receipt.requiredCheckNames)
    ) {
      return "merge effect receipt does not match the durable job policy or version";
    }
    if (approval.expires_at !== Date.parse(receipt.expiresAt) || now >= approval.expires_at) {
      return "merge effect receipt expiry does not match the approval boundary";
    }
    return null;
  }

  private insertCallback(
    callbackId: string,
    jobId: string | null,
    action: string,
    outcome: string,
    now: number,
    completion?: MergeCallbackIdentity,
  ): boolean {
    assertNonNegativeInteger(now, "now");
    assertNoRawMergeCallback(callbackId, "callbackId");
    if (jobId !== null) assertNoRawMergeCallback(jobId, "callback job id");
    assertNoRawMergeCallback(action, "callback action");
    assertNoRawMergeCallback(outcome, "callback outcome");
    if (completion) {
      if (action !== "merge" || outcome !== "accepted") {
        throw new TypeError("callback completion identity is only valid for accepted merge callbacks");
      }
      assertSha256Hex(completion.approvalNonceHash);
      assertFullSha(completion.headSha, "callback headSha");
      if (!completion.effectIdempotencyKey || completion.effectIdempotencyKey.length > MAX_EFFECT_KEY) {
        throw new TypeError("callback effect idempotency key is invalid");
      }
      assertNoRawMergeCallback(completion.effectIdempotencyKey, "callback effect idempotency key");
    } else if (action === "merge" && outcome === "accepted") {
      throw new TypeError("accepted merge callback identity is required");
    }
    const callbackNow = this.currentNow();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO callbacks (
           callback_query_id, job_id, action, outcome, processed_at,
           approval_nonce_hash, head_sha, effect_idempotency_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        callbackId,
        jobId,
        action,
        outcome,
        callbackNow,
        completion?.approvalNonceHash ?? null,
        completion?.headSha ?? null,
        completion?.effectIdempotencyKey ?? null,
      );
    return result.changes === 1;
  }

  private readJobBySourceUpdate(sourceUpdateId: number): Job | null {
    const row = this.db
      .prepare(`${JOB_SELECT} WHERE source_update_id = ?`)
      .get(sourceUpdateId) as JobRow | undefined;
    return row ? parseJob(row) : null;
  }

  private hasActiveJobExcluding(jobId: string): boolean {
    return this.db
      .prepare(
        "SELECT 1 FROM jobs WHERE id <> ? AND state NOT IN ('merged', 'cancelled', 'blocked', 'complete', 'production_failed') LIMIT 1",
      )
      .get(jobId) !== undefined;
  }
}

export function openStore(
  storage: PluginStorage,
  kv: PluginKv = storage.kv,
  now: () => number = () => Date.now(),
): TelegramAgentStore {
  const db = storage.database();
  storage.migrate(db, [...ALL_MIGRATIONS]);
  ensureTask9ApprovalColumns(db);
  return new SqliteTelegramAgentStore(db, kv, now);
}
