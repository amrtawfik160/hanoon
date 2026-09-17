import type { Job, JobState } from "./models";

export const JOB_LEDGER_DRAIN_REASON =
  "Upgrade drained this job because its pipeline stage could not be copied onto the job ledger without guessing.";

export type JobLedgerRow = Readonly<{
  id: string;
  stage: JobState;
  branch: string;
  head: string;
}>;

export type JobLedgerUpgradeSnapshot = Readonly<{
  id: string;
  state: string;
  branch: string | null;
  head: string | null;
}>;

export type JobLedgerUpgradeDecision =
  | Readonly<{ action: "migrate"; row: JobLedgerRow }>
  | Readonly<{ action: "drain"; id: string; reason: typeof JOB_LEDGER_DRAIN_REASON }>;

const MIGRATABLE_STAGES: ReadonlySet<string> = new Set<JobState>([
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
  "production_failed",
  "complete",
  "failed",
  "blocked",
  "cancelled",
  "merged",
]);

export function ledgerFromJob(job: Pick<Job, "id" | "state" | "adoptedBranch" | "prHeadSha" | "adoptedHeadSha">): JobLedgerRow {
  return {
    id: job.id,
    stage: job.state,
    branch: job.adoptedBranch ?? "",
    head: job.prHeadSha ?? job.adoptedHeadSha ?? "",
  };
}

function isMigratableStage(state: string): state is JobState {
  return MIGRATABLE_STAGES.has(state);
}

export function decideJobLedgerUpgrade(snapshot: JobLedgerUpgradeSnapshot): JobLedgerUpgradeDecision {
  if (snapshot.id.length === 0 || !isMigratableStage(snapshot.state)) {
    return {
      action: "drain",
      id: snapshot.id,
      reason: JOB_LEDGER_DRAIN_REASON,
    };
  }
  return {
    action: "migrate",
    row: {
      id: snapshot.id,
      stage: snapshot.state,
      branch: snapshot.branch ?? "",
      head: snapshot.head ?? "",
    },
  };
}
