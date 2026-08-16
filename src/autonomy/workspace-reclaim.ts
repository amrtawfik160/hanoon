import type { BranchLandingVerdict } from "./branch-landing";

/**
 * What a workspace sweep may reclaim, and what it must leave alone.
 *
 * Threads accumulate worktrees and branches, and nothing ever removed either.
 * On 2026-08-16 this repository had 23 worktrees and 77 branches, nearly all of
 * them belonging to work that had finished days earlier. The clutter is the
 * visible cost; the real one is that a finished branch and an unfinished branch
 * look identical in that list, so neither gets touched.
 *
 * This decides. It is pure: it takes observations and returns a plan. Removing
 * a directory, saving a patch, and deleting a ref all belong to the caller, so
 * every rule below can be read and tested without a filesystem.
 *
 * The posture is the same one the disk sweep uses: every guard fails CLOSED. A
 * thread whose status could not be read counts as running. A branch whose
 * landing could not be proved counts as unfinished. Keeping something costs a
 * directory or a ref; removing the wrong thing costs the work inside it.
 */

/** How long a worktree must sit untouched before it is a candidate. */
export const RECLAIM_MIN_IDLE_MS = 24 * 60 * 60_000;

/**
 * The most one run may reclaim. A sweep that is wrong should be wrong about a
 * bounded number of things, and leave the rest for a human to notice first.
 */
export const RECLAIM_PER_RUN_CAP = 20;

/**
 * The state of the thread that owns a worktree. `none` means no thread claims
 * it; `unknown` means the lookup failed, which is treated as still running.
 */
export type ThreadStatus = "running" | "terminal" | "unknown" | "none";

/** Statuses that mean a thread is still working, so its worktree is in use. */
const RUNNING_STATUSES: readonly string[] = ["active", "running", "starting"];

/**
 * Statuses that mean the thread has stopped. `idle` and `error` are included
 * deliberately: both describe a thread that finished its turn, and holding a
 * worktree for every one of them is how 23 of them accumulated. The idle grace
 * window and the landed-branch requirement are what make that safe, not this.
 */
const FINISHED_STATUSES: readonly string[] = ["idle", "error", "archived", "completed"];

/**
 * Reads BB's thread status. An unrecognised status is `unknown` rather than
 * finished, so a status BB adds later cannot silently become a licence to
 * delete a worktree.
 */
export function classifyThreadStatus(status: string | null | undefined): ThreadStatus {
  if (status === null) return "none";
  if (status === undefined) return "unknown";
  if (RUNNING_STATUSES.includes(status)) return "running";
  if (FINISHED_STATUSES.includes(status)) return "terminal";
  return "unknown";
}

export type WorktreeObservation = {
  path: string;
  /** null when the worktree is detached, which leaves no branch to delete. */
  branch: string | null;
  threadStatus: ThreadStatus;
  dirty: boolean;
  lastActivityAt: number;
};

export type ReclaimTarget = {
  path: string;
  branch: string | null;
  /** Uncommitted changes must be captured before the directory goes. */
  preserveUncommitted: boolean;
};

export type PreservedItem = { subject: string; reason: string };

export type WorkspaceReclaimPlan = {
  removeWorktrees: readonly ReclaimTarget[];
  deleteBranches: readonly string[];
  preserved: readonly PreservedItem[];
  /** True when the per-run cap held work back, so the report can say so. */
  truncated: boolean;
};

function isProtectedPath(path: string, protectedPaths: readonly string[]): boolean {
  return protectedPaths.some((root) => path === root || path.startsWith(`${root}/`));
}

/** Why this worktree may not be reclaimed, or null when it may. */
function worktreeBlocker(
  worktree: WorktreeObservation,
  input: Readonly<{ protectedPaths: readonly string[]; now: number; minIdleMs: number }>,
): string | null {
  if (isProtectedPath(worktree.path, input.protectedPaths)) return "protected path";
  if (worktree.threadStatus === "running") return "thread still running";
  if (worktree.threadStatus === "unknown") return "thread status could not be read";
  if (input.now - worktree.lastActivityAt < input.minIdleMs) return "active recently";
  return null;
}

/** Why this branch may not be deleted, or null when it may. */
function branchBlocker(
  branch: string,
  input: Readonly<{
    landing: Readonly<Record<string, BranchLandingVerdict>>;
    protectedBranches: readonly string[];
    heldBranches: ReadonlySet<string>;
  }>,
): string | null {
  if (input.protectedBranches.includes(branch)) return "protected branch";
  if (input.heldBranches.has(branch)) return "checked out in a worktree that is being kept";
  const verdict = input.landing[branch];
  if (verdict === undefined) return "landing was never determined";
  if (verdict.kind === "indeterminate") return `landing indeterminate: ${verdict.reason}`;
  if (verdict.kind === "outstanding") return "work has not landed in the trunk";
  return null;
}

export function planWorkspaceReclaim(input: Readonly<{
  worktrees: readonly WorktreeObservation[];
  branches: readonly string[];
  landing: Readonly<Record<string, BranchLandingVerdict>>;
  protectedPaths: readonly string[];
  protectedBranches: readonly string[];
  now: number;
  minIdleMs?: number;
  maxPerRun?: number;
}>): WorkspaceReclaimPlan {
  const minIdleMs = input.minIdleMs ?? RECLAIM_MIN_IDLE_MS;
  const maxPerRun = input.maxPerRun ?? RECLAIM_PER_RUN_CAP;

  const preserved: PreservedItem[] = [];
  const removable: ReclaimTarget[] = [];
  const keptWorktrees: WorktreeObservation[] = [];

  // Oldest first, so a capped run reclaims the most stale work and the order is
  // stable rather than dependent on how git happened to list things.
  const byAge = [...input.worktrees].sort((a, b) => a.lastActivityAt - b.lastActivityAt);

  for (const worktree of byAge) {
    const blocker = worktreeBlocker(worktree, { ...input, minIdleMs });
    if (blocker !== null) {
      preserved.push({ subject: worktree.path, reason: blocker });
      keptWorktrees.push(worktree);
      continue;
    }
    removable.push({
      path: worktree.path,
      branch: worktree.branch,
      preserveUncommitted: worktree.dirty,
    });
  }

  const removeWorktrees = removable.slice(0, maxPerRun);
  for (const held of removable.slice(maxPerRun)) {
    preserved.push({ subject: held.path, reason: "held back by this run's cap" });
    // A worktree the cap held back still holds its branch.
    const original = byAge.find((w) => w.path === held.path);
    if (original) keptWorktrees.push(original);
  }

  const heldBranches = new Set(
    keptWorktrees.map((w) => w.branch).filter((b): b is string => b !== null),
  );

  const deletable: string[] = [];
  for (const branch of input.branches) {
    const blocker = branchBlocker(branch, { ...input, heldBranches });
    if (blocker !== null) {
      preserved.push({ subject: branch, reason: blocker });
      continue;
    }
    deletable.push(branch);
  }

  const deleteBranches = deletable.slice(0, maxPerRun);
  for (const held of deletable.slice(maxPerRun)) {
    preserved.push({ subject: held, reason: "held back by this run's cap" });
  }

  return {
    removeWorktrees,
    deleteBranches,
    preserved,
    truncated: removable.length > maxPerRun || deletable.length > maxPerRun,
  };
}
