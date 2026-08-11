import type Database from "better-sqlite3";
import {
  MAX_CONCURRENT_JOBS,
  projectResourceKey,
  productionResourceKey,
  repositoryMergeResourceKey,
  RELEASE_CANDIDATE_JOB_STATES,
  type AdmissionResumeEvent,
  type AdmissionState,
  type JobAdmission,
  type JobResourceClaim,
  type MaxConcurrentJobs,
  type ResourceKind,
} from "../autonomy/models";
import { transition } from "../domain/state-machine";
import type { Job, JobEvent, ProjectPolicy } from "../domain/models";
import {
  JOB_SELECT,
  VersionConflictError,
  parseJobRow,
  persistJobTransition,
  persistPendingEffects,
  readJobById,
  type JobRow,
} from "./job-persistence";

type SqliteDatabase = Database.Database;

export type AdmissionWriteInput = Readonly<{
  jobId: string;
  expectedVersion: number;
  projectId: string;
  resumeEvent: AdmissionResumeEvent;
  now: number;
}>;

export type AdmissionAttemptInput = Readonly<{
  jobId: string;
  maxConcurrentJobs: MaxConcurrentJobs;
  ownerId: string;
  generation: number;
  now: number;
  leaseMs: number;
}>;

export type ClaimAdoptionInput = Readonly<{
  jobId: string;
  ownerId: string;
  generation: number;
  now: number;
  leaseMs: number;
}>;

export type AdmissionRejection =
  | "executor_lease_lost"
  | "admission_missing"
  | "job_missing"
  | "identity_mismatch"
  | "cancellation_requested"
  | "illegal_resume_state"
  | "capacity"
  | "project_busy"
  | "claim_conflict";

export type AdmissionAttempt =
  | Readonly<{
      outcome: "admitted";
      job: Job;
      admission: JobAdmission;
      claim: JobResourceClaim;
    }>
  | Readonly<{
      outcome: "not_admitted";
      reason: AdmissionRejection;
    }>;

export class AutonomyAdmissionConflictError extends Error {
  public constructor(jobId: string, reason: string) {
    super(`Autonomy admission ${jobId} identity conflict: ${reason}`);
    this.name = "AutonomyAdmissionConflictError";
  }
}

class AdmissionWriteConflictError extends Error {
  public constructor() {
    super("Autonomy admission changed during atomic admission");
    this.name = "AdmissionWriteConflictError";
  }
}

type AdmissionRow = {
  job_id: string;
  project_id: string;
  queue_seq: number;
  state: string;
  resume_event: string;
  queued_at: number;
  admitted_at: number | null;
  draining_at: number | null;
  released_at: number | null;
  release_reason: string | null;
};

type ClaimRow = {
  claim_id: number;
  job_id: string;
  resource_key: string;
  resource_kind: string;
  state: string;
  owner_id: string;
  generation: number;
  lease_expires_at: number;
  acquired_at: number;
  renewed_at: number;
  released_at: number | null;
  release_reason: string | null;
};

export type AdmissionWriteMode = "queue" | "requeue";

const ADMISSION_STATES: ReadonlySet<AdmissionState> = new Set([
  "queued",
  "admitted",
  "draining",
  "released",
]);
const RESUME_EVENTS: ReadonlySet<AdmissionResumeEvent> = new Set([
  "CONFIRMED",
  "CONTINUE_REVIEW",
]);
const RESOURCE_KINDS: ReadonlySet<ResourceKind> = new Set([
  "project",
  "repository_merge",
  "production_target",
]);
const CLAIM_STATES = new Set(["held", "released"]);
export const MAX_AUTONOMY_ROWS = 100;
const MAX_SCHEDULER_CANDIDATES = 16;

export type ResourceWaitProjection = Readonly<{
  kind: "repository_merge" | "production_target";
  key: string;
}>;

export type ResourceWaitProjectionInput = Readonly<{
  jobId: string;
  policy: ProjectPolicy;
  claims: readonly Pick<JobResourceClaim, "jobId" | "resourceKey" | "resourceKind" | "state">[];
}>;

export function projectResourceWait(
  input: ResourceWaitProjectionInput,
): ResourceWaitProjection[] {
  const heldKeys = new Set(
    input.claims
      .filter((claim) => claim.state === "held" && claim.jobId !== input.jobId)
      .map((claim) => `${claim.resourceKind}\u0000${claim.resourceKey}`),
  );
  const required = [
    {
      kind: "repository_merge" as const,
      key: repositoryMergeResourceKey(input.policy.githubRepository),
    },
    ...(input.policy.production === undefined ? [] : [{
      kind: "production_target" as const,
      key: productionResourceKey(input.policy),
    }]),
  ].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  return required
    .filter((resource) => heldKeys.has(`${resource.kind}\u0000${resource.key}`))
    .slice(0, 3);
}
const ADMISSION_SELECT = `
  SELECT job_id, project_id, queue_seq, state, resume_event, queued_at,
         admitted_at, draining_at, released_at, release_reason
    FROM job_admissions`;
const CLAIM_SELECT = `
  SELECT claim_id, job_id, resource_key, resource_kind, state, owner_id,
         generation, lease_expires_at, acquired_at, renewed_at, released_at,
         release_reason
    FROM job_resource_claims`;

function assertIdentifier(value: string, field: string, maxLength: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${field} must be a bounded non-empty string`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
}

function assertMaxConcurrentJobs(value: number): asserts value is MaxConcurrentJobs {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONCURRENT_JOBS) {
    throw new TypeError("maxConcurrentJobs must be an integer from 1 through 8");
  }
}

function boundedLimit(requestedLimit: number, maximum: number): number {
  assertPositiveInteger(requestedLimit, "limit");
  return Math.min(requestedLimit, maximum);
}

function parseAdmission(row: AdmissionRow): JobAdmission {
  if (!ADMISSION_STATES.has(row.state as AdmissionState)) {
    throw new Error(`Unknown persisted admission state: ${row.state}`);
  }
  if (!RESUME_EVENTS.has(row.resume_event as AdmissionResumeEvent)) {
    throw new Error(`Unknown persisted admission resume event: ${row.resume_event}`);
  }
  return {
    jobId: row.job_id,
    projectId: row.project_id,
    queueSeq: row.queue_seq,
    state: row.state as AdmissionState,
    resumeEvent: row.resume_event as AdmissionResumeEvent,
    queuedAt: row.queued_at,
    admittedAt: row.admitted_at,
    drainingAt: row.draining_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
  };
}

function parseClaim(row: ClaimRow): JobResourceClaim {
  if (!RESOURCE_KINDS.has(row.resource_kind as ResourceKind)) {
    throw new Error(`Unknown persisted resource kind: ${row.resource_kind}`);
  }
  if (!CLAIM_STATES.has(row.state)) throw new Error(`Unknown persisted claim state: ${row.state}`);
  return {
    claimId: row.claim_id,
    jobId: row.job_id,
    resourceKey: row.resource_key,
    resourceKind: row.resource_kind as ResourceKind,
    state: row.state as JobResourceClaim["state"],
    ownerId: row.owner_id,
    generation: row.generation,
    leaseExpiresAt: row.lease_expires_at,
    acquiredAt: row.acquired_at,
    renewedAt: row.renewed_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
  };
}

function admissionStates(states: readonly AdmissionState[]): AdmissionState[] {
  const stateNames = [...new Set(states)];
  for (const stateName of stateNames) {
    if (!ADMISSION_STATES.has(stateName)) throw new TypeError(`Unknown admission state: ${stateName}`);
  }
  return stateNames;
}

function assertWriteInput(input: AdmissionWriteInput): void {
  assertIdentifier(input.jobId, "jobId", 256);
  assertPositiveInteger(input.expectedVersion, "expectedVersion");
  assertIdentifier(input.projectId, "projectId", 200);
  if (!RESUME_EVENTS.has(input.resumeEvent)) throw new TypeError("resumeEvent is invalid");
  assertNonNegativeInteger(input.now, "now");
}

function assertAdmissionAttemptInput(input: AdmissionAttemptInput): void {
  assertIdentifier(input.jobId, "jobId", 256);
  assertMaxConcurrentJobs(input.maxConcurrentJobs);
  assertIdentifier(input.ownerId, "ownerId", 256);
  assertPositiveInteger(input.generation, "generation");
  assertNonNegativeInteger(input.now, "now");
  assertPositiveInteger(input.leaseMs, "leaseMs");
  if (input.now > Number.MAX_SAFE_INTEGER - input.leaseMs) {
    throw new TypeError("now plus leaseMs must be a safe integer");
  }
}

function assertClaimAdoptionInput(input: ClaimAdoptionInput): void {
  assertIdentifier(input.jobId, "jobId", 256);
  assertIdentifier(input.ownerId, "ownerId", 256);
  assertPositiveInteger(input.generation, "generation");
  assertNonNegativeInteger(input.now, "now");
  assertPositiveInteger(input.leaseMs, "leaseMs");
  if (input.now > Number.MAX_SAFE_INTEGER - input.leaseMs) {
    throw new TypeError("now plus leaseMs must be a safe integer");
  }
}

function assertJobIdentity(job: Job, input: AdmissionWriteInput): void {
  if (job.version !== input.expectedVersion) throw new VersionConflictError(input.jobId, input.expectedVersion);
  if (
    job.projectId !== input.projectId ||
    job.policy === null ||
    job.policy.projectId !== input.projectId ||
    job.policyVersion === null ||
    job.policyVersion < 1
  ) {
    throw new AutonomyAdmissionConflictError(input.jobId, "project or immutable policy project does not match");
  }
}

function assertContinuationState(job: Job, resumeEvent: AdmissionResumeEvent): void {
  if (resumeEvent === "CONTINUE_REVIEW" && (job.state !== "blocked" || job.blockedReason !== "review_limit")) {
    throw new AutonomyAdmissionConflictError(job.id, "review continuation requires a review-limit block");
  }
}

function readAdmission(db: SqliteDatabase, jobId: string): JobAdmission | null {
  const row = db.prepare(`${ADMISSION_SELECT} WHERE job_id = ?`).get(jobId) as AdmissionRow | undefined;
  return row ? parseAdmission(row) : null;
}

function readSequence(db: SqliteDatabase): number {
  const row = db
    .prepare("SELECT next_queue_seq FROM autonomy_sequence WHERE singleton = 1")
    .get() as { next_queue_seq: number } | undefined;
  if (!row) throw new Error("Autonomy sequence was not initialized");
  assertPositiveInteger(row.next_queue_seq, "next_queue_seq");
  return row.next_queue_seq;
}

function allocateQueueSequence(db: SqliteDatabase): number {
  const queueSeq = readSequence(db);
  const advanced = db
    .prepare(
      `UPDATE autonomy_sequence
          SET next_queue_seq = next_queue_seq + 1
        WHERE singleton = 1 AND next_queue_seq = ?`,
    )
    .run(queueSeq);
  if (advanced.changes !== 1) throw new Error("Autonomy queue sequence changed during allocation");
  return queueSeq;
}

function insertQueuedAdmission(
  db: SqliteDatabase,
  input: AdmissionWriteInput,
  queueSeq: number,
): JobAdmission {
  db.prepare(
    `INSERT INTO job_admissions (
       job_id, project_id, queue_seq, state, resume_event, queued_at,
       admitted_at, draining_at, released_at, release_reason
     ) VALUES (?, ?, ?, 'queued', ?, ?, NULL, NULL, NULL, NULL)`,
  ).run(input.jobId, input.projectId, queueSeq, input.resumeEvent, input.now);
  const admission = readAdmission(db, input.jobId);
  if (!admission) throw new Error(`Admission ${input.jobId} was not stored`);
  return admission;
}

function replaceReleasedAdmission(
  db: SqliteDatabase,
  input: AdmissionWriteInput,
  queueSeq: number,
): JobAdmission {
  const updated = db
    .prepare(
      `UPDATE job_admissions
          SET project_id = ?, queue_seq = ?, state = 'queued', resume_event = ?,
              queued_at = ?, admitted_at = NULL, draining_at = NULL,
              released_at = NULL, release_reason = NULL
        WHERE job_id = ? AND state = 'released'`,
    )
    .run(input.projectId, queueSeq, input.resumeEvent, input.now, input.jobId);
  if (updated.changes !== 1) throw new Error(`Released admission ${input.jobId} was not replaced`);
  const admission = readAdmission(db, input.jobId);
  if (!admission) throw new Error(`Admission ${input.jobId} was not stored after replacement`);
  return admission;
}

function assertReplayIdentity(existing: JobAdmission, input: AdmissionWriteInput): void {
  if (existing.projectId !== input.projectId || existing.resumeEvent !== input.resumeEvent) {
    throw new AutonomyAdmissionConflictError(input.jobId, "project or resume event changed");
  }
}

function persistQueuedAdmission(
  db: SqliteDatabase,
  input: AdmissionWriteInput,
  mode: AdmissionWriteMode,
): JobAdmission {
  const job = readJobById(db, input.jobId);
  if (!job) throw new Error(`Job ${input.jobId} was not found`);
  assertJobIdentity(job, input);
  assertContinuationState(job, input.resumeEvent);

  const existing = readAdmission(db, input.jobId);
  if (existing && existing.state !== "released") {
    assertReplayIdentity(existing, input);
    return existing;
  }
  if (!existing && mode === "requeue") {
    throw new AutonomyAdmissionConflictError(input.jobId, "there is no released admission to requeue");
  }

  const queueSeq = allocateQueueSequence(db);
  return existing ? replaceReleasedAdmission(db, input, queueSeq) : insertQueuedAdmission(db, input, queueSeq);
}

export function queueAdmissionInTransaction(
  db: SqliteDatabase,
  input: AdmissionWriteInput,
  mode: AdmissionWriteMode = "queue",
): JobAdmission {
  assertWriteInput(input);
  return persistQueuedAdmission(db, input, mode);
}

function currentExecutorLease(
  db: SqliteDatabase,
  input: Pick<AdmissionAttemptInput, "ownerId" | "generation" | "now">,
): boolean {
  return db.prepare(
    `SELECT 1 FROM executor_lease
      WHERE singleton = 1 AND owner_id = ? AND generation = ? AND lease_expires_at > ?`,
  ).get(input.ownerId, input.generation, input.now) !== undefined;
}

function resumeEventForAdmission(job: Job, resumeEvent: AdmissionResumeEvent): JobEvent | null {
  if (resumeEvent === "CONFIRMED" && job.state === "awaiting_confirmation") return { type: "CONFIRMED" };
  if (resumeEvent === "CONTINUE_REVIEW" && job.state === "blocked" && job.blockedReason === "review_limit") {
    return { type: "CONTINUE_REVIEW" };
  }
  return null;
}

function readHeldProjectClaim(db: SqliteDatabase, resourceKey: string): JobResourceClaim | null {
  const row = db.prepare(
    `${CLAIM_SELECT} WHERE resource_key = ? AND resource_kind = 'project' AND state = 'held' LIMIT 1`,
  ).get(resourceKey) as ClaimRow | undefined;
  return row ? parseClaim(row) : null;
}

function countOccupiedAdmissions(db: SqliteDatabase): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS count FROM job_admissions WHERE state IN ('admitted', 'draining')",
  ).get() as { count: number };
  if (!Number.isSafeInteger(row.count) || row.count < 0) throw new Error("Occupied admission count is invalid");
  return row.count;
}

function notAdmitted(reason: AdmissionRejection): AdmissionAttempt {
  return { outcome: "not_admitted", reason };
}

function sqliteErrorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return (error as { code?: unknown }).code;
}

function isExpectedAdmissionContention(error: unknown): boolean {
  const code = sqliteErrorCode(error);
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

function isExpectedClaimConstraint(error: unknown): boolean {
  const code = sqliteErrorCode(error);
  return code === "SQLITE_CONSTRAINT_UNIQUE";
}

function tryAdmitInTransaction(db: SqliteDatabase, input: AdmissionAttemptInput): AdmissionAttempt {
  if (!currentExecutorLease(db, input)) return notAdmitted("executor_lease_lost");

  const admission = readAdmission(db, input.jobId);
  if (!admission || admission.state !== "queued") return notAdmitted("admission_missing");
  const job = readJobById(db, input.jobId);
  if (!job) return notAdmitted("job_missing");
  if (
    job.projectId !== admission.projectId ||
    job.policy?.projectId !== admission.projectId ||
    job.policyVersion === null ||
    job.policyVersion < 1
  ) {
    return notAdmitted("identity_mismatch");
  }
  if (job.cancelRequestedAt !== null) return notAdmitted("cancellation_requested");
  const event = resumeEventForAdmission(job, admission.resumeEvent);
  if (!event) return notAdmitted("illegal_resume_state");
  if (countOccupiedAdmissions(db) >= input.maxConcurrentJobs) return notAdmitted("capacity");

  const resourceKey = projectResourceKey(admission.projectId);
  if (readHeldProjectClaim(db, resourceKey)) return notAdmitted("project_busy");
  let claimInserted: { changes: number };
  try {
    claimInserted = db.prepare(
      `INSERT INTO job_resource_claims (
         job_id, resource_key, resource_kind, state, owner_id, generation,
         lease_expires_at, acquired_at, renewed_at, released_at, release_reason
       ) VALUES (?, ?, 'project', 'held', ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      input.jobId,
      resourceKey,
      input.ownerId,
      input.generation,
      input.now + input.leaseMs,
      input.now,
      input.now,
    );
  } catch (error) {
    if (isExpectedClaimConstraint(error)) return notAdmitted("claim_conflict");
    throw error;
  }
  if (claimInserted.changes !== 1) throw new AdmissionWriteConflictError();

  const admissionUpdated = db.prepare(
    `UPDATE job_admissions
        SET state = 'admitted', admitted_at = ?
      WHERE job_id = ? AND state = 'queued' AND project_id = ?`,
  ).run(input.now, input.jobId, admission.projectId);
  if (admissionUpdated.changes !== 1) throw new AdmissionWriteConflictError();

  const transitioned = transition(job, event, input.now);
  persistJobTransition(db, job.id, job.version, transitioned.job);
  persistPendingEffects(db, transitioned.effects, input.now);

  const admitted = readAdmission(db, input.jobId);
  const claim = readHeldProjectClaim(db, resourceKey);
  if (!admitted || !claim) throw new Error("Admitted job lost its durable claim or admission");
  return { outcome: "admitted", job: transitioned.job, admission: admitted, claim };
}
export class AutonomyRepository {
  public constructor(private readonly db: SqliteDatabase) {}

  /**
   * Updates only the admission side of a terminal transition. The caller must
   * already be inside its owning immediate transaction so the job transition
   * and this lane transition cannot be observed separately.
   */
  public markDrainingInTransaction(jobId: string, now: number): JobAdmission | null {
    assertIdentifier(jobId, "jobId", 256);
    assertNonNegativeInteger(now, "now");
    const current = readAdmission(this.db, jobId);
    if (!current || current.state !== "admitted") return current;
    const updated = this.db
      .prepare(
        `UPDATE job_admissions
            SET state = 'draining', draining_at = ?
          WHERE job_id = ? AND state = 'admitted'`,
      )
      .run(now, jobId);
    if (updated.changes !== 1) throw new AdmissionWriteConflictError();
    return readAdmission(this.db, jobId);
  }

  /**
   * Releases an admission after the caller has proved that all worker and
   * effect cleanup prerequisites hold. This method intentionally does not
   * touch claims; claim release belongs to the same caller transaction.
   */
  public releaseInTransaction(jobId: string, now: number, reason: string): JobAdmission | null {
    assertIdentifier(jobId, "jobId", 256);
    assertNonNegativeInteger(now, "now");
    assertIdentifier(reason, "releaseReason", 160);
    const current = readAdmission(this.db, jobId);
    if (!current || current.state === "released") return current;
    const updated = this.db
      .prepare(
        `UPDATE job_admissions
            SET state = 'released', released_at = ?, release_reason = ?
          WHERE job_id = ? AND state IN ('queued', 'draining')`,
      )
      .run(now, reason, jobId);
    if (updated.changes !== 1) throw new AdmissionWriteConflictError();
    return readAdmission(this.db, jobId);
  }

  public queueAdmission(input: AdmissionWriteInput): JobAdmission {
    const write = this.db.transaction(() => queueAdmissionInTransaction(this.db, input, "queue"));
    return write.immediate();
  }

  public requeueAdmission(input: AdmissionWriteInput): JobAdmission {
    const write = this.db.transaction(() => queueAdmissionInTransaction(this.db, input, "requeue"));
    return write.immediate();
  }

  public tryAdmit(input: AdmissionAttemptInput): AdmissionAttempt {
    assertAdmissionAttemptInput(input);
    const attempt = this.db.transaction(() => tryAdmitInTransaction(this.db, input));
    try {
      return attempt.immediate();
    } catch (error) {
      if (error instanceof AdmissionWriteConflictError || isExpectedAdmissionContention(error)) {
        return notAdmitted("claim_conflict");
      }
      throw error;
    }
  }

  public adoptHeldClaims(input: ClaimAdoptionInput): boolean {
    assertClaimAdoptionInput(input);
    const adopt = this.db.transaction((): boolean => {
      if (!currentExecutorLease(this.db, input)) return false;
      const admission = readAdmission(this.db, input.jobId);
      if (!admission || (admission.state !== "admitted" && admission.state !== "draining")) return false;
      const requiredProjectClaim = this.db
        .prepare(
          `SELECT claim_id FROM job_resource_claims
             WHERE job_id = ? AND resource_key = ? AND resource_kind = 'project' AND state = 'held'
             LIMIT 1`,
        )
        .get(input.jobId, projectResourceKey(admission.projectId));
      if (!requiredProjectClaim) return false;
      const heldClaims = this.db
        .prepare(
          `SELECT claim_id FROM job_resource_claims
             WHERE job_id = ? AND state = 'held'
             ORDER BY claim_id ASC LIMIT ?`,
        )
        .all(input.jobId, MAX_AUTONOMY_ROWS + 1) as Array<{ claim_id: number }>;
      if (heldClaims.length === 0 || heldClaims.length > MAX_AUTONOMY_ROWS) return false;
      const updated = this.db
        .prepare(
          `UPDATE job_resource_claims
              SET owner_id = ?, generation = ?, lease_expires_at = ?, renewed_at = ?
            WHERE job_id = ? AND state = 'held'`,
        )
        .run(
          input.ownerId,
          input.generation,
          input.now + input.leaseMs,
          input.now,
          input.jobId,
        );
      return updated.changes === heldClaims.length;
    });
    return adopt.immediate();
  }

  public getAdmission(jobId: string): JobAdmission | null {
    assertIdentifier(jobId, "jobId", 256);
    return readAdmission(this.db, jobId);
  }

  public listAdmissions(states: readonly AdmissionState[], requestedLimit: number): JobAdmission[] {
    const stateNames = admissionStates(states);
    if (stateNames.length === 0) return [];
    const limit = boundedLimit(requestedLimit, MAX_AUTONOMY_ROWS);
    const placeholders = stateNames.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `${ADMISSION_SELECT}
          WHERE state IN (${placeholders})
          ORDER BY queue_seq ASC, job_id ASC
          LIMIT ?`,
      )
      .all(...stateNames, limit) as AdmissionRow[];
    return rows.map(parseAdmission);
  }

  public listReleaseCandidates(requestedLimit: number): JobAdmission[] {
    const limit = boundedLimit(requestedLimit, MAX_AUTONOMY_ROWS);
    const releaseStatePlaceholders = RELEASE_CANDIDATE_JOB_STATES.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT admission.job_id, admission.project_id, admission.queue_seq,
                admission.state, admission.resume_event, admission.queued_at,
                admission.admitted_at, admission.draining_at, admission.released_at,
                admission.release_reason
           FROM job_admissions AS admission
           JOIN jobs AS job ON job.id = admission.job_id
          WHERE (
            admission.state IN ('admitted', 'draining')
            AND job.state IN (${releaseStatePlaceholders})
          ) OR (
            admission.state = 'queued' AND job.state = 'cancelled'
          )
          ORDER BY CASE WHEN admission.state IN ('admitted', 'draining') THEN 0 ELSE 1 END,
                   admission.queue_seq ASC, admission.job_id ASC
          LIMIT ?`,
      )
      .all(...RELEASE_CANDIDATE_JOB_STATES, limit) as AdmissionRow[];
    return rows.map(parseAdmission);
  }

  public listOldestQueuedPerProject(requestedLimit: number): JobAdmission[] {
    const limit = boundedLimit(requestedLimit, MAX_SCHEDULER_CANDIDATES);
    const rows = this.db
      .prepare(
        `SELECT job_id, project_id, queue_seq, state, resume_event, queued_at,
                admitted_at, draining_at, released_at, release_reason
           FROM (
             SELECT admission.*,
                    ROW_NUMBER() OVER (
                      PARTITION BY project_id ORDER BY queue_seq ASC, job_id ASC
                    ) AS project_rank
               FROM job_admissions AS admission
              WHERE state = 'queued'
           )
          WHERE project_rank = 1
          ORDER BY queue_seq ASC, job_id ASC
          LIMIT ?`,
      )
      .all(limit) as AdmissionRow[];
    return rows.map(parseAdmission);
  }

  public listOccupiedAdmissions(requestedLimit: number): JobAdmission[] {
    const limit = boundedLimit(requestedLimit, MAX_AUTONOMY_ROWS);
    const rows = this.db
      .prepare(
        `${ADMISSION_SELECT}
          WHERE state IN ('admitted', 'draining')
          ORDER BY queue_seq ASC, job_id ASC
          LIMIT ?`,
      )
      .all(limit) as AdmissionRow[];
    return rows.map(parseAdmission);
  }

  public countOccupiedAdmissions(): number {
    return countOccupiedAdmissions(this.db);
  }

  public listHeldClaims(jobId: string | null, requestedLimit: number): JobResourceClaim[] {
    if (jobId !== null) assertIdentifier(jobId, "jobId", 256);
    const limit = boundedLimit(requestedLimit, MAX_AUTONOMY_ROWS);
    const predicate = jobId === null ? "" : " WHERE job_id = ?";
    const parameters = jobId === null ? [limit] : [jobId, limit];
    const rows = this.db
      .prepare(`${CLAIM_SELECT}${predicate} ORDER BY claim_id ASC LIMIT ?`)
      .all(...parameters) as ClaimRow[];
    return rows.map(parseClaim);
  }

  public listCurrentHeldClaims(jobId: string, requestedLimit: number): JobResourceClaim[] {
    assertIdentifier(jobId, "jobId", 256);
    const limit = boundedLimit(requestedLimit, MAX_AUTONOMY_ROWS);
    const rows = this.db
      .prepare(`${CLAIM_SELECT} WHERE job_id = ? AND state = 'held' ORDER BY claim_id ASC LIMIT ?`)
      .all(jobId, limit) as ClaimRow[];
    return rows.map(parseClaim);
  }

  public listCurrentHeldProjectClaims(requestedLimit: number): JobResourceClaim[] {
    const limit = boundedLimit(requestedLimit, MAX_AUTONOMY_ROWS);
    const rows = this.db
      .prepare(`${CLAIM_SELECT} WHERE state = 'held' AND resource_kind = 'project' ORDER BY claim_id ASC LIMIT ?`)
      .all(limit) as ClaimRow[];
    return rows.map(parseClaim);
  }

  public listCurrentHeldMergeClaims(input: {
    jobId: string;
    policy: ProjectPolicy;
    limit: number;
  }): JobResourceClaim[] {
    assertIdentifier(input.jobId, "jobId", 256);
    const limit = boundedLimit(input.limit, MAX_AUTONOMY_ROWS);
    const requirements = [
      { resourceKind: "repository_merge", resourceKey: repositoryMergeResourceKey(input.policy.githubRepository) },
      ...(input.policy.production === undefined ? [] : [{
        resourceKind: "production_target",
        resourceKey: productionResourceKey(input.policy),
      }]),
    ];
    const requirementPredicate = requirements.map(() => "(resource_kind = ? AND resource_key = ?)").join(" OR ");
    const requirementParameters = requirements.flatMap((requirement) => [requirement.resourceKind, requirement.resourceKey]);
    const rows = this.db
      .prepare(
        `${CLAIM_SELECT}
           WHERE state = 'held' AND job_id <> ? AND (${requirementPredicate})
           ORDER BY resource_kind ASC, resource_key ASC, claim_id ASC
           LIMIT ?`,
      )
      .all(input.jobId, ...requirementParameters, limit) as ClaimRow[];
    return rows.map(parseClaim);
  }

  public findJobByStatusMessageId(messageId: number): Job | null {
    assertPositiveInteger(messageId, "messageId");
    const row = this.db
      .prepare(`${JOB_SELECT} WHERE status_message_id = ?`)
      .get(messageId) as JobRow | undefined;
    return row ? parseJobRow(row) : null;
  }

  public listActiveJobs(requestedLimit: number): Job[] {
    const limit = boundedLimit(requestedLimit, MAX_AUTONOMY_ROWS);
    const rows = this.db
      .prepare(
        `SELECT job.*
           FROM (${JOB_SELECT}) AS job
           JOIN job_admissions AS admission ON admission.job_id = job.id
          WHERE admission.state IN ('queued', 'admitted', 'draining')
          ORDER BY admission.queue_seq ASC, admission.job_id ASC
          LIMIT ?`,
      )
      .all(limit) as JobRow[];
    return rows.map(parseJobRow);
  }
}
