import { shellSingleQuote } from "../bb/terminal-command";
import type { CommandResult } from "../bb/terminal-command";

/**
 * Whether a branch's work is already in the trunk.
 *
 * Ancestry alone is not enough. A branch that was squashed into the trunk, or
 * whose change was re-applied under a different commit id, is not an ancestor
 * of anything, so `git merge-base --is-ancestor` reports it as unmerged while
 * its content is already there. Believing that answer is what leaves finished
 * branches lying around looking outstanding.
 *
 * So there are two probes, and either one proves landing:
 *
 *   - **ancestry** — the tip is reachable from the trunk. Exact for ordinary
 *     merges, and cheap.
 *   - **tree equality** — merging the branch into the trunk produces the
 *     trunk's own tree, so the merge would change nothing. This is the
 *     squash-safe oracle, and it stays correct as the trunk advances past the
 *     commit that carried the work.
 *
 * Every unreadable answer is `indeterminate` rather than a guess in either
 * direction. Keeping a finished branch costs a branch name; deleting an
 * unfinished one costs the work on it, so only a positive proof may authorise
 * a delete.
 */
export type BranchLandingVerdict =
  | { kind: "landed"; via: "ancestor" | "tree" }
  | { kind: "outstanding" }
  | { kind: "indeterminate"; reason: string };

export type BranchLandingProbes = Readonly<{
  ancestor: CommandResult;
  mergeTree: CommandResult;
  trunkTree: CommandResult;
}>;

/** Reachability test. Exit 0 means the branch tip is already in the trunk. */
export function ancestorCommand(branch: string, trunk: string): string {
  return `git merge-base --is-ancestor ${shellSingleQuote(branch)} ${shellSingleQuote(trunk)}`;
}

/**
 * Writes the tree that merging `branch` into `trunk` would produce, and prints
 * its object id. Requires git >= 2.38.
 */
export function mergeTreeCommand(branch: string, trunk: string): string {
  return `git merge-tree --write-tree ${shellSingleQuote(trunk)} ${shellSingleQuote(branch)}`;
}

/** The trunk's own tree, which the merge result is compared against. */
export function trunkTreeCommand(trunk: string): string {
  return `git rev-parse ${shellSingleQuote(`${trunk}^{tree}`)}`;
}

const OBJECT_ID = /^[0-9a-f]{7,64}$/;

/** An object id, or null when the output is missing, empty, or not an id. */
function readObjectId(result: CommandResult): string | null {
  if (result.outcome !== "exited" || result.exitCode !== 0) return null;
  const first = result.output.trim().split("\n", 1)[0]?.trim() ?? "";
  return OBJECT_ID.test(first) ? first : null;
}

export function readBranchLanding(probes: BranchLandingProbes): BranchLandingVerdict {
  const { ancestor, mergeTree, trunkTree } = probes;

  // Ancestry is proof on its own, so it is read first and a failure of either
  // other probe cannot downgrade it.
  if (ancestor.outcome === "exited" && ancestor.exitCode === 0) {
    return { kind: "landed", via: "ancestor" };
  }
  if (ancestor.outcome !== "exited") {
    return { kind: "indeterminate", reason: `ancestry probe ${ancestor.outcome}` };
  }
  // git answers this question with 0 or 1. Anything else — an unknown ref at
  // 128, say — means the question was never actually asked.
  if (ancestor.exitCode !== 1) {
    return { kind: "indeterminate", reason: `ancestry probe exited ${ancestor.exitCode}` };
  }

  const trunkTreeId = readObjectId(trunkTree);
  if (trunkTreeId === null) {
    return { kind: "indeterminate", reason: "trunk tree could not be read" };
  }

  if (mergeTree.outcome !== "exited") {
    return { kind: "indeterminate", reason: `merge probe ${mergeTree.outcome}` };
  }
  // A non-zero exit here is a conflict, which is unambiguously real work.
  if (mergeTree.exitCode !== 0) return { kind: "outstanding" };

  const mergedTreeId = readObjectId(mergeTree);
  if (mergedTreeId === null) {
    return { kind: "indeterminate", reason: "merge result tree could not be read" };
  }

  return mergedTreeId === trunkTreeId
    ? { kind: "landed", via: "tree" }
    : { kind: "outstanding" };
}
