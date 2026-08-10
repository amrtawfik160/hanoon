import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { hashSecret } from "../src/crypto";
import { ALL_MIGRATIONS } from "../src/storage/migrations";
import { IdempotencyConflictError, openStore } from "../src/storage/store";

let fixtureNumber = 0;

function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-controller-store-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.createPairingCode(hashSecret("pair-controller"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair-controller"), "7", "7", 1_001)).toEqual({ ok: true });
  return { bb, store };
}

function turnInput(updateId: number, inputText = "What can you do?") {
  return {
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId,
    inputText,
    now: 2_000,
  };
}

function acquire(store: ReturnType<typeof openStore>) {
  const lease = store.acquireExecutorLease("executor", 2_000, 30_000);
  if (!lease.acquired) throw new Error("missing executor lease");
  return { ownerId: "executor", generation: lease.generation, now: 2_000, leaseMs: 30_000 };
}

it("appends one controller migration", () => {
  expect(ALL_MIGRATIONS).toHaveLength(4);
  expect(ALL_MIGRATIONS.at(-1)).toContain("CREATE TABLE controller_threads");
  expect(ALL_MIGRATIONS.at(-1)).toContain("CREATE TABLE controller_turns");
});

it("enqueues Telegram controller turns idempotently and rejects changed replay input", () => {
  const { store } = fixture();

  const first = store.enqueueControllerTurn(turnInput(101));

  expect(first).toMatchObject({
    controllerKey: "owner-7-controller",
    updateId: 101,
    ordinal: 1,
    inputText: "What can you do?",
    state: "queued",
  });
  expect(store.enqueueControllerTurn(turnInput(101))).toEqual(first);
  expect(() => store.enqueueControllerTurn(turnInput(101, "different"))).toThrow(IdempotencyConflictError);
});

it("claims exactly one FIFO turn while a controller turn is dispatching or submitted", () => {
  const { store } = fixture();
  const first = store.enqueueControllerTurn(turnInput(201, "first"));
  store.enqueueControllerTurn(turnInput(202, "second"));
  const fence = acquire(store);

  expect(store.claimNextControllerTurn(fence)).toMatchObject({ id: first.id, ordinal: 1, state: "dispatching" });
  expect(store.claimNextControllerTurn(fence)).toBeNull();
  expect(store.markControllerSpawned({
    turnId: first.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: first.id, ...fence })).toBe(true);
  expect(store.claimNextControllerTurn(fence)).toBeNull();
  expect(store.completeControllerTurn({ turnId: first.id, ...fence, responseText: "Hello." })).toBe(true);
  expect(store.claimNextControllerTurn(fence)).toMatchObject({ updateId: 202, ordinal: 2 });
});

it("fences controller mutations against a stale executor generation", () => {
  const { store } = fixture();
  const turn = store.enqueueControllerTurn(turnInput(301));
  const fence = acquire(store);
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);

  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation + 1,
    now: fence.now,
    leaseMs: fence.leaseMs,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_stale",
  })).toBe(false);
  expect(store.getControllerForOwner("7", "7")?.threadId).toBeNull();
});

it("fails a stale uncertain dispatch closed so the FIFO can continue", () => {
  const { store } = fixture();
  const first = store.enqueueControllerTurn(turnInput(351, "first"));
  store.enqueueControllerTurn(turnInput(352, "second"));
  const firstFence = acquire(store);
  expect(store.claimNextControllerTurn(firstFence)?.id).toBe(first.id);
  const successor = store.acquireExecutorLease("successor", 32_001, 30_000);
  if (!successor.acquired) throw new Error("missing successor lease");

  expect(store.failStaleControllerDispatches({
    ownerId: "successor",
    generation: successor.generation,
    now: 32_001,
  })).toBe(true);

  expect(store.listControllerTurns("owner-7-controller", 10).map((turn) => turn.state)).toEqual(["failed", "queued"]);
  expect(store.getOutbox(`controller:${first.id}:reply`)).toMatchObject({ status: "pending" });
  expect(store.claimNextControllerTurn({
    ownerId: "successor",
    generation: successor.generation,
    now: 32_001,
  })).toMatchObject({ updateId: 352, state: "dispatching" });
});

it("rejects credential-shaped controller failure text", () => {
  const { store } = fixture();
  const turn = store.enqueueControllerTurn(turnInput(401));
  const fence = acquire(store);
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);

  expect(() => store.failControllerTurn({
    turnId: turn.id,
    ...fence,
    error: "token=do-not-persist",
  })).toThrow(/credential/i);
  expect(store.listControllerTurns("owner-7-controller", 10)[0]?.state).toBe("dispatching");
});

it("does not expose a controller mapping after its paired owner is revoked", () => {
  const { store } = fixture();
  const turn = store.enqueueControllerTurn(turnInput(501));
  const fence = acquire(store);
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_owner",
  })).toBe(true);

  expect(store.getControllerByThreadId("thr_owner")?.controllerKey).toBe("owner-7-controller");
  expect(store.getControllerForOwner("7", "7")?.threadId).toBe("thr_owner");
  expect(store.revokeOwner(2_001)).toBe(true);
  expect(store.getControllerByThreadId("thr_owner")).toBeNull();
  expect(store.getControllerForOwner("7", "7")).toBeNull();
});

it("starts a fresh controller mapping after the same identity is revoked and paired again", () => {
  const { store } = fixture();
  const turn = store.enqueueControllerTurn(turnInput(551));
  const fence = acquire(store);
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_old_context",
  })).toBe(true);
  expect(store.revokeOwner(2_001)).toBe(true);
  store.createPairingCode(hashSecret("pair-again"), 2_002, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair-again"), "7", "7", 2_003)).toEqual({ ok: true });
  expect(store.getControllerForOwner("7", "7")).toBeNull();

  store.enqueueControllerTurn(turnInput(552, "fresh context"));

  expect(store.getControllerForOwner("7", "7")).toMatchObject({
    state: "pending_spawn",
    threadId: null,
    projectId: null,
    hostId: null,
  });
});
