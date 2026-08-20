import type { CompletedMergeRecord } from "../storage/store";

/**
 * Deciding whether a broken production is something this agent put there.
 *
 * A health fault says production stopped working. It does not say why, and most
 * of the time the answer is not a merge at all — a dependency expired, a node
 * died, someone else deployed. Reverting on a fault alone would undo innocent
 * work to fix something a revert cannot fix.
 *
 * Three things together make a revert the honest response. The last thing that
 * landed here was a merge; that merge was one this agent made on its own
 * authority, with no owner looking; and it landed recently enough that "the
 * merge broke it" is a better explanation than "something else did". Miss any
 * one of them and the answer is what it has always been: investigate and tell
 * the owner.
 *
 * The window is deliberately about the *latest* merge rather than the latest
 * unattended one. "An unattended merge happened at some point" is true of
 * almost any project that merges unattended, and acting on it would revert work
 * the owner merged themselves.
 */

/**
 * How recently the merge must have landed. Long enough to cover a fault that
 * took a while to show — a leak, a slow queue, a nightly path — and short enough
 * that yesterday's merge is not blamed for today's outage.
 */
export const REVERT_WINDOW_MS = 48 * 60 * 60_000;

export type RevertDecision =
  | Readonly<{ outcome: "revert"; merge: CompletedMergeRecord }>
  | Readonly<{ outcome: "investigate"; reason: string }>;

export function decideCrashRevert(input: Readonly<{
  merge: CompletedMergeRecord | null;
  now: number;
}>): RevertDecision {
  if (!input.merge) return { outcome: "investigate", reason: "nothing has been merged here" };
  if (!input.merge.unattended) {
    return { outcome: "investigate", reason: "the last merge here was one the owner approved" };
  }
  const age = input.now - input.merge.mergedAt;
  if (age < 0 || age > REVERT_WINDOW_MS) {
    return { outcome: "investigate", reason: "the last unattended merge is too old to blame" };
  }
  return { outcome: "revert", merge: input.merge };
}

/**
 * What the revert job is asked to do.
 *
 * Deliberately a work order rather than a command. The revert lands through the
 * ordinary pipeline — validation, review, and the same merge rule as everything
 * else — because a revert is a change to the repository like any other, and one
 * pushed around the gates is exactly the unreviewed production write this whole
 * system exists to prevent.
 */
export function revertWorkOrder(input: Readonly<{
  mergeCommitSha: string;
  alias: string;
}>): string {
  return [
    `Revert the merge commit ${input.mergeCommitSha} on ${input.alias}.`,
    "It merged without anyone being asked, and production health checks have been failing since.",
    "Revert exactly that commit and nothing else, keep the revert as small as reverting it requires,",
    "and land it through the normal pipeline.",
    "If reverting that commit is not possible cleanly, or the evidence says it is not the cause,",
    "stop and explain what you found instead of changing anything.",
  ].join(" ");
}
