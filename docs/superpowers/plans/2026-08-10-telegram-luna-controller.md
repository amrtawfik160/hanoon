# Telegram Luna Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the paired Telegram bot a durable conversational Codex `gpt-5.6-luna` controller at `max` reasoning that can start and monitor the existing guarded BB implementation/review/merge workflow.

**Architecture:** Telegram ingress remains pure I/O and persists standalone owner text as FIFO controller turns. The existing singleton leased executor creates or sends the hidden personal-workspace Luna thread, reconciles its output into the Telegram outbox, and continues to own every implementation/review/validation/merge effect. Schema-validated native tools commit job intent to SQLite; they never spawn worktrees or merge directly.

**Tech Stack:** TypeScript, BB Plugin SDK `^0.4.1`, BB `>=0.36`, Zod 4, better-sqlite3, Vitest, Telegram Bot API.

## Global Constraints

- Preserve every existing uncommitted change and establish a verified checkpoint before overlapping edits.
- Follow RED→GREEN TDD for every production behavior change.
- Use append-only SQLite migrations; do not edit or reorder shipped migration statements.
- Use exactly one leased execution engine. Telegram ingress and BB event listeners may persist/nudge only.
- The controller execution tuple is exactly `codex` / `gpt-5.6-luna` / `max` / `auto`, with explicit input-source metadata.
- Controller threads are hidden and use an explicitly host-routed personal workspace; implementation/review threads keep their existing visibility and worktree contracts.
- Review uses a fresh `threads.spawn` child in the implementation environment, never a provider-session fork.
- Worktrees remain the code/filesystem isolation boundary; threads remain the provider-conversation and lifecycle boundary.
- Merge remains guarded by fresh deterministic validation, two matching `git ls-remote --exit-code origin refs/pull/<number>/head` reads, and one expiring Telegram approval.
- Do not expose bot tokens, raw Telegram request bodies, credentials, filesystem paths, unbounded logs, or raw provider prompts in storage errors or Telegram replies.
- Commands, callbacks, and reply-to-status steering remain deterministic recovery/control paths. Standalone authorized text becomes Luna conversation.
- Execution mode is inline because the current BB environment has one active agent slot.

---

### Task 0: Verify and checkpoint the existing acceptance work

**Files:**
- Existing modified: `src/bb/terminal-command.ts`
- Existing modified: `src/domain/state-machine.ts`
- Existing modified: `src/services/effect-runner.ts`
- Existing modified: `src/storage/store.ts`
- Existing modified: `tests/doctor.test.ts`
- Existing modified: `tests/plugin.test.ts`
- Existing modified: `tests/terminal-command.test.ts`
- Existing untracked: `README.md`
- Existing untracked: `docs/acceptance-test.md`
- Existing untracked: `tests/end-to-end.test.ts`

**Interfaces:**
- Consumes: the current dirty worktree exactly as left by the prior live-acceptance repair.
- Produces: one verified baseline commit, without changing the content of the existing files during this task.

- [ ] **Step 1: Inspect the exact baseline scope**

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected: only the ten paths listed above are dirty before this plan file; no whitespace errors.

- [ ] **Step 2: Run the existing focused regressions**

Run:

```bash
npx vitest run tests/terminal-command.test.ts tests/doctor.test.ts tests/plugin.test.ts tests/end-to-end.test.ts
```

Expected: exit 0 with no failed tests.

- [ ] **Step 3: Run the existing full gate**

Run:

```bash
npm run check
bb plugin types --check
```

Expected: typecheck, all Vitest files, plugin build, and SDK type freshness exit 0.

- [ ] **Step 4: Commit only the verified baseline files**

```bash
git add src/bb/terminal-command.ts src/domain/state-machine.ts src/services/effect-runner.ts src/storage/store.ts tests/doctor.test.ts tests/plugin.test.ts tests/terminal-command.test.ts README.md docs/acceptance-test.md tests/end-to-end.test.ts
git commit -m "fix: complete Telegram plugin live acceptance plumbing"
```

### Task 1: Route implementation worktrees to the project's real host

**Files:**
- Modify: `src/bb/runner.ts`
- Modify: `tests/bb-runner.test.ts`

**Interfaces:**
- Consumes: `BbPluginApi["sdk"].projects.list()` project source data and the existing `BbRunner.spawnImplementation(job, attempt)` contract.
- Produces: `BbRunner.resolveProjectHost(projectId): Promise<string>` and a spawn request whose managed-worktree environment includes the selected source's exact `hostId`.

- [ ] **Step 1: Write the failing host-routing tests**

Add a project stub and assertions shaped like:

```ts
it("spawns the implementation worktree on the live default project source host", async () => {
  const { calls, runner } = runnerFixture({
    project: { id: "proj_1", kind: "standard", sources: [
      { id: "src_1", type: "local_path", hostId: "host_real", path: "/repo", isDefault: true },
    ] },
  });

  await runner.spawnImplementation(selectedJob, attempt("attempt_impl_host"));

  expect(calls.spawns[0]).toMatchObject({
    environment: {
      type: "host",
      hostId: "host_real",
      workspace: { type: "managed-worktree" },
    },
  });
});

it.each([
  ["missing project", null],
  ["personal project", { id: "proj_1", kind: "personal", sources: [] }],
  ["missing source host", {
    id: "proj_1",
    kind: "standard",
    sources: [{ id: "src_1", type: "local_path", hostId: "", path: "/repo", isDefault: true }],
  }],
])("fails closed before attachment upload when project routing is %s", async (_label, project) => {
  const { calls, runner } = runnerFixture({ project });
  await expect(runner.spawnImplementation(selectedJob, attempt("attempt_invalid_host")))
    .rejects.toThrow(/project|source|host/i);
  expect(calls.attachments).toHaveLength(0);
  expect(calls.spawns).toHaveLength(0);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run tests/bb-runner.test.ts
```

Expected: the valid case fails because `hostId` is absent; invalid cases fail because current code uploads/spawns without resolving a source.

- [ ] **Step 3: Implement minimal live project-source resolution**

Add a private resolver that reads the selected standard project, chooses its explicit default source (or the single source), validates a non-empty `hostId`, and throws a bounded configuration error before upload. Pass the result as:

```ts
environment: {
  type: "host",
  hostId,
  workspace: {
    type: "managed-worktree",
    baseBranch: { kind: "named", name: policy.baseBranch },
  },
}
```

- [ ] **Step 4: Verify GREEN and commit**

```bash
npx vitest run tests/bb-runner.test.ts tests/effect-runner.test.ts
git add src/bb/runner.ts tests/bb-runner.test.ts
git commit -m "fix: route Telegram worktrees to project host"
```

### Task 2: Preserve and classify Telegram API failures

**Files:**
- Modify: `src/telegram/client.ts`
- Create: `src/telegram/errors.ts`
- Modify: `src/telegram/ingress.ts`
- Modify: `src/services/job-executor-service.ts`
- Modify: `src/storage/store.ts`
- Modify: `tests/telegram-client.test.ts`
- Modify: `tests/telegram-ingress.test.ts`
- Modify: `tests/job-executor-service.test.ts`
- Modify: `tests/storage.test.ts`

**Interfaces:**
- Produces: `TelegramApiError` fields `httpStatus`, `errorCode`, `description`, and `retryAfterSeconds`.
- Produces: `classifyTelegramError(error): "not_modified" | "expired_callback" | "edit_unavailable" | "bad_entities" | "authentication" | "retryable" | "permanent"`.
- Produces: `TelegramAgentStore.replaceStatusOutboxMessage(...)` for atomically completing an edit fallback and replacing the job status-message id.

- [ ] **Step 1: Write failing client classification tests**

```ts
it("preserves a sanitized Telegram description and retry metadata", async () => {
  const error = await new TelegramClient("123:secret", telegramFetch([
    { ok: false, error_code: 400, description: "Bad Request: query is too old" },
  ])).answerCallback("cb", "Done").catch((value) => value);

  expect(error).toMatchObject({
    name: "TelegramApiError",
    errorCode: 400,
    description: "Bad Request: query is too old",
  });
  expect(String(error)).not.toContain("123:secret");
});
```

Add table tests for exact not-modified, expired callback, uneditable/missing message, malformed entities, 401, 429/5xx, and other permanent 400 responses.

- [ ] **Step 2: Write failing outbox recovery tests**

Test these observable outcomes:

```ts
// expired callback: answer once, mark sent, do not crash/retry
// uneditable status: edit fails, send succeeds, job.statusMessageId becomes new id atomically
// bad entities: retry once without parse_mode
// permanent 400: dead-letter immediately with sanitized description
```

Add an ingress regression where `deliverJobView` has already enqueued the durable status intent and its eager `editMessage` call throws a typed Telegram 400. `handleClaimed` must resolve, the update must not be replayed, and the pending outbox row must remain for the executor's classified delivery path.

- [ ] **Step 3: Verify RED**

Run:

```bash
npx vitest run tests/telegram-client.test.ts tests/telegram-ingress.test.ts tests/job-executor-service.test.ts tests/storage.test.ts
```

Expected: failures show missing error fields/classifier and missing edit-fallback transaction.

- [ ] **Step 4: Implement minimal error model and delivery policy**

`TelegramApiError` must construct a safe message from the code and sanitized description, never the token or request body. The executor handles classifications in this order:

```ts
if (kind === "expired_callback") completeOutbox(...);
else if (kind === "edit_unavailable" && jobId) sendReplacementAndReplaceStatus(...);
else if (kind === "bad_entities") retrySameOperationWithoutParseModeOnce(...);
else if (kind === "authentication" || kind === "permanent") deadLetterOutbox(...);
else failOutboxWithBackoff(...);
```

Remove the duplicate `completeOutbox` call in the existing success branch while editing this block.

In `TelegramIngress.deliverJobView`, catch only typed Telegram transport/API failures after the matching durable outbox intent exists. Leave that outbox pending and return the durable job snapshot. Continue throwing validation, authorization, version, and storage errors so programmer/state failures remain visible.

- [ ] **Step 5: Verify GREEN and commit**

```bash
npx vitest run tests/telegram-client.test.ts tests/telegram-ingress.test.ts tests/job-executor-service.test.ts tests/storage.test.ts tests/telegram-service.test.ts
git add src/telegram/client.ts src/telegram/errors.ts src/telegram/ingress.ts src/services/job-executor-service.ts src/storage/store.ts tests/telegram-client.test.ts tests/telegram-ingress.test.ts tests/job-executor-service.test.ts tests/storage.test.ts
git commit -m "fix: recover safely from Telegram API failures"
```

### Task 3: Add durable controller threads and FIFO turns

**Files:**
- Modify: `src/storage/migrations.ts`
- Create: `src/controller/models.ts`
- Modify: `src/storage/store.ts`
- Modify: `tests/storage.test.ts`
- Create: `tests/controller-store.test.ts`

**Interfaces:**
- Produces: `ControllerThreadRecord` with `controllerKey`, Telegram identities, BB project/host/thread ids, lifecycle state, pending spawn token, error, and timestamps.
- Produces: `ControllerTurnRecord` with update id, FIFO ordinal, text, state, lease fence, response/error, and timestamps.
- Produces store methods: `enqueueControllerTurn`, `getControllerByThreadId`, `getControllerForOwner`, `claimNextControllerTurn`, `markControllerSpawned`, `markControllerTurnSubmitted`, `completeControllerTurn`, `failControllerTurn`, and `listControllerTurns`.

- [ ] **Step 1: Write migration and store RED tests**

Tests must prove:

```ts
expect(ALL_MIGRATIONS.length).toBe(previousCount + 1);
expect(store.enqueueControllerTurn(input)).toMatchObject({ state: "queued" });
expect(store.enqueueControllerTurn(input)).toEqual(first); // same update is idempotent
expect(store.claimNextControllerTurn(fence)).toMatchObject({ ordinal: 1 });
expect(store.claimNextControllerTurn(fence)).toBeNull(); // one submitted/dispatching turn fences FIFO
```

Also assert replay with different text is an idempotency conflict, stale lease generations cannot mutate a turn, raw token-shaped error text is rejected/redacted, and controller lookup never returns a revoked owner mapping.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run tests/controller-store.test.ts tests/storage.test.ts
```

Expected: missing tables/types/methods.

- [ ] **Step 3: Append one migration and implement transactional methods**

Append a single migration that creates `controller_threads` and `controller_turns`, including unique constraints on controller key, BB thread id, Telegram update id, and `(controller_key, ordinal)`. Use checked states:

```sql
CHECK (state IN ('queued', 'dispatching', 'submitted', 'completed', 'failed'))
```

Every claim/mutation includes the executor owner and generation and verifies the current executor lease in the same immediate transaction.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npx vitest run tests/controller-store.test.ts tests/storage.test.ts tests/job-store.test.ts
git add src/storage/migrations.ts src/controller/models.ts src/storage/store.ts tests/storage.test.ts tests/controller-store.test.ts
git commit -m "feat: persist durable Telegram controller turns"
```

### Task 4: Create and reconcile the Luna Max BB controller

**Files:**
- Create: `src/controller/instructions.ts`
- Create: `src/controller/bb-controller.ts`
- Create: `src/controller/service.ts`
- Create: `src/services/executor-nudge.ts`
- Modify: `src/services/job-executor-service.ts`
- Create: `tests/controller-service.test.ts`
- Create: `tests/executor-nudge.test.ts`
- Modify: `tests/job-executor-service.test.ts`

**Interfaces:**
- Produces: `CONTROLLER_PROVIDER = "codex"`, `CONTROLLER_MODEL = "gpt-5.6-luna"`, `CONTROLLER_REASONING = "max"`, `CONTROLLER_PERMISSION = "auto"`.
- Produces: `BbControllerAdapter.spawn(turn, owner)` / `send(threadId, text)` / `status(threadId)` / `output(threadId)` / `findSpawnCandidate(controllerKey)`.
- Produces: `LunaControllerService.processOne(fence, signal): Promise<boolean>` and `reconcile(fence, signal): Promise<boolean>`.
- Produces: `ExecutorNudge.notify(): void` and `ExecutorNudge.wait(milliseconds, signal): Promise<void>` so durable ingress/events wake the leased executor without starting work themselves.

- [ ] **Step 1: Write controller spawn RED tests**

Assert the exact SDK request:

```ts
expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
  projectId: "proj_personal",
  providerId: "codex",
  model: "gpt-5.6-luna",
  reasoningLevel: "max",
  permissionMode: "auto",
  visibility: "hidden",
  environment: {
    type: "host",
    hostId: "host_personal",
    workspace: { type: "personal" },
  },
  executionInputSources: {
    providerId: "explicit",
    model: "explicit",
    reasoningLevel: "explicit",
    permissionMode: "explicit",
  },
}));
```

Add failures for missing personal project, missing default source host, and multiple uncertain-spawn candidates. Add an `ExecutorNudge` test proving `notify()` resolves a pending `wait()` once and abort cleanup leaves no later resolution.

- [ ] **Step 2: Write FIFO/reconciliation RED tests**

Prove first spawn, idle send with `mode: "start"`, second message waiting while submitted, idle output becoming one Telegram outbox reply, failed thread becoming a bounded reply, missed idle event recovered by reconciliation, deleted controller creating a fresh mapping, and uncertain dispatch failing closed without a second `threads.send`.

- [ ] **Step 3: Verify RED**

```bash
npx vitest run tests/controller-service.test.ts tests/executor-nudge.test.ts tests/job-executor-service.test.ts
```

Expected: missing controller adapter/service and executor hook.

- [ ] **Step 4: Implement the minimal adapter and service**

The initial prompt contains the owner text plus controller instructions. Later turns use:

```ts
await sdk.threads.send({
  threadId,
  mode: "start",
  input: [{ type: "text", text: turn.inputText, mentions: [] }],
});
```

`processOne` runs only after the executor lease is current. `reconcile` reads BB thread state/output and commits reply outbox rows keyed as `controller:<turn-id>:reply`. It never calls implementation/job effects directly.

- [ ] **Step 5: Integrate one controller operation per executor loop**

Add optional dependencies to `JobExecutorDependencies`:

```ts
controller?: {
  processOne(fence: EffectFence, signal: AbortSignal): Promise<boolean>;
  reconcile(fence: EffectFence, signal: AbortSignal): Promise<boolean>;
};
waitForWork?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
```

Run reconciliation then one dispatch before job effects; include their boolean result in `didWork`. Replace only the executor loop's active/idle sleep call with `waitForWork ?? sleep`, leaving lease-acquisition retry behavior unchanged.

- [ ] **Step 6: Verify GREEN and commit**

```bash
npx vitest run tests/controller-service.test.ts tests/executor-nudge.test.ts tests/job-executor-service.test.ts
git add src/controller/instructions.ts src/controller/bb-controller.ts src/controller/service.ts src/services/executor-nudge.ts src/services/job-executor-service.ts tests/controller-service.test.ts tests/executor-nudge.test.ts tests/job-executor-service.test.ts
git commit -m "feat: run a durable Luna Max Telegram controller"
```

### Task 5: Register guarded controller tools and confirmed job intent

**Files:**
- Create: `src/controller/tools.ts`
- Modify: `src/storage/store.ts`
- Modify: `src/plugin.ts`
- Create: `tests/controller-tools.test.ts`
- Modify: `tests/plugin.test.ts`
- Modify: `tests/storage.test.ts`

**Interfaces:**
- Produces store method `createConfirmedControllerJob({ controllerThreadId, projectId, task, now }): Job`.
- Produces tool registrations `telegram_agent_list_projects`, `telegram_agent_start_job`, `telegram_agent_job_status`, `telegram_agent_retry_job`, and `telegram_agent_cancel_job`; each successful mutation calls the injected executor nudge.
- Produces agent configuration limited to plugin-origin hidden Codex personal-project threads; every tool execution reauthorizes the exact durable controller thread id.

- [ ] **Step 1: Write atomic confirmed-job RED tests**

```ts
const job = store.createConfirmedControllerJob({
  controllerThreadId: "thr_controller",
  projectId: "proj_1",
  task: "Fix the redirect and add a regression test",
  now: 10_000,
});

expect(job.state).toBe("creating_implementation");
expect(store.listEffectsForJob(job.id).map((effect) => effect.kind)).toEqual([
  "render_status",
  "spawn_implementation",
]);
```

Assert idempotency within one submitted controller turn, single-active-job conflict, disabled project rejection, unmapped thread rejection, and no partial job/effects after a transaction failure.

- [ ] **Step 2: Write agent-surface RED tests**

Using `@bb/plugin-sdk/testing`, assert all five tools register, resolve only for the exact origin/provider/project/visibility context, and reject execution from implementation/review or unrelated personal threads. Assert tool results are bounded JSON without paths or raw logs.

- [ ] **Step 3: Verify RED**

```bash
npx vitest run tests/controller-tools.test.ts tests/plugin.test.ts tests/storage.test.ts
```

Expected: missing store transaction and agent registrations.

- [ ] **Step 4: Implement the confirmed-job transaction**

Within one immediate SQLite transaction:

1. resolve the submitted controller turn and enabled immutable policy;
2. insert/idempotently resolve the job using the controller turn's Telegram update id;
3. run `PROJECT_SELECTED` through `transition` and persist its effects;
4. run `CONFIRMED` through `transition` and persist its effects;
5. return the final `creating_implementation` job.

- [ ] **Step 5: Implement tools and conditional configuration**

Register Zod schemas and return compact JSON strings/objects. Configuration must resemble:

```ts
bb.agents.configure((context) => {
  const candidate = context.origin.kind === "plugin" &&
    context.origin.pluginId === bb.pluginId &&
    context.provider.id === "codex" &&
    context.project.kind === "personal" &&
    context.thread.visibility === "hidden";
  return candidate
    ? { tools: CONTROLLER_TOOL_NAMES, instructions: CONTROLLER_INSTRUCTIONS }
    : { tools: [] };
});
```

The execution callback still calls `store.getControllerByThreadId(threadId)` and fails closed if absent/revoked.

- [ ] **Step 6: Verify GREEN and commit**

```bash
npx vitest run tests/controller-tools.test.ts tests/plugin.test.ts tests/storage.test.ts tests/state-machine.test.ts
git add src/controller/tools.ts src/storage/store.ts src/plugin.ts tests/controller-tools.test.ts tests/plugin.test.ts tests/storage.test.ts
git commit -m "feat: let Luna start guarded BB jobs"
```

### Task 6: Route standalone Telegram text through Luna

**Files:**
- Modify: `src/telegram/ingress.ts`
- Modify: `src/plugin.ts`
- Modify: `tests/telegram-ingress.test.ts`
- Modify: `tests/plugin.test.ts`
- Modify: `tests/end-to-end.test.ts`

**Interfaces:**
- Consumes: `TelegramAgentStore.enqueueControllerTurn` and the controller-enabled job executor.
- Produces: standalone paired-owner text enqueues one controller turn; commands, callbacks, pairing, and reply-to-status steering retain their existing deterministic behavior.

- [ ] **Step 1: Write ingress RED tests**

Assert:

```ts
await ingress.handleClaimed(privateMessageUpdate("What projects can you work on?"), now);
expect(store.listControllerTurns()).toMatchObject([
  { sourceUpdateId: updateId, state: "queued", inputText: "What projects can you work on?" },
]);
expect(store.getActiveJob()).toBeNull();
```

Add cases proving `/status`, `/cancel`, `/retry`, `/projects`, callbacks, pairing, unauthorized chats, and replies to the exact active status message do not become controller turns.

- [ ] **Step 2: Write plugin lifecycle RED tests**

Assert all six BB thread events only nudge/reconcile mapped controller or job threads and never call `threads.spawn` or `threads.send` from the event handler. Assert the job executor receives the controller dependency.

- [ ] **Step 3: Verify RED**

```bash
npx vitest run tests/telegram-ingress.test.ts tests/plugin.test.ts tests/end-to-end.test.ts
```

Expected: standalone text currently creates an awaiting-project job instead of a controller turn.

- [ ] **Step 4: Implement routing and plugin wiring**

Keep the branch order explicit:

```ts
pairing -> authorization -> command -> callback/status-reply control -> enqueueControllerTurn
```

Update `/help` and the pairing success copy to explain natural Luna conversation while retaining recovery commands. Inject `onWorkAvailable: () => executorNudge.notify()` into ingress, notify only after a controller turn is durably enqueued, and have mapped BB lifecycle events call the same nudge so executor reconciliation reads authoritative thread state. Wire `BbControllerAdapter`, `LunaControllerService`, agent tools/configuration, `ExecutorNudge`, and the executor dependency in `src/plugin.ts`.

- [ ] **Step 5: Verify GREEN and commit**

```bash
npx vitest run tests/telegram-ingress.test.ts tests/plugin.test.ts tests/end-to-end.test.ts tests/controller-service.test.ts tests/controller-tools.test.ts
git add src/telegram/ingress.ts src/plugin.ts tests/telegram-ingress.test.ts tests/plugin.test.ts tests/end-to-end.test.ts
git commit -m "feat: make Telegram messages conversational"
```

### Task 7: Documentation, guard review, full verification, and live activation

**Files:**
- Modify: `README.md`
- Modify: `docs/acceptance-test.md`

**Interfaces:**
- Produces: operator-facing setup and recovery instructions matching the implemented settings, commands, Luna execution tuple, thread/worktree isolation, and merge approval behavior.
- Produces: a freshly built and reloaded installed plugin with live diagnostic evidence.

- [ ] **Step 1: Update documentation from implemented behavior**

Document:

- standalone messages go to a hidden Luna Max controller;
- commands and reply-to-status steering remain deterministic;
- background implementation/review models come from project policy;
- review threads have fresh provider context but share the implementation worktree;
- the exact doctor/activation commands and Telegram error recovery behavior.

- [ ] **Step 2: Run Test Guard, Clean Code Guard, and Docs Guard self-checks**

Inspect every changed test for behavior-level assertions, every changed production unit for bounded responsibility and duplicate logic, and every documented SDK/CLI/config claim against `types/bb-plugin-sdk.d.ts`, `package.json`, and registered commands/settings. Apply findings before proceeding.

- [ ] **Step 3: Run focused controller and transport gates**

```bash
npx vitest run tests/bb-runner.test.ts tests/telegram-client.test.ts tests/job-executor-service.test.ts tests/controller-store.test.ts tests/controller-service.test.ts tests/controller-tools.test.ts tests/telegram-ingress.test.ts tests/plugin.test.ts tests/end-to-end.test.ts
```

Expected: exit 0, no failed tests, no unhandled rejection warnings.

- [ ] **Step 4: Run the complete local gate**

```bash
npm run check
bb plugin types --check
git diff --check
git status --short
```

Expected: typecheck, all tests, build, SDK freshness, and whitespace checks pass. Only intended tracked documentation or final guard fixes remain uncommitted.

- [ ] **Step 5: Commit final documentation/guard fixes**

```bash
git add README.md docs/acceptance-test.md
git commit -m "docs: explain the Luna Telegram controller"
```

If a guard fix changed code/tests, stage those exact reviewed paths in the same commit and state them in the commit body.

- [ ] **Step 6: Reload and inspect the installed plugin**

```bash
bb plugin reload telegram-agent
bb plugin list --json
bb telegram-agent doctor --json
bb telegram-agent doctor proj_ymbs76hfau --json
bb plugin logs telegram-agent -n 100
```

Expected: plugin status `running`; `telegram-ingress` and `job-executor` are running rather than backoff; global and disposable-project doctor checks pass; logs contain no repeating Telegram 400 crash loop.

- [ ] **Step 7: Run live disposable-repository acceptance**

Use the paired private chat and project `proj_ymbs76hfau`:

1. Ask a conversational question and confirm the response comes from a hidden controller thread using `codex/gpt-5.6-luna` with `max` reasoning.
2. Send an unambiguous task for the disposable repository and confirm exactly one implementation thread/worktree is created on the source host.
3. Confirm a separate fresh review/test child uses the same environment and policy-selected background model.
4. Confirm the authoritative remote head and deterministic gates reach merge approval.
5. Approve the disposable PR in Telegram, verify the merge through BB/GitHub state, and confirm Luna reports the durable final state.

Do not merge any non-disposable project during acceptance.

- [ ] **Step 8: Record final evidence**

Report separately: local tests/typecheck/build, installed plugin/service state, controller provider/model/reasoning, implementation thread/environment, review thread/provider separation, Git head-gate evidence, approval, GitHub merge, and any production deployment evidence or blocker. Do not infer one plane from another.
