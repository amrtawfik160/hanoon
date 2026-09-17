import type Database from "better-sqlite3";
import { parseWorkerThreadTitle, type WorkerSkillRole } from "../agent-skills/role-resolver";
import {
  decideBootReconciliation,
  type BootGitObservation,
  type BootJobSnapshot,
  type BootReconciliationPlan,
  type BootThreadObservation,
  type BootThreadRole,
  type BootThreadSlot,
} from "../domain/boot-reconciliation";
import { type JobLedgerRow } from "../domain/job-ledger";
import { JOB_STATES, type JobState, type WorkerKind } from "../domain/models";
import { persistPendingEffects } from "./job-persistence";

type SqliteDatabase = Database.Database;

type BootJobRow = Readonly<{
  id: string;
  state: string;
  implementation_thread_id: string | null;
  review_thread_id: string | null;
  documentation_thread_id: string | null;
  stage: string;
  branch: string;
  head: string;
}>;

const THREAD_COLUMN: Readonly<Record<BootThreadSlot, string>> = {
  implementation: "implementation_thread_id",
  review: "review_thread_id",
  documentation: "documentation_thread_id",
};

function roleFromTitle(role: WorkerSkillRole): BootThreadRole {
  switch (role) {
    case "planner":
      return "plan";
    case "critic":
      return "critique";
    case "implementation":
      return "implementation";
    case "review":
      return "review";
    case "documentation":
      return "docs";
    case "final-review":
      return "final-review";
  }
}

function workerKindForRole(role: BootThreadRole | null): WorkerKind {
  if (role === "final-review") return "review";
  return role ?? "implementation";
}

function ensureOrphanLiveness(
  db: SqliteDatabase,
  jobId: string,
  threadId: string,
  role: BootThreadRole | null,
  now: number,
): { generation: number; workerKind: WorkerKind } {
  const workerKind = workerKindForRole(role);
  db.prepare(
    `INSERT INTO worker_liveness (
       job_id, worker_kind, resource_kind, resource_id, generation, state,
       source_updated_at, observed_at, stale_notified_at
     ) VALUES (?, ?, 'bb_thread', ?, 1, 'active', ?, ?, NULL)
     ON CONFLICT(job_id, resource_id) DO UPDATE SET
       worker_kind = excluded.worker_kind,
       resource_kind = 'bb_thread',
       generation = CASE
         WHEN worker_liveness.generation >= 1 THEN worker_liveness.generation
         ELSE excluded.generation
       END,
       state = 'active',
       source_updated_at = excluded.source_updated_at,
       observed_at = excluded.observed_at,
       stale_notified_at = NULL`,
  ).run(jobId, workerKind, threadId, now, now);
  const stored = db.prepare(
    `SELECT generation, worker_kind FROM worker_liveness WHERE job_id = ? AND resource_id = ?`,
  ).get(jobId, threadId) as { generation: number; worker_kind: WorkerKind } | undefined;
  if (!stored || !Number.isInteger(stored.generation) || stored.generation < 1) {
    throw new TypeError("boot orphan worker generation is required");
  }
  return { generation: stored.generation, workerKind: stored.worker_kind };
}

export function loadBootJobSnapshots(db: SqliteDatabase): BootJobSnapshot[] {
  const rows = db.prepare(
    `SELECT jobs.id, jobs.state, jobs.implementation_thread_id, jobs.review_thread_id,
            jobs.documentation_thread_id, job_ledger.stage, job_ledger.branch, job_ledger.head
       FROM jobs
       JOIN job_ledger ON job_ledger.id = jobs.id
      ORDER BY jobs.id`,
  ).all() as BootJobRow[];
  const snapshots: BootJobSnapshot[] = [];
  for (const row of rows) {
    if (!JOB_STATES.has(row.stage as JobState) || !JOB_STATES.has(row.state as JobState)) continue;
    snapshots.push({
      ledger: {
        id: row.id,
        stage: row.stage as JobLedgerRow["stage"],
        branch: row.branch,
        head: row.head,
      },
      implementationThreadId: row.implementation_thread_id,
      reviewThreadId: row.review_thread_id,
      documentationThreadId: row.documentation_thread_id,
    });
  }
  return snapshots;
}

function observeThreads(
  threads: readonly Readonly<{ threadId: string; title: string | null }>[],
): BootThreadObservation[] {
  return threads.map((thread) => {
    const identity = parseWorkerThreadTitle(thread.title);
    return {
      threadId: thread.threadId,
      jobId: identity?.jobId ?? null,
      role: identity ? roleFromTitle(identity.role) : null,
    };
  });
}

function bindAdoptedThread(
  db: SqliteDatabase,
  jobId: string,
  threadId: string,
  slot: BootThreadSlot,
): void {
  const column = THREAD_COLUMN[slot];
  db.prepare(
    `UPDATE jobs SET ${column} = ? WHERE id = ? AND ${column} IS NULL`,
  ).run(threadId, jobId);
}

function persistOrphanRetirement(
  db: SqliteDatabase,
  jobId: string,
  threadId: string,
  role: BootThreadRole | null,
  now: number,
): void {
  const worker = ensureOrphanLiveness(db, jobId, threadId, role, now);
  persistPendingEffects(db, [
    {
      idempotencyKey: `${jobId}:boot-orphan:${threadId}:render_status`,
      jobId,
      kind: "render_status",
      payload: {},
    },
    {
      idempotencyKey: `${jobId}:boot-orphan:${threadId}:stop_thread`,
      jobId,
      kind: "stop_thread",
      payload: {
        generation: worker.generation,
        resourceId: threadId,
        resourceKind: "bb_thread",
        workerKind: worker.workerKind,
      },
    },
  ], now);
}

export function applyBootReconciliation(
  db: SqliteDatabase,
  plan: BootReconciliationPlan,
  observations: readonly BootThreadObservation[],
  now: number,
): void {
  const roleByThread = new Map(observations.map((thread) => [thread.threadId, thread.role]));
  const existingJobs = new Set(
    (db.prepare("SELECT id FROM jobs").all() as Array<{ id: string }>).map((row) => row.id),
  );
  const apply = db.transaction(() => {
    for (const thread of plan.threads) {
      if (thread.action === "adopt") {
        if (thread.slot !== null) bindAdoptedThread(db, thread.jobId, thread.threadId, thread.slot);
        continue;
      }
      if (thread.jobId === null || !existingJobs.has(thread.jobId)) continue;
      persistOrphanRetirement(
        db,
        thread.jobId,
        thread.threadId,
        roleByThread.get(thread.threadId) ?? null,
        now,
      );
    }
  });
  apply();
}

export function reconcileJobsOnBoot(
  db: SqliteDatabase,
  observations: Readonly<{
    git: readonly BootGitObservation[];
    threads: readonly Readonly<{ threadId: string; title: string | null }>[];
  }>,
  now: number,
): BootReconciliationPlan {
  const parsedThreads = observeThreads(observations.threads);
  const plan = decideBootReconciliation({
    jobs: loadBootJobSnapshots(db),
    git: observations.git,
    threads: parsedThreads,
  });
  applyBootReconciliation(db, plan, parsedThreads, now);
  return plan;
}
