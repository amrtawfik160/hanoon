import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";
import {
  BbControllerAdapter,
  CONTROLLER_MODEL,
  CONTROLLER_PERMISSION,
  CONTROLLER_PROVIDER,
  CONTROLLER_REASONING,
  type ControllerAdapter,
} from "../src/controller/bb-controller";
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
    responseText: null,
    lastError: null,
    submittedAt: null,
    completedAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  } as const;
}

function sdkFixture(options: { projects?: unknown[]; threads?: unknown[] } = {}) {
  const spawn = vi.fn(async () => ({ id: "thr_controller", environmentId: "env_personal" }));
  const send = vi.fn(async () => ({ ok: true }));
  const list = vi.fn(async () => options.threads ?? []);
  const get = vi.fn(async () => ({ id: "thr_controller", status: "idle", archivedAt: null, deletedAt: null }));
  const output = vi.fn(async () => ({ output: "Hello from Luna." }));
  const sdk = {
    projects: { list: vi.fn(async () => options.projects ?? [personalProject()]) },
    threads: { spawn, send, list, get, output },
  } as unknown as BbPluginApi["sdk"];
  return { adapter: new BbControllerAdapter({ sdk, pluginId: "telegram-agent" }), spawn, send, list };
}

it("spawns the hidden personal controller with the exact Luna Max execution tuple", async () => {
  const { adapter, spawn } = sdkFixture();

  await adapter.spawn(turnRecord(), controllerRecord(), AbortSignal.timeout(1_000));

  expect({ CONTROLLER_PROVIDER, CONTROLLER_MODEL, CONTROLLER_REASONING, CONTROLLER_PERMISSION }).toEqual({
    CONTROLLER_PROVIDER: "codex",
    CONTROLLER_MODEL: "gpt-5.6-luna",
    CONTROLLER_REASONING: "max",
    CONTROLLER_PERMISSION: "auto",
  });
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
    input: [{ type: "text", text: expect.stringContaining("What projects can you work on?"), mentions: [] }],
  }));
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
