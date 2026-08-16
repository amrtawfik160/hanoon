import { expect, it, vi } from "vitest";
import type { BranchLandingVerdict } from "../src/autonomy/branch-landing";
import { RECLAIM_MIN_IDLE_MS, type WorktreeObservation } from "../src/autonomy/workspace-reclaim";
import {
  WORKSPACE_SCAN_INTERVAL_MS,
  WORKSPACE_STARTUP_DELAY_MS,
  WorkspaceHousekeepingService,
  type ProjectWorkspace,
  type WorkspaceAccess,
} from "../src/services/workspace-housekeeping-service";

const NOW = 1_786_850_000_000;
const IDLE = NOW - RECLAIM_MIN_IDLE_MS - 60_000;
const LANDED: BranchLandingVerdict = { kind: "landed", via: "tree" };

const PROJECT: ProjectWorkspace = {
  projectId: "proj_1",
  label: "demo",
  trunk: "trunk",
  protectedPaths: ["/src/demo"],
  protectedBranches: ["trunk", "main"],
};

function worktree(over: Partial<WorktreeObservation> = {}): WorktreeObservation {
  return {
    path: "/w/env_a/repo",
    branch: "bb/done",
    threadStatus: "terminal",
    dirty: false,
    lastActivityAt: IDLE,
    ...over,
  };
}

type AccessOverrides = Partial<WorkspaceAccess>;

function accessWith(calls: string[], over: AccessOverrides = {}): WorkspaceAccess {
  return {
    listProjects: async () => [PROJECT],
    listWorktrees: async () => [worktree()],
    listBranches: async () => ["bb/done"],
    probeLanding: async () => LANDED,
    preserveUncommitted: async (_p, path) => {
      calls.push(`preserve:${path}`);
      return `/rescue/${path.replaceAll("/", "_")}.patch`;
    },
    removeWorktree: async (_p, path) => {
      calls.push(`remove:${path}`);
    },
    deleteBranch: async (_p, branch) => {
      calls.push(`delete:${branch}`);
    },
    ...over,
  };
}

function storeFake() {
  return {
    getOwner: () => ({ userId: 7, chatId: 9 }),
    getControllerForOwner: () => ({ controllerKey: "ck" }),
    claimHousekeepingNotice: vi.fn(() => true),
    enqueueControllerTurn: vi.fn(),
  };
}

function service(access: WorkspaceAccess, store = storeFake(), armed = true) {
  return {
    store,
    svc: new WorkspaceHousekeepingService({
      store: store as never,
      workspace: access,
      clock: { now: () => NOW },
      issueUpdateId: () => 1,
      reclaimArmed: () => armed,
      warn: () => {},
    }),
  };
}

it("removes a finished worktree and deletes its landed branch", async () => {
  const calls: string[] = [];
  const { svc } = service(accessWith(calls));
  const outcome = await svc.sweep(NOW);
  expect(calls).toEqual(["remove:/w/env_a/repo", "delete:bb/done"]);
  expect(outcome.removedWorktrees).toEqual(["/w/env_a/repo"]);
  expect(outcome.deletedBranches).toEqual(["bb/done"]);
});

it("saves uncommitted work before the directory is removed", async () => {
  const calls: string[] = [];
  const { svc } = service(accessWith(calls, {
    listWorktrees: async () => [worktree({ dirty: true })],
  }));
  await svc.sweep(NOW);
  expect(calls.indexOf("preserve:/w/env_a/repo")).toBeLessThan(calls.indexOf("remove:/w/env_a/repo"));
});

it("refuses to remove a dirty worktree whose work could not be saved", async () => {
  // The whole point of the preserve step. If the patch cannot be written the
  // directory is the only copy of that work, so it stays.
  const calls: string[] = [];
  const { svc } = service(accessWith(calls, {
    listWorktrees: async () => [worktree({ dirty: true })],
    preserveUncommitted: async () => {
      throw new Error("disk full");
    },
  }));
  const outcome = await svc.sweep(NOW);
  expect(calls).not.toContain("remove:/w/env_a/repo");
  expect(outcome.removedWorktrees).toEqual([]);
});

it("does not delete the branch when its worktree could not be removed", async () => {
  const calls: string[] = [];
  const { svc } = service(accessWith(calls, {
    removeWorktree: async () => {
      throw new Error("device busy");
    },
  }));
  const outcome = await svc.sweep(NOW);
  expect(calls).not.toContain("delete:bb/done");
  expect(outcome.deletedBranches).toEqual([]);
});

it("plans but changes nothing when reclaim is not armed", async () => {
  const calls: string[] = [];
  const { svc } = service(accessWith(calls), storeFake(), false);
  const outcome = await svc.sweep(NOW);
  expect(calls).toEqual([]);
  expect(outcome.removedWorktrees).toEqual([]);
  expect(outcome.plans[0]?.plan.removeWorktrees).toHaveLength(1);
});

it("keeps sweeping other projects when one fails outright", async () => {
  const second: ProjectWorkspace = { ...PROJECT, projectId: "proj_2", label: "second" };
  const calls: string[] = [];
  const { svc } = service(accessWith(calls, {
    listProjects: async () => [PROJECT, second],
    listWorktrees: async (project) => {
      if (project.projectId === "proj_1") throw new Error("git missing");
      return [worktree({ path: "/w/env_b/repo", branch: "bb/second" })];
    },
    listBranches: async (project) => (project.projectId === "proj_1" ? [] : ["bb/second"]),
  }));
  const outcome = await svc.sweep(NOW);
  expect(outcome.removedWorktrees).toEqual(["/w/env_b/repo"]);
});

it("never probes or deletes a protected branch", async () => {
  const probed: string[] = [];
  const calls: string[] = [];
  const { svc } = service(accessWith(calls, {
    listWorktrees: async () => [],
    listBranches: async () => ["trunk", "main", "bb/done"],
    probeLanding: async (_p, branch) => {
      probed.push(branch);
      return LANDED;
    },
  }));
  await svc.sweep(NOW);
  expect(probed).toEqual(["bb/done"]);
  expect(calls).toEqual(["delete:bb/done"]);
});

it("tells the owner once what it reclaimed", async () => {
  const { svc, store } = service(accessWith([]));
  const outcome = await svc.sweep(NOW);
  expect(outcome.notified).toBe(true);
  expect(store.claimHousekeepingNotice).toHaveBeenCalledOnce();
  const enqueued = store.enqueueControllerTurn.mock.calls[0]?.[0] as { inputText: string; origin: string };
  expect(enqueued.origin).toBe("system");
  expect(enqueued.inputText).toMatch(/1 worktree/);
  expect(enqueued.inputText).toMatch(/1 branch/);
});

it("stays quiet when it reclaimed nothing", async () => {
  const { svc, store } = service(accessWith([], {
    listWorktrees: async () => [],
    listBranches: async () => [],
  }));
  const outcome = await svc.sweep(NOW);
  expect(outcome.notified).toBe(false);
  expect(store.enqueueControllerTurn).not.toHaveBeenCalled();
});

it("waits out the startup delay before its first sweep", async () => {
  const calls: string[] = [];
  const access = accessWith(calls);
  let clock = NOW;
  const svc = new WorkspaceHousekeepingService({
    store: storeFake() as never,
    workspace: access,
    clock: { now: () => clock },
    issueUpdateId: () => 1,
    reclaimArmed: () => true,
    warn: () => {},
  });
  expect(await svc.processDue()).toBe(false);
  expect(calls).toEqual([]);

  clock = NOW + WORKSPACE_STARTUP_DELAY_MS + 1;
  expect(await svc.processDue()).toBe(true);
  expect(calls).toContain("remove:/w/env_a/repo");

  // Paced afterwards: an immediate second tick must not sweep again.
  calls.length = 0;
  expect(await svc.processDue()).toBe(false);
  clock += WORKSPACE_SCAN_INTERVAL_MS + 1;
  expect(await svc.processDue()).toBe(true);
});

it("answers whether it is due without doing any work", () => {
  // The executor ticks constantly and this sweep runs daily, so a tick that is
  // not due must cost nothing at all: no await, and so no place for unrelated
  // work to interleave differently than it would have.
  const calls: string[] = [];
  let clock = NOW;
  const svc = new WorkspaceHousekeepingService({
    store: storeFake() as never,
    workspace: accessWith(calls),
    clock: { now: () => clock },
    issueUpdateId: () => 1,
    reclaimArmed: () => true,
    warn: () => {},
  });
  expect(svc.due(clock)).toBe(false);
  expect(calls).toEqual([]);

  clock = NOW + WORKSPACE_STARTUP_DELAY_MS + 1;
  expect(svc.due(clock)).toBe(true);
  expect(calls).toEqual([]);
});

it("survives a sweep that throws instead of taking the executor down", async () => {
  let clock = NOW;
  const svc = new WorkspaceHousekeepingService({
    store: storeFake() as never,
    workspace: accessWith([], {
      listProjects: async () => {
        throw new Error("everything is broken");
      },
    }),
    clock: { now: () => clock },
    issueUpdateId: () => 1,
    reclaimArmed: () => true,
    warn: () => {},
  });
  await svc.processDue();
  clock = NOW + WORKSPACE_STARTUP_DELAY_MS + 1;
  await expect(svc.processDue()).resolves.toBe(false);
});
