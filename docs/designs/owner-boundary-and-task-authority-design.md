# Owner Boundary and Task-Level Shipping Authority

Status: decision complete

Date: 2026-08-25

Wayfinder ticket: [Define the owner boundary and task-level shipping authority](https://github.com/amrtawfik160/hanoon/issues/34)

Inputs: the owner's requirement that a handed-off software task continue through merge, deployment, and testing, plus [workflow ownership research](workflow-ownership-invariants-research.md), [work artifact and tracker research](work-artifact-tracker-research.md), and the [navigator seam decision](agent-owned-workflow-navigator-design.md)

## Decision

An owner-requested software change defaults to a shipped outcome. The request grants Hanoon task-scoped authority to create and update planning artifacts, modify the owned repository worktree, commit and push the task branch, publish its pull request, merge the exact approved head, execute the configured deployment, run the configured canary, and execute the configured rollback when necessary.

Hanoon must not ask again for routine workflow, implementation, review, merge, deployment, or canary choices that fall inside that task and pass policy. It stops only when proceeding requires something the task and project policy do not grant, or when no safe engineering default exists for a consequential decision.

Task authority is narrower than standing project authority. It belongs to one authenticated owner request, one project, one evolving but bounded task scope, and one Hanoon job. It ends when that job finishes, is cancelled, or is revoked. It does not authorize sibling jobs, later cleanup, autonomous audit work, unrelated infrastructure, new spending, destructive data changes, or policy overrides.

## Canonical terms

**Task outcome** is the durable result the owner asked Hanoon to reach:

- `artifact`: finish when the requested research, diagnosis, map, specification, tickets, or other non-release artifact is accepted;
- `reviewed_change`: finish at a validated and reviewed pull request without merging;
- `shipped_change`: finish only after the approved change is merged and, when production is configured, deployed and accepted by the canary.

**Task authority** is the authenticated, task-scoped grant to perform the effects required by that outcome under project policy.

**Owner boundary** is a durable wait for a specific owner decision, authority grant, access action, or spending choice that Hanoon cannot safely supply itself. Uncertainty alone is not an owner boundary.

**Release authority receipt** is the exact-head evidence that a live task grant, explicit one-use grant, or standing project grant authorizes the merge. It replaces the owner's signature, not validation, review, checks, or production policy.

**Production incident** is a failed or indeterminate deploy or canary after production mutation may have occurred. It requires reconciliation or rollback before any retry.

## Deriving the requested outcome

The controller records the task outcome when it creates the job from an authenticated owner turn:

- A request to change code, configuration, or documentation defaults to `shipped_change`.
- A request explicitly limited to research, diagnosis, review, design, a map, a specification, or tickets uses `artifact`.
- A request to prepare, open, or update a pull request, or an instruction not to merge or deploy, uses `reviewed_change`.
- Explicit language such as "ship," "merge," "deploy," or "take it live" confirms `shipped_change` but is not required for an ordinary software-change request.
- A clear negative constraint always narrows the outcome. The model cannot broaden "do not merge" into a shipped task.

If the request genuinely supports two materially different outcomes, Hanoon may do safe research or create a reversible draft first. It asks only if choosing the outcome would itself cause an external effect the owner may not have intended.

The durable authority record includes the owner and controller identities, source update id, request digest, project id, task outcome, scope digest, explicit constraints, project policy version, creation time, and any later revocation or superseding owner decision. Child artifacts and ticket workers inherit the parent job's authority. They do not create a new grant.

## Authority by outcome

| Effect | `artifact` | `reviewed_change` | `shipped_change` |
| --- | --- | --- | --- |
| Read project and references | Allowed | Allowed | Allowed |
| Create or update task maps, specs, and tickets | Allowed | Allowed | Allowed |
| Claim and resolve task artifacts after evidence | Allowed | Allowed | Allowed |
| Modify the claimed managed worktree | Not unless the requested artifact requires disposable prototype work | Allowed | Allowed |
| Commit and push the task branch | No | Allowed | Allowed |
| Create or update the task pull request | No | Allowed | Allowed |
| Merge the exact approved head | No | No | Allowed |
| Run configured deploy and canary commands | No | No | Allowed |
| Run the configured rollback after an attempted production change | No | No | Allowed and mandatory when indicated |

No outcome silently authorizes:

- a new paid service, budget increase, purchase, or usage beyond configured limits;
- credentials, account access, or permission changes that are not already available through an admitted route;
- destructive data deletion, an irreversible migration, secret rotation, customer communication, or legal commitment;
- bypassing branch protection, required checks, review evidence, worktree ownership, effect fences, or production brakes;
- project policy changes or work outside the task's project and accepted artifact graph.

## Turning task authority into an exact-head release

A shipped task grant is recorded at intake, before a pull-request head exists. It cannot itself satisfy the merge gate. Once the final head passes all gates, the executor derives a one-use release authority receipt bound to:

- the job and current task-authority revision;
- the exact repository, base branch, pull request, and full head SHA;
- the accepted specification and implementation ticket snapshot digests;
- the validation, review, required-check, and merge-policy receipts;
- the current production policy and authority source.

If the head moves, the release receipt is revoked. The underlying task grant remains live, so Hanoon may validate and review the new in-scope head and derive another one without asking the owner. A material scope expansion, owner cancellation, policy change, or production brake suspends the task grant and prevents that derivation.

The task grant satisfies the owner-signature part of approval even when the project has no standing unattended-merge grant. Standing project authority remains useful for autonomous jobs and future tasks, but an owner should not need a blanket project grant to have one requested task shipped.

Production execution still requires owner-authored project commands and policy. A production project must have a rollback command before a task can deploy unattended. A project with no production may finish at merge only when its policy explicitly permits merge without production and carries the required checks and regression monitoring. Hanoon never silently downgrades `shipped_change` to a reviewed pull request.

## Legal owner boundaries

The navigator may propose only the following boundary classes. The executor validates each proposal against durable evidence before contacting the owner.

### `product_decision_required`

Two or more plausible choices materially change user-visible behavior, stored data, a public contract, security posture, billing, or an outcome that is costly to reverse, and the task, codebase, closed decisions, and project policy provide no safe default.

Routine naming, module shape, test strategy, skill choice, ticket order, error handling, and other engineering judgment do not qualify.

### `scope_expansion_required`

The smallest safe solution requires work outside the accepted task scope, project, artifact graph, or stated constraints. Refactoring code directly needed to make the requested change safe is not automatically a scope expansion. An adjacent feature, separate migration, or unrelated cleanup is.

### `credential_or_access_required`

A required capability is unavailable or invalid after Hanoon checks configured credential bindings, permitted hosts, repository access, and safe alternatives. Hanoon asks for the access action, never for the secret value in chat. It should use the secure credential or wizard path when human setup is unavoidable.

### `spend_authority_required`

The next safe action creates new external spend, exceeds the configured job or project budget, or requires increasing a service limit. Ordinary model, CI, and provider usage within configured limits is already authorized.

### `irreversible_effect_required`

The task requires destructive data loss, an irreversible migration, an external communication or commitment, a permission change, or another effect with no safe rollback that was not explicitly granted. A task-scoped merge and configured deployment are not classified here because `shipped_change` grants them under the release gates.

### `policy_change_required`

Completion requires weakening or changing project policy, bypassing a required check or branch rule, inventing production commands, accepting a missing rollback, or overriding a safety denial. Hanoon may repair code or configuration already inside the task, but it cannot rewrite the rule that judges its own work.

### `technical_tradeoff_required`

Bounded retries, model escalation, diagnosis, alternative admitted skills, and one relevant `ask-matt` consultation have failed to produce progress, and the owner can choose a meaningful scope, product, cost, or risk tradeoff. Repeated failure by itself is not a reason to ask a fake question. If no owner decision can move the work forward, Hanoon reports one truthful terminal block with evidence.

### `production_recovery_required`

A production outcome remains unknown after reconciliation, rollback is missing or failed, the same deploy or canary failure recurs after a successful rollback and repair, or production cannot be proven safe. Hanoon suspends task and standing release authority, applies the project admission brake, and asks for the exact recovery decision or access it needs.

No generic `uncertain`, `approval`, `review_needed`, or `what_next` boundary is legal. Workflow uncertainty belongs to the bounded `ask-matt` route. Routine merge approval is already settled by task authority.

## Event behavior

| Event | Hanoon behavior |
| --- | --- |
| Workflow, architecture, implementation, test, or ticket-order choice has a safe in-scope default | Decide, record the rationale, and continue. |
| Tracker, worker, CI, or provider operation fails transiently | Reconcile or retry under the existing bounded failure policy. |
| Validation or review finds a defect | Return to navigation, fix it, and rerun exact-head gates. |
| A model route fails repeatedly | Escalate the route or select another admitted approach before considering an owner boundary. |
| The navigator cannot choose the next skill | Record unresolved routing and consult `ask-matt` once for that decision digest. |
| A shipped task reaches reviewed release readiness | Derive the exact-head release receipt and continue through merge, deploy, and canary without asking. |
| Production is not configured for a shipped outcome | Stop at `policy_change_required`; do not call a reviewed pull request complete. |
| A required credential or permission is missing | Stop at `credential_or_access_required` with one concrete setup action. |
| A safe action would exceed budget or create new spend | Stop at `spend_authority_required` before incurring it. |
| A deploy or canary fails and configured rollback succeeds | Record and send one concise nonblocking incident notice, return to diagnosis, and continue within the production retry budget. |
| Rollback is absent, fails, or leaves the outcome unknown | Brake the project, suspend release authority, and stop at `production_recovery_required`. |
| The same production failure recurs after repair | Stop at `production_recovery_required`; do not expose production to an unchanged theory again. |
| The owner cancels or narrows the task | Revoke pending release receipts, stop reversible workers, reconcile in-flight effects, and obey the narrower authority. |

## Owner interaction contract

An accepted owner boundary becomes one durable interaction with a stable digest. Its message contains:

- what Hanoon is trying to finish;
- the exact fact that prevents safe continuation;
- what Hanoon already checked or tried;
- two or three real options when a choice exists;
- one recommended option and its consequence;
- what remains safely paused while Hanoon waits.

The message must not dump logs, ask the owner to choose an engineering workflow, or request a credential value in Telegram. It is deduplicated across restarts. Unrelated owner messages do not satisfy it. The answer creates an owner-decision receipt bound to the boundary digest, job, authority revision, and affected artifact or effect.

While waiting, Hanoon may continue genuinely independent read-only work that cannot prejudice the decision. It may not advance the blocked effect or use silence as consent. A status notice that needs no answer is distinct from an owner boundary and must say that no action is required.

## Autonomous work

Jobs without an authenticated owner request have no task authority. Daily audits, self-diagnosis, crash recovery, and other autonomous origins use the project's explicit standing policies and their existing bounds. They cannot borrow authority from the last owner-requested job.

An autonomous job may still prepare evidence or a reviewed change when its intake policy permits. Merge and production require a live standing release grant plus every normal gate. A production brake or owner revocation applies to both standing authority and any affected task grants.

## Current migration seam

Today, controller-created jobs are confirmed immediately, but the merge path still asks unless it finds a late textual preapproval or a standing project grant. See [`src/controller/tools.ts`](../../src/controller/tools.ts), [`src/services/merge-authority.ts`](../../src/services/merge-authority.ts), [`src/services/effect-runner.ts`](../../src/services/effect-runner.ts), and [`src/storage/store.ts`](../../src/storage/store.ts).

The additive change should:

1. Persist task outcome and task authority in the same transaction that creates the owner-requested job.
2. Add task authority as an exact job-scoped source in merge-authority resolution.
3. Derive and record an exact-head release authority receipt only after all existing gates pass.
4. Treat the current late merge instruction as an authority revision for a `reviewed_change` job, not as the default route for every task.
5. Let restart continuation recognize a live task grant for that same job without treating it as project-wide authority.
6. Suspend task authority on cancellation, material scope change, failed recovery, or an unresolved production outcome.
7. Keep standing unattended-merge policy for autonomous work and broad project grants.

## Decision carried forward

The specification can assume that owner-requested software changes default to `shipped_change`, exact-head task authority replaces routine merge prompts, configured deployment and canary continue automatically, and only the eight evidence-backed owner boundaries above may stop a task. The current refactor request is itself a shipped task: once its implementation passes the resulting gates, it is intended to be merged, deployed, and canary-tested without another approval round.
