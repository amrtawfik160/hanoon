import { productionHasRollbackCommand, type Job, type ProjectPolicy } from "../domain/models";
import { taskAuthorityAllowsEffect, type TaskConstraint, type TaskOutcome } from "../domain/task-authority";

type TaskAuthorityEvidence = Readonly<{
  jobId: string;
  projectId: string;
  outcome: TaskOutcome;
  constraints: readonly TaskConstraint[];
  status: "active" | "revoked" | "suspended" | "superseded";
}>;

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
  | Readonly<{ outcome: "ask_owner"; reason: string }>
  /** Spawn the one consensus pass this head is allowed, then decide again. */
  | Readonly<{ outcome: "start_consensus" }>
  /** That pass is already running. Nothing is asked and nothing is approved. */
  | Readonly<{ outcome: "await_consensus" }>
  /** The job-scoped shipped grant keeps routine review remediation inside the executor. */
  | Readonly<{ outcome: "continue_remediation"; reason: string }>;

/**
 * What the durable review evidence says about this head's consensus pass.
 * Supplied by the caller for the same reason the grant is: the rule stays a
 * pure function of what is already stored.
 */
export type ConsensusEvidence = Readonly<{
  /** A pass has already been asked for on this exact head. */
  requested: boolean;
  /** `pending` covers both "not spawned yet" and "spawned, still working". */
  assessment: "pending" | "pass" | "not_pass";
  /** Whether an independent route exists at all for this project. */
  routeAvailable: boolean;
}>;

/**
 * Where a live grant came from. The owner should always be able to tell the two
 * apart: one was a tap they remember, the other is a line in a policy file.
 */
export type MergeGrantSource = "button" | "policy" | "task";

export type LiveMergeGrant = Readonly<{ source: MergeGrantSource }>;

/**
 * Everything durable that decides whether a project may merge unattended,
 * gathered by the caller and passed in whole. Keeping it in one shape means the
 * rule below stays a pure function of storage rather than a second reader of
 * it, and every caller asks the same question the same way.
 */
export type MergeGrantEvidence = Readonly<{
  /** The standing approval the owner granted with the button, if any. */
  grant: MergeAuthorityGrant | null;
  /** When this project's authority was last withdrawn, from the append-only log. */
  revokedAt: number | null;
  /** When this project's current policy snapshot was stored. */
  policyStoredAt: number | null;
  /** The owner-origin grant for one exact job, if this is that job. */
  taskAuthority?: TaskAuthorityEvidence | null;
}>;

type GrantPolicy = Pick<ProjectPolicy, "autonomy"> | null;

/**
 * A policy grant is a standing instruction in the project's own policy, so
 * `/approvals off` has nothing to clear: the file cannot hear about the
 * withdrawal. The revocation therefore silences it until a newer policy
 * snapshot is stored — which only `project enable` does, and which is the owner
 * saying it again deliberately rather than a stale file arguing with them.
 */
function policyGrantIsLive(policy: GrantPolicy, evidence: MergeGrantEvidence): boolean {
  if (policy?.autonomy?.unattendedMerge !== true) return false;
  if (evidence.revokedAt === null) return true;
  return evidence.policyStoredAt !== null && evidence.policyStoredAt > evidence.revokedAt;
}

/**
 * The one place that decides whether a project may merge without being asked,
 * and on whose authority. Fail closed: anything unresolved is no grant.
 */
export function resolveMergeGrant(input: {
  projectId: string | null;
  jobId?: string | null;
  policy: GrantPolicy;
  evidence: MergeGrantEvidence;
}): LiveMergeGrant | null {
  if (taskGrantIsLive(input.evidence.taskAuthority, input.projectId, input.jobId ?? null)) {
    return { source: "task" };
  }
  if (grantIsLive(input.evidence.grant, input.projectId)) return { source: "button" };
  if (input.projectId !== null && policyGrantIsLive(input.policy, input.evidence)) return { source: "policy" };
  return null;
}

/**
 * Two remediation rounds means the change argued with its own review twice.
 * That is exactly the shape a standing grant should not cover: routine work
 * ships itself, work that fought back gets a human look.
 */
export const REMEDIATION_ASK_THRESHOLD = 2;

type AuthorityJob = Pick<
  Job,
  "projectId" | "prHeadSha" | "reviewCycle" | "cancelRequestedAt" | "policy"
> & Readonly<{ id?: string }>;

function taskGrantIsLive(
  authority: TaskAuthorityEvidence | null | undefined,
  projectId: string | null,
  jobId: string | null,
): boolean {
  if (!authority || !taskAuthorityAllowsEffect(authority, "merge")) return false;
  if (projectId === null || jobId === null || authority.projectId !== projectId || authority.jobId !== jobId) return false;
  return true;
}

function grantIsLive(grant: MergeAuthorityGrant | null, projectId: string | null): boolean {
  if (!grant || grant.revokedAt !== null) return false;
  return projectId !== null && grant.projectId === projectId;
}

/**
 * The owner is asked unless every condition for unattended merging holds. The
 * caller supplies the durable evidence; this function never reads storage, so
 * the rule is testable on its own and cannot drift from what the tests assert.
 */
export function decideAutoApproval(input: {
  job: AuthorityJob;
  grant: MergeAuthorityGrant | null;
  /** Latest durable revocation for this project. Absent means none was recorded. */
  revokedAt?: number | null;
  /** When this project's current policy snapshot was stored. */
  policyStoredAt?: number | null;
  /** The job-scoped grant, when the caller is evaluating an owner-origin job. */
  taskAuthority?: TaskAuthorityEvidence | null;
  /**
   * The consensus pass for this exact head. Absent means none is available,
   * which reads the same as no independent route: the owner is asked.
   */
  consensus?: ConsensusEvidence;
}): AutoApprovalDecision {
  const { job, grant } = input;
  const live = resolveMergeGrant({
    projectId: job.projectId,
    jobId: job.id,
    policy: job.policy,
    evidence: {
      grant,
      revokedAt: input.revokedAt ?? null,
      policyStoredAt: input.policyStoredAt ?? null,
      taskAuthority: input.taskAuthority ?? null,
    },
  });
  if (live === null) {
    return { outcome: "ask_owner", reason: "no standing approval for this project" };
  }
  if (job.cancelRequestedAt !== null) {
    return { outcome: "ask_owner", reason: "the owner asked for this job to stop" };
  }
  if (!job.prHeadSha) {
    return { outcome: "ask_owner", reason: "the pull-request head is not established" };
  }
  // A project that merges without production has said so deliberately, and its
  // policy carried the required checks and regression run to earn it. Every
  // other project still stops here: with nothing configured to deploy the
  // change, an unattended merge would be shipping into silence.
  if (!job.policy?.production && job.policy?.autonomy?.mergeWithoutProduction !== true) {
    return { outcome: "ask_owner", reason: "the project has no production configuration" };
  }
  if (job.policy?.production && !productionHasRollbackCommand(job.policy)) {
    return { outcome: "ask_owner", reason: "the project has no production rollback command" };
  }
  if (job.reviewCycle >= REMEDIATION_ASK_THRESHOLD) {
    return decideRemediatedChange(job, input.consensus, live.source === "task");
  }
  return { outcome: "auto_approve" };
}

/**
 * A change that argued with its own review twice is the shape a standing grant
 * should not simply wave through. The owner's look is what it needed; a second
 * independent review of the exact same head is what stands in for that look.
 *
 * It only stands in when it is unambiguous. A pass with no findings at all
 * approves; findings, a failure, a drifted head, or no independent route to run
 * it on all end where this used to: asking the owner.
 */
function decideRemediatedChange(
  job: AuthorityJob,
  consensus: ConsensusEvidence | undefined,
  taskGrant: boolean,
): AutoApprovalDecision {
  const asked: AutoApprovalDecision = {
    outcome: "ask_owner",
    reason: `the change needed ${job.reviewCycle} rounds of review fixes`,
  };
  if (!consensus?.routeAvailable) return taskGrant
    ? { outcome: "continue_remediation", reason: "Independent review is unavailable; continue fixing the reviewed change" }
    : asked;
  if (consensus.assessment === "pass") return { outcome: "auto_approve" };
  if (consensus.assessment === "not_pass") {
    if (taskGrant) {
      return {
        outcome: "continue_remediation",
        reason: "The independent review did not clear the current head; continue remediation",
      };
    }
    return {
      outcome: "ask_owner",
      reason: `the change needed ${job.reviewCycle} rounds of review fixes and a second review did not clear it`,
    };
  }
  // At most one pass per head: once asked for, the answer is waited for rather
  // than asked for again.
  return consensus.requested ? { outcome: "await_consensus" } : { outcome: "start_consensus" };
}
