import { shellSingleQuote } from "./terminal-command";
import type { CommandResult } from "./terminal-command";

/**
 * Refuses work in a worktree that was cut from a different root commit than the
 * trunk it is supposed to merge into.
 *
 * BB provisions a managed worktree from a base branch. When a spawn site omits
 * that base, BB falls back to the project's default branch, and if that default
 * belongs to an unrelated history the worker starts on a tree that can never be
 * merged back. `git merge-base` is the cheapest authoritative test: it reports a
 * commit when the two share any ancestor and exits 1 with no output when they do
 * not.
 */
export type AncestryCommandRunner = {
  run(input: {
    scope: { kind: "environment"; environmentId: string };
    title: string;
    command: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<CommandResult>;
};

export type AncestryVerdict =
  | { kind: "shared"; mergeBase: string }
  | { kind: "disjoint" }
  | { kind: "unknown"; reason: string };

const MERGE_BASE_TIMEOUT_MS = 60_000;
const SHA = /^[0-9a-f]{40}$/;

export class DisjointHistoryError extends Error {
  public constructor(public readonly trunk: string, message: string) {
    super(message);
    this.name = "DisjointHistoryError";
  }
}

export function mergeBaseCommand(trunk: string): string {
  return `git merge-base ${shellSingleQuote(trunk)} HEAD`;
}

/** Maps a `git merge-base` run onto a verdict without deciding what to do about it. */
export function readMergeBaseResult(result: CommandResult): AncestryVerdict {
  if (result.outcome === "timed_out") return { kind: "unknown", reason: "the check timed out" };
  if (result.outcome === "aborted") return { kind: "unknown", reason: "the check was aborted" };

  const output = result.output.trim();
  if (result.exitCode === 0) {
    if (!SHA.test(output)) return { kind: "unknown", reason: "git returned no usable merge base" };
    return { kind: "shared", mergeBase: output };
  }
  // git exits 1 with empty output for "no common ancestor". Any other exit code
  // (128 for a missing ref, for example) is a different problem and must not be
  // reported as a disjoint history.
  if (result.exitCode === 1 && output.length === 0) return { kind: "disjoint" };
  return { kind: "unknown", reason: `git exited ${String(result.exitCode)}` };
}

export function disjointHistoryMessage(trunk: string): string {
  return [
    `This worktree shares no commit history with ${trunk}.`,
    `It was cut from an unrelated root commit, so nothing committed here can ever merge into ${trunk}.`,
    "Stop work in this worktree rather than rebasing it by hand.",
    `Start the thread again with an explicit base branch (bb thread spawn --base-branch ${trunk}).`,
    `If ${trunk} is not the real trunk, correct the project policy baseBranch first, because every future worktree will repeat this.`,
  ].join(" ");
}

/**
 * Throws when the worktree provably shares no ancestor with `trunk`.
 *
 * An indeterminate result is not treated as a failure: a timed-out or
 * misconfigured check must not block a worktree whose history is fine.
 */
export async function assertSharedTrunkAncestry(input: {
  runner: AncestryCommandRunner;
  environmentId: string;
  trunk: string;
  signal?: AbortSignal;
  onIndeterminate?: (reason: string) => void;
}): Promise<AncestryVerdict> {
  const command = mergeBaseCommand(input.trunk);
  let result: CommandResult;
  try {
    result = await input.runner.run({
      scope: { kind: "environment", environmentId: input.environmentId },
      title: `Telegram trunk ancestry: ${input.trunk}`.slice(0, 80),
      command,
      timeoutMs: MERGE_BASE_TIMEOUT_MS,
      signal: input.signal,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    input.onIndeterminate?.(reason);
    return { kind: "unknown", reason };
  }

  const verdict = readMergeBaseResult(result);
  if (verdict.kind === "disjoint") {
    throw new DisjointHistoryError(input.trunk, disjointHistoryMessage(input.trunk));
  }
  if (verdict.kind === "unknown") input.onIndeterminate?.(verdict.reason);
  return verdict;
}
