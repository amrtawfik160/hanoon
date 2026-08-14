import type { Job } from "../domain/models";

/**
 * A standing merge grant is the owner saying "you no longer need to ask me for
 * this project". It replaces the owner's signature on a single merge; it does
 * not replace any of the checks that produced the merge candidate. Every guard
 * that ran before an approval was requested still runs, and a job that fails
 * one of them falls back to asking rather than proceeding.
 *
 * Fail closed everywhere: an absent, revoked, or unreadable grant asks.
 */
export type MergeAuthorityGrant = Readonly<{
  projectId: string;
  grantedAt: number;
  grantedByUserId: string;
  grantedByChatId: string;
  revokedAt: number | null;
  revokedReason: string | null;
}>;

export type AutoApprovalDecision =
  | Readonly<{ outcome: "auto_approve" }>
  | Readonly<{ outcome: "ask_owner"; reason: string }>;

/**
 * Two remediation rounds means the change argued with its own review twice.
 * That is exactly the shape a standing grant should not cover: routine work
 * ships itself, work that fought back gets a human look.
 */
export const REMEDIATION_ASK_THRESHOLD = 2;

type AuthorityJob = Pick<
  Job,
  "projectId" | "prHeadSha" | "reviewCycle" | "cancelRequestedAt" | "policy"
>;

function grantIsLive(grant: MergeAuthorityGrant | null, projectId: string | null): boolean {
  if (!grant || grant.revokedAt !== null) return false;
  return projectId !== null && grant.projectId === projectId;
}

/**
 * The owner is asked unless every condition for unattended merging holds. The
 * caller supplies the grant; this function never reads storage, so the rule is
 * testable on its own and cannot drift from what the tests assert.
 */
export function decideAutoApproval(input: {
  job: AuthorityJob;
  grant: MergeAuthorityGrant | null;
}): AutoApprovalDecision {
  const { job, grant } = input;
  if (!grantIsLive(grant, job.projectId)) {
    return { outcome: "ask_owner", reason: "no standing approval for this project" };
  }
  if (job.cancelRequestedAt !== null) {
    return { outcome: "ask_owner", reason: "the owner asked for this job to stop" };
  }
  if (!job.prHeadSha) {
    return { outcome: "ask_owner", reason: "the pull-request head is not established" };
  }
  if (!job.policy?.production) {
    return { outcome: "ask_owner", reason: "the project has no production configuration" };
  }
  if (job.reviewCycle >= REMEDIATION_ASK_THRESHOLD) {
    return {
      outcome: "ask_owner",
      reason: `the change needed ${job.reviewCycle} rounds of review fixes`,
    };
  }
  return { outcome: "auto_approve" };
}
