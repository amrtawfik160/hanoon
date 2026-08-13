import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { createHash } from "node:crypto";
import { expect, expectTypeOf, it } from "vitest";
import type { ControllerTurnRecord } from "../src/controller/models";
import { hashSecret } from "../src/crypto";
import { ALL_MIGRATIONS } from "../src/storage/migrations";
import { IdempotencyConflictError, openStore } from "../src/storage/store";
import { completeAcceptedControllerTurn } from "./support/controller-trust-fixtures";

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

function pendingSpawnFixture(updateId = 901) {
  const { bb, store } = fixture();
  const turn = store.enqueueControllerTurn(turnInput(updateId));
  const fence = acquire(store);
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  const controller = store.getControllerForOwner("7", "7");
  if (!controller?.pendingSpawnToken) throw new Error("missing pending controller spawn token");
  return {
    bb,
    store,
    turn,
    controller,
    fence,
    identity: {
      controllerKey: controller.controllerKey,
      turnId: turn.id,
      pendingSpawnToken: controller.pendingSpawnToken,
      now: fence.now,
    },
  };
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
    "a02875eab12120926d87ea4e759944dc6646c33b7dd019cc71edf016d28b7410",
  );
});

it("runs the exact legacy interaction preflight during store startup", () => {
  const { bb } = createFakePluginHost({ pluginId: "telegram-controller-store-legacy-preflight" });
  const db = bb.storage.database();
  bb.storage.migrate(db, ALL_MIGRATIONS.slice(0, 29));
  db.prepare(
    `INSERT INTO controller_threads (
       controller_key, telegram_user_id, telegram_chat_id, project_id, host_id,
       bb_thread_id, state, pending_spawn_token, last_error, created_at, updated_at
     ) VALUES ('legacy_controller', '7', '70', 'proj_1', 'host_1', 'thr_legacy', 'active', NULL, NULL, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO controller_turns (
       id, telegram_update_id, controller_key, ordinal, input_text, state,
       lease_owner, lease_generation, submitted_at, created_at, updated_at
     ) VALUES ('legacy_turn', 1, 'legacy_controller', 1, 'legacy input', 'submitted', 'executor', 1, 1, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO controller_generations (id, controller_key, thread_id, started_at, ended_at, end_reason)
     VALUES ('legacy_generation', 'legacy_controller', 'thr_legacy', 1, NULL, NULL)`,
  ).run();
  db.prepare(
    `INSERT INTO controller_questions (
       interaction_id, turn_id, controller_key, questions_json, state, answers_json, asked_at, answered_at
     ) VALUES ('legacy_interaction', 'legacy_turn', 'legacy_controller', ?, 'pending', '{}', 2, NULL)`,
  ).run(JSON.stringify([{
    id: "question_1",
    prompt: "ＡＰＩ＿ＫＥＹ＝secret-value",
    options: [{ value: "first", label: "First", description: null }],
  }]));

  expect(() => openStore(bb.storage, bb.storage.kv, () => 2_000)).toThrow();
  expect(db.prepare("SELECT COUNT(*) AS count FROM _bb_migrations").get()).toEqual({ count: 29 });
  expect(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'controller_interactions'",
  ).get()).toBeUndefined();
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
  expect(store.reserveControllerSpawn({
    controllerKey: first.controllerKey,
    turnId: first.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    now: fence.now,
  })).toBe(true);
  expect(store.markControllerSpawned({
    turnId: first.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
    spawnToken: first.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: first.id, ...fence })).toBe(true);
  expect(store.claimNextControllerTurn(fence)).toBeNull();
  completeAcceptedControllerTurn(store, first, fence, "Hello.");
  expect(store.claimNextControllerTurn(fence)).toMatchObject({ updateId: 202, ordinal: 2 });
});

it("resolves only the exact live pending controller spawn identity", () => {
  const { store, identity, controller } = pendingSpawnFixture();

  expect(store.getControllerForPendingSpawn(identity)).toMatchObject({
    controllerKey: controller.controllerKey,
    state: "pending_spawn",
    threadId: null,
    pendingSpawnToken: identity.pendingSpawnToken,
  });

  const forged = [
    { ...identity, controllerKey: "owner-8-controller" },
    { ...identity, turnId: "controller-turn-999" },
    { ...identity, pendingSpawnToken: "controller-turn-999" },
  ];
  for (const candidate of forged) {
    expect(store.getControllerForPendingSpawn(candidate)).toBeNull();
  }
});

it("reserves and consumes one exact pending controller project/host scope", () => {
  const value = pendingSpawnFixture();
  const scope = {
    controllerKey: value.controller.controllerKey,
    turnId: value.turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    ...value.fence,
  };

  if (false) {
    // @ts-expect-error strict controller mapping requires the spawn token
    value.store.markControllerSpawned({
      ...value.fence,
      turnId: value.turn.id,
      projectId: "proj_personal",
      hostId: "host_personal",
      threadId: "thr_tokenless",
    });
  }
  expect(value.store.markControllerSpawned({
    ...value.fence,
    turnId: value.turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_unreserved",
    spawnToken: value.turn.id,
  })).toBe(false);
  expect(value.store.reserveControllerSpawn(scope)).toBe(true);
  expect(value.store.reserveControllerSpawn(scope)).toBe(true);
  expect(value.store.reserveControllerSpawn({ ...scope, projectId: "proj_other" })).toBe(false);
  expect(value.store.reserveControllerSpawn({ ...scope, hostId: "host_other" })).toBe(false);
  expect(value.store.markControllerSpawned({
    ...value.fence,
    turnId: value.turn.id,
    projectId: "proj_other",
    hostId: "host_personal",
    threadId: "thr_wrong_scope",
    spawnToken: value.turn.id,
  })).toBe(false);
  expect(value.store.markControllerSpawned({
    ...value.fence,
    turnId: value.turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_exact_scope",
    spawnToken: value.turn.id,
  })).toBe(true);
  expect(value.store.getControllerForOwner("7", "7")).toMatchObject({
    state: "active",
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_exact_scope",
    pendingSpawnToken: null,
  });
});

it("fails closed for stale, expired, and taken-over pending spawn reservations", () => {
  const expired = pendingSpawnFixture(902);
  expect(expired.store.reserveControllerSpawn({
    ...expired.fence,
    controllerKey: expired.controller.controllerKey,
    turnId: expired.turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    now: expired.fence.now + expired.fence.leaseMs + 1,
  })).toBe(false);
  expect(expired.store.getControllerForOwner("7", "7")).toMatchObject({ projectId: null, hostId: null });

  const takenOver = pendingSpawnFixture(903);
  const successor = takenOver.store.acquireExecutorLease("successor", takenOver.fence.now + takenOver.fence.leaseMs + 1, 30_000);
  if (!successor.acquired) throw new Error("missing successor lease");
  expect(takenOver.store.reserveControllerSpawn({
    now: takenOver.fence.now + takenOver.fence.leaseMs + 1,
    controllerKey: takenOver.controller.controllerKey,
    turnId: takenOver.turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
  })).toBe(false);

  const stale = pendingSpawnFixture(904);
  stale.bb.storage.database().prepare(
    "UPDATE controller_threads SET pending_spawn_token = ? WHERE controller_key = ?",
  ).run("controller-turn-stale", stale.controller.controllerKey);
  expect(stale.store.reserveControllerSpawn({
    ...stale.fence,
    controllerKey: stale.controller.controllerKey,
    turnId: stale.turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
  })).toBe(false);
  expect(stale.store.getControllerForOwner("7", "7")).toMatchObject({ projectId: null, hostId: null });
});

it("clears a reserved pending scope on requeue and ordinary controller failure", () => {
  const requeued = pendingSpawnFixture(905);
  expect(requeued.store.reserveControllerSpawn({
    ...requeued.fence,
    controllerKey: requeued.controller.controllerKey,
    turnId: requeued.turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
  })).toBe(true);
  expect(requeued.store.requeueControllerTurn({ ...requeued.fence, turnId: requeued.turn.id })).toBe(true);
  expect(requeued.store.getControllerForOwner("7", "7")).toMatchObject({ projectId: null, hostId: null, pendingSpawnToken: null });

  const failed = pendingSpawnFixture(906);
  expect(failed.store.reserveControllerSpawn({
    ...failed.fence,
    controllerKey: failed.controller.controllerKey,
    turnId: failed.turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
  })).toBe(true);
  expect(failed.store.failControllerTurn({
    ...failed.fence,
    turnId: failed.turn.id,
    error: "spawn failed",
  })).toBe(true);
  expect(failed.store.getControllerForOwner("7", "7")).toMatchObject({ projectId: null, hostId: null, pendingSpawnToken: null });

  const imageFailed = pendingSpawnFixture(907);
  expect(imageFailed.store.reserveControllerSpawn({
    ...imageFailed.fence,
    controllerKey: imageFailed.controller.controllerKey,
    turnId: imageFailed.turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
  })).toBe(true);
  expect(imageFailed.store.recordControllerImagePreparationFailure({
    ...imageFailed.fence,
    turnId: imageFailed.turn.id,
  })).toBe(true);
  expect(imageFailed.store.getControllerForOwner("7", "7")).toMatchObject({ projectId: null, hostId: null, pendingSpawnToken: null });

  const stale = pendingSpawnFixture(908);
  expect(stale.store.reserveControllerSpawn({
    ...stale.fence,
    controllerKey: stale.controller.controllerKey,
    turnId: stale.turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
  })).toBe(true);
  const staleSuccessor = stale.store.acquireExecutorLease("stale-successor", stale.fence.now + stale.fence.leaseMs + 1, 30_000);
  if (!staleSuccessor.acquired) throw new Error("missing stale successor lease");
  expect(stale.store.failStaleControllerDispatches({
    ownerId: "stale-successor",
    generation: staleSuccessor.generation,
    now: stale.fence.now + stale.fence.leaseMs + 1,
  })).toBe(true);
  expect(stale.store.getControllerForOwner("7", "7")).toMatchObject({ projectId: null, hostId: null, pendingSpawnToken: null });
});

it.each([
  ["queued turn", (value: ReturnType<typeof pendingSpawnFixture>) => {
    value.bb.storage.database().prepare(
      "UPDATE controller_turns SET state = 'queued' WHERE id = ?",
    ).run(value.turn.id);
  }],
  ["wrong turn lease owner", (value: ReturnType<typeof pendingSpawnFixture>) => {
    value.bb.storage.database().prepare(
      "UPDATE controller_turns SET lease_owner = 'other-executor' WHERE id = ?",
    ).run(value.turn.id);
  }],
  ["expired executor lease", (value: ReturnType<typeof pendingSpawnFixture>) => {
    value.bb.storage.database().prepare(
      "UPDATE executor_lease SET lease_expires_at = ? WHERE singleton = 1",
    ).run(value.identity.now);
  }],
  ["taken-over executor lease", (value: ReturnType<typeof pendingSpawnFixture>) => {
    expect(value.store.releaseExecutorLease(value.fence.ownerId, value.fence.generation, value.identity.now)).toBe(true);
    const successor = value.store.acquireExecutorLease("successor-executor", value.identity.now, 30_000);
    expect(successor).toMatchObject({ acquired: true });
  }],
  ["revoked owner", (value: ReturnType<typeof pendingSpawnFixture>) => {
    expect(value.store.revokeOwner(value.identity.now + 1)).toBe(true);
  }],
  ["revoked controller", (value: ReturnType<typeof pendingSpawnFixture>) => {
    value.bb.storage.database().prepare(
      "UPDATE controller_threads SET state = 'revoked' WHERE controller_key = ?",
    ).run(value.controller.controllerKey);
  }],
  ["mapped controller", (value: ReturnType<typeof pendingSpawnFixture>) => {
    expect(value.store.reserveControllerSpawn({
      ...value.fence,
      controllerKey: value.controller.controllerKey,
      turnId: value.turn.id,
      projectId: "proj_personal",
      hostId: "host_personal",
    })).toBe(true);
    expect(value.store.markControllerSpawned({
      ...value.fence,
      turnId: value.turn.id,
      projectId: "proj_personal",
      hostId: "host_personal",
      threadId: "thr_already_mapped",
      spawnToken: value.turn.id,
    })).toBe(true);
  }],
] as const)("fails closed for a %s pending-spawn adversary", (_label, mutate) => {
  const value = pendingSpawnFixture();
  mutate(value);
  expect(value.store.getControllerForPendingSpawn(value.identity)).toBeNull();
});

it("fences controller mapping to the exact pending turn token and one unmapped controller", () => {
  const value = pendingSpawnFixture();

  value.bb.storage.database().prepare(
    "UPDATE controller_threads SET pending_spawn_token = ? WHERE controller_key = ?",
  ).run("controller-turn-other", value.controller.controllerKey);
  expect(value.store.markControllerSpawned({
    ...value.fence,
    turnId: value.turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_wrong_token",
    spawnToken: value.turn.id,
  })).toBe(false);
  expect(value.store.getControllerForOwner("7", "7")).toMatchObject({
    state: "pending_spawn",
    threadId: null,
    pendingSpawnToken: "controller-turn-other",
  });

  value.bb.storage.database().prepare(
    "UPDATE controller_threads SET pending_spawn_token = ? WHERE controller_key = ?",
  ).run(value.turn.id, value.controller.controllerKey);
  expect(value.store.markControllerSpawned({
    ...value.fence,
    turnId: value.turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_wrong_spawn_token",
    spawnToken: "controller-turn-other",
  })).toBe(false);
  expect(value.store.reserveControllerSpawn({
    ...value.fence,
    controllerKey: value.controller.controllerKey,
    turnId: value.turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
  })).toBe(true);
  expect(value.store.markControllerSpawned({
    ...value.fence,
    turnId: value.turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_first_mapping",
    spawnToken: value.turn.id,
  })).toBe(true);
  expect(value.store.markControllerSpawned({
    ...value.fence,
    turnId: value.turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_second_mapping",
    spawnToken: value.turn.id,
  })).toBe(false);
  expect(value.store.getControllerForOwner("7", "7")).toMatchObject({
    state: "active",
    threadId: "thr_first_mapping",
    pendingSpawnToken: null,
  });
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

  expect(store.reserveControllerSpawn({
    controllerKey: turn.controllerKey,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    now: fence.now,
  })).toBe(true);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation + 1,
    now: fence.now,
    leaseMs: fence.leaseMs,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_stale",
    spawnToken: turn.id,
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
  expect(store.reserveControllerSpawn({
    controllerKey: first.controllerKey,
    turnId: first.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    now: fence.now,
  })).toBe(true);
  expect(store.markControllerSpawned({
    turnId: first.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_failed_init",
    spawnToken: first.id,
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
  expect(store.reserveControllerSpawn({
    controllerKey: turn.controllerKey,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    now: fence.now,
  })).toBe(true);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_stream",
    spawnToken: turn.id,
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
  completeAcceptedControllerTurn(store, turn, fence, "Hello final");
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
  expect(store.reserveControllerSpawn({
    controllerKey: turn.controllerKey,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    now: fence.now,
  })).toBe(true);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_slow",
    spawnToken: turn.id,
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
  expect(store.reserveControllerSpawn({
    controllerKey: turn.controllerKey,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    now: fence.now,
  })).toBe(true);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_atomic_failure",
    spawnToken: turn.id,
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

it("sends the accepted controller answer as the durable finalization text", () => {
  const { store } = fixture();
  const turn = store.enqueueControllerTurn(turnInput(701));
  const fence = acquire(store);
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  expect(store.reserveControllerSpawn({
    controllerKey: turn.controllerKey,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    now: fence.now,
  })).toBe(true);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_formatting",
    spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: turn.id, ...fence })).toBe(true);

  completeAcceptedControllerTurn(store, turn, fence, "**Reduce complexity** — active\n- one item");

  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload).toMatchObject({
    text: "**Reduce complexity** — active\n- one item",
    disable_web_page_preview: true,
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
  expect(store.reserveControllerSpawn({
    controllerKey: turn.controllerKey,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    now: fence.now,
  })).toBe(true);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_owner",
    spawnToken: turn.id,
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
  expect(store.reserveControllerSpawn({
    controllerKey: turn.controllerKey,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    now: fence.now,
  })).toBe(true);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_old_context",
    spawnToken: turn.id,
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
