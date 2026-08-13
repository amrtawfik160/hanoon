import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";
import {
  resolveTelegramPresenceTarget,
  TelegramPresenceCoordinator,
} from "../src/services/telegram-presence";
import type { JobLaneSnapshot } from "../src/services/job-lane-runner";
import { completeAcceptedControllerTurn } from "./support/controller-trust-fixtures";

let fixtureNumber = 0;

function controllerFixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-presence-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.createPairingCode(hashSecret("pair-presence"), 1_000, 10_000);
  expect(store.pairOwnerWithPrivateChatCode(hashSecret("pair-presence"), "7", "70", 1_001)).toEqual({ ok: true });
  const turn = store.enqueueControllerTurn({
    controllerKey: "owner-presence-controller",
    telegramUserId: "7",
    telegramChatId: "70",
    updateId: 101,
    inputText: "Explain the project",
    now: 2_000,
  });
  const lease = store.acquireExecutorLease("executor", 2_000, 30_000);
  if (!lease.acquired) throw new Error("missing executor lease");
  const fence = { ownerId: "executor", generation: lease.generation, now: 2_000 };
  return { store, turn, fence };
}

function jobPresenceStore() {
  return {
    getOwner: () => ({ userId: "7", chatId: "70" }),
    getControllerForOwner: () => null,
    getPendingControllerTurn: () => null,
  };
}

function laneSnapshots(overrides: Partial<JobLaneSnapshot> = {}) {
  return {
    snapshot: (): JobLaneSnapshot => ({
      pipelineActive: 0,
      controlActive: 0,
      busyJobIds: [],
      ...overrides,
    }),
  };
}

const emptyLanes = laneSnapshots();

describe("Telegram presence target resolution", () => {
  it("selects dispatching and submitted controller turns but not queued or completed turns", () => {
    const queued = controllerFixture();
    expect(resolveTelegramPresenceTarget(queued.store, emptyLanes)).toBeNull();

    expect(queued.store.claimNextControllerTurn(queued.fence)).toMatchObject({ state: "dispatching" });
    expect(resolveTelegramPresenceTarget(queued.store, emptyLanes)).toEqual({
      key: `controller:${queued.turn.id}`,
      chatId: "70",
    });

    expect(queued.store.reserveControllerSpawn({
      controllerKey: queued.turn.controllerKey,
      turnId: queued.turn.id,
      projectId: "proj_personal",
      hostId: "host_personal",
      now: queued.fence.now,
    })).toBe(true);
    expect(queued.store.markControllerSpawned({
      ...queued.fence,
      turnId: queued.turn.id,
      projectId: "proj_personal",
      hostId: "host_personal",
      threadId: "thr_controller",
      spawnToken: queued.turn.id,
    })).toBe(true);
    expect(queued.store.markControllerTurnSubmitted({ ...queued.fence, turnId: queued.turn.id })).toBe(true);
    expect(resolveTelegramPresenceTarget(queued.store, emptyLanes)).toEqual({
      key: `controller:${queued.turn.id}`,
      chatId: "70",
    });

    completeAcceptedControllerTurn(queued.store, queued.turn, queued.fence, "Done.");
    expect(resolveTelegramPresenceTarget(queued.store, emptyLanes)).toBeNull();
  });

  it("fails closed for failed turns, revoked owners, and missing controller mappings", () => {
    const failed = controllerFixture();
    expect(failed.store.claimNextControllerTurn(failed.fence)).toMatchObject({ state: "dispatching" });
    expect(failed.store.failControllerTurn({
      ...failed.fence,
      turnId: failed.turn.id,
      error: "provider failed",
    })).toBe(true);
    expect(resolveTelegramPresenceTarget(failed.store, emptyLanes)).toBeNull();

    const revoked = controllerFixture();
    expect(revoked.store.claimNextControllerTurn(revoked.fence)).toMatchObject({ state: "dispatching" });
    expect(revoked.store.revokeOwner(2_001)).toBe(true);
    expect(resolveTelegramPresenceTarget(revoked.store, emptyLanes)).toBeNull();

    const noController = jobPresenceStore();
    expect(resolveTelegramPresenceTarget(noController, emptyLanes)).toBeNull();
  });

  it.each([
    [1, 0],
    [0, 1],
    [2, 3],
  ] as const)("uses one constant aggregate target for %s pipeline and %s control lanes", (pipelineActive, controlActive) => {
    expect(resolveTelegramPresenceTarget(
      jobPresenceStore(),
      laneSnapshots({ pipelineActive, controlActive, busyJobIds: ["private-job-a", "private-job-b"] }),
    )).toEqual({
      key: "jobs:aggregate",
      chatId: "70",
    });
  });

  it("keeps an actively responding controller ahead of aggregate job presence", () => {
    const active = controllerFixture();
    expect(active.store.claimNextControllerTurn(active.fence)).toMatchObject({ state: "dispatching" });
    expect(resolveTelegramPresenceTarget(
      active.store,
      laneSnapshots({ pipelineActive: 2, busyJobIds: ["private-job"] }),
    )).toEqual({ key: `controller:${active.turn.id}`, chatId: "70" });
  });
});

describe("Telegram presence heartbeat", () => {
  it("sends immediately, throttles the same work, and refreshes at four seconds", async () => {
    let snapshot: JobLaneSnapshot = { pipelineActive: 1, controlActive: 0, busyJobIds: ["job-a"] };
    const store = jobPresenceStore();
    const jobLanes = { snapshot: () => snapshot };
    const sendChatAction = vi.fn(async () => undefined);
    const coordinator = new TelegramPresenceCoordinator({
      store,
      jobLanes,
      telegram: { sendChatAction },
      warn: vi.fn(),
    });
    const signal = AbortSignal.timeout(1_000);

    await expect(coordinator.pulse(1_000, signal)).resolves.toBe(4_000);
    await expect(coordinator.pulse(4_999, signal)).resolves.toBe(1);
    await expect(coordinator.pulse(5_000, signal)).resolves.toBe(4_000);
    expect(sendChatAction).toHaveBeenCalledTimes(2);

    snapshot = { pipelineActive: 0, controlActive: 1, busyJobIds: ["job-b"] };
    await expect(coordinator.pulse(5_100, signal)).resolves.toBe(3_900);
    expect(sendChatAction).toHaveBeenCalledTimes(2);

    snapshot = { pipelineActive: 0, controlActive: 0, busyJobIds: [] };
    await expect(coordinator.pulse(5_200, signal)).resolves.toBeNull();
    snapshot = { pipelineActive: 2, controlActive: 0, busyJobIds: ["job-c", "job-d"] };
    await expect(coordinator.pulse(5_300, signal)).resolves.toBe(4_000);
    expect(sendChatAction).toHaveBeenCalledTimes(3);

    coordinator.reset();
    await expect(coordinator.pulse(5_400, signal)).resolves.toBe(4_000);
    expect(sendChatAction).toHaveBeenCalledTimes(4);
    expect(sendChatAction).toHaveBeenLastCalledWith("70", "typing", signal);
  });

  it("isolates and redacts a failed typing action without retrying before the deadline", async () => {
    const store = jobPresenceStore();
    const sendChatAction = vi.fn(async () => {
      throw new Error("bot123:supersecret rejected presence");
    });
    const warn = vi.fn();
    const coordinator = new TelegramPresenceCoordinator({
      store,
      jobLanes: laneSnapshots({ pipelineActive: 1, busyJobIds: ["job-a"] }),
      telegram: { sendChatAction },
      warn,
    });
    const signal = AbortSignal.timeout(1_000);

    await expect(coordinator.pulse(1_000, signal)).resolves.toBe(4_000);
    await expect(coordinator.pulse(1_001, signal)).resolves.toBe(3_999);

    expect(sendChatAction).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("Telegram presence failed");
    expect(warn.mock.calls[0]?.[0]).not.toContain("supersecret");
    expect(String(warn.mock.calls[0]?.[0]).length).toBeLessThanOrEqual(500);
  });
});
