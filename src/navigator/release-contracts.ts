export const NAVIGATOR_RELEASE_INCIDENT_BUDGET = 1;
export const NAVIGATOR_RELEASE_STEP_SKILL_ID = "start_release";

export type NavigatorReleaseEntryRequest = Readonly<{
  operationId: string;
  jobId: string;
  title: string;
  body: string;
}>;

export function navigatorReleaseOperationId(jobId: string): string {
  return `release:${jobId}`;
}

export const NAVIGATOR_RELEASE_STATES = [
  "locating_pr",
  "resolving_pr_head",
  "validating",
  "reviewing",
  "remediating",
  "documenting",
  "resolving_docs_head",
  "final_validating",
  "final_reviewing",
  "awaiting_merge_approval",
  "merging",
  "deploying",
  "verifying_production",
] as const;

export type NavigatorReleaseIncidentPhase = "deploy" | "canary";
export type NavigatorReleaseRollbackOutcome = "pass" | "fail" | "missing" | "indeterminate";

export type NavigatorReleaseAttempt = Readonly<{
  id: string;
  jobId: string;
  workflowStepId: string;
  effectIdempotencyKey: string;
  implementationTicketIds: readonly string[];
  snapshotDigest: string;
  jobVersion: number;
  workflowRevision: number;
  capabilityProfileId: string | null;
  capabilityProfileRevision: number | null;
}>;
