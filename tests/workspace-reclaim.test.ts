import { expect, it } from "vitest";
import type { BranchLandingVerdict } from "../src/autonomy/branch-landing";
import {
  RECLAIM_MIN_IDLE_MS,
  RECLAIM_PER_RUN_CAP,
  classifyThreadStatus,
  planWorkspaceReclaim,
  type WorktreeObservation,
} from "../src/autonomy/workspace-reclaim";

it.each(["active", "running", "starting"])("counts a %s thread as running", (status) => {
  expect(classifyThreadStatus(status)).toBe("running");
});

it.each(["idle", "error", "archived", "completed"])("counts a %s thread as finished", (status) => {
  expect(classifyThreadStatus(status)).toBe("terminal");
});

it("counts a thread with no status at all as unknown", () => {
  // Fails closed: unknown blocks reclaim in planWorkspaceReclaim.
  expect(classifyThreadStatus(undefined)).toBe("unknown");
});

it("counts a status it has never seen as unknown rather than finished", () => {
  // A new BB status must not silently become a licence to delete.
  expect(classifyThreadStatus("quiescing")).toBe("unknown");
});

it("counts an absent thread as none", () => {
  expect(classifyThreadStatus(null)).toBe("none");
});

const NOW = 1_786_850_000_000;
const LONG_IDLE = NOW - RECLAIM_MIN_IDLE_MS - 60_000;

const LANDED: BranchLandingVerdict = { kind: "landed", via: "tree" };
const OUTSTANDING: BranchLandingVerdict = { kind: "outstanding" };
const UNKNOWN: BranchLandingVerdict = { kind: "indeterminate", reason: "probe timed out" };

function worktree(over: Partial<WorktreeObservation> = {}): WorktreeObservation {
  return {
    path: "/w/env_a/repo",
    branch: "bb/done",
    threadStatus: "terminal",
    dirty: false,
    lastActivityAt: LONG_IDLE,
    ...over,
  };
}

type PlanOverrides = Partial<{
  worktrees: readonly WorktreeObservation[];
  branches: readonly string[];
  landing: Record<string, BranchLandingVerdict>;
  protectedPaths: readonly string[];
  protectedBranches: readonly string[];
  now: number;
}>;

function plan(over: PlanOverrides = {}) {
  return planWorkspaceReclaim({
    worktrees: [],
    branches: [],
    landing: {},
    protectedPaths: [],
    protectedBranches: ["trunk", "main"],
    now: NOW,
    ...over,
  });
}

it("reclaims a finished worktree whose branch has landed", () => {
  const result = plan({
    worktrees: [worktree()],
    branches: ["bb/done"],
    landing: { "bb/done": LANDED },
  });
  expect(result.removeWorktrees).toEqual([
    { path: "/w/env_a/repo", branch: "bb/done", preserveUncommitted: false },
  ]);
  expect(result.deleteBranches).toEqual(["bb/done"]);
});

it("never touches a worktree whose thread is still running", () => {
  const result = plan({
    worktrees: [worktree({ threadStatus: "running" })],
    branches: ["bb/done"],
    landing: { "bb/done": LANDED },
  });
  expect(result.removeWorktrees).toEqual([]);
  expect(result.preserved.map((p) => p.subject)).toContain("/w/env_a/repo");
});

it("does not delete a branch that is still checked out in a kept worktree", () => {
  // git would refuse this anyway; planning it would just produce a failed step
  // and a confusing report.
  const result = plan({
    worktrees: [worktree({ threadStatus: "running" })],
    branches: ["bb/done"],
    landing: { "bb/done": LANDED },
  });
  expect(result.deleteBranches).toEqual([]);
});

it("saves uncommitted work before removing a dirty worktree", () => {
  const result = plan({
    worktrees: [worktree({ dirty: true })],
    branches: ["bb/done"],
    landing: { "bb/done": LANDED },
  });
  expect(result.removeWorktrees[0]).toMatchObject({ preserveUncommitted: true });
});

it("removes a finished worktree but keeps a branch that has not landed", () => {
  const result = plan({
    worktrees: [worktree({ branch: "bb/wip" })],
    branches: ["bb/wip"],
    landing: { "bb/wip": OUTSTANDING },
  });
  expect(result.removeWorktrees).toHaveLength(1);
  expect(result.deleteBranches).toEqual([]);
  expect(result.preserved.map((p) => p.subject)).toContain("bb/wip");
});

it("keeps a branch whose landing could not be determined", () => {
  const result = plan({ branches: ["bb/mystery"], landing: { "bb/mystery": UNKNOWN } });
  expect(result.deleteBranches).toEqual([]);
  expect(result.preserved.find((p) => p.subject === "bb/mystery")?.reason).toMatch(/probe timed out/);
});

it("keeps a branch with no landing verdict at all", () => {
  // A branch the sweep never managed to probe must not fall through to delete.
  const result = plan({ branches: ["bb/unprobed"], landing: {} });
  expect(result.deleteBranches).toEqual([]);
});

it("never removes a protected path", () => {
  const result = plan({
    worktrees: [worktree({ path: "/root/github_projects/repo" })],
    protectedPaths: ["/root/github_projects/repo"],
    branches: [],
    landing: {},
  });
  expect(result.removeWorktrees).toEqual([]);
  expect(result.preserved.map((p) => p.reason).join(" ")).toMatch(/protected/i);
});

it("never deletes a protected branch even when it has landed", () => {
  const result = plan({ branches: ["trunk", "main"], landing: { trunk: LANDED, main: LANDED } });
  expect(result.deleteBranches).toEqual([]);
});

it("leaves a recently active worktree alone", () => {
  const result = plan({
    worktrees: [worktree({ lastActivityAt: NOW - 60_000 })],
    branches: ["bb/done"],
    landing: { "bb/done": LANDED },
  });
  expect(result.removeWorktrees).toEqual([]);
  expect(result.deleteBranches).toEqual([]);
});

it("deletes a landed branch that has no worktree at all", () => {
  // The common case: 77 branches, 23 worktrees. Most have nothing checked out.
  const result = plan({ branches: ["bb/orphan"], landing: { "bb/orphan": LANDED } });
  expect(result.deleteBranches).toEqual(["bb/orphan"]);
});

it("does not plan a branch delete for a detached worktree", () => {
  const result = plan({ worktrees: [worktree({ branch: null })], branches: [], landing: {} });
  expect(result.removeWorktrees[0]).toMatchObject({ branch: null });
  expect(result.deleteBranches).toEqual([]);
});

it("caps how much one run may reclaim", () => {
  const many = Array.from({ length: RECLAIM_PER_RUN_CAP + 5 }, (_, i) => worktree({
    path: `/w/env_${i}/repo`,
    branch: `bb/done-${i}`,
  }));
  const landing = Object.fromEntries(many.map((w) => [w.branch as string, LANDED]));
  const result = plan({ worktrees: many, branches: many.map((w) => w.branch as string), landing });
  expect(result.removeWorktrees).toHaveLength(RECLAIM_PER_RUN_CAP);
  expect(result.deleteBranches.length).toBeLessThanOrEqual(RECLAIM_PER_RUN_CAP);
});

it("reports what it held back when the cap truncates a run", () => {
  const many = Array.from({ length: RECLAIM_PER_RUN_CAP + 2 }, (_, i) => worktree({
    path: `/w/env_${i}/repo`,
    branch: `bb/done-${i}`,
  }));
  const landing = Object.fromEntries(many.map((w) => [w.branch as string, LANDED]));
  const result = plan({ worktrees: many, branches: many.map((w) => w.branch as string), landing });
  expect(result.truncated).toBe(true);
});

it("treats an unknown thread status as a reason to keep the worktree", () => {
  const result = plan({
    worktrees: [worktree({ threadStatus: "unknown" })],
    branches: ["bb/done"],
    landing: { "bb/done": LANDED },
  });
  expect(result.removeWorktrees).toEqual([]);
});
