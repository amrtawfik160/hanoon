# Controller Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound a full-permission controller turn by observed tool calls, token usage, and command failures, steering it back on course once and stopping it before it runs away.

**Architecture:** The reconcile loop already polls the BB event stream for a submitted turn and already owns a mid-turn `steer` channel. This plan extends the event observation with three counters, accumulates them on the turn row inside the existing cursor-guarded stream update, and evaluates a pure decision function that returns continue / steer / stop. No new loop, no new service, no new lease.

**Tech Stack:** TypeScript, better-sqlite3 via the plugin storage layer, Zod for tool parameters, Vitest.

## Global Constraints

- Migrations are append-only; add a new named block and register it in `ALL_MIGRATIONS`.
- Every mutation runs inside the existing executor fence (`ControllerLeaseFence`) and returns `boolean` rather than throwing on a lost fence.
- No unbounded strings reach SQLite or Telegram; reuse the existing bounded helpers.
- Owner-facing copy follows `src/controller/instructions.ts`: outcome first, no tool narration, no apology paragraph.
- Budgets are constants with rationale comments, matching `CONTROLLER_STALL_MS`; they are not new plugin settings.
- The deterministic suite (`npm run typecheck && npx vitest run`) must stay green: baseline is 57 files / 925 tests at commit `2334396`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/controller/supervisor.ts` (create) | Pure budget constants, signal type, and `evaluateSupervisor` decision function. No I/O. |
| `src/controller/bb-controller.ts` (modify) | Count tool starts, failed commands, and cumulative tokens while paging the event stream. |
| `src/controller/models.ts` (modify) | Carry the four accumulated counters on `ControllerTurnRecord`. |
| `src/storage/migrations.ts` (modify) | `CONTROLLER_SUPERVISOR_MIGRATIONS`, appended to `ALL_MIGRATIONS`. |
| `src/storage/store.ts` (modify) | Accumulate usage inside `updateControllerStream`; add `recordControllerSupervisorSteer`. |
| `src/controller/service.ts` (modify) | Evaluate the supervisor in the active branch, between owner steering and the stall check. |
| `tests/controller-supervisor.test.ts` (create) | Decision-function truth table, store accumulation, and two service integration paths. |

---

### Task 1: Pure supervisor decision function

**Files:**
- Create: `src/controller/supervisor.ts`
- Test: `tests/controller-supervisor.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SupervisorReason`, `SupervisorSignals`, `SupervisorDecision`, `evaluateSupervisor(signals): SupervisorDecision`, and the six budget constants.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import {
  evaluateSupervisor,
  SUPERVISOR_HARD_TOOL_CALLS,
  SUPERVISOR_SOFT_TOOL_CALLS,
} from "../src/controller/supervisor";

const quiet = {
  toolCalls: 0,
  totalTokens: 0,
  commandFailures: 0,
  steersIssued: 0,
  steeredReasons: [] as const,
};

it("lets an ordinary turn run", () => {
  expect(evaluateSupervisor(quiet)).toEqual({ kind: "continue" });
});

it("steers once at the soft tool budget", () => {
  const decision = evaluateSupervisor({ ...quiet, toolCalls: SUPERVISOR_SOFT_TOOL_CALLS });
  expect(decision).toMatchObject({ kind: "steer", reason: "tool_budget" });
});

it("does not repeat a steer for a reason already used", () => {
  expect(evaluateSupervisor({
    ...quiet,
    toolCalls: SUPERVISOR_SOFT_TOOL_CALLS,
    steersIssued: 1,
    steeredReasons: ["tool_budget"],
  })).toEqual({ kind: "continue" });
});

it("stops at the hard tool budget even when a steer was already spent", () => {
  const decision = evaluateSupervisor({
    ...quiet,
    toolCalls: SUPERVISOR_HARD_TOOL_CALLS,
    steersIssued: 1,
    steeredReasons: ["tool_budget"],
  });
  expect(decision).toMatchObject({ kind: "stop", reason: "tool_budget" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/controller-supervisor.test.ts`
Expected: FAIL — cannot resolve `../src/controller/supervisor`.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * A full-permission controller turn is bounded by wall-clock silence alone
 * (CONTROLLER_STALL_MS). A turn that keeps producing events while going
 * nowhere is invisible to that clock, so these budgets bound the work itself:
 * one nudge to land the answer, then a stop before it burns the owner's
 * money on a loop they cannot see.
 */

/** One nudge is a course correction; a second is nagging a model that is stuck. */
export const SUPERVISOR_MAX_STEERS_PER_TURN = 2;

// A phone answer is a handful of calls; a genuinely broad request ("what is
// running across every machine") lands near 40. 60 is past thorough and into
// searching, and 120 is not a question being answered.
export const SUPERVISOR_SOFT_TOOL_CALLS = 60;
export const SUPERVISOR_HARD_TOOL_CALLS = 120;

// Opus runs a 1M window, so tokens bound cost rather than context. A long
// investigation lands under 300k; past 600k the turn is not converging.
export const SUPERVISOR_SOFT_TOKENS = 300_000;
export const SUPERVISOR_HARD_TOKENS = 600_000;

// Five non-zero exits is a model trying variations instead of reading the error.
export const SUPERVISOR_SOFT_COMMAND_FAILURES = 5;

export type SupervisorReason = "tool_budget" | "token_budget" | "command_failures";

export type SupervisorSignals = {
  toolCalls: number;
  totalTokens: number;
  commandFailures: number;
  steersIssued: number;
  steeredReasons: readonly SupervisorReason[];
};

export type SupervisorDecision =
  | { kind: "continue" }
  | { kind: "steer"; reason: SupervisorReason; text: string }
  | { kind: "stop"; reason: SupervisorReason; ownerMessage: string };

const STEER_TEXT: Record<SupervisorReason, string> = {
  tool_budget:
    "You have spent a lot of tool calls on this one message. Stop looking and answer now with what you already have. If something is genuinely unresolved, say so in one clause.",
  token_budget:
    "This turn is running long. Land the answer now with what you already know, and name the one thing that would settle anything still open.",
  command_failures:
    "Several commands have failed. Stop trying variations: read the actual error, form one hypothesis, and either test that once or tell the owner what is blocking you.",
};

const STOP_MESSAGE =
  "That one ran past its budget, so I stopped it and started fresh. Ask me again — narrower helps.";

export function evaluateSupervisor(signals: SupervisorSignals): SupervisorDecision {
  if (signals.toolCalls >= SUPERVISOR_HARD_TOOL_CALLS) {
    return { kind: "stop", reason: "tool_budget", ownerMessage: STOP_MESSAGE };
  }
  if (signals.totalTokens >= SUPERVISOR_HARD_TOKENS) {
    return { kind: "stop", reason: "token_budget", ownerMessage: STOP_MESSAGE };
  }
  if (signals.steersIssued >= SUPERVISOR_MAX_STEERS_PER_TURN) return { kind: "continue" };
  const used = new Set(signals.steeredReasons);
  const soft: readonly (readonly [SupervisorReason, boolean])[] = [
    ["tool_budget", signals.toolCalls >= SUPERVISOR_SOFT_TOOL_CALLS],
    ["token_budget", signals.totalTokens >= SUPERVISOR_SOFT_TOKENS],
    ["command_failures", signals.commandFailures >= SUPERVISOR_SOFT_COMMAND_FAILURES],
  ];
  for (const [reason, tripped] of soft) {
    if (tripped && !used.has(reason)) return { kind: "steer", reason, text: STEER_TEXT[reason] };
  }
  return { kind: "continue" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/controller-supervisor.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/controller/supervisor.ts tests/controller-supervisor.test.ts
git commit -m "feat: add controller supervisor budget decisions"
```

---

### Task 2: Observe tool calls, command failures, and tokens

**Files:**
- Modify: `src/controller/bb-controller.ts:30-38` (type), `:218-256` (`events`)
- Modify: `tests/controller-service.test.ts`, `tests/controller-stream.test.ts`, `tests/controller-questions.test.ts` — 22 observation literals gain the three fields
- Test: `tests/controller-supervisor.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `ControllerEventObservation` gains required `toolCalls: number`, `commandFailures: number`, `totalTokens: number`. `toolCalls` and `commandFailures` are deltas for the polled window; `totalTokens` is the highest cumulative thread total seen in that window, or `0` when the window carried no usage event.

- [ ] **Step 1: Write the failing test**

```ts
it("counts tool starts, failed commands, and cumulative tokens", async () => {
  const events = [
    { id: "e1", threadId: "t", seq: 1, createdAt: 1, scope: { kind: "thread" }, type: "item/started",
      data: { item: { type: "commandExecution", id: "c1" } } },
    { id: "e2", threadId: "t", seq: 2, createdAt: 2, scope: { kind: "thread" }, type: "item/started",
      data: { item: { type: "reasoning", id: "r1" } } },
    { id: "e3", threadId: "t", seq: 3, createdAt: 3, scope: { kind: "thread" }, type: "item/completed",
      data: { item: { type: "commandExecution", id: "c1", exitCode: 2 } } },
    { id: "e4", threadId: "t", seq: 4, createdAt: 4, scope: { kind: "thread" }, type: "thread/tokenUsage/updated",
      data: { tokenUsage: { total: { totalTokens: 4_211 } } } },
  ];
  const { adapter } = sdkFixture({ events });

  const observation = await adapter.events("thr_controller", 0, AbortSignal.timeout(1_000));

  expect(observation).toMatchObject({ toolCalls: 1, commandFailures: 1, totalTokens: 4_211 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/controller-supervisor.test.ts`
Expected: FAIL — `toolCalls` is undefined on the observation.

- [ ] **Step 3: Write minimal implementation**

Add to the observation type in `src/controller/bb-controller.ts`:

```ts
  /** Tool-shaped item starts in this window; the caller accumulates them. */
  toolCalls: number;
  /** Non-zero command exits in this window; the caller accumulates them. */
  commandFailures: number;
  /** Highest cumulative thread token total in this window, else 0. */
  totalTokens: number;
```

Above the class, declare which items count as tool work:

```ts
// Reasoning, plain messages, and plan updates are the model thinking out loud.
// Everything here reaches outside the model and is what a budget should bound.
const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  "commandExecution",
  "toolCall",
  "webSearch",
  "fileChange",
  "backgroundTask",
]);
```

In `events()`, declare the accumulators next to the existing ones, add the three branches inside the row loop, and return them:

```ts
    let toolCalls = 0;
    let commandFailures = 0;
    let totalTokens = 0;
```

```ts
        if (row.type === "item/started" && TOOL_ITEM_TYPES.has(row.data.item.type)) toolCalls += 1;
        if (row.type === "item/completed" && row.data.item.type === "commandExecution") {
          const exitCode = row.data.item.exitCode;
          if (typeof exitCode === "number" && exitCode !== 0) commandFailures += 1;
        }
        if (row.type === "thread/tokenUsage/updated") {
          const total = row.data.tokenUsage.total.totalTokens;
          if (Number.isFinite(total) && total > totalTokens) totalTokens = total;
        }
```

```ts
    return {
      latestSeq, inputAccepted, assistantDelta, completed, error, pendingQuestion,
      toolCalls, commandFailures, totalTokens,
    };
```

- [ ] **Step 4: Update the 22 existing observation fixtures**

Run:

```bash
perl -0pi -e 's/pendingQuestion: null(\s*[,}])/pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0$1/g' \
  tests/controller-service.test.ts tests/controller-stream.test.ts tests/controller-questions.test.ts
```

- [ ] **Step 5: Run typecheck and the full suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; 58 files pass.

- [ ] **Step 6: Commit**

```bash
git add src/controller/bb-controller.ts tests/
git commit -m "feat: observe controller tool, failure, and token usage"
```

---

### Task 3: Persist the counters on the turn

**Files:**
- Modify: `src/storage/migrations.ts` (new block + `ALL_MIGRATIONS`)
- Modify: `src/controller/models.ts:40-64` (`ControllerTurnRecord`)
- Modify: `src/storage/store.ts` — `ControllerTurnRow`, `parseControllerTurn:1993`, `updateControllerStream:2936`, new `recordControllerSupervisorSteer`
- Test: `tests/controller-supervisor.test.ts`

**Interfaces:**
- Consumes: `SupervisorReason` from Task 1; the observation deltas from Task 2.
- Produces: `ControllerTurnRecord` gains `toolCalls`, `commandFailures`, `totalTokens`, `supervisorSteers: number`, `supervisorReasons: readonly SupervisorReason[]`. `updateControllerStream` gains optional `toolCalls`, `commandFailures`, `totalTokens` (default `0`) accumulated under the existing cursor guard. `recordControllerSupervisorSteer(input: ControllerLeaseFence & { turnId: string; reason: SupervisorReason }): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
it("accumulates usage once per cursor advance and records steers", () => {
  const { store, fence } = serviceFixture();
  const turn = submittedTurn(store, fence);
  const at = (now: number) => ({ ownerId: fence.ownerId, generation: fence.generation, now });

  expect(store.updateControllerStream({
    ...at(2_001), turnId: turn.id, cursor: 5, text: "working", phase: "thinking",
    toolCalls: 3, commandFailures: 1, totalTokens: 900,
  })).toBe(true);
  // Same cursor again: the guard rejects it, so nothing double counts.
  expect(store.updateControllerStream({
    ...at(2_002), turnId: turn.id, cursor: 5, text: "working", phase: "thinking",
    toolCalls: 3, commandFailures: 1, totalTokens: 900,
  })).toBe(false);
  expect(store.updateControllerStream({
    ...at(2_003), turnId: turn.id, cursor: 9, text: "working", phase: "thinking",
    toolCalls: 2, commandFailures: 0, totalTokens: 1_500,
  })).toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    toolCalls: 5, commandFailures: 1, totalTokens: 1_500,
  });

  expect(store.recordControllerSupervisorSteer({ ...at(2_004), turnId: turn.id, reason: "tool_budget" })).toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    supervisorSteers: 1, supervisorReasons: ["tool_budget"],
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/controller-supervisor.test.ts`
Expected: FAIL — `recordControllerSupervisorSteer` is not a function.

- [ ] **Step 3: Add the migration**

In `src/storage/migrations.ts`, after `CONTROLLER_IMAGE_MIGRATIONS`:

```ts
export const CONTROLLER_SUPERVISOR_MIGRATIONS = [String.raw`
ALTER TABLE controller_turns ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE controller_turns ADD COLUMN command_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE controller_turns ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE controller_turns ADD COLUMN supervisor_steers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE controller_turns ADD COLUMN supervisor_reasons TEXT NOT NULL DEFAULT '';
`] as const;
```

and register it as the last entry of `ALL_MIGRATIONS`.

- [ ] **Step 4: Extend the record, row, and parser**

`src/controller/models.ts` — import the reason type and add to `ControllerTurnRecord`:

```ts
import type { SupervisorReason } from "./supervisor";
```

```ts
  toolCalls: number;
  commandFailures: number;
  totalTokens: number;
  supervisorSteers: number;
  supervisorReasons: readonly SupervisorReason[];
```

`src/storage/store.ts` — add the five snake_case fields to `ControllerTurnRow`, and in `parseControllerTurn`:

```ts
    toolCalls: row.tool_calls,
    commandFailures: row.command_failures,
    totalTokens: row.total_tokens,
    supervisorSteers: row.supervisor_steers,
    supervisorReasons: parseSupervisorReasons(row.supervisor_reasons),
```

with a module-level helper next to the other parsers:

```ts
const SUPERVISOR_REASONS: ReadonlySet<string> = new Set([
  "tool_budget", "token_budget", "command_failures",
]);

// Stored as a comma-separated slug list: the vocabulary is closed and tiny, so
// JSON would only add a parse failure mode to a column that cannot grow.
function parseSupervisorReasons(value: string): readonly SupervisorReason[] {
  return value.split(",").filter((slug): slug is SupervisorReason => SUPERVISOR_REASONS.has(slug));
}
```

- [ ] **Step 5: Accumulate inside the cursor guard**

In `updateControllerStream`, widen the input and fold the counters into the same `UPDATE`, so the cursor guard that prevents a replayed page from re-rendering the draft also prevents it from double counting:

```ts
    toolCalls?: number;
    commandFailures?: number;
    totalTokens?: number;
```

```ts
      const updated = this.db.prepare(
        `UPDATE controller_turns
            SET bb_event_seq = ?, stream_text = ?, stream_phase = ?, updated_at = ?,
                tool_calls = tool_calls + ?,
                command_failures = command_failures + ?,
                total_tokens = MAX(total_tokens, ?)
          WHERE id = ? AND state = 'submitted' AND bb_event_seq < ?`,
      ).run(
        input.cursor, input.text, input.phase, input.now,
        input.toolCalls ?? 0, input.commandFailures ?? 0, input.totalTokens ?? 0,
        input.turnId, input.cursor,
      );
```

Guard the new inputs beside the existing assertions:

```ts
    assertNonNegativeInteger(input.toolCalls ?? 0, "toolCalls");
    assertNonNegativeInteger(input.commandFailures ?? 0, "commandFailures");
    assertNonNegativeInteger(input.totalTokens ?? 0, "totalTokens");
```

- [ ] **Step 6: Add the steer recorder**

Next to `updateControllerStream`:

```ts
  /**
   * Records that the supervisor already nudged this turn for one reason, so a
   * later poll reading the same tripped budget cannot nudge again.
   */
  public recordControllerSupervisorSteer(input: ControllerLeaseFence & {
    turnId: string;
    reason: SupervisorReason;
  }): boolean {
    this.assertControllerMutation(input);
    if (!SUPERVISOR_REASONS.has(input.reason)) throw new TypeError("Unknown controller supervisor reason");
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const updated = this.db.prepare(
        `UPDATE controller_turns
            SET supervisor_steers = supervisor_steers + 1,
                supervisor_reasons = CASE
                  WHEN supervisor_reasons = '' THEN ?
                  ELSE supervisor_reasons || ',' || ?
                END,
                updated_at = ?
          WHERE id = ? AND state = 'submitted'
            AND instr(',' || supervisor_reasons || ',', ',' || ? || ',') = 0`,
      ).run(input.reason, input.reason, input.now, input.turnId, input.reason);
      return updated.changes === 1;
    }).immediate();
  }
```

Declare it on the store interface beside `updateControllerStream:1574`.

- [ ] **Step 7: Run the test and the full suite**

Run: `npx vitest run tests/controller-supervisor.test.ts && npm run typecheck && npx vitest run`
Expected: new test passes; typecheck clean; all files pass.

- [ ] **Step 8: Commit**

```bash
git add src/storage/migrations.ts src/storage/store.ts src/controller/models.ts tests/controller-supervisor.test.ts
git commit -m "feat: persist controller turn usage and supervisor steers"
```

---

### Task 4: Act on the decision in the reconcile loop

**Files:**
- Modify: `src/controller/service.ts:211-296`
- Test: `tests/controller-supervisor.test.ts`

**Interfaces:**
- Consumes: `evaluateSupervisor` (Task 1), the observation deltas (Task 2), the persisted counters and `recordControllerSupervisorSteer` (Task 3).
- Produces: no new exports. Behavior only.

- [ ] **Step 1: Write the failing test**

```ts
it("steers a turn that crosses the soft tool budget, then stops it at the hard budget", async () => {
  const { store, fence } = serviceFixture();
  const turn = submittedTurn(store, fence);
  let toolCalls = SUPERVISOR_SOFT_TOOL_CALLS;
  let seq = 1;
  const adapter: ControllerAdapter = {
    ...idleAdapter(),
    status: vi.fn(async () => "active" as const),
    events: vi.fn(async () => ({
      latestSeq: (seq += 1), inputAccepted: true, assistantDelta: "", completed: false,
      error: null, pendingQuestion: null, toolCalls, commandFailures: 0, totalTokens: 0,
    })),
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_001 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(adapter.steer).toHaveBeenCalledWith(
    "thr_controller", expect.stringContaining("answer now"), fence.signal,
  );
  expect(store.getControllerTurn(turn.id)).toMatchObject({ supervisorSteers: 1 });

  toolCalls = SUPERVISOR_HARD_TOOL_CALLS;
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "failed",
    lastError: "Controller turn exceeded its budget",
  });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ threadId: null, state: "pending_spawn" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/controller-supervisor.test.ts`
Expected: FAIL — `steer` was not called; the turn stays submitted.

- [ ] **Step 3: Pass the observation deltas into the stream update**

In `reconcile`, extend the existing `updateControllerStream` call:

```ts
        if (projected.cursor > submitted.bbEventSeq) {
          this.dependencies.store.updateControllerStream({
            ...fenceAt(fence, this.dependencies.clock.now()),
            turnId: submitted.id,
            cursor: projected.cursor,
            text: projected.text,
            phase: projected.phase,
            toolCalls: observation.toolCalls,
            commandFailures: observation.commandFailures,
            totalTokens: observation.totalTokens,
          });
        }
```

- [ ] **Step 4: Evaluate between owner steering and the stall check**

In the `status === "active" || "starting" || "stopping"` branch, after the queued-owner-message steer block and before the stall check:

```ts
      // The owner's own words outrank a budget nudge, so this runs only once
      // nothing of theirs is waiting. A turn parked on a question is waiting on
      // a person, and no budget should fire against their thinking time.
      if (parked === null && await this.superviseBudget(submitted.id, controller, fence, signal)) {
        return true;
      }
```

and add the private method:

```ts
  /** True when the supervisor acted, so the caller stops reconciling this turn. */
  private async superviseBudget(
    turnId: string,
    controller: ControllerThreadRecord,
    fence: EffectFence,
    signal: AbortSignal,
  ): Promise<boolean> {
    const turn = this.dependencies.store.getControllerTurn(turnId);
    if (!turn || turn.state !== "submitted" || controller.threadId === null) return false;
    const decision = evaluateSupervisor({
      toolCalls: turn.toolCalls,
      totalTokens: turn.totalTokens,
      commandFailures: turn.commandFailures,
      steersIssued: turn.supervisorSteers,
      steeredReasons: turn.supervisorReasons,
    });
    if (decision.kind === "continue") return false;
    if (decision.kind === "steer") {
      try {
        await this.dependencies.adapter.steer(controller.threadId, decision.text, signal);
      } catch {
        // A nudge that did not land is not worth failing the turn over; the
        // hard budget still stops it, and the next poll may deliver it.
        return false;
      }
      return this.dependencies.store.recordControllerSupervisorSteer({
        ...fenceAt(fence, this.dependencies.clock.now()),
        turnId,
        reason: decision.reason,
      });
    }
    // Retiring the thread is the half that matters: a turn stopped for cost
    // that leaves its thread alive would let the next message resume the loop.
    this.dependencies.store.resetControllerThread({
      ...fenceAt(fence, this.dependencies.clock.now()),
      controllerKey: controller.controllerKey,
      expectedThreadId: controller.threadId,
      reason: "Turn exceeded its supervisor budget",
    });
    this.fail(turn, fence, "Controller turn exceeded its budget", decision.ownerMessage);
    return true;
  }
```

Import `evaluateSupervisor` from `./supervisor` at the top of the file.

- [ ] **Step 5: Run the test and the full suite**

Run: `npx vitest run tests/controller-supervisor.test.ts && npm run typecheck && npx vitest run`
Expected: all pass, 58 files.

- [ ] **Step 6: Commit**

```bash
git add src/controller/service.ts tests/controller-supervisor.test.ts
git commit -m "feat: bound controller turns with the supervisor"
```

---

### Task 5: Document the behavior

**Files:**
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Add the supervisor to the controller section**

Document that a submitted controller turn accumulates tool calls, failed commands, and token totals on its durable row; that crossing a soft budget spends one of two steers; and that crossing a hard budget fails the turn with an owner-facing message and retires the thread.

- [ ] **Step 2: Run the full gate**

Run: `npm run typecheck && npx vitest run`

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: describe the controller supervisor"
```

---

## Remaining phases

Each becomes its own plan document once this one is green. Order and rationale are set by `docs/designs/agent-experience-autonomy.md` and the harness gap review:

1. **Delegation and join** — a `telegram_agent_delegate` tool that spawns bounded BB threads and registers a durable join built on the existing `thread_idle` monitors, so a turn can fan out and aggregate instead of working serially.
2. **Self-writing memory** — post-turn and post-job extraction as fenced effects, a nightly curation monitor using `MEMORY_HALF_LIFE_MS`, and recall-outcome feedback into `confidence`.
3. **System monitors** — plugin-owned monitors for stale-job sweep, memory quality, and the weekly autonomy scorecard.
4. **Answer-quality evaluation** — golden transcripts replayed against the existing fakes and scored against the instruction contract.
5. **Persona overlay and fast-model lane** — an owner-editable bounded overlay after the fixed instructions, and a cheap model for extraction, digest compaction, and Telegram rewriting.
