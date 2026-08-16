# Options for reconciling `main` with the real history

Background is in [`docs/repository-history.md`](repository-history.md). In short:
`main` (`85b8e6a`, 6 commits) and every branch carrying real work have no common
ancestor. This document lists the ways to reconcile them, what each risks, and
what it costs to undo.

## Status: Option A taken, 2026-08-16

The live line was given a trunk branch, `trunk`, and `main` was left exactly as
it stands. Nothing was rewritten and no published history changed. How `trunk`
was assembled, and which tips were left out, is recorded in
[`docs/repository-history.md`](repository-history.md).

One step remains, and it is the one that actually stops threads being cut from
the wrong history: **decide whether `trunk` becomes the GitHub default branch.**
`main` is still the default today.

That turned out not to be cosmetic. BB resolves a no-base spawn against
`origin/main`, from a project default branch it tracks from GitHub. Neither
moving the project source path nor moving the underlying clone onto `trunk`
changed it; both were tried and measured. Until the GitHub default changes, every
spawn on this project has to pass `--base-branch trunk` explicitly. The evidence
is in [`docs/repository-history.md`](repository-history.md).

Repointing project policy `baseBranch` values is *not* on this list. No policy
row exists for this repository, and the six that do exist belong to other
repositories where `main` is the correct trunk.

Options B, C and D below stay available and unblocked. They are recorded so that
if one ever becomes necessary, the reasoning does not have to be rebuilt.

## Facts the choice rests on

- `main` and `origin/main` are both `85b8e6a`. `main` is the GitHub default branch
  and is not protected, so nothing on GitHub blocks any option below.
- `main` contains no file that is absent from the live line. Nothing is lost by
  any option below; the disagreement is only about ancestry.
- The live line's trunk is `trunk` (281 commits). Before 2026-08-16 it had no
  trunk branch at all, which is what made BB fall back to `main`.
- `930e235` and `ba2710b` are still outside `trunk`, each because of merge
  conflicts recorded in [`docs/repository-history.md`](repository-history.md).
- Four merged pull requests (#1–#4) are attached to `main`'s history. There are
  no open pull requests.
- 19 of the 21 active worktrees are checked out on live-line branches.

## Precondition for the remaining options

Two steps first, if B, C or D is ever chosen:

1. Merge `930e235` and `ba2710b` into `trunk`, resolving their conflicts
   deliberately, so one ref genuinely contains all the work. Without this, any
   option below silently leaves work behind.
2. Push backup refs for `main` and `trunk` before touching anything, so every
   option's undo is a fetch rather than a recovery.

## Option A — Name the live line as trunk, leave `main` alone

Create a branch (`trunk`) at the integration tip, push it, and make it the GitHub
default. `main` stays exactly as it is, as a historical branch. This is the
option that was taken, except that the GitHub default has not been switched yet.

- **Risk: low.** No published history is rewritten. The repository keeps two
  unrelated branches, which is untidy and needs explaining to anyone new. Every
  project policy `baseBranch` must be repointed at the new trunk. No open pull
  requests need retargeting today, but any opened against `main` later would.
- **Cost to undo: trivial.** Set the GitHub default back to `main` and delete the
  new branch. No commit is rewritten, so no clone is invalidated.

## Option B — Merge the live line into `main` with unrelated histories

`git merge --allow-unrelated-histories` on `main`, taking the live tree wholesale,
producing a merge commit with two roots.

- **Risk: medium.** The merge touches essentially every file and must be resolved
  to exactly the live tip's content; a sloppy resolution silently reintroduces
  stale `main` versions of files. `main` then has two root commits permanently
  and `git log` reads oddly. Nothing is force-pushed and the four merged pull
  requests stay reachable.
- **Cost to undo: moderate.** Revert the merge commit, or reset `main` to
  `85b8e6a` and force-push. Cheap on the same day, progressively worse once
  branches and CI are cut from the merged `main`.

## Option C — Force `main` to the live tip

`git branch -f main <tip>` and force-push, replacing `main`'s six commits.

- **Risk: high.** Rewrites published history on the default branch. `main` is
  unprotected, so nothing on GitHub will stop this — the safety has to come from
  the operator. Every existing clone and worktree on `main` breaks and needs a
  hard reset. The four merged pull requests stop being
  reachable from `main`, so the GitHub record of how the project was published
  becomes misleading.
- **Cost to undo: moderate but disruptive.** `85b8e6a` is recoverable from the
  backup ref, so undoing is another force-push, and anyone who re-synced in the
  meantime is whipsawed twice.

## Option D — Graft the live line onto `main`'s root

Rewrite the live history so its root's parent becomes `main`'s root, giving one
continuous history.

- **Risk: very high.** Rewrites all 277 live commits, so every commit SHA on the
  live line changes. All `bb/*` thread branches, all `backup/*` refs and roughly
  twenty active worktrees are invalidated at once, and in-flight threads lose the
  commits they are working against. The stored job records that pin exact head
  SHAs no longer match anything.
- **Cost to undo: expensive.** Every branch must be restored from backups
  individually, and any work committed after the rewrite has to be replayed by
  hand.

## Option E — Do nothing

- **Risk: low in the short term, compounding.** The code changes described in
  `docs/repository-history.md` stop new threads being cut from `main`, so the
  day-to-day breakage is contained. But `main` stays a misleading default, the
  published GitHub history keeps diverging from the real one, and every future
  publish repeats the squash-onto-an-unrelated-root pattern that caused this.
- **Cost to undo: none.** This is the current state.

## Why Option A was chosen

It unblocks work immediately, is the only option that rewrites nothing, and its
undo is a single settings change. It also leaves Options B and C available later,
once the trunk is stable and there is time to do the merge carefully. Option D is
not worth its risk given that no content is actually missing from either side.
