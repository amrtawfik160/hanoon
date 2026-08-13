import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { createHash } from "node:crypto";
import { expect, expectTypeOf, it } from "vitest";
import type { ControllerTurnRecord } from "../src/controller/models";
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

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Applied migrations are immutable history: each release appends, so these are
// indexed from the start and a new migration only ever extends the tail.
it("keeps every shipped migration at its original position and appends new ones", () => {
  expect(ALL_MIGRATIONS).toHaveLength(30);
  expect(ALL_MIGRATIONS[3]).toContain("CREATE TABLE controller_threads");
  expect(ALL_MIGRATIONS[3]).toContain("CREATE TABLE controller_turns");
  expect(ALL_MIGRATIONS[4]).toContain("dispatch_after_seq");
  expect(ALL_MIGRATIONS[4]).toContain("telegram_message_id");
  expect(ALL_MIGRATIONS[5]).toContain("CREATE TABLE thread_operations");
  expect(ALL_MIGRATIONS[6]).toContain("CREATE TABLE pipeline_stage_attempts");
  expect(ALL_MIGRATIONS[7]).toContain("documentation_thread_id");
  expect(ALL_MIGRATIONS[8]).toContain("merge_commit_sha");
  expect(ALL_MIGRATIONS[8]).toContain("production_failed");
  expect(ALL_MIGRATIONS[9]).toContain("CREATE TABLE memories");
  expect(ALL_MIGRATIONS[9]).toContain("CREATE VIRTUAL TABLE memories_fts");
  expect(ALL_MIGRATIONS[10]).toContain("CREATE TABLE monitors");
  expect(ALL_MIGRATIONS[11]).toContain("CREATE TABLE tool_receipts");
  expect(ALL_MIGRATIONS[11]).toContain("CREATE TABLE controller_generations");
  expect(ALL_MIGRATIONS[12]).toContain("awaiting_interaction_id");
  expect(ALL_MIGRATIONS[12]).toContain("CREATE TABLE controller_questions");
  expect(ALL_MIGRATIONS[13]).toContain("CREATE TABLE observed_threads");
  expect(ALL_MIGRATIONS[13]).toContain("CREATE TABLE thread_interactions");
  expect(ALL_MIGRATIONS[14]).toContain("'unsupported'");
  expect(ALL_MIGRATIONS[15]).toContain("notified_at");
  expect(ALL_MIGRATIONS[16]).toContain("CREATE TABLE autonomy_sequence");
  expect(ALL_MIGRATIONS[17]).toContain("image_file_id");
  expect(ALL_MIGRATIONS[18]).toContain("tool_calls");
  expect(ALL_MIGRATIONS[18]).toContain("supervisor_reasons");
  expect(ALL_MIGRATIONS[19]).toContain("CREATE TABLE delegations");
  expect(ALL_MIGRATIONS[20]).toContain("CREATE TABLE job_memory_extractions");
  expect(ALL_MIGRATIONS[21]).toContain("CREATE TABLE memory_recalls");
  expect(ALL_MIGRATIONS[22]).toContain("ADD COLUMN system_key");
  expect(ALL_MIGRATIONS[23]).toContain("CREATE TABLE controller_overlay");
  expect(ALL_MIGRATIONS[24]).toContain("token_baseline");
  expect(ALL_MIGRATIONS[25]).toContain("sealed_at");
  expect(ALL_MIGRATIONS[26]).toContain("ADD COLUMN origin");
  expect(ALL_MIGRATIONS[27]).toContain("CREATE TABLE production_health");
  expect(ALL_MIGRATIONS[28]).toContain("CREATE TABLE controller_evidence");
  expect(ALL_MIGRATIONS[28]).toContain("CREATE TABLE controller_finalizations");
  expect(ALL_MIGRATIONS[28]).toContain("evidence_high_water_id INTEGER NOT NULL");
  expect(ALL_MIGRATIONS[29]).toContain("CREATE TABLE controller_interactions");
  expect(ALL_MIGRATIONS[29]).toContain("controller_generation_id");
});

it("pins the exact shipped and controller trust migration bytes in order", () => {
  expect(sha256(ALL_MIGRATIONS.slice(0, 28).join("\u0000"))).toBe(
    "505dfd4781117dfb2c817d31640e833370189e6b3ef2c7c24e646fb1838eed56",
  );
  expect(sha256(ALL_MIGRATIONS[28]!)).toBe(
    "4ec9eb259bbdce396ac0026c13ebd84ec71f25433092827cc9aae5fe903505d3",
  );
  expect(sha256(ALL_MIGRATIONS[29]!)).toBe(
    "d9afb52a02808d9d15c909afb30b87f7968fda5982a5d4359ce75549fdbb2c27",
  );
});

it("requires controller trust state on the public turn record", () => {
  expectTypeOf<ControllerTurnRecord["evidenceEventSeq"]>().toEqualTypeOf<number>();
  expectTypeOf<ControllerTurnRecord["completionContinuations"]>().toEqualTypeOf<number>();
  expectTypeOf<ControllerTurnRecord["acceptedFinalizationId"]>().toEqualTypeOf<number | null>();
  expectTypeOf<ControllerTurnRecord["evidenceLimitExceededAt"]>().toEqualTypeOf<number | null>();
});

it("enqueues Telegram controller turns idempotently and rejects changed replay input", () => {
  const { store } = fixture();
  const image = {
    fileId: "telegram-file-id",
    fileName: "telegram-screenshot.jpg",
    mimeType: "image/jpeg" as const,
    sizeBytes: 125_000,
  };

  const first = store.enqueueControllerTurn({ ...turnInput(101), image });

  expect(first).toMatchObject({
    controllerKey: "owner-7-controller",
    updateId: 101,
    ordinal: 1,
    inputText: "What can you do?",
    image,
    state: "queued",
    dispatchAfterSeq: 0,
    retryCount: 0,
    bbEventSeq: 0,
    streamText: "Hanoon is queued…",
    telegramMessageId: null,
    streamPhase: "queued",
    evidenceEventSeq: 0,
    completionContinuations: 0,
    acceptedFinalizationId: null,
    evidenceLimitExceededAt: null,
  });
  expect(store.enqueueControllerTurn({ ...turnInput(101), image })).toEqual(first);
  expect(() => store.enqueueControllerTurn(turnInput(101, "different"))).toThrow(IdempotencyConflictError);
  expect(() => store.enqueueControllerTurn({
    ...turnInput(101),
    image: { ...image, fileId: "different-file-id" },
  })).toThrow(IdempotencyConflictError);
});

it.each([
  ["negative evidence cursor", "evidence_event_seq", -1],
  ["unsafe evidence cursor", "evidence_event_seq", Number.MAX_SAFE_INTEGER + 1],
  ["negative continuation count", "completion_continuations", -1],
  ["unsafe continuation count", "completion_continuations", Number.MAX_SAFE_INTEGER + 1],
  ["zero accepted finalization id", "accepted_finalization_id", 0],
  ["unsafe accepted finalization id", "accepted_finalization_id", Number.MAX_SAFE_INTEGER + 1],
  ["negative evidence-limit timestamp", "evidence_limit_exceeded_at", -1],
  ["unsafe evidence-limit timestamp", "evidence_limit_exceeded_at", Number.MAX_SAFE_INTEGER + 1],
])("fails closed on a persisted %s", (_scenario, column, invalidValue) => {
  const { bb, store } = fixture();
  const turn = store.enqueueControllerTurn(turnInput(102));
  bb.storage.database().prepare(
    `UPDATE controller_turns SET ${column} = ? WHERE id = ?`,
  ).run(invalidValue, turn.id);

  expect(() => store.getControllerTurn(turn.id)).toThrow(/persisted controller turn/i);
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

it("counts a retryable image preparation failure while returning the turn to the queue", () => {
  const { store } = fixture();
  const turn = store.enqueueControllerTurn({
    ...turnInput(203, "inspect this image"),
    image: {
      fileId: "telegram-file-id",
      fileName: "telegram-screenshot.png",
      mimeType: "image/png",
      sizeBytes: null,
    },
  });
  const fence = acquire(store);
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);

  expect(store.recordControllerImagePreparationFailure({ ...fence, turnId: turn.id })).toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "queued", retryCount: 1 });
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
    payload: { text: "Hanoon is connecting…" },
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
    payload: { text: "Hanoon is responding…" },
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

it("fails and retires a submitted controller turn in one fenced operation", () => {
  const { store } = fixture();
  const turn = store.enqueueControllerTurn(turnInput(402));
  const fence = acquire(store);
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_atomic_failure",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: turn.id, ...fence })).toBe(true);

  expect(store.failAndRetireControllerTurn({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    expectedThreadId: "thr_atomic_failure",
    error: "Controller evidence could not be sealed",
  })).toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "failed" });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ threadId: null, state: "pending_spawn" });
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text)
    .toBe("I couldn't complete that controller turn safely. Please resend your request.");
});

it("sends a controller answer as Telegram HTML so its formatting renders", () => {
  const { store } = fixture();
  const turn = store.enqueueControllerTurn(turnInput(701));
  const fence = acquire(store);
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_formatting",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: turn.id, ...fence })).toBe(true);

  expect(store.completeControllerTurn({
    turnId: turn.id,
    ...fence,
    responseText: "**Reduce complexity** — active\n- one item",
  })).toBe(true);

  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload).toMatchObject({
    text: "<b>Reduce complexity</b> — active\n• one item",
    parse_mode: "HTML",
  });
});

it("finds the in-flight controller turn after a long conversation history", () => {
  const { bb, store } = fixture();
  const history = store.enqueueControllerTurn(turnInput(601));
  const db = bb.storage.database();
  const insert = db.prepare(
    `INSERT INTO controller_turns (id, telegram_update_id, controller_key, ordinal, input_text, state, created_at, updated_at)
     VALUES (?, ?, 'owner-7-controller', ?, 'older question', 'completed', 1, 1)`,
  );
  db.transaction(() => {
    db.prepare("UPDATE controller_turns SET state = 'completed' WHERE id = ?").run(history.id);
    for (let ordinal = 2; ordinal <= 1_100; ordinal += 1) {
      insert.run(`controller-turn-history-${ordinal}`, 700 + ordinal, ordinal);
    }
  })();
  const turn = store.enqueueControllerTurn(turnInput(9_001, "the newest question"));
  const fence = acquire(store);
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);

  expect(store.listControllerTurns("owner-7-controller", 1_000).some((row) => row.id === turn.id)).toBe(false);
  expect(store.getPendingControllerTurn("owner-7-controller")).toMatchObject({
    id: turn.id,
    state: "dispatching",
  });

  expect(store.requeueControllerTurn({ turnId: turn.id, ...fence })).toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "queued", leaseOwner: null });
  expect(store.getPendingControllerTurn("owner-7-controller")).toBeNull();
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
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
