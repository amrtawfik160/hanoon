# Workflow Ownership and Delivery Invariants Research

Status: research complete

Date: 2026-08-25

Wayfinder ticket: [Trace current workflow ownership and protected delivery invariants](https://github.com/amrtawfik160/hanoon/issues/31)

## Verdict

Hanoon currently has a replaceable workflow compiler wrapped around a durable delivery executor.

The replaceable part classifies a task into one of six recipes, expands that recipe into fixed stages, assigns static role and skill profiles, and certifies several Superpowers-shaped transitions with native adapters. This is the choreography that should be replaced by an agent-owned workflow navigator using the admitted Matt Pocock skills.

The durable executor is already the right authority boundary. It owns versioned job transitions, idempotent effects, leases, resource claims, worker recovery, exact-head validation, review evidence, approval, merge reconciliation, deployment, canary verification, rollback, failure brakes, and owner delivery. The navigator may propose work to this executor. It must never write job state, call merge or production providers, invent evidence, or bypass an executor fence.

The deep module boundary is therefore:

```text
task and durable evidence
        |
        v
workflow navigator proposes one typed next step
        |
        v
durable executor validates policy, state, capability, and evidence
        |
        v
persisted transition plus leased effect
        |
        v
BB worker, review, merge, deploy, or canary operation
```

## Current control chain

| Boundary | Current owner | What happens now |
| --- | --- | --- |
| Task classification | [`src/capabilities/routing.ts`](../../src/capabilities/routing.ts) | Regex and supplied evidence produce traits, reason codes, and one of six recipes. A persisted recipe is a rigor floor and can be promoted only twice. |
| Recipe policy | [`src/domain/recipes.ts`](../../src/domain/recipes.ts) | Each recipe fixes planning, diagnosis, baseline testing, review depth, and conditional documentation. |
| Stage projection | [`src/domain/pipeline-graph.ts`](../../src/domain/pipeline-graph.ts) | Static recipe arrays choose the work sequence and review lanes. Documentation and delivery metadata are derived from the diff. |
| Skill and model profile | [`src/capabilities/profiles.ts`](../../src/capabilities/profiles.ts), [`src/agent-skills/role-resolver.ts`](../../src/agent-skills/role-resolver.ts) | Recipe, stage, role, and traits select a fixed skill set and model route. The selected profile is persisted with exact descriptor, registry, and graph digests. |
| Orchestration certification | [`src/capabilities/native-adapters.ts`](../../src/capabilities/native-adapters.ts) | Active routing requires native adapter receipts for worktree creation, implementation, review creation, and branch finishing. The adapters explicitly emulate Superpowers mechanics. |
| Runtime progression | [`src/domain/state-machine.ts`](../../src/domain/state-machine.ts) | A deterministic state machine converts accepted evidence events into a new job version and idempotent effects. It currently embeds the fixed plan, critique, implementation, validation, review, docs, approval, merge, deploy, and canary order. |
| External work | [`src/services/effect-runner.ts`](../../src/services/effect-runner.ts) | Leased effects create or resume BB work, bind capability profiles, collect worker and terminal evidence, and submit fenced events back to storage. |
| Durable scheduling | [`src/services/job-executor-service.ts`](../../src/services/job-executor-service.ts), [`src/services/job-lane-runner.ts`](../../src/services/job-lane-runner.ts) | One executor generation schedules bounded lanes, permits one active operation per job, renews effect and resource fences, retries transient failures, and dead-letters permanent or exhausted work. |
| Persistence | [`src/storage/store.ts`](../../src/storage/store.ts), [`src/storage/job-persistence.ts`](../../src/storage/job-persistence.ts), [`src/storage/migrations.ts`](../../src/storage/migrations.ts) | SQLite stores jobs, policy snapshots, admissions, effects, outbox messages, resource claims, attempts, capability evidence, approvals, merge facts, and production evidence. Job transition and effect creation are one transaction. |
| Merge readiness | [`src/bb/validation.ts`](../../src/bb/validation.ts), [`src/domain/gates.ts`](../../src/domain/gates.ts) | Git, BB, and GitHub evidence bind the repository, environment, branch, clean worktree, local head, twice-read remote head, review attempt, validation result, required checks, merge method, and expiry. |
| Owner authority | [`src/services/approval-service.ts`](../../src/services/approval-service.ts), [`src/services/merge-authority.ts`](../../src/services/merge-authority.ts) | A one-use approval is bound to the owner, job version, and exact head for 15 minutes. Standing authority is project-scoped, revocable, and fails closed. |
| Merge | [`src/services/merge-handler.ts`](../../src/services/merge-handler.ts), [`src/storage/store.ts`](../../src/storage/store.ts) | A leased merge effect is revalidated immediately before the provider call. The call fence and result are durable so an unknown provider outcome is reconciled without a second merge call. |
| Production | [`src/services/production-runner.ts`](../../src/services/production-runner.ts), [`src/services/effect-runner.ts`](../../src/services/effect-runner.ts) | The merged commit is checked out, owner-authored deploy commands run in order, canary follows deploy, output is bounded and redacted, and any configured rollback runs before failure is reported. |
| Completion | [`src/storage/store.ts`](../../src/storage/store.ts) | Terminal release waits for workers, cleanup controls, merge, and production effects. Status delivery is durable through the outbox rather than being treated as proof that the underlying operation succeeded. |

## Choreography to replace

The following behavior is workflow policy, not a platform safety invariant:

1. The task trait regexes and the six recipe identities: `direct`, `bounded`, `bug`, `architectural`, `skill-authoring`, and `adopted-pr`.
2. The static recipe policy table that decides whether planning, critique, diagnosis, baseline testing, and particular review depths happen.
3. The static recipe stage arrays and success routes, including the assumption that an architectural task always follows plan, critique, implementation, task review, validation, integrated review, and delivery.
4. Role mappings that name a fixed set of workflow skills for each recipe and stage.
5. Native adapters whose purpose is to certify Superpowers-shaped workflow transitions.
6. Model routing and escalation keyed to the old recipe and fixed stage vocabulary.
7. State-machine branches whose only purpose is choosing the next knowledge-work phase, such as whether to plan, critique, diagnose, write docs, or request another review.
8. Fixed plan and review cycle limits when the navigator can instead choose a different skill, prototype, research step, ticket split, or owner boundary based on durable evidence.

Diff-based documentation selection and the one-writer declaration currently sit in the same pipeline module. They should not be discarded with the static stage arrays. Documentation necessity is a deterministic change-surface check, and one writer per worktree is a concurrency invariant.

## Invariants to preserve

### Durable state and effect authority

- Every accepted transition checks the expected job version and current executor generation.
- State mutation and creation of its effects remain atomic.
- Every effect has a deterministic idempotency key and a bounded payload.
- A job has at most one leased operation at a time. Safe control effects are separate from mutating pipeline work.
- External operations run only while the executor, effect, and required resource claims are current. A successor generation cannot settle its predecessor's work without the explicit adoption checks.
- Transient effect failures use bounded backoff. Permanent failures and the twentieth attempt are dead-lettered instead of looping forever.
- Terminal release waits for active or uncertain workers and unresolved merge or production effects.

These protections are implemented in [`src/storage/store.ts`](../../src/storage/store.ts), [`src/services/job-executor-service.ts`](../../src/services/job-executor-service.ts), and [`src/services/job-lane-runner.ts`](../../src/services/job-lane-runner.ts).

### Workspace and worker isolation

- One code-writing worker owns a worktree at a time. Parallel work requires genuinely independent worktrees and explicit durable partitioning.
- A managed worktree must share ancestry with the configured trunk before code work proceeds.
- Worker attempts bind the job, role, environment, thread or terminal resource, input digest, model route, and capability profile.
- Replayed dispatch reuses the same attempt. A settled attempt cannot be rewritten by a later observation.
- Silent, stale, and interrupted workers are classified and recovered through durable records before their step is replayed.

The attempt ledger is in [`src/storage/stage-execution-repository.ts`](../../src/storage/stage-execution-repository.ts), ancestry protection is in [`src/bb/worktree-ancestry.ts`](../../src/bb/worktree-ancestry.ts), and recovery is enforced by [`src/services/effect-runner.ts`](../../src/services/effect-runner.ts) and [`src/storage/store.ts`](../../src/storage/store.ts).

### Capability admission and evidence

- A workflow step names an admitted exact capability descriptor. A skill name alone grants no tools, credentials, merge authority, or production authority.
- Worker profiles are immutable and bind subject, recipe or successor workflow identity, revision, registry digest, graph digest, model route, assignments, and mandatory outcomes.
- Required capability outcomes are append-only and must settle before the corresponding transition is accepted.
- Denial evidence remains explicit. An unavailable route blocks or selects another admitted step, rather than silently weakening the requested discipline.

The new navigator can generalize the current recipe field, but must preserve this evidence model. See [`src/capabilities/contracts.ts`](../../src/capabilities/contracts.ts), [`src/capabilities/profiles.ts`](../../src/capabilities/profiles.ts), and [`src/storage/capability-repository.ts`](../../src/storage/capability-repository.ts).

### Exact-head review and merge

- Implementation or documentation that changes the head revokes earlier review, validation, and approval evidence.
- Validation proves the owned environment is clean and on the same full SHA as the pull request. The remote head is read again after checks to detect movement during collection.
- Review and validation receipts bind the same head and review attempt.
- Required checks, repository identity, base branch, merge method, and receipt expiry remain merge gates.
- Approval is single-use and exact-head. Standing authority may replace an owner interaction, but never replaces evidence gates.
- The merge provider is called at most once for a durable call identity. An ambiguous return is reconciled from Git and GitHub facts rather than replayed.
- A successful merge is not enough to start deployment until the configured base branch proves it contains the approved content.

These rules are enforced by [`src/bb/validation.ts`](../../src/bb/validation.ts), [`src/domain/gates.ts`](../../src/domain/gates.ts), [`src/services/approval-service.ts`](../../src/services/approval-service.ts), [`src/services/merge-authority.ts`](../../src/services/merge-authority.ts), and the merge boundary in [`src/storage/store.ts`](../../src/storage/store.ts).

### Production and truthful completion

- Deployment requires an immutable production policy, the owned environment, durable merge facts, and current production claims.
- Commands are owner-authored, bounded, run in declared order, and produce redacted receipts.
- Canary verification begins only after deploy success is durable.
- A configured rollback runs immediately after a failed deploy or canary, even if the job was cancelled during production.
- Missing or failed rollback withdraws unattended delivery and pauses new project admissions until the owner intervenes.
- An executor interruption after a production mutation produces an unknown-outcome incident. The mutation is not replayed automatically.
- `complete` means canary success for a project with production. A project explicitly configured to have no production ends at `merged`.
- Owner-facing completion is sent from durable job, evidence, and outbox state. A message delivery attempt is never used as operational proof.

See [`src/services/production-runner.ts`](../../src/services/production-runner.ts), [`src/services/effect-runner.ts`](../../src/services/effect-runner.ts), [`src/domain/state-machine.ts`](../../src/domain/state-machine.ts), and [`src/storage/store.ts`](../../src/storage/store.ts).

## Natural navigator seam

The executor should expose a small interface that accepts a typed proposed step against a versioned workflow snapshot. The proposal needs enough data to prove:

- which admitted skill or native operation is requested;
- which durable artifacts and evidence justify it;
- which job and workflow revision it applies to;
- what outcome schema the executor may accept;
- whether it is knowledge work, a read-only check, a code-writing operation, an owner interaction, merge, deploy, or canary;
- what authority and resource claims it requires.

The executor then decides whether the proposal is legal, persists the transition and effect together, and later validates the result before exposing a new snapshot. The navigator receives facts, not mutable service objects. It cannot directly call BB, GitHub, Telegram, storage, merge, or production providers.

This seam lets the agent choose `wayfinder`, `research`, `to-spec`, `to-tickets`, `implement`, `code-review`, `ask-matt`, or another admitted step without weakening Hanoon's delivery guarantees. The exact proposal schema and navigator state belong to the next design ticket.

## Migration constraints

The current database persists recipe ids and versions on jobs and immutable capability profiles. Capability profile tables are append-only, and old receipts bind old registry and graph digests. A safe migration must therefore be additive:

1. Existing jobs keep their stored route and evidence interpretation until they reach a safe terminal or explicit migration checkpoint.
2. New jobs receive a versioned navigator identity and workflow snapshot. Legacy recipe columns and readers remain available while old jobs exist.
3. Old capability receipts remain readable and are never rewritten to look like Matt Pocock skill receipts.
4. Removing the executable Superpowers bundle must not strand an in-flight profile that still needs one of its descriptors. Rollout must either drain those jobs or provide a bounded legacy resume path that cannot be selected for new work.
5. Shadow evaluation may compare navigator proposals with the old classifier, but only one authority may create live effects for a job.
6. Rollback selects the prior workflow engine for new jobs and preserves already-created navigator jobs. It does not rewrite their history.

## Executable contracts already present

The highest-value regression suites protect behavior that should survive the refactor:

- [`tests/state-machine.test.ts`](../../tests/state-machine.test.ts): legal progression, bounded patch and critique loops, cancellation, head invalidation, merge, deployment, and canary semantics.
- [`tests/gates.test.ts`](../../tests/gates.test.ts): fully bound merge receipts, double-read remote head truth, required checks, and stable blocking reasons.
- [`tests/autonomy-effect-leasing.test.ts`](../../tests/autonomy-effect-leasing.test.ts): executor generations, exact effect ownership, resource claims, and one operation per job.
- [`tests/autonomy-crash-recovery.test.ts`](../../tests/autonomy-crash-recovery.test.ts): restart boundaries, attempt reuse, approval and merge ambiguity, and deploy-before-canary durability.
- [`tests/stage-execution-ledger.test.ts`](../../tests/stage-execution-ledger.test.ts): immutable attempt identity and measured execution evidence.
- [`tests/merge.test.ts`](../../tests/merge.test.ts): exact-head approval, provider call fencing, strict merge confirmation, unknown-outcome reconciliation, and post-merge base verification.
- [`tests/production-runner.test.ts`](../../tests/production-runner.test.ts): command order, output bounds, rollback, and canary failure recovery.
- [`tests/end-to-end.test.ts`](../../tests/end-to-end.test.ts): reviewed delivery through durable completion and restart recovery.

Tests that assert the six recipes or exact stage sequence are migration tests, not permanent product invariants. New navigator tests should observe proposed steps, durable effects, evidence acceptance, and terminal outcomes through the narrow executor interface rather than asserting internal helper calls.

## Decision carried forward

The navigator owns reversible workflow choice. The executor owns authority, mutation, evidence, and delivery safety. Replacement work should delete the old classifier, recipe projections, static workflow skill mappings, and Superpowers-shaped adapter certification only after a versioned navigator can drive the same fenced executor boundary.

This research does not decide the navigator's exact state schema, task-level owner authority, artifact tracker, or rollout gates. Those remain on the wayfinder map.
