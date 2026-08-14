# Hanoon Agent Operating System Design

Status: approved research-amended specification; Slice 1 implementation planning authorized

Date: 2026-08-12

Package: `bb-plugin-telegram-agent`

Plugin id: `telegram-agent`

Research basis: [Hanoon Harness Research Review](hanoon-agent-operating-system-research.md)

## Outcome

Hanoon becomes a BB-native agent operating system: a durable controller that can answer, investigate, coordinate workers, run reviewed delivery pipelines, recover from failures, learn from evidence, execute bounded workflows, and handle rich artifacts without claiming work it cannot prove.

The existing Hanoon kernel remains authoritative. BB owns provider sessions, threads, interactions, hosts, environments, worktrees, and provider discovery. The plugin owns Telegram identity, durable controller state, scheduling, resource claims, effects, receipts, approvals, memory, evidence, and delivery. SQLite remains the single transactional control plane.

This document defines the common architecture, release decomposition, and the complete Slice 1 trust and measurement contract. Each later slice receives a focused design and implementation plan before its code is changed.

## Existing foundation to preserve

The following contracts are strengths, not migration targets:

- one paired Telegram owner;
- one generation-fenced executor authority with bounded concurrent job lanes;
- durable effects and a durable Telegram outbox;
- immutable project-policy snapshots;
- project, repository-merge, and production-target resource claims;
- separate provider conversations for implementation and independent review;
- exact pull-request-head review and validation;
- one-use, expiring owner approval bound to the exact reviewed head;
- separate merge, deployment, and canary receipts;
- fail-closed handling of ambiguous external mutations;
- BB-managed threads, worktrees, providers, hosts, and interactions;
- lexical memory that works without an embedding service or API key.

No slice may bypass or weaken these contracts.

## Product principles

1. **Durable state outranks narration.** A model's operational claim is a proposal until the plugin can bind it to current receipts, state, or a durable obligation.
2. **BB remains the harness.** Hanoon does not add its own provider subprocess manager, session-resume files, process groups, worktree manager, or second conversation database.
3. **One transactional authority.** Authoritative state remains in the plugin SQLite database. Caches, embeddings, and frontend signals may degrade without changing decisions.
4. **Capability is explicit.** Tools, workflows, models, and connectors declare what they can do, their risk, and the evidence they produce.
5. **Attempts are immutable.** A provider/model/prompt/policy tuple is fixed for one attempt. Recovery creates another attempt rather than silently changing an active one.
6. **Every promise has an owner.** Deferred work names a durable job, monitor, workflow run, or maintenance run.
7. **Progressive disclosure.** Controllers receive compact context and references first, with full bodies available on demand.
8. **Fail closed at irreversible boundaries.** Unknown, stale, expired, or contradictory evidence blocks; it never becomes success.
9. **Quiet when healthy.** Milestones and incidents are delivered; ordinary polling and clean maintenance runs are not narrated.
10. **Incremental replacement.** New focused repositories and services take ownership as their slices land. There is no flag-day rewrite of `src/storage/store.ts` or the delivery state machine.
11. **Measure before optimizing.** A new model, router, context strategy, evaluator, or orchestration layer controls work only after a disclosed baseline and realistic outcome evaluation show the required lift.
12. **Use the smallest sufficient interface.** Tools stay distinct, bounded, and well described. Deterministic workflows own predictable transitions; the model owns decisions that genuinely require flexible reasoning.

## Non-goals

- Copying another harness's source, prompts, schemas, service topology, or filesystem layout.
- Adding Redis, a separate worker daemon, or a standalone dashboard server.
- Replacing BB's provider, thread, interaction, host, environment, or worktree APIs.
- Approval-free merge, deployment, destructive cleanup, credential mutation, spending, or connector installation.
- Automatic production rollback.
- Allowing an evaluation judge to edit live prompts or settings directly.
- Treating an answer or trace grader as authoritative when deterministic outcome evidence disagrees.
- Adding semantic retrieval, adaptive routing, extra agents, or retries without measured improvement under a disclosed budget.
- Storing raw provider transcripts, raw private Telegram messages, credentials, unbounded command output, or absolute worktree paths in telemetry.
- Generalizing the reviewed delivery pipeline before an equivalence suite proves the replacement preserves every safety invariant.

## Target architecture

```text
Telegram / BB / artifacts / approved signals
                    |
                    v
          durable intake and identity
                    |
                    v
       context compiler + capability policy
                    |
                    v
              BB agent thread
                    |
          +---------+----------+
          |                    |
          v                    v
 receipted capabilities   structured finalizer
          |                    |
          +---------+----------+
                    v
      generation-fenced executor and workflows
                    |
        +-----------+------------+
        |                        |
        v                        v
 durable effects/approvals   trace event ledger
        |                        |
        v                        v
 Telegram outbox           BB cockpit and evals
```

The controller never writes an authoritative outcome directly. It invokes a capability that records evidence, or it submits a finalization candidate that the plugin validates against evidence already committed for the same turn.

## Power target

Hanoon targets comparable breadth through context rollover, durable memory, evaluated provider/model routing, fallback and health circuits, reusable workflow graphs, capability policy, rich artifacts, trace replay, outcome evaluations, and adaptive orchestration.

Hanoon is designed to exceed a process-centric harness where its existing architecture is stronger: the owner can operate it remotely from Telegram; BB supplies native provider sessions, interactions, hosts, environments, and worktrees; and the plugin binds autonomous work to transactional effects, resource claims, exact-head review, one-use approvals, deployment receipts, and duplicate-safe delivery. This is a design target, not a measured superiority claim. Power is measured by recoverable completed outcomes, safety, cost per successful outcome, and evidence under a disclosed harness and budget—not by the number of subprocess or prompt-management features copied into the plugin.

## Release decomposition

### Slice 1: controller trust contract

Ship one controller instruction path, an enforceable descriptor for every Hanoon controller capability, blocking pre-execution policy, evidence-bearing controller tools, structured finalization, a completion gate, hidden-controller interaction bridging, `auto` as the default permission mode, and a minimum outcome-evaluation baseline. This is the prerequisite for every broader autonomy feature.

### Slice 2: proven autonomy

Persist skill receipts, idempotent milestone notices, executable acceptance runs, and duration-aware scorecards. Complete the already-approved agent-experience design without altering merge or production authority.

### Slice 3: trace ledger, cockpit, and evaluation lab

Expand the Slice 1 evaluation baseline with an append-only correlation ledger, bounded rollups, native BB RPC/realtime UI, deterministic trace replay, a broad scenario corpus, nightly differential evaluation, controlled-versus-strong-elicitation reports, and verified-isolated prompt experiments that may only propose a reviewed job.

### Slice 4: context and memory v2

Add durable context capsules, proactive reset-first controller-generation rollover, task-specific context packs, project-aware recall, progressive-disclosure memory, evaluated lexical/vector fusion with lexical fallback, document references, repository knowledge maps, provenance, and outcome attribution.

### Slice 5: provider resilience and adaptive routing

Discover live BB providers and models, establish the most-capable eligible baseline, route by declared role requirements only after shadow evaluation, record immutable execution choices, add health circuits and controlled recovery, enforce concurrency/spend budgets, fingerprint repeated failures, and adapt orchestration intensity from durable task-type outcomes.

### Slice 6: durable workflow recipes and maintenance

Add validated deterministic workflow recipes with dependencies, artifacts, gates, fenced nondeterministic effects, fan-out/join, approval signals, checkpoints, and history rollover. Add a leased maintenance registry with schedules, cost caps, run history, deduplication, and quiet notification policy. The existing delivery pipeline remains unchanged until recipe equivalence is proved.

### Slice 7: artifact and capability fabric

Add bounded Telegram voice, audio, document, URL, reply-chain, and outbound artifact support. Generalize the Slice 1 capability descriptors into a discoverable registry for every tool, skill, connector, and recipe, including schema, risk, data class, idempotency, credential scope, egress, host reach, cost class, and receipt type.

Each slice produces working software and an independently reviewable release. Slices execute in order because later decisions depend on the trust, evidence, and telemetry laid down earlier.

## Research-adjusted execution strategy

The external research and reference-system audit select a thin-kernel sequence:

1. **Trust and measure.** Slice 1 makes every Hanoon capability explicit, gates side effects before execution, validates the only owner-visible final action, and records a before/after outcome baseline.
2. **Prove existing autonomy.** Slice 2 turns the current skill, milestone, acceptance, and scorecard contracts into durable evidence.
3. **Make behavior legible.** Slice 3 correlates outcomes, traces, costs, fallbacks, and experiments without making trace narration authoritative.
4. **Reset and retrieve deliberately.** Slice 4 uses fresh provider generations, typed handoffs, small context packs, and evaluated hybrid recall instead of relying on compaction or vector search alone.
5. **Optimize under gates.** Slice 5 changes models, reasoning, or retry intensity only after a shadow comparison against the most-capable eligible baseline.
6. **Generalize deterministic execution.** Slice 6 moves predictable transitions into recipes while keeping provider and external calls as fenced effects.
7. **Expand the surface.** Slice 7 adds artifacts and connectors only through the capability, approval, credential, evidence, and evaluation contracts established earlier.

The roadmap borrows the external reference system's schema-first exits, context fidelity modes, bounded recovery, hybrid-retrieval hypothesis, telemetry, and budgets. It deliberately does not copy the reference system's bridge/Redis/worker/process topology, fail-open completion cases, regex or prefixless answer delivery, raw unknown telemetry payloads, or active-checkout prompt experiments.

## Common data and module boundaries

New storage domains use focused repositories over the plugin-owned SQLite database in BB's managed data directory:

- `src/storage/controller-evidence-repository.ts`
- `src/storage/controller-interaction-repository.ts`
- `src/storage/skill-receipt-repository.ts`
- `src/storage/acceptance-repository.ts`
- `src/storage/trace-repository.ts`
- `src/storage/context-repository.ts`
- `src/storage/provider-health-repository.ts`
- `src/storage/workflow-repository.ts`
- `src/storage/artifact-repository.ts`

These names describe planned modules. The public `TelegramAgentStore` may initially delegate to them so callers can migrate incrementally. Transactions that update jobs, effects, approvals, receipts, or outbox entries remain atomic even when the SQL moves into a focused repository.

Migrations remain append-only in `src/storage/migrations.ts`. A shipped statement is never edited or reordered. New collections are bounded and indexed for every production query path. Raw payloads are replaced by typed projections, hashes, and stable entity references.

Each slice begins with `bb plugin types --check`. Stale generated declarations are refreshed in a dedicated prerequisite change before implementation relies on an SDK surface; handwritten ambient types are not used to guess a newer BB contract.

## Slice 1 detailed design: controller trust contract

### Goals

- Deliver only answers that satisfy a plugin-owned completion contract.
- Bind live-state, work-result, and success claims to evidence from the same controller turn.
- Bind future follow-up to an existing durable obligation.
- Ensure the controller receives one copy of its instructions.
- Stop using unrestricted `full` permission as the workaround for invisible BB prompts.
- Let the Telegram owner answer controller questions and BB command/file approvals without opening BB.
- Preserve ordinary conversational answers that need no tool or external proof.
- Declare and enforce the risk, authority, approval, evidence, and result contract of every Hanoon-managed controller capability.
- Record a reproducible before/after baseline that distinguishes answer form, trace behavior, and durable outcome.

### Non-goals

- Semantic proof of arbitrary prose using another model.
- Automatic approval of arbitrary shell commands based on command-text parsing.
- Intercepting a third-party MCP write when BB itself emits no interaction for it.
- Giving the controller direct authority over job implementation worktrees; reviewed code delivery remains routed through durable jobs.
- Skill outcome receipts, CLI-managed live-acceptance sessions, the full trace/evaluation lab, embeddings, provider fallback, workflow recipes, or new media types; those belong to later slices.
- Dynamically classifying owner intent to hide or expose tools inside an already-running provider session.
- Treating an LLM judge as proof that an external mutation or operational result occurred.
- Changing reviewed job, merge, deployment, or canary transitions.

### Slice 1 delivery checkpoints

Slice 1 is one release contract but lands through three independently green checkpoints:

1. **Baseline.** Add the versioned outcome-scenario/report contract, verify all current-source claims, record the compatible current-controller baseline, and change no owner-facing production behavior.
2. **Kernel.** Add the complete capability manifest, blocking wrapper, evidence projection, finalization validator, and deterministic fake-host coverage. Exercise the new path only in tests and a disposable acceptance profile while the production default remains unchanged.
3. **Cutover.** Add the Telegram interaction bridge, change fresh defaults from `full` to `auto`, make accepted finalization the sole owner-visible answer path, rerun the fixed-harness comparison, and remove the temporary compatibility path after acceptance.

These checkpoints are review and rollback boundaries, not permanent operating modes. No long-lived dual delivery path or dual authority survives the Slice 1 release.

### One controller instruction path

`bb.agents.configure` remains the only source of standing controller instructions and the owner working-style overlay. The first thread input contains only:

1. bounded replacement context when this is a replacement generation;
2. the current owner message;
3. an image attachment reference when present.

`buildInitialControllerPrompt` is replaced with an input composer that does not include `CONTROLLER_INSTRUCTIONS`. Prompt tests count an exact sentinel from the instruction block across the resolved configuration plus first input and require one occurrence.

The controller instructions also change in three ways:

- the final action for every owner turn is `telegram_agent_respond`;
- installations, credential changes, spending, destructive external actions, and irreversible external writes require an explicit owner decision;
- the controller no longer claims it can silently install or configure integrations.

### Core capability policy

Slice 1 adds one static `ControllerCapabilityDescriptor` for every Hanoon-managed controller tool, including `telegram_agent_turn_evidence` and `telegram_agent_respond`. A descriptor declares:

| Field | Contract |
| --- | --- |
| `capability_id` | Stable namespaced id; equal to the registered tool name for Slice 1. |
| `schema_version` | Version of the advertised parameters and result projection. |
| `effect_class` | `read`, `durable_local_write`, `reversible_external_write`, or `irreversible_external_write`. |
| `risk_class` | `low`, `medium`, `high`, or `critical`; derived from impact, not model confidence. |
| `data_class` | Bounded data categories the tool may read and return. |
| `reversibility` | Whether and how the effect can be reversed or compensated. |
| `idempotency` | `read`, receipt key, effect key, or explicit reconciliation strategy. |
| `approval` | `none`, exact BB interaction, existing Hanoon confirmation, or existing pipeline approval. |
| `allowed_roles` | Durable controller or worker roles allowed to receive and invoke it. |
| `project_scope` | Whether the call is controller-global, current-project, or bound to an exact durable entity. |
| `credential_scope` | Required credential class and audience; `none` for capabilities without credentials. |
| `egress` | Allowed external service class or `none`. |
| `proof_kinds` | Evidence kinds a successful result may produce. |
| `receipt_kind` | Durable receipt or observation type, if any. |
| `result_limit` | Maximum bounded result projection returned to the provider. |

Registration fails closed when the descriptor set and registered Hanoon tool set differ. The common execution wrapper validates the durable controller identity, current pending turn, role/project/entity scope, descriptor policy, exact approval state when required, and current executor fence before it invokes a side-effecting domain operation. A missing descriptor, unknown effect class, stale approval, or policy-read failure denies the call before the side effect.

BB-native command and file-change tools remain under BB's permission engine and the Telegram interaction bridge. Slice 1 does not pretend to wrap opaque third-party tools that BB does not surface through an interaction. The descriptor contract applies to everything Hanoon itself registers; Slice 7 generalizes it to Hanoon-managed connectors, artifacts, skills, and recipes.

Tool selection remains based on stable durable identity and feature configuration through `bb.agents.configure`. Slice 1 does not add a model intent router. A later slice may split the controller tool set only when evaluation shows ambiguous or overlapping tools are causing errors.

### Evidence records

Evidence comes from two plugin-controlled projections:

1. every successful Hanoon controller tool except the finalization and evidence-index tools records a row before returning; and
2. the controller event observer projects completed BB `commandExecution`, `fileChange`, `webSearch`, `webFetch`, `imageView`, and non-Hanoon `toolCall` items into rows.

The second path lets the controller prove work performed through BB's native harness without treating arbitrary output as authoritative. A completed command proves its recorded execution outcome; it does not by itself prove that an external system changed. Native rows are idempotent by BB item id. Neither path stores raw arguments, raw results, command output, diffs, URLs, or absolute paths.

`controller_evidence` has these logical fields:

| Field | Contract |
| --- | --- |
| `evidence_id` | SQLite-assigned monotonic identity rendered as `evidence:<id>`. |
| `turn_id` | The exact submitted controller turn. |
| `controller_key` | The durable controller identity. |
| `source_kind` | `hanoon_tool` or `bb_item`. |
| `source_name` | Registered Hanoon tool name or BB item type. |
| `source_item_id` | BB item id for native evidence; null for a Hanoon tool projection. |
| `outcome` | `observed`, `succeeded`, `failed`, `interrupted`, or `denied`. |
| `args_sha256` | Canonical argument digest. |
| `result_sha256` | Digest of the canonical domain result before the evidence envelope, or of the canonical native-item result projection. |
| `proof_kinds_json` | Bounded enum list such as `job_state`, `thread_state`, `command_result`, `workspace_change`, `external_mutation`, `pipeline_outcome`, `obligation`, `retrieved_content`, or `health_snapshot`. |
| `subject_refs_json` | At most 16 stable references such as `job:<id>`, `thread:<id>`, `bb-item:<id>`, `monitor:<id>`, `project:<id>`, or a normalized project-relative path reference. |
| `observed_at` | Plugin clock time after the result or terminal BB item is observed. |

Evidence rows are append-only. Native projections have a partial unique key on `(turn_id, source_kind, source_item_id)`, and every validation query is indexed by turn and evidence id.

The common Hanoon tool wrapper requires a JSON-object domain result, hashes it without the reserved envelope, inserts the row, and then returns the existing domain fields plus one `_hanoonEvidence` object containing the reference, outcome, proof kinds, subjects, and observation time. A malformed or non-object domain result fails closed and is not shown as success.

Add `telegram_agent_turn_evidence`, a bounded read-only index of evidence references, source labels, outcomes, proof kinds, subjects, and observation times for the current turn. Before listing, it reconciles unseen native events just like the finalization tool. It records no evidence about itself and exposes no raw values. This gives the model stable references for BB-native items, whose normal results cannot carry `_hanoonEvidence`.

Read tools record a fresh observation each time and never replay a previous read. Existing mutating-tool idempotency through `tool_receipts` remains unchanged; a replayed mutation result receives a new evidence row for the current observation while retaining the original mutation receipt.

A failed Hanoon tool call records no proof-bearing evidence. Its existing error/receipt path remains available for diagnostics. A completed BB item with a negative outcome may prove only that matching negative outcome. Evidence is capped at 128 rows per turn. Crossing the cap marks the turn non-finalizable with `evidence_limit_exceeded`; further Hanoon tool calls return a bounded error and the existing supervisor stops the turn instead of silently losing proof.

### Structured finalization

Add `telegram_agent_respond` as the only controller tool allowed to propose the owner-visible final message. Its strict input is:

```ts
type ControllerFinalization = {
  disposition: "answered" | "needs_owner" | "deferred";
  segments: Array<
    | { type: "text"; text: string }
    | {
        type: "claim";
        text: string;
        kind:
          | "observed_state"
          | "execution_result"
          | "workspace_change"
          | "external_mutation"
          | "pipeline_outcome"
          | "health_assessment"
          | "uncertainty";
        outcome: "observed" | "succeeded" | "failed" | "uncertain";
        subjectRef: string;
        evidenceRefs: string[];
      }
  >;
  obligationRefs: string[];
};
```

The owner-visible message is the exact concatenation of segment text in order. Bounds are fixed at a 4,000-character rendered message, 24 nonempty segments, 12 claim segments, 8 evidence references per claim, and 8 obligation references. Duplicate references within a claim are rejected. A rejected candidate may be followed by another bounded revision, while a current-envelope accepted candidate is immutable after any one-time legacy normalization.

Claim segments are required for statements about current Hanoon, BB, workspace, pipeline, or external-system state and about completed work. This binds the exact delivered words to their evidence instead of keeping a detached claims inventory. General explanations, calculations, opinions, and other conversational answers that do not assert current operational state may use text segments only.

`controller_finalizations` is append-only except for a one-way null-to-timestamp `consumed_at` transition and the one-time compatibility repair that revalidates and normalizes a legacy accepted row to the current envelope. If that legacy validation fails, the row is retired and the accepted pointer is cleared in the same transaction. It stores one row per turn revision with its bounded JSON contract, rendered message, `evidence_high_water_id`, state (`accepted` or `rejected`), rejection code, creation time, validation time, and consumption time. A partial unique index permits at most one accepted revision per turn, and at most eight revisions may be inserted for one logical turn. It stores no raw provider output. After legacy normalization, the accepted row's evidence high-water id is an immutable seal over the evidence set against which its words were validated.

### Completion validation

Before validation or evidence-index listing, the tool path reconciles unseen completed native BB items through the current event high-water mark. Evidence inserts and advancement of `controller_turns.evidence_event_seq` share one fenced transaction. The native-item uniqueness key makes concurrent service polling and tool-time reconciliation harmless. The finalization tool then validates synchronously against current durable state:

1. Every evidence reference in a claim segment exists, belongs to this turn, and names the declared subject.
2. Claim kind, declared outcome, and evidence proof kind are compatible. A generic command, file-change, retrieved-content, or tool-completion row cannot prove a high-impact external mutation or pipeline outcome.
3. `needs_owner` has no obligation references and is accepted only when a current job or interaction record names an unresolved owner approval/question boundary.
4. `deferred` contains at least one obligation reference, and every reference resolves to an armed monitor, a nonterminal job, or another plugin-owned durable obligation.
5. `answered` contains no obligation reference.
6. A message consisting only of process intent—such as promising to check, investigate, or get back later—is rejected unless `deferred` names a live durable obligation and the text states that concrete follow-up.
7. A text segment containing a high-impact completion assertion about implementation, tests, review, merge, deployment, production, deletion, installation, credential mutation, or spending is rejected. The assertion must be a compatible claim segment with a successful outcome.
8. Evidence from returned command, web, or connector content is untrusted data. Only the plugin projector assigns outcome, proof kind, and subjects.
9. All referenced records are re-read inside the validation transaction; stale or missing evidence rejects the candidate.

After acceptance, the common capability gate denies every Hanoon-managed capability except an idempotent repeat of `telegram_agent_respond`, which returns `accepted_already` without reconciliation or another effect. If a BB-native item that was already in flight completes after acceptance, its evidence id exceeds the seal. Completion then fails closed, leaves the accepted row unconsumed, emits no answer outbox, and retires the provider generation. This makes “final action” a durable ordering rule rather than an instruction-only convention.

The compatibility boundary is fixed:

| Claim kind | Compatible evidence |
| --- | --- |
| `observed_state` | Matching Hanoon state projection such as job, thread, monitor, or project state. |
| `execution_result` | The matching BB command/tool item outcome only; it proves no broader semantic result. |
| `workspace_change` | The matching completed BB file-change item and normalized path only. |
| `external_mutation` | A Hanoon-managed mutation receipt or reconciled effect explicitly projected as `external_mutation`. |
| `pipeline_outcome` | Current terminal job state backed by the required review, validation, merge, deployment, or canary receipts. |
| `health_assessment` | A current bounded health snapshot. |
| `uncertainty` | Matching negative, interrupted, denied, ambiguous, or stale evidence when available. |

In particular, command exit zero is not validation evidence, a file-change item is not proof that an implementation is correct, retrieved content is not proof that an external write occurred, and a generic MCP/tool completion is not an effect receipt. Slice 2 adds skill and acceptance receipts for direct implementation, test, and review claims outside the existing durable job pipeline.

The deterministic validator concatenates segment text but does not paraphrase it or invent evidence. A rejected call returns its stable rejection code and the smallest corrective instruction to the model.

### Turn completion behavior

When BB reports the provider turn complete or idle:

- an accepted finalization completes the controller turn using its rendered message; raw assistant output is ignored;
- a rejected or missing finalization causes one continuation turn instructing the controller to inspect `telegram_agent_turn_evidence` and call `telegram_agent_respond` with the evidence already available;
- `controller_turns.completion_continuations` is atomically advanced from zero to one before dispatch, and cannot advance again;
- the continuation's BB event baseline is moved to the current high-water mark so earlier deltas and item events are not replayed;
- if the continuation also ends without an accepted finalization, the turn fails with a concise owner-visible notice and the controller generation is retired;
- an accepted finalization survives a provider error that occurs after the tool call, because the owner message was already durably validated;
- evidence recorded after the accepted row's high-water seal prevents delivery and retires the provider generation;
- controller-turn completion, digest insertion, accepted-finalization consumption, and Telegram outbox insertion occur in one fenced transaction.

This replaces acceptance of arbitrary nonempty BB output. Raw assistant deltas are reduced to bounded observation booleans and are never stored in `stream_text`, a Telegram draft, or an outbox. Telegram may show typing plus deterministic phase text derived from BB lifecycle/item types. The stream is cleared at terminalization, and only the accepted finalization enters the conversation digest and durable outbox.

### Generic controller interactions

Create `controller_interactions` as the generic successor to `controller_questions`. It supports `user_question`, `approval`, and `unsupported`, with pending, answered, and delivered states. The append-only migration copies any existing controller question into the new representation; the old table remains untouched for migration compatibility but receives no new rows.

The controller event observer parses both `system/userQuestion/lifecycle` and `system/permissionGrant/lifecycle`, including pending and resolved events. The controller turn records the pending interaction id, which exempts it from stall detection while the owner is deciding.

Telegram rendering reuses the existing bounded worker-interaction parser and button vocabulary with controller-specific callback identities:

- user questions retain their option and free-text behavior;
- command and file-change approvals show the bounded subject and only `Allow once` and `Deny` for the hidden controller;
- `Allow all session` is deliberately withheld for the controller even if BB offers it;
- unsupported interaction shapes notify the owner but expose no guessed resolution buttons.

An owner tap is persisted before BB resolution. Delivery to BB is retried until confirmed, and duplicate taps are harmless. The provider turn remains parked throughout. A permission denial is delivered to the provider as a normal resolution so it can answer with the resulting blocker.

### Permission default and residual boundary

The default controller execution profile constant and plugin setting descriptor change from `full` to `auto`. Fresh configuration parsing therefore resolves to `auto`; any already persisted explicit permission value remains unchanged.

BB's own permission engine remains authoritative. Hanoon does not infer that a command is safe by parsing shell text, and it never approves an interaction on the owner's behalf. The bridge only moves BB's exact decision to Telegram.

This slice cannot mechanically intercept a third-party MCP capability when BB does not produce an interaction. Therefore the controller instruction contract still requires an owner decision before connector installation, credential mutation, spending, destructive external actions, or irreversible external writes. Slice 1 enforces descriptors for Hanoon's own tools; Slice 7 extends the same policy and receipt contract to Hanoon-managed connectors. Neither slice claims control over opaque third-party behavior.

### Safety and privacy

- Evidence stores digests, enums, stable ids, and bounded projections only.
- Native paths are normalized relative to the known project root; paths outside it contribute no path subject.
- Finalizations and interaction payloads use the existing credential-like-text and output-redaction boundaries before durable storage or Telegram delivery.
- Approval summaries clip commands and paths; they never include environment variables or command output.
- Capability policy treats connector and retrieved content as untrusted data; content cannot alter tool risk, approval, role, credential, or egress policy.
- Hanoon-managed connectors use the narrowest available credential scope, bind tokens to their intended audience where supported, and never pass an inbound connector token through to another service.
- Controller evidence is visible only to the paired owner, plugin CLI, and future authenticated BB cockpit RPC.
- A stale executor generation cannot accept a finalization, resolve an interaction, complete a turn, or enqueue its response.
- Hidden controller threads remain hidden and are addressed only through their exact durable controller mapping.
- Merge and production approvals remain separate from BB command/file approvals and retain their existing exact-head, expiry, and one-use rules.

### Slice 1 module boundaries

Planned focused units:

- `src/controller/capability-policy.ts`: complete descriptor manifest, risk/proof vocabulary, and pure pre-execution policy decisions.
- `src/controller/capability-executor.ts`: common authorization, approval, fence, evidence, and result-bounding wrapper for Hanoon-managed controller tools.
- `src/controller/finalization-contract.ts`: schemas, bounds, claim/proof compatibility, process-only detection, and stable rejection codes; no I/O.
- `src/controller/evidence-projector.ts`: Hanoon-tool envelopes, native BB item projection, evidence-index projection, and proof-kind definitions.
- `src/controller/interaction-service.ts`: controller interaction reconciliation and BB delivery.
- `src/eval/controller-scenario-contract.ts`: versioned scenario, harness metadata, grader, trial, outcome, and report schemas; no production I/O.
- `scripts/eval-controller-outcomes.mjs`: opt-in multi-trial runner that extends the existing answer-form evaluation and emits a bounded report.
- `evals/controller-scenarios.json`: secret-free scenario definitions and deterministic outcome assertions.
- `src/storage/controller-evidence-repository.ts`: evidence and finalization transactions.
- `src/storage/controller-interaction-repository.ts`: generic controller interaction persistence and migration reads.
- `src/controller/service.ts`: orchestration only—observe, validate completion state, issue one continuation, and finish/fail.
- `src/controller/bb-controller.ts`: BB event and interaction adapter only.
- `src/controller/tools.ts`: registration and domain projections; common wrappers delegate evidence persistence to the focused unit.

The implementation plan must not grow new multi-hundred-line storage domains inside `src/storage/store.ts`. Existing touched methods may delegate to the new repositories while the aggregate interface remains compatible.

### Slice 1 failure behavior

- Missing pending turn during a Hanoon tool call fails authorization and records no evidence.
- A missing or inconsistent capability descriptor prevents registration; a policy-read failure, stale approval, or fence loss denies execution before the side effect.
- Evidence persistence failure makes the tool call fail; the model cannot receive an unreceipted success result.
- Native evidence projection failure leaves the event cursor unadvanced and the turn non-finalizable until reconciliation succeeds.
- Finalization validation loss of fence returns a tool error and cannot complete the turn.
- BB interaction read failure leaves the turn active and retries within the existing stall/supervisor bounds.
- BB interaction resolution with an ambiguous outcome remains answered-but-undelivered and retries by exact interaction id; it never fabricates delivery.
- Telegram delivery failure remains in the durable outbox.
- One failed completion continuation retires the controller generation so the next owner message starts from durable digest, memory, and receipts.
- Migration failure aborts plugin activation without modifying later migration indices.

### Slice 1 evaluation baseline

The current `npm run eval:answers` suite remains the calibration-gated judge for answer form. It intentionally cannot see the external world and therefore never becomes an outcome grader. Slice 1 adds a versioned scenario contract with three separate result layers:

1. **Outcome graders** inspect durable Hanoon state, receipts, BB item state, the Telegram outbox, and controlled fake external systems. These are authoritative for task success and safety.
2. **Trace graders** inspect bounded typed events for required or forbidden behavior, such as one continuation, one approval resolution, or no replayed effect. They diagnose how the outcome occurred.
3. **Answer graders** apply the existing calibration-gated form rubric and any scenario-specific communication rubric. They cannot turn a failed outcome into a pass.

Every evaluation report records:

- scenario and scenario-schema version;
- Hanoon commit and dirty-state flag;
- provider, model, reasoning level, service tier, and permission mode;
- controller instruction, overlay, capability-manifest, policy, and context-capsule digests;
- advertised tool names and parameter-schema digests;
- per-trial context/token/spend/turn/retry budgets;
- trial seed when the provider supports one;
- outcome, trace, and answer grader versions;
- wall time, tokens, provider cost when available, terminal failure class, and proof references.

Before implementation changes the answer path, the runner records the current controller baseline on the compatible scenario subset. After implementation it reruns the same fixed harness and budget. Nondeterministic provider scenarios use multiple independent trials and always report the denominator; a one-off live run is labeled smoke evidence, not a capability rate. Deterministic safety invariants must all pass. Unsupported success, duplicate irreversible effect, stale approval acceptance, or capability-policy bypass fails the release on any trial rather than being averaged away.

Direct provider/model comparisons use the same tasks, tools, graders, and budgets. A separate strong-elicitation report may vary the harness or budget, but it must name every difference and report cost per successful outcome. No Slice 1 schema or owner-facing path depends on an online judge, and the ordinary deterministic suite stays offline and cost-free.

### Slice 1 deterministic verification

Implementation follows test-driven development. Required tests include:

#### Prompt and configuration

- The initial owner input plus resolved configuration contains exactly one controller instruction sentinel.
- The working-style overlay appears once and remains after the fixed boundary instructions.
- Fresh/default profiles resolve `permissionMode: "auto"`; an explicit existing setting remains unchanged.

#### Capability policy

- The descriptor manifest and registered Hanoon controller tool names are exactly equal.
- Every descriptor has a valid schema version, effect/risk/data class, idempotency strategy, approval rule, role/scope, credential/egress policy, proof kinds, receipt kind, and result bound.
- A read capability may run without a mutation receipt but still records a current-turn observation.
- A side-effecting capability is denied before invocation when identity, pending turn, role, project/entity scope, approval, policy, or fence validation fails.
- A denied capability produces no success evidence and no domain side effect.
- Connector or retrieved text that asks to change policy cannot change the descriptor or approval decision.
- A credential audience/scope mismatch is denied, and an inbound connector token is never forwarded as an upstream credential.

#### Evidence and finalization

- Read and mutating tools return bounded evidence references tied to the current turn.
- Completed native command/file/tool items are projected idempotently, and the evidence-index tool returns their bounded references.
- Evidence-index reconciliation records a preceding native item but never records the index call itself.
- A failed Hanoon tool produces no proof-bearing evidence.
- A failed native command can prove its negative execution outcome but cannot prove a successful mutation.
- An outside-project or absolute native path is absent from the stored and returned subject projection.
- A 129th evidence item makes the turn non-finalizable rather than evicting an earlier row.
- Mutation replay does not repeat the mutation and produces current evidence for the replay observation.
- Evidence from another turn, controller, subject, failed call, or incompatible proof kind is rejected.
- A successful generic command or tool-call item cannot prove a high-impact external mutation or pipeline outcome.
- A plain conversational answer with no tools can finalize using only text segments.
- Accepted segment text is concatenated character-for-character in order.
- Process-only messages are rejected.
- High-impact success text outside a claim segment is rejected.
- High-impact claim segments without compatible proof are rejected.
- A deferred answer without a live job or armed monitor is rejected.
- A valid current-turn claim and a valid durable obligation are accepted.
- An accepted current-envelope finalization is immutable; a legacy accepted row is normalized once under full current validation or retired with its pointer cleared atomically.
- An accepted finalization stores the current evidence high-water id and denies every later non-finalizer Hanoon capability before effect.
- A native BB item completing beyond the accepted evidence seal prevents finalization consumption and owner-answer delivery.
- A ninth finalization revision is rejected without inserting another row.

#### Completion and races

- Raw nonempty BB output without finalization does not complete the turn.
- Telegram drafts contain deterministic phase text but no raw provider prose.
- The service sends exactly one completion continuation.
- A second missing finalization fails and retires the generation.
- An accepted finalization is delivered even if the provider errors afterward.
- Two database connections racing finalization acceptance produce one accepted candidate.
- Two completion workers racing the same accepted candidate produce one delivered outbox message.
- Restart during native evidence reconciliation observes both the evidence rows and advanced cursor or neither, then reprojects exactly once.
- A stale executor generation cannot accept or complete.
- Restart after accepted finalization but before outbox creation produces one completion and one outbox row.

#### Interaction bridge

- Hidden controller user questions and command/file approvals render in Telegram.
- Controller approvals expose `Allow once` and `Deny`, never `Allow all session`.
- Unsupported interactions notify without buttons.
- An owner tap is durable before BB resolution and retries after restart.
- Duplicate taps and duplicate lifecycle events do not resolve twice.
- A pending interaction exempts the turn from stall handling.
- A denial returns to the provider and lets it produce an evidence-bound answer.

#### Regression gate

- Existing supervisor, image, memory, tool-receipt, thread-notice, job, merge, deployment, and end-to-end suites remain green. Controller streaming assertions are intentionally replaced with phase-only draft and accepted-finalization delivery tests.
- Scenario schema and report parsing fail closed on unknown versions, missing graders, missing harness metadata, duplicate trials, or an unparseable judge result.
- Outcome failure cannot be overridden by trace or answer scores.
- The current answer-form judge passes its golden-case calibration gate, and the fixed-harness before/after report includes all required scenario denominators and budgets.
- TypeScript typecheck, skill verification, plugin build, `git diff --check`, and bundle metadata checks pass.
- The fake BB host test uses real temporary SQLite and exercises the registered finalization tool and a pending approval end to end.

### Slice 1 live acceptance

A disposable installed-plugin run must separately prove:

1. a normal Telegram question receives an accepted finalization;
2. a live status answer names current evidence;
3. a process-only provider answer triggers one continuation and does not reach Telegram;
4. an `auto`-mode controller command that needs approval appears in Telegram;
5. `Allow once` resumes the exact controller interaction;
6. restart between tap persistence and BB resolution resolves once;
7. a durable monitor permits a deferred response;
8. unsupported success claims remain zero;
9. a deliberately stale or mismatched capability approval is denied before execution;
10. the evaluation report names its harness, tool manifest, budgets, trials, outcomes, and cost when available;
11. no merge, deployment, credential, spending, or destructive external action is performed by the acceptance profile.

Live evidence is reported separately from deterministic tests. An incomplete scenario remains `incomplete`, never `passed`.

### Slice 1 acceptance criteria

- Controller standing instructions appear exactly once.
- New default controller sessions run in `auto` permission mode.
- Every delivered controller answer came from an accepted structured finalization.
- Every delivered accepted finalization remained the last evidence-producing action for its turn.
- Raw provider prose never reaches Telegram before finalization acceptance.
- Every referenced claim is bound to compatible evidence from the same turn.
- Every deferred promise names a live durable obligation.
- Process narration alone cannot complete a turn.
- Every registered Hanoon controller tool has one enforced capability descriptor, and no side effect runs after a failed pre-execution policy decision.
- Hidden controller questions and supported approvals can be answered entirely from Telegram.
- The controller cannot grant itself session-wide approval from Telegram.
- No merge, production, effect-fencing, resource-claim, or one-use approval invariant changes.
- The fixed-harness baseline and after report keep outcome, trace, and answer grades separate and disclose all trial denominators and budgets.
- Focused, full deterministic, build, and disposable live gates pass with separate evidence.

## Later-slice contracts

The following decisions are fixed by this umbrella design; their detailed schemas and task plans are deferred to their own written specifications.

### Slice 2 fixed contracts

- `skill_receipts` are append-only per attempt, skill id, and bundle digest.
- Mandatory guards need terminal receipts before their stage advances.
- Milestone notices reuse the durable outbox and are keyed by entity id plus version.
- `acceptance_runs` persist a bounded checklist and proof references; typed assertions cannot mark a step passed.
- Scorecards expose denominators and time windows, plus median stage durations from durable timestamps.

### Slice 3 fixed contracts

- `harness_events` is append-only and correlated from Telegram intake through delivery and production receipts.
- Authoritative transition events are inserted in the same transaction as the transition.
- Fine-grained typed event retention defaults to 30 days; bounded daily rollups retain 180 days.
- Unknown BB/provider event shapes are counted and reduced to a typed redacted marker; their raw payload is not persisted.
- The BB app uses `bb.rpc` for validated reads and `bb.realtime` only as an ephemeral refetch signal.
- The frontend registers a native `navPanel` cockpit and a thread panel action; it does not start an HTTP server.
- The Slice 1 scenario contract expands into capability and regression corpora with deterministic outcome assertions, recorded event replay, multiple live trials, calibration-gated optional LLM judgment, and periodic human spot checks.
- Reports distinguish fixed-harness comparisons from strong-elicitation comparisons and include harness/tool/policy versions, budgets, success rate, and cost per successful outcome.
- Prompt experiments verify an isolated BB worktree and branch before editing, use cost caps and multiple trials, and may only create a reviewed Hanoon job or issue; they cannot apply live changes.

### Slice 4 fixed contracts

- A context capsule records intent, goals, unresolved questions, commitments, decisions, active entity references, and completed mutations; it excludes raw transcripts and secrets.
- Controller rollover is proactive at bounded age, turn, or token thresholds and starts a fresh provider generation from the capsule, current durable/repository state, relevant memories, receipts, and one bounded next objective.
- In-place compaction may reduce context inside one generation but is never the durable cross-generation handoff.
- Context packs are role-specific (`full`, `compact`, `minimal`, `steering`) and have explicit byte/token budgets.
- Project memory is included automatically when project identity is durable.
- Memory retrieval remains lexical when semantic retrieval is unavailable.
- Semantic vectors are rebuildable cache data, never the authoritative memory record.
- Lexical and vector candidates are fused deterministically only after a held-out recall corpus shows lift over the current SQLite lexical/recency/importance/confidence baseline.
- Progressive disclosure injects stubs; full bodies require an exact memory/document reference.
- Project knowledge begins with a short checked map into source-of-truth documents and machine-readable state, not a copied manual in the controller prompt.
- Recall effectiveness is scored from linked claims and outcomes, not mere absence of an immediate correction.

### Slice 5 fixed contracts

- Provider/model inventory comes from `bb.sdk.providers.list` and `bb.sdk.providers.models`, not a committed static catalog.
- Each role declares required capabilities, acceptable latency/cost classes, and fallback order.
- Every attempt records the selected provider, model, reasoning, service tier, permission mode, and selection reason before spawn.
- An attempt never switches provider or model in place.
- The most-capable eligible model establishes each task-class baseline; smaller models, reduced reasoning, lower context fidelity, or shorter retry budgets begin in shadow mode and control dispatch only after meeting explicit outcome and safety thresholds.
- Circuit state, throttles, and recovery flags are durable and provider/host scoped.
- Recovery admits work gradually and never duplicates a job/effect.
- Adaptive task maturity may alter context fidelity, reasoning, model class, reviewer count, and retry budget; it may not weaken approval, review, validation, merge, deployment, security, or evidence gates.

### Slice 6 fixed contracts

- A recipe is a versioned validated graph of steps, dependencies, artifacts, gates, effects, and optional compensations.
- Recipe transition logic is deterministic. Provider calls, shell work, connectors, and external mutations execute only as fenced effects with durable typed results.
- Only the fenced executor advances runs, consumes approval decisions, and leases effects.
- Fan-out joins only after every required child has a durable terminal result.
- A bounded work unit has an acceptance contract before execution and leaves a typed checkpoint for the next unit.
- Human decisions are durable exact-call signals; resume revalidates current identity, authorization, descriptor policy, and fence before continuing.
- Long histories roll over at typed checkpoints, while committed effect results remain referenced and are never replayed from narration.
- Irreversible effects still use explicit capability approval and idempotency/reconciliation.
- The reviewed delivery state machine remains authoritative until an equivalence suite proves a recipe implementation against every current transition and failure invariant.
- Maintenance definitions declare schedule, lease, timeout, cost cap, notification policy, and dedupe key; clean runs are silent.

### Slice 7 fixed contracts

- Artifacts are content-addressed, MIME-sniffed, size-bounded, and stored through BB project attachments or a confined plugin-owned directory.
- Images preserve the existing 10 MiB bound. Each new non-image artifact type receives an explicit product bound in its slice design and obeys any stricter BB or Telegram limit.
- Extraction and transcription produce bounded derived artifacts with provider, model, timestamp, source hash, and failure state.
- Unsupported or failed enrichment preserves the original owner message and reports the bounded limitation.
- The Slice 1 descriptors generalize into a registry for tools, skills, connectors, and recipes; the registry declares schema, effect/risk/data class, reversibility, idempotency, approval requirement, credential scope and audience, egress, host reach, cost class, proof kinds, receipt kind, and result bounds.
- Hanoon-managed connector credentials are least-scope, audience-bound where supported, securely referenced rather than copied into context, and never passed through from one service to another.
- Connector content is untrusted context and cannot modify capability policy.

## Program-level acceptance

The roadmap is complete only when all seven slice gates pass and a release report proves:

- one durable answer path with zero unsupported success claims in the acceptance corpus;
- complete capability-policy coverage for every Hanoon-managed tool, skill, connector, and recipe, with zero policy bypasses in the acceptance corpus;
- Telegram-visible owner decisions for every representable controller permission boundary;
- correlated traces from intake to durable delivery and, for jobs, through exact-head production evidence;
- deterministic replay and nightly regression comparison;
- fixed-harness and strong-elicitation reports that disclose tool/policy/model/context versions, trial counts, budgets, success rates, and cost per successful outcome;
- proactive context rollover without repeated owner context;
- lexical memory operation during semantic-provider failure;
- runtime provider discovery, circuit pause, and duplicate-safe drip recovery;
- at least one non-delivery workflow recipe with fan-out/join and restart recovery;
- voice and document intake with bounded provenance;
- no duplicate irreversible effects;
- no weakening of exact-head review, approval, merge, deployment, or canary rules;
- no raw secrets, prompts, transcripts, unbounded logs, or absolute worktree paths in new durable tables or UI projections.

## Rollout and rollback

- Every schema change is additive and lands before code that requires it.
- New behavior is enabled slice by slice after deterministic and disposable live acceptance.
- A slice may use a bounded compatibility read during one release, but no unbounded dual-write period is allowed.
- Provider routing, reduced reasoning/context/retry policies, and workflow recipes begin in observation/shadow mode and control dispatch only after their declared evaluation threshold passes.
- Semantic retrieval begins as a shadow ranker against a held-out corpus; lexical retrieval remains the fallback and rollback path.
- Semantic retrieval, cockpit UI, evaluation judgment, and enrichment degrade independently without stopping the core controller or delivery pipeline.
- Rollback disables the new reader/dispatcher while retaining additive evidence rows; it never deletes or rewrites durable history.

## Documentation obligations

Each implementation slice updates the README capability summary, architecture, configuration, operations, security, and live-acceptance surfaces that its behavior changes. Planned APIs are documented as planned until their implementation and tests land. No release documentation may describe a live capability solely because it appears in this design.

The research review remains the rationale and source register for this roadmap. Implementation documents link to it instead of copying external guidance into prompts or public operator instructions.
