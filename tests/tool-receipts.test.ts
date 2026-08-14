import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { policyFixture } from "./helpers";
import { openStore } from "../src/storage/store";
import { registerControllerTools } from "../src/controller/tools";

const NOW = 1_800_000_000_000;
const CONTROLLER_KEY = "owner-7-controller";

let fixtureNumber = 0;
function fixture() {
  const { bb, harness } = createFakePluginHost({ pluginId: `telegram-agent-receipts-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => NOW);
  store.createPairingCode(hashSecret("pair-receipts"), NOW - 1_000, NOW + 20_000);
  expect(store.pairOwnerWithCode(hashSecret("pair-receipts"), "7", "7", NOW - 500)).toEqual({ ok: true });
  store.upsertProjectPolicy(policyFixture(), NOW - 400);
  const turn = store.enqueueControllerTurn({
    controllerKey: CONTROLLER_KEY,
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 4_001,
    inputText: "cancel the billing job",
    now: NOW,
  });
  const lease = store.acquireExecutorLease("executor", NOW, 60_000);
  if (!lease.acquired) throw new Error("missing lease");
  const fence = { ownerId: "executor", generation: lease.generation, now: NOW };
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  expect(store.reserveControllerSpawn({
    controllerKey: CONTROLLER_KEY,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    now: NOW,
  })).toBe(true);
  expect(store.markControllerSpawned({
    ...fence,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
    spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, turnId: turn.id })).toBe(true);
  return { bb, harness, store, turn, fence };
}

function callContext() {
  return { threadId: "thr_controller", projectId: "proj_personal" };
}

it("runs a mutating tool once per turn and replays its result afterwards", async () => {
  const { bb, harness, store } = fixture();
  const notify = vi.fn();
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify,
    now: () => NOW,
  });

  const first = await harness.behavior.callAgentTool(
    "telegram_agent_remember",
    { subject: "deploy window", body: "Only weekday mornings.", kind: "preference" },
    callContext(),
  );
  const replay = await harness.behavior.callAgentTool(
    "telegram_agent_remember",
    { subject: "deploy window", body: "Only weekday mornings.", kind: "preference" },
    callContext(),
  );

  const firstResult = JSON.parse(first as string);
  const replayResult = JSON.parse(replay as string);
  expect(replayResult.remembered).toEqual(firstResult.remembered);
  expect(firstResult._hanoonEvidence).toMatchObject({ ref: "evidence:1", outcome: "succeeded" });
  expect(replayResult._hanoonEvidence).toMatchObject({ ref: "evidence:2", outcome: "observed" });
  expect(store.countMemories("owner")).toBe(1);
  expect(store.listToolReceipts(store.getPendingControllerTurn(CONTROLLER_KEY)!.id)).toHaveLength(1);
  expect(store.listControllerEvidence(store.getPendingControllerTurn(CONTROLLER_KEY)!.id, 10)).toHaveLength(2);
});

it("treats different arguments as a different call", async () => {
  const { bb, harness, store } = fixture();
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => NOW,
  });

  await harness.behavior.callAgentTool(
    "telegram_agent_remember",
    { subject: "deploy window", body: "Only weekday mornings.", kind: "preference" },
    callContext(),
  );
  await harness.behavior.callAgentTool(
    "telegram_agent_remember",
    { subject: "review depth", body: "Always run the full suite.", kind: "preference" },
    callContext(),
  );

  expect(store.countMemories("owner")).toBe(2);
});

it("reports an interrupted call as uncertain instead of running it twice", async () => {
  const { bb, harness, store, turn } = fixture();
  const request = vi.fn(async () => ({
    id: "op_1",
    kind: "stop_thread" as const,
    threadId: "thr_watched",
    state: "awaiting_confirmation" as const,
    expiresAt: NOW + 60_000,
  }));
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => NOW,
  });
  // A previous generation started this exact call and never reported back.
  const claimed = store.claimToolReceipt({
    turnId: turn.id,
    toolName: "telegram_agent_request_thread_operation",
    argsSha256: "a".repeat(64),
    controllerKey: CONTROLLER_KEY,
    now: NOW,
  });
  expect(claimed).toEqual({ outcome: "fresh" });

  const replayed = store.claimToolReceipt({
    turnId: turn.id,
    toolName: "telegram_agent_request_thread_operation",
    argsSha256: "a".repeat(64),
    controllerKey: CONTROLLER_KEY,
    now: NOW + 1,
  });

  expect(replayed).toEqual({ outcome: "interrupted" });
  expect(request).not.toHaveBeenCalled();
});

it("retries only a failure recorded before the operation starts", () => {
  const { store, turn } = fixture();
  const key = {
    turnId: turn.id,
    toolName: "telegram_agent_create_thread",
    argsSha256: "b".repeat(64),
  };
  expect(store.claimToolReceipt({ ...key, controllerKey: CONTROLLER_KEY, now: NOW })).toEqual({ outcome: "fresh" });
  store.failToolReceipt({ ...key, error: "BB unreachable", now: NOW + 1 });

  expect(store.claimToolReceipt({ ...key, controllerKey: CONTROLLER_KEY, now: NOW + 2 }))
    .toEqual({ outcome: "interrupted" });

  const safeKey = { ...key, argsSha256: "d".repeat(64) };
  expect(store.claimToolReceipt({ ...safeKey, controllerKey: CONTROLLER_KEY, now: NOW + 3 }))
    .toEqual({ outcome: "fresh" });
  store.failToolReceipt({ ...safeKey, error: "authorization_failed", now: NOW + 4 });
  expect(store.claimToolReceipt({ ...safeKey, controllerKey: CONTROLLER_KEY, now: NOW + 5 }))
    .toEqual({ outcome: "fresh" });
});

it("keeps receipts of what the turn already did", () => {
  const { store, turn } = fixture();
  const key = { turnId: turn.id, toolName: "telegram_agent_cancel_job", argsSha256: "c".repeat(64) };
  store.claimToolReceipt({ ...key, controllerKey: CONTROLLER_KEY, now: NOW });
  store.completeToolReceipt({ ...key, result: '{"job":{"state":"cancelled"}}', now: NOW + 1 });

  expect(store.listToolReceipts(turn.id)).toEqual([
    { toolName: "telegram_agent_cancel_job", state: "completed", result: '{"job":{"state":"cancelled"}}' },
  ]);
});

it("keeps a retired controller thread as closed history rather than erasing it", () => {
  const { store, fence } = fixture();

  expect(store.listControllerGenerations(CONTROLLER_KEY, 10)).toMatchObject([
    { threadId: "thr_controller", endedAt: null, endReason: null },
  ]);

  expect(store.resetControllerThread({
    ...fence,
    controllerKey: CONTROLLER_KEY,
    expectedThreadId: "thr_controller",
    reason: "Controller provider turn failed",
  })).toBe(true);

  expect(store.listControllerGenerations(CONTROLLER_KEY, 10)).toMatchObject([
    { threadId: "thr_controller", endedAt: NOW, endReason: "Controller provider turn failed" },
  ]);
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ threadId: null, state: "pending_spawn" });
});
