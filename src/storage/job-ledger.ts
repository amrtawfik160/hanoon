import type Database from "better-sqlite3";
import {
  decideJobLedgerUpgrade,
  type JobLedgerRow,
  type JobLedgerUpgradeDecision,
} from "../domain/job-ledger";
import {
  persistPendingEffects,
  readJobLedger,
  writeJobLedger,
} from "./job-persistence";

type SqliteDatabase = Database.Database;

export { readJobLedger, writeJobLedger };

type UpgradeJobRow = Readonly<{
  id: string;
  state: string;
  adopted_branch: string | null;
  adopted_head_sha: string | null;
  pr_head_sha: string | null;
  version: number;
}>;

export function upgradeJobsOntoLedger(db: SqliteDatabase, now: number): JobLedgerUpgradeDecision[] {
  const pending = db.prepare(
    `SELECT id, state, adopted_branch, adopted_head_sha, pr_head_sha, version
       FROM jobs
      WHERE id NOT IN (SELECT id FROM job_ledger)
      ORDER BY id`,
  ).all() as UpgradeJobRow[];
  const outcomes: JobLedgerUpgradeDecision[] = [];
  const upgrade = db.transaction(() => {
    for (const job of pending) {
      const decision = decideJobLedgerUpgrade({
        id: job.id,
        state: job.state,
        branch: job.adopted_branch,
        head: job.pr_head_sha ?? job.adopted_head_sha,
      });
      outcomes.push(decision);
      if (decision.action === "migrate") {
        writeJobLedger(db, decision.row, now);
        continue;
      }
      const cancelled = db.prepare(
        `UPDATE jobs
            SET state = 'cancelled', resume_state = ?, last_error = ?, version = ?, updated_at = ?
          WHERE id = ? AND version = ?`,
      ).run(job.state, decision.reason, job.version + 1, now, job.id, job.version);
      if (cancelled.changes !== 1) continue;
      writeJobLedger(db, {
        id: job.id,
        stage: "cancelled",
        branch: job.adopted_branch ?? "",
        head: job.pr_head_sha ?? job.adopted_head_sha ?? "",
      }, now);
      persistPendingEffects(db, [{
        idempotencyKey: `${job.id}:${job.version + 1}:render_status`,
        jobId: job.id,
        kind: "render_status",
        payload: {},
      }], now);
    }
  });
  upgrade();
  return outcomes;
}
