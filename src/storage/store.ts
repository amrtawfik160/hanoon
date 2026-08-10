import type { BbPluginApi } from "@bb/plugin-sdk";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  projectPolicySchema,
  type Job,
  type JobEffect,
  type JobEvent,
  type JobState,
  type ProjectPolicy,
  type StoredEffect,
} from "../domain/models";
import { assertSafeFailureSummary, transition } from "../domain/state-machine";
import { ALL_MIGRATIONS } from "./migrations";

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

export type OutboxInput = {
  logicalKey: string;
  chatId: string;
  messageId?: number | null;
  payload: Record<string, unknown>;
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

export type MergeEffectPayload = {
  headSha: string;
  receipt: DurableMergeReceipt;
  mergeCallStartedAt?: number;
  mergeCallOutcome?: "unknown";
  mergeOutcome?: "stale";
};

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
  pr_number: number | null;
  pr_url: string | null;
  pr_head_sha: string | null;
  status_message_id: number | null;
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
type TelegramUpdateRow = {
  status: "processing" | "processed" | "failed";
  claim_owner: string | null;
  claim_generation: number | null;
  claim_expires_at: number | null;
};

const JOB_STATES: ReadonlySet<JobState> = new Set([
  "awaiting_project",
  "awaiting_confirmation",
  "creating_implementation",
  "implementing",
  "locating_pr",
  "resolving_pr_head",
  "reviewing",
  "remediating",
  "validating",
  "awaiting_merge_approval",
  "merging",
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
const RAW_MERGE_CALLBACK = /(?:^|[^A-Za-z0-9_-])m:[A-Za-z0-9_-]{32}(?:$|[^A-Za-z0-9_-])/;
const TELEGRAM_UPDATE_LEASE_MS = 300_000;
const MAX_RECEIPT_STRING = 512;
const MAX_EFFECT_KEY = 256;
const MAX_MERGE_RESULT_JSON = 64_000;

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

function assertNoRawMergeCallback(value: string, field: string): void {
  if (RAW_MERGE_CALLBACK.test(value)) throw new TypeError(`${field} must not contain a raw merge callback nonce`);
}

function serializeBoundedJson(value: unknown, field: string, maxLength: number): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new TypeError(`${field} must be JSON serializable`);
  }
  if (json === undefined || json.length > maxLength) throw new TypeError(`${field} must be bounded JSON`);
  assertNoRawMergeCallback(json, field);
  return json;
}

function serializeBoundedMergeResult(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("merge result must be a JSON object");
  }
  return serializeBoundedJson(value, "merge result", MAX_MERGE_RESULT_JSON);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new TypeError(`${field} contains an unexpected field`);
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
  serializeBoundedMergeResult(mergeResult);
  return parseMergeEffectPayload(activePayload);
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
  leaseMergeEffect(input: {
    jobId: string;
    effectIdempotencyKey: string;
    leaseOwner: string;
    leaseGeneration: number;
    now: number;
    leaseDurationMs: number;
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
  getNextTelegramOffset(): number;
  recordCallback(callbackId: string, jobId: string | null, action: string, outcome: string, now: number): boolean;
  getCallback(callbackId: string): CallbackRecord | null;
  completeMergeSuccess(input: MergeSuccessInput): boolean;
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
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    prHeadSha: row.pr_head_sha,
    statusMessageId: row.status_message_id,
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

function persistJobTransition(
  db: SqliteDatabase,
  jobId: string,
  expectedVersion: number,
  transitionedJob: Job,
): void {
  if (transitionedJob.lastError !== null) assertNoRawMergeCallback(transitionedJob.lastError, "job error");
  const updated = db
    .prepare(
      `UPDATE jobs SET
         request_text = ?, state = ?, resume_state = ?, project_id = ?,
         policy_version = ?, policy_json = ?, environment_id = ?,
         implementation_thread_id = ?, review_thread_id = ?, pr_number = ?,
         pr_url = ?, pr_head_sha = ?, status_message_id = ?, review_cycle = ?,
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
      transitionedJob.prNumber,
      transitionedJob.prUrl,
      transitionedJob.prHeadSha,
      transitionedJob.statusMessageId,
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
    const payloadJson = JSON.stringify(effect.payload);
    if (payloadJson === undefined) throw new TypeError("effect payload must be JSON serializable");
    assertNoRawMergeCallback(payloadJson, "effect payload");
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
         review_thread_id, pr_number, pr_url, pr_head_sha, status_message_id,
         review_cycle, review_block_at, cancel_requested_at, blocked_reason,
         last_error, version, created_at, updated_at
    FROM jobs`;

function serializeOutbox(item: OutboxInput, now: number): string {
  if (!item.logicalKey || !item.chatId) throw new TypeError("outbox identity is required");
  if (!Number.isInteger(now) || now < 0) throw new TypeError("now must be a non-negative integer");
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(item.payload);
  } catch {
    throw new TypeError("outbox payload must be JSON serializable");
  }
  if (payloadJson === undefined) throw new TypeError("outbox payload must be JSON serializable");
  assertNoRawMergeCallback(payloadJson, "outbox payload");
  if (
    item.messageId !== undefined &&
    item.messageId !== null &&
    (!Number.isInteger(item.messageId) || item.messageId < 1)
  ) {
    throw new TypeError("outbox messageId must be a positive integer");
  }
  return payloadJson;
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
         message_id = excluded.message_id,
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

function advanceTelegramCursor(db: SqliteDatabase): void {
  const cursor = db
    .prepare("SELECT next_offset FROM telegram_cursor WHERE singleton = 1")
    .get() as { next_offset: number } | undefined;
  if (!cursor) throw new Error("Telegram cursor was not initialized");

  const firstUnprocessed = db
    .prepare(
      "SELECT MIN(update_id) AS update_id FROM telegram_updates WHERE update_id >= ? AND status <> 'processed'",
    )
    .get(cursor.next_offset) as { update_id: number | null };
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
  ) {}

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
    const result = this.db
      .prepare(
        "UPDATE owners SET revoked_at = ? WHERE singleton = 1 AND revoked_at IS NULL",
      )
      .run(now);
    return result.changes === 1;
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
          "SELECT 1 FROM jobs WHERE state NOT IN ('merged', 'cancelled', 'blocked') LIMIT 1",
        )
        .get() !== undefined
    );
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
      if (!job || job.implementationThreadId !== threadId || ["merged", "cancelled", "blocked"].includes(job.state)) {
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
      .prepare(`${JOB_SELECT} WHERE state NOT IN ('merged', 'cancelled', 'blocked') ORDER BY updated_at DESC, id DESC LIMIT 1`)
      .get() as JobRow | undefined;
    return row ? parseJob(row) : null;
  }

  public findJobByThreadId(threadId: string): Job | null {
    const row = this.db
      .prepare(`${JOB_SELECT} WHERE implementation_thread_id = ? OR review_thread_id = ? ORDER BY updated_at DESC LIMIT 1`)
      .get(threadId, threadId) as JobRow | undefined;
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
      const row = this.readEffect(input.jobId, input.effectIdempotencyKey);
      if (!row) return { ok: false, reason: "durable merge effect was not found" };
      if (row.kind !== "merge_pr") return { ok: false, reason: "durable effect is not merge_pr" };
      if (
        row.status !== "leased" ||
        row.lease_owner !== input.leaseOwner ||
        row.lease_generation !== input.leaseGeneration ||
        row.lease_expires_at === null ||
        row.lease_expires_at <= input.now
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
      const bindingError = this.mergeReceiptBindingError(row, payload, job, approval, input.now);
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
        mergeCallStartedAt: input.now,
        mergeCallOutcome: "unknown",
      };
      const payloadJson = JSON.stringify(markedPayload);
      assertNoRawMergeCallback(payloadJson, "merge effect payload");
      const marked = this.db
        .prepare(
          `UPDATE effects SET payload_json = ?, updated_at = ?
             WHERE job_id = ? AND idempotency_key = ? AND status = 'leased'
               AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?`,
        )
        .run(
          payloadJson,
          input.now,
          input.jobId,
          input.effectIdempotencyKey,
          input.leaseOwner,
          input.leaseGeneration,
          input.now,
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
    const reject = this.db.transaction((): ApprovalRejectionResult => {
      const previous = this.db
        .prepare("SELECT outcome FROM callbacks WHERE callback_query_id = ?")
        .get(input.callbackId) as { outcome: string } | undefined;
      if (previous) {
        return { outcome: previous.outcome === "accepted" ? "accepted" : "rejected", callbackRecorded: false };
      }

      const approval = this.readApproval(input.nonceHash);
      if (approval?.outcome === "accepted" && approval.consumed_at !== null && this.hasMergeEffect(approval.job_id, approval.head_sha)) {
        const recorded = this.insertCallback(input.callbackId, approval.job_id, "merge", "accepted", input.now);
        return { outcome: "accepted", callbackRecorded: recorded };
      }

      const jobId = input.jobId ?? approval?.job_id ?? null;
      if (approval?.consumed_at === null) {
        this.db
          .prepare(
            `UPDATE approvals SET consumed_at = ?, outcome = 'revoked'
               WHERE nonce_hash = ? AND consumed_at IS NULL`,
          )
          .run(input.now, input.nonceHash);
        const job = approval ? this.readJobById(approval.job_id) : null;
        if (job?.state === "awaiting_merge_approval") {
          const transitioned = transition(job, {
            type: "APPROVAL_STALE",
            ...(input.headSha === undefined ? {} : { headSha: input.headSha }),
          }, input.now);
          persistJobTransition(this.db, job.id, job.version, transitioned.job);
          persistPendingEffects(this.db, transitioned.effects, input.now);
        }
      } else if (approval?.outcome === "accepted") {
        this.db
          .prepare("UPDATE approvals SET outcome = 'revoked' WHERE nonce_hash = ?")
          .run(input.nonceHash);
      }

      const recorded = this.insertCallback(input.callbackId, jobId, "merge", "rejected", input.now);
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
      const row = this.readApproval(nonceHash);
      if (!row || row.consumed_at !== null || now >= row.expires_at) return null;
      if (!this.approvalIsCurrent(row, undefined)) {
        this.db
          .prepare(
            `UPDATE approvals SET consumed_at = ?, outcome = 'revoked'
               WHERE nonce_hash = ? AND consumed_at IS NULL`,
          )
          .run(now, nonceHash);
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
      const row = this.readApproval(input.nonceHash);
      if (!row) return { ok: false, reason: "missing" };
      if (row.consumed_at !== null) {
        return row.outcome !== null && row.outcome !== "consumed" && row.outcome !== "accepted"
          ? { ok: false, reason: "revoked" }
          : { ok: false, reason: "consumed" };
      }
      if (input.now >= row.expires_at) return { ok: false, reason: "expired" };
      if (!this.approvalIsCurrent(row, input.identity)) {
        this.db
          .prepare(
            `UPDATE approvals SET consumed_at = ?, outcome = 'revoked'
               WHERE nonce_hash = ? AND consumed_at IS NULL`,
          )
          .run(input.now, input.nonceHash);
        return { ok: false, reason: "revoked" };
      }

      const updated = this.db
        .prepare(
          `UPDATE approvals
              SET consumed_at = ?, outcome = 'consumed'
            WHERE nonce_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
        )
        .run(input.now, input.nonceHash, input.now);
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
      const row = this.readApproval(input.nonceHash);
      if (!row) return { ok: false, reason: "missing" };
      if (row.consumed_at !== null) {
        if (row.outcome === "accepted") {
          const current = this.readJobById(row.job_id);
          const expectedKey = `${row.job_id}:${(row.job_version ?? input.expectedJobVersion) + 1}:merge_pr`;
          const existing = this.readEffect(row.job_id, expectedKey);
          if (!current || !existing) throw new Error("accepted approval is missing its durable merge effect");
          let payload: MergeEffectPayload;
          try {
            payload = parseMergeEffectPayload(JSON.parse(existing.payload_json));
          } catch (error) {
            throw new Error(error instanceof Error ? `accepted merge effect is invalid: ${error.message}` : "accepted merge effect is invalid");
          }
          let suppliedPayload: MergeEffectPayload;
          try {
            suppliedPayload = parseMergeEffectPayload(input.effect.payload);
          } catch (error) {
            throw new Error(error instanceof Error ? `caller-supplied merge effect is invalid: ${error.message}` : "caller-supplied merge effect is invalid");
          }
          if (input.effect.idempotencyKey !== expectedKey || input.effect.jobId !== row.job_id) {
            throw new Error("accepted merge effect idempotency key does not match the generated key");
          }
          if (
            payload.receipt.approvalNonceHash !== input.nonceHash ||
            payload.receipt.headSha !== row.head_sha ||
            suppliedPayload.headSha !== payload.headSha ||
            JSON.stringify(suppliedPayload.receipt) !== JSON.stringify(payload.receipt)
          ) {
            throw new Error("accepted merge effect payload does not match the approval");
          }
          return { ok: true, jobId: row.job_id, headSha: row.head_sha };
        }
        return row.outcome !== null && row.outcome !== "consumed"
          ? { ok: false, reason: "revoked" }
          : { ok: false, reason: "consumed" };
      }
      if (input.now >= row.expires_at) return { ok: false, reason: "expired" };
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
          .run(input.now, input.nonceHash);
        return { ok: false, reason: "revoked" };
      }
      if (current.state !== "awaiting_merge_approval" || input.effect.jobId !== row.job_id) {
        return { ok: false, reason: "version_conflict" };
      }

      const transitioned = transition(
        current,
        { type: "APPROVAL_ACCEPTED", headSha: row.head_sha },
        input.now,
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
      let payload: MergeEffectPayload;
      try {
        payload = parseMergeEffectPayload(input.effect.payload);
      } catch (error) {
        throw new TypeError(error instanceof Error ? error.message : "invalid durable merge effect payload");
      }
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
        input.now,
      );
      if (receiptError) throw new TypeError(receiptError);

      const consumed = this.db
        .prepare(
          `UPDATE approvals
              SET consumed_at = ?, outcome = 'accepted'
            WHERE nonce_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
      )
        .run(input.now, input.nonceHash, input.now);
      if (consumed.changes !== 1) return { ok: false, reason: "consumed" };

      persistJobTransition(this.db, current.id, input.expectedJobVersion, transitioned.job);
      const effectPayloadJson = serializeBoundedJson(input.effect.payload, "merge effect payload", MAX_MERGE_RESULT_JSON);
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
          input.now,
          input.now,
          input.now,
        );
      if (inserted.changes !== 1) throw new Error("durable merge effect insertion did not insert exactly one row");
      const otherEffects = transitioned.effects.filter((effect) => effect.kind !== "merge_pr");
      persistPendingEffects(this.db, otherEffects, input.now);
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

  public completeMergeSuccess(input: MergeSuccessInput): boolean {
    assertSafeFailureSummary(input.message);
    assertNonNegativeInteger(input.now, "now");
    const resultJson = serializeBoundedMergeResult(input.result);
    const complete = this.db.transaction((): boolean => {
      const effect = this.readEffect(input.jobId, input.effectIdempotencyKey);
      if (!effect) return false;
      if (effect.status === "done") {
        if (input.outbox) persistOutbox(this.db, input.outbox, serializeOutbox(input.outbox, input.now), input.now);
        return true;
      }
      if (!this.effectLeaseIsActive(effect, input.leaseOwner, input.leaseGeneration, input.now)) return false;
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
        input.now,
      );
      if (bindingError) return false;
      if (storedPayload.mergeCallStartedAt === undefined || storedPayload.mergeCallOutcome !== "unknown") return false;

      const transitioned = transition(current, {
        type: "MERGE_SUCCEEDED",
        message: input.message,
      }, input.now);
      const payloadJson = JSON.stringify({
        ...storedPayload,
        mergeResult: JSON.parse(resultJson) as Record<string, unknown>,
      });
      if (payloadJson === undefined || payloadJson.length > MAX_MERGE_RESULT_JSON) {
        throw new TypeError("merge effect result must be bounded");
      }
      assertNoRawMergeCallback(payloadJson, "merge effect result");

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
          input.now,
          input.jobId,
          input.effectIdempotencyKey,
          input.leaseOwner,
          input.leaseGeneration,
          input.now,
        );
      if (updated.changes !== 1) throw new Error("Merge effect completion lost its durable row");
      if (input.outbox) persistOutbox(this.db, input.outbox, serializeOutbox(input.outbox, input.now), input.now);
      persistPendingEffects(this.db, transitioned.effects, input.now);
      return true;
    });
    return complete();
  }

  public failMergeEffect(input: MergeFailureInput): boolean {
    assertSafeFailureSummary(input.reason);
    assertNoRawMergeCallback(input.reason, "merge failure reason");
    assertNonNegativeInteger(input.now, "now");
    const fail = this.db.transaction((): boolean => {
      const effect = this.readEffect(input.jobId, input.effectIdempotencyKey);
      if (!effect || effect.status === "done") return false;
      if (!this.effectLeaseIsActive(effect, input.leaseOwner, input.leaseGeneration, input.now)) return false;
      const current = this.readJobById(input.jobId);
      const transitioned = current && current.state === "merging"
        ? current.cancelRequestedAt !== null
          ? transition(current, { type: "CANCEL_CONFIRMED" }, input.now)
          : transition(current, {
              type: "MERGE_FAILED",
              reason: input.reason,
            }, input.now)
        : null;
      this.db
        .prepare(
          `UPDATE approvals SET consumed_at = COALESCE(consumed_at, ?), outcome = 'revoked'
             WHERE job_id = ? AND (outcome IS NULL OR outcome = 'accepted')`,
        )
        .run(input.now, input.jobId);
      const updated = this.db
        .prepare(
          `UPDATE effects SET status = 'failed', lease_owner = NULL,
             lease_generation = NULL, lease_expires_at = NULL, last_error = ?,
           next_attempt_at = ?, updated_at = ?
           WHERE job_id = ? AND idempotency_key = ? AND status = 'leased'
             AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?`,
        )
        .run(
          input.reason,
          input.now,
          input.now,
          input.jobId,
          input.effectIdempotencyKey,
          input.leaseOwner,
          input.leaseGeneration,
          input.now,
      );
      if (updated.changes !== 1) throw new Error("Merge effect failure lost its durable row");
      if (transitioned) {
        persistJobTransition(this.db, input.jobId, current!.version, transitioned.job);
        persistPendingEffects(this.db, transitioned.effects, input.now);
      }
      return true;
    });
    return fail();
  }

  public staleMergeEffect(input: MergeStaleInput): boolean {
    assertSafeFailureSummary(input.reason);
    assertNoRawMergeCallback(input.reason, "merge stale reason");
    assertNonNegativeInteger(input.now, "now");
    const stale = this.db.transaction((): boolean => {
      const effect = this.readEffect(input.jobId, input.effectIdempotencyKey);
      if (!effect || effect.status === "done") return false;
      if (!this.effectLeaseIsActive(effect, input.leaseOwner, input.leaseGeneration, input.now)) return false;
      const current = this.readJobById(input.jobId);
      if (!current || current.state !== "merging") return false;
      if (current.prNumber === null) return false;
      let storedPayload: MergeEffectPayload;
      try {
        storedPayload = parseMergeEffectPayload(JSON.parse(effect.payload_json));
      } catch {
        return false;
      }
      if (this.mergeReceiptBindingError(
        effect,
        storedPayload,
        current,
        this.readApproval(storedPayload.receipt.approvalNonceHash),
        input.now,
      )) return false;

      const next = structuredClone(current);
      next.prHeadSha = null;
      next.state = "resolving_pr_head";
      next.lastError = input.reason;
      next.version += 1;
      next.updatedAt = input.now;
      persistJobTransition(this.db, input.jobId, current.version, next);
      this.db
        .prepare(
          `UPDATE approvals SET consumed_at = COALESCE(consumed_at, ?), outcome = 'revoked'
             WHERE job_id = ? AND (outcome IS NULL OR outcome = 'accepted')`,
        )
        .run(input.now, input.jobId);
      const resolveEffect: JobEffect = {
        idempotencyKey: `${input.jobId}:${next.version}:resolve_pr_head`,
        jobId: input.jobId,
        kind: "resolve_pr_head",
        payload: { number: current.prNumber, url: current.prUrl },
      };
      const renderEffect: JobEffect = {
        idempotencyKey: `${input.jobId}:${next.version}:render_status`,
        jobId: input.jobId,
        kind: "render_status",
        payload: {},
      };
      persistPendingEffects(this.db, [resolveEffect, renderEffect], input.now);
      const updated = this.db
        .prepare(
          `UPDATE effects SET payload_json = ?, status = 'done', lease_owner = NULL,
             lease_generation = NULL, lease_expires_at = NULL, last_error = ?,
             updated_at = ? WHERE job_id = ? AND idempotency_key = ?
               AND status = 'leased' AND lease_owner = ? AND lease_generation = ?
               AND lease_expires_at > ?`,
        )
        .run(
          JSON.stringify({
            ...parseMergeEffectPayload(JSON.parse(effect.payload_json)),
            mergeOutcome: "stale",
          }),
          input.reason,
          input.now,
          input.jobId,
          input.effectIdempotencyKey,
          input.leaseOwner,
          input.leaseGeneration,
          input.now,
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
  ): boolean {
    if (!callbackId || !action || !outcome) throw new TypeError("Callback identity and outcome are required");
    assertNoRawMergeCallback(callbackId, "callbackId");
    assertNoRawMergeCallback(action, "callback action");
    assertNoRawMergeCallback(outcome, "callback outcome");
    return this.insertCallback(callbackId, jobId, action, outcome, now);
  }

  public getCallback(callbackId: string): CallbackRecord | null {
    if (!callbackId) throw new TypeError("callbackId must not be empty");
    const row = this.db
      .prepare(
        `SELECT callback_query_id, job_id, action, outcome, processed_at
           FROM callbacks WHERE callback_query_id = ?`,
      )
      .get(callbackId) as CallbackRow | undefined;
    return row
      ? {
          callbackId: row.callback_query_id,
          jobId: row.job_id,
          action: row.action,
          outcome: row.outcome,
          processedAt: row.processed_at,
        }
      : null;
  }

  public enqueueReconcileForThread(threadId: string, now: number): boolean {
    if (!threadId) throw new TypeError("threadId must not be empty");
    const enqueue = this.db.transaction((): boolean => {
      const job = this.db
        .prepare(`${JOB_SELECT} WHERE implementation_thread_id = ? OR review_thread_id = ? ORDER BY updated_at DESC LIMIT 1`)
        .get(threadId, threadId) as JobRow | undefined;
      if (!job) return false;
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO effects (
             idempotency_key, job_id, kind, payload_json, status, attempts,
             next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, 'reconcile_job', ?, 'pending', 0, ?, ?, ?)`,
        )
        .run(`reconcile:${job.id}:${threadId}`, job.id, JSON.stringify({ threadId }), now, now, now);
      return result.changes === 1;
    });
    return enqueue();
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

  private hasMergeEffect(jobId: string, headSha: string): boolean {
    const rows = this.db
      .prepare("SELECT payload_json, status FROM effects WHERE job_id = ? AND kind = 'merge_pr'")
      .all(jobId) as Array<{ payload_json: string; status: StoredEffect["status"] }>;
    return rows.some((row) => {
      if (row.status === "failed" || row.status === "dead") return false;
      try {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown> & { mergeOutcome?: unknown };
        if (payload.mergeOutcome === "stale") return false;
        const parsed = parsePersistedMergeEffectPayload(payload, row.status);
        return parsed.receipt.headSha === headSha;
      } catch {
        return false;
      }
    });
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
    if (now >= approval.expires_at || now >= Date.parse(receipt.expiresAt)) {
      return "durable merge approval has expired";
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
  ): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO callbacks (
           callback_query_id, job_id, action, outcome, processed_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(callbackId, jobId, action, outcome, now);
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
        "SELECT 1 FROM jobs WHERE id <> ? AND state NOT IN ('merged', 'cancelled', 'blocked') LIMIT 1",
      )
      .get(jobId) !== undefined;
  }
}

export function openStore(storage: PluginStorage, kv: PluginKv = storage.kv): TelegramAgentStore {
  const db = storage.database();
  storage.migrate(db, [...ALL_MIGRATIONS]);
  ensureTask9ApprovalColumns(db);
  return new SqliteTelegramAgentStore(db, kv);
}
