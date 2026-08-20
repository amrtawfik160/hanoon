/**
 * What a periodic audit produces, and how a day's worth of them becomes one
 * message.
 *
 * The audits are read-only checks that run on their own cadence and report what
 * they found. They exist to catch drift the owner would otherwise trip over
 * later: documentation that no longer matches the code, debt markers piling up,
 * a backlog going stale, review findings that were never addressed.
 *
 * Two rules shape everything here.
 *
 * A clean day is silent. An audit that reports "all fine" every morning is a
 * daily interruption that trains the owner to ignore the one morning it matters.
 *
 * A noisy day is bounded, and says so. A repository with five hundred debt
 * markers must not produce a message with five hundred lines in it, and cutting
 * the list without saying it was cut reads as "that is all of them", which is a
 * lie. Every cut is counted out loud.
 */

/**
 * The facts behind a finding, in a shape that survives being read by something
 * other than a person.
 *
 * The digest is prose, and prose is where a work order goes to die: "12 markers"
 * cannot be counted and "#42" cannot be looked up without parsing the sentence
 * back apart. An audit that can state its finding as a concrete piece of work
 * says so here; one that cannot leaves this out, and nothing downstream may
 * guess on its behalf.
 */
export type AuditFindingIntake =
  | Readonly<{ kind: "bug"; issue: number; title: string }>
  | Readonly<{ kind: "docs"; document: string; reference: string }>
  | Readonly<{ kind: "debt"; path: string; markers: number; kinds: readonly string[] }>
  | Readonly<{ kind: "review"; pr: number; unanswered: number; excerpt: string }>;

/** One thing an audit noticed. */
export type AuditFinding = {
  auditId: string;
  /** What the finding is about: a file, an issue number, a branch. */
  subject: string;
  detail: string;
  /** Present only when this finding can be stated as a concrete work order. */
  intake?: AuditFindingIntake;
};

export type AuditResult =
  // A scoped clean result is qualified when a digest is already visible, but
  // it does not turn an otherwise clean day into a daily interruption.
  | { auditId: string; status: "ok"; findings: readonly AuditFinding[]; scope?: string }
  | { auditId: string; status: "findings"; findings: readonly AuditFinding[]; scope?: string }
  | { auditId: string; status: "error"; findings: readonly AuditFinding[]; error: string; scope?: string };

/** Most one audit may contribute, so a single noisy check cannot fill a message. */
export const AUDIT_FINDINGS_PER_AUDIT_CAP = 5;

/** Most the whole message may carry, however many audits contributed. */
export const AUDIT_FINDINGS_TOTAL_CAP = 12;

function held(count: number): string {
  return `and ${count} more`;
}

/**
 * One plain message for the owner, or null when there is nothing worth saying.
 */
export function auditDigest(input: Readonly<{
  project: string;
  results: readonly AuditResult[];
}>): string | null {
  const withFindings = input.results.filter((r) => r.status === "findings" && r.findings.length > 0);
  const failed = input.results.filter((r) => r.status === "error");
  if (withFindings.length === 0 && failed.length === 0) return null;

  const lines: string[] = [];
  let remaining = AUDIT_FINDINGS_TOTAL_CAP;

  for (const result of withFindings) {
    if (remaining <= 0) {
      lines.push(`${result.auditId}: ${result.findings.length} more, not shown here.`);
      continue;
    }
    const room = Math.min(AUDIT_FINDINGS_PER_AUDIT_CAP, remaining);
    const shown = result.findings.slice(0, room);
    remaining -= shown.length;
    const omitted = result.findings.length - shown.length;
    const body = shown.map((f) => `${f.subject}: ${f.detail}`).join("; ");
    lines.push(
      `${result.auditId}: ${result.findings.length} found. ${body}` +
      (omitted > 0 ? ` (${held(omitted)}).` : "."),
    );
  }

  for (const result of input.results) {
    if (result.status !== "ok" || result.scope === undefined) continue;
    lines.push(`${result.auditId}: no findings in ${result.scope}.`);
  }

  for (const result of failed) {
    // Named rather than dropped: an audit that could not run is not an audit
    // that found nothing, and the difference matters when nothing is reported.
    lines.push(`${result.auditId}: could not run (${result.error}).`);
  }

  return [`Daily check on ${input.project}:`, ...lines].join("\n");
}
