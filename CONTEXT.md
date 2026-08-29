# Hanoon Agent Pipeline

Language for how Hanoon assigns and proves agent capabilities.

## Language

**Capability**:
A skill, tool, connector, model, or native operation that Hanoon can identify and make available under policy.

**Capability profile**:
The smallest policy-approved set of capabilities assigned to one verified role and task attempt.
_Avoid_: Everything enabled, global toolset

**Capability route**:
The one approved way a capability participates: `worker`, `hanoon-native`, `manual-only`, or `inventory-only`.
_Avoid_: Globally enabled, always loaded

**Selection receipt**:
A durable record explaining why a capability was eligible and included in a specific capability profile. It is not proof that the capability affected the result.
_Avoid_: Skill-use proof, reasoning trace

**Outcome receipt**:
A durable record linking a capability to an observable artifact, strict result, command outcome, finding, or state transition.
_Avoid_: Self-reported use, hidden reasoning proof

**Capability request**:
An agent's bounded proposal to add a compatible capability to its current profile. Hanoon policy, not the requesting agent, decides whether it is granted.
_Avoid_: Self-assigned tool, dynamic permission

**Profile revision**:
An immutable, incremented capability profile produced when Hanoon approves a compatible additive capability request at a provider message boundary.
_Avoid_: Live permission mutation, silent tool expansion

**Admitted capability**:
A discovered capability with a complete descriptor, passing compatibility evidence, shadow evaluation, and an explicit eligible role or task mapping.
_Avoid_: Installed capability, trusted by presence

**Task trait**:
A durable, bounded fact about requested work or its observed change surface that influences workflow and capability eligibility.
_Avoid_: Prompt guess, hidden classification

**Rigor escalation**:
A one-way change to a more protective workflow step, capability profile, or model route after new risk, scope, or failure evidence.
_Avoid_: Silent reroute, automatic downgrade

**Delivery metadata**:
A validated reviewer-facing pull-request title and body proposal derived from the exact final diff. It gives the executor no publishing authority.
_Avoid_: Pull-request action, raw request title

**Code-writing lane**:
The single implementation thread allowed to modify one Hanoon-managed worktree at a time.
_Avoid_: Parallel editors, nested implementer

**Capability compatibility graph**:
Declarative prerequisites, exclusions, ordering rules, and task-surface triggers that constrain capability profile composition.
_Avoid_: Prompt-only routing, worker discretion

**Guard result envelope**:
One strict review-attempt result containing a separate terminal outcome for every guard selected from the observed change surface.
_Avoid_: Combined verdict, prose review claim

**Capability descriptor**:
The versioned policy record declaring one capability's identity, route, eligibility, effects, risk, data access, authority requirements, cost, bounds, and proof contract.
_Avoid_: Tool description, prompt hint

**Capability bundle**:
A named, policy-approved group of related controller tools granted to one logical turn through a capability profile revision.
_Avoid_: Global toolset, permanent session permission

**Model pool**:
An explicitly configured `strong`, `standard`, or `fast` execution tuple from which Hanoon selects by step contract, risk, and observed complexity.
_Avoid_: Default model, model self-selection

**External capability adapter**:
A reviewed Hanoon-owned RPC or connector boundary that makes an admitted external capability executable under Hanoon's descriptor, approval, and receipt contracts.
_Avoid_: Other-plugin tool selection, installed integration

**Capability profile receipt**:
An append-only `requested`, `selected`, `denied`, or `outcome` record binding a capability and descriptor digest to one profile revision and durable subject.
_Avoid_: Reasoning log, mutable skill claim

**Shadow profile**:
A candidate capability profile recorded for comparison without controlling the active attempt.
_Avoid_: Dry run, inactive configuration

**Orchestration authority**:
The Hanoon executor's exclusive right to own agent fan-out, worktrees, retries, publishing, external effects, and durable transitions.
_Avoid_: Nested orchestrator, worker-owned pipeline

**Capability expansion budget**:
The single batched, compatible profile revision and bounded continuation allowed for one logical controller turn or worker attempt.
_Avoid_: Recursive discovery, repeated tool expansion

**Mandatory capability**:
A capability whose successful terminal outcome is required by an accepted workflow step or release gate before work may advance.
_Avoid_: Best-effort guard, silently skipped skill

**Invocation class**:
Whether a skill may be selected by a matching model or must be explicitly invoked by the owner or workflow navigator.
_Avoid_: Globally auto-triggered skill, prompt convention

**Workflow navigator**:
The agent-owned decision module that proposes one next workflow step from current durable facts without holding effect authority.
_Avoid_: Recipe classifier, executor, autonomous tool caller

**Navigator snapshot**:
An immutable, bounded view of the job, artifacts, policy, capabilities, and evidence against which one navigator proposal is made.
_Avoid_: Live service context, mutable job object

**Workflow step**:
One accepted, version-bound attempt to invoke an admitted skill or enter a guarded release from a navigator snapshot.
_Avoid_: Pipeline stage, mutable plan item

**Skill step contract**:
Hanoon's executable policy for a schedulable skill's inputs, resources, result schema, evidence, and allowed artifact effects.
_Avoid_: Skill prose as API, worker discretion

**Work artifact**:
A durable map, specification, decision ticket, implementation ticket, or resolution represented in the configured tracker and mirrored into Hanoon's evidence model.
_Avoid_: Worker thread, job status, prompt attachment

**Artifact snapshot**:
An immutable tracker revision and content digest accepted as the input to a workflow step.
_Avoid_: Current issue body, mutable reference document

**Frontier**:
The ordered set of open, unblocked, and unclaimed work artifacts eligible for the next claim.
_Avoid_: Backlog, all open issues

**Task outcome**:
The terminal result the owner asked one job to reach: an accepted artifact, a reviewed change, or a shipped change.
_Avoid_: Delivery mode, workflow recipe

**Task authority**:
An authenticated, project- and job-scoped grant to perform the effects required by one task outcome under project policy.
_Avoid_: Standing approval, blanket autonomy

**Owner boundary**:
A durable wait for a specific decision, authority grant, access action, or spending choice that Hanoon cannot safely supply itself.
_Avoid_: Uncertainty, progress update, routine approval

**Release authority receipt**:
One exact-head record showing that live task, explicit, or standing authority permits a merge after all release gates pass.
_Avoid_: Task authority, merge button, review receipt

**Release controller**:
The executor-owned submachine that validates the final head and carries an authorized change through merge, deployment, canary, and recovery.
_Avoid_: Workflow navigator, shipping skill

**Production incident**:
A failed or indeterminate deployment or canary after a production mutation may have occurred.
_Avoid_: Test failure, ordinary retry

**Guard disposition**:
The registry-derived classification of a guard finding as `must_fix` or `advisory`; it is recomputed by Hanoon from stable rule identity rather than trusted from reviewer prose.
_Avoid_: Model-selected blocker, every stylistic note blocks

**Thread ask**:
The one-line reason the controller gives when it messages a worker thread, recorded once the send lands and owed to the owner until a reply states it. It is the substance of the instruction, not the message text.
_Avoid_: Tool narration, the sent message, a promise to explain later

**Reference document**:
A project- or globally-scoped document Hanoon indexes for consultation. It informs work but is neither the canonical tracker artifact nor an executable instruction.
_Avoid_: Uploaded file, attachment, knowledge base

**Structural map**:
A bounded heading tree with each section's full path and character count, used to show agents what a reference document contains before retrieving its body. It keeps every top-level heading when they fit; under an extreme limit it names omitted structure explicitly.
_Avoid_: Summary, table of contents

**Passage**:
A retrievable part of a reference document carrying its full section path. It is the unit of search and citation.
_Avoid_: Chunk, excerpt, snippet

**Outside reading**:
A durable record that the agent read material outside Hanoon's tools, including its source, capture time, and a bounded excerpt.
_Avoid_: Search result, fetched page, tool output

**Specification conflict**:
A disagreement between a reference document and the current instruction about what to build or which rule governs. A disagreement about implementation details is not one.
_Avoid_: Mismatch, discrepancy, contradiction

**Conduct layer**:
The fixed, non-overridable instructions that define the agent's behavioural boundaries.
_Avoid_: System prompt, persona, guardrails

**Identity layer**:
The replaceable instructions that define who the agent is and how it communicates, without changing its conduct layer.
_Avoid_: Persona, character, prompt
