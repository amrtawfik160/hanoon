import {
  isResumablePermanentFailure,
  isResumablePlanBlock,
  isResumableReviewBlock,
  isReviewedPrCompletionBlock,
  type Job,
} from "../domain/models";

/**
 * A blocked job is not a finished job. The state machine already knows how to
 * leave every recoverable block — `RETRY` for a dead-lettered effect,
 * `CONTINUE_REVIEW` for a plan or review ceiling — but until now the only thing
 * that ever fired those events was the owner tapping a button. Jobs that could
 * have carried themselves to a merge sat blocked instead, and the owner was the
 * scheduler.
 *
 * This decides, for one blocked job, whether to drive it onward or hand it over.
 * Pure: the caller supplies the job and how many times it has already been
 * pushed through this same block, and gets back an event to apply.
 */

/**
 * How many times the same block may be resumed automatically before the owner
 * hears about it. Bounded so a genuinely impossible job surfaces instead of
 * spinning, and matched to the reference pipeline's dispatch ceiling.
 */
export const MAX_AUTO_CONTINUES = 3;

export type ContinuationJob = Pick<
  Job,
  | "state"
  | "blockedReason"
  | "resumeState"
  | "lastError"
  | "prNumber"
  | "reviewCycle"
  | "implementationThreadId"
  | "cancelRequestedAt"
  | "policy"
  | "deliveryMode"
>;

export type ContinuationDecision =
  /** Apply this event to the job; it can make progress on its own. */
  | Readonly<{ action: "resume"; event: "RETRY" | "CONTINUE_REVIEW" }>
  /** Only the owner can move this along. `reason` is why, in their words. */
  | Readonly<{ action: "escalate"; reason: string }>
  /** Not this sweep's business: already moving, already handed over, or cancelling. */
  | Readonly<{ action: "hold" }>;

/**
 * Identifies *which* block a job is stuck on, so repeated attempts at the same
 * wall are counted together while a job that blocks somewhere new starts fresh.
 * Without this a job that blocked in planning, recovered, built a PR, and then
 * blocked in review would arrive at review with its ladder already spent.
 */
export function continuationKey(job: Pick<Job, "blockedReason" | "resumeState">): string {
  return `${job.blockedReason ?? "-"}:${job.resumeState ?? "-"}`;
}

/** The owner has to fix the project's configuration; retrying cannot. */
const CONFIGURATION_ESCALATION =
  "This job is blocked on project configuration, which I cannot change on my own.";

const EXHAUSTED_ESCALATION =
  `I tried to get this moving ${MAX_AUTO_CONTINUES} times and it stopped at the same place each time.`;

const UNRECOVERABLE_ESCALATION =
  "This job stopped somewhere I have no way to resume from.";

export function planJobContinuation(input: {
  job: ContinuationJob;
  attempts: number;
}): ContinuationDecision {
  const { job, attempts } = input;
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new TypeError("attempts must be a non-negative integer");
  }
  if (job.state !== "blocked") return { action: "hold" };

  // A cancellation in flight is the owner's decision already made. Resuming
  // here would race their intent and restart work they asked to stop.
  if (job.cancelRequestedAt !== null) return { action: "hold" };

  // These two exist precisely to reach the owner. Driving past them would
  // defeat the boundary they encode.
  if (job.blockedReason === "cancellation_unconfirmed") return { action: "hold" };

  // A reviewed PR that only lacks production settings is finished work, not a
  // stuck job: the state machine closes it out rather than resuming a stage.
  if (isReviewedPrCompletionBlock(job)) {
    return { action: "resume", event: "CONTINUE_REVIEW" };
  }
  if (job.blockedReason === "configuration") {
    return { action: "escalate", reason: CONFIGURATION_ESCALATION };
  }

  const event = resumeEventFor(job);
  if (event === null) return { action: "escalate", reason: UNRECOVERABLE_ESCALATION };

  // Checked after resolvability so a job the owner must see is named for the
  // reason it cannot proceed, not for a ladder it never had a way to climb.
  if (attempts >= MAX_AUTO_CONTINUES) {
    return { action: "escalate", reason: EXHAUSTED_ESCALATION };
  }
  return { action: "resume", event };
}

/**
 * What the controller is told when the ladder runs out. Addressed to the agent,
 * not the owner: it decides how to say this, and the owner reads one plain line
 * rather than a state name and an error string.
 */
export function continuationEscalationNotice(input: {
  reason: string;
  lastError: string | null;
  alias: string | null;
}): string {
  const where = input.alias ? ` on ${input.alias.slice(0, 40)}` : "";
  const detail = input.lastError ? `\n\nWhere it stops: ${input.lastError.slice(0, 200)}` : "";
  return `A job${where} has stopped and I cannot get it moving on my own. ${input.reason}${detail}\n\nTell the owner in a line or two what is stuck and what you think it needs, in plain language. Do not start another job to fix it without asking. They can retry it from its status message.`;
}

/**
 * Which event the state machine will actually accept for this block. Mirrors
 * the guards in `transitionBlocked`, so a decision here is never rejected as an
 * illegal transition later.
 */
function resumeEventFor(job: ContinuationJob): "RETRY" | "CONTINUE_REVIEW" | null {
  if (isResumablePermanentFailure(job)) return "RETRY";
  if (isResumablePlanBlock(job) || isResumableReviewBlock(job)) return "CONTINUE_REVIEW";
  return null;
}
