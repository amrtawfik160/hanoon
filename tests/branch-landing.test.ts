import { expect, it } from "vitest";
import type { CommandResult } from "../src/bb/terminal-command";
import {
  ancestorCommand,
  mergeTreeCommand,
  readBranchLanding,
  trunkTreeCommand,
} from "../src/autonomy/branch-landing";

const TRUNK_TREE = "4effcd9be8ccacb4b772bf80bb7c6ad7b0459a49";
const OTHER_TREE = "1111111111111111111111111111111111111111";

function exited(exitCode: number, output = ""): CommandResult {
  return { outcome: "exited", exitCode, output };
}

/** A branch whose tip is reachable from the trunk: an ordinary merge. */
const ANCESTOR_YES = exited(0);
/** git's answer for "not an ancestor". */
const ANCESTOR_NO = exited(1);

it("reads an ancestor branch as landed", () => {
  expect(readBranchLanding({
    ancestor: ANCESTOR_YES,
    mergeTree: exited(0, `${TRUNK_TREE}\n`),
    trunkTree: exited(0, `${TRUNK_TREE}\n`),
  })).toEqual({ kind: "landed", via: "ancestor" });
});

it("reads a squash-merged branch as landed even though it is not an ancestor", () => {
  // The case that made ba2710b look outstanding for days: the same change was
  // re-applied under a different commit id, so ancestry says no while the
  // content is already in the trunk. Merging it back would be a no-op.
  expect(readBranchLanding({
    ancestor: ANCESTOR_NO,
    mergeTree: exited(0, `${TRUNK_TREE}\n`),
    trunkTree: exited(0, `${TRUNK_TREE}\n`),
  })).toEqual({ kind: "landed", via: "tree" });
});

it("reads a branch that would change the trunk as outstanding", () => {
  expect(readBranchLanding({
    ancestor: ANCESTOR_NO,
    mergeTree: exited(0, `${OTHER_TREE}\n`),
    trunkTree: exited(0, `${TRUNK_TREE}\n`),
  })).toEqual({ kind: "outstanding" });
});

it("reads a conflicting merge as outstanding rather than landed", () => {
  // git merge-tree exits non-zero on conflict. A conflict is real work.
  expect(readBranchLanding({
    ancestor: ANCESTOR_NO,
    mergeTree: exited(1, "CONFLICT (content): Merge conflict in src/plugin.ts"),
    trunkTree: exited(0, `${TRUNK_TREE}\n`),
  })).toEqual({ kind: "outstanding" });
});

it("refuses to judge when the trunk tree cannot be read", () => {
  // An unknown trunk ref must never read as outstanding-and-therefore-keepable
  // nor as landed. It is simply unknown, and unknown never authorises a delete.
  const verdict = readBranchLanding({
    ancestor: ANCESTOR_NO,
    mergeTree: exited(0, `${TRUNK_TREE}\n`),
    trunkTree: exited(128, "fatal: Not a valid object name"),
  });
  expect(verdict.kind).toBe("indeterminate");
});

it.each([
  ["timed_out", { outcome: "timed_out" } as CommandResult],
  ["aborted", { outcome: "aborted" } as CommandResult],
])("treats a %s ancestry probe as indeterminate", (_label, result) => {
  expect(readBranchLanding({
    ancestor: result,
    mergeTree: exited(0, `${OTHER_TREE}\n`),
    trunkTree: exited(0, `${TRUNK_TREE}\n`),
  }).kind).toBe("indeterminate");
});

it("treats an unreadable merge-tree probe as indeterminate, not outstanding", () => {
  expect(readBranchLanding({
    ancestor: ANCESTOR_NO,
    mergeTree: { outcome: "timed_out" },
    trunkTree: exited(0, `${TRUNK_TREE}\n`),
  }).kind).toBe("indeterminate");
});

it("still reports landed when ancestry proves it and the tree probe failed", () => {
  // Ancestry alone is proof. A broken second probe must not downgrade it.
  expect(readBranchLanding({
    ancestor: ANCESTOR_YES,
    mergeTree: { outcome: "timed_out" },
    trunkTree: exited(128, "fatal"),
  })).toEqual({ kind: "landed", via: "ancestor" });
});

it("rejects empty merge-tree output rather than matching an empty trunk tree", () => {
  expect(readBranchLanding({
    ancestor: ANCESTOR_NO,
    mergeTree: exited(0, "\n"),
    trunkTree: exited(0, "\n"),
  }).kind).toBe("indeterminate");
});

it("quotes branch and trunk names so neither can break out of the command", () => {
  expect(ancestorCommand("feature", "trunk"))
    .toBe("git merge-base --is-ancestor 'feature' 'trunk'");
  expect(mergeTreeCommand("feature", "trunk"))
    .toBe("git merge-tree --write-tree 'trunk' 'feature'");
  expect(trunkTreeCommand("trunk")).toBe("git rev-parse 'trunk^{tree}'");
  expect(ancestorCommand("it's-a-branch", "trunk"))
    .toBe(`git merge-base --is-ancestor 'it'"'"'s-a-branch' 'trunk'`);
});
