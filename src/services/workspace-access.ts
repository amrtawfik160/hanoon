import {
  ancestorCommand,
  mergeTreeCommand,
  readBranchLanding,
  trunkTreeCommand,
  type BranchLandingVerdict,
} from "../autonomy/branch-landing";
import { classifyThreadStatus, type WorktreeObservation } from "../autonomy/workspace-reclaim";
import {
  branchListCommand,
  parseBranchList,
  parseWorktreeList,
} from "../bb/worktree-inventory";
import { shellSingleQuote } from "../bb/terminal-command";
import type { CommandResult, TerminalRunInput } from "../bb/terminal-command";
import type { TelegramAgentStore } from "../storage/store";
import type { ProjectWorkspace, WorkspaceAccess } from "./workspace-housekeeping-service";

/** Long enough for git on a large repository, short enough to never wedge a sweep. */
const GIT_TIMEOUT_MS = 60_000;

/** Where uncommitted work goes before its worktree is removed. */
const RESCUE_DIR = "$HOME/.hanoon-worktree-rescue";

type CommandRunner = { run(input: TerminalRunInput): Promise<CommandResult> };

type ProjectsApi = { list(args: Record<string, never>): Promise<readonly unknown[]> };
type ThreadsApi = { list(args: { projectId: string }): Promise<unknown> };

type ProjectSource = { hostId: string; path: string | null; isDefault?: boolean };
type ProjectRecord = { id: string; kind?: string; sources?: readonly ProjectSource[] };
type ThreadRecord = { environmentBranchName?: string | null; status?: string; updatedAt?: number };

/** Where a project's commands run. Kept out of ProjectWorkspace so the sweep's
 *  own types stay free of BB's host model. */
type HostTarget = { hostId: string; cwd: string | null };

function readOutput(result: CommandResult): string {
  return result.outcome === "exited" && result.exitCode === 0 ? result.output : "";
}

function defaultSource(project: ProjectRecord): ProjectSource | undefined {
  const sources = project.sources ?? [];
  return sources.find((candidate) => candidate.isDefault) ?? (
    sources.length === 1 ? sources[0] : undefined
  );
}

/**
 * The live implementation of the workspace sweep's view of the world.
 *
 * Everything here is I/O: running git on the project's own host and asking BB
 * which threads are still working. Every decision it feeds lives in the pure
 * modules, so this stays small enough to read in one go.
 */
export function createWorkspaceAccess(input: Readonly<{
  sdk: { projects: ProjectsApi; threads: ThreadsApi };
  store: Pick<TelegramAgentStore, "listEnabledProjectPolicies">;
  terminal: CommandRunner;
  warn?: (message: string) => void;
}>): WorkspaceAccess {
  const targets = new Map<string, HostTarget>();

  const run = async (project: ProjectWorkspace, title: string, command: string): Promise<CommandResult> => {
    const target = targets.get(project.projectId);
    if (!target) return { outcome: "aborted" };
    return input.terminal.run({
      scope: { kind: "host_path", hostId: target.hostId, cwd: target.cwd },
      title,
      command,
      timeoutMs: GIT_TIMEOUT_MS,
    });
  };

  return {
    async listProjects() {
      const policies = input.store.listEnabledProjectPolicies();
      if (policies.length === 0) return [];
      const projects = (await input.sdk.projects.list({})) as readonly ProjectRecord[];
      const workspaces: ProjectWorkspace[] = [];
      for (const { policy } of policies) {
        const project = projects.find((candidate) => candidate.id === policy.projectId);
        if (!project || (project.kind !== undefined && project.kind !== "standard")) continue;
        const source = defaultSource(project);
        if (!source || source.hostId.trim().length === 0 || source.path === null) continue;
        targets.set(policy.projectId, { hostId: source.hostId, cwd: source.path });
        workspaces.push({
          projectId: policy.projectId,
          label: policy.alias ?? policy.projectId,
          trunk: policy.baseBranch,
          // The project's own checkout is where these commands run. Reclaiming
          // it would delete the ground the sweep is standing on.
          protectedPaths: [source.path],
          protectedBranches: [policy.baseBranch, "main", "trunk"],
        });
      }
      return workspaces;
    },

    async listWorktrees(project) {
      const listed = parseWorktreeList(readOutput(
        await run(project, "worktree inventory", "git worktree list --porcelain"),
      ));
      if (listed.length === 0) return [];

      // One lookup for the whole project rather than one per worktree.
      const byBranch = new Map<string, ThreadRecord>();
      try {
        const raw = await input.sdk.threads.list({ projectId: project.projectId });
        const threads = (Array.isArray(raw) ? raw : (raw as { threads?: unknown })?.threads ?? []) as readonly ThreadRecord[];
        for (const thread of threads) {
          const branch = thread.environmentBranchName;
          if (typeof branch === "string" && branch.length > 0) byBranch.set(branch, thread);
        }
      } catch (error) {
        // Without thread statuses every worktree reads as unknown, which the
        // planner keeps. Losing this lookup costs a sweep, never a directory.
        input.warn?.(`Thread statuses unavailable for ${project.label}: ${String(error).slice(0, 120)}`);
        return listed.map((entry): WorktreeObservation => ({
          path: entry.path,
          branch: entry.branch,
          threadStatus: "unknown",
          dirty: false,
          lastActivityAt: Number.MAX_SAFE_INTEGER,
        }));
      }

      const observations: WorktreeObservation[] = [];
      for (const entry of listed) {
        const thread = entry.branch === null ? undefined : byBranch.get(entry.branch);
        const dirty = readOutput(
          await run(project, "worktree state", `git -C ${shellSingleQuote(entry.path)} status --porcelain`),
        ).trim().length > 0;
        observations.push({
          path: entry.path,
          branch: entry.branch,
          threadStatus: classifyThreadStatus(thread === undefined ? null : thread.status),
          dirty,
          // A worktree no thread claims has no work in flight, so it is only
          // held back by the landed-branch rule, not by the idle window.
          lastActivityAt: typeof thread?.updatedAt === "number" ? thread.updatedAt : 0,
        });
      }
      return observations;
    },

    async listBranches(project) {
      return parseBranchList(readOutput(await run(project, "branch inventory", branchListCommand())));
    },

    async probeLanding(project, branch): Promise<BranchLandingVerdict> {
      const [ancestor, mergeTree, trunkTree] = [
        await run(project, "landing: ancestry", ancestorCommand(branch, project.trunk)),
        await run(project, "landing: merge", mergeTreeCommand(branch, project.trunk)),
        await run(project, "landing: trunk tree", trunkTreeCommand(project.trunk)),
      ];
      return readBranchLanding({ ancestor, mergeTree, trunkTree });
    },

    async preserveUncommitted(project, path) {
      // Named after the worktree so two rescues cannot overwrite each other.
      const name = path.replaceAll(/[^A-Za-z0-9._-]/g, "_");
      const destination = `${RESCUE_DIR}/${name}.patch`;
      // Double quotes, not single: `$HOME` has to be expanded by the shell on
      // the host that owns the worktree, and single-quoting it made every
      // rescue redirect into a directory literally named `$HOME`. `mkdir` was
      // unquoted and did expand, so the directory appeared and every write into
      // it failed — which is exactly how it read in the logs. The name is
      // already reduced to [A-Za-z0-9._-], so it is safe unquoted here.
      const result = await run(
        project,
        "preserve uncommitted work",
        `mkdir -p "${RESCUE_DIR}" && git -C ${shellSingleQuote(path)} diff HEAD > "${destination}"`,
      );
      if (result.outcome !== "exited" || result.exitCode !== 0) {
        throw new Error(`could not write ${destination}`);
      }
      return destination;
    },

    async removeWorktree(project, path) {
      const result = await run(
        project,
        "remove worktree",
        `git worktree remove --force ${shellSingleQuote(path)}`,
      );
      if (result.outcome !== "exited" || result.exitCode !== 0) {
        throw new Error(`git worktree remove exited ${result.outcome === "exited" ? result.exitCode : result.outcome}`);
      }
    },

    async deleteBranch(project, branch) {
      // -D rather than -d: a squash-merged branch is not "merged" by git's own
      // reckoning, and the landing oracle has already proved this one is in.
      const result = await run(project, "delete branch", `git branch -D ${shellSingleQuote(branch)}`);
      if (result.outcome !== "exited" || result.exitCode !== 0) {
        throw new Error(`git branch -D exited ${result.outcome === "exited" ? result.exitCode : result.outcome}`);
      }
    },
  };
}
