import { JOB_STATES, type Job, type JobState } from "./models";

export const JOB_LEDGER_DRAIN_REASON =
  "Upgrade drained this job because its pipeline stage could not be copied onto the job ledger without guessing.";

export const JOB_LEDGER_HEAD = /^(?:|[0-9a-f]{40})$/;

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

export function ledgerFromJob(job: Pick<Job, "id" | "state" | "adoptedBranch" | "prHeadSha" | "adoptedHeadSha">): JobLedgerRow {
  return {
    id: job.id,
    stage: job.state,
    branch: job.adoptedBranch ?? "",
    head: job.prHeadSha ?? job.adoptedHeadSha ?? "",
  };
}

export function readableJobLedgerHead(head: string | null | undefined): string {
  const value = head ?? "";
  return JOB_LEDGER_HEAD.test(value) ? value : "";
}

function isMigratableStage(state: string): state is JobState {
  return JOB_STATES.has(state as JobState) && state !== "recovering_worker";
}

export function decideJobLedgerUpgrade(snapshot: JobLedgerUpgradeSnapshot): JobLedgerUpgradeDecision {
  if (
    snapshot.id.length === 0 ||
    !isMigratableStage(snapshot.state) ||
    !JOB_LEDGER_HEAD.test(snapshot.head ?? "")
  ) {
    return {
      action: "drain",
      id: snapshot.id,
      reason: JOB_LEDGER_DRAIN_REASON,
    };
  }
  return {
    action: "migrate",
    row: ledgerFromJob({
      id: snapshot.id,
      state: snapshot.state,
      adoptedBranch: snapshot.branch,
      prHeadSha: snapshot.head,
      adoptedHeadSha: null,
    }),
  };
}
