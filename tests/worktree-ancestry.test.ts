import { expect, it, vi } from "vitest";
import type { CommandResult } from "../src/bb/terminal-command";
import {
  DisjointHistoryError,
  assertSharedTrunkAncestry,
  mergeBaseCommand,
  readMergeBaseResult,
} from "../src/bb/worktree-ancestry";

const MERGE_BASE = "5929a435e41f85a217dea010302bbac0c0fa6493";

function runnerReturning(result: CommandResult) {
  return { run: vi.fn(async () => result) };
}

it("reads a merge base commit as shared history", () => {
  expect(readMergeBaseResult({ outcome: "exited", exitCode: 0, output: `${MERGE_BASE}\n` }))
    .toEqual({ kind: "shared", mergeBase: MERGE_BASE });
});

it("reads git's empty exit 1 as a disjoint history", () => {
  expect(readMergeBaseResult({ outcome: "exited", exitCode: 1, output: "" })).toEqual({ kind: "disjoint" });
});

it("does not read a missing trunk ref as a disjoint history", () => {
  // git exits 128 for an unknown ref. Reporting that as disjoint would send the
  // owner chasing a history problem that does not exist.
  const verdict = readMergeBaseResult({
    outcome: "exited",
    exitCode: 128,
    output: "fatal: Not a valid object name no-such-branch",
  });
  expect(verdict.kind).toBe("unknown");
});

it.each([
  ["timed_out", { outcome: "timed_out" } as CommandResult],
  ["aborted", { outcome: "aborted" } as CommandResult],
])("treats a %s check as indeterminate rather than disjoint", (_label, result) => {
  expect(readMergeBaseResult(result).kind).toBe("unknown");
});

it("quotes the trunk name so a branch with a quote cannot break out of the command", () => {
  expect(mergeBaseCommand("main")).toBe("git merge-base 'main' HEAD");
  expect(mergeBaseCommand("it's-a-branch")).toBe(`git merge-base 'it'"'"'s-a-branch' HEAD`);
});

it("refuses a worktree that shares no ancestor with the trunk", async () => {
  const runner = runnerReturning({ outcome: "exited", exitCode: 1, output: "" });

  await expect(assertSharedTrunkAncestry({ runner, environmentId: "env_1", trunk: "main" }))
    .rejects.toBeInstanceOf(DisjointHistoryError);
});

it("tells the owner what to do about a disjoint worktree", async () => {
  const runner = runnerReturning({ outcome: "exited", exitCode: 1, output: "" });

  let error: DisjointHistoryError | null = null;
  try {
    await assertSharedTrunkAncestry({ runner, environmentId: "env_1", trunk: "trunk-branch" });
  } catch (caught) {
    error = caught as DisjointHistoryError;
  }

  expect(error).toBeInstanceOf(DisjointHistoryError);
  expect(error?.trunk).toBe("trunk-branch");
  expect(error?.message).toContain("shares no commit history with trunk-branch");
  expect(error?.message).toContain("--base-branch trunk-branch");
  expect(error?.message).toContain("baseBranch");
});

it("allows a worktree that shares history and runs the check in the given environment", async () => {
  const runner = runnerReturning({ outcome: "exited", exitCode: 0, output: MERGE_BASE });

  const verdict = await assertSharedTrunkAncestry({ runner, environmentId: "env_7", trunk: "main" });

  expect(verdict).toEqual({ kind: "shared", mergeBase: MERGE_BASE });
  expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
    scope: { kind: "environment", environmentId: "env_7" },
    command: "git merge-base 'main' HEAD",
  }));
});

it("does not block work when the check itself fails", async () => {
  const runner = { run: vi.fn(async () => { throw new Error("terminal unavailable"); }) };
  const indeterminate = vi.fn();

  const verdict = await assertSharedTrunkAncestry({
    runner,
    environmentId: "env_1",
    trunk: "main",
    onIndeterminate: indeterminate,
  });

  expect(verdict.kind).toBe("unknown");
  expect(indeterminate).toHaveBeenCalledWith("terminal unavailable");
});
