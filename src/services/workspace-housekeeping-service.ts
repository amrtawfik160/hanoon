import type { BranchLandingVerdict } from "../autonomy/branch-landing";
import {
  planWorkspaceReclaim,
  type WorkspaceReclaimPlan,
  type WorktreeObservation,
} from "../autonomy/workspace-reclaim";
import { redactError } from "../errors";
import type { TelegramAgentStore } from "../storage/store";

/** Daily. Worktrees and branches accrete over days, never over minutes. */
export const WORKSPACE_SCAN_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * How long after startup the first sweep waits. Long enough that the executor's
 * first ticks belong to whatever the owner asked for while the plugin was down,
 * and nothing here is urgent to the minute.
 */
export const WORKSPACE_STARTUP_DELAY_MS = 10 * 60_000;

/** A day, so a sweep that keeps reclaiming does not report every tick. */
export const WORKSPACE_NOTICE_DEDUP_MS = 24 * 60 * 60_000;

/** One repository the sweep is responsible for, and what it must not touch. */
export type ProjectWorkspace = {
  projectId: string;
  label: string;
  /** The branch work is expected to land in. Landing is judged against this. */
  trunk: string;
  /** Checkouts that are never reclaimable: the project source, the main clone. */
  protectedPaths: readonly string[];
  protectedBranches: readonly string[];
};

/**
 * Everything the sweep needs from the outside world. Kept behind one interface
 * so every rule above it can be tested without a filesystem or a git binary.
 */
export type WorkspaceAccess = {
  listProjects(): Promise<readonly ProjectWorkspace[]>;
  listWorktrees(project: ProjectWorkspace): Promise<readonly WorktreeObservation[]>;
  listBranches(project: ProjectWorkspace): Promise<readonly string[]>;
  probeLanding(project: ProjectWorkspace, branch: string): Promise<BranchLandingVerdict>;
  /** Captures uncommitted work somewhere durable; returns where it was put. */
  preserveUncommitted(project: ProjectWorkspace, path: string): Promise<string | null>;
  removeWorktree(project: ProjectWorkspace, path: string): Promise<void>;
  deleteBranch(project: ProjectWorkspace, branch: string): Promise<void>;
};

export type WorkspaceHousekeepingDependencies = {
  store: Pick<
    TelegramAgentStore,
    "getOwner" | "getControllerForOwner" | "enqueueControllerTurn" | "claimHousekeepingNotice"
  >;
  workspace: WorkspaceAccess;
  clock: { now(): number };
  issueUpdateId(now: number): number;
  /** Off means plan and report, change nothing. */
  reclaimArmed(): boolean;
  warn?: (message: string) => void;
};

export type WorkspaceHousekeepingOutcome = Readonly<{
  plans: readonly { project: ProjectWorkspace; plan: WorkspaceReclaimPlan }[];
  removedWorktrees: readonly string[];
  deletedBranches: readonly string[];
  notified: boolean;
}>;

/** Plain sentence for the owner. Counts only, because that is the whole story. */
export function workspaceReclaimNotice(
  removedWorktrees: number,
  deletedBranches: number,
  keptBack: number,
): string {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    `I tidied up finished work: removed ${count(removedWorktrees, "worktree", "worktrees")}`,
    `and ${count(deletedBranches, "branch", "branches")}.`,
  ];
  if (keptBack > 0) {
    parts.push(`I left ${keptBack} alone because I could not prove they were finished.`);
  }
  return parts.join(" ");
}

/**
 * The sweep that keeps finished work from piling up.
 *
 * Nothing ever reclaimed a worktree or a branch, so they accumulated until a
 * finished branch and an unfinished one were indistinguishable in the list.
 * This removes only what it can prove is done, and says what it left behind.
 *
 * Every step is independently guarded. A project that cannot be read costs that
 * project's sweep and nothing else, and a directory that will not go costs that
 * directory. The one ordering that is not best-effort is preserve-then-remove:
 * uncommitted work is captured first, and a capture that fails cancels the
 * removal rather than proceeding without it.
 */
export class WorkspaceHousekeepingService {
  private nextScanAt: number | null = null;

  public constructor(private readonly dependencies: WorkspaceHousekeepingDependencies) {}

  /**
   * Whether a sweep is owed, decided synchronously.
   *
   * The executor ticks constantly and this runs daily, so a caller that awaited
   * on every tick would pay a scheduling yield tens of thousands of times to
   * learn "not yet" — and that yield is observable, because it hands unrelated
   * in-flight work a turn it would not otherwise have had.
   */
  public due(now: number): boolean {
    if (this.nextScanAt === null) {
      this.nextScanAt = now + WORKSPACE_STARTUP_DELAY_MS;
      return false;
    }
    return now >= this.nextScanAt;
  }

  public async processDue(): Promise<boolean> {
    const now = this.dependencies.clock.now();
    if (!this.due(now)) return false;
    this.nextScanAt = now + WORKSPACE_SCAN_INTERVAL_MS;
    try {
      const outcome = await this.sweep(now);
      return outcome.removedWorktrees.length > 0 || outcome.deletedBranches.length > 0;
    } catch (error) {
      this.dependencies.warn?.(
        `Workspace housekeeping did not complete: ${redactError(error).slice(0, 200)}`,
      );
      return false;
    }
  }

  /** Exposed for tests and for a deliberate one-off; `processDue` paces it. */
  public async sweep(now: number): Promise<WorkspaceHousekeepingOutcome> {
    let projects: readonly ProjectWorkspace[] = [];
    try {
      projects = await this.dependencies.workspace.listProjects();
    } catch (error) {
      this.dependencies.warn?.(`Projects could not be listed: ${redactError(error).slice(0, 200)}`);
      return { plans: [], removedWorktrees: [], deletedBranches: [], notified: false };
    }

    const plans: { project: ProjectWorkspace; plan: WorkspaceReclaimPlan }[] = [];
    const removedWorktrees: string[] = [];
    const deletedBranches: string[] = [];
    let keptBack = 0;

    for (const project of projects) {
      let plan: WorkspaceReclaimPlan;
      try {
        plan = await this.planFor(project, now);
      } catch (error) {
        // One project's git being unreadable is that project's sweep, not the
        // sweep. The others still run.
        this.dependencies.warn?.(
          `Workspace sweep skipped ${project.label}: ${redactError(error).slice(0, 160)}`,
        );
        continue;
      }
      plans.push({ project, plan });
      keptBack += plan.preserved.length;

      if (!this.dependencies.reclaimArmed()) {
        if (plan.removeWorktrees.length > 0 || plan.deleteBranches.length > 0) {
          this.dependencies.warn?.(
            `Workspace sweep found reclaimable work in ${project.label} but reclaim is not armed`,
          );
        }
        continue;
      }

      const applied = await this.apply(project, plan);
      removedWorktrees.push(...applied.removed);
      deletedBranches.push(...applied.deleted);
    }

    const notified = this.notify(removedWorktrees.length, deletedBranches.length, keptBack, now);
    return { plans, removedWorktrees, deletedBranches, notified };
  }

  private async planFor(project: ProjectWorkspace, now: number): Promise<WorkspaceReclaimPlan> {
    const worktrees = await this.dependencies.workspace.listWorktrees(project);
    const allBranches = await this.dependencies.workspace.listBranches(project);
    // Protected branches are filtered before probing rather than after: the
    // planner would refuse them anyway, and probing costs three git calls each.
    const branches = allBranches.filter((b) => !project.protectedBranches.includes(b));

    const landing: Record<string, BranchLandingVerdict> = {};
    for (const branch of branches) {
      try {
        landing[branch] = await this.dependencies.workspace.probeLanding(project, branch);
      } catch (error) {
        landing[branch] = {
          kind: "indeterminate",
          reason: `probe failed: ${redactError(error).slice(0, 80)}`,
        };
      }
    }

    return planWorkspaceReclaim({
      worktrees,
      branches,
      landing,
      protectedPaths: project.protectedPaths,
      protectedBranches: project.protectedBranches,
      now,
    });
  }

  private async apply(
    project: ProjectWorkspace,
    plan: WorkspaceReclaimPlan,
  ): Promise<{ removed: string[]; deleted: string[] }> {
    const removed: string[] = [];
    // A branch whose worktree would not go is still checked out, so deleting it
    // would fail anyway and reporting it as reclaimed would be a lie.
    const stillHeld = new Set<string>();

    for (const target of plan.removeWorktrees) {
      if (target.preserveUncommitted) {
        try {
          const saved = await this.dependencies.workspace.preserveUncommitted(project, target.path);
          if (saved === null) throw new Error("no location returned");
        } catch (error) {
          this.dependencies.warn?.(
            `Kept ${target.path}: its uncommitted work could not be saved (${redactError(error).slice(0, 120)})`,
          );
          if (target.branch !== null) stillHeld.add(target.branch);
          continue;
        }
      }
      try {
        await this.dependencies.workspace.removeWorktree(project, target.path);
        removed.push(target.path);
      } catch (error) {
        this.dependencies.warn?.(
          `Worktree ${target.path} could not be removed: ${redactError(error).slice(0, 120)}`,
        );
        if (target.branch !== null) stillHeld.add(target.branch);
      }
    }

    const deleted: string[] = [];
    for (const branch of plan.deleteBranches) {
      if (stillHeld.has(branch)) continue;
      try {
        await this.dependencies.workspace.deleteBranch(project, branch);
        deleted.push(branch);
      } catch (error) {
        this.dependencies.warn?.(
          `Branch ${branch} could not be deleted: ${redactError(error).slice(0, 120)}`,
        );
      }
    }
    return { removed, deleted };
  }

  private notify(removed: number, deleted: number, keptBack: number, now: number): boolean {
    if (removed === 0 && deleted === 0) return false;
    const owner = this.dependencies.store.getOwner();
    if (!owner) return false;
    const controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
    if (!controller) return false;
    if (!this.dependencies.store.claimHousekeepingNotice({
      key: "workspace:reclaim",
      detail: `${removed} worktrees, ${deleted} branches`,
      now,
      dedupMs: WORKSPACE_NOTICE_DEDUP_MS,
    })) return false;
    this.dependencies.store.enqueueControllerTurn({
      controllerKey: controller.controllerKey,
      telegramUserId: owner.userId,
      telegramChatId: owner.chatId,
      updateId: this.dependencies.issueUpdateId(now),
      inputText: workspaceReclaimNotice(removed, deleted, keptBack),
      // Not the owner speaking; this must never read as their verdict on the
      // previous answer.
      origin: "system",
      now,
    });
    return true;
  }
}
