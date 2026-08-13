import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";
import { BbControllerAdapter, type ControllerAdapter } from "../src/controller/bb-controller";
import { CONTROLLER_STALL_MS, LunaControllerService } from "../src/controller/service";
import { DEFAULT_CONTROLLER_EXECUTION_PROFILE } from "../src/controller/execution-profile";
import {
  questionOptionToken,
  renderQuestion,
  renderControllerInteraction,
  parseThreadInteraction,
} from "../src/controller/questions";

const INTERACTION_ID = "pint_4k97457aun";
const QUESTION_ID = "toolu_abc:question-1";
const OPTION_A = "toolu_abc:question-1:option-1";
const OPTION_B = "toolu_abc:question-1:option-2";

const testEvidenceProjector = {
  reconcile: vi.fn(async (...args: unknown[]) => ({
    outcome: "reconciled" as const,
    reconciliationIncomplete: null,
    fromSeq: 0,
    throughSeq: Number(args[1] && typeof args[1] === "object" && "evidenceEventSeq" in args[1]
      ? (args[1] as { evidenceEventSeq: number }).evidenceEventSeq
      : 0),
    targetSeq: typeof args[4] === "number" ? args[4] : 0,
  })),
};

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
  const eventsList = vi.fn(async (_input?: { afterSeq?: string; limit?: string }) => options.events ?? []);
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

it("surfaces a pending user-question reference from the controller event stream", async () => {
  const { adapter } = adapterFixture({ events: [lifecycleEvent(5, "pending")] });

  const observation = await adapter.events("thr_controller", 0, AbortSignal.timeout(1_000));

  expect(observation.interactionReferences).toEqual([
    { interactionId: INTERACTION_ID, kind: "user_question", status: "pending" },
  ]);
});

it("clears the pending question once the interaction stops being pending", async () => {
  const { adapter } = adapterFixture({
    events: [lifecycleEvent(5, "pending"), lifecycleEvent(6, "resolved")],
  });

  const observation = await adapter.events("thr_controller", 0, AbortSignal.timeout(1_000));

  expect(observation.interactionReferences).toEqual([
    { interactionId: INTERACTION_ID, kind: "user_question", status: "resolved" },
  ]);
});

it("uses lifecycle sequence rather than arrival order for duplicate references", async () => {
  const resolved = lifecycleEvent(6, "resolved");
  const pending = lifecycleEvent(5, "pending");
  const { adapter } = adapterFixture({ events: [resolved, pending, pending, resolved] });

  await expect(adapter.events("thr_controller", 0, AbortSignal.timeout(1_000))).resolves.toMatchObject({
    interactionReferences: [{ interactionId: INTERACTION_ID, kind: "user_question", status: "resolved" }],
  });
});

it("emits bounded references for both question and permission lifecycles without trusting inline payloads", async () => {
  const permission = {
    ...lifecycleEvent(6, "pending"),
    type: "system/permissionGrant/lifecycle",
    data: {
      ...lifecycleEvent(6, "pending").data,
      interactionId: "permission_4k97457aun",
      payload: { kind: "approval", summary: "inline payload is not authority" },
    },
  };
  const { adapter } = adapterFixture({
    events: [lifecycleEvent(5, "pending"), permission, lifecycleEvent(7, "resolved")],
  });

  await expect(adapter.events("thr_controller", 0, AbortSignal.timeout(1_000))).resolves.toMatchObject({
    interactionReferences: [
      { interactionId: INTERACTION_ID, kind: "user_question", status: "resolved" },
      { interactionId: "permission_4k97457aun", kind: "approval", status: "pending" },
    ],
  });
});

it("does not advance the lifecycle cursor past the omitted 257th reference", async () => {
  const references = Array.from({ length: 257 }, (_, index) => {
    const event = lifecycleEvent(index + 1, "pending");
    return {
      ...event,
      data: { ...event.data, interactionId: `interaction-${index + 1}` },
    };
  });
  const events = [
    ...references,
    { id: "accepted", threadId: "thr_controller", seq: 258, createdAt: 258, scope: { kind: "turn" }, type: "turn/input/accepted", data: {} },
    { id: "tool", threadId: "thr_controller", seq: 259, createdAt: 259, scope: { kind: "turn" }, type: "item/started", data: { item: { type: "commandExecution" } } },
    { id: "tokens", threadId: "thr_controller", seq: 260, createdAt: 260, scope: { kind: "turn" }, type: "thread/tokenUsage/updated", data: { tokenUsage: { total: { totalTokens: 42 } } } },
    { id: "error", threadId: "thr_controller", seq: 261, createdAt: 261, scope: { kind: "turn" }, type: "system/error", data: {} },
  ];
  const { adapter, eventsList } = adapterFixture();
  const pageRequests: Array<{ afterSeq: string; limit: string }> = [];
  eventsList.mockImplementation(async (input = {}) => {
    const afterSeq = Number(input.afterSeq ?? "0");
    const limit = Number(input.limit ?? "100");
    pageRequests.push({ afterSeq: String(afterSeq), limit: String(limit) });
    return events.filter((event) => event.seq > afterSeq).slice(0, limit);
  });

  const first = await adapter.events("thr_controller", 0, AbortSignal.timeout(1_000));
  expect(first.interactionReferences).toHaveLength(256);
  expect(first.interactionReferences).not.toContainEqual({
    interactionId: "interaction-257",
    kind: "user_question",
    status: "pending",
  });
  expect(first.latestSeq).toBe(256);
  expect(first.inputAccepted).toBe(false);
  expect(first.toolActivityObserved).toBe(false);
  expect(first.totalTokens).toBe(0);
  expect(first.error).toBeNull();
  expect(pageRequests).toEqual([
    { afterSeq: "0", limit: "100" },
    { afterSeq: "100", limit: "100" },
    { afterSeq: "200", limit: "100" },
  ]);

  const second = await adapter.events("thr_controller", first.latestSeq, AbortSignal.timeout(1_000));
  expect(second.interactionReferences).toEqual([
    { interactionId: "interaction-257", kind: "user_question", status: "pending" },
  ]);
  expect(second.latestSeq).toBe(261);
  expect(second.inputAccepted).toBe(true);
  expect(second.toolActivityObserved).toBe(true);
  expect(second.totalTokens).toBe(42);
  expect(second.error).toBe("Controller provider turn failed");
  expect(pageRequests).toEqual([
    { afterSeq: "0", limit: "100" },
    { afterSeq: "100", limit: "100" },
    { afterSeq: "200", limit: "100" },
    { afterSeq: "256", limit: "100" },
  ]);
});

it("retains a lifecycle reference even when its inline payload is not answerable", async () => {
  const bare = lifecycleEvent(5, "pending");
  const { adapter } = adapterFixture({
    events: [{ ...bare, data: { ...bare.data, payload: { kind: "user_question", questions: [] } } }],
  });

  await expect(adapter.events("thr_controller", 0, AbortSignal.timeout(1_000)))
    .resolves.toMatchObject({
      interactionReferences: [{ interactionId: INTERACTION_ID, kind: "user_question" as const, status: "pending" as const }],
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    });
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

it("rejects session-wide approval resolutions at the SDK boundary", async () => {
  const { adapter, resolve } = adapterFixture();

  await expect(adapter.resolveInteraction(
    "thr_controller",
    INTERACTION_ID,
    { decision: "allow_for_session", grantedPermissions: null } as never,
    AbortSignal.timeout(1_000),
  )).rejects.toThrow();
  expect(resolve).not.toHaveBeenCalled();
});

it("steers a busy controller thread instead of starting a competing turn", async () => {
  const { adapter, send } = adapterFixture();

  await adapter.steer("thr_controller", "in review i mean not in progress", AbortSignal.timeout(1_000));

  expect(send).toHaveBeenCalledWith({
    threadId: "thr_controller",
    mode: "steer-if-active",
    input: [{ type: "text", text: "in review i mean not in progress", mentions: [] }],
  });
});

it("derives a stable, callback-sized token for each question option", () => {
  const token = questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_A);

  expect(token).toBe(questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_A));
  expect(token).not.toBe(questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_B));
  expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
});

it("rejects a question writer outside the explicit controller namespaces", () => {
  expect(() => renderQuestion(
    INTERACTION_ID,
    questionPayload().questions[0]!,
    "q" as never,
  )).toThrow();
});

it("renders controller questions, approvals, and unsupported interactions with the controller callback namespace", () => {
  const question = renderControllerInteraction({
    kind: "user_question",
    interactionId: INTERACTION_ID,
    questions: questionPayload().questions,
  });
  expect("reply_markup" in question ? question.reply_markup.inline_keyboard[0]?.[0]?.callback_data : null)
    .toBe(`i:${questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_A)}`);

  const approval = renderControllerInteraction({
    kind: "approval",
    interactionId: INTERACTION_ID,
    summary: "wants to run a command",
    decisions: ["allow_once", "deny"],
  });
  expect("reply_markup" in approval ? approval.reply_markup.inline_keyboard.flat().map((button) => button.text) : [])
    .toEqual(["Allow once", "Deny"]);
  expect(approval.text).not.toMatch(/session/i);

  const unsupported = renderControllerInteraction({ kind: "unsupported", interactionId: INTERACTION_ID });
  expect(unsupported).not.toHaveProperty("reply_markup");
});

it.each([
  { decisions: ["allow_once", "deny"] },
  { availableDecisions: "allow_once", decisions: ["allow_once", "deny"] },
  { availableDecisions: ["allow_once"], decisions: ["deny"] },
  { availableDecisions: ["allow_once", 7] },
] as const)("requires the own canonical decision list for worker approvals: %#", (fields) => {
  expect(parseThreadInteraction("worker_approval_boundary", {
    kind: "approval",
    subject: { kind: "command", command: "npm test", cwd: "/workspace/project" },
    ...fields,
  })).toEqual({ kind: "unsupported", interactionId: "worker_approval_boundary" });
});

function storeFixture(name: string) {
  const { bb } = createFakePluginHost({ pluginId: `telegram-questions-${name}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.createPairingCode(hashSecret("pair"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", 1_001)).toEqual({ ok: true });
  // Long enough that the stall-watchdog clock in these tests stays inside it.
  const lease = store.acquireExecutorLease("executor", 2_000, 60 * 60_000);
  if (!lease.acquired) throw new Error("missing lease");
  return {
    db: bb.storage.database(),
    store,
    fence: { ownerId: "executor", generation: lease.generation },
  };
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
  expect(store.reserveControllerSpawn({
    controllerKey: turn.controllerKey,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    now: 2_000,
  })).toBe(true);
  store.markControllerSpawned({
    ...fence,
    now: 2_000,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
    spawnToken: turn.id,
  });
  store.markControllerTurnSubmitted({ ...fence, now: 2_000, turnId: turn.id });
  return turn;
}

function recordQuestion(
  store: ReturnType<typeof storeFixture>["store"],
  fence: { ownerId: string; generation: number },
  turn: ReturnType<typeof submittedTurn>,
  now = 3_000,
): string {
  const generation = store.listControllerGenerations(turn.controllerKey, 1)[0];
  if (!generation) throw new Error("missing controller generation");
  return store.recordControllerInteraction({
    ...fence,
    now,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    bbThreadId: "thr_controller",
    controllerGenerationId: generation.id,
    interaction: {
      kind: "user_question",
      interactionId: INTERACTION_ID,
      questions: questionPayload().questions,
    },
  });
}

it("parks a submitted turn on its question and asks the owner in Telegram", () => {
  const { store, fence } = storeFixture("park");
  const turn = submittedTurn(store, fence);

  expect(recordQuestion(store, fence, turn)).toBe("recorded");

  const parked = store.getControllerTurn(turn.id);
  expect(parked?.awaitingInteractionId).toBe(INTERACTION_ID);
  expect(parked?.state).toBe("submitted");

  const asked = store.getOutbox(`controller-interaction:${INTERACTION_ID}:0`);
  expect(asked?.payload.text).toContain("How should I run the fix threads?");
  expect(asked?.payload.reply_markup).toEqual({
    inline_keyboard: [
      [{ text: "Cluster into ~8 threads", callback_data: `i:${questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_A)}` }],
      [{ text: "One thread per issue", callback_data: `i:${questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_B)}` }],
    ],
  });
});

it("resolves a parked question from a tapped option and releases the turn", () => {
  const { store, fence } = storeFixture("tap");
  const turn = submittedTurn(store, fence);
  expect(recordQuestion(store, fence, turn)).toBe("recorded");

  const answered = store.answerControllerInteractionByToken({
    token: questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_A),
    userId: "7",
    chatId: "7",
    now: 4_000,
  });

  expect(answered).toMatchObject({
    ok: true,
    complete: true,
    turnId: turn.id,
    interactionId: INTERACTION_ID,
    resolution: { kind: "user_answer", answers: { [QUESTION_ID]: { selected: [OPTION_A] } } },
  });
  expect(store.getControllerTurn(turn.id)?.awaitingInteractionId).toBe(INTERACTION_ID);
});

it("resolves a parked question from a plain Telegram reply", () => {
  const { store, fence } = storeFixture("text");
  const turn = submittedTurn(store, fence);
  expect(recordQuestion(store, fence, turn)).toBe("recorded");

  const answered = store.answerControllerInteractionWithText({
    controllerKey: "owner-7-controller",
    userId: "7",
    chatId: "7",
    text: "in review i mean not in progress",
    now: 4_000,
  });

  expect(answered).toMatchObject({
    ok: true,
    complete: true,
    turnId: turn.id,
    interactionId: INTERACTION_ID,
    resolution: { kind: "user_answer", answers: { [QUESTION_ID]: { selected: [], freeText: "in review i mean not in progress" } } },
  });
  expect(store.getControllerTurn(turn.id)?.awaitingInteractionId).toBe(INTERACTION_ID);
});

it("refuses a stale option token once the question is answered", () => {
  const { store, fence } = storeFixture("stale");
  const turn = submittedTurn(store, fence);
  expect(recordQuestion(store, fence, turn)).toBe("recorded");
  const token = questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_A);
  expect(store.answerControllerInteractionByToken({ token, userId: "7", chatId: "7", now: 4_000 }).ok).toBe(true);

  expect(store.answerControllerInteractionByToken({ token, userId: "7", chatId: "7", now: 4_001 }))
    .toEqual({ ok: false, reason: "stale" });
});

it("keeps the oldest pending interaction visible and promotes the next after delivery", () => {
  const { store, fence } = storeFixture("interaction-order");
  const turn = submittedTurn(store, fence);
  expect(recordQuestion(store, fence, turn)).toBe("recorded");
  const generation = store.listControllerGenerations(turn.controllerKey, 1)[0];
  if (!generation) throw new Error("missing controller generation");
  expect(store.recordControllerInteraction({
    ...fence,
    now: 3_001,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    bbThreadId: generation.threadId,
    controllerGenerationId: generation.id,
    interaction: {
      kind: "user_question",
      interactionId: "second-controller-interaction",
      questions: [{
        id: "second-question",
        prompt: "Which second route?",
        shortLabel: "Route",
        multiSelect: false,
        allowFreeText: true,
        options: [{ value: "second", label: "Second", description: null }],
      }],
    },
  })).toBe("recorded");
  expect(store.getOutbox("controller-interaction:second-controller-interaction:0")).toBeNull();

  expect(store.answerControllerInteractionByToken({
    token: questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_A),
    userId: "7",
    chatId: "7",
    now: 3_002,
  }).ok).toBe(true);
  expect(store.markControllerInteractionDelivered({
    ...fence,
    now: 3_003,
    interactionId: INTERACTION_ID,
    turnId: turn.id,
    bbThreadId: generation.threadId,
  })).toBe(true);
  expect(store.getOutbox("controller-interaction:second-controller-interaction:0")?.payload.text)
    .toContain("Which second route?");
});

function serviceAdapter(overrides: Partial<ControllerAdapter> = {}): ControllerAdapter {
  return {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "thr_controller", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    getInteraction: vi.fn(async (threadId: string, interactionId: string) => ({
      id: interactionId,
      threadId,
      status: "pending",
      payload: questionPayload(),
    })),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({
      latestSeq: 0,
      inputAccepted: false,
      assistantDelta: "",
      completed: false,
      error: null,
      interactionReferences: [], toolCalls: 0, commandFailures: 0, totalTokens: 0,
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
      interactionReferences: [{ interactionId: INTERACTION_ID, kind: "user_question" as const, status: "pending" as const }],
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
  });
  const service = new LunaControllerService({ store, adapter, evidenceProjector: testEvidenceProjector, clock: { now: () => 3_000 } });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)?.awaitingInteractionId).toBe(INTERACTION_ID);
  expect(store.getOutbox(`controller-interaction:${INTERACTION_ID}:0`)?.payload.text)
    .toContain("How should I run the fix threads?");
});

it("replays a lifecycle reference after a failed authoritative read", async () => {
  const { store, fence } = storeFixture("service-interaction-read-retry");
  const turn = submittedTurn(store, fence);
  const getInteraction = vi.fn()
    .mockRejectedValueOnce(new Error("temporary interaction read failure"))
    .mockResolvedValue({
      id: INTERACTION_ID,
      threadId: "thr_controller",
      status: "pending",
      payload: questionPayload(),
    });
  const events = vi.fn(async () => ({
    latestSeq: 5,
    inputAccepted: true,
    assistantOutputObserved: false,
    toolActivityObserved: false,
    completed: false,
    error: null,
    interactionReferences: [{
      interactionId: INTERACTION_ID,
      kind: "user_question" as const,
      status: "pending" as const,
    }],
    toolCalls: 0,
    commandFailures: 0,
    totalTokens: 0,
  }));
  const adapter = serviceAdapter({
    latestSeq: vi.fn(async () => 5),
    events,
    getInteraction,
  });
  const service = new LunaControllerService({
    store,
    adapter,
    evidenceProjector: testEvidenceProjector,
    clock: { now: () => 3_000 },
  });
  const signal = AbortSignal.timeout(10_000);

  await service.reconcile({ ...fence, signal }, signal);

  expect(getInteraction).toHaveBeenCalledTimes(1);
  expect(store.getControllerTurn(turn.id)?.bbEventSeq).toBe(0);
  expect(store.getPendingControllerInteraction(turn.controllerKey)).toBeNull();

  await service.reconcile({ ...fence, signal }, signal);

  expect(events).toHaveBeenNthCalledWith(2, "thr_controller", 0, signal);
  expect(store.getControllerTurn(turn.id)?.bbEventSeq).toBe(5);
  expect(store.getPendingControllerInteraction(turn.controllerKey)).toMatchObject({
    interactionId: INTERACTION_ID,
  });
});

it("fails closed when a lifecycle ID belongs to another controller generation", async () => {
  const { db, store, fence } = storeFixture("service-interaction-conflict");
  const turn = submittedTurn(store, fence);
  expect(recordQuestion(store, fence, turn)).toBe("recorded");
  const previousGeneration = store.listControllerGenerations(turn.controllerKey, 1)[0];
  if (!previousGeneration) throw new Error("missing previous controller generation");
  db.prepare(
    "UPDATE controller_generations SET ended_at = ?, end_reason = ? WHERE id = ?",
  ).run(3_001, "takeover", previousGeneration.id);
  db.prepare(
    `INSERT INTO controller_generations (id, controller_key, thread_id, started_at, ended_at, end_reason)
     VALUES (?, ?, ?, ?, NULL, NULL)`,
  ).run("gen_controller_replacement", turn.controllerKey, "thr_controller_replacement", 3_001);
  db.prepare(
    "UPDATE controller_threads SET bb_thread_id = ? WHERE controller_key = ?",
  ).run("thr_controller_replacement", turn.controllerKey);

  const getInteraction = vi.fn(async (threadId: string, interactionId: string) => ({
    id: interactionId,
    threadId,
    status: "pending",
    payload: questionPayload(),
  }));
  const adapter = serviceAdapter({
    latestSeq: vi.fn(async () => 5),
    events: vi.fn(async () => ({
      latestSeq: 5,
      inputAccepted: true,
      assistantOutputObserved: false,
      toolActivityObserved: false,
      completed: false,
      error: null,
      interactionReferences: [{
        interactionId: INTERACTION_ID,
        kind: "user_question" as const,
        status: "pending" as const,
      }],
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    getInteraction,
  });
  const service = new LunaControllerService({
    store,
    adapter,
    evidenceProjector: testEvidenceProjector,
    clock: { now: () => 3_100 },
  });
  const signal = AbortSignal.timeout(10_000);

  await service.reconcile({ ...fence, signal }, signal);

  expect(getInteraction).toHaveBeenCalledWith("thr_controller_replacement", INTERACTION_ID, signal);
  expect(store.getControllerTurn(turn.id)?.bbEventSeq).toBe(0);
});

it.each([
  ["wrong interaction id", { id: "other-interaction", threadId: "thr_controller", status: "pending" }],
  ["wrong thread id", { id: INTERACTION_ID, threadId: "thr_other", status: "pending" }],
  ["ambiguous status", { id: INTERACTION_ID, threadId: "thr_controller", status: "resolving" }],
] as const)("rejects a lifecycle get with %s before projecting its payload", async (_caseName, snapshot) => {
  const { store, fence } = storeFixture("service-get-boundary");
  const turn = submittedTurn(store, fence);
  const adapter = serviceAdapter({
    events: vi.fn(async () => ({
      latestSeq: 5,
      inputAccepted: true,
      assistantDelta: "Inline payload is not authority.",
      completed: false,
      error: null,
      interactionReferences: [{ interactionId: INTERACTION_ID, kind: "user_question" as const, status: "pending" as const }],
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    getInteraction: vi.fn(async () => ({ ...snapshot, payload: questionPayload() })),
  });
  const service = new LunaControllerService({ store, adapter, evidenceProjector: testEvidenceProjector, clock: { now: () => 3_000 } });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(true);

  expect(adapter.getInteraction).toHaveBeenCalledTimes(1);
  expect(store.getPendingControllerInteraction(turn.controllerKey)).toBeNull();
  expect(store.getOutbox(`controller-interaction:${INTERACTION_ID}:0`)).toBeNull();
});

it("rejects an exact interaction read after the controller generation changes", async () => {
  const { db, store, fence } = storeFixture("service-generation-boundary");
  const turn = submittedTurn(store, fence);
  const generation = store.listControllerGenerations(turn.controllerKey, 1)[0];
  if (!generation) throw new Error("missing controller generation");
  const getInteraction = vi.fn(async () => {
    db.prepare(
      "UPDATE controller_generations SET ended_at = ?, end_reason = ? WHERE id = ?",
    ).run(3_001, "takeover", generation.id);
    return {
      id: INTERACTION_ID,
      threadId: "thr_controller",
      status: "pending",
      payload: questionPayload(),
    };
  });
  const adapter = serviceAdapter({
    events: vi.fn(async () => ({
      latestSeq: 5,
      inputAccepted: true,
      assistantDelta: "Generation changed.",
      completed: false,
      error: null,
      interactionReferences: [{ interactionId: INTERACTION_ID, kind: "user_question" as const, status: "pending" as const }],
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    getInteraction,
  });
  const service = new LunaControllerService({ store, adapter, evidenceProjector: testEvidenceProjector, clock: { now: () => 3_000 } });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(true);

  expect(getInteraction).toHaveBeenCalledTimes(1);
  expect(store.getPendingControllerInteraction(turn.controllerKey)).toBeNull();
});

it.each(["resolved", "interrupted"] as const)("does not settle a lifecycle reference without a durable exact answer when BB is %s", async (status) => {
  const { store, fence } = storeFixture("service-resolved-interaction");
  const turn = submittedTurn(store, fence);
  expect(recordQuestion(store, fence, turn)).toBe("recorded");
  const adapter = serviceAdapter({
    events: vi.fn(async () => ({
      latestSeq: 5,
      inputAccepted: true,
      assistantDelta: "Done.",
      completed: false,
      error: null,
      interactionReferences: [{ interactionId: INTERACTION_ID, kind: "user_question" as const, status: "pending" as const }],
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    getInteraction: vi.fn(async (threadId: string, interactionId: string) => ({
      id: interactionId,
      threadId,
      status,
      payload: null,
    })),
  });
  const service = new LunaControllerService({ store, adapter, evidenceProjector: testEvidenceProjector, clock: { now: () => 3_000 } });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(true);

  expect(adapter.getInteraction).toHaveBeenCalledWith("thr_controller", INTERACTION_ID, signal);
  expect(adapter.answerQuestion).not.toHaveBeenCalled();
  expect(store.getPendingControllerInteraction(turn.controllerKey)).toMatchObject({ interactionId: INTERACTION_ID });
  expect(store.getControllerTurn(turn.id)?.awaitingInteractionId).toBe(INTERACTION_ID);
});

it("delivers the owner's answer back to the blocked BB thread", async () => {
  const { store, fence } = storeFixture("service-answer");
  const turn = submittedTurn(store, fence);
  expect(recordQuestion(store, fence, turn)).toBe("recorded");
  expect(store.answerControllerInteractionByToken({
    token: questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_A),
    userId: "7",
    chatId: "7",
    now: 4_000,
  }).ok).toBe(true);
  const adapter = serviceAdapter({
    getInteraction: vi.fn(async (threadId: string, interactionId: string) => {
      const answered = store.getAnsweredControllerInteraction(turn.controllerKey);
      return {
        id: interactionId,
        threadId,
        status: answered ? "resolved" : "pending",
        payload: questionPayload(),
        resolution: answered?.resolution ?? null,
      };
    }),
  });
  const service = new LunaControllerService({ store, adapter, evidenceProjector: testEvidenceProjector, clock: { now: () => 4_100 } });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(true);

  expect(adapter.answerQuestion).toHaveBeenCalledWith(
    "thr_controller",
    INTERACTION_ID,
    { [QUESTION_ID]: { selected: [OPTION_A] } },
    signal,
  );
  // Delivered once: a second pass must not answer the same interaction again.
  const second = new LunaControllerService({ store, adapter, evidenceProjector: testEvidenceProjector, clock: { now: () => 4_200 } });
  await second.reconcile({ ...fence, signal }, signal);
  expect(adapter.answerQuestion).toHaveBeenCalledTimes(1);
});

it("gives up on a turn that stopped producing events and unblocks the queue", async () => {
  const { store, fence } = storeFixture("service-stall");
  const turn = submittedTurn(store, fence);
  const service = new LunaControllerService({
    store,
    adapter: serviceAdapter(),
    evidenceProjector: testEvidenceProjector,
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
  expect(recordQuestion(store, fence, turn, 2_500)).toBe("recorded");
  const service = new LunaControllerService({
    store,
    adapter: serviceAdapter(),
    evidenceProjector: testEvidenceProjector,
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
  const service = new LunaControllerService({ store, adapter, evidenceProjector: testEvidenceProjector, clock: { now: () => 2_200 } });
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
  const service = new LunaControllerService({ store, adapter, evidenceProjector: testEvidenceProjector, clock: { now: () => 2_200 } });
  const signal = AbortSignal.timeout(2_000);

  await service.reconcile({ ...fence, signal }, signal);

  expect(store.getControllerTurn(correction.id)?.state).toBe("queued");
});

it("retires a parked question when its turn dies, so later messages are not swallowed", () => {
  const { store, fence } = storeFixture("orphan");
  const turn = submittedTurn(store, fence);
  expect(recordQuestion(store, fence, turn)).toBe("recorded");

  expect(store.failControllerTurn({
    ...fence,
    now: 4_000,
    turnId: turn.id,
    error: "Controller provider turn failed",
  })).toBe(true);

  expect(store.getPendingControllerInteraction("owner-7-controller")).toBeNull();
  expect(store.answerControllerInteractionWithText({
    controllerKey: "owner-7-controller",
    userId: "7",
    chatId: "7",
    text: "cluster them",
    now: 4_100,
  })).toEqual({ ok: false, reason: "stale" });
});

it("does not deliver an answer whose turn died before BB heard it", async () => {
  const { store, fence } = storeFixture("orphan-answer");
  const turn = submittedTurn(store, fence);
  expect(recordQuestion(store, fence, turn)).toBe("recorded");
  store.answerControllerInteractionByToken({
    token: questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_A),
    userId: "7",
    chatId: "7",
    now: 3_500,
  });
  store.failControllerTurn({ ...fence, now: 4_000, turnId: turn.id, error: "Controller provider turn failed" });
  const adapter = serviceAdapter();
  const service = new LunaControllerService({ store, adapter, evidenceProjector: testEvidenceProjector, clock: { now: () => 4_100 } });
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
  const service = new LunaControllerService({ store, adapter, evidenceProjector: testEvidenceProjector, clock: { now: () => 2_200 } });
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
    evidenceProjector: testEvidenceProjector,
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
