import { createHash } from "node:crypto";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { TelegramIngress } from "../src/telegram/ingress";
import { runTelegramService } from "../src/services/telegram-service";
import { policyFixture } from "./helpers";
import type { SendMessagePayload, TelegramUpdate } from "../src/telegram/types";
import type { ControllerInteraction } from "../src/controller/questions";

const OWNER = "7";
const THREAD_ID = "thr_answer_atomicity";
// Exactly the key the ingress derives for this owner, so the durable rows these
// tests set up are the ones a real Telegram message resolves against.
const CONTROLLER_KEY = createHash("sha256")
  .update(`telegram-controller:${OWNER}:${OWNER}`, "utf8")
  .digest("base64url")
  .slice(0, 32);
const INTERACTION_ID = "pint_answer_atomicity";

let hostNumber = 0;

class FakeTelegram {
  public readonly sent: { chatId: string; payload: SendMessagePayload }[] = [];
  private nextMessageId = 700;

  public async sendMessage(chatId: string, payload: SendMessagePayload): Promise<{ message_id: number }> {
    this.sent.push({ chatId, payload });
    return { message_id: this.nextMessageId++ };
  }

  public async editMessage(): Promise<void> {}
  public async answerCallback(): Promise<void> {}
}

function question(id: string, prompt: string) {
  return { id, prompt, shortLabel: null, multiSelect: false, allowFreeText: true, options: [] };
}

/**
 * A real file-backed store carrying one controller turn parked on a real
 * durable interaction, so a restart can reopen exactly what was committed.
 */
function answerFixture(questions: { id: string; prompt: string }[]) {
  const { bb } = createFakePluginHost({ pluginId: `telegram-answer-atomicity-${hostNumber++}` });
  const storage = bb.storage;
  const store = openStore(storage, storage.kv, () => 2_000);
  store.upsertProjectPolicy(policyFixture(), 1_500);
  store.createPairingCode(hashSecret("pair-answer"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair-answer"), OWNER, OWNER, 1_001)).toEqual({ ok: true });
  const lease = store.acquireExecutorLease("executor", 2_000, 60 * 60_000);
  if (!lease.acquired) throw new Error("executor lease was unavailable");
  const fence = { ownerId: "executor", generation: lease.generation, now: 2_000 };

  const turn = store.enqueueControllerTurn({
    controllerKey: CONTROLLER_KEY,
    telegramUserId: OWNER,
    telegramChatId: OWNER,
    updateId: 100,
    inputText: "ship the release",
    now: 2_000,
  });
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    ...fence, turnId: turn.id, projectId: "proj_answer", hostId: "host_answer", threadId: THREAD_ID,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, turnId: turn.id })).toBe(true);

  const generation = store.getOpenControllerGeneration(CONTROLLER_KEY, THREAD_ID);
  if (!generation) throw new Error("controller generation was unavailable");
  const interaction: ControllerInteraction = {
    kind: "user_question",
    interactionId: INTERACTION_ID,
    questions: questions.map((entry) => question(entry.id, entry.prompt)),
  };
  expect(store.recordControllerInteraction({
    ...fence,
    turnId: turn.id,
    controllerKey: CONTROLLER_KEY,
    bbThreadId: THREAD_ID,
    controllerGenerationId: generation.id,
    interaction,
    now: 2_100,
  })).toBe("recorded");

  return {
    store, turn, fence, storage,
    reopen: (): TelegramAgentStore => openStore(storage, storage.kv, () => 2_000),
  };
}

function textUpdate(updateId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: Number(OWNER), type: "private" },
      from: { id: Number(OWNER), is_bot: false },
      text,
    },
  } as TelegramUpdate;
}

/**
 * The real polling loop, driven for exactly one batch. `crashAfterIngress`
 * stands in for the process dying between the ingress commit and whatever the
 * service would have written afterwards.
 */
async function pumpService(
  store: TelegramAgentStore,
  ingress: TelegramIngress,
  updates: TelegramUpdate[],
  options: { crashAfterIngress?: boolean } = {},
): Promise<void> {
  const abort = new AbortController();
  let polls = 0;
  const client = {
    async getMe() { return { id: 123, username: "bot" }; },
    async getUpdates() {
      polls += 1;
      if (polls > 1) { abort.abort(); return []; }
      return updates;
    },
  };
  await runTelegramService({
    store,
    client: () => client,
    ingress: {
      async handleClaimed(update, now) {
        const outcome = await ingress.handleClaimed(update, now);
        if (options.crashAfterIngress) throw new Error("process died before the update was completed");
        return outcome;
      },
    },
    getConfig: () => ({ ok: true, value: { botToken: "123:abcdefghijklmnopqrstuvwxyzABCDEFGHI" } }),
    clock: { now: () => 3_000 },
    warn: () => undefined,
  }, abort.signal);
}

function controllerTurns(store: TelegramAgentStore) {
  return store.listControllerTurns(CONTROLLER_KEY, 20);
}

it("commits a single-question answer and its update claim together", async () => {
  const fixture = answerFixture([{ id: "q1", prompt: "Which branch?" }]);
  const telegram = new FakeTelegram();
  const ingress = new TelegramIngress({ store: fixture.store, telegram, onWorkAvailable: () => undefined });

  await pumpService(fixture.store, ingress, [textUpdate(200, "main")]);

  const restarted = fixture.reopen();
  expect(restarted.getAnsweredControllerInteraction(CONTROLLER_KEY)).toMatchObject({
    interactionId: INTERACTION_ID,
  });
  // The answer and the claim that produced it are one durable fact.
  expect(restarted.beginTelegramUpdate(200, 4_000)).toBe("processed");
  expect(controllerTurns(restarted)).toHaveLength(1);
});

it("replays a crashed single-question answer without answering anything else", async () => {
  const fixture = answerFixture([{ id: "q1", prompt: "Which branch?" }]);
  const telegram = new FakeTelegram();
  const ingress = new TelegramIngress({ store: fixture.store, telegram, onWorkAvailable: () => undefined });

  await pumpService(fixture.store, ingress, [textUpdate(200, "main")], { crashAfterIngress: true });

  // Restart: nothing in memory survives, only what the ingress transaction committed.
  const restarted = fixture.reopen();
  const answeredBefore = restarted.getAnsweredControllerInteraction(CONTROLLER_KEY);
  expect(answeredBefore).toMatchObject({ interactionId: INTERACTION_ID });
  const outboxBefore = restarted.listOutbox(50).length;

  const replayIngress = new TelegramIngress({
    store: restarted, telegram: new FakeTelegram(), onWorkAvailable: () => undefined,
  });
  await pumpService(restarted, replayIngress, [textUpdate(200, "main")]);

  expect(restarted.getAnsweredControllerInteraction(CONTROLLER_KEY)).toEqual(answeredBefore);
  // The replayed answer text must not become a new request to the controller.
  expect(controllerTurns(restarted)).toHaveLength(1);
  expect(restarted.listOutbox(50)).toHaveLength(outboxBefore);
});

it("replays a crashed multi-question answer without advancing to the next question", async () => {
  const fixture = answerFixture([
    { id: "q1", prompt: "Which branch?" },
    { id: "q2", prompt: "Which environment?" },
  ]);
  const telegram = new FakeTelegram();
  const ingress = new TelegramIngress({ store: fixture.store, telegram, onWorkAvailable: () => undefined });

  await pumpService(fixture.store, ingress, [textUpdate(201, "main")], { crashAfterIngress: true });

  const restarted = fixture.reopen();
  const pendingBefore = restarted.getPendingControllerInteraction(CONTROLLER_KEY);
  // The first question is answered and the second is the one now being asked.
  expect(pendingBefore?.answers).toMatchObject({ q1: { freeText: "main" } });
  const outboxBefore = restarted.listOutbox(50);
  expect(outboxBefore.some((item) => item.logicalKey.endsWith(":1"))).toBe(true);

  const replayIngress = new TelegramIngress({
    store: restarted, telegram: new FakeTelegram(), onWorkAvailable: () => undefined,
  });
  await pumpService(restarted, replayIngress, [textUpdate(201, "main")]);

  // A replay must not silently answer the second question with the first one's words.
  expect(restarted.getPendingControllerInteraction(CONTROLLER_KEY)?.answers)
    .toEqual(pendingBefore?.answers);
  expect(controllerTurns(restarted)).toHaveLength(1);
  expect(restarted.listOutbox(50)).toHaveLength(outboxBefore.length);
});

it("claims and commits a direct answer when the caller has not claimed the update", async () => {
  const fixture = answerFixture([{ id: "q1", prompt: "Which branch?" }]);
  const telegram = new FakeTelegram();
  const ingress = new TelegramIngress({ store: fixture.store, telegram, onWorkAvailable: () => undefined });

  // Direct callers are allowed to hand an unclaimed update to the atomic answer
  // path; it creates the claim in the same transaction as the answer.
  await expect(ingress.handleClaimed(textUpdate(202, "main"), 3_000))
    .resolves.toEqual({ updateSettled: true });

  const restarted = fixture.reopen();
  expect(restarted.getAnsweredControllerInteraction(CONTROLLER_KEY)).toMatchObject({
    interactionId: INTERACTION_ID,
  });
  expect(restarted.getPendingControllerInteraction(CONTROLLER_KEY)).toBeNull();
  expect(controllerTurns(restarted)).toHaveLength(1);
});

it("leaves a message that is not an answer to the ordinary claimed path", async () => {
  const fixture = answerFixture([{ id: "q1", prompt: "Which branch?" }]);
  // Settle the interaction so the next message is a fresh request, not an answer.
  expect(fixture.store.markControllerInteractionResolved({
    ...fixture.fence, interactionId: INTERACTION_ID, turnId: fixture.turn.id, bbThreadId: THREAD_ID,
  })).toBe(true);
  const telegram = new FakeTelegram();
  const ingress = new TelegramIngress({ store: fixture.store, telegram, onWorkAvailable: () => undefined });

  await pumpService(fixture.store, ingress, [textUpdate(203, "also run the migration")]);

  const restarted = fixture.reopen();
  expect(controllerTurns(restarted)).toHaveLength(2);
  expect(restarted.beginTelegramUpdate(203, 4_000)).toBe("processed");
});

it("reports the settled update to the service so it is never completed twice", async () => {
  const fixture = answerFixture([{ id: "q1", prompt: "Which branch?" }]);
  const telegram = new FakeTelegram();
  const ingress = new TelegramIngress({ store: fixture.store, telegram, onWorkAvailable: () => undefined });
  const completeTelegramUpdate = vi.spyOn(fixture.store, "completeTelegramUpdate");

  await pumpService(fixture.store, ingress, [textUpdate(204, "main")]);

  expect(completeTelegramUpdate).not.toHaveBeenCalled();
  expect(fixture.store.beginTelegramUpdate(204, 4_000)).toBe("processed");
});
