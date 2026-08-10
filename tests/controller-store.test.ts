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

it("keeps controller and operation migrations before the appended pipeline migration", () => {
  expect(ALL_MIGRATIONS).toHaveLength(9);
  expect(ALL_MIGRATIONS.at(-6)).toContain("CREATE TABLE controller_threads");
  expect(ALL_MIGRATIONS.at(-6)).toContain("CREATE TABLE controller_turns");
  expect(ALL_MIGRATIONS.at(-5)).toContain("dispatch_after_seq");
  expect(ALL_MIGRATIONS.at(-5)).toContain("telegram_message_id");
  expect(ALL_MIGRATIONS.at(-4)).toContain("CREATE TABLE thread_operations");
  expect(ALL_MIGRATIONS.at(-3)).toContain("CREATE TABLE pipeline_stage_attempts");
  expect(ALL_MIGRATIONS.at(-2)).toContain("documentation_thread_id");
  expect(ALL_MIGRATIONS.at(-1)).toContain("merge_commit_sha");
  expect(ALL_MIGRATIONS.at(-1)).toContain("production_failed");
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
    dispatchAfterSeq: 0,
    retryCount: 0,
    bbEventSeq: 0,
    streamText: "",
    telegramMessageId: null,
    streamPhase: "queued",
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

it("requeues one unaccepted controller turn in a fresh generation without losing FIFO order", () => {
  const { store } = fixture();
  const first = store.enqueueControllerTurn(turnInput(371, "first"));
  store.enqueueControllerTurn(turnInput(372, "second"));
  const fence = acquire(store);
  expect(store.claimNextControllerTurn(fence)?.id).toBe(first.id);
  expect(store.markControllerSpawned({
    turnId: first.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_failed_init",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: first.id, dispatchAfterSeq: 21, ...fence })).toBe(true);

  expect(store.retryUnacceptedControllerTurn({
    turnId: first.id,
    controllerKey: "owner-7-controller",
    expectedThreadId: "thr_failed_init",
    ...fence,
  })).toBe(true);

  expect(store.listControllerTurns("owner-7-controller", 10)).toMatchObject([
    { id: first.id, state: "queued", retryCount: 1, dispatchAfterSeq: 0 },
    { updateId: 372, state: "queued", retryCount: 0 },
  ]);
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ threadId: null, state: "pending_spawn" });
  expect(store.claimNextControllerTurn(fence)).toMatchObject({ id: first.id, state: "dispatching", retryCount: 1 });
});

it("keeps one durable Telegram message id from controller placeholder through live edits", () => {
  const { store } = fixture();
  const turn = store.enqueueControllerTurn(turnInput(381, "stream this"));
  const fence = acquire(store);
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_stream",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: turn.id, dispatchAfterSeq: 7, ...fence })).toBe(true);
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    messageId: null,
    status: "pending",
    payload: { text: "Connecting to Luna Max…" },
  });

  const leased = store.leaseOutbox(fence.ownerId, fence.generation, fence.now, 10, 30_000);
  expect(leased).toHaveLength(1);
  expect(store.completeOutbox(leased[0]!.logicalKey, fence.ownerId, fence.generation, 501, fence.now)).toBe(true);
  expect(store.listControllerTurns("owner-7-controller", 10)[0]?.telegramMessageId).toBe(501);

  expect(store.updateControllerStream({
    turnId: turn.id,
    cursor: 9,
    text: "Hello",
    phase: "responding",
    ...fence,
  })).toBe(true);
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    messageId: 501,
    status: "pending",
    payload: { text: "Hello" },
  });
  const edit = store.leaseOutbox(fence.ownerId, fence.generation, fence.now, 10, 30_000);
  expect(edit).toHaveLength(1);
  expect(store.completeOutbox(edit[0]!.logicalKey, fence.ownerId, fence.generation, 501, fence.now)).toBe(true);
  expect(store.completeControllerTurn({ turnId: turn.id, responseText: "Hello final", ...fence })).toBe(true);
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    messageId: 501,
    status: "pending",
    payload: { text: "Hello final" },
  });
});

it("refreshes an unchanged ephemeral controller draft before Telegram expires it", () => {
  const { store } = fixture();
  const turn = store.enqueueControllerTurn(turnInput(391, "think for a while"));
  const fence = acquire(store);
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_slow",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: turn.id, ...fence })).toBe(true);
  const leased = store.leaseOutbox(fence.ownerId, fence.generation, fence.now, 10, 30_000);
  expect(store.completeOutbox(leased[0]!.logicalKey, fence.ownerId, fence.generation, null, fence.now)).toBe(true);

  expect(store.refreshControllerDraft({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 21_999,
    sentBefore: 1_999,
  })).toBe(false);
  expect(store.refreshControllerDraft({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 22_000,
    sentBefore: 2_000,
  })).toBe(true);
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    status: "pending",
    messageId: null,
  });
  const refreshed = store.leaseOutbox(fence.ownerId, fence.generation, 22_000, 10, 30_000);
  expect(refreshed[0]?.attempts).toBe(1);
  expect(store.completeOutbox(refreshed[0]!.logicalKey, fence.ownerId, fence.generation, null, 22_000)).toBe(true);
  expect(store.updateControllerStream({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 23_000,
    cursor: 1,
    text: "Still working",
    phase: "responding",
  })).toBe(true);
  expect(store.leaseOutbox(fence.ownerId, fence.generation, 23_000, 10, 30_000)[0]?.attempts).toBe(1);
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
