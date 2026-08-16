# Repository history: why `main` is disjoint from the work

This note records a repository-level fault found on 2026-08-15. It explains what
is wrong, how the repository reached this state, and what was changed in code to
stop it recurring. Reconciling `main` itself is an owner decision and has not
been done.

## What is wrong

The repository contains two unrelated root commits:

| Root | Date | Description |
| --- | --- | --- |
| `0ad7cb9` | 2026-08-09 17:58 | `docs: design Telegram BB agent plugin` — the original history |
| `35e59f1` | 2026-08-10 20:27 | `feat: Hanoon, a private Telegram agent for BB` — a second, unrelated root |

`main` and `origin/main` are both `85b8e6a`, six commits deep, and descend from
`35e59f1`. Every branch carrying real work descends from `0ad7cb9`. The two have
no common ancestor at all, so `git merge-base main <any work branch>` returns
nothing.

There are three lines, not two:

| Line | Root | Depth | Last commit | Status |
| --- | --- | --- | --- | --- |
| `main` | `35e59f1` | 6 | 2026-08-12 | Published on GitHub, disjoint from the work |
| `feature/telegram-agent-implementation` (`d4f2446`) | `0ad7cb9` | 83 | 2026-08-10 23:04 | Abandoned |
| The live work (`c11da25` and siblings) | `0ad7cb9` | 260–277 | 2026-08-15 23:20 | Where all current work happens |

The abandoned line and the live line split at `530e1e6` (depth 3, 2026-08-09
19:01). Their unique commits share no commit subjects, so the two grew
independently rather than one being a rebase of the other. Files such as
`src/controller/finalization-contract.ts` exist only on the live line.

## How it happened

`35e59f1` is a single big-bang commit containing the entire plugin tree. Its
tree matches no other commit in the repository, which is the signature of a tree
published into a fresh history rather than a commit that grew from one — the
usual cause is initialising a new repository over an existing working tree and
pushing that as the first commit.

Every later commit on `main` is a squashed copy of a commit that already existed
locally. Each `main` commit's tree is byte-identical to a local commit on one of
the `0ad7cb9` lines:

| `main` commit | Identical tree on a local commit |
| --- | --- |
| `ee08e62` (PR #1) | `1ee7de5` |
| `5844ab8` (PR #2) | `74023f0` |
| `504620e` (PR #3) | `363b33e` |
| `830226c` (PR #4) | `f2254b27` |

So the work was published to GitHub by copying trees into squashed pull requests
against a history that never contained the commits those trees came from. Each
publish reproduced the content and dropped the ancestry. Because `main` was fed
from both the abandoned line and the live line at different times, no single
local branch corresponds to it.

Nothing is lost: `main` contains no file that is absent from the live line.

## Why it kept costing work

BB provisions a managed worktree from a base branch, and when a spawn site omits
that base BB falls back to the project's default branch. That default is `main`.
New threads were therefore cut from the six-commit disjoint history, and the
work in them could not be merged back without a manual rebase.

Two spawn sites relied on that default:

- `src/controller/thread-observer.ts` — threads the controller opens for the owner
- `src/plugin.ts` — the hidden memory-extraction thread

The guarded job pipeline in `src/bb/runner.ts` was already passing an explicit
named base branch, which is why jobs were less affected than ad-hoc threads.

## What changed in code

- `createProjectThread` now requires an explicit `baseBranch` and rejects a blank
  one. There is no default to fall back to.
- Both controller spawn sites resolve the base branch from the project's stored
  policy. A project with no configured base branch is an error rather than a
  silent fallback.
- The memory-extraction thread resolves its base branch the same way.
- `src/bb/worktree-ancestry.ts` runs `git merge-base <trunk> HEAD` in a new
  worktree. A commit means shared history; git's empty exit 1 means the histories
  are disjoint and the job refuses to start, naming the trunk and telling the
  operator to respawn with an explicit base branch. Any other outcome, including
  a missing ref or a timed-out check, is treated as indeterminate and does not
  block work.
- The check runs once per environment, in `EffectRunner.spawnImplementation`,
  before the worker is given a scratchpad or the job moves to `implementing`.

## The trunk

The live line previously had no trunk branch, which is why BB fell back to
`main`. It now has one: `trunk`, assembled on 2026-08-16 from

- `c11da25`, the fullest existing live tip at 277 commits,
- `6ea6ef8`, the base-branch and ancestry fix described above,
- `a5da950`, merged cleanly with no file overlap against the work already in
  `c11da25`.

`npm run check` on the assembled result is green: typecheck clean, 3793 tests
across 134 files, build and artifact verification pass.

Two live tips were **not** merged, because each conflicts with the trunk:

| Tip | Conflicting files |
| --- | --- |
| `930e235` | `src/plugin.ts` |
| `ba2710b` | `scripts/eval-controller-answers.mjs`, `src/eval/answer-contract.ts`, `src/eval/eval-integrity.ts`, `tests/answer-contract.test.ts`, `tests/eval-integrity-race.test.ts` |

Both conflict against `c11da25` as well, so neither was caused by the fix
commit. They are set aside rather than abandoned: the work is intact on its own
branches and can be merged once the conflicts are resolved deliberately.

## What is still open

`main` is unchanged and still disjoint. Reconciling it, if it is ever wanted,
is covered in [`docs/main-reconciliation-options.md`](main-reconciliation-options.md).

Every project policy `baseBranch` must name `trunk`. Pointing it at `main` will
make the ancestry guard refuse every job, which is the intended behaviour but is
not a fix.
