# Telegram Live Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Telegram's native `typing...` indicator while Luna or an authoritative BB worker is active, while retaining one durable milestone status message.

**Architecture:** Add a one-attempt `sendChatAction` transport operation, isolate presence selection and heartbeat throttling in a small executor-owned coordinator, and let the leased executor pulse it after reconciliation. Durable controller state, worker-liveness state, effects, and outbox delivery remain authoritative; ingress and lifecycle callbacks never send presence.

**Tech Stack:** TypeScript, Telegram Bot API, BB plugin SDK, SQLite-backed `TelegramAgentStore`, Vitest.

## Global Constraints

- The leased job executor is the only presence execution engine.
- Send action `typing` at most once every 4,000 milliseconds while eligible work is active.
- Telegram chat actions are ephemeral, best-effort, one-attempt operations and never enter the durable outbox.
- Eligible controller states are `dispatching` and `submitted`.
- Eligible worker-liveness states are `starting` and `active`; `unknown`, `stale`, `stopping`, `idle`, and `failed` fail closed.
- Eligible job/worker pairs are implementation for `creating_implementation`, `implementing`, or `remediating`; review for `reviewing`; validation for `validating`.
- No typing while waiting for project selection, confirmation, merge approval, retry, user input, host recovery, or a terminal state.
- Keep final controller replies and job milestone status edits durable and idempotent.
- Do not stream partial provider tokens or add periodic text messages.
- Use Luna Max behavior and existing project/review/merge isolation unchanged.

---

### Task 1: One-attempt Telegram chat-action transport

**Files:**
- Modify: `src/telegram/client.ts`
- Test: `tests/telegram-client.test.ts`

**Interfaces:**
- Consumes: existing `TelegramClient.request` and serialized JSON transport.
- Produces: `TelegramClient.sendChatAction(chatId: string, action: "typing", signal?: AbortSignal): Promise<void>`.
- Produces: internal request option `maxAttempts?: number`, defaulting to the current four attempts.

- [ ] **Step 1: Add a failing request-shape test**

Add a test that constructs a real `TelegramClient` with the existing fetch recorder, calls:

```ts
await client.sendChatAction("70", "typing");
```

and asserts the request URL ends in `/sendChatAction`, the JSON body equals:

```ts
{ chat_id: "70", action: "typing" }
```

and the method resolves when Telegram returns `{ ok: true, result: true }`.

- [ ] **Step 2: Add a failing one-attempt/fail-fast test**

Return Telegram error `429` with `retry_after` and assert `sendChatAction` makes exactly one fetch call and rejects with the typed Telegram error. Also call the method through a deliberate runtime cast with action `upload_photo` and assert it rejects locally before fetch.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
bunx vitest run tests/telegram-client.test.ts
```

Expected: FAIL because `sendChatAction` does not exist.

- [ ] **Step 4: Implement the minimal transport**

Extend the internal request shape with:

```ts
maxAttempts?: number;
```

Resolve attempts with `request.maxAttempts ?? MAX_ATTEMPTS`, validate the value is an integer from 1 through `MAX_ATTEMPTS`, and use it as the retry-loop bound. Add:

```ts
public sendChatAction(chatId: string, action: "typing", signal?: AbortSignal): Promise<void> {
  if (action !== "typing") throw new TypeError("Unsupported Telegram chat action");
  return this.request({
    method: "sendChatAction",
    payload: { chat_id: chatId, action },
    callerSignal: signal,
    timeoutMs: 5_000,
    maxAttempts: 1,
    parseResult: () => undefined,
  });
}
```

Avoid double-inserting `chat_id`: unlike `sendMessage`, this method calls the generic request directly.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```bash
bunx vitest run tests/telegram-client.test.ts
```

Expected: PASS with no retry sleep for chat-action failures.

- [ ] **Step 6: Commit the transport slice**

```bash
git add src/telegram/client.ts tests/telegram-client.test.ts
git commit -m "feat: add Telegram typing transport"
```

---

### Task 2: Authoritative presence selection and heartbeat throttling

**Files:**
- Create: `src/services/telegram-presence.ts`
- Create: `tests/telegram-presence.test.ts`

**Interfaces:**
- Consumes store methods: `getOwner`, `getControllerForOwner`, `listControllerTurns`, `getActiveJob`, and `getWorkerLiveness`.
- Consumes transport: `{ sendChatAction(chatId: string, action: "typing", signal?: AbortSignal): Promise<void> }`.
- Produces: `resolveTelegramPresenceTarget(store): { key: string; chatId: string } | null`.
- Produces: `TelegramPresenceCoordinator.pulse(now: number, signal: AbortSignal): Promise<number | null>` where the number is milliseconds until the next refresh and `null` means inactive.
- Produces: `TelegramPresenceCoordinator.reset(): void`.

- [ ] **Step 1: Write failing controller-state tests**

Use the real fake-host SQLite store and existing pairing/controller helpers. Assert:

```ts
expect(resolveTelegramPresenceTarget(store)).toEqual({
  key: `controller:${turn.id}`,
  chatId: "70",
});
```

for `dispatching` and `submitted`. Assert `null` for `queued`, `completed`, `failed`, revoked owner, and missing controller mapping.

- [ ] **Step 2: Write failing job/liveness matrix tests**

Create jobs with the existing state-machine/store helpers and persist worker liveness. Assert a target only for these exact pairs:

```ts
[
  ["creating_implementation", "implementation", "starting"],
  ["implementing", "implementation", "active"],
  ["remediating", "implementation", "active"],
  ["reviewing", "review", "active"],
  ["validating", "validation", "active"],
]
```

Assert `null` for a mismatched worker kind, all non-active liveness values, `awaiting_merge_approval`, `merging`, terminal jobs, and no owner.

- [ ] **Step 3: Write failing heartbeat tests**

With a stable active target and recorded transport, assert:

```ts
await coordinator.pulse(1_000, signal); // sends immediately, returns 4_000
await coordinator.pulse(4_999, signal); // no send, returns 1
await coordinator.pulse(5_000, signal); // refreshes, returns 4_000
```

Change the target key and assert the new target sends immediately. Remove the target and assert `null`; restore it and assert immediate send. Call `reset()` and assert immediate send on the next pulse.

- [ ] **Step 4: Write a failing failure-isolation test**

Make `sendChatAction` reject with a credential-shaped error, pass a warning recorder, and assert `pulse` resolves with `4_000`, records one bounded redacted warning, and does not retry before the next deadline.

- [ ] **Step 5: Run the focused tests and verify RED**

Run:

```bash
bunx vitest run tests/telegram-presence.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 6: Implement target resolution**

Create constants for `HEARTBEAT_MS = 4_000`, eligible job states, and eligible liveness states. Prefer an in-flight controller turn over a background job. Construct stable keys as `controller:<turn-id>` and `job:<job-id>:<worker-kind>:<generation>:<resource-id>` so a worker generation change refreshes immediately.

- [ ] **Step 7: Implement the coordinator**

Store only the last attempted `{ key, at }` in memory. In `pulse`, clear that value on an inactive target, send immediately for a new key, throttle the same key until 4,000 milliseconds elapse, and record the attempt timestamp even when Telegram rejects. Catch errors, redact with the existing `redactError`, bound the warning to 500 characters, and never throw unless the caller signal is aborted.

- [ ] **Step 8: Run the focused tests and verify GREEN**

Run:

```bash
bunx vitest run tests/telegram-presence.test.ts
```

Expected: PASS for the controller matrix, job/liveness matrix, heartbeat, reset, and failure isolation.

- [ ] **Step 9: Commit the coordinator slice**

```bash
git add src/services/telegram-presence.ts tests/telegram-presence.test.ts
git commit -m "feat: coordinate Telegram live presence"
```

---

### Task 3: Lease-owned executor integration and live plugin wiring

**Files:**
- Modify: `src/services/job-executor-service.ts`
- Modify: `src/plugin.ts`
- Modify: `tests/job-executor-service.test.ts`
- Modify: `tests/plugin.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `TelegramPresenceCoordinator.pulse(now, signal)` and `reset()` from Task 2.
- Produces: optional executor dependency `presence?: Pick<TelegramPresenceCoordinator, "pulse" | "reset">`.
- Produces: executor wait capped by the active presence refresh deadline.
- Wires production transport to `TelegramClient.sendChatAction` with the executor's abort signal.

- [ ] **Step 1: Write failing executor scheduling tests**

Add a presence fake with `pulse` returning `4_000` and a wait recorder. Run one executor iteration and assert:

```ts
expect(waitForWork).toHaveBeenCalledWith(4_000, expect.any(AbortSignal));
```

when the ordinary wait would be 5,000 or 60,000 milliseconds. Return `null` and assert the existing active/idle wait remains unchanged.

- [ ] **Step 2: Write failing lease/reset tests**

Assert `presence.reset()` runs when a lease is acquired and again when its work loop ends. Force lease loss with the existing lease-generation fixture and assert the stale executor never calls `pulse` after losing authority; a replacement acquisition resets before pulsing.

- [ ] **Step 3: Write a failing plugin-wiring test**

Run the registered job-executor service through the fake plugin host with a submitted controller turn. Stub Telegram's chat-action transport or fetch boundary and assert the service requests `typing` without creating an outbox row or a second execution service.

- [ ] **Step 4: Run focused integration tests and verify RED**

Run:

```bash
bunx vitest run tests/job-executor-service.test.ts tests/plugin.test.ts
```

Expected: FAIL because the executor has no presence dependency and plugin wiring lacks chat actions.

- [ ] **Step 5: Integrate presence into the executor**

After controller/job reconciliation and before the wait, call `presence.pulse(currentNow, workAbort.signal)`. Preserve effects and outbox ordering. Compute:

```ts
const ordinaryWaitMs = didWork ? ACTIVE_POLL_MS : IDLE_POLL_MS;
const waitMs = presenceWaitMs === null
  ? ordinaryWaitMs
  : Math.min(ordinaryWaitMs, Math.max(1, presenceWaitMs));
```

Reset the coordinator immediately after lease acquisition and in the lease-loop `finally`. Do not call it unless `isExecutorLeaseCurrent` is true.

- [ ] **Step 6: Wire the production coordinator**

Construct one `TelegramPresenceCoordinator` for the background service with the existing store, `clock`, redacted `bb.log.warn`, and a transport factory that reads the latest configured bot token. Pass `workAbort.signal` through to `TelegramClient.sendChatAction` so reload, shutdown, or lease loss aborts the request.

- [ ] **Step 7: Update operational documentation**

In `README.md` update the conversation/task flow and recovery guarantees to state that the leased executor emits a best-effort native typing heartbeat every four seconds for active controller/worker states, while milestone status edits and final replies remain durable. Explicitly state that ingress does not own presence and chat actions are not outbox-persisted.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run:

```bash
bunx vitest run tests/telegram-client.test.ts tests/telegram-presence.test.ts tests/job-executor-service.test.ts tests/plugin.test.ts
```

Expected: PASS.

- [ ] **Step 9: Run complete local gates**

Run:

```bash
bun run typecheck
bun test
bun run build
git diff --check
```

Expected: all commands exit 0 with no test failures or type errors.

- [ ] **Step 10: Review changed production, test, and documentation code**

Apply Clean Code Guard to production changes, Test Guard to changed tests, and Docs Guard to README/spec/plan claims. Fix findings, rerun the focused and complete gates, then inspect `git diff --stat` and `git status --short`.

- [ ] **Step 11: Commit the integration slice**

```bash
git add src/services/job-executor-service.ts src/plugin.ts tests/job-executor-service.test.ts tests/plugin.test.ts README.md
git commit -m "feat: show live Telegram agent presence"
```

- [ ] **Step 12: Reload and verify the installed plugin**

Run:

```bash
bb plugin build /root/github_projects/telegram-bb-agent-plugin
bb plugin reload telegram-agent
bb plugin list --json
bb plugin logs telegram-agent -n 100
```

Expected: plugin status `running`; `telegram-ingress` and `job-executor` services running; no activation or crash-loop error.

Send a real Telegram message that requires a noticeable Luna Max response, observe `typing...` refresh while its controller turn is active, then verify the final response is delivered and the indicator clears. Inspect the hidden controller thread to confirm model `gpt-5.6-luna`, reasoning `max`, and permission `auto`. For a guarded job, verify the single status message changes at milestones and typing stops in `awaiting_merge_approval` or a terminal state.

- [ ] **Step 13: Record final evidence**

Capture the focused/full test commands, build/reload status, plugin services, controller execution tuple, live Telegram observation, changed commits, and any external blocker. Do not claim live UI proof if Telegram was not observed from the paired chat.
