import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";
import { BbControllerAdapter, type ControllerAdapter } from "../src/controller/bb-controller";
import { CONTROLLER_STALL_MS, LunaControllerService } from "../src/controller/service";
import { DEFAULT_CONTROLLER_EXECUTION_PROFILE } from "../src/controller/execution-profile";
import { questionOptionToken } from "../src/controller/questions";

const INTERACTION_ID = "pint_4k97457aun";
const QUESTION_ID = "toolu_abc:question-1";
const OPTION_A = "toolu_abc:question-1:option-1";
const OPTION_B = "toolu_abc:question-1:option-2";

function questionPayload() {
  return {
    kind: "user_question",
    questions: [{
      id: QUESTION_ID,
      prompt: "36 open issues in Cyndra. How should I run the fix threads?",
      shortLabel: "Fix threads",
      multiSelect: false,
      allowFreeText: true,
      options: [
        { value: OPTION_A, label: "Cluster into ~8 threads", description: "Group issues by surface." },
        { value: OPTION_B, label: "One thread per issue", description: "Maximum isolation." },
      ],
    }],
  };
}

function lifecycleEvent(seq: number, status: string) {
  return {
    id: `e${seq}`,
    threadId: "thr_controller",
    seq,
    createdAt: seq,
    scope: { kind: "turn" },
    type: "system/userQuestion/lifecycle",
    data: {
      interactionId: INTERACTION_ID,
      providerId: "claude-code",
      status,
      resolution: null,
      payload: questionPayload(),
    },
  };
}

function adapterFixture(options: { events?: unknown[] } = {}) {
  const resolve = vi.fn(async () => ({ id: INTERACTION_ID, status: "resolving" }));
  const send = vi.fn(async () => ({ ok: true }));
  const eventsList = vi.fn(async () => options.events ?? []);
  const sdk = {
    projects: { list: vi.fn(async () => []) },
    hosts: { list: vi.fn(async () => []) },
    threads: {
      spawn: vi.fn(),
      send,
      list: vi.fn(async () => []),
      get: vi.fn(async () => ({
        id: "thr_controller",
        status: "active",
        providerId: "claude-code",
        archivedAt: null,
        deletedAt: null,
      })),
      output: vi.fn(async () => ({ output: "" })),
      timeline: vi.fn(async () => ({ maxSeq: 0 })),
      events: { list: eventsList },
      interactions: { resolve, list: vi.fn(async () => []), get: vi.fn(), cancel: vi.fn(), respond: vi.fn() },
    },
  } as unknown as BbPluginApi["sdk"];
  const adapter = new BbControllerAdapter({
    sdk,
    pluginId: "telegram-agent",
    executionProfile: () => DEFAULT_CONTROLLER_EXECUTION_PROFILE,
  });
  return { adapter, resolve, send, eventsList };
}

it("surfaces a pending user question from the controller event stream", async () => {
  const { adapter } = adapterFixture({ events: [lifecycleEvent(5, "pending")] });

  const observation = await adapter.events("thr_controller", 0, AbortSignal.timeout(1_000));

  expect(observation.pendingQuestion).toEqual({
    interactionId: INTERACTION_ID,
    questions: [{
      id: QUESTION_ID,
      prompt: "36 open issues in Cyndra. How should I run the fix threads?",
      shortLabel: "Fix threads",
      multiSelect: false,
      allowFreeText: true,
      options: [
        { value: OPTION_A, label: "Cluster into ~8 threads", description: "Group issues by surface." },
        { value: OPTION_B, label: "One thread per issue", description: "Maximum isolation." },
      ],
    }],
  });
});

it("clears the pending question once the interaction stops being pending", async () => {
  const { adapter } = adapterFixture({
    events: [lifecycleEvent(5, "pending"), lifecycleEvent(6, "resolved")],
  });

  const observation = await adapter.events("thr_controller", 0, AbortSignal.timeout(1_000));

  expect(observation.pendingQuestion).toBeNull();
});

it("ignores a lifecycle event that carries no answerable question", async () => {
  const bare = lifecycleEvent(5, "pending");
  const { adapter } = adapterFixture({
    events: [{ ...bare, data: { ...bare.data, payload: { kind: "user_question", questions: [] } } }],
  });

  await expect(adapter.events("thr_controller", 0, AbortSignal.timeout(1_000)))
    .resolves.toMatchObject({ pendingQuestion: null });
});

it("answers a pending question through the BB interaction resolution", async () => {
  const { adapter, resolve } = adapterFixture();

  await adapter.answerQuestion(
    "thr_controller",
    INTERACTION_ID,
    { [QUESTION_ID]: { selected: [OPTION_A] } },
    AbortSignal.timeout(1_000),
  );

  expect(resolve).toHaveBeenCalledWith({
    threadId: "thr_controller",
    interactionId: INTERACTION_ID,
    resolution: {
      kind: "user_answer",
      answers: { [QUESTION_ID]: { selected: [OPTION_A] } },
    },
  });
});

it("steers a busy controller thread instead of starting a competing turn", async () => {
  const { adapter, send } = adapterFixture();

  await adapter.steer("thr_controller", "in review i mean not in progress", AbortSignal.timeout(1_000));

  expect(send).toHaveBeenCalledWith({
    threadId: "thr_controller",
    mode: "auto",
    input: [{ type: "text", text: "in review i mean not in progress", mentions: [] }],
  });
});

it("derives a stable, callback-sized token for each question option", () => {
  const token = questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_A);

  expect(token).toBe(questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_A));
  expect(token).not.toBe(questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_B));
  expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
});

function storeFixture(name: string) {
  const { bb } = createFakePluginHost({ pluginId: `telegram-questions-${name}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.createPairingCode(hashSecret("pair"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", 1_001)).toEqual({ ok: true });
  // Long enough that the stall-watchdog clock in these tests stays inside it.
  const lease = store.acquireExecutorLease("executor", 2_000, 60 * 60_000);
  if (!lease.acquired) throw new Error("missing lease");
  return { store, fence: { ownerId: "executor", generation: lease.generation } };
}

function submittedTurn(store: ReturnType<typeof storeFixture>["store"], fence: { ownerId: string; generation: number }) {
  const turn = store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 91,
    inputText: "review all open issues",
    now: 2_000,
  });
  store.claimNextControllerTurn({ ...fence, now: 2_000 });
  store.markControllerSpawned({
    ...fence,
    now: 2_000,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
  });
  store.markControllerTurnSubmitted({ ...fence, now: 2_000, turnId: turn.id });
  return turn;
}

it("parks a submitted turn on its question and asks the owner in Telegram", () => {
  const { store, fence } = storeFixture("park");
  const turn = submittedTurn(store, fence);

  expect(store.recordControllerQuestion({
    ...fence,
    now: 3_000,
    turnId: turn.id,
    interactionId: INTERACTION_ID,
    questions: questionPayload().questions,
  })).toBe(true);

  const parked = store.getControllerTurn(turn.id);
  expect(parked?.awaitingInteractionId).toBe(INTERACTION_ID);
  expect(parked?.state).toBe("submitted");

  const asked = store.getOutbox(`controller-question:${INTERACTION_ID}:0`);
  expect(asked?.payload.text).toContain("How should I run the fix threads?");
  expect(asked?.payload.reply_markup).toEqual({
    inline_keyboard: [
      [{ text: "Cluster into ~8 threads", callback_data: `q:${questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_A)}` }],
      [{ text: "One thread per issue", callback_data: `q:${questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_B)}` }],
    ],
  });
});

it("resolves a parked question from a tapped option and releases the turn", () => {
  const { store, fence } = storeFixture("tap");
  const turn = submittedTurn(store, fence);
  store.recordControllerQuestion({
    ...fence,
    now: 3_000,
    turnId: turn.id,
    interactionId: INTERACTION_ID,
    questions: questionPayload().questions,
  });

  const answered = store.answerControllerQuestion({
    token: questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_A),
    userId: "7",
    chatId: "7",
    now: 4_000,
  });

  expect(answered).toEqual({
    ok: true,
    complete: true,
    turnId: turn.id,
    interactionId: INTERACTION_ID,
    answers: { [QUESTION_ID]: { selected: [OPTION_A] } },
  });
  expect(store.getControllerTurn(turn.id)?.awaitingInteractionId).toBeNull();
});

it("resolves a parked question from a plain Telegram reply", () => {
  const { store, fence } = storeFixture("text");
  const turn = submittedTurn(store, fence);
  store.recordControllerQuestion({
    ...fence,
    now: 3_000,
    turnId: turn.id,
    interactionId: INTERACTION_ID,
    questions: questionPayload().questions,
  });

  const answered = store.answerControllerQuestionWithText({
    controllerKey: "owner-7-controller",
    text: "in review i mean not in progress",
    now: 4_000,
  });

  expect(answered).toEqual({
    ok: true,
    complete: true,
    turnId: turn.id,
    interactionId: INTERACTION_ID,
    answers: { [QUESTION_ID]: { selected: [], freeText: "in review i mean not in progress" } },
  });
  expect(store.getControllerTurn(turn.id)?.awaitingInteractionId).toBeNull();
});

it("refuses a stale option token once the question is answered", () => {
  const { store, fence } = storeFixture("stale");
  const turn = submittedTurn(store, fence);
  store.recordControllerQuestion({
    ...fence,
    now: 3_000,
    turnId: turn.id,
    interactionId: INTERACTION_ID,
    questions: questionPayload().questions,
  });
  const token = questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_A);
  expect(store.answerControllerQuestion({ token, userId: "7", chatId: "7", now: 4_000 }).ok).toBe(true);

  expect(store.answerControllerQuestion({ token, userId: "7", chatId: "7", now: 4_001 }))
    .toEqual({ ok: false, reason: "stale" });
});

function serviceAdapter(overrides: Partial<ControllerAdapter> = {}): ControllerAdapter {
  return {
    spawn: vi.fn(async () => ({ threadId: "thr_controller", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => 0),
    output: vi.fn(async () => "done"),
    events: vi.fn(async () => ({
      latestSeq: 0,
      inputAccepted: false,
      assistantDelta: "",
      completed: false,
      error: null,
      pendingQuestion: null,
    })),
    findSpawnCandidate: vi.fn(async () => null),
    ...overrides,
  };
}

it("parks the turn and asks in Telegram when the thread blocks on a question", async () => {
  const { store, fence } = storeFixture("service-park");
  const turn = submittedTurn(store, fence);
  const adapter = serviceAdapter({
    events: vi.fn(async () => ({
      latestSeq: 5,
      inputAccepted: true,
      assistantDelta: "Big job.",
      completed: false,
      error: null,
      pendingQuestion: { interactionId: INTERACTION_ID, questions: questionPayload().questions },
    })),
  });
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 3_000 } });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)?.awaitingInteractionId).toBe(INTERACTION_ID);
  expect(store.getOutbox(`controller-question:${INTERACTION_ID}:0`)?.payload.text)
    .toContain("How should I run the fix threads?");
});

it("delivers the owner's answer back to the blocked BB thread", async () => {
  const { store, fence } = storeFixture("service-answer");
  const turn = submittedTurn(store, fence);
  store.recordControllerQuestion({
    ...fence,
    now: 3_000,
    turnId: turn.id,
    interactionId: INTERACTION_ID,
    questions: questionPayload().questions,
  });
  expect(store.answerControllerQuestion({
    token: questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_A),
    userId: "7",
    chatId: "7",
    now: 4_000,
  }).ok).toBe(true);
  const adapter = serviceAdapter();
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 4_100 } });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(true);

  expect(adapter.answerQuestion).toHaveBeenCalledWith(
    "thr_controller",
    INTERACTION_ID,
    { [QUESTION_ID]: { selected: [OPTION_A] } },
    signal,
  );
  // Delivered once: a second pass must not answer the same interaction again.
  const second = new LunaControllerService({ store, adapter, clock: { now: () => 4_200 } });
  await second.reconcile({ ...fence, signal }, signal);
  expect(adapter.answerQuestion).toHaveBeenCalledTimes(1);
});

it("gives up on a turn that stopped producing events and unblocks the queue", async () => {
  const { store, fence } = storeFixture("service-stall");
  const turn = submittedTurn(store, fence);
  const service = new LunaControllerService({
    store,
    adapter: serviceAdapter(),
    clock: { now: () => 2_000 + CONTROLLER_STALL_MS + 1 },
  });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)?.state).toBe("failed");
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).toContain("stalled");
});

it("waits indefinitely while the owner still owes the thread an answer", async () => {
  const { store, fence } = storeFixture("service-no-stall");
  const turn = submittedTurn(store, fence);
  store.recordControllerQuestion({
    ...fence,
    now: 2_500,
    turnId: turn.id,
    interactionId: INTERACTION_ID,
    questions: questionPayload().questions,
  });
  const service = new LunaControllerService({
    store,
    adapter: serviceAdapter(),
    clock: { now: () => 2_000 + CONTROLLER_STALL_MS + 1 },
  });
  const signal = AbortSignal.timeout(2_000);

  await service.reconcile({ ...fence, signal }, signal);

  expect(store.getControllerTurn(turn.id)?.state).toBe("submitted");
});

it("hands a message sent mid-answer to the thread already writing it", async () => {
  const { store, fence } = storeFixture("service-steer");
  const running = submittedTurn(store, fence);
  const correction = store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 92,
    inputText: "in review i mean not in progress",
    now: 2_100,
  });
  const adapter = serviceAdapter();
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_200 } });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(true);

  expect(adapter.steer).toHaveBeenCalledWith("thr_controller", "in review i mean not in progress", signal);
  expect(store.getControllerTurn(correction.id)?.state).toBe("completed");
  // The running answer still owns the reply; the correction gets no second one.
  expect(store.getOutbox(`controller:${correction.id}:reply`)).toBeNull();
  expect(store.getControllerTurn(running.id)?.state).toBe("submitted");
});

it("leaves a mid-answer message queued when the thread will not take it", async () => {
  const { store, fence } = storeFixture("service-steer-fails");
  submittedTurn(store, fence);
  const correction = store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 93,
    inputText: "actually hold on",
    now: 2_100,
  });
  const adapter = serviceAdapter({
    steer: vi.fn(async () => { throw new Error("BB refused the steer"); }),
  });
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_200 } });
  const signal = AbortSignal.timeout(2_000);

  await service.reconcile({ ...fence, signal }, signal);

  expect(store.getControllerTurn(correction.id)?.state).toBe("queued");
});

it("retires a parked question when its turn dies, so later messages are not swallowed", () => {
  const { store, fence } = storeFixture("orphan");
  const turn = submittedTurn(store, fence);
  store.recordControllerQuestion({
    ...fence,
    now: 3_000,
    turnId: turn.id,
    interactionId: INTERACTION_ID,
    questions: questionPayload().questions,
  });

  expect(store.failControllerTurn({
    ...fence,
    now: 4_000,
    turnId: turn.id,
    error: "Controller provider turn failed",
  })).toBe(true);

  expect(store.getPendingControllerQuestion("owner-7-controller")).toBeNull();
  expect(store.answerControllerQuestionWithText({
    controllerKey: "owner-7-controller",
    text: "cluster them",
    now: 4_100,
  })).toEqual({ ok: false, reason: "stale" });
});

it("does not deliver an answer whose turn died before BB heard it", async () => {
  const { store, fence } = storeFixture("orphan-answer");
  const turn = submittedTurn(store, fence);
  store.recordControllerQuestion({
    ...fence,
    now: 3_000,
    turnId: turn.id,
    interactionId: INTERACTION_ID,
    questions: questionPayload().questions,
  });
  store.answerControllerQuestion({
    token: questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_A),
    userId: "7",
    chatId: "7",
    now: 3_500,
  });
  store.failControllerTurn({ ...fence, now: 4_000, turnId: turn.id, error: "Controller provider turn failed" });
  const adapter = serviceAdapter();
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 4_100 } });
  const signal = AbortSignal.timeout(2_000);

  await service.reconcile({ ...fence, signal }, signal);

  expect(adapter.answerQuestion).not.toHaveBeenCalled();
});

it("stops re-steering a message the thread keeps refusing", async () => {
  const { store, fence } = storeFixture("steer-bounded");
  submittedTurn(store, fence);
  const correction = store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 94,
    inputText: "actually hold on",
    now: 2_100,
  });
  const steer = vi.fn(async () => { throw new Error("BB refused the steer"); });
  const adapter = serviceAdapter({ steer });
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_200 } });
  const signal = AbortSignal.timeout(2_000);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await service.reconcile({ ...fence, signal }, signal);
  }

  // Bounded: the reconcile loop runs every 250ms while streaming, so an
  // unbounded retry here would hammer BB for as long as the answer takes.
  expect(steer.mock.calls.length).toBeLessThanOrEqual(3);
  expect(store.getControllerTurn(correction.id)?.state).toBe("queued");
});

it("retires the wedged thread when a turn stalls, so the next message is not stuck behind it", async () => {
  const { store, fence } = storeFixture("stall-retires");
  const turn = submittedTurn(store, fence);
  const service = new LunaControllerService({
    store,
    adapter: serviceAdapter(),
    clock: { now: () => 2_000 + CONTROLLER_STALL_MS + 1 },
  });
  const signal = AbortSignal.timeout(2_000);

  await service.reconcile({ ...fence, signal }, signal);

  expect(store.getControllerTurn(turn.id)?.state).toBe("failed");
  // Failing the turn while leaving the thread wedged means every later message
  // waits out the busy timeout instead of getting a fresh thread.
  const controller = store.getControllerForOwner("7", "7");
  expect(controller?.threadId).toBeNull();
  expect(controller?.state).toBe("pending_spawn");
});
