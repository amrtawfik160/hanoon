import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import Database from "better-sqlite3";
import { openStore } from "../src/storage/store";
import { BbControllerAdapter, type ControllerAdapter } from "../src/controller/bb-controller";
import { CONTROLLER_STALL_MS, LunaControllerService } from "../src/controller/service";
import { ControllerInteractionService } from "../src/controller/interaction-service";
import { ControllerInteractionRepository } from "../src/storage/controller-interaction-repository";
import { DEFAULT_CONTROLLER_EXECUTION_PROFILE } from "../src/controller/execution-profile";
import {
  parseControllerInteraction,
  questionOptionToken,
  renderControllerInteraction,
  threadDecisionToken,
} from "../src/controller/questions";
import type { ControllerEvidenceReconciler } from "../src/controller/evidence-projector";

const evidenceProjector: ControllerEvidenceReconciler = {
  reconcile: vi.fn(async (_controller, turn) => ({
    outcome: "reconciled" as const,
    reconciliationIncomplete: null,
    fromSeq: turn.evidenceEventSeq,
    throughSeq: turn.evidenceEventSeq,
    targetSeq: turn.evidenceEventSeq,
  })),
};

const INTERACTION_ID = "pint_4k97457aun";
const APPROVAL_ID = "pint_approval_1";
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

function questionInteraction() {
  return {
    kind: "user_question" as const,
    interactionId: INTERACTION_ID,
    questions: questionPayload().questions,
  };
}

function approvalInteraction(decisions: ("allow_once" | "deny")[] = ["allow_once", "deny"]) {
  return {
    kind: "approval" as const,
    interactionId: APPROVAL_ID,
    summary: "wants to run:\n\n`npm test`",
    decisions,
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

function permissionEvent(seq: number, status: string, subjectKind = "permission_grant") {
  return {
    id: `p${seq}`,
    threadId: "thr_controller",
    seq,
    createdAt: seq,
    scope: { kind: "turn" },
    type: "system/permissionGrant/lifecycle",
    data: {
      interactionId: APPROVAL_ID,
      providerId: "claude-code",
      status,
      resolution: null,
      subject: { kind: subjectKind, itemId: "item-1", toolName: "bash", permissions: {} },
    },
  };
}

function adapterFixture(options: { events?: unknown[] } = {}) {
  const resolve = vi.fn(async () => ({ id: INTERACTION_ID, status: "resolving" }));
  const send = vi.fn(async () => ({ ok: true }));
  // BB pages events strictly after the cursor, so a fixture that ignored
  // `afterSeq` could never show whether a bounded window resumes correctly.
  const eventsList = vi.fn(async ({ afterSeq }: { afterSeq?: string } = {}) => {
    const rows = (options.events ?? []) as { seq: number }[];
    const after = Number(afterSeq ?? "0");
    return Number.isFinite(after) ? rows.filter((row) => row.seq > after) : rows;
  });
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

it("observes both controller question and permission lifecycles as bounded references", async () => {
  const { adapter } = adapterFixture({
    events: [lifecycleEvent(5, "pending"), permissionEvent(6, "pending")],
  });

  const observation = await adapter.events("thr_controller", 0, AbortSignal.timeout(1_000));

  expect(observation.interactions).toEqual([
    { interactionId: INTERACTION_ID, kind: "user_question", status: "pending" },
    { interactionId: APPROVAL_ID, kind: "approval", status: "pending" },
  ]);
});

it("carries no inline question payload on the observation", async () => {
  const { adapter } = adapterFixture({ events: [lifecycleEvent(5, "pending")] });

  const observation = await adapter.events("thr_controller", 0, AbortSignal.timeout(1_000));

  expect(observation).not.toHaveProperty("pendingQuestion");
  expect(JSON.stringify(observation)).not.toContain("How should I run the fix threads?");
});

it("keeps only the last lifecycle status for a repeated or reordered reference", async () => {
  const { adapter } = adapterFixture({
    events: [lifecycleEvent(5, "pending"), lifecycleEvent(6, "pending"), lifecycleEvent(7, "resolved")],
  });

  const observation = await adapter.events("thr_controller", 0, AbortSignal.timeout(1_000));

  expect(observation.interactions).toEqual([
    { interactionId: INTERACTION_ID, kind: "user_question", status: "resolved" },
  ]);
});

it("reports an unrecognised permission subject as an unsupported reference", async () => {
  const { adapter } = adapterFixture({ events: [permissionEvent(5, "pending", "mystery")] });

  const observation = await adapter.events("thr_controller", 0, AbortSignal.timeout(1_000));

  expect(observation.interactions).toEqual([
    { interactionId: APPROVAL_ID, kind: "unsupported", status: "pending" },
  ]);
});

it.each([
  ["a status the plugin cannot act on", { status: "resolving" }],
  ["an unknown status", { status: "who-knows" }],
  ["an interaction id it cannot bound", { interactionId: "x".repeat(4_000) }],
  ["a missing interaction id", { interactionId: undefined }],
])("refuses to read past a lifecycle row carrying %s", async (_scenario, overrides) => {
  const event = lifecycleEvent(5, "pending");
  const { adapter } = adapterFixture({
    events: [{ ...event, data: { ...event.data, ...overrides } }],
  });

  // Consuming this row would advance the cursor past a block the plugin cannot
  // describe, losing it for good. Failing the whole window keeps it unread.
  await expect(adapter.events("thr_controller", 0, AbortSignal.timeout(1_000)))
    .rejects.toThrow(/lifecycle/i);
});

it("reads a window whose lifecycle rows are all projectable", async () => {
  const { adapter } = adapterFixture({ events: [lifecycleEvent(5, "pending")] });

  const observation = await adapter.events("thr_controller", 0, AbortSignal.timeout(1_000));

  expect(observation.latestSeq).toBe(5);
  expect(observation.interactions).toHaveLength(1);
});

it("keeps the cursor behind a malformed lifecycle row that follows good events", async () => {
  const malformed = lifecycleEvent(6, "resolving");
  const { adapter } = adapterFixture({
    events: [
      { id: "t5", threadId: "thr_controller", seq: 5, createdAt: 5, scope: { kind: "turn" },
        type: "turn/input/accepted", data: {} },
      malformed,
    ],
  });

  await expect(adapter.events("thr_controller", 0, AbortSignal.timeout(1_000)))
    .rejects.toThrow(/lifecycle/i);
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

it("renders exactly Allow once and Deny for a supported approval", () => {
  const rendered = renderControllerInteraction(approvalInteraction());

  expect(rendered?.reply_markup?.inline_keyboard.flat().map((button) => button.text))
    .toEqual(["Allow once", "Deny"]);
  expect(JSON.stringify(rendered)).not.toContain("allow_for_session");
  expect(JSON.stringify(rendered)).not.toContain("Allow all session");
  for (const button of rendered?.reply_markup?.inline_keyboard.flat() ?? []) {
    expect(button.callback_data).toMatch(/^i:[A-Za-z0-9_-]{32}$/);
    expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
  }
});

it("renders an unsupported interaction with no buttons at all", () => {
  const rendered = renderControllerInteraction({
    kind: "unsupported",
    interactionId: "pint_unsupported",
    metadata: { sourceKind: "approval" },
  });

  expect(rendered?.reply_markup).toBeUndefined();
  expect(rendered?.text.length).toBeGreaterThan(0);
});

function storeFixture(name: string) {
  const { bb } = createFakePluginHost({ pluginId: `telegram-questions-${name}` });
  const storage = bb.storage;
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.createPairingCode(hashSecret("pair"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", 1_001)).toEqual({ ok: true });
  // Long enough that the stall-watchdog clock in these tests stays inside it.
  const lease = store.acquireExecutorLease("executor", 2_000, 60 * 60_000);
  if (!lease.acquired) throw new Error("missing lease");
  return {
    store,
    storage,
    db: bb.storage.database(),
    fence: { ownerId: "executor", generation: lease.generation },
  };
}

/** A second real connection to the same SQLite file, opened independently. */
function independentStore(fixture: ReturnType<typeof storeFixture>) {
  const connection = new Database(fixture.db.name);
  connection.pragma("busy_timeout = 5000");
  connection.pragma("foreign_keys = ON");
  return openStore(
    { ...fixture.storage, database: () => connection } as never,
    fixture.storage.kv,
    () => 4_000,
  );
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

function recordInteraction(
  store: ReturnType<typeof storeFixture>["store"],
  fence: { ownerId: string; generation: number },
  turnId: string,
  interaction: ReturnType<typeof questionInteraction> | ReturnType<typeof approvalInteraction>,
  now = 3_000,
): boolean {
  const generation = store.getOpenControllerGeneration("owner-7-controller", "thr_controller");
  if (!generation) throw new Error("missing open controller generation");
  return store.recordControllerInteraction({
    ...fence,
    now,
    turnId,
    controllerKey: "owner-7-controller",
    bbThreadId: "thr_controller",
    controllerGenerationId: generation.id,
    interaction,
  });
}

it("parks a submitted turn on its interaction and asks the owner in Telegram", () => {
  const { store, fence } = storeFixture("park");
  const turn = submittedTurn(store, fence);

  expect(recordInteraction(store, fence, turn.id, questionInteraction())).toBe(true);

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

it("asks an approval with only Allow once and Deny", () => {
  const { store, fence } = storeFixture("park-approval");
  const turn = submittedTurn(store, fence);

  expect(recordInteraction(store, fence, turn.id, approvalInteraction())).toBe(true);

  const asked = store.getOutbox(`controller-interaction:${APPROVAL_ID}:0`);
  expect(asked?.payload.reply_markup).toEqual({
    inline_keyboard: [
      [{ text: "Allow once", callback_data: `i:${threadDecisionToken(APPROVAL_ID, "allow_once")}` }],
      [{ text: "Deny", callback_data: `i:${threadDecisionToken(APPROVAL_ID, "deny")}` }],
    ],
  });
});

it("resolves a parked interaction from a tapped option and releases the turn", () => {
  const { store, fence } = storeFixture("tap");
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, questionInteraction());

  const answered = store.answerControllerInteractionByToken({
    token: questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_A),
    userId: "7",
    chatId: "7",
    callbackId: "cb-1",
    now: 4_000,
  });

  expect(answered).toMatchObject({ ok: true, turnId: turn.id, interactionId: INTERACTION_ID });
  expect(store.getControllerTurn(turn.id)?.awaitingInteractionId).toBe(INTERACTION_ID);
  expect(store.getAnsweredControllerInteraction("owner-7-controller")).toMatchObject({
    interactionId: INTERACTION_ID,
    answer: { kind: "user_answer", answers: { [QUESTION_ID]: { selected: [OPTION_A] } } },
  });
  expect(store.getCallback("cb-1")).toMatchObject({ action: "controller_interaction", outcome: "accepted" });
  expect(store.getOutbox("callback:cb-1")?.payload.text).toBe("Got it.");
});

it("is idempotent for a replayed callback id and never answers twice", () => {
  const { store, fence } = storeFixture("callback-replay");
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, approvalInteraction());
  const token = threadDecisionToken(APPROVAL_ID, "deny");

  expect(store.answerControllerInteractionByToken({ token, userId: "7", chatId: "7", callbackId: "cb-2", now: 4_000 }))
    .toMatchObject({ ok: true });
  expect(store.answerControllerInteractionByToken({ token, userId: "7", chatId: "7", callbackId: "cb-2", now: 4_001 }))
    .toEqual({ ok: false, reason: "replayed" });
  expect(store.getAnsweredControllerInteraction("owner-7-controller")).toMatchObject({
    answer: { decision: "deny" },
    answeredAt: 4_000,
  });
});

it("refuses a replayed token from a second callback once the interaction is answered", () => {
  const { store, fence } = storeFixture("token-replay");
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, approvalInteraction());
  const token = threadDecisionToken(APPROVAL_ID, "allow_once");

  expect(store.answerControllerInteractionByToken({ token, userId: "7", chatId: "7", callbackId: "cb-3", now: 4_000 }))
    .toMatchObject({ ok: true });
  expect(store.answerControllerInteractionByToken({ token, userId: "7", chatId: "7", callbackId: "cb-4", now: 4_001 }))
    .toEqual({ ok: false, reason: "stale" });
  expect(store.getCallback("cb-4")).toMatchObject({ outcome: "stale" });
});

it("keeps a button and a competing free-text answer to one winner", () => {
  const { store, fence } = storeFixture("button-vs-text");
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, questionInteraction());

  expect(store.answerControllerInteractionByToken({
    token: questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_B),
    userId: "7", chatId: "7", callbackId: "cb-5", now: 4_000,
  })).toMatchObject({ ok: true });
  expect(store.answerControllerInteractionWithText({
    controllerKey: "owner-7-controller", userId: "7", chatId: "7", text: "cluster them", now: 4_001,
  })).toEqual({ ok: false, reason: "stale", updateSettled: false });
  expect(store.getAnsweredControllerInteraction("owner-7-controller")?.answer)
    .toEqual({ kind: "user_answer", answers: { [QUESTION_ID]: { selected: [OPTION_B] } } });
});

it("resolves a parked question from a plain Telegram reply", () => {
  const { store, fence } = storeFixture("text");
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, questionInteraction());

  const answered = store.answerControllerInteractionWithText({
    controllerKey: "owner-7-controller",
    userId: "7",
    chatId: "7",
    text: "in review i mean not in progress",
    now: 4_000,
  });

  expect(answered).toMatchObject({ ok: true, turnId: turn.id, interactionId: INTERACTION_ID });
  expect(store.getAnsweredControllerInteraction("owner-7-controller")?.answer).toEqual({
    kind: "user_answer",
    answers: { [QUESTION_ID]: { selected: [], freeText: "in review i mean not in progress" } },
  });
});

it("never lets free text answer an approval", () => {
  const { store, fence } = storeFixture("text-approval");
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, approvalInteraction());

  expect(store.answerControllerInteractionWithText({
    controllerKey: "owner-7-controller", userId: "7", chatId: "7", text: "yes go ahead", now: 4_000,
  })).toEqual({ ok: false, reason: "stale", updateSettled: false });
  expect(store.getPendingControllerInteraction("owner-7-controller")?.state).toBe("pending");
});

it("refuses an answer from a user or chat that does not own the controller", () => {
  const { store, fence } = storeFixture("wrong-owner");
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, approvalInteraction());
  const token = threadDecisionToken(APPROVAL_ID, "deny");

  expect(store.answerControllerInteractionByToken({ token, userId: "8", chatId: "7", callbackId: "cb-6", now: 4_000 }))
    .toEqual({ ok: false, reason: "stale" });
  expect(store.answerControllerInteractionByToken({ token, userId: "7", chatId: "8", callbackId: "cb-7", now: 4_001 }))
    .toEqual({ ok: false, reason: "stale" });
  expect(store.getPendingControllerInteraction("owner-7-controller")?.state).toBe("pending");
});

function interactionServiceFor(
  fixture: ReturnType<typeof storeFixture>,
  interactions: { get: ReturnType<typeof vi.fn>; resolve: ReturnType<typeof vi.fn> },
  now: () => number,
) {
  return new ControllerInteractionService({
    store: new ControllerInteractionRepository(fixture.db),
    interactions: interactions as never,
    clock: now,
  });
}

function pendingGet(payload: unknown, interactionId = INTERACTION_ID) {
  return vi.fn(async () => ({
    id: interactionId,
    threadId: "thr_controller",
    status: "pending",
    payload,
  }));
}

function serviceAdapter(overrides: Partial<ControllerAdapter> = {}): ControllerAdapter {
  return {
    spawn: vi.fn(async () => ({ threadId: "thr_controller", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({
      latestSeq: 0,
      inputAccepted: false,
      assistantOutputObserved: false,
      toolActivityObserved: false,
      completed: false,
      error: null,
      interactions: [],
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    findSpawnCandidate: vi.fn(async () => null),
    ...overrides,
  };
}

it("parks the turn and asks in Telegram from an observed lifecycle reference", async () => {
  const fixture = storeFixture("service-park");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  const adapter = serviceAdapter({
    events: vi.fn(async () => ({
      latestSeq: 5,
      inputAccepted: true,
      assistantOutputObserved: true,
      toolActivityObserved: false,
      completed: false,
      error: null,
      interactions: [{ interactionId: INTERACTION_ID, kind: "user_question" as const, status: "pending" as const }],
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
  });
  const get = pendingGet(questionPayload());
  const interactionService = interactionServiceFor(fixture, { get, resolve: vi.fn() }, () => 3_000);
  const service = new LunaControllerService({
    store, adapter, evidenceProjector, interactionService, clock: { now: () => 3_000 },
  });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(true);

  expect(get).toHaveBeenCalledWith(expect.objectContaining({
    threadId: "thr_controller",
    interactionId: INTERACTION_ID,
  }));
  expect(store.getControllerTurn(turn.id)?.awaitingInteractionId).toBe(INTERACTION_ID);
  expect(store.getOutbox(`controller-interaction:${INTERACTION_ID}:0`)?.payload.text)
    .toContain("How should I run the fix threads?");
});

it("ignores an authoritative interaction whose returned identity does not match", async () => {
  const fixture = storeFixture("service-mismatch");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  const adapter = serviceAdapter({
    events: vi.fn(async () => ({
      latestSeq: 5, inputAccepted: true, assistantOutputObserved: false, toolActivityObserved: false,
      completed: false, error: null,
      interactions: [{ interactionId: INTERACTION_ID, kind: "user_question" as const, status: "pending" as const }],
      toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
  });
  const get = vi.fn(async () => ({
    id: "pint_other", threadId: "thr_controller", status: "pending", payload: questionPayload(),
  }));
  const interactionService = interactionServiceFor(fixture, { get, resolve: vi.fn() }, () => 3_000);
  const service = new LunaControllerService({
    store, adapter, evidenceProjector, interactionService, clock: { now: () => 3_000 },
  });
  const signal = AbortSignal.timeout(2_000);

  await service.reconcile({ ...fence, signal }, signal);

  expect(store.getControllerTurn(turn.id)?.awaitingInteractionId).toBeNull();
  expect(store.getPendingControllerInteraction("owner-7-controller")).toBeNull();
  // A reply about some other interaction proves nothing about this one, so the
  // cursor may not move past the event that named it.
  expect(store.getControllerTurn(turn.id)?.bbEventSeq).toBe(0);
});

it("cannot complete a turn or advance the cursor on a malformed lifecycle row", async () => {
  const fixture = storeFixture("service-malformed-lifecycle");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  // The real adapter over a stream whose only lifecycle row is unprojectable.
  const malformed = lifecycleEvent(5, "resolving");
  const sdkAdapter = new BbControllerAdapter({
    sdk: {
      threads: {
        get: vi.fn(async () => ({
          id: "thr_controller", status: "active", providerId: "claude-code",
          archivedAt: null, deletedAt: null,
        })),
        timeline: vi.fn(async () => ({ maxSeq: 5 })),
        events: { list: vi.fn(async () => [malformed]) },
        send: vi.fn(), spawn: vi.fn(), list: vi.fn(async () => []),
        interactions: { get: vi.fn(), resolve: vi.fn(), list: vi.fn(async () => []) },
      },
      projects: { list: vi.fn(async () => []) },
      hosts: { list: vi.fn(async () => []) },
    } as unknown as BbPluginApi["sdk"],
    pluginId: "telegram-agent",
    executionProfile: () => DEFAULT_CONTROLLER_EXECUTION_PROFILE,
  });
  const service = new LunaControllerService({
    store, adapter: sdkAdapter, evidenceProjector,
    interactionService: interactionServiceFor(fixture, { get: vi.fn(), resolve: vi.fn() }, () => 3_000),
    clock: { now: () => 3_000 },
  });
  const signal = AbortSignal.timeout(2_000);

  await service.reconcile({ ...fence, signal }, signal);

  const observed = store.getControllerTurn(turn.id);
  expect(observed?.bbEventSeq).toBe(0);
  expect(observed?.state).toBe("submitted");
});

it("refuses to advance the cursor past an interaction BB could not describe", async () => {
  const fixture = storeFixture("service-malformed-payload");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  const adapter = serviceAdapter({
    events: vi.fn(async () => ({
      latestSeq: 5, inputAccepted: true, assistantOutputObserved: false, toolActivityObserved: false,
      completed: false, error: null,
      interactions: [{ interactionId: INTERACTION_ID, kind: "user_question" as const, status: "pending" as const }],
      toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
  });
  // A payload that is not an object at all cannot be projected into anything,
  // safe or unsafe, so it is invalid rather than unsupported.
  const get = vi.fn(async () => ({
    id: INTERACTION_ID, threadId: "thr_controller", status: "pending", payload: "not-an-object",
  }));
  const interactionService = interactionServiceFor(fixture, { get, resolve: vi.fn() }, () => 3_000);
  const service = new LunaControllerService({
    store, adapter, evidenceProjector, interactionService, clock: { now: () => 3_000 },
  });
  const signal = AbortSignal.timeout(2_000);

  await service.reconcile({ ...fence, signal }, signal);

  expect(store.getPendingControllerInteraction("owner-7-controller")).toBeNull();
  expect(store.getControllerTurn(turn.id)?.bbEventSeq).toBe(0);
});

it("records an unanswerable but identified interaction so the cursor can move on", async () => {
  const fixture = storeFixture("service-unsupported-progress");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  const adapter = serviceAdapter({
    events: vi.fn(async () => ({
      latestSeq: 5, inputAccepted: true, assistantOutputObserved: false, toolActivityObserved: false,
      completed: false, error: null,
      interactions: [{ interactionId: INTERACTION_ID, kind: "user_question" as const, status: "pending" as const }],
      toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
  });
  const get = vi.fn(async () => ({
    id: INTERACTION_ID, threadId: "thr_controller", status: "pending",
    payload: { kind: "some_new_block" },
  }));
  const interactionService = interactionServiceFor(fixture, { get, resolve: vi.fn() }, () => 3_000);
  const service = new LunaControllerService({
    store, adapter, evidenceProjector, interactionService, clock: { now: () => 3_000 },
  });
  const signal = AbortSignal.timeout(2_000);

  await service.reconcile({ ...fence, signal }, signal);

  expect(store.getPendingControllerInteraction("owner-7-controller")).toMatchObject({
    interactionId: INTERACTION_ID,
  });
  expect(store.getControllerTurn(turn.id)?.bbEventSeq).toBe(5);
});

it("settles rather than skips an interaction BB has authoritatively closed", async () => {
  const fixture = storeFixture("service-authoritative-settled");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, questionInteraction(), 3_000);
  const adapter = serviceAdapter({
    events: vi.fn(async () => ({
      latestSeq: 5, inputAccepted: true, assistantOutputObserved: false, toolActivityObserved: false,
      completed: false, error: null,
      interactions: [{ interactionId: INTERACTION_ID, kind: "user_question" as const, status: "pending" as const }],
      toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
  });
  // The stream still called it pending, but BB itself says it is over. BB wins.
  const get = vi.fn(async () => ({
    id: INTERACTION_ID, threadId: "thr_controller", status: "resolved", payload: questionPayload(),
  }));
  const interactionService = interactionServiceFor(fixture, { get, resolve: vi.fn() }, () => 3_100);
  const service = new LunaControllerService({
    store, adapter, evidenceProjector, interactionService, clock: { now: () => 3_100 },
  });
  const signal = AbortSignal.timeout(2_000);

  await service.reconcile({ ...fence, signal }, signal);

  expect(store.getPendingControllerInteraction("owner-7-controller")).toBeNull();
  expect(store.getControllerTurn(turn.id)?.awaitingInteractionId).toBeNull();
  expect(store.getControllerTurn(turn.id)?.bbEventSeq).toBe(5);
});

it("delivers the owner's answer to BB before any evidence work and only once", async () => {
  const fixture = storeFixture("service-answer");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, questionInteraction());
  expect(store.answerControllerInteractionByToken({
    token: questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_A),
    userId: "7", chatId: "7", callbackId: "cb-answer", now: 4_000,
  })).toMatchObject({ ok: true });
  const get = pendingGet(questionPayload());
  const resolve = vi.fn(async () => ({ id: INTERACTION_ID, threadId: "thr_controller", status: "resolved" }));
  const interactionService = interactionServiceFor(fixture, { get, resolve }, () => 4_100);
  const adapter = serviceAdapter();
  (evidenceProjector.reconcile as ReturnType<typeof vi.fn>).mockClear();
  const service = new LunaControllerService({
    store, adapter, evidenceProjector, interactionService, clock: { now: () => 4_100 },
  });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(true);

  expect(resolve).toHaveBeenCalledWith({
    threadId: "thr_controller",
    interactionId: INTERACTION_ID,
    resolution: { kind: "user_answer", answers: { [QUESTION_ID]: { selected: [OPTION_A] } } },
  });
  expect(evidenceProjector.reconcile).not.toHaveBeenCalled();
  expect(store.getControllerTurn(turn.id)?.awaitingInteractionId).toBeNull();

  const second = new LunaControllerService({
    store, adapter, evidenceProjector, interactionService, clock: { now: () => 4_200 },
  });
  await second.reconcile({ ...fence, signal }, signal);
  expect(resolve).toHaveBeenCalledTimes(1);
});

it("adopts an already-resolved BB interaction instead of resolving it twice", async () => {
  const fixture = storeFixture("service-already-resolved");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, approvalInteraction());
  store.answerControllerInteractionByToken({
    token: threadDecisionToken(APPROVAL_ID, "allow_once"),
    userId: "7", chatId: "7", callbackId: "cb-adopt", now: 4_000,
  });
  const get = vi.fn(async () => ({
    id: APPROVAL_ID, threadId: "thr_controller", status: "resolved", payload: null,
  }));
  const resolve = vi.fn();
  const interactionService = interactionServiceFor(fixture, { get, resolve }, () => 4_100);
  const service = new LunaControllerService({
    store, adapter: serviceAdapter(), evidenceProjector, interactionService, clock: { now: () => 4_100 },
  });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(true);

  expect(resolve).not.toHaveBeenCalled();
  expect(store.getAnsweredControllerInteraction("owner-7-controller")).toBeNull();
  expect(store.getControllerTurn(turn.id)?.awaitingInteractionId).toBeNull();
});

it("gives up on a turn that stopped producing events and unblocks the queue", async () => {
  const fixture = storeFixture("service-stall");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  const service = new LunaControllerService({
    store,
    adapter: serviceAdapter(),
    evidenceProjector,
    interactionService: interactionServiceFor(fixture, { get: vi.fn(), resolve: vi.fn() }, () => 2_000),
    clock: { now: () => 2_000 + CONTROLLER_STALL_MS + 1 },
  });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)?.state).toBe("failed");
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text)
    .toBe("I couldn't complete that controller turn safely. Please resend your request.");
});

it("waits indefinitely while the owner still owes the thread an answer", async () => {
  const fixture = storeFixture("service-no-stall");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, questionInteraction(), 2_500);
  const service = new LunaControllerService({
    store,
    adapter: serviceAdapter(),
    evidenceProjector,
    interactionService: interactionServiceFor(fixture, { get: vi.fn(), resolve: vi.fn() }, () => 2_500),
    clock: { now: () => 2_000 + CONTROLLER_STALL_MS + 1 },
  });
  const signal = AbortSignal.timeout(2_000);

  await service.reconcile({ ...fence, signal }, signal);

  expect(store.getControllerTurn(turn.id)?.state).toBe("submitted");
});

it("suppresses draft refresh, steering, and supervisor work while an interaction is open", async () => {
  const fixture = storeFixture("service-parked-suppression");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, questionInteraction(), 2_500);
  store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 99,
    inputText: "and also check the logs",
    now: 2_600,
  });
  const adapter = serviceAdapter();
  const service = new LunaControllerService({
    store,
    adapter,
    evidenceProjector,
    interactionService: interactionServiceFor(fixture, { get: vi.fn(), resolve: vi.fn() }, () => 2_700),
    clock: { now: () => 2_700 },
  });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(true);

  expect(adapter.steer).not.toHaveBeenCalled();
  expect(store.getControllerTurn(turn.id)?.state).toBe("submitted");
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.reply_markup).toBeUndefined();
});

it("hands a message sent mid-answer to the thread already writing it", async () => {
  const fixture = storeFixture("service-steer");
  const { store, fence } = fixture;
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
  const service = new LunaControllerService({
    store, adapter, evidenceProjector,
    interactionService: interactionServiceFor(fixture, { get: vi.fn(), resolve: vi.fn() }, () => 2_200),
    clock: { now: () => 2_200 },
  });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(true);

  expect(adapter.steer).toHaveBeenCalledWith("thr_controller", "in review i mean not in progress", signal);
  expect(store.getControllerTurn(correction.id)?.state).toBe("completed");
  // The running answer still owns the reply; the correction gets no second one.
  expect(store.getOutbox(`controller:${correction.id}:reply`)).toBeNull();
  expect(store.getControllerTurn(running.id)?.state).toBe("submitted");
});

it("leaves a mid-answer message queued when the thread will not take it", async () => {
  const fixture = storeFixture("service-steer-fails");
  const { store, fence } = fixture;
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
  const service = new LunaControllerService({
    store, adapter, evidenceProjector,
    interactionService: interactionServiceFor(fixture, { get: vi.fn(), resolve: vi.fn() }, () => 2_200),
    clock: { now: () => 2_200 },
  });
  const signal = AbortSignal.timeout(2_000);

  await service.reconcile({ ...fence, signal }, signal);

  expect(store.getControllerTurn(correction.id)?.state).toBe("queued");
});

it("retires a parked interaction when its turn dies, so later messages are not swallowed", () => {
  const { store, fence } = storeFixture("orphan");
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, questionInteraction());

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
  })).toEqual({ ok: false, reason: "stale", updateSettled: false });
});

it("does not deliver an answer whose turn died before BB heard it", async () => {
  const fixture = storeFixture("orphan-answer");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, questionInteraction());
  store.answerControllerInteractionByToken({
    token: questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_A),
    userId: "7", chatId: "7", callbackId: "cb-orphan", now: 3_500,
  });
  store.failControllerTurn({ ...fence, now: 4_000, turnId: turn.id, error: "Controller provider turn failed" });
  const resolve = vi.fn();
  const service = new LunaControllerService({
    store,
    adapter: serviceAdapter(),
    evidenceProjector,
    interactionService: interactionServiceFor(fixture, { get: vi.fn(), resolve }, () => 4_100),
    clock: { now: () => 4_100 },
  });
  const signal = AbortSignal.timeout(2_000);

  await service.reconcile({ ...fence, signal }, signal);

  expect(resolve).not.toHaveBeenCalled();
});

it("stops re-steering a message the thread keeps refusing", async () => {
  const fixture = storeFixture("steer-bounded");
  const { store, fence } = fixture;
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
  const service = new LunaControllerService({
    store, adapter, evidenceProjector,
    interactionService: interactionServiceFor(fixture, { get: vi.fn(), resolve: vi.fn() }, () => 2_200),
    clock: { now: () => 2_200 },
  });
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
  const fixture = storeFixture("stall-retires");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  const service = new LunaControllerService({
    store,
    adapter: serviceAdapter(),
    evidenceProjector,
    interactionService: interactionServiceFor(fixture, { get: vi.fn(), resolve: vi.fn() }, () => 2_000),
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

it("keeps the oldest of two open interactions visible and promotes the next after it settles", () => {
  const { store, fence } = storeFixture("oldest-first");
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, questionInteraction(), 3_000);
  recordInteraction(store, fence, turn.id, approvalInteraction(), 3_001);

  expect(store.getPendingControllerInteraction("owner-7-controller")?.interactionId).toBe(INTERACTION_ID);
  expect(store.getControllerTurn(turn.id)?.awaitingInteractionId).toBe(INTERACTION_ID);
  // The newer approval's token cannot jump the queue.
  expect(store.answerControllerInteractionByToken({
    token: threadDecisionToken(APPROVAL_ID, "deny"),
    userId: "7", chatId: "7", callbackId: "cb-jump", now: 3_100,
  })).toEqual({ ok: false, reason: "stale" });

  expect(store.answerControllerInteractionByToken({
    token: questionOptionToken(INTERACTION_ID, QUESTION_ID, OPTION_A),
    userId: "7", chatId: "7", callbackId: "cb-first", now: 3_200,
  })).toMatchObject({ ok: true });
  expect(store.markControllerInteractionResolved({
    ...fence, now: 3_300, interactionId: INTERACTION_ID, turnId: turn.id, bbThreadId: "thr_controller",
  })).toBe(true);

  expect(store.getPendingControllerInteraction("owner-7-controller")?.interactionId).toBe(APPROVAL_ID);
  expect(store.getControllerTurn(turn.id)?.awaitingInteractionId).toBe(APPROVAL_ID);
});

it("settles a durable row from a resolved lifecycle without inventing an answer", async () => {
  const fixture = storeFixture("resolved-lifecycle");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, questionInteraction(), 3_000);
  const adapter = serviceAdapter({
    events: vi.fn(async () => ({
      latestSeq: 6, inputAccepted: true, assistantOutputObserved: false, toolActivityObserved: false,
      completed: false, error: null,
      interactions: [{ interactionId: INTERACTION_ID, kind: "user_question" as const, status: "resolved" as const }],
      toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
  });
  const get = vi.fn();
  const service = new LunaControllerService({
    store, adapter, evidenceProjector,
    interactionService: interactionServiceFor(fixture, { get, resolve: vi.fn() }, () => 3_100),
    clock: { now: () => 3_100 },
  });
  const signal = AbortSignal.timeout(2_000);

  await service.reconcile({ ...fence, signal }, signal);

  expect(get).not.toHaveBeenCalled();
  expect(store.getPendingControllerInteraction("owner-7-controller")).toBeNull();
  expect(store.getAnsweredControllerInteraction("owner-7-controller")).toBeNull();
  expect(store.getControllerTurn(turn.id)?.awaitingInteractionId).toBeNull();
});

it("keeps a committed tap durable across restart and retries only the exact resolution", async () => {
  const fixture = storeFixture("restart-before-resolve");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, approvalInteraction(), 3_000);
  expect(store.answerControllerInteractionByToken({
    token: threadDecisionToken(APPROVAL_ID, "allow_once"),
    userId: "7", chatId: "7", callbackId: "cb-restart", now: 3_100,
  })).toMatchObject({ ok: true });
  const resolve = vi.fn(async () => ({ id: APPROVAL_ID, threadId: "thr_controller", status: "resolved" }));
  const failingResolve = vi.fn(async () => { throw new Error("BB was unreachable"); });
  const get = pendingGet(null, APPROVAL_ID);
  const signal = AbortSignal.timeout(2_000);

  const crashed = new LunaControllerService({
    store, adapter: serviceAdapter(), evidenceProjector,
    interactionService: interactionServiceFor(fixture, { get, resolve: failingResolve }, () => 3_200),
    clock: { now: () => 3_200 },
  });
  await expect(crashed.reconcile({ ...fence, signal }, signal)).resolves.toBe(false);
  expect(store.getAnsweredControllerInteraction("owner-7-controller")).not.toBeNull();

  const restarted = new LunaControllerService({
    store, adapter: serviceAdapter(), evidenceProjector,
    interactionService: interactionServiceFor(fixture, { get, resolve }, () => 3_300),
    clock: { now: () => 3_300 },
  });
  await expect(restarted.reconcile({ ...fence, signal }, signal)).resolves.toBe(true);

  expect(resolve).toHaveBeenCalledOnce();
  expect(resolve).toHaveBeenCalledWith({
    threadId: "thr_controller",
    interactionId: APPROVAL_ID,
    resolution: { decision: "allow_once", grantedPermissions: null },
  });
  expect(store.getAnsweredControllerInteraction("owner-7-controller")).toBeNull();
});

it("retires a turn whose interaction boundary stays unreadable, and not before", async () => {
  const fixture = storeFixture("interaction-boundary");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  const adapter = serviceAdapter({
    events: vi.fn(async () => ({
      latestSeq: 5, inputAccepted: true, assistantOutputObserved: false, toolActivityObserved: false,
      completed: false, error: null,
      interactions: [{ interactionId: INTERACTION_ID, kind: "user_question" as const, status: "pending" as const }],
      toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
  });
  const get = vi.fn(async () => { throw new Error("BB interaction unavailable"); });
  const serviceAt = (now: number) => new LunaControllerService({
    store, adapter, evidenceProjector,
    interactionService: interactionServiceFor(fixture, { get, resolve: vi.fn() }, () => now),
    clock: { now: () => now },
  });
  const signal = AbortSignal.timeout(2_000);

  await expect(serviceAt(2_100).reconcile({ ...fence, signal }, signal)).resolves.toBe(false);
  expect(store.getControllerTurn(turn.id)?.state).toBe("submitted");

  await expect(serviceAt(2_000 + CONTROLLER_STALL_MS + 1).reconcile({ ...fence, signal }, signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "failed",
    lastError: "Controller interaction boundary remained unavailable",
  });
});

it("stops a window before a ninth distinct interaction instead of dropping references", async () => {
  const events = Array.from({ length: 12 }, (_value, index) => {
    const event = permissionEvent(index + 1, "pending");
    return { ...event, data: { ...event.data, interactionId: `pint_bulk_${index}` } };
  });
  const { adapter } = adapterFixture({ events });

  const observation = await adapter.events("thr_controller", 0, AbortSignal.timeout(1_000));

  expect(observation.interactions.map((reference) => reference.interactionId)).toEqual(
    Array.from({ length: 8 }, (_value, index) => `pint_bulk_${index}`),
  );
  // The cursor may only claim the events this window actually read. The ninth
  // interaction's event was not processed, so seq 9 is still unread work.
  expect(observation.latestSeq).toBe(8);
});

it("delivers twelve interaction references over bounded passes with no skipped seq", async () => {
  const events = Array.from({ length: 12 }, (_value, index) => {
    const event = permissionEvent(index + 1, "pending");
    return { ...event, data: { ...event.data, interactionId: `pint_bulk_${index}` } };
  });
  const { adapter } = adapterFixture({ events });

  const seen: string[] = [];
  let cursor = 0;
  for (let pass = 0; pass < 5; pass += 1) {
    const observation = await adapter.events("thr_controller", cursor, AbortSignal.timeout(1_000));
    expect(observation.interactions.length).toBeLessThanOrEqual(8);
    for (const reference of observation.interactions) seen.push(reference.interactionId);
    if (observation.latestSeq === cursor) break;
    cursor = observation.latestSeq;
  }

  expect(seen).toEqual(Array.from({ length: 12 }, (_value, index) => `pint_bulk_${index}`));
  expect(cursor).toBe(12);
});

it("never loses a settlement to a window boundary", async () => {
  const settled = permissionEvent(1, "resolved");
  const events = [
    { ...settled, data: { ...settled.data, interactionId: "pint_settled" } },
    ...Array.from({ length: 10 }, (_value, index) => {
      const event = permissionEvent(index + 2, "pending");
      return { ...event, data: { ...event.data, interactionId: `pint_open_${index}` } };
    }),
  ];
  const { adapter } = adapterFixture({ events });

  const first = await adapter.events("thr_controller", 0, AbortSignal.timeout(1_000));
  const second = await adapter.events("thr_controller", first.latestSeq, AbortSignal.timeout(1_000));

  // Losing this one would leave its durable row parked on a block BB closed.
  expect(first.interactions[0]).toEqual({
    interactionId: "pint_settled", kind: "approval", status: "resolved",
  });
  expect([...first.interactions, ...second.interactions].map((reference) => reference.interactionId))
    .toEqual(["pint_settled", ...Array.from({ length: 10 }, (_value, index) => `pint_open_${index}`)]);
});

it("counts only the metrics of the events a bounded window actually read", async () => {
  const events = [
    ...Array.from({ length: 9 }, (_value, index) => {
      const event = permissionEvent(index + 1, "pending");
      return { ...event, data: { ...event.data, interactionId: `pint_metric_${index}` } };
    }),
    {
      id: "t10", threadId: "thr_controller", seq: 10, createdAt: 10, scope: { kind: "turn" },
      type: "item/started", data: { item: { type: "commandExecution" } },
    },
    {
      id: "t11", threadId: "thr_controller", seq: 11, createdAt: 11, scope: { kind: "turn" },
      type: "turn/completed", data: {},
    },
  ];
  const { adapter } = adapterFixture({ events });

  const first = await adapter.events("thr_controller", 0, AbortSignal.timeout(1_000));

  // Seq 9 onward was never read, so claiming its tool call or its completion
  // would report work this pass did not observe.
  expect(first.latestSeq).toBe(8);
  expect(first.toolCalls).toBe(0);
  expect(first.completed).toBe(false);

  const second = await adapter.events("thr_controller", first.latestSeq, AbortSignal.timeout(1_000));

  expect(second.latestSeq).toBe(11);
  expect(second.toolCalls).toBe(1);
  expect(second.completed).toBe(true);
});

it("keeps retrying an undeliverable owner answer instead of retiring the turn", async () => {
  const fixture = storeFixture("undeliverable-answer");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, approvalInteraction(), 3_000);
  expect(store.answerControllerInteractionByToken({
    token: threadDecisionToken(APPROVAL_ID, "allow_once"),
    userId: "7", chatId: "7", callbackId: "cb-slow", now: 3_100,
  })).toMatchObject({ ok: true });
  const get = vi.fn(async () => { throw new Error("BB unavailable"); });
  // Far past the stall window: an owner may take any amount of time to answer,
  // and that thinking time must never be read as a wedged thread.
  const late = 3_100 + CONTROLLER_STALL_MS * 4;
  const service = new LunaControllerService({
    store, adapter: serviceAdapter(), evidenceProjector,
    interactionService: interactionServiceFor(fixture, { get, resolve: vi.fn() }, () => late),
    clock: { now: () => late },
  });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(false);

  expect(get).toHaveBeenCalledOnce();
  expect(store.getControllerTurn(turn.id)?.state).toBe("submitted");
  expect(store.getAnsweredControllerInteraction("owner-7-controller")).not.toBeNull();
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "active", threadId: "thr_controller" });
});

it("stays inside the reference cap even when settlements fill the whole window", async () => {
  const events = [
    ...Array.from({ length: 9 }, (_value, index) => {
      const event = permissionEvent(index + 1, "resolved");
      return { ...event, data: { ...event.data, interactionId: `pint_done_${index}` } };
    }),
    ...Array.from({ length: 5 }, (_value, index) => {
      const event = permissionEvent(index + 20, "pending");
      return { ...event, data: { ...event.data, interactionId: `pint_live_${index}` } };
    }),
  ];
  const { adapter } = adapterFixture({ events });

  const first = await adapter.events("thr_controller", 0, AbortSignal.timeout(1_000));

  expect(first.interactions).toHaveLength(8);
  expect(first.interactions.every((reference) => reference.status === "resolved")).toBe(true);

  // The ninth settlement and every live block behind it are still waiting, not
  // discarded, so a later pass is what delivers them.
  const second = await adapter.events("thr_controller", first.latestSeq, AbortSignal.timeout(1_000));

  expect(second.interactions.map((reference) => reference.interactionId)).toEqual([
    "pint_done_8",
    ...Array.from({ length: 5 }, (_value, index) => `pint_live_${index}`),
  ]);
});

it("never retires a parked turn for a transient BB boundary failure", async () => {
  const fixture = storeFixture("parked-boundary-failure");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, questionInteraction(), 3_000);
  const adapter = serviceAdapter({
    status: vi.fn(async () => { throw new Error("BB status unavailable"); }),
  });
  // Long past the stall window: the owner is simply taking their time, and a
  // parked turn emits no events to measure liveness with.
  const late = 3_000 + CONTROLLER_STALL_MS * 3;
  const service = new LunaControllerService({
    store, adapter, evidenceProjector,
    interactionService: interactionServiceFor(fixture, { get: vi.fn(), resolve: vi.fn() }, () => late),
    clock: { now: () => late },
  });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(false);

  expect(store.getControllerTurn(turn.id)?.state).toBe("submitted");
  expect(store.getPendingControllerInteraction("owner-7-controller")?.state).toBe("pending");
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "active", threadId: "thr_controller" });
});

it("projects a question the owner could never answer as unsupported", () => {
  const projected = parseControllerInteraction("pint_unanswerable", {
    kind: "user_question",
    questions: [{
      id: "dead",
      prompt: "Pick one",
      multiSelect: false,
      allowFreeText: false,
      options: [],
    }],
  });

  expect(projected).toEqual({
    kind: "unsupported",
    interactionId: "pint_unanswerable",
    metadata: { sourceKind: "user_question" },
  });
});

it("rolls the owner answer back with its callback and acknowledgement", () => {
  const { store, db, fence } = storeFixture("atomic-rollback");
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, approvalInteraction());
  // Fails the acknowledgement write only, inside the same transaction.
  db.exec(
    "CREATE TRIGGER block_callback_ack BEFORE INSERT ON outbox WHEN NEW.logical_key = 'callback:cb-rollback' BEGIN SELECT RAISE(ABORT, 'ack unavailable'); END",
  );

  expect(() => store.answerControllerInteractionByToken({
    token: threadDecisionToken(APPROVAL_ID, "deny"),
    userId: "7", chatId: "7", callbackId: "cb-rollback", now: 4_000,
  })).toThrow(/ack unavailable/);

  expect(store.getPendingControllerInteraction("owner-7-controller")?.state).toBe("pending");
  expect(store.getAnsweredControllerInteraction("owner-7-controller")).toBeNull();
  expect(store.getCallback("cb-rollback")).toBeNull();
  expect(store.getOutbox("callback:cb-rollback")).toBeNull();
});

it("settles two independent connections racing different decisions to one winner", () => {
  const fixture = storeFixture("two-connection-race");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, approvalInteraction());
  const other = independentStore(fixture);

  const first = store.answerControllerInteractionByToken({
    token: threadDecisionToken(APPROVAL_ID, "allow_once"),
    userId: "7", chatId: "7", callbackId: "cb-race-a", now: 4_000,
  });
  const second = other.answerControllerInteractionByToken({
    token: threadDecisionToken(APPROVAL_ID, "deny"),
    userId: "7", chatId: "7", callbackId: "cb-race-b", now: 4_001,
  });

  expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
  expect(first).toMatchObject({ ok: true });
  expect(second).toEqual({ ok: false, reason: "stale" });
  // Both connections agree on the single durable decision.
  expect(other.getAnsweredControllerInteraction("owner-7-controller")?.answer)
    .toEqual({ decision: "allow_once", grantedPermissions: null });
  expect(store.getAnsweredControllerInteraction("owner-7-controller")?.answer)
    .toEqual({ decision: "allow_once", grantedPermissions: null });
});

it("refuses an answer from an owner whose pairing was revoked", () => {
  const { store, db, fence } = storeFixture("revoked-owner");
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, approvalInteraction());
  db.prepare("UPDATE owners SET revoked_at = 3_500 WHERE singleton = 1").run();

  expect(store.answerControllerInteractionByToken({
    token: threadDecisionToken(APPROVAL_ID, "deny"),
    userId: "7", chatId: "7", callbackId: "cb-revoked", now: 4_000,
  })).toEqual({ ok: false, reason: "stale" });
  expect(store.answerControllerInteractionWithText({
    controllerKey: "owner-7-controller", userId: "7", chatId: "7", text: "go ahead", now: 4_001,
  })).toEqual({ ok: false, reason: "stale", updateSettled: false });
  // The row survives — it is BB's block, not the owner's — but nothing a
  // revoked owner sends can settle it.
  expect(store.getPendingControllerInteraction("owner-7-controller")?.state).toBe("pending");
  expect(store.getAnsweredControllerInteraction("owner-7-controller")).toBeNull();
});

it("records nothing when the controller generation moves between the get and the write", async () => {
  const fixture = storeFixture("generation-moved");
  const { store, db, fence } = fixture;
  const turn = submittedTurn(store, fence);
  const adapter = serviceAdapter({
    events: vi.fn(async () => ({
      latestSeq: 5, inputAccepted: true, assistantOutputObserved: false, toolActivityObserved: false,
      completed: false, error: null,
      interactions: [{ interactionId: INTERACTION_ID, kind: "user_question" as const, status: "pending" as const }],
      toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
  });
  const get = vi.fn(async () => {
    // The generation the reference was fenced against ends while BB is answering.
    db.prepare("UPDATE controller_generations SET ended_at = 3_050, end_reason = 'replaced' WHERE ended_at IS NULL").run();
    return { id: INTERACTION_ID, threadId: "thr_controller", status: "pending", payload: questionPayload() };
  });
  const service = new LunaControllerService({
    store, adapter, evidenceProjector,
    interactionService: interactionServiceFor(fixture, { get, resolve: vi.fn() }, () => 3_100),
    clock: { now: () => 3_100 },
  });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(false);

  expect(get).toHaveBeenCalledOnce();
  expect(store.getPendingControllerInteraction("owner-7-controller")).toBeNull();
  expect(store.getControllerTurn(turn.id)?.awaitingInteractionId).toBeNull();
});

it.each([
  ["missing", "Controller conversation became unavailable"],
  ["incompatible", "Controller provider became incompatible"],
] as const)("retires a turn parked on a %s thread instead of holding dead buttons forever", async (status, error) => {
  const fixture = storeFixture(`parked-lost-${status}`);
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, questionInteraction(), 3_000);
  const service = new LunaControllerService({
    store,
    adapter: serviceAdapter({ status: vi.fn(async () => status) }),
    evidenceProjector,
    interactionService: interactionServiceFor(fixture, { get: vi.fn(), resolve: vi.fn() }, () => 3_100),
    clock: { now: () => 3_100 },
  });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "failed", lastError: error });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "pending_spawn", threadId: null });
});

it("retires a turn whose answered interaction is parked on a thread BB lost", async () => {
  const fixture = storeFixture("answered-lost-thread");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, approvalInteraction(), 3_000);
  expect(store.answerControllerInteractionByToken({
    token: threadDecisionToken(APPROVAL_ID, "deny"),
    userId: "7", chatId: "7", callbackId: "cb-lost", now: 3_100,
  })).toMatchObject({ ok: true });
  const status = vi.fn(async () => "missing" as const);
  const service = new LunaControllerService({
    store,
    adapter: serviceAdapter({ status }),
    evidenceProjector,
    interactionService: interactionServiceFor(
      fixture,
      { get: vi.fn(async () => { throw new Error("thread is gone"); }), resolve: vi.fn() },
      () => 3_200,
    ),
    clock: { now: () => 3_200 },
  });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(true);

  expect(status).toHaveBeenCalled();
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "failed",
    lastError: "Controller conversation became unavailable",
  });
});

it("keeps BB's settlement rather than consuming it when the parked row refuses to settle", async () => {
  const fixture = storeFixture("settlement-not-lost");
  const { store, db, fence } = fixture;
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, questionInteraction(), 3_000);
  // Corrupt the row so every settlement write refuses it. The turn stays parked
  // by design, so consuming the resolved event would strand it forever.
  db.prepare("UPDATE controller_interactions SET payload_json = '{' WHERE interaction_id = ?").run(INTERACTION_ID);
  const adapter = serviceAdapter({
    events: vi.fn(async () => ({
      latestSeq: 9, inputAccepted: true, assistantOutputObserved: false, toolActivityObserved: false,
      completed: false, error: null,
      interactions: [{ interactionId: INTERACTION_ID, kind: "user_question" as const, status: "resolved" as const }],
      toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
  });
  const service = new LunaControllerService({
    store, adapter, evidenceProjector,
    interactionService: interactionServiceFor(fixture, { get: vi.fn(), resolve: vi.fn() }, () => 3_100),
    clock: { now: () => 3_100 },
  });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(false);

  // The event cursor did not advance past BB's settlement.
  expect(store.getControllerTurn(turn.id)?.bbEventSeq).toBe(0);
  expect(store.getControllerTurn(turn.id)?.awaitingInteractionId).toBe(INTERACTION_ID);
});

it("retires a turn parked on a lost thread even when the event boundary also fails", async () => {
  const fixture = storeFixture("parked-lost-events");
  const { store, fence } = fixture;
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, questionInteraction(), 3_000);
  const service = new LunaControllerService({
    store,
    adapter: serviceAdapter({
      status: vi.fn(async () => "missing" as const),
      events: vi.fn(async () => { throw new Error("thread events are gone"); }),
    }),
    evidenceProjector,
    interactionService: interactionServiceFor(fixture, { get: vi.fn(), resolve: vi.fn() }, () => 3_100),
    clock: { now: () => 3_100 },
  });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "failed",
    lastError: "Controller conversation became unavailable",
  });
});

it("keeps a second settlement in the same window when the promoted row refuses it", async () => {
  const fixture = storeFixture("second-settlement");
  const { store, db, fence } = fixture;
  const turn = submittedTurn(store, fence);
  recordInteraction(store, fence, turn.id, questionInteraction(), 3_000);
  recordInteraction(store, fence, turn.id, approvalInteraction(), 3_001);
  // The approval is the row promoted once the question settles, and it is the
  // one whose settlement must not be consumed.
  db.prepare("UPDATE controller_interactions SET payload_json = '{' WHERE interaction_id = ?").run(APPROVAL_ID);
  const adapter = serviceAdapter({
    events: vi.fn(async () => ({
      latestSeq: 9, inputAccepted: true, assistantOutputObserved: false, toolActivityObserved: false,
      completed: false, error: null,
      interactions: [
        { interactionId: INTERACTION_ID, kind: "user_question" as const, status: "resolved" as const },
        { interactionId: APPROVAL_ID, kind: "approval" as const, status: "resolved" as const },
      ],
      toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
  });
  const service = new LunaControllerService({
    store, adapter, evidenceProjector,
    interactionService: interactionServiceFor(fixture, { get: vi.fn(), resolve: vi.fn() }, () => 3_100),
    clock: { now: () => 3_100 },
  });
  const signal = AbortSignal.timeout(2_000);

  await expect(service.reconcile({ ...fence, signal }, signal)).resolves.toBe(false);

  expect(store.getControllerTurn(turn.id)?.bbEventSeq).toBe(0);
  expect(store.getControllerTurn(turn.id)?.awaitingInteractionId).toBe(APPROVAL_ID);
});
