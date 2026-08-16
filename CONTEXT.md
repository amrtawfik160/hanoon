# Hanoon Agent Pipeline

Language for how Hanoon assigns and proves agent capabilities.

## Language

**Capability**:
A skill, tool, connector, model, or workflow recipe that Hanoon can identify and make available under policy.

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
A durable, bounded fact about requested work or its observed change surface that influences recipe and capability eligibility.
_Avoid_: Prompt guess, hidden classification

**Task recipe**:
A versioned Hanoon stage graph selected from durable task traits: `direct`, `bounded`, `bug`, `architectural`, `skill-authoring`, or `adopted-pr`.
_Avoid_: Universal pipeline, model-managed workflow

**Rigor escalation**:
A one-way change from a task recipe or capability profile to a more protective compatible version after new risk, scope, or failure evidence.
_Avoid_: Silent reroute, automatic downgrade

**Delivery metadata**:
A validated reviewer-facing pull-request title and body proposal derived from the exact final diff. It gives the executor no publishing authority.
_Avoid_: Pull-request action, raw request title

**Code-writing lane**:
The single implementation thread allowed to modify one Hanoon-managed worktree at a time.
_Avoid_: Parallel editors, nested implementer

**Native recipe adapter**:
A versioned Hanoon implementation of an orchestration skill's preserved invariants, with conflicting mechanics replaced by executor-owned stages and receipts.
_Avoid_: Injected orchestration skill, simulated skill use

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
An explicitly configured `strong`, `standard`, or `fast` execution tuple from which Hanoon selects by recipe, stage, risk, and observed complexity.
_Avoid_: Default model, model self-selection

**External capability adapter**:
A reviewed Hanoon-owned RPC or connector boundary that makes an admitted external capability executable under Hanoon's descriptor, approval, and receipt contracts.
_Avoid_: Other-plugin tool selection, installed integration

**Capability profile receipt**:
An append-only `requested`, `selected`, `denied`, or `outcome` record binding a capability and descriptor digest to one profile revision and durable subject.
_Avoid_: Reasoning log, mutable skill claim

**Recipe promotion**:
The per-recipe transition from shadow observation to dispatch control after deterministic, disposable-live, and fixed-harness gates pass.
_Avoid_: Global rollout, trial by production

**Shadow profile**:
A candidate capability profile recorded for comparison without controlling the active attempt.
_Avoid_: Dry run, inactive configuration

**Orchestration authority**:
The Hanoon executor that owns agent fan-out, worktrees, retries, publishing, and durable stage transitions.
_Avoid_: Nested orchestrator, worker-owned pipeline

**Capability expansion budget**:
The single batched, compatible profile revision and bounded continuation allowed for one logical controller turn or worker attempt.
_Avoid_: Recursive discovery, repeated tool expansion

**Mandatory capability**:
A capability whose successful terminal outcome is required by the selected recipe before its stage may advance.
_Avoid_: Best-effort guard, silently skipped skill

**Guard disposition**:
The registry-derived classification of a guard finding as `must_fix` or `advisory`; it is recomputed by Hanoon from stable rule identity rather than trusted from reviewer prose.
_Avoid_: Model-selected blocker, every stylistic note blocks

**Thread ask**:
The one-line reason the controller gives when it messages a worker thread, recorded once the send lands and owed to the owner until a reply states it. It is the substance of the instruction, not the message text.
_Avoid_: Tool narration, the sent message, a promise to explain later
