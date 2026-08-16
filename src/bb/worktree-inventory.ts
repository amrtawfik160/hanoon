/**
 * Reading git's own account of what worktrees and branches exist.
 *
 * Both commands are fixed strings with no interpolation, so nothing here can be
 * made to run something else. The parsing is separated from the running so the
 * shapes git actually emits — a detached worktree with no branch, a branch name
 * containing slashes, a final block with no trailing blank line — can be tested
 * without a repository.
 */

export type WorktreeEntry = {
  path: string;
  /** null when the worktree is detached, which leaves no branch to delete. */
  branch: string | null;
};

export function worktreeListCommand(): string {
  return "git worktree list --porcelain";
}

export function branchListCommand(): string {
  return "git for-each-ref --format=%(refname:short) refs/heads/";
}

const BRANCH_PREFIX = "branch refs/heads/";
const WORKTREE_PREFIX = "worktree ";

/**
 * Porcelain output is blocks of `key value` lines separated by blank lines. A
 * block without a `worktree` line names nothing and is skipped rather than
 * guessed at.
 */
export function parseWorktreeList(output: string): readonly WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let path: string | null = null;
  let branch: string | null = null;

  const flush = () => {
    if (path !== null) entries.push({ path, branch });
    path = null;
    branch = null;
  };

  for (const raw of output.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(WORKTREE_PREFIX)) {
      // A new worktree line starts a block even if the last one never ended.
      flush();
      path = line.slice(WORKTREE_PREFIX.length).trim() || null;
      continue;
    }
    if (line.startsWith(BRANCH_PREFIX)) {
      branch = line.slice(BRANCH_PREFIX.length).trim() || null;
    }
    // `HEAD`, `detached`, `bare`, `locked` and anything else carry nothing this
    // needs: a block with no branch line is detached by construction.
  }
  flush();
  return entries;
}

/** git prints a parenthesised marker for a detached HEAD; it is not a branch. */
export function parseBranchList(output: string): readonly string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("("));
}
