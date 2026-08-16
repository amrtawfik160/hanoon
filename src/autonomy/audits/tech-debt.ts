import type { AuditFinding } from "../audit-contract";
import { VENDORED_DOC_PREFIXES } from "./docs-staleness";

/**
 * Debt markers left in the code, counted per file.
 *
 * What it does: takes the marker lines a grep found and turns them into one
 *   finding per file, worst first. Read-only.
 * Cadence: daily. Debt accrues over weeks; daily visibility is enough and
 *   anything faster is just a louder version of the same number.
 * Failure modes:
 *   - the grep itself failing is the caller's problem; this sees only lines
 *     that were read successfully
 *   - vendored code and dependencies are skipped, because their debt is not
 *     this repository's to pay
 *
 * One finding per file, not per marker: a file with forty markers is one
 * problem worth looking at, and forty lines in a message is a message nobody
 * reads. Worst first, because the digest only has room for the first few.
 */

/** The markers this looks for. Widening this is a deliberate, tested change. */
export const DEBT_MARKERS: readonly string[] = Object.freeze(["TODO", "FIXME", "HACK", "XXX"]);

export type DebtMarker = {
  path: string;
  line: number;
  kind: string;
  text: string;
};

/** Code this repository carries but did not write, so its debt is not ours. */
const SKIPPED_PREFIXES: readonly string[] = Object.freeze([
  ...VENDORED_DOC_PREFIXES,
  "node_modules/",
  "vendor/",
  "types/",
]);

export function analyseTechDebt(input: Readonly<{
  markers: readonly DebtMarker[];
  skippedPrefixes?: readonly string[];
}>): readonly AuditFinding[] {
  const skipped = input.skippedPrefixes ?? SKIPPED_PREFIXES;
  const byFile = new Map<string, { count: number; kinds: Set<string> }>();

  for (const marker of input.markers) {
    if (skipped.some((prefix) => marker.path.startsWith(prefix))) continue;
    const entry = byFile.get(marker.path) ?? { count: 0, kinds: new Set<string>() };
    entry.count += 1;
    entry.kinds.add(marker.kind);
    byFile.set(marker.path, entry);
  }

  return [...byFile.entries()]
    // Worst first so a capped digest shows the files that matter. Ties break by
    // name, so two runs over the same tree report the same order.
    .sort(([leftPath, left], [rightPath, right]) => (
      right.count - left.count || leftPath.localeCompare(rightPath)
    ))
    .map(([path, entry]): AuditFinding => ({
      auditId: "tech-debt",
      subject: path,
      detail: `${entry.count} marker${entry.count === 1 ? "" : "s"} (${[...entry.kinds].sort().join(", ")})`,
    }));
}
