import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";
import {
  BbControllerAdapter,
  type ControllerAdapter,
  type ControllerStatus,
} from "../src/controller/bb-controller";
import { DEFAULT_CONTROLLER_EXECUTION_PROFILE } from "../src/controller/execution-profile";
import { LunaControllerService } from "../src/controller/service";

const testEvidenceProjector = {
  reconcile: vi.fn(async (...args: unknown[]) => ({
    outcome: "reconciled" as const,
    reconciliationIncomplete: null,
    fromSeq: 0,
    throughSeq: Number(args[1] && typeof args[1] === "object" && "evidenceEventSeq" in args[1]
      ? (args[1] as { evidenceEventSeq: number }).evidenceEventSeq
      : 0),
    targetSeq: typeof args[4] === "number" ? args[4] : 0,
  })),
};
import {
  evaluateSupervisor,
  SUPERVISOR_HARD_TOKENS,
  SUPERVISOR_HARD_TOOL_CALLS,
  SUPERVISOR_MAX_STEERS_PER_TURN,
  SUPERVISOR_SOFT_COMMAND_FAILURES,
  SUPERVISOR_SOFT_TOKENS,
  SUPERVISOR_SOFT_TOOL_CALLS,
  type SupervisorSignals,
} from "../src/controller/supervisor";

const quiet: SupervisorSignals = {
  toolCalls: 0,
  totalTokens: 0,
  commandFailures: 0,
  steersIssued: 0,
  steeredReasons: [],
};

it("lets an ordinary turn run", () => {
  expect(evaluateSupervisor(quiet)).toEqual({ kind: "continue" });
});

it("lets a turn one call short of the soft budget run", () => {
  expect(evaluateSupervisor({ ...quiet, toolCalls: SUPERVISOR_SOFT_TOOL_CALLS - 1 }))
    .toEqual({ kind: "continue" });
});

it.each([
  ["tool_budget", { toolCalls: SUPERVISOR_SOFT_TOOL_CALLS }],
  ["token_budget", { totalTokens: SUPERVISOR_SOFT_TOKENS }],
  ["command_failures", { commandFailures: SUPERVISOR_SOFT_COMMAND_FAILURES }],
] as const)("steers once at the %s soft budget", (reason, signals) => {
  expect(evaluateSupervisor({ ...quiet, ...signals })).toMatchObject({ kind: "steer", reason });
});

it("does not repeat a steer for a reason already used", () => {
  expect(evaluateSupervisor({
    ...quiet,
    toolCalls: SUPERVISOR_SOFT_TOOL_CALLS,
    steersIssued: 1,
    steeredReasons: ["tool_budget"],
  })).toEqual({ kind: "continue" });
});

it("still steers for a different reason after one is spent", () => {
  expect(evaluateSupervisor({
    ...quiet,
    toolCalls: SUPERVISOR_SOFT_TOOL_CALLS,
    commandFailures: SUPERVISOR_SOFT_COMMAND_FAILURES,
    steersIssued: 1,
    steeredReasons: ["tool_budget"],
  })).toMatchObject({ kind: "steer", reason: "command_failures" });
});

it("stops nudging once every steer is spent", () => {
  expect(evaluateSupervisor({
    ...quiet,
    commandFailures: SUPERVISOR_SOFT_COMMAND_FAILURES,
    steersIssued: SUPERVISOR_MAX_STEERS_PER_TURN,
    steeredReasons: ["tool_budget", "token_budget"],
  })).toEqual({ kind: "continue" });
});

it.each([
  ["tool_budget", { toolCalls: SUPERVISOR_HARD_TOOL_CALLS }],
  ["token_budget", { totalTokens: SUPERVISOR_HARD_TOKENS }],
] as const)("stops at the %s hard budget even when its steer was spent", (reason, signals) => {
  expect(evaluateSupervisor({
    ...quiet,
    ...signals,
    steersIssued: SUPERVISOR_MAX_STEERS_PER_TURN,
    steeredReasons: ["tool_budget", "token_budget"],
  })).toMatchObject({ kind: "stop", reason });
});

it("never stops for command failures alone", () => {
  expect(evaluateSupervisor({
    ...quiet,
    commandFailures: SUPERVISOR_SOFT_COMMAND_FAILURES * 100,
    steersIssued: SUPERVISOR_MAX_STEERS_PER_TURN,
    steeredReasons: ["command_failures"],
  })).toEqual({ kind: "continue" });
});

function event(seq: number, type: string, data: unknown) {
  return { id: `e${seq}`, threadId: "thr_controller", seq, createdAt: seq, scope: { kind: "thread" }, type, data };
}

function observingAdapter(pages: readonly (readonly unknown[])[]) {
  let page = 0;
  const sdk = {
    threads: { events: { list: vi.fn(async () => pages[page++] ?? []) } },
  } as unknown as BbPluginApi["sdk"];
  return new BbControllerAdapter({
    sdk,
    pluginId: "telegram-agent",
    executionProfile: () => DEFAULT_CONTROLLER_EXECUTION_PROFILE,
  });
}

it("counts tool starts, failed commands, and the cumulative token total", async () => {
  const adapter = observingAdapter([[
    event(1, "item/started", { item: { type: "commandExecution", id: "c1" } }),
    event(2, "item/started", { item: { type: "reasoning", id: "r1" } }),
    event(3, "item/started", { item: { type: "toolCall", id: "t1" } }),
    event(4, "item/completed", { item: { type: "commandExecution", id: "c1", exitCode: 2 } }),
    event(5, "item/completed", { item: { type: "commandExecution", id: "c2", exitCode: 0 } }),
    event(6, "thread/tokenUsage/updated", { tokenUsage: { total: { totalTokens: 4_211 } } }),
    event(7, "thread/tokenUsage/updated", { tokenUsage: { total: { totalTokens: 9_004 } } }),
  ]]);

  const observation = await adapter.events("thr_controller", 0, AbortSignal.timeout(1_000));

  expect(observation).toMatchObject({ toolCalls: 2, commandFailures: 1, totalTokens: 9_004 });
});

it("reports no usage for a window that carried none", async () => {
  const adapter = observingAdapter([[event(1, "item/agentMessage/delta", { delta: "hi" })]]);

  const observation = await adapter.events("thr_controller", 0, AbortSignal.timeout(1_000));

  expect(observation).toMatchObject({ toolCalls: 0, commandFailures: 0, totalTokens: 0 });
});

function storeFixture(name: string) {
  const { bb } = createFakePluginHost({ pluginId: `telegram-supervisor-${name}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.createPairingCode(hashSecret("pair"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", 1_001)).toEqual({ ok: true });
  // Long enough that the stall watchdog stays out of these tests.
  const lease = store.acquireExecutorLease("executor", 2_000, 60 * 60_000);
  if (!lease.acquired) throw new Error("missing lease");
  return { store, fence: { ownerId: "executor", generation: lease.generation } };
}

function submittedTurn(
  store: ReturnType<typeof storeFixture>["store"],
  fence: { ownerId: string; generation: number },
) {
  const turn = store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 91,
    inputText: "audit every machine",
    now: 2_000,
  });
  store.claimNextControllerTurn({ ...fence, now: 2_000 });
  expect(store.reserveControllerSpawn({
    controllerKey: turn.controllerKey,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    now: 2_000,
  })).toBe(true);
  store.markControllerSpawned({
    ...fence,
    now: 2_000,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
    spawnToken: turn.id,
  });
  store.markControllerTurnSubmitted({ ...fence, now: 2_000, turnId: turn.id });
  return turn;
}

function recordOwnerQuestion(
  store: ReturnType<typeof storeFixture>["store"],
  fence: { ownerId: string; generation: number },
  turn: ReturnType<typeof submittedTurn>,
): boolean {
  const generation = store.listControllerGenerations(turn.controllerKey, 1)[0];
  if (!generation) throw new Error("missing controller generation");
  return store.recordControllerInteraction({
    ...fence,
    now: 2_001,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    bbThreadId: "thr_controller",
    controllerGenerationId: generation.id,
    interaction: {
      kind: "user_question",
      interactionId: "int_1",
      questions: [{
        id: "q1",
        prompt: "Which project?",
        shortLabel: "Project",
        multiSelect: false,
        allowFreeText: false,
        options: [{ value: "cyndra", label: "cyndra", description: "the invoice service" }],
      }],
    },
  });
}

it("starts a turn with no recorded usage", () => {
  const { store, fence } = storeFixture("initial");
  const turn = submittedTurn(store, fence);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    toolCalls: 0,
    commandFailures: 0,
    totalTokens: 0,
    supervisorSteers: 0,
    supervisorReasons: [],
  });
});

it("accumulates usage only when the stream cursor advances", () => {
  const { store, fence } = storeFixture("accumulate");
  const turn = submittedTurn(store, fence);
  const at = (now: number) => ({ ...fence, now });

  expect(store.updateControllerStream({
    ...at(2_001), turnId: turn.id, cursor: 5, text: "working", phase: "thinking",
    toolCalls: 3, commandFailures: 1, totalTokens: 900,
  })).toBe(true);
  // Replaying the same page must not double count what it already recorded.
  expect(store.updateControllerStream({
    ...at(2_002), turnId: turn.id, cursor: 5, text: "working", phase: "thinking",
    toolCalls: 3, commandFailures: 1, totalTokens: 900,
  })).toBe(false);
  expect(store.updateControllerStream({
    ...at(2_003), turnId: turn.id, cursor: 9, text: "working on", phase: "thinking",
    toolCalls: 2, commandFailures: 0, totalTokens: 1_500,
  })).toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    toolCalls: 5,
    commandFailures: 1,
    totalTokens: 1_500,
  });
});

it("keeps the highest token total when a later window reports a lower one", () => {
  const { store, fence } = storeFixture("token-max");
  const turn = submittedTurn(store, fence);
  const at = (now: number) => ({ ...fence, now });

  store.updateControllerStream({
    ...at(2_001), turnId: turn.id, cursor: 4, text: "a", phase: "thinking", totalTokens: 8_000,
  });
  store.updateControllerStream({
    ...at(2_002), turnId: turn.id, cursor: 8, text: "ab", phase: "thinking", totalTokens: 0,
  });

  expect(store.getControllerTurn(turn.id)).toMatchObject({ totalTokens: 8_000 });
});

it("records one steer per reason and refuses a duplicate", () => {
  const { store, fence } = storeFixture("steers");
  const turn = submittedTurn(store, fence);
  const at = (now: number) => ({ ...fence, now });

  expect(store.recordControllerSupervisorSteer({ ...at(2_004), turnId: turn.id, reason: "tool_budget" })).toBe(true);
  expect(store.recordControllerSupervisorSteer({ ...at(2_005), turnId: turn.id, reason: "tool_budget" })).toBe(false);
  expect(store.recordControllerSupervisorSteer({ ...at(2_006), turnId: turn.id, reason: "token_budget" })).toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    supervisorSteers: 2,
    supervisorReasons: ["tool_budget", "token_budget"],
  });
});

it("refuses to record a steer under a stale executor generation", () => {
  const { store, fence } = storeFixture("stale");
  const turn = submittedTurn(store, fence);

  expect(store.recordControllerSupervisorSteer({
    ownerId: fence.ownerId,
    generation: fence.generation + 1,
    now: 2_004,
    turnId: turn.id,
    reason: "tool_budget",
  })).toBe(false);
});

type Observation = Awaited<ReturnType<ControllerAdapter["events"]>>;

function serviceAdapter(observation: () => Observation, status: () => ControllerStatus): ControllerAdapter {
  return {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "thr_controller", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => status()),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => observation()),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
}

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    latestSeq: 1,
    inputAccepted: true,
    assistantDelta: "",
    completed: false,
    error: null,
    pendingQuestion: null,
    toolCalls: 0,
    commandFailures: 0,
    totalTokens: 0,
    ...overrides,
  };
}

it("steers a turn that crosses the soft tool budget, then stops it at the hard budget", async () => {
  const { store, fence } = storeFixture("budget-path");
  const turn = submittedTurn(store, fence);
  let seq = 1;
  let toolCalls = SUPERVISOR_SOFT_TOOL_CALLS;
  const adapter = serviceAdapter(
    () => observation({ latestSeq: (seq += 1), toolCalls }),
    () => "active",
  );
  const service = new LunaControllerService({ store, adapter, evidenceProjector: testEvidenceProjector, clock: { now: () => 2_001 } });
  const runFence = { ...fence, signal: AbortSignal.timeout(2_000) };

  await expect(service.reconcile(runFence, runFence.signal)).resolves.toBe(true);

  expect(adapter.steer).toHaveBeenCalledWith(
    "thr_controller",
    expect.stringContaining("answer now"),
    runFence.signal,
  );
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "submitted",
    supervisorSteers: 1,
    supervisorReasons: ["tool_budget"],
  });

  // A second poll at the same tripped budget must not nudge again.
  toolCalls = 0;
  await expect(service.reconcile(runFence, runFence.signal)).resolves.toBe(true);
  expect(adapter.steer).toHaveBeenCalledTimes(1);

  toolCalls = SUPERVISOR_HARD_TOOL_CALLS;
  await expect(service.reconcile(runFence, runFence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "failed",
    lastError: "Controller turn exceeded its budget",
  });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ threadId: null, state: "pending_spawn" });
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text)
    .toContain("ran past its budget");
});

it("leaves a turn parked on an owner question alone however much it has spent", async () => {
  const { store, fence } = storeFixture("parked");
  const turn = submittedTurn(store, fence);
  expect(recordOwnerQuestion(store, fence, turn)).toBe(true);
  const adapter = serviceAdapter(
    () => observation({ latestSeq: 9, toolCalls: SUPERVISOR_HARD_TOOL_CALLS }),
    () => "active",
  );
  const service = new LunaControllerService({ store, adapter, evidenceProjector: testEvidenceProjector, clock: { now: () => 2_002 } });
  const runFence = { ...fence, signal: AbortSignal.timeout(2_000) };

  await expect(service.reconcile(runFence, runFence.signal)).resolves.toBe(true);

  expect(adapter.steer).not.toHaveBeenCalled();
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "submitted" });
});

it("keeps the turn running when a budget nudge cannot be delivered", async () => {
  const { store, fence } = storeFixture("steer-fails");
  const turn = submittedTurn(store, fence);
  const adapter = serviceAdapter(
    () => observation({ latestSeq: 4, toolCalls: SUPERVISOR_SOFT_TOOL_CALLS }),
    () => "active",
  );
  adapter.steer = vi.fn(async () => { throw new Error("steer channel is down"); });
  const service = new LunaControllerService({ store, adapter, evidenceProjector: testEvidenceProjector, clock: { now: () => 2_001 } });
  const runFence = { ...fence, signal: AbortSignal.timeout(2_000) };

  await expect(service.reconcile(runFence, runFence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "submitted",
    supervisorSteers: 0,
  });
});

it("budgets this turn's tokens, not the whole thread's history", async () => {
  const { store, fence } = storeFixture("token-baseline");
  const turn = submittedTurn(store, fence);
  // A controller thread answers many messages; BB reports tokens cumulatively
  // for the thread, so a week-old thread opens far above the hard budget.
  const lifetime = SUPERVISOR_HARD_TOKENS + 25_000;
  let seq = 1;
  const adapter = serviceAdapter(
    () => observation({ latestSeq: (seq += 1), totalTokens: lifetime }),
    () => "active",
  );
  const service = new LunaControllerService({ store, adapter, evidenceProjector: testEvidenceProjector, clock: { now: () => 2_001 } });
  const runFence = { ...fence, signal: AbortSignal.timeout(2_000) };

  await expect(service.reconcile(runFence, runFence.signal)).resolves.toBe(true);

  // The turn itself has spent nothing yet, so it must still be running.
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "submitted",
    tokenBaseline: lifetime,
  });
  expect(adapter.steer).not.toHaveBeenCalled();

  // Once this turn genuinely spends past the hard budget, it is stopped.
  const spent = lifetime + SUPERVISOR_HARD_TOKENS;
  const busy = serviceAdapter(
    () => observation({ latestSeq: (seq += 1), totalTokens: spent }),
    () => "active",
  );
  const second = new LunaControllerService({ store, adapter: busy, evidenceProjector: testEvidenceProjector, clock: { now: () => 2_002 } });
  await expect(second.reconcile(runFence, runFence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "failed",
    lastError: "Controller turn exceeded its budget",
  });
});
