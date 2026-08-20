import type { AuditFinding } from "../audit-contract";

/**
 * Open bugs nobody has touched in a long time.
 *
 * What it does: takes the open issues labelled as bugs and reports the ones
 *   that have gone untouched past the stale window, most neglected first.
 *   Read-only.
 * Cadence: daily.
 * Failure modes:
 *   - the issue list failing to load is the caller's problem; this sees only
 *     issues that were read successfully
 *   - an unreadable timestamp reads as not stale, so a missing date can never
 *     manufacture a finding
 *
 * It measures neglect, not age. A bug open for six months and commented on
 * yesterday is being worked; a bug open for six weeks that nobody has touched
 * is the one worth a mention. Reporting on age alone would bury the second in
 * a list of the first.
 */

/** Untouched for longer than this and a bug is worth mentioning. */
export const BACKLOG_STALE_AFTER_MS = 30 * 24 * 60 * 60_000;

export type BacklogIssue = {
  number: number;
  title: string;
  createdAt: number;
  /** Last activity of any kind. */
  updatedAt: number;
};

const DAY_MS = 24 * 60 * 60_000;

export function analyseBugBacklog(input: Readonly<{
  issues: readonly BacklogIssue[];
  now: number;
  staleAfterMs?: number;
}>): readonly AuditFinding[] {
  const staleAfterMs = input.staleAfterMs ?? BACKLOG_STALE_AFTER_MS;

  return input.issues
    .filter((issue) => {
      if (!Number.isFinite(issue.updatedAt)) return false;
      return input.now - issue.updatedAt >= staleAfterMs;
    })
    // Most neglected first: the digest shows only the first few, and the
    // longest-untouched bug is the one worth that room.
    .sort((left, right) => left.updatedAt - right.updatedAt || left.number - right.number)
    .map((issue): AuditFinding => ({
      auditId: "bug-backlog",
      subject: `#${issue.number}`,
      detail: `${issue.title} (untouched ${Math.floor((input.now - issue.updatedAt) / DAY_MS)} days)`,
      intake: { kind: "bug", issue: issue.number, title: issue.title },
    }));
}
