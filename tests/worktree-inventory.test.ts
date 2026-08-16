import { expect, it } from "vitest";
import {
  branchListCommand,
  parseBranchList,
  parseWorktreeList,
  worktreeListCommand,
} from "../src/bb/worktree-inventory";

const PORCELAIN = [
  "worktree /root/github_projects/repo",
  "HEAD 5e86c0c803cdcf05314581d817374ab9785af13a",
  "branch refs/heads/trunk",
  "",
  "worktree /root/.bb-server/worktrees/env_a/repo",
  "HEAD adefdfe01ea178f886b230a6b2c5870777d2137e",
  "branch refs/heads/bb/some-thread",
  "",
  "worktree /root/.bb-server/worktrees/env_b/repo",
  "HEAD 438b94d0000000000000000000000000000000aa",
  "detached",
  "",
].join("\n");

it("reads each worktree's path and branch", () => {
  expect(parseWorktreeList(PORCELAIN)).toEqual([
    { path: "/root/github_projects/repo", branch: "trunk" },
    { path: "/root/.bb-server/worktrees/env_a/repo", branch: "bb/some-thread" },
    { path: "/root/.bb-server/worktrees/env_b/repo", branch: null },
  ]);
});

it("keeps a branch name that contains slashes intact", () => {
  const parsed = parseWorktreeList("worktree /w\nHEAD abc\nbranch refs/heads/bb/a/b/c\n");
  expect(parsed[0]?.branch).toBe("bb/a/b/c");
});

it("reads a final block that has no trailing blank line", () => {
  const parsed = parseWorktreeList("worktree /w\nHEAD abc\nbranch refs/heads/solo");
  expect(parsed).toEqual([{ path: "/w", branch: "solo" }]);
});

it("ignores a block that never named a worktree", () => {
  expect(parseWorktreeList("HEAD abc\nbranch refs/heads/orphan\n")).toEqual([]);
});

it("reads nothing out of empty output", () => {
  expect(parseWorktreeList("")).toEqual([]);
  expect(parseWorktreeList("\n\n")).toEqual([]);
});

it("reads one branch per line and drops blanks", () => {
  expect(parseBranchList("trunk\nmain\nbb/one\n\n")).toEqual(["trunk", "main", "bb/one"]);
});

it("ignores a detached-HEAD marker line in the branch list", () => {
  // git prints this for a detached worktree; it is not a branch name.
  expect(parseBranchList("trunk\n(HEAD detached at abc123)\nmain\n")).toEqual(["trunk", "main"]);
});

it("builds commands that need no shell quoting of their own", () => {
  expect(worktreeListCommand()).toBe("git worktree list --porcelain");
  expect(branchListCommand()).toBe("git for-each-ref --format=%(refname:short) refs/heads/");
});
