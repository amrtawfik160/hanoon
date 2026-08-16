# Options for reconciling `main` with the real history

Background is in [`docs/repository-history.md`](repository-history.md). In short:
`main` (`85b8e6a`, 6 commits) and every branch carrying real work have no common
ancestor. This document lists the ways to reconcile them, what each risks, and
what it costs to undo. **Nothing here has been done.** Choosing between these
changes published history and is the owner's call.

## Facts the choice rests on

- `main` and `origin/main` are both `85b8e6a`. `main` is the GitHub default branch
  and is not protected, so nothing on GitHub blocks any option below.
- `main` contains no file that is absent from the live line. Nothing is lost by
  any option below; the disagreement is only about ancestry.
- The live line has **no trunk branch**. It exists only as `bb/*` thread branches
  and `backup/*` branches. The fullest single ref is `c11da25` (277 commits),
  which still does not contain three in-flight tips: `a5da950`, `930e235`, `ba2710b`.
- Four merged pull requests (#1–#4) are attached to `main`'s history. There are
  no open pull requests.
- 19 of the 21 active worktrees are checked out on live-line branches.

## Precondition for every option

Two steps first, whichever option is chosen:

1. Pick the integration tip and merge the three stragglers into it, so one ref
   genuinely contains all the work. Without this, any option below silently
   leaves work behind.
2. Push backup refs for `main` and the chosen tip before touching anything, so
   every option's undo is a fetch rather than a recovery.

## Option A — Name the live line as trunk, leave `main` alone

Create a branch (for example `trunk`) at the integration tip, push it, and make
it the GitHub default. `main` stays exactly as it is, as a historical branch.

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

## Recommendation

Option A. It unblocks work immediately, is the only option that rewrites nothing,
and its undo is a single settings change. It also leaves Options B and C
available later, once the live line has a stable trunk and there is time to do
the merge carefully. Option D is not worth its risk given that no content is
actually missing from either side.

The single question for the owner is therefore: **may we designate the live line
as the default branch and leave `main` in place as history, or do you want `main`
itself rewritten to carry the real work?**
