import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { TaskConstraint } from "../domain/task-authority";
import type { TaskAuthority } from "./task-authority-repository";

type SqliteDatabase = Database.Database;

export const RELEASE_AUTHORITY_SOURCES = ["task", "explicit", "button", "policy"] as const;
export type ReleaseAuthoritySource = (typeof RELEASE_AUTHORITY_SOURCES)[number];
export const RELEASE_AUTHORITY_STATUSES = ["active", "consumed", "revoked"] as const;
export type ReleaseAuthorityStatus = (typeof RELEASE_AUTHORITY_STATUSES)[number];

export type ReleaseAuthorityReceipt = Readonly<{
  receiptId: string;
  jobId: string;
  effectIdempotencyKey: string;
  authorityId: string | null;
  authorityRevision: number | null;
  authoritySource: ReleaseAuthoritySource;
  projectId: string;
  repository: string;
  baseBranch: string;
  environmentId: string;
  prNumber: number;
  headSha: string;
  artifactGraphDigest: string | null;
  reviewAttemptId: string;
  validationCompletedAt: number;
  requiredCheckNames: readonly string[];
  mergeMethod: "merge" | "rebase" | "squash";
  productionPolicyDigest: string | null;
  gateReceiptDigest: string;
  status: ReleaseAuthorityStatus;
  createdAt: number;
  updatedAt: number;
  consumedAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
}>;

export type CreateReleaseAuthorityReceiptInput = Readonly<{
  receiptId: string;
  jobId: string;
  effectIdempotencyKey: string;
  authorityId?: string | null;
  authorityRevision?: number | null;
  authoritySource: ReleaseAuthoritySource;
  projectId: string;
  repository: string;
  baseBranch: string;
  environmentId: string;
  prNumber: number;
  headSha: string;
  artifactGraphDigest?: string | null;
  reviewAttemptId: string;
  validationCompletedAt: number;
  requiredCheckNames: readonly string[];
  mergeMethod: "merge" | "rebase" | "squash";
  productionPolicyDigest?: string | null;
  gateReceiptDigest: string;
  now: number;
  taskAuthority?: TaskAuthority | null;
}>;

type ReceiptRow = Readonly<{
  receipt_id: string;
  job_id: string;
  effect_idempotency_key: string;
  authority_id: string | null;
  authority_revision: number | null;
  authority_source: string;
  project_id: string;
  repository: string;
  base_branch: string;
  environment_id: string;
  pr_number: number;
  head_sha: string;
  artifact_graph_digest: string | null;
  review_attempt_id: string;
  validation_completed_at: number;
  required_check_names_json: string;
  merge_method: string;
  production_policy_digest: string | null;
  gate_receipt_digest: string;
  status: string;
  created_at: number;
  updated_at: number;
  consumed_at: number | null;
  revoked_at: number | null;
  revoked_reason: string | null;
}>;

const SOURCE_SET = new Set<string>(RELEASE_AUTHORITY_SOURCES);
const STATUS_SET = new Set<string>(RELEASE_AUTHORITY_STATUSES);
const OUTCOME_CONSTRAINTS = new Set<TaskConstraint>([
  "artifact_only",
  "pull_request_only",
  "no_merge",
  "no_deploy",
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const FULL_SHA = /^[0-9a-f]{40}$/u;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function releaseAuthorityReceiptId(effectIdempotencyKey: string): string {
  return `releaseauth_${digest(effectIdempotencyKey).slice(0, 32)}`;
}

export function releaseGateReceiptDigest(input: Readonly<{
  projectId: string;
  repository: string;
  baseBranch: string;
  environmentId: string;
  prNumber: number;
  headSha: string;
  reviewAttemptId: string;
  validationCompletedAt: number;
  requiredCheckNames: readonly string[];
  mergeMethod: "merge" | "rebase" | "squash";
  productionPolicyDigest: string | null;
}>): string {
  return digest({
    projectId: input.projectId,
    repository: input.repository,
    baseBranch: input.baseBranch,
    environmentId: input.environmentId,
    prNumber: input.prNumber,
    headSha: input.headSha,
    reviewAttemptId: input.reviewAttemptId,
    validationCompletedAt: input.validationCompletedAt,
    requiredCheckNames: [...input.requiredCheckNames].sort(),
    mergeMethod: input.mergeMethod,
    productionPolicyDigest: input.productionPolicyDigest,
  });
}

function assertBounded(value: string, field: string, max = 512): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new TypeError(`${field} must be a bounded non-empty string`);
  }
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
}

function assertDigest(value: string | null | undefined, field: string, required: boolean): void {
  if (value === null || value === undefined) {
    if (required) throw new TypeError(`${field} is required`);
    return;
  }
  if (!SHA256.test(value)) throw new TypeError(`${field} must be a SHA-256 digest`);
}

function parseNames(serialized: string): readonly string[] {
  const names: unknown = JSON.parse(serialized);
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || name.length === 0 || name.length > 512)) {
    throw new Error("Invalid persisted release receipt check names");
  }
  if (new Set(names).size !== names.length || JSON.stringify(names) !== JSON.stringify([...names].sort())) {
    throw new Error("Persisted release receipt check names are not unique and sorted");
  }
  return names;
}

function parseReceipt(row: ReceiptRow): ReleaseAuthorityReceipt {
  if (!SOURCE_SET.has(row.authority_source)) throw new Error(`Unknown release authority source: ${row.authority_source}`);
  if (!STATUS_SET.has(row.status)) throw new Error(`Unknown release authority status: ${row.status}`);
  if (row.authority_revision !== null && (!Number.isSafeInteger(row.authority_revision) || row.authority_revision < 1)) {
    throw new Error("Invalid release authority revision");
  }
  if (!FULL_SHA.test(row.head_sha)) throw new Error("Invalid persisted release receipt head");
  assertDigest(row.artifact_graph_digest, "artifact graph digest", false);
  assertDigest(row.production_policy_digest, "production policy digest", false);
  assertDigest(row.gate_receipt_digest, "gate receipt digest", true);
  if (row.merge_method !== "merge" && row.merge_method !== "rebase" && row.merge_method !== "squash") {
    throw new Error("Invalid persisted release receipt merge method");
  }
  return {
    receiptId: row.receipt_id,
    jobId: row.job_id,
    effectIdempotencyKey: row.effect_idempotency_key,
    authorityId: row.authority_id,
    authorityRevision: row.authority_revision,
    authoritySource: row.authority_source as ReleaseAuthoritySource,
    projectId: row.project_id,
    repository: row.repository,
    baseBranch: row.base_branch,
    environmentId: row.environment_id,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    artifactGraphDigest: row.artifact_graph_digest,
    reviewAttemptId: row.review_attempt_id,
    validationCompletedAt: row.validation_completed_at,
    requiredCheckNames: parseNames(row.required_check_names_json),
    mergeMethod: row.merge_method as ReleaseAuthorityReceipt["mergeMethod"],
    productionPolicyDigest: row.production_policy_digest,
    gateReceiptDigest: row.gate_receipt_digest,
    status: row.status as ReleaseAuthorityStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}

function readByEffect(db: SqliteDatabase, effectIdempotencyKey: string): ReleaseAuthorityReceipt | null {
  const row = db.prepare("SELECT * FROM release_authority_receipts WHERE effect_idempotency_key = ?")
    .get(effectIdempotencyKey) as ReceiptRow | undefined;
  return row ? parseReceipt(row) : null;
}

function readByJob(db: SqliteDatabase, jobId: string): readonly ReleaseAuthorityReceipt[] {
  const rows = db.prepare(
    "SELECT * FROM release_authority_receipts WHERE job_id = ? ORDER BY created_at ASC, receipt_id ASC",
  ).all(jobId) as ReceiptRow[];
  return rows.map(parseReceipt);
}

export function releaseAuthorityReceiptMatches(
  receipt: ReleaseAuthorityReceipt,
  input: CreateReleaseAuthorityReceiptInput,
): boolean {
  return receipt.receiptId === input.receiptId &&
    receipt.jobId === input.jobId &&
    receipt.effectIdempotencyKey === input.effectIdempotencyKey &&
    receipt.authorityId === (input.authorityId ?? null) &&
    receipt.authorityRevision === (input.authorityRevision ?? null) &&
    receipt.authoritySource === input.authoritySource &&
    receipt.projectId === input.projectId &&
    receipt.repository === input.repository &&
    receipt.baseBranch === input.baseBranch &&
    receipt.environmentId === input.environmentId &&
    receipt.prNumber === input.prNumber &&
    receipt.headSha === input.headSha &&
    receipt.artifactGraphDigest === (input.artifactGraphDigest ?? null) &&
    receipt.reviewAttemptId === input.reviewAttemptId &&
    receipt.validationCompletedAt === input.validationCompletedAt &&
    JSON.stringify(receipt.requiredCheckNames) === JSON.stringify([...input.requiredCheckNames].sort()) &&
    receipt.mergeMethod === input.mergeMethod &&
    receipt.productionPolicyDigest === (input.productionPolicyDigest ?? null) &&
    receipt.gateReceiptDigest === input.gateReceiptDigest;
}

function assertInput(input: CreateReleaseAuthorityReceiptInput): void {
  assertBounded(input.receiptId, "receiptId");
  assertBounded(input.jobId, "jobId");
  assertBounded(input.effectIdempotencyKey, "effectIdempotencyKey");
  assertBounded(input.projectId, "projectId");
  assertBounded(input.repository, "repository");
  assertBounded(input.baseBranch, "baseBranch");
  assertBounded(input.environmentId, "environmentId");
  assertBounded(input.reviewAttemptId, "reviewAttemptId");
  assertBounded(input.authoritySource, "authoritySource");
  if (!SOURCE_SET.has(input.authoritySource)) throw new TypeError("authoritySource is invalid");
  assertDigest(input.gateReceiptDigest, "gateReceiptDigest", true);
  if (input.authorityId !== null && input.authorityId !== undefined) assertBounded(input.authorityId, "authorityId");
  assertDigest(input.artifactGraphDigest, "artifactGraphDigest", false);
  assertDigest(input.productionPolicyDigest, "productionPolicyDigest", false);
  if (!Number.isSafeInteger(input.authorityRevision) && input.authorityRevision !== null && input.authorityRevision !== undefined) {
    throw new TypeError("authorityRevision must be a positive integer");
  }
  if (input.authorityRevision !== null && input.authorityRevision !== undefined && input.authorityRevision < 1) {
    throw new TypeError("authorityRevision must be a positive integer");
  }
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber < 1) throw new TypeError("prNumber must be positive");
  if (!FULL_SHA.test(input.headSha)) throw new TypeError("headSha must be a full lowercase SHA");
  assertTimestamp(input.validationCompletedAt, "validationCompletedAt");
  assertTimestamp(input.now, "now");
  if (input.requiredCheckNames.length > 50 || input.requiredCheckNames.some((name) => typeof name !== "string" || name.length === 0 || name.length > 512)) {
    throw new TypeError("requiredCheckNames must be bounded strings");
  }
  if (new Set(input.requiredCheckNames).size !== input.requiredCheckNames.length ||
    JSON.stringify(input.requiredCheckNames) !== JSON.stringify([...input.requiredCheckNames].sort())) {
    throw new TypeError("requiredCheckNames must be unique and sorted");
  }
  if (input.mergeMethod !== "merge" && input.mergeMethod !== "rebase" && input.mergeMethod !== "squash") {
    throw new TypeError("mergeMethod is invalid");
  }
}

function taskAuthorityIsUsable(input: CreateReleaseAuthorityReceiptInput): boolean {
  const authority = input.taskAuthority;
  if (!authority || authority.status !== "active" || authority.jobId !== input.jobId || authority.projectId !== input.projectId ||
    authority.outcome !== "shipped_change" || authority.authorityId !== (input.authorityId ?? null) ||
    authority.revision !== input.authorityRevision || authority.artifactGraphDigest !== (input.artifactGraphDigest ?? null)) {
    return false;
  }
  return !authority.constraints.some((constraint) => OUTCOME_CONSTRAINTS.has(constraint));
}

export class ReleaseAuthorityRepository {
  public constructor(private readonly db: SqliteDatabase) {}

  public record(input: CreateReleaseAuthorityReceiptInput): ReleaseAuthorityReceipt {
    assertInput(input);
    if (input.authoritySource === "task" && !taskAuthorityIsUsable(input)) {
      throw new TypeError("task release authority is not live for this exact job and artifact graph");
    }
    const existing = readByEffect(this.db, input.effectIdempotencyKey);
    if (existing) {
      if (!releaseAuthorityReceiptMatches(existing, input)) throw new Error("release authority receipt identity changed on replay");
      return existing;
    }
    this.db.prepare(
      `INSERT INTO release_authority_receipts (
         receipt_id, job_id, effect_idempotency_key, authority_id, authority_revision,
         authority_source, project_id, repository, base_branch, environment_id,
         pr_number, head_sha, artifact_graph_digest, review_attempt_id,
         validation_completed_at, required_check_names_json, merge_method,
         production_policy_digest, gate_receipt_digest, status, created_at,
         updated_at, consumed_at, revoked_at, revoked_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, NULL)`,
    ).run(
      input.receiptId,
      input.jobId,
      input.effectIdempotencyKey,
      input.authorityId ?? null,
      input.authorityRevision ?? null,
      input.authoritySource,
      input.projectId,
      input.repository,
      input.baseBranch,
      input.environmentId,
      input.prNumber,
      input.headSha,
      input.artifactGraphDigest ?? null,
      input.reviewAttemptId,
      input.validationCompletedAt,
      JSON.stringify(input.requiredCheckNames),
      input.mergeMethod,
      input.productionPolicyDigest ?? null,
      input.gateReceiptDigest,
      input.now,
      input.now,
    );
    const stored = readByEffect(this.db, input.effectIdempotencyKey);
    if (!stored) throw new Error("release authority receipt was not stored");
    return stored;
  }

  public getByEffect(effectIdempotencyKey: string): ReleaseAuthorityReceipt | null {
    assertBounded(effectIdempotencyKey, "effectIdempotencyKey");
    return readByEffect(this.db, effectIdempotencyKey);
  }

  public listForJob(jobId: string): readonly ReleaseAuthorityReceipt[] {
    assertBounded(jobId, "jobId");
    return readByJob(this.db, jobId);
  }

  public revokeForJob(jobId: string, reason: string, now: number): number {
    assertBounded(jobId, "jobId");
    assertBounded(reason, "reason", 500);
    assertTimestamp(now, "now");
    return this.db.prepare(
      `UPDATE release_authority_receipts
          SET status = 'revoked', revoked_at = ?, revoked_reason = ?, updated_at = ?
        WHERE job_id = ? AND status = 'active'`,
    ).run(now, reason, now, jobId).changes;
  }

  public consume(effectIdempotencyKey: string, now: number): boolean {
    assertBounded(effectIdempotencyKey, "effectIdempotencyKey");
    assertTimestamp(now, "now");
    return this.db.prepare(
      `UPDATE release_authority_receipts
          SET status = 'consumed', consumed_at = ?, updated_at = ?
        WHERE effect_idempotency_key = ? AND status = 'active'`,
    ).run(now, now, effectIdempotencyKey).changes === 1;
  }
}
