import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";
import {
  BbControllerAdapter,
  type ControllerAdapter,
} from "../src/controller/bb-controller";
import {
  DEFAULT_CONTROLLER_EXECUTION_PROFILE,
  type ControllerExecutionProfile,
} from "../src/controller/execution-profile";
import { LunaControllerService } from "../src/controller/service";

function personalProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "proj_personal",
    kind: "personal",
    name: "Personal",
    gitRemoteUrl: null,
    createdAt: 1,
    updatedAt: 1,
    sources: [{
      id: "src_personal",
      projectId: "proj_personal",
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
      type: "local_path",
      hostId: "host_personal",
      path: "/personal",
    }],
    ...overrides,
  };
}

function controllerRecord(overrides: Record<string, unknown> = {}) {
  return {
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    projectId: null,
    hostId: null,
    threadId: null,
    state: "pending_spawn",
    pendingSpawnToken: "controller-turn-1",
    lastError: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  } as const;
}

function turnRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "controller-turn-1",
    updateId: 1,
    controllerKey: "owner-7-controller",
    ordinal: 1,
    inputText: "What projects can you work on?",
    state: "dispatching",
    leaseOwner: "executor",
    leaseGeneration: 1,
    dispatchAfterSeq: 0,
    retryCount: 0,
    bbEventSeq: 0,
    streamText: "",
    telegramMessageId: null,
    streamPhase: "queued",
    responseText: null,
    lastError: null,
    submittedAt: null,
    completedAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  } as const;
}

function sdkFixture(options: {
  projects?: unknown[];
  threads?: unknown[];
  hosts?: unknown[];
  events?: unknown[];
  executionProfile?: ControllerExecutionProfile;
} = {}) {
  const spawn = vi.fn(async () => ({ id: "thr_controller", environmentId: "env_personal" }));
  const send = vi.fn(async () => ({ ok: true }));
  const list = vi.fn(async () => options.threads ?? []);
  const get = vi.fn(async () => ({ id: "thr_controller", status: "idle", archivedAt: null, deletedAt: null }));
  const output = vi.fn(async () => ({ output: "Hello from Luna." }));
  const eventsList = vi.fn(async () => options.events ?? []);
  const sdk = {
    projects: { list: vi.fn(async () => options.projects ?? [personalProject()]) },
    hosts: { list: vi.fn(async () => options.hosts ?? [{ id: "host_personal", status: "connected" }]) },
    threads: { spawn, send, list, get, output, events: { list: eventsList } },
  } as unknown as BbPluginApi["sdk"];
  const dependencies = {
    sdk,
    pluginId: "telegram-agent",
    executionProfile: () => options.executionProfile ?? DEFAULT_CONTROLLER_EXECUTION_PROFILE,
  };
  return { adapter: new BbControllerAdapter(dependencies), spawn, send, list, eventsList };
}

it("spawns the hidden personal controller with the exact Luna Max execution tuple", async () => {
  const { adapter, spawn } = sdkFixture();

  await adapter.spawn(turnRecord(), controllerRecord(), AbortSignal.timeout(1_000));

  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
    projectId: "proj_personal",
    providerId: "codex",
    model: "gpt-5.6-luna",
    reasoningLevel: "max",
    serviceTier: "fast",
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
      serviceTier: "explicit",
      permissionMode: "explicit",
    },
    input: [{ type: "text", text: expect.stringContaining("What projects can you work on?"), mentions: [] }],
  }));
});

it("keeps the exact Luna Max fast execution tuple on later controller turns", async () => {
  const { adapter, send } = sdkFixture();

  await adapter.send("thr_controller", "Show active threads", AbortSignal.timeout(1_000));

  expect(send).toHaveBeenCalledWith({
    threadId: "thr_controller",
    mode: "start",
    model: "gpt-5.6-luna",
    reasoningLevel: "max",
    serviceTier: "fast",
    permissionMode: "auto",
    executionInputSources: {
      model: "explicit",
      reasoningLevel: "explicit",
      serviceTier: "explicit",
      permissionMode: "explicit",
    },
    input: [{ type: "text", text: "Show active threads", mentions: [] }],
  });
});

it("reduces BB controller events after the durable sequence without exposing reasoning", async () => {
  const events = [
    { id: "e11", threadId: "thr_controller", seq: 11, createdAt: 11, scope: { kind: "thread" }, type: "turn/input/accepted", data: {} },
    { id: "e12", threadId: "thr_controller", seq: 12, createdAt: 12, scope: { kind: "thread" }, type: "item/reasoning/textDelta", data: { delta: "private chain" } },
    { id: "e13", threadId: "thr_controller", seq: 13, createdAt: 13, scope: { kind: "thread" }, type: "item/agentMessage/delta", data: { delta: "Hello" } },
    { id: "e14", threadId: "thr_controller", seq: 14, createdAt: 14, scope: { kind: "thread" }, type: "turn/completed", data: {} },
  ];
  const { adapter, eventsList } = sdkFixture({ events });
  const signal = AbortSignal.timeout(1_000);

  await expect(adapter.events("thr_controller", 10, signal)).resolves.toEqual({
    latestSeq: 14,
    inputAccepted: true,
    assistantDelta: "Hello",
    completed: true,
    error: null,
  });
  expect(eventsList).toHaveBeenCalledWith({
    threadId: "thr_controller",
    afterSeq: "10",
    limit: "100",
    signal,
  });
});

it("uses the only connected host when the personal project has no source binding", async () => {
  const { adapter, spawn } = sdkFixture({
    projects: [personalProject({ sources: [] })],
    hosts: [
      { id: "host_offline", status: "disconnected" },
      { id: "host_connected", status: "connected" },
    ],
  });

  await adapter.spawn(turnRecord(), controllerRecord(), AbortSignal.timeout(1_000));

  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
    projectId: "proj_personal",
    environment: {
      type: "host",
      hostId: "host_connected",
      workspace: { type: "personal" },
    },
  }));
});

it("uses the configured execution profile for initial and later controller turns", async () => {
  const executionProfile: ControllerExecutionProfile = {
    model: "gpt-5.6-terra",
    reasoningLevel: "high",
    serviceTier: "default",
    permissionMode: "accept-edits",
  };
  const { adapter, spawn, send } = sdkFixture({ executionProfile });

  await adapter.spawn(turnRecord(), controllerRecord(), AbortSignal.timeout(1_000));
  await adapter.send("thr_controller", "Show active threads", AbortSignal.timeout(1_000));

  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
    providerId: "codex",
    title: "Telegram Codex controller owner-7-controller",
    ...executionProfile,
    executionInputSources: {
      providerId: "explicit",
      model: "explicit",
      reasoningLevel: "explicit",
      serviceTier: "explicit",
      permissionMode: "explicit",
    },
  }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    threadId: "thr_controller",
    ...executionProfile,
    executionInputSources: {
      model: "explicit",
      reasoningLevel: "explicit",
      serviceTier: "explicit",
      permissionMode: "explicit",
    },
  }));
});

it("fails closed when an unbound personal project has multiple connected hosts", async () => {
  const { adapter, spawn } = sdkFixture({
    projects: [personalProject({ sources: [] })],
    hosts: [
      { id: "host_one", status: "connected" },
      { id: "host_two", status: "connected" },
    ],
  });

  await expect(adapter.spawn(turnRecord(), controllerRecord(), AbortSignal.timeout(1_000)))
    .rejects.toThrow(/connected host|ambiguous/i);
  expect(spawn).not.toHaveBeenCalled();
});

it.each([
  ["missing personal project", []],
  ["missing default host", [personalProject({ sources: [{ ...personalProject().sources[0], hostId: "" }] })]],
  ["ambiguous personal source", [personalProject({ sources: [
    { ...personalProject().sources[0], isDefault: false, id: "one" },
    { ...personalProject().sources[0], isDefault: false, id: "two" },
  ] })]],
])("fails closed for %s", async (_label, projects) => {
  const { adapter, spawn } = sdkFixture({ projects });
  await expect(adapter.spawn(turnRecord(), controllerRecord(), AbortSignal.timeout(1_000))).rejects.toThrow(/personal|source|host/i);
  expect(spawn).not.toHaveBeenCalled();
});

it("adopts only one exact plugin-origin hidden spawn candidate", async () => {
  const candidate = {
    id: "thr_candidate",
    projectId: "proj_personal",
    providerId: "codex",
    status: "idle",
    title: "Telegram Luna controller owner-7-controller",
    visibility: "hidden",
    originPluginId: "telegram-agent",
    archivedAt: null,
    deletedAt: null,
  };
  const one = sdkFixture({ threads: [candidate] });
  await expect(one.adapter.findSpawnCandidate("owner-7-controller", AbortSignal.timeout(1_000))).resolves.toMatchObject({
    threadId: "thr_candidate",
    projectId: "proj_personal",
    hostId: "host_personal",
  });

  const ambiguous = sdkFixture({ threads: [candidate, { ...candidate, id: "thr_other" }] });
  await expect(ambiguous.adapter.findSpawnCandidate("owner-7-controller", AbortSignal.timeout(1_000))).rejects.toThrow(/multiple|ambiguous/i);
});

it("does not re-adopt the errored production controller during recovery", async () => {
  const poisoned = {
    id: "thr_n2uyc2p445",
    projectId: "proj_personal",
    providerId: "codex",
    status: "error",
    title: "Telegram Luna controller owner-7-controller",
    visibility: "hidden",
    originPluginId: "telegram-agent",
    archivedAt: null,
    deletedAt: null,
  };
  const { adapter } = sdkFixture({ threads: [poisoned] });

  await expect(adapter.findSpawnCandidate("owner-7-controller", AbortSignal.timeout(1_000))).resolves.toBeNull();
});

let serviceFixtureNumber = 0;
function serviceFixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-controller-service-${serviceFixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.createPairingCode(hashSecret("pair"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", 1_001)).toEqual({ ok: true });
  const lease = store.acquireExecutorLease("executor", 2_000, 30_000);
  if (!lease.acquired) throw new Error("missing lease");
  const fence = { ownerId: "executor", generation: lease.generation, signal: AbortSignal.timeout(2_000) };
  return { store, fence };
}

it("dispatches FIFO, waits for idle output, and then sends the next turn with mode start", async () => {
  const { store, fence } = serviceFixture();
  store.enqueueControllerTurn({ ...turnRecord({ updateId: 11, inputText: "first" }), telegramUserId: "7", telegramChatId: "7", now: 2_000 });
  store.enqueueControllerTurn({ ...turnRecord({ updateId: 12, inputText: "second" }), telegramUserId: "7", telegramChatId: "7", now: 2_001 });
  let status: "active" | "idle" = "active";
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "thr_controller", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: async () => status,
    output: vi.fn(async () => "First answer."),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantDelta: "", completed: false, error: null })),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_000 } });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(false);
  expect(store.listControllerTurns("owner-7-controller", 10).map((turn) => turn.state)).toEqual(["submitted", "queued"]);

  status = "idle";
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getOutbox("controller:controller-turn-11:reply")?.payload.text).toBe("First answer.");
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(adapter.send).toHaveBeenCalledWith("thr_controller", "second", fence.signal);
  expect(store.listControllerTurns("owner-7-controller", 10).map((turn) => turn.state)).toEqual(["completed", "submitted"]);
});

it("fails an uncertain send closed and never submits it twice", async () => {
  const { store, fence } = serviceFixture();
  store.enqueueControllerTurn({ ...turnRecord({ updateId: 21, inputText: "send once" }), telegramUserId: "7", telegramChatId: "7", now: 2_000 });
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "thr_controller", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => { throw new Error("uncertain send"); }),
    status: vi.fn(async () => "idle" as const),
    output: vi.fn(async () => "unused"),
    events: vi.fn(async () => ({ latestSeq: 22, inputAccepted: true, assistantDelta: "", completed: false, error: "Controller provider turn failed" })),
    findSpawnCandidate: vi.fn(async () => ({ threadId: "thr_controller", projectId: "proj_personal", hostId: "host_personal" })),
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_000 } });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })).not.toBeNull();
  expect(store.markControllerSpawned({
    turnId: "controller-turn-21",
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
  })).toBe(true);
  expect(store.failControllerTurn({
    turnId: "controller-turn-21",
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    error: "setup",
  })).toBe(true);
  store.enqueueControllerTurn({ ...turnRecord({ updateId: 22, inputText: "send once" }), telegramUserId: "7", telegramChatId: "7", now: 2_001 });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(false);
  expect(adapter.send).toHaveBeenCalledTimes(1);
  expect(store.listControllerTurns("owner-7-controller", 10).at(-1)?.state).toBe("failed");
});

it("keeps an idle submitted turn durable when BB output retrieval fails transiently", async () => {
  const { store, fence } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 31, inputText: "answer after retry" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
  })).toBe(true);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    output: vi.fn(async () => { throw new Error("temporary BB output failure"); }),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantDelta: "", completed: false, error: null })),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_000 } });

  await expect(service.reconcile(fence, fence.signal)).rejects.toThrow("temporary BB output failure");

  expect(store.listControllerTurns("owner-7-controller", 10)[0]?.state).toBe("submitted");
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    status: "pending",
    payload: { text: "Connecting to Luna Max…" },
  });
});

it("projects active Luna assistant deltas into the durable controller reply", async () => {
  const { store, fence } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 36, inputText: "stream answer" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })?.id)
    .toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_streaming",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    dispatchAfterSeq: 8,
    now: 2_000,
  })).toBe(true);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    output: vi.fn(async () => "unused"),
    events: vi.fn(async () => ({
      latestSeq: 10,
      inputAccepted: true,
      assistantDelta: "Working on it",
      completed: false,
      error: null,
    })),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_001 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(adapter.events).toHaveBeenCalledWith("thr_streaming", 8, fence.signal);
  expect(store.listControllerTurns("owner-7-controller", 10)[0]).toMatchObject({
    bbEventSeq: 10,
    streamText: "Working on it",
    streamPhase: "responding",
  });
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    status: "pending",
    payload: { text: "Working on it" },
  });
});

it("refreshes an unchanged active Luna draft before Telegram expires it", async () => {
  const { store, fence } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 37, inputText: "keep thinking" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })?.id)
    .toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_thinking",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
  })).toBe(true);
  const [draft] = store.leaseOutbox(fence.ownerId, fence.generation, 2_000, 1, 30_000);
  expect(store.completeOutbox(draft!.logicalKey, fence.ownerId, fence.generation, null, 2_000)).toBe(true);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    output: vi.fn(async () => "unused"),
    events: vi.fn(async () => ({
      latestSeq: 0,
      inputAccepted: true,
      assistantDelta: "",
      completed: false,
      error: null,
    })),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 22_000 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    status: "pending",
    messageId: null,
  });
});

it("retires an errored controller so a later queued message can start a fresh generation", async () => {
  const { store, fence } = serviceFixture();
  const failed = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 41, inputText: "show active threads" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  store.enqueueControllerTurn({
    ...turnRecord({ updateId: 42, inputText: "try again" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_001,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })?.id)
    .toBe(failed.id);
  expect(store.markControllerSpawned({
    turnId: failed.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_poisoned",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: failed.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
  })).toBe(true);
  const spawn = vi.fn(async () => ({
    threadId: "thr_fresh",
    projectId: "proj_personal",
    hostId: "host_personal",
  }));
  const adapter: ControllerAdapter = {
    spawn,
    send: vi.fn(async () => undefined),
    status: vi.fn(async (threadId: string) => threadId === "thr_poisoned" ? "error" : "active"),
    output: vi.fn(async () => "unused"),
    events: vi.fn(async () => ({ latestSeq: 22, inputAccepted: true, assistantDelta: "", completed: false, error: "Controller provider turn failed" })),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_002 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.listControllerTurns("owner-7-controller", 10).map((turn) => turn.state))
    .toEqual(["failed", "queued"]);
  expect(store.getControllerForOwner("7", "7")).toMatchObject({
    threadId: null,
    state: "pending_spawn",
  });
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(store.getControllerForOwner("7", "7")?.threadId).toBe("thr_fresh");
});

it("recovers from the 2026-08-10 poisoned controller before dispatching the next message", async () => {
  const { store, fence } = serviceFixture();
  const previous = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 46, inputText: "previous failed request" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })?.id)
    .toBe(previous.id);
  expect(store.markControllerSpawned({
    turnId: previous.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_poisoned_idle",
  })).toBe(true);
  expect(store.failControllerTurn({
    turnId: previous.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_001,
    error: "Controller provider turn failed",
  })).toBe(true);
  const next = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 47, inputText: "show active threads" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_002,
  });
  const spawn = vi.fn(async () => ({
    threadId: "thr_fresh_after_poison",
    projectId: "proj_personal",
    hostId: "host_personal",
  }));
  const adapter: ControllerAdapter = {
    spawn,
    send: vi.fn(async () => undefined),
    status: vi.fn(async (threadId: string) => threadId === "thr_poisoned_idle" ? "error" : "active"),
    output: vi.fn(async () => "unused"),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantDelta: "", completed: false, error: null })),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_003 } });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);

  expect(store.listControllerTurns("owner-7-controller", 10).at(-1)).toMatchObject({
    id: next.id,
    state: "submitted",
  });
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(store.getControllerForOwner("7", "7")?.threadId).toBe("thr_fresh_after_poison");
});

it("retires an errored controller generation even when no turn remains submitted", async () => {
  const { store, fence } = serviceFixture();
  const previous = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 48, inputText: "provider initialization timed out" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })?.id)
    .toBe(previous.id);
  expect(store.markControllerSpawned({
    turnId: previous.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_initialize_timeout",
  })).toBe(true);
  expect(store.failControllerTurn({
    turnId: previous.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_001,
    error: "Controller send outcome is uncertain",
  })).toBe(true);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "error" as const),
    output: vi.fn(async () => "unused"),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantDelta: "", completed: false, error: null })),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_002 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerForOwner("7", "7")).toMatchObject({
    threadId: null,
    state: "pending_spawn",
  });
});

it("retries one controller generation when BB proves the input was never accepted", async () => {
  const { store, fence } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 51, inputText: "show active threads" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })?.id)
    .toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_never_accepted",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    dispatchAfterSeq: 9,
    now: 2_000,
  })).toBe(true);
  const spawn = vi.fn(async () => ({
    threadId: "thr_retry",
    projectId: "proj_personal",
    hostId: "host_personal",
  }));
  const adapter: ControllerAdapter = {
    spawn,
    send: vi.fn(async () => undefined),
    status: vi.fn(async (threadId: string) => threadId === "thr_never_accepted" ? "error" : "active"),
    output: vi.fn(async () => "unused"),
    events: vi.fn(async () => ({
      latestSeq: 11,
      inputAccepted: false,
      assistantDelta: "",
      completed: false,
      error: "Controller provider turn failed",
    })),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_002 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.listControllerTurns("owner-7-controller", 10)[0]).toMatchObject({
    state: "queued",
    retryCount: 1,
    dispatchAfterSeq: 0,
  });
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    status: "pending",
    payload: { text: "Connecting to Luna Max…" },
  });
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(store.getControllerForOwner("7", "7")?.threadId).toBe("thr_retry");
});
