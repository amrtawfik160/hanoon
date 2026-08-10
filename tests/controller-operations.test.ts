import { createFakePluginHost, makeThreadResponse } from "@bb/plugin-sdk/testing";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { ThreadOperationService } from "../src/controller/operations";
import { openStore } from "../src/storage/store";
import { parseCallbackData } from "../src/telegram/view";
import type { SendMessagePayload } from "../src/telegram/types";

let fixtureNumber = 0;

function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-controller-operations-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 1_000);
  store.createPairingCode(hashSecret("pair-operation"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair-operation"), "7", "7", 1_001)).toEqual({ ok: true });
  const send = vi.fn(async () => ({ ok: true as const }));
  const stop = vi.fn(async () => ({ ok: true as const }));
  const sdk = {
    threads: {
      get: vi.fn(async () => makeThreadResponse({
        id: "thr_target",
        projectId: "proj_1",
        title: "Fix billing",
        visibility: "visible",
        status: "active",
        archivedAt: null,
        deletedAt: null,
      })),
      send,
      stop,
      rateLimitRecovery: vi.fn(),
      continueAfterRateLimit: vi.fn(),
    },
  } as unknown as BbPluginApi["sdk"];
  const telegram = {
    sendMessage: vi.fn(async (_chatId: string, _payload: SendMessagePayload) => ({ message_id: 601 })),
  };
  const service = new ThreadOperationService({
    store,
    sdk,
    telegram,
    pluginId: "telegram-agent",
    clock: { now: () => 1_000 },
    randomBytes: (size) => Buffer.alloc(size, 7),
  });
  return { bb, store, sdk, telegram, service, send, stop };
}

it("binds one steer confirmation to the paired owner, message, target, and nonce hash", async () => {
  const { bb, store, telegram, service } = fixture();

  const requested = await service.request({
    kind: "steer_thread",
    threadId: "thr_target",
    text: "Focus on the failing test",
    signal: AbortSignal.timeout(1_000),
  });

  const payload = telegram.sendMessage.mock.calls[0]?.[1];
  const callbackData = payload?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data;
  if (typeof callbackData !== "string") throw new Error("confirmation callback was not rendered");
  const action = parseCallbackData(callbackData);
  expect(action.type).toBe("operation");
  if (action.type !== "operation") throw new Error("wrong callback action");
  const persisted = bb.storage.database().prepare(
    "SELECT nonce_hash, thread_id, operation_text, state, confirmation_message_id FROM thread_operations WHERE id = ?",
  ).get(requested.id) as Record<string, unknown>;
  expect(persisted).toMatchObject({
    nonce_hash: hashSecret(action.nonce),
    thread_id: "thr_target",
    operation_text: "Focus on the failing test",
    state: "awaiting_confirmation",
    confirmation_message_id: 601,
  });
  expect(JSON.stringify(persisted)).not.toContain(action.nonce);

  expect(store.confirmThreadOperation({
    nonceHash: hashSecret(action.nonce),
    userId: "7",
    chatId: "7",
    messageId: 602,
    now: 1_099,
  })).toEqual({ ok: false, reason: "missing" });
  expect(store.getThreadOperation(requested.id)).toMatchObject({ state: "awaiting_confirmation" });
  expect(store.confirmThreadOperation({
    nonceHash: hashSecret(action.nonce),
    userId: "7",
    chatId: "7",
    messageId: 601,
    now: 1_100,
  })).toMatchObject({ ok: true, operation: { id: requested.id, state: "confirmed" } });
  expect(store.confirmThreadOperation({
    nonceHash: hashSecret(action.nonce),
    userId: "7",
    chatId: "7",
    messageId: 601,
    now: 1_101,
  })).toEqual({ ok: false, reason: "consumed" });
});

it("executes one confirmed steer under the singleton fence and cannot replay it", async () => {
  const { store, service, send } = fixture();
  const requested = await service.request({
    kind: "steer_thread",
    threadId: "thr_target",
    text: "Focus on the failing test",
    signal: AbortSignal.timeout(1_000),
  });
  const operation = store.getThreadOperation(requested.id);
  if (!operation) throw new Error("operation was not stored");
  expect(store.confirmThreadOperation({
    nonceHash: operation.nonceHash,
    userId: "7",
    chatId: "7",
    messageId: 601,
    now: 1_100,
  }).ok).toBe(true);
  const lease = store.acquireExecutorLease("executor", 1_100, 30_000);
  if (!lease.acquired) throw new Error("executor lease unavailable");
  const fence = { ownerId: "executor", generation: lease.generation, signal: AbortSignal.timeout(1_000) };

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(false);

  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith({
    threadId: "thr_target",
    mode: "auto",
    input: [{ type: "text", text: "Focus on the failing test", mentions: [] }],
  });
  expect(store.getThreadOperation(requested.id)).toMatchObject({ state: "completed", result: "Steering sent" });
  expect(store.getOutbox(`thread-operation:${requested.id}:status`)).toMatchObject({
    messageId: 601,
    status: "pending",
    payload: {
      text: "Thread operation completed: Steering sent.",
      reply_markup: { inline_keyboard: [] },
    },
  });
});

it("rejects hidden BB targets before issuing a confirmation", async () => {
  const { sdk, telegram, service } = fixture();
  vi.mocked(sdk.threads.get).mockResolvedValueOnce(makeThreadResponse({
    id: "thr_hidden",
    visibility: "hidden",
  }));

  await expect(service.request({
    kind: "stop_thread",
    threadId: "thr_hidden",
    signal: AbortSignal.timeout(1_000),
  })).rejects.toThrow(/visible/i);
  expect(telegram.sendMessage).not.toHaveBeenCalled();
});

it("invalidates an outstanding confirmation when the owner is revoked", async () => {
  const { store, service } = fixture();
  const requested = await service.request({
    kind: "stop_thread",
    threadId: "thr_target",
    signal: AbortSignal.timeout(1_000),
  });
  const operation = store.getThreadOperation(requested.id);
  if (!operation) throw new Error("operation was not stored");

  expect(store.revokeOwner(1_050)).toBe(true);

  expect(store.confirmThreadOperation({
    nonceHash: operation.nonceHash,
    userId: "7",
    chatId: "7",
    messageId: 601,
    now: 1_100,
  })).toEqual({ ok: false, reason: "missing" });
  expect(store.getThreadOperation(requested.id)).toMatchObject({
    state: "failed",
    lastError: "Controller owner was revoked",
  });
});
