# Adaptive Capability Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace static all-tools and role-only routing with a durable, least-capability, evidence-backed pipeline that selects one of six recipes, all 23 bundled skills, explicit model pools, and bounded recovery without weakening existing delivery fences.

**Architecture:** Add pure capability contracts, a pinned catalog, deterministic routing, and guard logic ahead of focused SQLite repositories. Persist immutable profiles and append-only receipts before provider work, then project them into BB agent configuration and the existing executor. Preserve the current state machine as the legacy fallback while shadow and active recipe modes reuse its proven approval, merge, deployment, canary, and idempotent-effect boundaries.

**Tech Stack:** TypeScript, Zod, better-sqlite3, BB Plugin SDK 0.4.1, Vitest, Telegram, Git/GitHub-backed delivery effects.

**Spec:** `docs/designs/adaptive-capability-pipeline.md`

## Global Constraints

- Hanoon remains the only orchestration authority; skills never authorize worktrees, fan-out, retries, publishing, merging, deployment, or state transitions.
- Preserve generation fences, resource claims, exact-head review, one-use owner approval, effect idempotency, deployment/canary receipts, and durable Telegram outbox behavior.
- Keep active legacy jobs on their snapshotted graph. New behavior defaults to shadow until its recipe promotion gate passes.
- Use append-only migrations and focused repositories; do not add another storage domain directly to the 10,000-line `src/storage/store.ts`.
- One code-writing lane owns a managed worktree. Independent read/review lanes may run concurrently.
- A logical subject receives at most one batched capability expansion and one bounded continuation.
- Automatic recipe promotion is monotonic and capped at two. Planning gets one critique-driven revision, structured output one format correction, and review 1–10 cycles with default 3.
- A repeated mandatory finding receives two remediation attempts; its third occurrence blocks.
- Model attempts keep one provider/model/reasoning/tier tuple. Two equivalent failures escalate one pool; two at `strong` block.
- External discovery is read-only. Installation, enablement, updates, credentials, and new authority require explicit owner action outside discovery.
- Do not store raw prompts, private reasoning, credentials, absolute paths, or unbounded logs.
- Do not commit, push, merge, deploy, or open a pull request during this implementation.

---

### Task 1: Capability contracts and pinned catalog

**Files:**
- Create: `src/capabilities/contracts.ts`
- Create: `src/capabilities/catalog.ts`
- Test: `tests/capability-catalog.test.ts`
- Modify: `src/agent-skills/role-resolver.ts`
- Modify: `tests/skill-bundle.test.ts`

**Interfaces:**
- Produces: `CapabilityDescriptor`, `CapabilityRoute`, `CapabilityKind`, `CapabilityTerminalOutcome`, `CAPABILITY_CATALOG`, `descriptorDigest()`, `validateCapabilityCatalog()`.
- Consumes: `REQUIRED_SKILLS` and the existing 23-skill bundle contract.

- [x] **Step 1: Write the failing catalog tests**

Create literal tests proving all 23 bundled skill ids appear exactly once, the four routes validate, all executable descriptors contain every required contract group, unknown keys fail, missing prerequisites fail, conflicts are symmetric, ordering is acyclic, and declared substitutes are admitted and equal-or-stronger.

```ts
it("describes every bundled skill exactly once", () => {
  expect(CAPABILITY_CATALOG.filter((entry) => entry.kind === "skill").map((entry) => entry.id).sort())
    .toEqual(REQUIRED_SKILLS.map((entry) => entry.id).sort());
});

it("rejects an executable capability without a proof contract", () => {
  const broken = { ...CAPABILITY_CATALOG[0], evidence: undefined };
  expect(() => validateCapabilityCatalog([broken])).toThrow(/evidence/i);
});
```

- [x] **Step 2: Verify RED**

Run `npx vitest run tests/capability-catalog.test.ts`.

Expected: FAIL because `src/capabilities/contracts.ts` and `catalog.ts` do not exist.

- [x] **Step 3: Implement strict descriptor contracts**

Export these strict schemas and inferred types:

```ts
export type CapabilityRoute = "worker" | "hanoon-native" | "manual-only" | "inventory-only";
export type CapabilityKind = "skill" | "tool" | "native-adapter" | "model" | "connector" | "recipe";
export type CapabilityTerminalOutcome = "passed" | "findings" | "blocked" | "failed";

export const capabilityDescriptorSchema = z.object({
  id: boundedId,
  kind: z.enum(["skill", "tool", "native-adapter", "model", "connector", "recipe"]),
  source: boundedText,
  version: boundedText,
  digest: sha256Hex,
  status: z.enum(["admitted", "disabled", "retired"]),
  route: z.enum(["worker", "hanoon-native", "manual-only", "inventory-only"]),
  routing: routingSchema,
  composition: compositionSchema,
  effects: effectsSchema,
  authority: authoritySchema,
  contract: ioContractSchema,
  economics: economicsSchema,
  evidence: evidenceSchema,
}).strict();
```

Use deterministic canonical JSON and SHA-256 for `descriptorDigest`. Bound every list and string before hashing. `validateCapabilityCatalog` rejects duplicate ids, digest mismatch, incomplete executable descriptors, cycles, asymmetric conflicts, unknown dependencies/substitutes, and weaker substitutes.

- [x] **Step 4: Build the complete catalog**

Describe all 23 skills with the exact routes and triggers from the approved specification. Add descriptors for six recipes, seven controller bundles (six domain bundles plus the metadata pair), seven native adapters, and three model-pool capability ids. Keep the catalog declaration data-only; put validation logic in `contracts.ts`.

- [x] **Step 5: Verify GREEN**

Run `npx vitest run tests/capability-catalog.test.ts tests/skill-bundle.test.ts tests/agent-skill-routing.test.ts`.

Expected: PASS with exactly 23 skill descriptors and no change to bundle integrity.

---

### Task 2: Immutable profiles and append-only universal receipts

**Files:**
- Create: `src/storage/capability-repository.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `src/storage/store.ts`
- Test: `tests/capability-repository.test.ts`
- Modify: `tests/storage.test.ts`

**Interfaces:**
- Consumes: descriptor ids/digests and recipe/model selections from Task 1.
- Produces: `CapabilityRepository.createProfile()`, `appendReceipt()`, `appendTerminalOutcome()`, `getActiveProfile()`, `getProfileForThread()`, `listReceipts()`, `listSkillReceiptProjection()`.

- [x] **Step 1: Write failing real-SQLite tests**

Cover atomic profile creation, normalized assignments, monotonic revisions, one active profile per subject/revision, one terminal outcome for a mandatory assignment, append-only rejection, transaction rollback, concurrent revision conflict, and compatibility projection.

```ts
const profile = primary.createProfile({
  subjectKind: "worker_attempt",
  subjectId: "attempt_1",
  recipeId: "bounded",
  recipeVersion: 1,
  registryDigest: "a".repeat(64),
  graphDigest: "b".repeat(64),
  mode: "shadow",
  model: strongTuple,
  assignments: [{ capabilityId: "test-driven-development", descriptorDigest: "c".repeat(64), mandatory: true }],
  reasonCodes: ["logic_change"],
  traits: ["logic"],
  now: 1_000,
});
expect(profile.revision).toBe(1);
expect(primary.appendTerminalOutcome({ profileId: profile.id, capabilityId: "test-driven-development", outcome: "passed", evidenceRefs: ["attempt:1"], now: 2_000 })).toBe(true);
expect(() => primary.appendTerminalOutcome({ profileId: profile.id, capabilityId: "test-driven-development", outcome: "passed", evidenceRefs: ["attempt:2"], now: 3_000 })).toThrow(/terminal/i);
```

- [x] **Step 2: Verify RED**

Run `npx vitest run tests/capability-repository.test.ts`.

Expected: FAIL because the repository and tables do not exist.

- [x] **Step 3: Add append-only migrations**

Append migrations for:

```sql
capability_profiles
capability_profile_assignments
capability_receipts
capability_inventory
recipe_promotions
model_route_trials
guard_fingerprints
```

Use foreign keys, enum checks, bounded JSON projections, unique `(subject_kind, subject_id, revision)`, unique selected assignments, and a partial unique terminal-outcome index. Add a read-only `skill_receipts` view over skill assignments and their terminal outcomes. Do not modify or duplicate `tool_receipts`.

- [x] **Step 4: Implement the focused repository**

Validate all writes before SQL. `createProfile` inserts the profile, selected assignments, and `selected` receipts in one immediate transaction. A revision must equal the current maximum plus one. `appendTerminalOutcome` verifies exact descriptor identity and uses the partial unique constraint to reject replay. Return bounded typed projections, never raw JSON strings.

Expose narrow delegation methods on `TelegramAgentStore`; instantiate `CapabilityRepository` beside `AutonomyRepository` without moving unrelated store logic.

- [x] **Step 5: Verify GREEN**

Run `npx vitest run tests/capability-repository.test.ts tests/storage.test.ts tests/autonomy-migration.test.ts`.

Expected: PASS, including migration from every existing fixture database.

---

### Task 3: Deterministic task traits, recipes, and durable job snapshots

**Files:**
- Create: `src/capabilities/routing.ts`
- Create: `src/domain/recipes.ts`
- Modify: `src/domain/models.ts`
- Modify: `src/storage/job-persistence.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `src/storage/store.ts`
- Modify: `src/controller/tools.ts`
- Test: `tests/task-routing.test.ts`
- Modify: `tests/job-persistence.test.ts`
- Modify: `tests/controller-tools.test.ts`

**Interfaces:**
- Produces: `TaskRecipe`, `TaskTrait`, `classifyTaskTraits()`, `selectTaskRecipe()`, `promoteTaskRecipe()`, `recipeExecutionPolicy()`.
- Persists: `job.taskRecipe`, `job.recipeVersion`, `job.recipePromotionCount`, `job.routingMode`.

- [x] **Step 1: Write the failing classifier table**

Use hand-derived fixtures for priority and negative cases. Prove adopted PR outranks all traits, skill authoring retains identity, architectural risk outranks bug/direct, a reproducible bug outranks direct wording, direct requires zero behavioral risk, and bounded is the fallback.

```ts
it.each([
  [{ origin: "adopted_pr", text: "fix auth" }, "adopted-pr"],
  [{ origin: "requested", text: "update the foo skill" }, "skill-authoring"],
  [{ origin: "requested", text: "migrate the public billing schema" }, "architectural"],
  [{ origin: "requested", text: "reproduce the crash when saving" }, "bug"],
  [{ origin: "requested", text: "change README wording" }, "direct"],
  [{ origin: "requested", text: "add a filter to the existing list" }, "bounded"],
])("selects %s", (input, expected) => expect(selectTaskRecipe(classifyTaskTraits(input))).toBe(expected));
```

Also prove the owner can increase rigor, cannot suppress a safety trait, automatic promotion stops after two, and retry/restart never downgrades.

- [x] **Step 2: Verify RED**

Run `npx vitest run tests/task-routing.test.ts`.

Expected: FAIL because routing modules do not exist.

- [x] **Step 3: Implement pure routing**

Represent traits as a bounded sorted set with provenance (`owner`, `origin`, `policy`, `repository`, `diff`, `failure`). Use anchored token/phrase tables only for low-risk initial hints. Safety-critical traits come from explicit owner text, job origin, project policy, or observed repository/diff evidence. The pure classifier returns `{ recipe, traits, reasonCodes }`; it never writes state.

`recipeExecutionPolicy` maps recipes onto proven state-machine entry behavior:

```ts
type RecipeExecutionPolicy = Readonly<{
  planning: "none" | "approved-design" | "plan-and-critique";
  diagnosis: boolean;
  baselineTest: boolean;
  review: "diff-guards" | "single" | "task-and-integrated";
  documentation: "conditional";
}>;
```

- [x] **Step 4: Persist routing snapshots**

Add append-only job columns with legacy-safe defaults. Existing rows map `small_fix` to `direct`, adopted origin to `adopted-pr`, and remaining `full` rows to `architectural` in `legacy` mode. New controller jobs store the selected recipe and traits transactionally before admission. Keep `delivery_mode` as a compatibility projection: `direct` maps to `small_fix`; other recipes map to `full` until active recipe execution replaces that branch.

- [x] **Step 5: Verify GREEN**

Run `npx vitest run tests/task-routing.test.ts tests/job-persistence.test.ts tests/controller-tools.test.ts tests/state-machine.test.ts`.

Expected: PASS with old fixtures parsed and new jobs carrying immutable recipe snapshots.

---

### Task 4: Least-capability worker profiles and compatibility graph

**Files:**
- Create: `src/capabilities/profiles.ts`
- Modify: `src/agent-skills/role-resolver.ts`
- Modify: `src/controller/tools.ts`
- Modify: `src/services/effect-runner.ts`
- Modify: `src/bb/handoffs.ts`
- Modify: `src/bb/pipeline-handoffs.ts`
- Test: `tests/capability-profiles.test.ts`
- Modify: `tests/agent-skill-routing.test.ts`
- Modify: `tests/effect-runner.test.ts`

**Interfaces:**
- Consumes: verified worker identity, task recipe/traits, stage, observed change surface, and catalog.
- Produces: `selectCapabilityProfile()`, `resolvePersistedWorkerProfile()`, profile-aware worker instructions.

- [x] **Step 1: Write failing profile-selection tests**

Cover every recipe/stage matrix, completed-grill exclusion of brainstorming, debug-before-TDD ordering, writing-skills prerequisite, remediation-only receiving-review, strict-role communication exclusion, exact-diff guards, nontrivial final-diff PR writing, raw orchestration-skill exclusion, and denied-reason receipts.

```ts
expect(selectCapabilityProfile(bugImplementation)).toMatchObject({
  skills: [
    "systematic-debugging",
    "test-driven-development",
    "verification-before-completion",
  ],
});
expect(selectCapabilityProfile(grilledArchitecture).skills).not.toContain("brainstorming");
```

- [x] **Step 2: Verify RED**

Run `npx vitest run tests/capability-profiles.test.ts`.

Expected: FAIL because profile selection does not exist.

- [x] **Step 3: Implement compatibility-aware selection**

Select the minimum catalog assignments whose role, recipe, stage, and traits match. Topologically order skills. Deny conflicts and unmet prerequisites with stable reason codes. Never insert `hanoon-native`, `manual-only`, or `inventory-only` entries into worker `skills`.

Persist the profile and its selection receipts before emitting a spawn effect. Put profile id/revision and recipe version into the work-order envelope. `bb.agents.configure` resolves worker skills only from the exact persisted thread/attempt profile and returns none on identity, digest, revision, or role mismatch.

- [x] **Step 4: Emit observable outcomes**

On strict worker completion, bind verification, artifact, command, or review evidence to selected mandatory capabilities before transition. Missing mandatory outcomes block the transition. Native orchestration stages append `hanoon-native` outcomes atomically with their executor transition.

- [x] **Step 5: Verify GREEN**

Run `npx vitest run tests/capability-profiles.test.ts tests/agent-skill-routing.test.ts tests/effect-runner.test.ts tests/handoffs.test.ts`.

Expected: PASS and unknown/spoofed workers still receive no skills or tools.

---

### Task 5: Controller tool bundles and bounded capability expansion

**Files:**
- Create: `src/capabilities/controller-bundles.ts`
- Modify: `src/controller/tools.ts`
- Modify: `src/controller/models.ts`
- Modify: `src/controller/service.ts`
- Modify: `src/storage/capability-repository.ts`
- Modify: `src/storage/store.ts`
- Test: `tests/controller-capabilities.test.ts`
- Modify: `tests/controller-tools.test.ts`
- Modify: `tests/controller-service.test.ts`

**Interfaces:**
- Produces: `CONTROLLER_TOOL_BUNDLES`, `selectControllerBundles()`, `telegram_agent_capabilities`, `telegram_agent_request_capability`.
- Persists: one controller-turn profile revision and expansion count.

- [x] **Step 1: Write failing bundle and tool tests**

Assert the exact 23-tool partition from the spec, no duplicates, no omissions, metadata tools always selected, intent-specific minimum bundles, one compatible batch grant, a denied second request, and denial for effects/credentials/egress/orchestration changes.

```ts
expect(new Set(Object.values(CONTROLLER_TOOL_BUNDLES).flat())).toEqual(new Set(CONTROLLER_TOOL_NAMES));
expect(selectControllerBundles("show job status")).toEqual(["core-observation"]);
expect(selectControllerBundles("start the approved implementation")).toEqual(["core-observation", "job-control"]);
```

- [x] **Step 2: Verify RED**

Run `npx vitest run tests/controller-capabilities.test.ts tests/controller-tools.test.ts`.

Expected: FAIL because all controller tools are still selected.

- [x] **Step 3: Register metadata tools and select bundles**

Keep all domain tools registered, but return only selected bundle names from `bb.agents.configure`. Detect explicit `/grill-with-docs`, `/grilling`, or `/domain-modeling` invocation and add the three manual discovery skills for that turn only. Normal controller profiles contain communication and proportional-development guidance but no manual discovery skills.

`telegram_agent_capabilities` returns only bounded profile, eligible-bundle, denial, and inventory summaries. `telegram_agent_request_capability` accepts one array of bundle ids, checks compatibility and authority, records `requested` plus `selected` or `denied`, and never executes the requested domain operation itself.

- [x] **Step 4: Enforce the safe provider boundary**

An approved expansion stores revision `n + 1`, sets `capabilityContinuationCount` from 0 to 1, and returns a typed `resume_required` result. The controller service retires the current provider mapping at the next idle boundary, resubmits one bounded continuation on the same logical turn, and verifies `bb.agents.configure` resolved the new profile before exposing added tools. A second expansion or unproved relaunch blocks with a stable reason.

- [x] **Step 5: Verify GREEN**

Run `npx vitest run tests/controller-capabilities.test.ts tests/controller-tools.test.ts tests/controller-service.test.ts tests/controller-supervisor.test.ts`.

Expected: PASS; unrelated and spoofed sessions receive no tools, and a live session is never assumed to hot-mutate.

---

### Task 6: Per-guard envelopes, deterministic disposition, and loop bounds

**Files:**
- Create: `src/capabilities/guards.ts`
- Modify: `src/domain/review.ts`
- Modify: `src/domain/review-lenses.ts`
- Modify: `src/services/review-handler.ts`
- Modify: `src/services/effect-runner.ts`
- Modify: `src/storage/capability-repository.ts`
- Test: `tests/guard-envelopes.test.ts`
- Modify: `tests/review.test.ts`
- Modify: `tests/review-loop.test.ts`
- Modify: `tests/review-lenses.test.ts`

**Interfaces:**
- Produces: `guardResultEnvelopeSchema`, `assessGuardEnvelope()`, `guardFindingFingerprint()`, `recordGuardFingerprint()`, `requiredGuardsForChangeSurface()`.
- Consumes: exact head SHA, diff digest, work-order requirement ids, and selected mandatory guard descriptors.

- [x] **Step 1: Write failing guard tests**

Prove exact-head/diff matching, one terminal result per selected guard, rejection of extra/missing/duplicate guards, deterministic rule disposition, critical/high and must-fix remediation, advisory medium/low reporting, blocked/failed mandatory behavior, declared substitute handling, and third-fingerprint blocking.

```ts
expect(assessGuardEnvelope(envelopeWith("medium", "docs.rule-10"), policy).outcome).toBe("pass_with_advisories");
expect(assessGuardEnvelope(envelopeWith("low", "docs.rule-1"), policy).outcome).toBe("changes_requested");
expect(recordGuardFingerprint(threeTimesSameFinding)).toMatchObject({ outcome: "blocked", occurrence: 3 });
```

- [x] **Step 2: Verify RED**

Run `npx vitest run tests/guard-envelopes.test.ts`.

Expected: FAIL because review has no per-guard contract or stable rule ids.

- [x] **Step 3: Implement the strict envelope**

The model supplies rule id, severity, relative subject, evidence, and optional requirement id. It cannot supply disposition. Hanoon verifies selected guard ids and derives `must_fix` or `advisory` from the catalog plus work order. Hash descriptor digest, rule id, normalized subject, and requirement/evidence class; exclude mutable prose.

Persist each guard's terminal capability outcome before settling the group. A mandatory `blocked` or `failed` result uses one declared substitute or blocks. Optional denial may pass with a receipt.

- [x] **Step 4: Preserve bounded review behavior**

Keep one format correction. Keep project `maxReviewCycles` bounds 1–10/default 3. Record fingerprint occurrences transactionally with remediation transition. First and second mandatory occurrences remediate; the third blocks even when `reviewBlockAt` is larger.

- [x] **Step 5: Verify GREEN**

Run `npx vitest run tests/guard-envelopes.test.ts tests/review.test.ts tests/review-loop.test.ts tests/review-lenses.test.ts tests/state-machine.test.ts`.

Expected: PASS, including exact-head concurrency and existing review recovery tests.

---

### Task 7: Explicit model pools and read-only external inventory

**Files:**
- Create: `src/capabilities/models.ts`
- Create: `src/capabilities/inventory.ts`
- Modify: `src/domain/models.ts`
- Modify: `src/config.ts`
- Modify: `src/plugin.ts`
- Modify: `src/services/pipeline-stage-runner.ts`
- Modify: `src/services/job-memory-service.ts`
- Modify: `src/storage/capability-repository.ts`
- Modify: `src/storage/store.ts`
- Test: `tests/model-routing.test.ts`
- Test: `tests/capability-inventory.test.ts`
- Modify: `tests/plugin.test.ts`

**Interfaces:**
- Produces: `ModelPoolRegistry`, `selectModelRoute()`, `recordModelFailure()`, `discoverExternalInventory()`, `admitInventoryItem()`.
- Consumes: BB `providers.list`, `providers.models`, `plugins.list`, and `skills.list` read APIs.

- [x] **Step 1: Write failing model and inventory tests**

Cover recipe/stage/risk routing, exact tuple persistence, no in-attempt switch, two equivalent failures per tier, no downgrade, exhaustion at `strong`, five-trial shadow evidence, read-only discovery, bounded redaction, and non-executable inventory status.

```ts
expect(selectModelRoute({ recipe: "architectural", stage: "planning", risk: "high" }, pools).pool).toBe("strong");
expect(selectModelRoute({ recipe: "direct", stage: "delivery-metadata", risk: "low" }, pools).pool).toBe("fast");
expect(() => admitInventoryItem(discoveredOnly)).toThrow(/descriptor|shadow|mapping/i);
```

- [x] **Step 2: Verify RED**

Run `npx vitest run tests/model-routing.test.ts tests/capability-inventory.test.ts`.

Expected: FAIL because model pools and inventory do not exist.

- [x] **Step 3: Implement explicit pool routing**

Add strict `fast`, `standard`, and `strong` tuples per execution class. A tuple contains provider id, model id, reasoning level, and service tier; permission remains role policy. Legacy project profiles remain the legacy-mode fallback. Shadow/active routing requires complete tuples and blocks unknown configuration rather than inheriting a provider default.

Failure equivalence hashes provider, model, stage, normalized error class, and operation. The second equivalent failure selects the next pool for a new attempt. At `strong`, the second equivalent failure blocks. Persist the chosen tuple before spawn.

- [x] **Step 4: Implement read-only inventory**

Call only the four BB read methods named above. Normalize plugin, skill, provider, and model records into bounded inventory rows with source identity, version when available, digest when available, host scope, discovery time, and `inventory-only` status. Refresh at plugin start and then on a bounded interval; discovery failure keeps the previous snapshot and records health state without changing authority.

Admission remains a maintainer-controlled catalog change plus tests. Do not call plugin or skill install/update/remove methods and do not request credentials.

- [x] **Step 5: Verify GREEN**

Run `npx vitest run tests/model-routing.test.ts tests/capability-inventory.test.ts tests/plugin.test.ts tests/pipeline-stage-runner.test.ts tests/job-memory.test.ts`.

Expected: PASS with zero mutating SDK calls during discovery.

---

### Task 8: Recipe-aware executor and native adapters

**Files:**
- Modify: `src/domain/state-machine.ts`
- Modify: `src/domain/pipeline-graph.ts`
- Modify: `src/services/effect-runner.ts`
- Modify: `src/services/job-executor-service.ts`
- Modify: `src/services/pipeline-stage-runner.ts`
- Modify: `src/bb/handoffs.ts`
- Modify: `src/bb/pipeline-handoffs.ts`
- Modify: `src/bb/prompts.ts`
- Test: `tests/recipe-execution.test.ts`
- Modify: `tests/state-machine.test.ts`
- Modify: `tests/pipeline-graph.test.ts`
- Modify: `tests/end-to-end.test.ts`

**Interfaces:**
- Consumes: durable recipe snapshot, profile ids, model route, guard outcome, and native-adapter descriptor.
- Produces: recipe-aware stage/effect selection and atomic native-adapter outcome receipts.

- [x] **Step 1: Write failing recipe graph tests**

Exercise all six required graphs, monotonic two-step escalation, restart reconstruction, one code writer per worktree, independent review lanes, conditional docs, deterministic direct metadata, nontrivial PR-writer metadata, and architectural task plus integrated review gates.

```ts
expect(runRecipe("direct").stages).toEqual(["implementation", "validation", "diff-guards", "delivery"]);
expect(runRecipe("bug").stages).toEqual(["diagnosis", "regression", "implementation", "validation", "review", "delivery"]);
expect(runRecipe("architectural").stages).toEqual(["plan", "critique", "implementation", "task-review", "validation", "integrated-review", "delivery"]);
```

Prove existing approval, merge, deploy, canary, effect, claim, and stale-head tests are unchanged.

- [x] **Step 2: Verify RED**

Run `npx vitest run tests/recipe-execution.test.ts`.

Expected: FAIL because state progression reads only `deliveryMode` and origin.

- [x] **Step 3: Add recipe-aware entry and skips**

Use `recipeExecutionPolicy` at confirmation and review completion. `direct`, `bounded`, `bug`, and `skill-authoring` enter implementation after their approved precondition envelope is present. `architectural` uses plan/critique. `adopted-pr` retains exact remote-head setup. Validation and exact-head review remain mandatory when merge is requested.

Compute documentation need from the exact diff: documentation files changed, public API/config/CLI behavior changed, or the work order explicitly requires docs. Skip the docs worker otherwise. A selected docs worker must emit a terminal `docs-guard` outcome.

- [x] **Step 4: Record native adapter outcomes**

Wrap worktree creation, parallel fan-out, plan execution, review creation, and branch finishing in named adapter calls. Each adapter verifies its source digest and preserved invariants, then commits its `hanoon-native` outcome with the authoritative transition. Raw orchestration skills never enter worker profiles.

- [x] **Step 5: Verify GREEN**

Run `npx vitest run tests/recipe-execution.test.ts tests/state-machine.test.ts tests/pipeline-graph.test.ts tests/effect-runner.test.ts tests/end-to-end.test.ts`.

Expected: PASS in `legacy`, `shadow`, and fake-host `active` modes.

---

### Task 9: Kill switches, promotion gates, Telegram projection, and operator commands

**Files:**
- Create: `src/capabilities/promotion.ts`
- Modify: `src/config.ts`
- Modify: `src/plugin.ts`
- Modify: `src/cli.ts`
- Modify: `src/telegram/view.ts`
- Modify: `src/controller/tools.ts`
- Modify: `src/services/monitor-service.ts`
- Test: `tests/capability-promotion.test.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/telegram-view.test.ts`
- Modify: `tests/monitor.test.ts`

**Interfaces:**
- Produces: `assessRecipePromotion()`, routing-mode settings, `bb telegram-agent capability <status|inventory|receipts|promote|rollback>`.
- Consumes: deterministic results, disposable-live run evidence, model trials, and zero-tolerance safety counters.

- [x] **Step 1: Write failing promotion and projection tests**

Prove all required deterministic categories, classifier 100%, one recovery live run, at least five model trials, candidate success count at least baseline, and every zero-tolerance counter. Prove promotion is per recipe in the order direct, bounded, bug, skill-authoring, adopted-pr, architectural. Prove each kill switch affects only new attempts and preserves receipts.

Assert normal Telegram cards show recipe/stage, material escalation, blocker/decision, verification/guard outcome, and delivery state—without capability dumps. Detailed status/CLI views show bounded ids, revisions, model tuple, and receipt summaries but no private fields.

- [x] **Step 2: Verify RED**

Run `npx vitest run tests/capability-promotion.test.ts tests/telegram-view.test.ts tests/cli.test.ts`.

Expected: FAIL because promotion and capability operator surfaces do not exist.

- [x] **Step 3: Implement promotion and rollback**

Promotion reads durable evidence and writes one `recipe_promotions` decision. It cannot accept typed assertions as live proof. Add independent settings/flags for legacy job graph, all-tools controller, and strong-only model routing. Rollback changes new dispatch selection only; it never deletes profiles/receipts or mutates in-flight snapshots.

- [x] **Step 4: Implement quiet observability**

Add the concise normal status fields. Notify only on material denial, escalation, substitute use, exhausted recovery, missing mandatory evidence, or owner decision. Add bounded capability detail commands and tool projections. Apply existing redaction and Telegram length limits before persistence or delivery.

- [x] **Step 5: Verify GREEN**

Run `npx vitest run tests/capability-promotion.test.ts tests/telegram-view.test.ts tests/cli.test.ts tests/monitor.test.ts tests/controller-tools.test.ts`.

Expected: PASS and existing Telegram callback/status behavior remains valid.

---

### Task 10: Integrated acceptance, documentation, and release gate

**Files:**
- Create: `tests/capability-pipeline-end-to-end.test.ts`
- Modify: `tests/evidence-gates.test.ts`
- Modify: `tests/end-to-end.test.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/configuration.md`
- Modify: `docs/operations.md`
- Modify: `docs/live-acceptance.md`
- Modify: `docs/designs/agent-experience-autonomy.md`
- Modify: `docs/designs/hanoon-agent-operating-system.md`

**Interfaces:**
- Consumes: all prior production interfaces.
- Produces: one fake-host end-to-end proof for every recipe, restart, recovery, receipt, denial, kill switch, and privacy boundary.

- [x] **Step 1: Write failing integrated scenarios**

Use real migrated SQLite and the fake BB host. Cover six recipes, one induced recoverable provider failure each, controller bundle expansion/relaunch, model escalation, mandatory guard remediation and recurrence block, active-job restart, external inventory denial, legacy rollback, stale approval rejection, and duplicate-effect count zero.

Each scenario asserts outcome state and durable evidence independently. It never marks success from worker prose.

- [x] **Step 2: Verify RED**

Run `npx vitest run tests/capability-pipeline-end-to-end.test.ts`.

Expected: at least one scenario fails until all integration wiring and evidence ordering are complete.

- [x] **Step 3: Complete the four integration seams**

Wire the already-defined interfaces at exactly four seams: controller job creation persists the routing snapshot and initial profile; worker spawn reads that exact profile and model tuple; strict worker/review completion persists mandatory outcomes before transition; Telegram/CLI reads only bounded repository projections. If an integrated assertion still fails, add one focused failing regression test beside the owning module before changing production code. Keep legacy fixtures working and avoid unrelated refactors.

- [x] **Step 4: Update operator documentation**

Document current, implemented behavior only: routing modes, recipes, model-pool configuration, bundle expansion, receipt inspection, promotion evidence, rollback, failure meanings, privacy, and the live acceptance procedure. Link to the approved specification and ADRs instead of restating their rationale.

- [x] **Step 5: Run reactive guards**

Apply `clean-code-guard` to changed production code, `test-guard` to changed tests, and `docs-guard` to changed technical documentation. Fix every must-fix finding and record advisory findings without creating extra process artifacts.

- [x] **Step 6: Run the full release gate**

Run:

```bash
npm run skills:verify
npm run check
git diff --check
```

Expected: 23 bundled skills verified, zero test failures, typecheck success, build success, and no whitespace errors.

- [x] **Step 7: Reconcile against the specification**

Read `docs/designs/adaptive-capability-pipeline.md` section by section. For every acceptance bullet, identify its production path and passing test. Report any live-only promotion evidence separately as `incomplete`; never enable a recipe in production without that evidence.

Reconciliation result: deterministic implementation and fake-host acceptance are complete. Disposable live-run promotion evidence is `incomplete`; production exposes no evidence-ingestion or collector API, defaults new recipes to shadow, and enables no recipe without authoritative live evidence.
