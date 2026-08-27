import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  TASK_CONSTRAINTS,
  TASK_OUTCOMES,
  taskAuthorityAllowsEffect,
  taskAuthorityIsStrictNarrowing,
  type TaskAuthorityEffect,
  type TaskConstraint,
  type TaskOutcome,
} from "../domain/task-authority";

type SqliteDatabase = Database.Database;

export const TASK_AUTHORITY_STATUSES = ["active", "revoked", "suspended", "superseded"] as const;
export type TaskAuthorityStatus = (typeof TASK_AUTHORITY_STATUSES)[number];

export type TaskAuthority = Readonly<{
  authorityId: string;
  jobId: string;
  revision: number;
  ownerUserId: string;
  ownerChatId: string;
  controllerKey: string;
  sourceUpdateId: number;
  requestDigest: string;
  projectId: string;
  outcome: TaskOutcome;
  scopeDigest: string;
  constraints: readonly TaskConstraint[];
  policyVersion: number;
  policyDigest: string;
  artifactGraphDigest: string;
  status: TaskAuthorityStatus;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
  revokedReason: string | null;
  supersededAt: number | null;
  supersededReason: string | null;
}>;

export type CreateTaskAuthorityInput = Readonly<{
  authorityId: string;
  jobId: string;
  ownerUserId: string;
  ownerChatId: string;
  controllerKey: string;
  sourceUpdateId: number;
  requestDigest: string;
  projectId: string;
  outcome: TaskOutcome;
  scopeDigest: string;
  constraints: readonly TaskConstraint[];
  policyVersion: number;
  policyDigest: string;
  artifactGraphDigest: string;
  now: number;
}>;

type AuthorityRow = Readonly<{
  authority_id: string;
  job_id: string;
  revision: number;
  owner_user_id: string;
  owner_chat_id: string;
  controller_key: string;
  source_update_id: number;
  request_digest: string;
  project_id: string;
  task_outcome: string;
  scope_digest: string;
  constraints_json: string;
  policy_version: number;
  policy_digest: string;
  artifact_graph_digest: string;
  status: string;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  revoked_reason: string | null;
  superseded_at: number | null;
  superseded_reason: string | null;
}>;

const OUTCOMES = new Set<string>(TASK_OUTCOMES);
const CONSTRAINTS = new Set<string>(TASK_CONSTRAINTS);
const STATUSES = new Set<string>(TASK_AUTHORITY_STATUSES);

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function taskPolicyDigest(policyJson: string): string {
  return digest(policyJson);
}

export function taskArtifactGraphDigest(bindings: readonly unknown[]): string {
  const canonical = [...bindings].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return digest(JSON.stringify(canonical));
}

function parseConstraints(serialized: string): readonly TaskConstraint[] {
  const value: unknown = JSON.parse(serialized);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !CONSTRAINTS.has(entry))) {
    throw new Error("Invalid persisted task authority constraints");
  }
  if (new Set(value).size !== value.length) throw new Error("Persisted task authority constraints are duplicated");
  return value as TaskConstraint[];
}

function parseAuthority(row: AuthorityRow): TaskAuthority {
  if (!OUTCOMES.has(row.task_outcome)) throw new Error(`Unknown task authority outcome: ${row.task_outcome}`);
  if (!STATUSES.has(row.status)) throw new Error(`Unknown task authority status: ${row.status}`);
  if (!Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error("Invalid task authority revision");
  return {
    authorityId: row.authority_id,
    jobId: row.job_id,
    revision: row.revision,
    ownerUserId: row.owner_user_id,
    ownerChatId: row.owner_chat_id,
    controllerKey: row.controller_key,
    sourceUpdateId: row.source_update_id,
    requestDigest: row.request_digest,
    projectId: row.project_id,
    outcome: row.task_outcome as TaskOutcome,
    scopeDigest: row.scope_digest,
    constraints: parseConstraints(row.constraints_json),
    policyVersion: row.policy_version,
    policyDigest: row.policy_digest,
    artifactGraphDigest: row.artifact_graph_digest,
    status: row.status as TaskAuthorityStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    supersededAt: row.superseded_at,
    supersededReason: row.superseded_reason,
  };
}

function authorityId(jobId: string): string {
  return `taskauth_${digest(jobId).slice(0, 32)}`;
}

function event(
  db: SqliteDatabase,
  authority: TaskAuthority,
  action: "granted" | "revised" | "revoked" | "suspended" | "superseded",
  reason: string | null,
  now: number,
): void {
  db.prepare(
    `INSERT INTO task_authority_events (authority_id, job_id, revision, action, reason, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(authority.authorityId, authority.jobId, authority.revision, action, reason, now);
}

function readAuthority(db: SqliteDatabase, jobId: string): TaskAuthority | null {
  const row = db.prepare(
    `SELECT revision.* FROM task_authority_current AS current
       JOIN task_authority_revisions AS revision
         ON revision.authority_id = current.authority_id AND revision.revision = current.revision
      WHERE current.job_id = ?`,
  ).get(jobId) as AuthorityRow | undefined;
  return row ? parseAuthority(row) : null;
}

function readAuthorityRevision(
  db: SqliteDatabase,
  jobId: string,
  revision: number,
): TaskAuthority | null {
  const row = db.prepare(
    "SELECT * FROM task_authority_revisions WHERE job_id = ? AND revision = ?",
  ).get(jobId, revision) as AuthorityRow | undefined;
  return row ? parseAuthority(row) : null;
}

function appendRevision(db: SqliteDatabase, authority: TaskAuthority): void {
  db.prepare(
    `INSERT INTO task_authority_revisions (
       authority_id, job_id, revision, owner_user_id, owner_chat_id, controller_key,
       source_update_id, request_digest, project_id, task_outcome, scope_digest,
       constraints_json, policy_version, policy_digest, artifact_graph_digest,
       status, created_at, updated_at, revoked_at, revoked_reason, superseded_at, superseded_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    authority.authorityId, authority.jobId, authority.revision, authority.ownerUserId,
    authority.ownerChatId, authority.controllerKey, authority.sourceUpdateId,
    authority.requestDigest, authority.projectId, authority.outcome, authority.scopeDigest,
    JSON.stringify(authority.constraints), authority.policyVersion, authority.policyDigest,
    authority.artifactGraphDigest, authority.status, authority.createdAt, authority.updatedAt,
    authority.revokedAt, authority.revokedReason, authority.supersededAt, authority.supersededReason,
  );
  const moved = db.prepare(
    `UPDATE task_authority_current SET revision = ?
      WHERE job_id = ? AND authority_id = ? AND revision = ?`,
  ).run(authority.revision, authority.jobId, authority.authorityId, authority.revision - 1);
  if (moved.changes !== 1) throw new Error("Task authority current revision changed during update");
}

function assertDigest(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new TypeError(`${field} must be a SHA-256 digest`);
}

function assertBoundedIdentity(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new TypeError(`${field} must be a bounded non-empty string`);
  }
}

export class TaskAuthorityRepository {
  public constructor(private readonly db: SqliteDatabase) {}

  public create(input: CreateTaskAuthorityInput): TaskAuthority {
    assertBoundedIdentity(input.authorityId, "authorityId");
    assertBoundedIdentity(input.jobId, "jobId");
    assertBoundedIdentity(input.ownerUserId, "ownerUserId");
    assertBoundedIdentity(input.ownerChatId, "ownerChatId");
    assertBoundedIdentity(input.controllerKey, "controllerKey");
    assertBoundedIdentity(input.projectId, "projectId");
    assertDigest(input.requestDigest, "requestDigest");
    assertDigest(input.scopeDigest, "scopeDigest");
    assertDigest(input.policyDigest, "policyDigest");
    assertDigest(input.artifactGraphDigest, "artifactGraphDigest");
    if (!OUTCOMES.has(input.outcome)) throw new TypeError("Unknown task authority outcome");
    if (new Set(input.constraints).size !== input.constraints.length || input.constraints.some((entry) => !CONSTRAINTS.has(entry))) {
      throw new TypeError("Invalid task authority constraints");
    }
    const existing = readAuthority(this.db, input.jobId);
    if (existing) {
      if (
        existing.authorityId !== input.authorityId || existing.ownerUserId !== input.ownerUserId ||
        existing.ownerChatId !== input.ownerChatId || existing.controllerKey !== input.controllerKey ||
        existing.sourceUpdateId !== input.sourceUpdateId || existing.requestDigest !== input.requestDigest ||
        existing.projectId !== input.projectId || existing.outcome !== input.outcome ||
        existing.scopeDigest !== input.scopeDigest || JSON.stringify(existing.constraints) !== JSON.stringify(input.constraints) ||
        existing.policyVersion !== input.policyVersion || existing.policyDigest !== input.policyDigest
      ) throw new Error("task authority identity changed on replay");
      return existing;
    }
    this.db.prepare(
      `INSERT INTO task_authorities (
         authority_id, job_id, revision, owner_user_id, owner_chat_id, controller_key,
         source_update_id, request_digest, project_id, task_outcome, scope_digest,
         constraints_json, policy_version, policy_digest, artifact_graph_digest,
         status, created_at, updated_at, revoked_at, revoked_reason, superseded_at, superseded_reason
       ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, NULL, NULL)`,
    ).run(
      input.authorityId,
      input.jobId,
      input.ownerUserId,
      input.ownerChatId,
      input.controllerKey,
      input.sourceUpdateId,
      input.requestDigest,
      input.projectId,
      input.outcome,
      input.scopeDigest,
      JSON.stringify(input.constraints),
      input.policyVersion,
      input.policyDigest,
      input.artifactGraphDigest,
      input.now,
      input.now,
    );
    this.db.prepare(
      `INSERT INTO task_authority_revisions (
         authority_id, revision, job_id, owner_user_id, owner_chat_id, controller_key,
         source_update_id, request_digest, project_id, task_outcome, scope_digest,
         constraints_json, policy_version, policy_digest, artifact_graph_digest,
         status, created_at, updated_at, revoked_at, revoked_reason, superseded_at, superseded_reason
       )
       SELECT authority_id, revision, job_id, owner_user_id, owner_chat_id, controller_key,
              source_update_id, request_digest, project_id, task_outcome, scope_digest,
              constraints_json, policy_version, policy_digest, artifact_graph_digest,
              status, created_at, updated_at, revoked_at, revoked_reason, superseded_at, superseded_reason
         FROM task_authorities WHERE authority_id = ?`,
    ).run(input.authorityId);
    this.db.prepare(
      `INSERT INTO task_authority_current(job_id, authority_id, revision) VALUES (?, ?, 1)`,
    ).run(input.jobId, input.authorityId);
    const authority = readAuthority(this.db, input.jobId);
    if (!authority) throw new Error("Task authority was not stored");
    event(this.db, authority, "granted", null, input.now);
    return authority;
  }

  public get(jobId: string): TaskAuthority | null {
    return readAuthority(this.db, jobId);
  }

  public getRevision(jobId: string, revision: number): TaskAuthority | null {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError("revision must be a positive integer");
    return readAuthorityRevision(this.db, jobId, revision);
  }

  public admitEffect(
    jobId: string,
    effectIdempotencyKey: string,
    effect: TaskAuthorityEffect,
    now: number,
  ): boolean {
    const authority = readAuthority(this.db, jobId);
    const job = this.db.prepare(
      "SELECT task_outcome, task_constraints_json FROM jobs WHERE id = ?",
    ).get(jobId) as { task_outcome: string | null; task_constraints_json: string } | undefined;
    if (!job) return false;
    if (!authority) return job.task_outcome === null;
    if (job.task_outcome !== authority.outcome ||
      job.task_constraints_json !== JSON.stringify(authority.constraints) ||
      !taskAuthorityAllowsEffect(authority, effect)) return false;
    const existing = this.db.prepare(
      `SELECT authority_id, authority_revision, effect FROM task_authority_effect_admissions
        WHERE effect_idempotency_key = ? AND effect = ?`,
    ).get(effectIdempotencyKey, effect) as {
      authority_id: string;
      authority_revision: number;
      effect: string;
    } | undefined;
    if (existing) {
      return existing.authority_id === authority.authorityId &&
        existing.authority_revision === authority.revision && existing.effect === effect;
    }
    return this.db.prepare(
      `INSERT INTO task_authority_effect_admissions (
         effect_idempotency_key, job_id, authority_id, authority_revision, effect, admitted_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      effectIdempotencyKey,
      jobId,
      authority.authorityId,
      authority.revision,
      effect,
      now,
    ).changes === 1;
  }

  public effectAdmissionIsCurrent(
    jobId: string,
    effectIdempotencyKey: string,
    effect: TaskAuthorityEffect,
  ): boolean {
    const authority = readAuthority(this.db, jobId);
    const job = this.db.prepare(
      "SELECT task_outcome, task_constraints_json FROM jobs WHERE id = ?",
    ).get(jobId) as { task_outcome: string | null; task_constraints_json: string } | undefined;
    if (!job) return false;
    if (!authority) return job.task_outcome === null;
    const admission = this.db.prepare(
      `SELECT authority_id, authority_revision, effect FROM task_authority_effect_admissions
        WHERE effect_idempotency_key = ? AND job_id = ? AND effect = ?`,
    ).get(effectIdempotencyKey, jobId, effect) as {
      authority_id: string;
      authority_revision: number;
      effect: string;
    } | undefined;
    return admission?.authority_id === authority.authorityId &&
      admission.authority_revision === authority.revision && admission.effect === effect &&
      job.task_outcome === authority.outcome &&
      job.task_constraints_json === JSON.stringify(authority.constraints) &&
      taskAuthorityAllowsEffect(authority, effect);
  }

  public updateArtifactGraph(jobId: string, artifactGraphDigest: string, now: number): TaskAuthority | null {
    assertDigest(artifactGraphDigest, "artifactGraphDigest");
    const authority = readAuthority(this.db, jobId);
    if (!authority || authority.status !== "active" || authority.artifactGraphDigest === artifactGraphDigest) return authority;
    appendRevision(this.db, {
      ...authority,
      revision: authority.revision + 1,
      artifactGraphDigest,
      updatedAt: now,
    });
    const revised = readAuthority(this.db, jobId);
    if (!revised) throw new Error("Task authority disappeared during artifact graph update");
    event(this.db, revised, "revised", "artifact_graph_advanced", now);
    return revised;
  }

  public reviseForMergeInstruction(jobId: string, now: number): TaskAuthority | null {
    const authority = readAuthority(this.db, jobId);
    if (!authority || authority.status !== "active" || authority.outcome !== "reviewed_change") return authority;
    const constraints = authority.constraints.filter((entry) => entry !== "no_merge" && entry !== "pull_request_only");
    const outcome: TaskOutcome = "shipped_change";
    const scopeDigest = digest(JSON.stringify({ requestDigest: authority.requestDigest, outcome, constraints }));
    appendRevision(this.db, {
      ...authority,
      revision: authority.revision + 1,
      outcome,
      constraints,
      scopeDigest,
      updatedAt: now,
      supersededAt: null,
      supersededReason: null,
    });
    const revised = readAuthority(this.db, jobId);
    if (!revised) throw new Error("Revised task authority disappeared");
    event(this.db, revised, "revised", "owner_merge_instruction", now);
    return revised;
  }

  public narrow(
    jobId: string,
    outcome: TaskOutcome,
    constraints: readonly TaskConstraint[],
    now: number,
  ): TaskAuthority | null {
    if (!OUTCOMES.has(outcome) || new Set(constraints).size !== constraints.length ||
      constraints.some((entry) => !CONSTRAINTS.has(entry))) {
      throw new TypeError("Invalid narrowed task authority");
    }
    const authority = readAuthority(this.db, jobId);
    if (!authority || authority.status !== "active" ||
      !taskAuthorityIsStrictNarrowing(authority, { outcome, constraints })) return null;
    const scopeDigest = digest(JSON.stringify({ requestDigest: authority.requestDigest, outcome, constraints }));
    appendRevision(this.db, {
      ...authority,
      revision: authority.revision + 1,
      outcome,
      constraints,
      scopeDigest,
      updatedAt: now,
    });
    const narrowed = readAuthority(this.db, jobId);
    if (!narrowed) throw new Error("Narrowed task authority disappeared");
    event(this.db, narrowed, "revised", "owner_narrowing_instruction", now);
    return narrowed;
  }

  public revoke(jobId: string, reason: string, now: number, status: "revoked" | "suspended" = "revoked"): TaskAuthority | null {
    assertBoundedIdentity(reason, "reason");
    const authority = readAuthority(this.db, jobId);
    if (!authority || authority.status === status || authority.status !== "active") return authority;
    appendRevision(this.db, {
      ...authority,
      revision: authority.revision + 1,
      status,
      updatedAt: now,
      revokedAt: now,
      revokedReason: reason,
    });
    const revoked = readAuthority(this.db, jobId);
    if (!revoked) throw new Error("Revoked task authority disappeared");
    event(this.db, revoked, status, reason, now);
    return revoked;
  }
}

export function taskAuthorityIdForJob(jobId: string): string {
  return authorityId(jobId);
}
