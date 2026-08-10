import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import type { JobState } from "../src/domain/models";
import { openStore } from "../src/storage/store";
import {
  resolveTelegramPresenceTarget,
  TelegramPresenceCoordinator,
} from "../src/services/telegram-presence";
import {
  activeWorkerFixture,
  jobFixture,
} from "./helpers";

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

function jobPresenceStore(
  state: JobState,
  worker = activeWorkerFixture(),
) {
  const job = jobFixture({ state });
  return {
    getOwner: () => ({ userId: "7", chatId: "70" }),
    getControllerForOwner: () => null,
    listControllerTurns: () => [],
    getActiveJob: () => job,
    getWorkerLiveness: () => worker,
  };
}

describe("Telegram presence target resolution", () => {
  it("selects dispatching and submitted controller turns but not queued or completed turns", () => {
    const queued = controllerFixture();
    expect(resolveTelegramPresenceTarget(queued.store)).toBeNull();

    expect(queued.store.claimNextControllerTurn(queued.fence)).toMatchObject({ state: "dispatching" });
    expect(resolveTelegramPresenceTarget(queued.store)).toEqual({
      key: `controller:${queued.turn.id}`,
      chatId: "70",
    });

    expect(queued.store.markControllerSpawned({
      ...queued.fence,
      turnId: queued.turn.id,
      projectId: "proj_personal",
      hostId: "host_personal",
      threadId: "thr_controller",
    })).toBe(true);
    expect(queued.store.markControllerTurnSubmitted({ ...queued.fence, turnId: queued.turn.id })).toBe(true);
    expect(resolveTelegramPresenceTarget(queued.store)).toEqual({
      key: `controller:${queued.turn.id}`,
      chatId: "70",
    });

    expect(queued.store.completeControllerTurn({
      ...queued.fence,
      turnId: queued.turn.id,
      responseText: "Done.",
    })).toBe(true);
    expect(resolveTelegramPresenceTarget(queued.store)).toBeNull();
  });

  it("fails closed for failed turns, revoked owners, and missing controller mappings", () => {
    const failed = controllerFixture();
    expect(failed.store.claimNextControllerTurn(failed.fence)).toMatchObject({ state: "dispatching" });
    expect(failed.store.failControllerTurn({
      ...failed.fence,
      turnId: failed.turn.id,
      error: "provider failed",
    })).toBe(true);
    expect(resolveTelegramPresenceTarget(failed.store)).toBeNull();

    const revoked = controllerFixture();
    expect(revoked.store.claimNextControllerTurn(revoked.fence)).toMatchObject({ state: "dispatching" });
    expect(revoked.store.revokeOwner(2_001)).toBe(true);
    expect(resolveTelegramPresenceTarget(revoked.store)).toBeNull();

    const noController = jobPresenceStore("awaiting_project");
    expect(resolveTelegramPresenceTarget(noController)).toBeNull();
  });

  it.each([
    ["creating_implementation", "implementation", "starting"],
    ["implementing", "implementation", "active"],
    ["remediating", "implementation", "active"],
    ["reviewing", "review", "active"],
    ["validating", "validation", "active"],
  ] as const)("selects %s with an authoritative %s worker that is %s", (state, workerKind, workerState) => {
    const worker = activeWorkerFixture({ workerKind, state: workerState });

    expect(resolveTelegramPresenceTarget(jobPresenceStore(state, worker))).toEqual({
      key: `job:job_1:${workerKind}:${worker.generation}:${worker.resourceId}`,
      chatId: "70",
    });
  });

  it.each([
    ["implementing", "review", "active"],
    ["reviewing", "implementation", "active"],
    ["validating", "validation", "stopping"],
    ["validating", "validation", "idle"],
    ["validating", "validation", "failed"],
    ["validating", "validation", "unknown"],
    ["validating", "validation", "stale"],
    ["awaiting_merge_approval", "validation", "active"],
    ["merging", "merge", "active"],
    ["merged", "implementation", "active"],
    ["blocked", "implementation", "active"],
    ["cancelled", "implementation", "active"],
  ] as const)("does not select %s with worker %s/%s", (state, workerKind, workerState) => {
    expect(resolveTelegramPresenceTarget(jobPresenceStore(
      state,
      activeWorkerFixture({ workerKind, state: workerState }),
    ))).toBeNull();
  });
});

describe("Telegram presence heartbeat", () => {
  it("sends immediately, throttles the same work, and refreshes at four seconds", async () => {
    let worker = activeWorkerFixture();
    let active = true;
    const store = {
      getOwner: () => ({ userId: "7", chatId: "70" }),
      getControllerForOwner: () => null,
      listControllerTurns: () => [],
      getActiveJob: () => active ? jobFixture({ state: "implementing" }) : null,
      getWorkerLiveness: () => worker,
    };
    const sendChatAction = vi.fn(async () => undefined);
    const coordinator = new TelegramPresenceCoordinator({
      store,
      telegram: { sendChatAction },
      warn: vi.fn(),
    });
    const signal = AbortSignal.timeout(1_000);

    await expect(coordinator.pulse(1_000, signal)).resolves.toBe(4_000);
    await expect(coordinator.pulse(4_999, signal)).resolves.toBe(1);
    await expect(coordinator.pulse(5_000, signal)).resolves.toBe(4_000);
    expect(sendChatAction).toHaveBeenCalledTimes(2);

    worker = activeWorkerFixture({ generation: 3, resourceId: "thr_replacement" });
    await expect(coordinator.pulse(5_100, signal)).resolves.toBe(4_000);
    expect(sendChatAction).toHaveBeenCalledTimes(3);

    active = false;
    await expect(coordinator.pulse(5_200, signal)).resolves.toBeNull();
    active = true;
    await expect(coordinator.pulse(5_300, signal)).resolves.toBe(4_000);
    expect(sendChatAction).toHaveBeenCalledTimes(4);

    coordinator.reset();
    await expect(coordinator.pulse(5_400, signal)).resolves.toBe(4_000);
    expect(sendChatAction).toHaveBeenCalledTimes(5);
    expect(sendChatAction).toHaveBeenLastCalledWith("70", "typing", signal);
  });

  it("isolates and redacts a failed typing action without retrying before the deadline", async () => {
    const store = jobPresenceStore("implementing");
    const sendChatAction = vi.fn(async () => {
      throw new Error("bot123:supersecret rejected presence");
    });
    const warn = vi.fn();
    const coordinator = new TelegramPresenceCoordinator({
      store,
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
