# Hanoon Usable Teammate Specification

Status: reviewed 2026-09-16; planning authorized

Date: 2026-09-16

Package: `bb-plugin-telegram-agent`

Sources: [firstmate](https://github.com/kunchenguid/firstmate) (cloned at `/root/github_projects/firstmate`), `bb-orchestration-skills` (`proj_xwpqycg35w`), grill Q1–Q12 in thread `thr_qw674g8vqv`.

The vocabulary in [`CONTEXT.md`](../../CONTEXT.md) and decisions in [`docs/adr`](../adr/) are normative except where this document explicitly amends them. Statements under **Current baseline** describe the implementation before this change.

## Problem

Hanoon is complicated and does not work well: the pipeline stalls instead of delivering pull requests (Q1c), monitors and memory produce noise (Q1d), crashes lose state (Q1e), and telling Hanoon to do something does not reliably end with a pull request the way Cursor background agents do.

## Goal

Hanoon becomes a real teammate: it holds access to every enabled project, builds deep per-project and per-client understanding from onboarding plus owner-fed information, and ships work tested through deployment and verified in production. Telling it to do something ends with a pull request (ship) or a standalone report (scout).

Non-goals for this specification: listening in Telegram groups/channels (seam only), learning automatically from finished jobs, and always-on upkeep. Those stay off until the pipeline is reliable.

## Current baseline

- ~112k LOC under `src/`; three layers (Telegram I/O, SQLite durable control, BB execution).
- A 13-stage pipeline machine (intake → plan → critique → build → test → review → docs → final test/review → approval → merge → deploy → canary) with a finding ledger, recipe/navigator routing history, per-tool receipts, evidence rows, and a conversation digest, all in SQLite.
- 35-skill locked bundle: `to-spec`, `to-tickets`, `implement`, `improve-codebase-architecture` are present but `invocationClass: user`, so workers cannot self-select them and the navigator never schedules them — the agent demonstrably does not use them.
- `grilling` is `invocationClass: model`, so the controller and workers can grill without being asked. `grill-with-docs` and `grill-me` are already `user`.
- UI skills (`better-ui`, `emil-design-eng`) are not bundled at all.
- Memory uses full-text recall with fade/devalue tuning; daily/weekly upkeep and scorecards run on.
- Project onboarding requires a hand-written policy file.

## Decisions (from grill)

- **D1 intake→PR contract (Q5):** acknowledge → clean worktree → plan/build/test/review → PR link plus risk plus checks. Workers ask only owner-boundary questions (access, spend, destructive). Grill skills run only on explicit request.
- **D2 knowledge (Q6):** onboarding conventions required; memory holds bounded standing preferences, corrections, and per-project conventions; owner keeps feeding client and work information conversationally; automatic learning off.
- **D3 gates, hybrid (Q7):** auto-detect plus policy override. Pre-merge: validation commands, one quality review, GitHub required checks green, exact-head binding. Post-merge: deploy plus canary only when the policy names a target. Revert-on-red only when opted in. Standing merge grants keep the existing guard (refused unless GitHub already requires a status check on the base branch).
- **D4 durable core (Q8):** SQLite keeps pairing, project policy, a job ledger (`id/stage/branch/head`), outbox, approvals, and monitors. Everything else is deleted or rebuilt from git/BB state on boot.
- **D5 strategy (Q9):** phased strip. The executor adopts the `bb-orchestration-skills` discipline natively (serial tickets, chained worktrees, fresh thread per phase, verified claims, budgets, classified pauses). No nested spawning: workers never spawn workers.
- **D6 onboarding (Q10):** `project enable` auto-detects and writes a draft policy the owner reviews. No production target means the job finishes at the reviewed pull request and never deploys.
- **D7 defaults (Q11):** thread-follow plus approvals/outbox on; scheduled monitors only when explicitly set; upkeep and auto-learn off (disk-pressure warnings stay active).
- **D8 groups seam (Q12):** durable `ingestion source` record plus a disabled read-only ingestion route. No group listener built.
- **D9 skill power (confirmation):** the navigator explicitly schedules `to-spec`, `to-tickets`, `implement`, and `improve-codebase-architecture`; a new pinned UI kit carries `better-ui` and `emil-design-eng`; `grilling` becomes explicit-request-only.

## Skill wiring (normative)

- The workflow navigator MUST explicitly schedule user-class skills; model self-selection stays rejected for them:
  - planner: `to-spec`, then `to-tickets` for multi-step work;
  - implementation: `implement`, plus `tdd` and `diagnosing-bugs` where they apply;
  - architecture tasks: `improve-codebase-architecture`;
  - documentation stage: `technical-writing`.
- Reclassify `grilling` from `model` to `user` and remove grill skills from the default controller bundle. Uninvited grilling is a selection bug with a regression test.
- New UI kit: vendor `better-ui` and `emil-design-eng` from reviewed upstreams at pinned revisions with a license check, lock digests, and verifier coverage. Both are model-invoked and scheduled on UI-surface tasks for implementation and review. Upstream URLs and revisions are TBD and MUST be reviewed before vendoring; this specification does not authorize unreviewed sources.
- The executor follows the `orchestrate-implementation`, `review-fix-loop`, `land-stack`, and `verify-landing` procedures natively inside the plugin. Worker threads MUST NOT spawn BB threads.

## Durable core (normative)

Keep: owner pairing, project policy, job ledger (`id/stage/branch/head`), outbox, approvals, monitors, and the new disabled `ingestion source` table.

Delete or deprecate: the stage machine beyond the ledger, the finding ledger, recipe/navigator/promotion columns and readers, evidence rows, per-tool receipts, the conversation digest, memory fade/devalue and full-text rank tuning, and the daily/weekly upkeep schedulers.

On boot the executor reconciles jobs, worktrees, and threads from git and BB state, firstmate-style: a restart is a non-event. In-flight jobs at upgrade time either migrate onto the ledger or drain; they MUST NOT silently advance or silently vanish.

## Ship and scout contracts

- Every task gets an explicit contract before it starts: what to build or learn, how it ships, and how much autonomy the worker has.
- Ship work runs in one managed worktree per ticket, lands through the project's mode, and reports a PR link with risk and checks. Unlanded work is never torn down.
- Scout work leaves a standalone report and changes no project code.
- Project modes are `no-mistakes`, `direct-PR`, and `local-only`, plus the existing standing-grant flag. Default is `no-mistakes`. A standing grant replaces the owner's tap and nothing else: review, validation, and exact-head binding still run; their proof is the gate artifacts (PR head, check runs), not the deleted evidence-row tables.

## Gates

- Pre-merge: resolved validation commands (auto-detected from the checkout, policy overrides) plus one quality review plus GitHub required checks green plus exact-head binding of review and validation to the full PR head.
- Approval: one-use, expiring owner tap, unless the project holds a standing grant from a button tap or its policy.
- Post-merge: deploy command plus canary command, only when the policy names a production target. Revert-on-red only when opted in. A failed production rollback withdraws the grant automatically and stops that project taking new work.

## Onboarding

`bb telegram-agent project enable <project-id>` detects the repository, base branch, validation commands, and required checks from branch protection, then writes a draft policy. The owner adds deployment/canary commands, redaction patterns, review limit, and merge method before `bb telegram-agent doctor <project-id>` passes. A project with no production settings finishes at the reviewed pull request unless its policy explicitly opts into merging without one.

## Memory and monitors

- Memory keeps standing preferences, corrections (a correction retires the belief it contradicts), and per-project conventions. It answers what it knows and forgets on request. No decay tuning in v1; the list stays bounded and inspectable.
- Monitors: thread-follow for threads Hanoon started or messaged stays on; scheduled monitors exist only when the owner sets them; upkeep and scorecards default off.

## Groups seam

New `ingestion_source` record (`chat_ref`, `project_id`, `captured_at`, bounded excerpt, `status`, default disabled) with a read-only ingestion route. It reuses the Outside-reading, Reference-document, and Passage model. No Telegram group listener and no automatic learning are built under this specification.

## Vocabulary deltas for CONTEXT.md

Add: ship task, scout task, ingestion source. Narrow: memory (bounded standing preferences, corrections, per-project conventions; no decay model). Remove when the code lands: the recipe/navigator/promotion family and any terms left without an implementation.

## Phases and acceptance

- **P1 thin core plus executor discipline (fixes Q1c and Q1e):** durable core cut-down, boot reconciliation, serial-ticket executor with chained worktrees and fresh threads per phase, hybrid gates, auto-detect onboarding, grill reclassification with regression test. Accept on the disposable live acceptance intake→PR run, a kill-restart-resume run that returns to the same ledger stage, and zero uninvited grilling.
- **P2 bounded memory and monitors (fixes Q1d):** bounded memory, owner-fed preferences, corrected defaults, upkeep off. Accept on one week of default-quiet operation plus a preference the owner set being applied on a later job.
- **P3 groups live:** out of scope here; this specification accepts the merged disabled seam only.

## Risks

- Cutting the stage machine can strand in-flight jobs; the boot migration or drain path is mandatory, not optional.
- The UI kit MUST NOT be vendored until its upstreams, revisions, and licenses are reviewed.
- Any worker-spawns-worker shortcut reintroduces the nesting this design removes; the worker contract forbids it and selection stays fail-closed.
