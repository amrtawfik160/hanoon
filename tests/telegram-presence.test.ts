import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";
import { completeTurnThroughFinalization } from "./support/controller-trust-fixtures";
import {
  resolveTelegramPresenceTarget,
  TelegramPresenceCoordinator,
} from "../src/services/telegram-presence";
import { TelegramApiError } from "../src/telegram/errors";

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

    completeTurnThroughFinalization(queued.store, queued.fence, {
      turnId: queued.turn.id,
      controllerKey: queued.turn.controllerKey,
      responseText: "Done.",
    });
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

    const noController = jobPresenceStore();
    expect(resolveTelegramPresenceTarget(noController)).toBeNull();
  });

  it("does not keep Telegram typing active without an owner-facing controller turn", () => {
    expect(resolveTelegramPresenceTarget(jobPresenceStore())).toBeNull();
  });

  it("keeps an actively responding controller visible", () => {
    const active = controllerFixture();
    expect(active.store.claimNextControllerTurn(active.fence)).toMatchObject({ state: "dispatching" });
    expect(resolveTelegramPresenceTarget(active.store))
      .toEqual({ key: `controller:${active.turn.id}`, chatId: "70" });
  });
});

describe("Telegram presence heartbeat", () => {
  it("sends immediately, throttles the same work, and refreshes at four seconds", async () => {
    const active = controllerFixture();
    expect(active.store.claimNextControllerTurn(active.fence)).toMatchObject({ state: "dispatching" });
    const sendChatAction = vi.fn(async () => undefined);
    const coordinator = new TelegramPresenceCoordinator({
      store: active.store,
      telegram: { sendChatAction },
      warn: vi.fn(),
    });
    const signal = AbortSignal.timeout(1_000);

    await expect(coordinator.pulse(1_000, signal)).resolves.toBe(4_000);
    await expect(coordinator.pulse(4_999, signal)).resolves.toBe(1);
    await expect(coordinator.pulse(5_000, signal)).resolves.toBe(4_000);
    expect(sendChatAction).toHaveBeenCalledTimes(2);

    coordinator.reset();
    await expect(coordinator.pulse(5_100, signal)).resolves.toBe(4_000);
    expect(sendChatAction).toHaveBeenCalledTimes(3);
    expect(sendChatAction).toHaveBeenLastCalledWith("70", "typing", signal);
  });

  it("isolates and redacts a failed typing action without retrying before the deadline", async () => {
    const active = controllerFixture();
    expect(active.store.claimNextControllerTurn(active.fence)).toMatchObject({ state: "dispatching" });
    const sendChatAction = vi.fn(async () => {
      throw new Error("bot123:supersecret rejected presence");
    });
    const warn = vi.fn();
    const coordinator = new TelegramPresenceCoordinator({
      store: active.store,
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

  it("honors Telegram retry_after after the 2026-08-12 presence-rate-limit incident", async () => {
    let turnId = "turn-before-rate-limit";
    const store = {
      getOwner: () => ({ userId: "7", chatId: "70" }),
      getControllerForOwner: () => ({ controllerKey: "controller" }),
      getPendingControllerTurn: () => ({ id: turnId, state: "submitted" as const }),
    };
    const sendChatAction = vi.fn()
      .mockRejectedValueOnce(new TelegramApiError({
        httpStatus: 429,
        errorCode: 429,
        description: "Too Many Requests: retry later",
        retryAfterSeconds: 30,
      }))
      .mockResolvedValue(undefined);
    const coordinator = new TelegramPresenceCoordinator({
      store,
      telegram: { sendChatAction },
      warn: vi.fn(),
    });
    const signal = AbortSignal.timeout(1_000);

    await expect(coordinator.pulse(1_000, signal)).resolves.toBe(31_000);
    turnId = "turn-after-rate-limit";
    await expect(coordinator.pulse(1_001, signal)).resolves.toBe(30_999);
    await expect(coordinator.pulse(5_000, signal)).resolves.toBe(27_000);
    expect(sendChatAction).toHaveBeenCalledOnce();

    await expect(coordinator.pulse(32_000, signal)).resolves.toBe(4_000);
    expect(sendChatAction).toHaveBeenCalledTimes(2);
  });

  it("leaves a safety margin after Telegram's retry_after deadline", async () => {
    const active = controllerFixture();
    expect(active.store.claimNextControllerTurn(active.fence)).toMatchObject({ state: "dispatching" });
    const sendChatAction = vi.fn(async () => {
      throw new TelegramApiError({
        httpStatus: 429,
        errorCode: 429,
        description: "Too Many Requests: retry later",
        retryAfterSeconds: 10,
      });
    });
    const coordinator = new TelegramPresenceCoordinator({
      store: active.store,
      telegram: { sendChatAction },
      warn: vi.fn(),
    });

    await expect(coordinator.pulse(1_000, AbortSignal.timeout(1_000))).resolves.toBe(11_000);
  });

  it("returns without waiting for a slow cosmetic typing request", async () => {
    const active = controllerFixture();
    expect(active.store.claimNextControllerTurn(active.fence)).toMatchObject({ state: "dispatching" });
    let resolveTyping!: () => void;
    const typing = new Promise<void>((resolve) => {
      resolveTyping = resolve;
    });
    const sendChatAction = vi.fn(() => typing);
    const coordinator = new TelegramPresenceCoordinator({
      store: active.store,
      telegram: { sendChatAction },
      warn: vi.fn(),
    });
    const pulse = coordinator.pulse(1_000, new AbortController().signal);

    try {
      await Promise.resolve();
      const returned = await Promise.race([
        pulse.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0)),
      ]);
      expect(returned).toBe(true);
      expect(sendChatAction).toHaveBeenCalledOnce();
    } finally {
      resolveTyping();
      await pulse;
    }
  });
});
