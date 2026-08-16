import type Database from "better-sqlite3";
import type { MaxConcurrentJobs } from "../autonomy/models";
import type { JobLaneSnapshot } from "./job-lane-runner";
import { inspectRuntimeIdentity, type ActivationHealth, type RuntimeIdentity } from "./runtime-identity";

type SqliteDatabase = Database.Database;

export type AutonomyHealth = {
  maxConcurrentJobs: MaxConcurrentJobs | null;
  admittedJobs: number;
  drainingJobs: number;
  queuedJobs: number;
  occupiedJobs: number;
  availableSlots: number | null;
  pipelineActive: number;
  controlActive: number;
  oldestQueueAgeMs: number | null;
  /**
   * Projects the failure brake is holding. Without this a jam looks
   * inexplicable from outside: free slots, nothing held, no job admitted. That
   * is exactly what the brake produces, and exactly how it read for five and a
   * half hours while the agent hunted for a fault that was not there.
   */
  pausedProjects: { projectId: string; reason: string; pausedAtMs: number }[];
  heldResources: {
    total: number;
    project: number;
    repositoryMerge: number;
    productionTarget: number;
  };
};

export type HealthReport = {
  observedAt: number;
  ok: boolean;
  problems: string[];
  executor: {
    owner: string | null;
    generation: number | null;
    leaseExpiresAt: number | null;
    heartbeatAt: number | null;
    heartbeatAgeMs: number | null;
    heartbeatStale: boolean;
    current: boolean;
  };
  work: { pendingEffects: number; deadEffects: number; oldestPendingEffectAgeMs: number | null };
  delivery: { pendingOutbox: number; deadOutbox: number; oldestPendingOutboxAgeMs: number | null };
  telegram: { nextOffset: number; failedUpdates: number };
  controller: { threadId: string | null; state: string | null; generations: number; queuedTurns: number };
  autonomy: AutonomyHealth;
  monitors: { armed: number; nextDueAt: number | null; failed: number };
  memory: { live: number; searchable: boolean };
  database: { integrity: string };
  activation: ActivationHealth | null;
};

export const EXECUTOR_HEARTBEAT_STALE_MS = 30_000;

function count(db: SqliteDatabase, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { value: number } | undefined;
  return row?.value ?? 0;
}

function oldestAge(db: SqliteDatabase, sql: string, now: number): number | null {
  const row = db.prepare(sql).get() as { oldest: number | null } | undefined;
  return row?.oldest === null || row?.oldest === undefined ? null : Math.max(0, now - row.oldest);
}

/**
 * One place the owner can look when something feels wrong. Every check reads
 * durable state directly, so it stays truthful even when the executor is stuck.
 */
export function buildHealthReport(
  db: SqliteDatabase,
  now: number,
  maxConcurrentJobs: MaxConcurrentJobs | null,
  lanes: JobLaneSnapshot,
  runtimeIdentity?: RuntimeIdentity,
): HealthReport {
  const lease = db.prepare(
    "SELECT owner_id, generation, lease_expires_at, heartbeat_at FROM executor_lease WHERE singleton = 1",
  ).get() as {
    owner_id: string | null;
    generation: number | null;
    lease_expires_at: number | null;
    heartbeat_at: number | null;
  } | undefined;
  const controller = db.prepare(
    "SELECT controller_key, bb_thread_id, state FROM controller_threads LIMIT 1",
  ).get() as { controller_key: string; bb_thread_id: string | null; state: string } | undefined;
  const pausedProjects = (db.prepare(
    `SELECT project_id, reason, paused_at FROM project_admission_pauses
      WHERE cleared_at IS NULL ORDER BY paused_at`,
  ).all() as { project_id: string; reason: string; paused_at: number }[]).map((row) => ({
    projectId: row.project_id,
    reason: row.reason,
    pausedAtMs: row.paused_at,
  }));
  const admissions = db.prepare(
    `SELECT
       SUM(CASE WHEN state = 'admitted' THEN 1 ELSE 0 END) AS admitted,
       SUM(CASE WHEN state = 'draining' THEN 1 ELSE 0 END) AS draining,
       SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) AS queued
     FROM job_admissions
     WHERE state IN ('queued', 'admitted', 'draining')`,
  ).get() as { admitted: number | null; draining: number | null; queued: number | null };
  const heldResources = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN resource_kind = 'project' THEN 1 ELSE 0 END) AS project,
       SUM(CASE WHEN resource_kind = 'repository_merge' THEN 1 ELSE 0 END) AS repository_merge,
       SUM(CASE WHEN resource_kind = 'production_target' THEN 1 ELSE 0 END) AS production_target
     FROM job_resource_claims
     WHERE state = 'held'`,
  ).get() as {
    total: number;
    project: number | null;
    repository_merge: number | null;
    production_target: number | null;
  };
  const admittedJobs = admissions.admitted ?? 0;
  const drainingJobs = admissions.draining ?? 0;
  const queuedJobs = admissions.queued ?? 0;
  const occupiedJobs = admittedJobs + drainingJobs;
  const leaseCurrent = (lease?.lease_expires_at ?? 0) > now;
  const heartbeatAt = lease?.heartbeat_at ?? null;
  const heartbeatAgeMs = heartbeatAt === null ? null : Math.max(0, now - heartbeatAt);
  const heartbeatStale = lease?.owner_id !== null && lease?.owner_id !== undefined &&
    (heartbeatAgeMs === null || heartbeatAgeMs > EXECUTOR_HEARTBEAT_STALE_MS);

  const report: HealthReport = {
    observedAt: now,
    ok: true,
    problems: [],
    executor: {
      owner: lease?.owner_id ?? null,
      generation: lease?.generation ?? null,
      leaseExpiresAt: lease?.lease_expires_at ?? null,
      heartbeatAt,
      heartbeatAgeMs,
      heartbeatStale,
      current: leaseCurrent && !heartbeatStale,
    },
    work: {
      pendingEffects: count(db, "SELECT COUNT(*) AS value FROM effects WHERE status IN ('pending', 'leased')"),
      deadEffects: count(db, "SELECT COUNT(*) AS value FROM effects WHERE status = 'dead'"),
      oldestPendingEffectAgeMs: oldestAge(
        db,
        "SELECT MIN(next_attempt_at) AS oldest FROM effects WHERE status IN ('pending', 'leased')",
        now,
      ),
    },
    delivery: {
      pendingOutbox: count(db, "SELECT COUNT(*) AS value FROM outbox WHERE status IN ('pending', 'leased')"),
      deadOutbox: count(db, "SELECT COUNT(*) AS value FROM outbox WHERE status = 'dead'"),
      oldestPendingOutboxAgeMs: oldestAge(
        db,
        "SELECT MIN(next_attempt_at) AS oldest FROM outbox WHERE status IN ('pending', 'leased')",
        now,
      ),
    },
    telegram: {
      nextOffset: count(db, "SELECT next_offset AS value FROM telegram_cursor WHERE singleton = 1"),
      failedUpdates: count(db, "SELECT COUNT(*) AS value FROM telegram_updates WHERE status = 'failed'"),
    },
    controller: {
      threadId: controller?.bb_thread_id ?? null,
      state: controller?.state ?? null,
      generations: controller
        ? count(db, "SELECT COUNT(*) AS value FROM controller_generations WHERE controller_key = ?", controller.controller_key)
        : 0,
      queuedTurns: count(db, "SELECT COUNT(*) AS value FROM controller_turns WHERE state IN ('queued', 'dispatching')"),
    },
    autonomy: {
      maxConcurrentJobs,
      admittedJobs,
      drainingJobs,
      queuedJobs,
      occupiedJobs,
      availableSlots: maxConcurrentJobs === null ? null : Math.max(0, maxConcurrentJobs - occupiedJobs),
      pipelineActive: lanes.pipelineActive,
      controlActive: lanes.controlActive,
      oldestQueueAgeMs: oldestAge(
        db,
        "SELECT MIN(queued_at) AS oldest FROM job_admissions WHERE state = 'queued'",
        now,
      ),
      pausedProjects,
      heldResources: {
        total: heldResources.total,
        project: heldResources.project ?? 0,
        repositoryMerge: heldResources.repository_merge ?? 0,
        productionTarget: heldResources.production_target ?? 0,
      },
    },
    monitors: {
      armed: count(db, "SELECT COUNT(*) AS value FROM monitors WHERE state = 'armed'"),
      // Schedules only. A thread watch carries a due time as its settling
      // window, not as a firing time, and reporting that as the next monitor
      // due would tell the operator a watch fires a minute from now when what
      // it is really waiting for is the thread.
      nextDueAt: (db.prepare(
        "SELECT MIN(due_at) AS value FROM monitors WHERE state = 'armed' AND kind = 'schedule' AND due_at IS NOT NULL",
      ).get() as { value: number | null }).value,
      failed: count(db, "SELECT COUNT(*) AS value FROM monitors WHERE state = 'failed'"),
    },
    memory: {
      live: count(db, "SELECT COUNT(*) AS value FROM memories WHERE forgotten_at IS NULL AND superseded_by IS NULL"),
      searchable: isSearchable(db),
    },
    database: { integrity: integrityCheck(db) },
    activation: runtimeIdentity ? inspectRuntimeIdentity(db, runtimeIdentity) : null,
  };

  if (!leaseCurrent) report.problems.push("the executor lease is not current");
  if (heartbeatStale) report.problems.push("the executor heartbeat is stale");
  if (maxConcurrentJobs === null) report.problems.push("concurrency configuration is invalid");
  if (report.work.deadEffects > 0) report.problems.push(`${report.work.deadEffects} job step(s) gave up`);
  if (report.delivery.deadOutbox > 0) report.problems.push(`${report.delivery.deadOutbox} message(s) could not be delivered`);
  if (report.telegram.failedUpdates > 0) report.problems.push(`${report.telegram.failedUpdates} Telegram update(s) failed`);
  if (report.monitors.failed > 0) report.problems.push(`${report.monitors.failed} monitor(s) failed`);
  // Stated even when nothing else is wrong: a paused project is the whole
  // explanation for queued work that never starts, and only the owner can lift
  // it, so the way out belongs in the same line.
  if (report.autonomy.pausedProjects.length > 0) {
    report.problems.push(
      `${report.autonomy.pausedProjects.length} project(s) paused by the failure brake and taking no work; `
      + "the owner clears one with /resume <name>",
    );
  }
  if (!report.memory.searchable) report.problems.push("memory search is unavailable");
  if (report.database.integrity !== "ok") report.problems.push(`database integrity: ${report.database.integrity}`);
  if (report.activation && !report.activation.ok) report.problems.push(...report.activation.problems);
  report.ok = report.problems.length === 0;
  return report;
}

// Recall is only real if the index answers. Probing beats assuming FTS5 exists.
function isSearchable(db: SqliteDatabase): boolean {
  try {
    db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ? LIMIT 1").get('"healthprobe"');
    return true;
  } catch {
    return false;
  }
}

function integrityCheck(db: SqliteDatabase): string {
  try {
    const row = db.prepare("PRAGMA quick_check(1)").get() as Record<string, string>;
    return Object.values(row)[0] ?? "unknown";
  } catch {
    return "unavailable";
  }
}
