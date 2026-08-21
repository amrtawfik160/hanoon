import type Database from "better-sqlite3";
import {
  projectPolicySchema,
  type AutonomousJobOrigin,
  type DeliveryMode,
  type Job,
  type JobOrigin,
  type RoutingMode,
  type JobEffect,
  type JobState,
  type StoredEffect,
} from "../domain/models";
import { TASK_RECIPES, type TaskRecipe } from "../domain/recipes";
import {
  taskReasonCodesSchema,
  taskTraitSnapshotSchema,
} from "../capabilities/routing";
import { containsForbiddenCallbackMaterial } from "../telegram/callback-material";

type SqliteDatabase = Database.Database;

export type JobRow = {
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
  delivery_mode: DeliveryMode;
  task_recipe: TaskRecipe;
  recipe_version: number;
  recipe_promotion_count: number;
  routing_mode: RoutingMode;
  task_traits_json: string;
  task_reason_codes_json: string;
  job_origin: JobOrigin;
  autonomous_origin: AutonomousJobOrigin | null;
  adopted_branch: string | null;
  adopted_head_sha: string | null;
  plan_cycle: number;
  review_cycle: number;
  review_block_at: number;
  cancel_requested_at: number | null;
  merge_pre_approved_at: number | null;
  blocked_reason: Job["blockedReason"];
  last_error: string | null;
  version: number;
  created_at: number;
  updated_at: number;
};

export type EffectRow = {
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
  "recovering_worker",
  "production_failed",
  "complete",
  "failed",
  "blocked",
  "cancelled",
  "merged",
]);
const BLOCKED_REASONS: ReadonlySet<NonNullable<Job["blockedReason"]>> = new Set([
  "plan_limit",
  "review_limit",
  "configuration",
  "cancellation_unconfirmed",
  "permanent_effect_failure",
]);
const DELIVERY_MODES: ReadonlySet<DeliveryMode> = new Set(["full", "small_fix"]);
const JOB_ORIGINS: ReadonlySet<JobOrigin> = new Set(["requested", "adopted_pr"]);
const AUTONOMOUS_JOB_ORIGINS: ReadonlySet<AutonomousJobOrigin> = new Set([
  "audit_intake",
  "self_diagnosis",
  "crash_revert",
]);
const TASK_RECIPE_SET: ReadonlySet<TaskRecipe> = new Set(TASK_RECIPES);
const ROUTING_MODES: ReadonlySet<RoutingMode> = new Set(["legacy", "shadow", "active"]);

const MAX_RECEIPT_STRING = 512;
export const MAX_MERGE_RESULT_JSON = 64_000;
const MAX_EXTERNAL_URL_LENGTH = 500;
const MAX_QUERY_DEPTH = 4;
const CREDENTIAL_QUERY_KEY = /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|auth(?:orization)?|auth[_-]?(?:token|key)|session[_-]?token|private[_-]?key|credentials?|password|passwd|secret|token|key|jwt|signature|sig)$/i;
const CREDENTIAL_QUERY_VALUE = /^(?:bearer\s+\S+|(?:sk|rk)-[A-Za-z0-9_-]{10,}|(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|password|secret|token|credential)\s*[:=]|(?:secret|password|token|credential|api[_-]?key)\b)/i;

export function assertBoundedString(value: unknown, field: string, max = MAX_RECEIPT_STRING): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new TypeError(`${field} must be a bounded non-empty string`);
  }
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

export function assertNoRawMergeCallback(value: string, field: string): void {
  if (containsForbiddenCallbackMaterial(value)) throw new TypeError(`${field} must not contain a raw merge callback nonce`);
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

export function serializeBoundedJson(value: unknown, field: string, maxLength: number): string {
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

export class VersionConflictError extends Error {
  public constructor(jobId: string, expectedVersion: number) {
    super(`Job ${jobId} changed since version ${expectedVersion}`);
    this.name = "VersionConflictError";
  }
}

export function parseJobRow(row: JobRow): Job {
  if (!JOB_STATES.has(row.state as JobState)) throw new Error(`Unknown persisted job state: ${row.state}`);
  if (row.resume_state !== null && !JOB_STATES.has(row.resume_state as JobState)) {
    throw new Error(`Unknown persisted resume state: ${row.resume_state}`);
  }
  if (row.blocked_reason !== null && !BLOCKED_REASONS.has(row.blocked_reason)) {
    throw new Error(`Unknown persisted blocked reason: ${row.blocked_reason}`);
  }
  if (!DELIVERY_MODES.has(row.delivery_mode)) {
    throw new Error(`Unknown persisted delivery mode: ${row.delivery_mode}`);
  }
  if (!TASK_RECIPE_SET.has(row.task_recipe)) throw new Error(`Unknown persisted task recipe: ${row.task_recipe}`);
  if (!Number.isSafeInteger(row.recipe_version) || row.recipe_version < 1) {
    throw new Error(`Invalid persisted recipe version: ${row.recipe_version}`);
  }
  if (!Number.isSafeInteger(row.recipe_promotion_count) || row.recipe_promotion_count < 0 || row.recipe_promotion_count > 2) {
    throw new Error(`Invalid persisted recipe promotion count: ${row.recipe_promotion_count}`);
  }
  if (!ROUTING_MODES.has(row.routing_mode)) throw new Error(`Unknown persisted routing mode: ${row.routing_mode}`);
  const taskTraits = taskTraitSnapshotSchema.parse(JSON.parse(row.task_traits_json));
  const taskReasonCodes = taskReasonCodesSchema.parse(JSON.parse(row.task_reason_codes_json));
  if (!JOB_ORIGINS.has(row.job_origin)) throw new Error(`Unknown persisted job origin: ${row.job_origin}`);
  if (row.autonomous_origin !== null && !AUTONOMOUS_JOB_ORIGINS.has(row.autonomous_origin)) {
    throw new Error(`Unknown persisted autonomous origin: ${row.autonomous_origin}`);
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
    deliveryMode: row.delivery_mode,
    taskRecipe: row.task_recipe,
    recipeVersion: row.recipe_version,
    recipePromotionCount: row.recipe_promotion_count,
    routingMode: row.routing_mode,
    taskTraits,
    taskReasonCodes,
    origin: row.job_origin,
    autonomousOrigin: row.autonomous_origin,
    adoptedBranch: row.adopted_branch,
    adoptedHeadSha: row.adopted_head_sha,
    planCycle: row.plan_cycle,
    reviewCycle: row.review_cycle,
    reviewBlockAt: row.review_block_at,
    cancelRequestedAt: row.cancel_requested_at,
    mergePreApprovedAt: row.merge_pre_approved_at,
    blockedReason: row.blocked_reason,
    lastError: row.last_error,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function parseStoredEffect(row: EffectRow): StoredEffect {
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

export function persistJobTransition(
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
         deployment_summary = ?, canary_summary = ?, status_message_id = ?, delivery_mode = ?,
         task_recipe = ?, recipe_version = ?, recipe_promotion_count = ?, routing_mode = ?,
         task_traits_json = ?, task_reason_codes_json = ?, plan_cycle = ?, review_cycle = ?,
         review_block_at = ?, cancel_requested_at = ?, merge_pre_approved_at = ?, blocked_reason = ?,
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
      transitionedJob.deliveryMode,
      transitionedJob.taskRecipe,
      transitionedJob.recipeVersion,
      transitionedJob.recipePromotionCount,
      transitionedJob.routingMode,
      JSON.stringify(transitionedJob.taskTraits),
      JSON.stringify(transitionedJob.taskReasonCodes),
      transitionedJob.planCycle,
      transitionedJob.reviewCycle,
      transitionedJob.reviewBlockAt,
      transitionedJob.cancelRequestedAt,
      transitionedJob.mergePreApprovedAt,
      transitionedJob.blockedReason,
      transitionedJob.lastError,
      transitionedJob.version,
      transitionedJob.updatedAt,
      jobId,
      expectedVersion,
    );
  if (updated.changes !== 1) throw new VersionConflictError(jobId, expectedVersion);
}

export function persistPendingEffects(
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

export const JOB_SELECT = `
  SELECT id, source_update_id, request_text, state, resume_state, project_id,
         policy_version, policy_json, environment_id, implementation_thread_id,
         review_thread_id, documentation_thread_id, pr_number, pr_url, pr_head_sha,
         merge_message, merge_commit_sha, merged_at, deployment_summary, canary_summary, status_message_id,
         delivery_mode, task_recipe, recipe_version, recipe_promotion_count, routing_mode,
         task_traits_json, task_reason_codes_json, job_origin, autonomous_origin,
         adopted_branch, adopted_head_sha,
         plan_cycle, review_cycle, review_block_at, cancel_requested_at, merge_pre_approved_at,
         blocked_reason, last_error, version, created_at, updated_at
    FROM jobs`;

export function readJobById(db: SqliteDatabase, jobId: string): Job | null {
  const row = db
    .prepare(`${JOB_SELECT} WHERE id = ?`)
    .get(jobId) as JobRow | undefined;
  return row ? parseJobRow(row) : null;
}

export function readJobBySourceUpdate(db: SqliteDatabase, sourceUpdateId: number): Job | null {
  const row = db
    .prepare(`${JOB_SELECT} WHERE source_update_id = ?`)
    .get(sourceUpdateId) as JobRow | undefined;
  return row ? parseJobRow(row) : null;
}
