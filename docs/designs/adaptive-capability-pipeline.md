# Adaptive Capability Pipeline Specification

Status: approved; implementation authorized

Date: 2026-08-13

Package: `bb-plugin-telegram-agent`

This specification amends [Hanoon Agent Operating System Design](hanoon-agent-operating-system.md) and [Agent Experience and Proven Autonomy Design](agent-experience-autonomy.md). It is the source of truth for task recipes, capability routing, universal capability evidence, guard disposition, and model-pool routing. It supersedes their static role-to-skill mapping, skill-only receipt schema, `full`/`small_fix` target routing, and later-slice placement of adaptive capability routing.

The vocabulary in [`CONTEXT.md`](../../CONTEXT.md) and decisions in [`docs/adr`](../adr/) are normative. This document defines the target behavior; statements under **Current baseline** describe the implementation as it exists before this change.

## Outcome

Hanoon selects the smallest policy-approved task recipe, capability profile, and model pool that can safely complete each request. It uses all admitted capabilities when their declared trigger applies, without loading every skill or tool into every provider session.

The Hanoon executor remains the only orchestration authority. It owns worktrees, fan-out, retries, provider-session boundaries, publishing, merging, deployment, and durable state transitions. Skills guide work inside those boundaries. BB continues to own providers, sessions, threads, hosts, environments, and managed worktrees.

Existing resource claims, generation fences, exact-head review, one-use owner approval, merge, deployment, canary, effect idempotency, and durable outbox contracts remain authoritative.

## Current baseline

The repository currently has these relevant behaviors:

- The plugin manifest exposes six skill roots containing 27 pinned skills.
- `src/agent-skills/role-resolver.ts` assigns a static subset by controller or worker role.
- The controller receives all 23 registered controller tools; workers receive no Hanoon tools.
- New jobs are classified only as `small_fix` or `full`.
- Full jobs follow a fixed planning, critique, implementation, validation, review, documentation, final-validation, final-review, approval, merge, deployment, and canary graph. Small fixes skip parts of that graph.
- `tool_receipts` provide at-most-once mutation evidence but are not a universal capability ledger.
- Review output is strict JSON, gets one format correction, and currently treats every finding as changes requested.
- Planning permits one critique-driven revision. Project review limits are configurable from 1 through 10 and default to 3.
- `bb.agents.configure` resolves this plugin's registered tools and manifest skills at thread start or turn submission. A live provider session is not hot-mutated; changed selections require a safe session start or resume boundary.
- Plugin configuration cannot directly select another plugin's tools or skills.

The migration preserves active jobs on this behavior until each job reaches a terminal state. New routing never rewrites an in-flight job's authority or approval snapshot.

## Scope

This change delivers:

1. one versioned registry for executable Hanoon capabilities;
2. deterministic task traits and six task recipes;
3. immutable capability profiles and append-only universal receipts;
4. policy-selected controller tool bundles and bounded capability expansion;
5. explicit `fast`, `standard`, and `strong` model pools;
6. native adapters for orchestration-oriented skills;
7. exact-diff guard selection and deterministic finding disposition;
8. read-only discovery and explicit admission of external capabilities;
9. shadow evaluation, per-recipe promotion, and independent kill switches;
10. concise Telegram visibility into routing and evidence.

This change does not:

- install, enable, update, or remove external plugins or skills;
- request or grant credentials automatically;
- let a model change its recipe, profile, model, approvals, or authority;
- run manual discovery skills without the owner's explicit invocation;
- allow multiple code writers in one worktree;
- replace BB provider, thread, host, environment, or worktree APIs;
- weaken merge, deployment, spending, credential, or destructive-action approvals;
- store raw prompts, private reasoning, credentials, absolute paths, or unbounded logs;
- create documentation solely as workflow evidence.

## Authority model

The controller proposes work and capability requests. Deterministic Hanoon policy selects and validates recipes, profiles, models, stage transitions, retry budgets, and finding disposition. Workers can return typed outcomes but cannot grant capabilities or advance authoritative state.

An owner may request more rigor or approve an existing authority boundary. An owner request cannot make a safety-critical trait false, remove a mandatory capability, reuse stale approval, or downgrade a running job.

Repository-changing work retains one code-writing lane per managed worktree. Hanoon may run independent investigations, jobs, and review lenses concurrently when they share no writable state. Review workers remain independent from implementation conversation history.

## Capability registry

Every executable capability has one complete, versioned descriptor. Discovery records may be incomplete, but remain `inventory-only` and cannot enter a profile until admission creates a complete descriptor.

### Descriptor contract

The target descriptor contains these fields:

| Group | Required fields |
| --- | --- |
| Identity | capability id, kind, source, version, content digest, lifecycle status |
| Routing | route, eligible roles, recipes, stages, required traits, forbidden traits |
| Composition | prerequisites, conflicts, ordering constraints, declared substitutes |
| Effects | effect class, risk class, data classes, reversibility, idempotency |
| Authority | owner approval, credentials, egress, host, workspace, and permission requirements |
| Contract | bounded input schema, bounded output schema, timeout and result limits |
| Economics | cost class and eligible model pools |
| Evidence | mandatory or optional status, terminal outcomes, proof schema, receipt type |

Allowed routes are:

- `worker`: BB loads the skill into an eligible provider session;
- `hanoon-native`: the executor enforces a versioned adapter that preserves the source skill's invariants;
- `manual-only`: the owner explicitly invokes it in the main conversation;
- `inventory-only`: visible for discovery but not executable.

Unknown fields, unknown enum values, incomplete executable descriptors, digest mismatch, unmet prerequisites, conflicts, or ambiguous substitutes fail closed. Descriptor validation happens during plugin activation and again before profile selection using the persisted descriptor digest.

### All bundled skills

| Skill | Route | Activation |
| --- | --- | --- |
| `proportional-development-workflow` | worker | Controller classification of development requests |
| `unslop` | worker | Owner-facing explanations and summaries; excluded from strict-JSON roles |
| `technical-writing` | worker | Documentation drafts; excluded from strict-JSON roles |
| `brainstorming` | worker | Architectural discovery when no completed grilling session exists |
| `writing-plans` | worker | Architectural planning after an approved specification |
| `systematic-debugging` | worker | Reproducible bugs, test failures, or unexpected behavior |
| `test-driven-development` | worker | Features, bugs, refactors, logic, state, data, or public-contract changes |
| `receiving-code-review` | worker | Remediation of review findings |
| `verification-before-completion` | worker | Before a code, test, documentation, or skill attempt reports completion |
| `writing-skills` | worker | Skill-authoring recipe after baseline test evidence exists |
| `clean-code-guard` | worker | Production-code diff |
| `test-guard` | worker | Test-code diff |
| `docs-guard` | worker | Technical-documentation diff |
| `using-superpowers` | hanoon-native | Profile selection and workflow discipline |
| `using-git-worktrees` | hanoon-native | Managed-worktree lifecycle and safety checks |
| `dispatching-parallel-agents` | hanoon-native | Independent parallel lanes selected by the executor |
| `executing-plans` | hanoon-native | Versioned recipe execution and checkpoints |
| `subagent-driven-development` | hanoon-native | Several genuinely independent implementation tasks |
| `requesting-code-review` | hanoon-native | Independent review gate creation and evidence collection |
| `finishing-a-development-branch` | hanoon-native | Delivery choices and owner-controlled integration boundary |
| `grill-with-docs` | manual-only | Explicit owner invocation for one-session discovery with terminology/ADR upkeep |
| `grilling` | manual-only | Dependency of explicit grilling or direct owner invocation |
| `domain-modeling` | manual-only | Dependency of explicit grilling or direct terminology work |

A native-adapter receipt records the source skill id and digest, preserved invariants, replaced mechanics, adapter version, authority boundary, tests, and outcome. It is labeled `hanoon-native`; it never claims the raw skill ran.

### Compatibility graph

The registry enforces these initial composition rules:

- a confirmed grilling summary excludes `brainstorming` for the same feature;
- `writing-skills` requires prior test-driven baseline evidence;
- bug diagnosis precedes regression-test and implementation work;
- `receiving-code-review` activates only for remediation;
- changed files select applicable guards from the exact diff;
- orchestration-route skills are never injected into a worker;
- communication guidance is excluded from strict structured-output roles;
- a documentation worker runs only when deterministic change-surface triage selects it;
- every denied or incompatible request receives a bounded reason code.

The graph is declarative, versioned, validated for cycles, and included in the capability-profile digest.

## Task traits and recipe selection

Task traits are bounded facts from owner input, job origin, project policy, repository inspection, dependency/schema inspection, exact changed paths, and observed failures. The controller may propose traits; Hanoon recomputes safety-critical traits and owns the result.

Classification uses this priority:

1. `adopted-pr` for an existing eligible pull request;
2. `skill-authoring` for creating or changing a skill;
3. `architectural` for a new subsystem or security, authentication, billing, migration, concurrency, data-integrity, public-contract, high-risk, or multi-session work;
4. `bug` for reproducible deviation from known behavior;
5. `direct` for copy, styling, documentation, configuration, or mechanical work with no behavioral risk;
6. `bounded` for all remaining scoped work.

Observed paths, schemas, dependencies, diffs, or failures may promote rigor. At most two automatic promotions are permitted for one job. A third promotion or material scope/authority change blocks for the owner. Recipes never automatically downgrade, including after retry or restart. `adopted-pr` and `skill-authoring` retain their identity when architectural traits add stronger stages and guards.

### Recipe stage graphs

| Recipe | Required graph |
| --- | --- |
| Direct | implement → selected verification/guards → delivery |
| Bounded | short approved design → implement → targeted verification → one independent review → conditional docs → delivery |
| Bug | reproduce and diagnose → failing regression test → fix → targeted verification → one independent review → conditional docs → delivery |
| Architectural | approved discovery/specification → plan → critique → bounded task execution and task review gates → integrated verification/review → conditional docs → delivery |
| Skill authoring | failing baseline pressure test → skill change → compliance test → review → delivery |
| Adopted PR | resolve exact remote head → inspect → validate → independent review → bounded remediation when required → delivery |

For any recipe, observed diff triggers and project policy add mandatory checks. A repository change intended for merge still requires the existing exact-head independent review and owner approval, even when its recipe otherwise omits a general review stage. Every recipe uses deterministic delivery metadata: this engine's catalog is frozen and no longer carries a skill that writes it. Delivery metadata does not grant commit, push, pull-request, merge, or deployment authority; the executor alone performs authorized effects.

## Controller capability bundles

The controller no longer receives all 23 domain tools. Hanoon selects whole bundles from traits and can add one compatible bundle at a safe boundary.

| Bundle | Existing tools |
| --- | --- |
| Core observation | `telegram_agent_list_projects`, `telegram_agent_job_status`, `telegram_agent_list_threads`, `telegram_agent_thread_status`, `telegram_agent_read_thread`, `telegram_agent_health`, `telegram_agent_scorecard` |
| Job control | `telegram_agent_start_job`, `telegram_agent_retry_job`, `telegram_agent_cancel_job`, `telegram_agent_steer_job`, `telegram_agent_adopt_pr` |
| Thread control | `telegram_agent_create_thread`, `telegram_agent_send_to_thread` |
| Memory | `telegram_agent_remember`, `telegram_agent_recall`, `telegram_agent_forget` |
| Monitoring | `telegram_agent_watch`, `telegram_agent_list_watches`, `telegram_agent_cancel_watch` |
| Operations | `telegram_agent_request_thread_operation`, `telegram_agent_delegate`, `telegram_agent_set_working_style` |

Two new metadata tools are always available:

- `telegram_agent_capabilities` returns the current profile, eligible bundles, bounded denial reasons, and read-only inventory summaries;
- `telegram_agent_request_capability` submits one batched additive request against the current profile.

Eligibility is not approval. A request that adds approval, credentials, egress, side effects, orchestration authority, or an incompatible capability starts a new attempt or stops at the existing owner boundary. A compatible low-risk request may create one new immutable profile revision and one automatic continuation for that logical controller turn or worker attempt. A second expansion request is denied and surfaced.

Because BB does not hot-mutate a live provider session, the executor persists the revision, ends at a safe provider boundary, proves the next session start or resume resolved the new profile, and only then continues. Failure to prove that boundary blocks; the worker never assumes a newly selected tool or skill is active.

## Capability profiles and receipts

### Immutable profiles

`capability_profiles` stores one immutable row per profile revision with:

- profile id and monotonic revision;
- controller-turn or worker-attempt subject;
- task recipe id and version;
- registry and compatibility-graph digests;
- selected descriptor ids and digests;
- selected model-pool tuple and routing reason;
- `active` or `shadow` mode;
- bounded trait and reason-code projections;
- creation timestamp.

Selected assignments are normalized child rows so constraints and queries do not depend on opaque JSON. A subject has one active profile per revision and no terminal profile is rewritten.

### Append-only receipts

`capability_receipts` records `requested`, `selected`, `denied`, and `outcome` events for skills, tools, connectors, models, recipes, and native adapters. Each row binds:

- receipt id;
- subject and profile revision;
- capability id and descriptor digest;
- event type and bounded reason code;
- mandatory or optional status;
- terminal outcome when applicable;
- exact head, diff, artifact, command, effect, or state-transition references when applicable;
- bounded evidence references and timestamp.

Selection is evidence of eligibility, not proof that a capability affected the result. An outcome requires observable evidence: a strict result, verified artifact, command result, finding, native transition, or existing effect receipt. Raw model narration and private reasoning are never evidence.

The migration exposes a read-only `skill_receipts` compatibility view for earlier consumers. Existing `tool_receipts` remain the idempotency record for controller mutations and are referenced rather than copied into universal receipts.

### Ordering guarantees

1. Hanoon commits a profile and all selection receipts transactionally before spawning or resuming the subject.
2. A worker outcome commits before the next stage transition.
3. An authoritative native-adapter outcome commits in the same transaction as its state transition.
4. Review and guard outcomes bind to the exact head and diff they assessed.
5. Each mandatory selected capability has exactly one terminal outcome.
6. Profile revisions increase monotonically, and terminal receipts are append-only.

If receipt persistence fails, the capability result is not exposed as success. If a state transition cannot atomically retain its required evidence, it does not occur.

## Guards and review

One independent review attempt receives only the guards selected by the exact change surface. Its strict result envelope contains a separate terminal `passed`, `findings`, `blocked`, or `failed` result for every selected guard. Architectural work gets task-scoped reviews plus one integrated final review; bounded work gets one final review.

Guard findings contain a stable rule id, severity, normalized project-relative subject, bounded evidence, and optional requirement id. Hanoon derives disposition from the descriptor and work order:

- failed checks, `critical` or `high` findings, requirements/public-contract violations, and registered `must_fix` rules require remediation;
- registered advisory rules and remaining `medium` or `low` findings are reported without creating a retry loop;
- model-supplied prose cannot set or clear blocking status.

The repeated-finding fingerprint hashes the descriptor digest, rule id, normalized subject identity, and requirement or evidence class; mutable title and explanation prose are excluded. A mandatory fingerprint may trigger two remediation attempts. Its third occurrence blocks even if the wider review budget remains. The configured review limit remains 1 through 10 and defaults to 3.

A missing or failed mandatory capability may use one descriptor-declared admitted substitute with equal or stronger protection. Without one, the stage blocks. Optional denial records a receipt and may continue.

Planning retains one critique-driven revision. Invalid strict output receives one format correction and then blocks. Existing fenced-effect recovery remains authoritative for external mutations.

## Model pools

Hanoon defines `fast`, `standard`, and `strong` pools for each execution class. A pool entry is an explicit provider id, model id, reasoning level, and service tier. Permission mode remains a separate role and effect policy.

Default routing is:

- `strong`: grilling, architecture, difficult planning, and high-risk review;
- `standard`: integration, debugging, multi-file implementation, and ordinary review;
- `fast`: mechanical implementation, extraction, formatting, and delivery metadata with complete requirements.

Recipe, stage, risk, and observed complexity select the pool before an attempt begins. The exact tuple is stored in the profile and remains fixed for the attempt. Unknown, unavailable, or unconfigured tuples do not fall back silently.

Two equivalent provider/model failures at one tier promote the next attempt one tier from `fast` to `standard` to `strong`. Two equivalent failures at `strong`, or exhaustion of an existing configured recovery budget, block. Recovery never downgrades an attempt or changes its tuple in place.

## External capability discovery and admission

Hanoon inventories installed plugins, skills, providers, and models through BB read APIs. Inventory refresh is automatic and read-only. Presence never grants execution.

Admission requires:

1. a complete pinned descriptor and source digest;
2. license and provenance review where code or instructions are bundled;
3. compatibility, authority, privacy, and side-effect checks;
4. deterministic contract tests;
5. shadow evaluation under a fixed harness and budget;
6. an explicit role, recipe, and stage mapping;
7. owner approval for installation, enabling, credentials, or new authority.

External skills that must be selected through `bb.agents.configure` are reviewed and pinned into this plugin's own manifest skill roots. Another plugin's executable capability requires a reviewed Hanoon-owned RPC or connector adapter with its own descriptor and receipts. Hanoon never invokes another plugin's install, enable, update, credential, or mutation surface merely because discovery found it.

## Telegram behavior

Normal status shows only:

- selected recipe and current stage;
- material rigor or model-pool escalation;
- blocker or owner decision;
- verification and mandatory-guard outcome;
- delivery state.

Capability ids, profile revisions, model tuples, descriptors, and receipts are available on demand. Routine selections and clean checks stay quiet. Material denial, escalation, substitute use, exhausted recovery, or missing mandatory evidence produces a concise notice.

Telegram output never includes raw prompts, private reasoning, credentials, absolute filesystem paths, or unbounded provider/command output.

## Persistence and restart behavior

Migrations are append-only. New focused repositories own capability registry, profiles/receipts, routing state, model pools, and external inventory; `src/storage/store.ts` may delegate through its existing aggregate interface during migration.

New jobs snapshot their recipe, recipe version, registry digest, profile revision, and routing mode. Active legacy jobs finish on their existing `full` or `small_fix` graph. A restart reconstructs routing from durable snapshots, never from the latest prompt or registry contents. A profile whose descriptor is retired may finish only if its pinned source remains available and policy still permits it; otherwise it blocks with the exact missing capability.

The earlier skill-only receipt table is not created. A compatibility view supplies its bounded read shape from universal receipts. Shipped `tool_receipts` and approval/effect tables remain unchanged.

## Rollout

1. **Foundation:** add registry validation, routing schemas, profile/receipt storage, model-pool configuration, compatibility projection, and kill switches with production behavior unchanged.
2. **Shadow:** compute candidate traits, recipes, profiles, guard disposition, and model routes beside the legacy path; record shadow profiles without controlling execution.
3. **Controller bundles:** enable bounded tool profiles and one safe capability continuation after equivalence and restart tests pass.
4. **Recipe promotion:** promote `direct`, then `bounded`, `bug`, `skill-authoring`, `adopted-pr`, and finally `architectural`, each independently.
5. **External admission:** enable only individually reviewed adapters after the internal registry and receipt path is proven.

Independent kill switches restore:

- the legacy full job graph;
- the controller's all-tools profile;
- strong-model routing.

Kill switches change dispatch behavior without deleting profiles, receipts, or migration data. A recipe rollback affects only new attempts; in-flight authority remains pinned.

## Verification strategy

### Deterministic gates

- Registry tests cover every bundled capability, digest, route, descriptor field, missing dependency, conflict, cycle, and declared substitute.
- Classifier tables cover every priority class, owner escalation, unsafe downgrade, changed-path escalation, and the two-promotion ceiling.
- Profile tests cover least-capability selection, strict role exclusion, one batched expansion, denial, monotonic revision, and safe session relaunch.
- Real-SQLite tests cover migration, transaction rollback, concurrent selection, unique mandatory outcomes, append-only receipts, compatibility-view reads, and restart reconstruction.
- Recipe graph tests cover every stage and prove existing approval, merge, deployment, canary, resource-claim, and effect fences are unchanged.
- Guard tests cover exact-head/diff binding, per-guard envelopes, deterministic disposition, fingerprint recurrence, substitute selection, and review budgets 1 and 10 plus default 3.
- Model tests cover fixed tuples, unavailable entries, two-equivalent-failure escalation, exhaustion at `strong`, and no downgrade.
- Controller tests cover all six bundles, the two metadata tools, denial notices, and no hot-mutation assumption.
- Telegram tests prove quiet routine behavior, material notices, bounded detail views, and privacy exclusions.
- Bundle integrity, typecheck, full tests, and build remain mandatory.

### Promotion gates

A recipe may control dispatch only when:

- all descriptor, identity, compatibility, migration, receipt, recipe, approval, and restart tests pass;
- the safety-critical classifier scores 100% on its fixed corpus with zero unsafe downgrade;
- the recipe completes at least one disposable end-to-end run containing an induced recoverable failure;
- each candidate model route completes at least five independent trials against the `strong` baseline under the same harness and budget;
- candidate successful outcomes meet or exceed the baseline count;
- policy bypasses, missing mandatory receipts, unsupported success claims, stale approvals, and duplicate irreversible effects all equal zero.

Live evidence and deterministic evidence remain separate. A missing or inconclusive gate is `incomplete`, never `passed`.

## Acceptance criteria

The implementation is complete only when:

- all 23 bundled skills have their specified route and tested activation or manual boundary;
- every executable skill, tool, native adapter, model, connector, and recipe has one validated descriptor;
- every provider subject starts from a persisted least-capability profile;
- controller sessions no longer receive all 23 tools by default;
- one compatible profile expansion succeeds only after a proven session boundary, while a second is denied;
- every mandatory capability has one exact-subject terminal outcome before stage advancement;
- static `full`/`small_fix` classification no longer controls promoted recipes;
- guard findings follow registry disposition and repeated mandatory findings block on the third occurrence;
- attempts keep one model tuple and follow the two-failure escalation rule;
- external inventory cannot execute without admission and explicit authority;
- active legacy jobs, existing approvals, merge, deployment, canary, effects, and Telegram delivery retain their safety contracts;
- every promoted recipe passes its deterministic and disposable-live gates;
- each kill switch restores its legacy behavior without data rollback;
- normal Telegram output exposes material routing decisions without exposing private or unbounded data.
