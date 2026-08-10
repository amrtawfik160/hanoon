# Telegram BB Valor Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the paired Telegram bot a realtime Luna Max BB operator and extend guarded jobs through independent planning, critique, implementation, testing, review, documentation, merge, production deployment, and canary verification.

**Architecture:** Telegram remains a pure durable I/O bridge and the leased executor remains the sole execution engine. SQLite stores replaceable controller generations, event cursors, confirmed BB operations, canonical pipeline stages, exact-SHA receipts, and production outcomes; BB threads isolate provider conversations while one managed worktree isolates each job's files.

**Tech Stack:** TypeScript, BB plugin SDK 0.4.1, BB threads/events/environments/terminals, better-sqlite3, Telegram Bot API long polling/message editing, Zod, Vitest.

## Global Constraints

- Controller execution is exactly `codex/gpt-5.6-luna`, reasoning `max`, service tier `fast`, permission mode `auto`.
- The Telegram polling service may only authenticate, deduplicate, persist, acknowledge, deliver outbox entries, and nudge the executor.
- Only the fenced leased executor may spawn/send/stop BB work, run commands, merge, deploy, or verify production.
- Worktrees remain the branch/checkout/filesystem isolation boundary; fresh BB threads provide provider-conversation isolation.
- Read the PR head with `git ls-remote --exit-code origin refs/pull/<N>/head`; GitHub API head values are never authoritative.
- Never expose reasoning deltas, raw tool arguments, command output, tokens, secrets, absolute paths, or unbounded thread output to Telegram.
- Existing-thread mutations and merge/deploy require owner-bound, action-bound, target-bound, expiring, one-use Telegram confirmations.
- Do not fabricate ETA. Report `unavailable` unless historical Telegram-job evidence supports a bounded estimate.
- Critique loops are capped at 2; patch/test/review loops are capped at 3.
- Every GitHub merge is preceded by a fresh Luna Max docs thread instructed to use Docs Guard and BB CLI skills.
- A successful merge is followed by configured production deployment and canary verification; Convex deployment uses the Convex CLI.

---

### Task 1: Recoverable fast Luna controller generations

**Files:**
- Modify: `src/controller/bb-controller.ts`
- Modify: `src/controller/service.ts`
- Modify: `src/controller/models.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `src/storage/store.ts`
- Test: `tests/controller-service.test.ts`
- Test: `tests/controller-store.test.ts`

**Interfaces:**
- Produces: `ControllerEventObservation`, `ControllerAdapter.events(threadId, afterSeq, signal)`, `TelegramAgentStore.retireControllerGeneration(...)`, and safe one-attempt redispatch when no input acceptance exists.
- Consumes: existing executor lease fences and controller turn FIFO states.

- [ ] **Step 1: Write failing adapter tests for explicit fast service tier and event reads**

```ts
it("uses Luna Max fast tier on spawn and every later turn", async () => {
  const fixture = controllerAdapterFixture();
  await fixture.adapter.spawn(turnRecord(), controllerRecord(), AbortSignal.timeout(1_000));
  await fixture.adapter.send("thr_controller", "status", AbortSignal.timeout(1_000));
  expect(fixture.spawn.mock.calls[0]?.[0]).toMatchObject({
    model: "gpt-5.6-luna",
    reasoningLevel: "max",
    serviceTier: "fast",
    permissionMode: "auto",
  });
  expect(fixture.send.mock.calls[0]?.[0]).toMatchObject({
    model: "gpt-5.6-luna",
    reasoningLevel: "max",
    serviceTier: "fast",
    permissionMode: "auto",
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/controller-service.test.ts`

Expected: FAIL because spawn/send omit `serviceTier: "fast"` and send-time explicit settings.

- [ ] **Step 3: Add the adapter event boundary and explicit execution tuple**

```ts
export type ControllerEventObservation = {
  latestSeq: number;
  inputAccepted: boolean;
  assistantDelta: string;
  completed: boolean;
  error: string | null;
};
```

`events()` must page `sdk.threads.events.list` from the durable cursor and reduce only safe event types. `item/reasoning/*` is ignored.

- [ ] **Step 4: Add failing service tests for the poisoned-controller regression**

```ts
it("retires an errored generation and lets the next queued turn create a fresh controller", async () => {
  const fixture = submittedControllerFixture({ status: "error", inputAccepted: false });
  await fixture.service.reconcile(fixture.fence, AbortSignal.timeout(1_000));
  expect(fixture.store.getControllerForOwner("7", "7")?.threadId).toBeNull();
  expect(fixture.store.listControllerTurns(fixture.controllerKey, 10)[0]?.state).toBe("queued");
});
```

- [ ] **Step 5: Run the service/store tests and verify RED**

Run: `npm test -- tests/controller-service.test.ts tests/controller-store.test.ts`

Expected: FAIL because an error only fails the turn and preserves the poisoned mapping.

- [ ] **Step 6: Append migration fields and implement acceptance-aware recovery**

Append columns for dispatch baseline sequence, retry count, provider generation, last observed sequence/time, accepted time, and first-output time. If failure occurs before `turn/input/accepted`, retire the generation and requeue once; otherwise fail closed, retire the generation only after settlement, and preserve later FIFO turns.

- [ ] **Step 7: Run focused tests and commit**

Run: `npm test -- tests/controller-service.test.ts tests/controller-store.test.ts`

Commit: `fix: recover failed Luna controller generations`

---

### Task 2: Durable same-message Telegram streaming

**Files:**
- Create: `src/controller/stream.ts`
- Modify: `src/controller/service.ts`
- Modify: `src/services/job-executor-service.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `src/storage/store.ts`
- Test: `tests/controller-stream.test.ts`
- Test: `tests/job-executor-service.test.ts`
- Test: `tests/plugin.test.ts`

**Interfaces:**
- Produces: `projectControllerStream(events, prior)`, controller placeholder outbox, durable `telegramMessageId`, cursor/text/edit hash, and final edit of the same Telegram message.
- Consumes: Task 1 event observations and the existing outbox lease/delivery path.

- [ ] **Step 1: Write projector tests that catch leaked reasoning and duplicate deltas**

```ts
it("projects only assistant deltas after the durable cursor", () => {
  const projected = projectControllerStream([
    event(11, "item/reasoning/textDelta", { delta: "private" }),
    event(12, "item/agentMessage/delta", { delta: "Hello" }),
    event(13, "item/agentMessage/delta", { delta: " world" }),
  ], { cursor: 10, text: "", phase: "thinking" });
  expect(projected).toMatchObject({ cursor: 13, text: "Hello world" });
  expect(projected.text).not.toContain("private");
});
```

- [ ] **Step 2: Run projector test and verify RED**

Run: `npm test -- tests/controller-stream.test.ts`

Expected: FAIL because `src/controller/stream.ts` does not exist.

- [ ] **Step 3: Implement the pure bounded projector**

The projector caps Telegram text at 3,900 Unicode characters, maps safe phases (`connecting`, `thinking`, `using_tools`, `responding`, `complete`, `failed`), and produces a stable SHA-256 edit hash.

- [ ] **Step 4: Write failing executor integration for placeholder, edit, restart, and final reuse**

```ts
it("sends one controller placeholder then edits that message through delta and completion", async () => {
  const fixture = realtimeControllerExecutorFixture();
  await fixture.runUntilIdle();
  expect(fixture.telegram.sendMessage).toHaveBeenCalledTimes(1);
  expect(fixture.telegram.editMessage).toHaveBeenCalledWith("7", 501, { text: "Hello" });
  expect(fixture.telegram.editMessage).toHaveBeenLastCalledWith("7", 501, { text: "Hello from Luna." });
});
```

- [ ] **Step 5: Run integration tests and verify RED**

Run: `npm test -- tests/job-executor-service.test.ts tests/plugin.test.ts`

Expected: FAIL because controller responses create only a final outbox send.

- [ ] **Step 6: Add stream persistence and outbox edit semantics**

Create the placeholder with a stable logical key, atomically retain the returned message id, update the same logical outbox row without clearing its known id, rate-limit edits to one per second, and make final completion reuse that id. A plugin restart resumes from cursor/text/id without a duplicate send.

- [ ] **Step 7: Run focused tests and commit**

Run: `npm test -- tests/controller-stream.test.ts tests/job-executor-service.test.ts tests/plugin.test.ts`

Commit: `feat: stream Luna replies into Telegram`

---

### Task 3: Truthful BB-wide thread observability

**Files:**
- Create: `src/controller/thread-observer.ts`
- Modify: `src/controller/tools.ts`
- Modify: `src/plugin.ts`
- Test: `tests/thread-observer.test.ts`
- Test: `tests/controller-tools.test.ts`

**Interfaces:**
- Produces: `BbThreadProjection`, `listVisibleThreads(input, signal)`, `getVisibleThreadStatus(threadId, signal)`, `telegram_agent_list_threads`, and `telegram_agent_thread_status`.
- Consumes: `sdk.projects.list`, `sdk.threads.list/get/output/interactions.list/childSummary`, and environment/PR metadata already present on BB thread responses.

- [ ] **Step 1: Write failing projection tests with active, stopping, hidden, and stale fixtures**

```ts
it("lists visible active threads with elapsed and last activity but no invented ETA", async () => {
  const rows = await fixture.observer.list({ statuses: ["active", "stopping"], limit: 20 }, fixture.signal);
  expect(rows[0]).toMatchObject({
    id: "thr_cyndra",
    project: "cyndra-saas",
    status: "active",
    eta: "unavailable",
  });
  expect(rows.some((row) => row.id === "thr_hidden")).toBe(false);
});
```

- [ ] **Step 2: Run the observer test and verify RED**

Run: `npm test -- tests/thread-observer.test.ts`

Expected: FAIL because the observer module does not exist.

- [ ] **Step 3: Implement bounded read-only observation**

List at most 100 non-archived, non-hidden threads; join project names; use BB timestamps/status as truth; fetch bounded output/interactions/child summary only for exact status requests; normalize output to 1,200 characters; return no filesystem paths or hidden controller rows.

- [ ] **Step 4: Add tool-registration tests and implementation**

Update `CONTROLLER_TOOL_NAMES` to include the two read tools and provide concise experimental status labels. Tool results remain under 8 KiB.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm test -- tests/thread-observer.test.ts tests/controller-tools.test.ts`

Commit: `feat: expose BB thread progress to Luna`

---

### Task 4: Confirmed existing-thread controls

**Files:**
- Create: `src/controller/operations.ts`
- Modify: `src/controller/tools.ts`
- Modify: `src/services/job-executor-service.ts`
- Modify: `src/telegram/view.ts`
- Modify: `src/telegram/ingress.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `src/storage/store.ts`
- Test: `tests/controller-operations.test.ts`
- Test: `tests/telegram-ingress.test.ts`

**Interfaces:**
- Produces: durable operation kinds `steer_thread`, `stop_thread`, `retry_thread`; opaque confirmation callback `o:<nonce>`; executor application via `sdk.threads.send/stop` and eligible retry.
- Consumes: paired owner identity, exact visible thread projection, existing callback deduplication, and executor lease fencing.

- [ ] **Step 1: Write failing one-use confirmation tests**

```ts
it("applies one confirmed steer to the exact thread and rejects replay", async () => {
  const issued = fixture.store.issueThreadOperation({
    ownerUserId: "7", ownerChatId: "7", kind: "steer_thread",
    threadId: "thr_target", text: "Focus on the failing test", now: 1_000,
  });
  expect(fixture.store.confirmThreadOperation(issued.nonce, "7", "7", 1_100)).toMatchObject({ ok: true });
  expect(fixture.store.confirmThreadOperation(issued.nonce, "7", "7", 1_101)).toMatchObject({ ok: false });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/controller-operations.test.ts tests/telegram-ingress.test.ts`

Expected: FAIL because generic BB operation confirmations do not exist.

- [ ] **Step 3: Append operation tables and implement token binding**

Persist only a nonce hash, operation kind, exact target, bounded text, owner/chat identity, expiry, state, executor fence, and sanitized result. Telegram callback data contains no thread id or text.

- [ ] **Step 4: Implement executor application and revalidation**

At execution, refetch the exact thread, reject hidden/deleted/archived/controller targets, verify legal status, then perform one SDK action. Uncertain outcomes fail closed and stay inspectable.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm test -- tests/controller-operations.test.ts tests/telegram-ingress.test.ts tests/job-executor-service.test.ts`

Commit: `feat: add confirmed BB thread controls`

---

### Task 5: Canonical PLAN/CRITIQUE/BUILD graph and artifact handoff

**Files:**
- Create: `src/domain/pipeline-graph.ts`
- Create: `src/bb/pipeline-handoffs.ts`
- Create: `src/services/pipeline-stage-runner.ts`
- Modify: `src/domain/models.ts`
- Modify: `src/domain/state-machine.ts`
- Modify: `src/bb/runner.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `src/storage/store.ts`
- Test: `tests/pipeline-graph.test.ts`
- Test: `tests/pipeline-stage-runner.test.ts`
- Test: `tests/handoffs.test.ts`

**Interfaces:**
- Produces: `PipelineStage`, `PipelineOutcome`, `nextPipelineStage`, durable `pipeline_stage_attempts`, `buildPlanPacket`, `buildCritiquePacket`, `spawnPlanner`, `spawnCritic`, and `spawnBuilderFromPlan`.
- Consumes: existing attachment upload, project policy execution profiles, managed worktree creation, and worker liveness.

- [ ] **Step 1: Write table-driven failing graph tests**

```ts
it.each([
  ["PLAN", "success", 0, 0, "CRITIQUE"],
  ["CRITIQUE", "needs_revision", 0, 1, "PLAN"],
  ["CRITIQUE", "needs_revision", 0, 2, "BLOCKED"],
  ["TEST", "fail", 1, 0, "PATCH"],
  ["REVIEW", "changes_requested", 2, 0, "PATCH"],
  ["PATCH", "success", 2, 0, "TEST"],
])("routes %s/%s", (stage, outcome, patchCycles, critiqueCycles, expected) => {
  expect(nextPipelineStage({ stage, outcome, patchCycles, critiqueCycles })).toBe(expected);
});
```

- [ ] **Step 2: Run graph tests and verify RED**

Run: `npm test -- tests/pipeline-graph.test.ts`

Expected: FAIL because the graph module does not exist.

- [ ] **Step 3: Implement the pure canonical graph**

Unknown stage/outcome returns `BLOCKED`; no success fallback is permitted. `PATCH` remains visible because Telegram must explain correction loops.

- [ ] **Step 4: Write failing stage-runner and artifact tests**

Assert that planner and critic are fresh spawns in the same environment, critic has no source thread/provider fork, plan bytes become a hashed `plan.md` attachment, and builder's prompt only instructs it to read the two attachments.

- [ ] **Step 5: Run stage tests and verify RED**

Run: `npm test -- tests/pipeline-stage-runner.test.ts tests/handoffs.test.ts`

Expected: FAIL because jobs jump directly to implementation.

- [ ] **Step 6: Append stage-attempt storage and route new jobs through PLAN/CRITIQUE**

Every attempt is generation fenced and stores role, ordinal, environment/thread/terminal ids, input hashes, start/end SHA, outcome JSON, and timestamps. Critique failure resumes the planner with the bounded critique artifact; success spawns a separate builder with attachment-only handoff.

- [ ] **Step 7: Run focused tests and commit**

Run: `npm test -- tests/pipeline-graph.test.ts tests/pipeline-stage-runner.test.ts tests/handoffs.test.ts tests/state-machine.test.ts`

Commit: `feat: add planned guarded job pipeline`

---

### Task 6: Independent test/review/patch/docs final verification

**Files:**
- Modify: `src/domain/pipeline-graph.ts`
- Modify: `src/services/pipeline-stage-runner.ts`
- Modify: `src/services/review-handler.ts`
- Modify: `src/bb/runner.ts`
- Modify: `src/bb/handoffs.ts`
- Modify: `src/bb/validation.ts`
- Test: `tests/pipeline-stage-runner.test.ts`
- Test: `tests/review-loop.test.ts`
- Test: `tests/validation.test.ts`

**Interfaces:**
- Produces: deterministic TEST receipts, fresh REVIEW attempts, PATCH builder resume, Luna Max DOCS attempt, `FINAL_TEST`, and fresh `FINAL_REVIEW` bound to the post-docs head.
- Consumes: Task 5 stage attempts, existing review JSON contract, terminal runner, and Git-native head resolver.

- [ ] **Step 1: Write failing mutation and freshness tests**

Assert that reviewer filesystem mutation blocks the attempt, review findings route through PATCH then TEST, each re-review has a new thread id, docs are Luna Max/fast/auto in the same environment, and a docs head change invalidates all prior review/validation receipts.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/pipeline-stage-runner.test.ts tests/review-loop.test.ts tests/validation.test.ts`

Expected: FAIL because review currently precedes one validation and jobs have no docs/final-review stages.

- [ ] **Step 3: Implement deterministic TEST and bounded PATCH cycles**

Run configured validation commands in terminals, persist redacted receipts, steer the builder with a bounded attachment, and enforce the three-cycle cap before another effect is emitted.

- [ ] **Step 4: Implement docs and final exact-SHA verification**

Spawn a fresh docs thread with exact Luna settings and instructions to use Docs Guard and BB CLI skills. Resolve the new PR SHA with Git, rerun deterministic tests, then spawn a fresh final reviewer at that SHA. No earlier verdict survives a head change.

- [ ] **Step 5: Run focused tests and commit**

Run: `npm test -- tests/pipeline-stage-runner.test.ts tests/review-loop.test.ts tests/validation.test.ts tests/bb-runner.test.ts`

Commit: `feat: gate jobs on docs and final review`

---

### Task 7: Merge, mandatory production deploy, canary, and live rollout

**Files:**
- Create: `src/services/production-runner.ts`
- Modify: `src/domain/models.ts`
- Modify: `src/domain/state-machine.ts`
- Modify: `src/services/merge-handler.ts`
- Modify: `src/services/effect-runner.ts`
- Modify: `src/telegram/view.ts`
- Modify: `src/cli.ts`
- Test: `tests/production-runner.test.ts`
- Test: `tests/merge.test.ts`
- Test: `tests/end-to-end.test.ts`
- Modify: `docs/acceptance-test.md`

**Interfaces:**
- Produces: required `ProjectPolicy.production`, effects `deploy_production` and `verify_production`, separate merge/deploy/canary receipts, and Telegram `Merge + deploy <sha>` approval copy.
- Consumes: exact final-review SHA, existing approval nonce fencing, terminal command runner, output redaction, and BB PR merge SDK.

- [ ] **Step 1: Write failing policy and state-machine tests**

```ts
it("does not issue merge approval without deploy and canary commands", () => {
  const job = finalReviewPassedJob({ production: undefined });
  const result = transition(job, { type: "FINAL_REVIEW_PASSED", headSha: HEAD }, NOW);
  expect(result.job).toMatchObject({ state: "blocked", blockedReason: "configuration" });
  expect(result.effects.some((effect) => effect.kind === "issue_approval")).toBe(false);
});
```

- [ ] **Step 2: Run production/merge tests and verify RED**

Run: `npm test -- tests/production-runner.test.ts tests/merge.test.ts tests/state-machine.test.ts`

Expected: FAIL because merge is terminal and policy has no production contract.

- [ ] **Step 3: Add production policy and post-merge effects**

`MERGE_SUCCEEDED` transitions to `deploying`; successful deploy transitions to `verifying_production`; only canary success transitions to `complete`. Store merged SHA, deployment receipts, and canary receipts separately. Validate Convex policies by requiring a command whose executable arguments invoke `convex deploy`.

- [ ] **Step 4: Add production incident behavior**

Deployment/canary failure after merge enters `production_failed`, preserves the successful merge fact, sends an immediate incident message with redacted receipts and configured manual rollback command, and never runs rollback automatically.

- [ ] **Step 5: Update CLI policy configuration and end-to-end tests**

The CLI accepts repeated deploy/canary command triples and a rollback command. The end-to-end fixture proves one exact-SHA approval, one merge SDK call, ordered deploy commands, ordered canary commands, and distinct Telegram outcome text.

- [ ] **Step 6: Run the complete local gate**

Run: `npm run typecheck`

Run: `npm test`

Run: `npm run build`

Run: `bb plugin types --check .`

Run: `git diff --check`

Expected: every command exits 0 and Vitest reports zero failing tests.

- [ ] **Step 7: Reload and perform live Telegram acceptance**

Run: `bb plugin reload telegram-agent`

Run: `bb plugin list --json`

From the paired chat, verify the immediate placeholder, same-message delta edit, poisoned-controller replacement, `/threads`-equivalent natural-language status, and one disposable full job through production verification. Record exact thread ids, stage receipts, PR SHA, merge result, deploy result, and canary result in `docs/acceptance-test.md`.

- [ ] **Step 8: Commit**

Commit: `feat: complete Telegram production pipeline`

---

## Self-review record

- Spec coverage: every design section maps to Tasks 1-7; realtime/recovery precede pipeline expansion so each commit is independently useful.
- Placeholder scan: every implementation step names its concrete behavior and neighboring interface.
- Type consistency: controller events flow Task 1 to Task 2; observer/control types remain separate from guarded jobs; pipeline stages flow Tasks 5-7; exact SHA remains a full lowercase 40-character value at every gate.
