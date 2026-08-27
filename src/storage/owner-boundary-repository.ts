import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  normalizeOwnerBoundary,
  normalizeOwnerBoundaryAnswer,
  ownerBoundaryDigest,
  renderOwnerBoundary,
  OWNER_BOUNDARY_CODES,
  type OwnerBoundaryCode,
  type OwnerBoundaryDraft,
  type OwnerBoundaryOption,
} from "../domain/owner-boundary";

type SqliteDatabase = Database.Database;

export const OWNER_BOUNDARY_STATUSES = ["pending", "answered", "revoked"] as const;
export type OwnerBoundaryStatus = (typeof OWNER_BOUNDARY_STATUSES)[number];

export type OwnerBoundaryRecord = Readonly<OwnerBoundaryDraft & {
  boundaryId: string;
  jobId: string;
  digest: string;
  authorityId: string;
  authorityRevision: number;
  ownerUserId: string;
  ownerChatId: string;
  status: OwnerBoundaryStatus;
  createdAt: number;
  updatedAt: number;
  answeredAt: number | null;
  answerText: string | null;
  answerDigest: string | null;
  revokedAt: number | null;
  revokedReason: string | null;
}>;

export type CreateOwnerBoundaryInput = OwnerBoundaryDraft & Readonly<{
  jobId: string;
  authorityId: string;
  authorityRevision: number;
  ownerUserId: string;
  ownerChatId: string;
  now: number;
}>;

export type OwnerBoundaryAnswerInput = Readonly<{
  boundaryDigest: string;
  jobId: string;
  authorityId: string;
  authorityRevision: number;
  affectedArtifactId?: string | null;
  affectedEffectIdempotencyKey?: string | null;
  ownerUserId: string;
  ownerChatId: string;
  answerText: string;
  now: number;
}>;

export type OwnerBoundaryAnswerResult =
  | Readonly<{ outcome: "answered"; boundary: OwnerBoundaryRecord }>
  | Readonly<{ outcome: "replayed"; boundary: OwnerBoundaryRecord }>
  | Readonly<{ outcome: "rejected" }>;

type BoundaryRow = Readonly<{
  boundary_id: string;
  job_id: string;
  digest: string;
  authority_id: string;
  authority_revision: number;
  code: string;
  goal: string;
  blocker: string;
  prior_checks_json: string;
  options_json: string;
  recommendation: string;
  paused_effect: string;
  affected_artifact_id: string | null;
  affected_effect_idempotency_key: string | null;
  owner_user_id: string;
  owner_chat_id: string;
  status: string;
  created_at: number;
  updated_at: number;
  answered_at: number | null;
  answer_text: string | null;
  answer_digest: string | null;
  revoked_at: number | null;
  revoked_reason: string | null;
}>;

const STATUS_SET = new Set<string>(OWNER_BOUNDARY_STATUSES);
const CODE_SET = new Set<string>(OWNER_BOUNDARY_CODES);
const IDENTIFIER = /^[A-Za-z0-9_.:/-]{1,256}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function assertIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new TypeError(`${field} is not a safe identifier`);
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive safe integer`);
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
}

function assertDigest(value: string, field: string): void {
  if (!SHA256.test(value)) throw new TypeError(`${field} must be a SHA-256 digest`);
}

function assertReason(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 500 || /[\r\n]/u.test(value)) {
    throw new TypeError("owner boundary revocation reason must be a bounded single line");
  }
}

function boundaryId(jobId: string, digest: string): string {
  return `boundary_${createHash("sha256").update(`${jobId}\u0000${digest}`, "utf8").digest("hex").slice(0, 32)}`;
}

function boundaryOutboxKey(jobId: string, digest: string): string {
  return `owner-boundary:${jobId}:${digest}`;
}

function appendEvent(
  db: SqliteDatabase,
  boundary: Pick<OwnerBoundaryRecord, "boundaryId" | "jobId">,
  action: "created" | "answered" | "revoked",
  reason: string | null,
  answerDigest: string | null,
  now: number,
): void {
  db.prepare(
    `INSERT INTO owner_boundary_events (boundary_id, job_id, action, reason, answer_digest, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(boundary.boundaryId, boundary.jobId, action, reason, answerDigest, now);
}

function parseBoundary(row: BoundaryRow): OwnerBoundaryRecord {
  if (!CODE_SET.has(row.code)) throw new Error(`Unknown owner boundary code: ${row.code}`);
  if (!STATUS_SET.has(row.status)) throw new Error(`Unknown owner boundary status: ${row.status}`);
  if (!Number.isSafeInteger(row.authority_revision) || row.authority_revision < 1) {
    throw new Error("Invalid owner boundary authority revision");
  }
  const draft = normalizeOwnerBoundary({
    code: row.code as OwnerBoundaryCode,
    goal: row.goal,
    blocker: row.blocker,
    priorChecks: JSON.parse(row.prior_checks_json) as readonly string[],
    options: JSON.parse(row.options_json) as readonly OwnerBoundaryOption[],
    recommendation: row.recommendation,
    pausedEffect: row.paused_effect,
    affectedArtifactId: row.affected_artifact_id,
    affectedEffectIdempotencyKey: row.affected_effect_idempotency_key,
  });
  if (ownerBoundaryDigest(draft) !== row.digest) throw new Error("owner boundary digest binding is invalid");
  if (row.status === "answered" && (!row.answer_text || !row.answer_digest || !SHA256.test(row.answer_digest))) {
    throw new Error("answered owner boundary is missing its decision receipt");
  }
  if (row.status === "revoked" && (!row.revoked_at || !row.revoked_reason)) {
    throw new Error("revoked owner boundary is missing its revocation facts");
  }
  return {
    ...draft,
    boundaryId: row.boundary_id,
    jobId: row.job_id,
    digest: row.digest,
    authorityId: row.authority_id,
    authorityRevision: row.authority_revision,
    ownerUserId: row.owner_user_id,
    ownerChatId: row.owner_chat_id,
    status: row.status as OwnerBoundaryStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    answeredAt: row.answered_at,
    answerText: row.answer_text,
    answerDigest: row.answer_digest,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}

function readByDigest(db: SqliteDatabase, digest: string, jobId?: string): OwnerBoundaryRecord | null {
  const row = db.prepare(
    `SELECT * FROM owner_boundaries
      WHERE digest = ? ${jobId === undefined ? "" : "AND job_id = ?"}
      ORDER BY created_at DESC, boundary_id DESC LIMIT 1`,
  ).get(...(jobId === undefined ? [digest] : [digest, jobId])) as BoundaryRow | undefined;
  return row ? parseBoundary(row) : null;
}

function authorityMatches(
  db: SqliteDatabase,
  input: Pick<CreateOwnerBoundaryInput, "jobId" | "authorityId" | "authorityRevision" | "ownerUserId" | "ownerChatId">,
): boolean {
  const row = db.prepare(
    `SELECT authority_id, job_id, revision, owner_user_id, owner_chat_id, status
       FROM task_authorities WHERE authority_id = ? AND job_id = ?`,
  ).get(input.authorityId, input.jobId) as {
    authority_id: string;
    job_id: string;
    revision: number;
    owner_user_id: string;
    owner_chat_id: string;
    status: string;
  } | undefined;
  return row !== undefined && row.status === "active" && row.revision === input.authorityRevision &&
    row.owner_user_id === input.ownerUserId && row.owner_chat_id === input.ownerChatId;
}

function persistBoundaryOutbox(
  db: SqliteDatabase,
  boundary: OwnerBoundaryRecord,
  now: number,
): void {
  const payloadJson = JSON.stringify({
    text: renderOwnerBoundary(boundary),
    disable_web_page_preview: true,
  });
  if (Buffer.byteLength(payloadJson, "utf8") > 64_000) throw new TypeError("owner boundary message is too large");
  db.prepare(
    `INSERT OR IGNORE INTO outbox (
       logical_key, chat_id, message_id, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, NULL, ?, 'pending', 0, ?, ?, ?)`,
  ).run(boundaryOutboxKey(boundary.jobId, boundary.digest), boundary.ownerChatId, payloadJson, now, now, now);
}

function persistReconcileEffect(db: SqliteDatabase, boundary: OwnerBoundaryRecord, now: number): void {
  const key = `${boundary.jobId}:owner-boundary:${boundary.digest}:reconcile`;
  const payload = JSON.stringify({
    boundaryDigest: boundary.digest,
    jobId: boundary.jobId,
    authorityId: boundary.authorityId,
    authorityRevision: boundary.authorityRevision,
    affectedArtifactId: boundary.affectedArtifactId,
    affectedEffectIdempotencyKey: boundary.affectedEffectIdempotencyKey,
  });
  db.prepare(
    `INSERT OR IGNORE INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, 'reconcile_job', ?, 'pending', 0, ?, ?, ?)`,
  ).run(key, boundary.jobId, payload, now, now, now);
}

export class OwnerBoundaryRepository {
  public constructor(private readonly db: SqliteDatabase) {}

  public record(input: CreateOwnerBoundaryInput): OwnerBoundaryRecord | null {
    assertIdentifier(input.jobId, "jobId");
    assertIdentifier(input.authorityId, "authorityId");
    assertIdentifier(input.ownerUserId, "ownerUserId");
    assertIdentifier(input.ownerChatId, "ownerChatId");
    assertPositiveInteger(input.authorityRevision, "authorityRevision");
    assertNonNegativeInteger(input.now, "now");
    if (!authorityMatches(this.db, input)) return null;
    const draft = normalizeOwnerBoundary(input);
    const digest = ownerBoundaryDigest(draft);
    const existing = readByDigest(this.db, digest, input.jobId);
    if (existing) return existing;
    const boundary: OwnerBoundaryRecord = {
      ...draft,
      boundaryId: boundaryId(input.jobId, digest),
      jobId: input.jobId,
      digest,
      authorityId: input.authorityId,
      authorityRevision: input.authorityRevision,
      ownerUserId: input.ownerUserId,
      ownerChatId: input.ownerChatId,
      status: "pending",
      createdAt: input.now,
      updatedAt: input.now,
      answeredAt: null,
      answerText: null,
      answerDigest: null,
      revokedAt: null,
      revokedReason: null,
    };
    this.db.prepare(
      `INSERT INTO owner_boundaries (
         boundary_id, job_id, digest, authority_id, authority_revision, code,
         goal, blocker, prior_checks_json, options_json, recommendation, paused_effect,
         affected_artifact_id, affected_effect_idempotency_key, owner_user_id, owner_chat_id,
         status, created_at, updated_at, answered_at, answer_text, answer_digest, revoked_at, revoked_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, NULL, NULL)`,
    ).run(
      boundary.boundaryId,
      boundary.jobId,
      boundary.digest,
      boundary.authorityId,
      boundary.authorityRevision,
      boundary.code,
      boundary.goal,
      boundary.blocker,
      JSON.stringify(boundary.priorChecks),
      JSON.stringify(boundary.options),
      boundary.recommendation,
      boundary.pausedEffect,
      boundary.affectedArtifactId,
      boundary.affectedEffectIdempotencyKey,
      boundary.ownerUserId,
      boundary.ownerChatId,
      boundary.createdAt,
      boundary.updatedAt,
    );
    appendEvent(this.db, boundary, "created", null, null, input.now);
    persistBoundaryOutbox(this.db, boundary, input.now);
    return readByDigest(this.db, digest, input.jobId);
  }

  public get(digest: string, jobId?: string): OwnerBoundaryRecord | null {
    assertDigest(digest, "boundary digest");
    if (jobId !== undefined) assertIdentifier(jobId, "jobId");
    return readByDigest(this.db, digest, jobId);
  }

  public listForJob(jobId: string): readonly OwnerBoundaryRecord[] {
    assertIdentifier(jobId, "jobId");
    const rows = this.db.prepare(
      "SELECT * FROM owner_boundaries WHERE job_id = ? ORDER BY created_at ASC, boundary_id ASC",
    ).all(jobId) as BoundaryRow[];
    return rows.map(parseBoundary);
  }

  public getPendingForReply(input: Readonly<{ ownerChatId: string; messageId: number }>): OwnerBoundaryRecord | null {
    assertIdentifier(input.ownerChatId, "ownerChatId");
    assertPositiveInteger(input.messageId, "messageId");
    const row = this.db.prepare(
      `SELECT boundary.*
         FROM owner_boundaries AS boundary
         JOIN outbox ON outbox.logical_key = 'owner-boundary:' || boundary.job_id || ':' || boundary.digest
        WHERE boundary.owner_chat_id = ? AND boundary.status = 'pending'
          AND outbox.status = 'sent' AND outbox.message_id = ?
        ORDER BY boundary.created_at DESC, boundary.boundary_id DESC LIMIT 1`,
    ).get(input.ownerChatId, input.messageId) as BoundaryRow | undefined;
    return row ? parseBoundary(row) : null;
  }

  public answer(input: OwnerBoundaryAnswerInput): OwnerBoundaryAnswerResult {
    assertDigest(input.boundaryDigest, "boundary digest");
    assertIdentifier(input.jobId, "jobId");
    assertIdentifier(input.authorityId, "authorityId");
    assertIdentifier(input.ownerUserId, "ownerUserId");
    assertIdentifier(input.ownerChatId, "ownerChatId");
    assertPositiveInteger(input.authorityRevision, "authorityRevision");
    assertNonNegativeInteger(input.now, "now");
    const boundary = readByDigest(this.db, input.boundaryDigest, input.jobId);
    if (!boundary || boundary.authorityId !== input.authorityId || boundary.authorityRevision !== input.authorityRevision ||
      boundary.ownerUserId !== input.ownerUserId || boundary.ownerChatId !== input.ownerChatId ||
      boundary.affectedArtifactId !== (input.affectedArtifactId ?? null) ||
      boundary.affectedEffectIdempotencyKey !== (input.affectedEffectIdempotencyKey ?? null)) {
      return { outcome: "rejected" };
    }
    if (boundary.status !== "pending" || !authorityMatches(this.db, input)) {
      return { outcome: boundary.status === "answered" ? "replayed" : "rejected", boundary };
    }
    let answer: ReturnType<typeof normalizeOwnerBoundaryAnswer>;
    try {
      answer = normalizeOwnerBoundaryAnswer(input.answerText);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return { outcome: "rejected" };
    }
    const updated = this.db.prepare(
      `UPDATE owner_boundaries
          SET status = 'answered', updated_at = ?, answered_at = ?, answer_text = ?, answer_digest = ?
        WHERE boundary_id = ? AND status = 'pending'`,
    ).run(input.now, input.now, answer.answerText, answer.answerDigest, boundary.boundaryId);
    if (updated.changes !== 1) {
      const replay = this.get(input.boundaryDigest, input.jobId);
      return replay?.status === "answered" ? { outcome: "replayed", boundary: replay } : { outcome: "rejected" };
    }
    const answered = this.get(input.boundaryDigest, input.jobId);
    if (!answered) throw new Error("answered owner boundary disappeared");
    appendEvent(this.db, answered, "answered", null, answer.answerDigest, input.now);
    persistReconcileEffect(this.db, answered, input.now);
    return { outcome: "answered", boundary: answered };
  }

  public revokeForJob(jobId: string, reason: string, now: number): number {
    assertIdentifier(jobId, "jobId");
    assertReason(reason);
    assertNonNegativeInteger(now, "now");
    const pending = this.db.prepare(
      "SELECT * FROM owner_boundaries WHERE job_id = ? AND status = 'pending' ORDER BY boundary_id",
    ).all(jobId) as BoundaryRow[];
    let revokedCount = 0;
    for (const row of pending) {
      const updated = this.db.prepare(
        `UPDATE owner_boundaries
            SET status = 'revoked', updated_at = ?, revoked_at = ?, revoked_reason = ?
          WHERE boundary_id = ? AND status = 'pending'`,
      ).run(now, now, reason, row.boundary_id);
      if (updated.changes !== 1) continue;
      revokedCount += 1;
      const boundary = parseBoundary({
        ...row,
        status: "revoked",
        updated_at: now,
        revoked_at: now,
        revoked_reason: reason,
      });
      appendEvent(this.db, boundary, "revoked", reason, null, now);
      const retiredPayload = JSON.stringify({
        text: "This owner decision is no longer needed because the task was stopped.",
        disable_web_page_preview: true,
      });
      this.db.prepare(
        `UPDATE outbox SET payload_json = ?, status = CASE WHEN status = 'sent' THEN 'sent' ELSE 'pending' END,
            lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL,
            next_attempt_at = ?, last_error = NULL, updated_at = ?
          WHERE logical_key = ? AND status <> 'dead'`,
      ).run(retiredPayload, now, now, boundaryOutboxKey(boundary.jobId, boundary.digest));
    }
    return revokedCount;
  }
}
