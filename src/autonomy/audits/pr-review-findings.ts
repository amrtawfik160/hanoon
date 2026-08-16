import type { AuditFinding } from "../audit-contract";

/**
 * Review comments that were raised and then shipped past.
 *
 * What it does: takes the review threads on recently merged pull requests and
 *   reports the ones nobody resolved, grouped per pull request. Read-only.
 * Cadence: daily.
 * Failure modes:
 *   - the review data failing to load is the caller's problem; this sees only
 *     threads that were read successfully
 *   - an outdated thread is skipped, because the code it pointed at is gone,
 *     so the comment no longer describes anything that shipped
 *
 * A review finding that was answered is fine and a review finding that was
 * argued down is fine. The one worth surfacing is the one nobody replied to at
 * all, which merged along with everything else and now looks like agreement.
 */

/** Enough of a comment to recognise it, not enough to fill the message. */
const EXCERPT_LIMIT = 120;

export type ReviewThread = {
  pr: number;
  prTitle: string;
  author: string;
  body: string;
  resolved: boolean;
  /** True when the code the thread pointed at no longer exists. */
  outdated: boolean;
};

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length <= EXCERPT_LIMIT ? flat : `${flat.slice(0, EXCERPT_LIMIT - 1)}…`;
}

export function analysePrReviewFindings(input: Readonly<{
  threads: readonly ReviewThread[];
}>): readonly AuditFinding[] {
  const byPr = new Map<number, ReviewThread[]>();
  for (const thread of input.threads) {
    if (thread.resolved || thread.outdated) continue;
    byPr.set(thread.pr, [...(byPr.get(thread.pr) ?? []), thread]);
  }

  return [...byPr.entries()]
    .sort(([leftPr, left], [rightPr, right]) => right.length - left.length || leftPr - rightPr)
    .map(([pr, threads]): AuditFinding => {
      const first = threads[0];
      const extra = threads.length > 1 ? ` and ${threads.length - 1} more` : "";
      return {
        auditId: "pr-review-findings",
        subject: `#${pr}`,
        detail: `${threads.length} unanswered: "${excerpt(first?.body ?? "")}"${extra}`,
      };
    });
}
