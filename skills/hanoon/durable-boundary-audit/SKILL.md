---
name: durable-boundary-audit
description: "Audit a change against this plugin's durable boundaries — append-only migrations, the fenced capability manifest, executor fences, one-use approvals, and secret-free surfaces — and prove every new guard actually fails. Use when reviewing or finishing a change that touches migrations, the controller manifest, credentials, approvals, or any test that claims to prove a boundary holds."
---

# Durable boundary audit

The generic guards check whether code is clean, tested, and truthfully documented.
This one checks the five boundaries that make this plugin safe to run unattended.
Each has already been broken at least once, and in every case a green test run was
the thing that hid it.

Apply this after the work is written and before it is presented or merged. It is a
review pass, not a writing style.

## Prove the guard before you trust it

A test that has never failed proves nothing. For every guard this change adds or
relies on, break the thing it guards and watch it fail, then restore and watch it
pass. Report both results.

This is not ceremony. Each of these shipped green and was caught only this way:

- a secret-canary scan that only matched the literal string, so any encoding leaked past it;
- a `CHECK` constraint listing four of six binding states, so a legitimate response could never reconcile;
- a replay guard held in a `Map`, so it recovered in tests and lost everything on restart;
- an acceptance report that accepted a hand-edited `passed`.

If you cannot make the guard fail, you have not found its edge — say so rather than
claiming coverage.

## The five boundaries

**Migrations are append-only.** Append after the current last entry. Never edit,
reorder, renumber, or drop one, and never rename a constant without checking every
position test. An installed database has already run the old list; changing it
silently diverges live schemas. If a migration looks wrong, append a corrective one.

**The capability manifest is the whole controller surface.** Every tool needs a
descriptor, and `validateManifest()` throws at module load if the two disagree —
that is your fastest feedback, so run the import rather than reasoning about it.
Adding a tool means adding its descriptor, its scope resolution, its evidence
projection, and updating whatever pins the count. Removing one silently is the
failure to watch for during a merge: take neither side wholesale.

**Fences and generations gate every durable write.** An executor lease owner and
generation, or a controller generation, guards each mutation. Do not widen, skip,
or "temporarily" bypass a fence check to make something pass. If a fenced write is
refused, the refusal is usually correct and the state is wrong — repair the state.
Exactly one open controller generation may match a live thread; two makes every
recovery path fail closed, and the controller wedges until a person intervenes.

**Approvals are one-use and head-bound.** Merge and production approval bind to an
exact pull-request head and expire. Never reuse, re-issue, or synthesise one, and
never treat a standing approval as a substitute for the checks that produced the
candidate.

**Secrets never reach an agent-visible surface.** Tool results, evidence rows,
Telegram output, CLI and doctor output, logs, thread titles, and error messages are
all agent- or owner-visible. A resolved credential, vault reference, PEM, or raw
provider error belongs in none of them. Prefer making the leak impossible — narrow
the type so the secret never reaches the layer — over redacting it late.

## What to report

State each boundary the change touches, what you checked, and the result of the
break-and-restore for every guard. Name anything you could not verify. A boundary
you did not touch needs no entry.

If the change cannot satisfy a boundary, stop and report it. On this codebase a
refused write, a throwing validator, and a failing constraint have each turned out
to be correct about a real defect more often than the change that tripped them.
