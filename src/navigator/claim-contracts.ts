import type { Job } from "../domain/models";
import {
  productionResourceKey,
  projectResourceKey,
  repositoryMergeResourceKey,
  type JobResourceClaim,
} from "../autonomy/models";

export type NavigatorClaimedEffectKind =
  | "run_navigator_skill"
  | "run_navigator_ticket_worker"
  | "run_navigator_release";

export type NavigatorRequiredResourceClaim = Readonly<Pick<JobResourceClaim, "resourceKind" | "resourceKey">>;

export type NavigatorClaimContract = Readonly<{
  resourceClaims: readonly NavigatorRequiredResourceClaim[];
  requiresTicketWorkArtifact: boolean;
}>;

export function navigatorClaimContract(
  kind: NavigatorClaimedEffectKind,
  job: Pick<Job, "projectId" | "policy">,
): NavigatorClaimContract | null {
  if (job.projectId === null) return null;
  const projectClaim = { resourceKind: "project" as const, resourceKey: projectResourceKey(job.projectId) };
  if (kind === "run_navigator_skill") {
    return { resourceClaims: [projectClaim], requiresTicketWorkArtifact: false };
  }
  if (kind === "run_navigator_ticket_worker") {
    return { resourceClaims: [projectClaim], requiresTicketWorkArtifact: true };
  }
  if (job.policy === null) return null;
  return {
    resourceClaims: [
      projectClaim,
      { resourceKind: "repository_merge", resourceKey: repositoryMergeResourceKey(job.policy.githubRepository) },
      ...(job.policy.production === undefined ? [] : [{
        resourceKind: "production_target" as const,
        resourceKey: productionResourceKey(job.policy),
      }]),
    ],
    requiresTicketWorkArtifact: false,
  };
}
