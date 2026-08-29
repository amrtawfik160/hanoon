import type Database from "better-sqlite3";
import type { TelegramAgentStore } from "../storage/store";
import type { NavigatorLiveScenario } from "./promotion";

export type NavigatorLiveScenarioRun = Readonly<{
  scenario: NavigatorLiveScenario;
  jobId: string;
  terminalState: "complete" | "merged" | "cancelled";
}>;

function count(
  database: Database.Database,
  sql: string,
  params: readonly unknown[],
): number {
  const row = database.prepare(sql).get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function navigatorLiveScenarioHasRequiredEvidence(
  store: TelegramAgentStore,
  database: Database.Database,
  run: NavigatorLiveScenarioRun,
): boolean {
  const job = store.getJob(run.jobId);
  if (!job || job.workflowEngine !== "navigator-v1" || job.state !== run.terminalState) {
    return false;
  }
  const effects = store.listEffectsForJob(run.jobId);
  switch (run.scenario) {
    case "happy_path":
      return run.terminalState === "complete" &&
        job.prNumber !== null &&
        effects.some((effect) => effect.kind === "deploy_production" && effect.status === "done") &&
        effects.some((effect) => effect.kind === "verify_production" && effect.status === "done");
    case "interrupted_tracker_create":
      return run.terminalState === "cancelled" &&
        count(database, "SELECT COUNT(*) AS count FROM work_artifact_create_intents WHERE effort_id = ?", [run.jobId]) > 0;
    case "stale_head":
      return count(
        database,
        `SELECT COUNT(*) AS count
           FROM navigator_ticket_worker_outcomes AS outcome
           JOIN navigator_ticket_worker_attempts AS attempt ON attempt.id = outcome.attempt_id
          WHERE attempt.job_id = ? AND outcome.reason_code = 'git_observation_rejected'`,
        [run.jobId],
      ) > 0;
    case "ambiguous_merge":
      return effects.filter((effect) => effect.kind === "merge_pr").length > 1;
    case "canary_failure":
      return count(
        database,
        "SELECT COUNT(*) AS count FROM navigator_release_incidents WHERE job_id = ? AND phase = 'canary'",
        [run.jobId],
      ) > 0;
    case "successful_rollback":
      return count(
        database,
        "SELECT COUNT(*) AS count FROM navigator_release_incidents WHERE job_id = ? AND rollback_outcome = 'pass'",
        [run.jobId],
      ) > 0;
    case "repair":
      return count(
        database,
        `SELECT COUNT(*) AS count
           FROM navigator_ticket_repair_proposals AS proposal
           JOIN navigator_ticket_repair_snapshots AS snapshot ON snapshot.id = proposal.snapshot_id
          WHERE snapshot.job_id = ?`,
        [run.jobId],
      ) > 0;
    case "re_release":
      return effects.filter((effect) => effect.kind === "run_navigator_release").length >= 2 ||
        (count(database, "SELECT COUNT(*) AS count FROM navigator_release_findings WHERE job_id = ?", [run.jobId]) > 0 &&
          effects.filter((effect) => effect.kind === "run_navigator_release").length >= 1);
    default:
      return false;
  }
}

export function assertNavigatorLiveScenarioEvidence(
  store: TelegramAgentStore,
  database: Database.Database,
  run: NavigatorLiveScenarioRun,
): void {
  if (!navigatorLiveScenarioHasRequiredEvidence(store, database, run)) {
    throw new TypeError(
      `Navigator live evidence for ${run.scenario} is not an executed disposable run`,
    );
  }
}
