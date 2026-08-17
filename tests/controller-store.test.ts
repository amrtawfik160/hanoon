import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { createHash } from "node:crypto";
import { expect, expectTypeOf, it } from "vitest";
import type { ControllerTurnRecord } from "../src/controller/models";
import { CONTROLLER_PHASE_TEXT } from "../src/controller/models";
import { hashSecret } from "../src/crypto";
import { ALL_MIGRATIONS } from "../src/storage/migrations";
import { IdempotencyConflictError, openStore, type ControllerFailureCode } from "../src/storage/store";
import { completeTurnThroughFinalization } from "./support/controller-trust-fixtures";

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

function nativeEvidenceCandidate(sourceItemId: string) {
  return {
    sourceName: "commandExecution" as const,
    sourceItemId,
    outcome: "succeeded" as const,
    argsSha256: "c".repeat(64),
    resultSha256: "d".repeat(64),
    proofKinds: ["command_result"] as const,
    subjectRefs: [`bb-item:${sourceItemId}`] as const,
  };
}

const GENERATION_REPAIR_MIGRATION_START = 52;
const PRESERVED_FINALIZATION_PAYLOAD = JSON.stringify({
  disposition: "answered",
  segments: [{ type: "text", text: "preserved finalization" }],
  obligationRefs: [],
});

function seedDuplicateControllerGenerations(
  bb: ReturnType<typeof createFakePluginHost>["bb"],
) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(0, GENERATION_REPAIR_MIGRATION_START));
  db.prepare(
    `INSERT INTO owners (
       singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at
     ) VALUES (1, '7', '7', 1_000, NULL)`,
  ).run();
  db.prepare(
    `INSERT INTO controller_threads (
       controller_key, telegram_user_id, telegram_chat_id, project_id, host_id,
       bb_thread_id, state, created_at, updated_at
     ) VALUES (
       'owner-7-controller', '7', '7', 'proj_personal', 'host_personal',
       'thr_corrupt_primary', 'active', 1_000, 1_500
     )`,
  ).run();
  db.prepare(
    `INSERT INTO controller_turns (
       id, telegram_update_id, controller_key, ordinal, input_text, state,
       lease_owner, lease_generation, submitted_at, created_at, updated_at
     ) VALUES (
       'turn-corrupt-submitted', 91_001, 'owner-7-controller', 1,
       'preserve submitted owner input', 'submitted', 'executor', 1, 1_500, 1_000, 1_500
     )`,
  ).run();
  db.prepare(
    `INSERT INTO controller_turns (
       id, telegram_update_id, controller_key, ordinal, input_text, state,
       created_at, updated_at
     ) VALUES (
       'turn-corrupt-queued', 91_002, 'owner-7-controller', 2,
       'preserve queued owner input', 'queued', 1_100, 1_100
     )`,
  ).run();
  const finalization = db.prepare(
    `INSERT INTO controller_finalizations (
       turn_id, revision, payload_json, rendered_message, evidence_high_water_id,
       state, rejection_code, created_at, validated_at, consumed_at
     ) VALUES (?, 1, ?, ?, 0, 'accepted', NULL, 1_400, 1_400, NULL)`,
  ).run(
    "turn-corrupt-submitted",
    PRESERVED_FINALIZATION_PAYLOAD,
    "preserved finalization",
  );
  db.prepare(
    "UPDATE controller_turns SET accepted_finalization_id = ? WHERE id = 'turn-corrupt-submitted'",
  ).run(Number(finalization.lastInsertRowid));
  db.prepare(
    `INSERT INTO controller_generations (
       id, controller_key, thread_id, started_at, ended_at, end_reason
     ) VALUES
       ('gen-corrupt-primary', 'owner-7-controller', 'thr_corrupt_primary', 1_200, NULL, NULL),
       ('gen-corrupt-other', 'owner-7-controller', 'thr_corrupt_other', 1_300, NULL, NULL)`,
  ).run();
  return { db, finalizationId: Number(finalization.lastInsertRowid) };
}

function expectDuplicateGenerationRepair(
  bb: ReturnType<typeof createFakePluginHost>["bb"],
  finalizationId: number,
) {
  const db = bb.storage.database();
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  expect(store.getControllerTurn("turn-corrupt-submitted")).toMatchObject({
    state: "queued",
    inputText: "preserve submitted owner input",
    acceptedFinalizationId: finalizationId,
    completionContinuations: 2,
  });
  expect(store.getControllerTurn("turn-corrupt-queued")).toMatchObject({
    state: "queued",
    inputText: "preserve queued owner input",
  });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({
    state: "pending_spawn",
    threadId: null,
  });
  expect(db.prepare(
    `SELECT id, controller_key, thread_id, started_at
       FROM controller_generations
      WHERE controller_key = 'owner-7-controller'
      ORDER BY id`,
  ).all()).toEqual([
    {
      id: "gen-corrupt-other",
      controller_key: "owner-7-controller",
      thread_id: "thr_corrupt_other",
      started_at: 1_300,
    },
    {
      id: "gen-corrupt-primary",
      controller_key: "owner-7-controller",
      thread_id: "thr_corrupt_primary",
      started_at: 1_200,
    },
  ]);
  expect(db.prepare(
    `SELECT generation_id, controller_key, thread_id, started_at,
            original_ended_at, original_end_reason, reason
       FROM controller_generation_quarantine
      ORDER BY generation_id`,
  ).all()).toEqual([
    {
      generation_id: "gen-corrupt-other",
      controller_key: "owner-7-controller",
      thread_id: "thr_corrupt_other",
      started_at: 1_300,
      original_ended_at: null,
      original_end_reason: null,
      reason: "ambiguous_open_generations",
    },
    {
      generation_id: "gen-corrupt-primary",
      controller_key: "owner-7-controller",
      thread_id: "thr_corrupt_primary",
      started_at: 1_200,
      original_ended_at: null,
      original_end_reason: null,
      reason: "ambiguous_open_generations",
    },
  ]);
  expect(db.prepare(
    "SELECT payload_json, consumed_at FROM controller_finalizations WHERE id = ?",
  ).get(finalizationId)).toEqual({
    payload_json: PRESERVED_FINALIZATION_PAYLOAD,
    consumed_at: null,
  });
  expect(store.getOutbox("controller-generation-recovery:owner-7-controller")?.payload).toEqual({
    text: "I preserved that message because its delivery could not be confirmed. It will be reconciled before any action is repeated.",
    disable_web_page_preview: true,
  });
  expect(db.prepare(
    "SELECT COUNT(*) AS count FROM outbox WHERE logical_key = 'controller-generation-recovery:owner-7-controller'",
  ).get()).toEqual({ count: 1 });
}

// Applied migrations are immutable history: each release appends, so these are
// indexed from the start and a new migration only ever extends the tail.
it("keeps every shipped migration at its original position and appends new ones", () => {
  expect(ALL_MIGRATIONS).toHaveLength(70);
  expect(ALL_MIGRATIONS[65]).toContain("CREATE TABLE reference_documents");
  expect(ALL_MIGRATIONS[66]).toContain("thread_interactions ADD COLUMN controller_key");
  expect(ALL_MIGRATIONS[67]).toContain("CREATE TABLE reference_section_digests");
  expect(ALL_MIGRATIONS[68]).toContain("CREATE TABLE project_admission_pause_clear_history");
  expect(ALL_MIGRATIONS[69]).toContain("CREATE TABLE controller_voice_inbox");
  expect(ALL_MIGRATIONS[60]).toContain("CREATE TABLE stage_executions");
  expect(ALL_MIGRATIONS[42]).toContain("CREATE TABLE merge_authority");
  expect(ALL_MIGRATIONS[43]).toContain("CREATE TABLE regression_watch");
  expect(ALL_MIGRATIONS[44]).toContain("CREATE TABLE credential_bindings");
  expect(ALL_MIGRATIONS[55]).toContain("thread_interactions ADD COLUMN audience");
  expect(ALL_MIGRATIONS[56]).toContain("CREATE TABLE controller_thread_asks");
  expect(ALL_MIGRATIONS[57]).toContain("controller_supervisor_steer_attempts_v2");
  expect(ALL_MIGRATIONS[58]).toContain("CREATE TABLE housekeeping_notices");
  expect(ALL_MIGRATIONS[59]).toContain("stall_notified_at");
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
  expect(ALL_MIGRATIONS[28]).toContain("'CONTINUE_REVIEW', 'RETRY'");
  expect(ALL_MIGRATIONS[29]).toContain("image_kind");
  expect(ALL_MIGRATIONS[30]).toContain("delivery_mode");
  expect(ALL_MIGRATIONS[31]).toContain("CREATE TABLE worker_recoveries");
  expect(ALL_MIGRATIONS[32]).toContain("adopted_branch");
  expect(ALL_MIGRATIONS[33]).toContain("review_lens");
  expect(ALL_MIGRATIONS[34]).toContain("PRIMARY KEY(job_id, resource_id)");
  expect(ALL_MIGRATIONS[35]).toContain("CREATE TABLE capability_profiles");
  expect(ALL_MIGRATIONS[35]).toContain("CREATE VIEW skill_receipts");
  expect(ALL_MIGRATIONS[35]).not.toContain("settled_at");
  expect(ALL_MIGRATIONS[36]).toContain("ADD COLUMN task_recipe");
  expect(ALL_MIGRATIONS[36]).toContain("routing_mode");
  expect(ALL_MIGRATIONS[37]).toContain("capability_continuation_count");
  expect(ALL_MIGRATIONS[38]).toContain("CREATE TABLE recipe_promotion_evidence_manifests");
  expect(ALL_MIGRATIONS[38]).toContain("ALTER TABLE model_route_trials ADD COLUMN settled_at");
  expect(ALL_MIGRATIONS[39]).toContain("model_fallback_index");
  expect(ALL_MIGRATIONS[40]).toContain("CREATE TABLE controller_evidence");
  expect(ALL_MIGRATIONS[40]).toContain("CREATE TABLE controller_finalizations");
  expect(ALL_MIGRATIONS[40]).toContain("evidence_high_water_id INTEGER NOT NULL");
  expect(ALL_MIGRATIONS[41]).toContain("CREATE TABLE controller_interactions");
  expect(ALL_MIGRATIONS[41]).toContain("controller_generation_id TEXT REFERENCES controller_generations(id)");
  expect(ALL_MIGRATIONS[45]).toContain("steer_reservation_turn_id");
  expect(ALL_MIGRATIONS[46]).toContain("CREATE TABLE controller_supervisor_steer_attempts");
  expect(ALL_MIGRATIONS[47]).toContain("CREATE TABLE controller_interaction_quarantine");
  expect(ALL_MIGRATIONS[48]).toContain("envelope_version");
  expect(ALL_MIGRATIONS[49]).toContain("consumed_at");
  expect(ALL_MIGRATIONS[50]).toContain("input_accepted");
  expect(ALL_MIGRATIONS[50]).toContain("private_draft_text");
  expect(ALL_MIGRATIONS[50]).toContain("recovery_source_turn_id");
  expect(ALL_MIGRATIONS[50]).not.toMatch(/\b(?:UPDATE|DELETE|DROP)\b/u);
  expect(ALL_MIGRATIONS[51]).toContain("thread_follow_up_json");
  expect(ALL_MIGRATIONS[52]).toContain("CREATE TABLE controller_generation_quarantine");
  expect(ALL_MIGRATIONS[53]).toContain("CREATE UNIQUE INDEX one_open_controller_generation");
  expect(ALL_MIGRATIONS[54]).toContain("delivery_state");
  expect(ALL_MIGRATIONS[54]).toContain("dispatch_retry_count");
  expect(ALL_MIGRATIONS[54]).toContain("delivery_reconcile_attempts");
  expect(ALL_MIGRATIONS[54]).toContain("busy_wait_notified_at");
  expect(ALL_MIGRATIONS[54]).not.toMatch(/\b(?:DROP|RENAME)\b/u);
});

it("rolls back an interrupted additive delivery-state migration and starts cleanly on retry", () => {
  const { bb } = createFakePluginHost({ pluginId: `telegram-controller-delivery-migration-${fixtureNumber++}` });
  const db = bb.storage.database();
  bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(0, 54));
  db.prepare(
    `INSERT INTO owners (
       singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at
     ) VALUES (1, '7', '7', 1_000, NULL)`,
  ).run();
  db.prepare(
    `INSERT INTO controller_threads (
       controller_key, telegram_user_id, telegram_chat_id, project_id, host_id,
       bb_thread_id, state, created_at, updated_at
     ) VALUES (
       'owner-7-controller', '7', '7', 'proj_personal', 'host_personal',
       'thr_live_dispatch', 'active', 1_000, 1_500
     )`,
  ).run();
  db.prepare(
    `INSERT INTO controller_turns (
       id, telegram_update_id, controller_key, ordinal, input_text, state,
       lease_owner, lease_generation, created_at, updated_at
     ) VALUES (
       'turn-live-dispatch', 92_001, 'owner-7-controller', 1,
       'preserve live dispatch', 'dispatching', 'executor', 1, 1_000, 1_500
     )`,
  ).run();
  db.exec(`
    CREATE TRIGGER interrupt_delivery_state_migration
    BEFORE UPDATE ON controller_turns
    WHEN OLD.id = 'turn-live-dispatch'
    BEGIN
      SELECT RAISE(ABORT, 'interrupt-delivery-state-migration');
    END
  `);

  expect(() => openStore(bb.storage, bb.storage.kv, () => 2_000))
    .toThrow(/interrupt-delivery-state-migration/);
  expect(db.prepare(
    "SELECT name FROM pragma_table_info('controller_turns') WHERE name = 'delivery_state'",
  ).get()).toBeUndefined();
  expect(db.prepare(
    "SELECT name FROM pragma_table_info('controller_turns') WHERE name = 'busy_wait_notified_at'",
  ).get()).toBeUndefined();
  expect(db.prepare(
    "SELECT input_text, state FROM controller_turns WHERE id = 'turn-live-dispatch'",
  ).get()).toEqual({ input_text: "preserve live dispatch", state: "dispatching" });

  db.exec("DROP TRIGGER interrupt_delivery_state_migration");
  const store = openStore(bb.storage, bb.storage.kv, () => 2_001);

  expect(store.getControllerTurn("turn-live-dispatch")).toMatchObject({
    inputText: "preserve live dispatch",
    state: "dispatching",
  });
  expect(db.prepare(
    `SELECT delivery_state, dispatch_kind, dispatch_correlation_id,
            dispatch_retry_count, delivery_reconcile_attempts, busy_wait_notified_at,
            next_dispatch_at
       FROM controller_turns WHERE id = 'turn-live-dispatch'`,
  ).get()).toEqual({
    delivery_state: "delivery_unknown",
    dispatch_kind: "send",
    dispatch_correlation_id: null,
    dispatch_retry_count: 0,
    delivery_reconcile_attempts: 0,
    busy_wait_notified_at: null,
    next_dispatch_at: 0,
  });
});

it("preflights duplicate open generations without choosing a winner", () => {
  const { bb } = createFakePluginHost({ pluginId: `telegram-controller-generation-migration-${fixtureNumber++}` });
  const { db, finalizationId } = seedDuplicateControllerGenerations(bb);

  expectDuplicateGenerationRepair(bb, finalizationId);
  expect(db.prepare(
    "SELECT COUNT(*) AS count FROM controller_generations WHERE controller_key = 'owner-7-controller' AND ended_at IS NULL",
  ).get()).toEqual({ count: 0 });

  db.prepare(
    `INSERT INTO controller_generations (
       id, controller_key, thread_id, started_at, ended_at, end_reason
     ) VALUES ('gen-fresh', 'owner-7-controller', 'thr_fresh', 2_100, NULL, NULL)`,
  ).run();
  expect(() => db.prepare(
    `INSERT INTO controller_generations (
       id, controller_key, thread_id, started_at, ended_at, end_reason
     ) VALUES ('gen-forbidden', 'owner-7-controller', 'thr_forbidden', 2_200, NULL, NULL)`,
  ).run()).toThrow(/unique/i);
});

it("resumes when interrupted after quarantine schema creation and before preflight", () => {
  const { bb } = createFakePluginHost({ pluginId: `telegram-controller-generation-before-${fixtureNumber++}` });
  const { db, finalizationId } = seedDuplicateControllerGenerations(bb);
  bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(0, 53));

  expect(db.prepare(
    "SELECT COUNT(*) AS count FROM controller_generations WHERE controller_key = 'owner-7-controller' AND ended_at IS NULL",
  ).get()).toEqual({ count: 2 });
  expectDuplicateGenerationRepair(bb, finalizationId);
});

it("rolls back an interrupted generation preflight and completes on restart", () => {
  const { bb } = createFakePluginHost({ pluginId: `telegram-controller-generation-during-${fixtureNumber++}` });
  const { db, finalizationId } = seedDuplicateControllerGenerations(bb);
  db.exec(`
    CREATE TRIGGER interrupt_generation_preflight
    BEFORE UPDATE OF ended_at ON controller_generations
    WHEN NEW.controller_key = 'owner-7-controller'
    BEGIN
      SELECT RAISE(ABORT, 'interrupt-generation-preflight');
    END
  `);

  expect(() => openStore(bb.storage, bb.storage.kv, () => 2_000)).toThrow(/interrupt-generation-preflight/);
  expect(db.prepare(
    "SELECT COUNT(*) AS count FROM controller_generations WHERE controller_key = 'owner-7-controller' AND ended_at IS NULL",
  ).get()).toEqual({ count: 2 });
  expect(db.prepare(
    "SELECT COUNT(*) AS count FROM controller_generation_quarantine",
  ).get()).toEqual({ count: 0 });
  expect(db.prepare(
    "SELECT state, bb_thread_id FROM controller_threads WHERE controller_key = 'owner-7-controller'",
  ).get()).toEqual({ state: "active", bb_thread_id: "thr_corrupt_primary" });

  db.exec("DROP TRIGGER interrupt_generation_preflight");
  expectDuplicateGenerationRepair(bb, finalizationId);
});

it("rolls back and restarts after interruption following preflight", () => {
  const { bb } = createFakePluginHost({ pluginId: `telegram-controller-generation-after-${fixtureNumber++}` });
  const { db, finalizationId } = seedDuplicateControllerGenerations(bb);
  const originalMigrate = bb.storage.migrate.bind(bb.storage);
  let interrupted = false;
  bb.storage.migrate = (database, statements) => {
    const quarantineExists = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'controller_generation_quarantine'",
    ).get() !== undefined;
    const preflightFinished = quarantineExists && database.prepare(
      "SELECT 1 FROM controller_generation_quarantine LIMIT 1",
    ).get() !== undefined;
    if (!interrupted && statements.length === ALL_MIGRATIONS.length && preflightFinished) {
      interrupted = true;
      throw new Error("interrupt-after-generation-preflight");
    }
    originalMigrate(database, statements);
  };

  expect(() => openStore(bb.storage, bb.storage.kv, () => 2_000)).toThrow(/interrupt-after-generation-preflight/);
  expect(db.prepare(
    "SELECT COUNT(*) AS count FROM controller_generation_quarantine",
  ).get()).toEqual({ count: 0 });
  expect(db.prepare(
    "SELECT COUNT(*) AS count FROM controller_generations WHERE controller_key = 'owner-7-controller' AND ended_at IS NULL",
  ).get()).toEqual({ count: 2 });
  expect(db.prepare(
    "SELECT state, bb_thread_id FROM controller_threads WHERE controller_key = 'owner-7-controller'",
  ).get()).toEqual({ state: "active", bb_thread_id: "thr_corrupt_primary" });
  expect(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'one_open_controller_generation'",
  ).get()).toBeUndefined();

  bb.storage.migrate = originalMigrate;
  expectDuplicateGenerationRepair(bb, finalizationId);
});

it("upgrades a live legacy controller row after an interrupted recovery migration", () => {
  const { bb } = createFakePluginHost({ pluginId: `telegram-controller-migration-${fixtureNumber++}` });
  const db = bb.storage.database();
  bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(0, 50));
  db.prepare(
    `INSERT INTO controller_threads (
       controller_key, telegram_user_id, telegram_chat_id, state, created_at, updated_at
     ) VALUES (?, ?, ?, 'pending_spawn', ?, ?)`,
  ).run("owner-legacy-controller", "7", "7", 1_000, 1_000);
  db.prepare(
    `INSERT INTO controller_turns (
       id, telegram_update_id, controller_key, ordinal, input_text, state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
  ).run("legacy-controller-turn", 9_001, "owner-legacy-controller", 1, "preserve me", 1_000, 1_000);

  db.exec("BEGIN IMMEDIATE");
  db.exec("ALTER TABLE controller_turns ADD COLUMN input_accepted INTEGER NOT NULL DEFAULT 0 CHECK (input_accepted IN (0, 1))");
  db.exec("ROLLBACK");
  expect(db.prepare("SELECT name FROM pragma_table_info('controller_turns') WHERE name = 'input_accepted'").get()).toBeUndefined();

  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);

  expect(store.getControllerTurn("legacy-controller-turn")).toMatchObject({
    inputText: "preserve me",
    state: "queued",
    inputAccepted: false,
    privateDraftItemId: null,
    privateDraftText: "",
    recoverySourceTurnId: null,
  });
  expect(db.prepare("SELECT COUNT(*) AS count FROM controller_turns WHERE id = ?")
    .get("legacy-controller-turn")).toEqual({ count: 1 });
});

it("pins the exact shipped and controller trust migration bytes in order", () => {
  expect(sha256(ALL_MIGRATIONS.slice(0, 28).join("\u0000"))).toBe(
    "505dfd4781117dfb2c817d31640e833370189e6b3ef2c7c24e646fb1838eed56",
  );
  expect(sha256(ALL_MIGRATIONS[40]!)).toBe(
    "4ec9eb259bbdce396ac0026c13ebd84ec71f25433092827cc9aae5fe903505d3",
  );
  expect(sha256(ALL_MIGRATIONS[41]!)).toBe(
    "47f96300edfdef5bfec673225293738bc38a06e038bf4c4afee74e1f4e8f0dcf",
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
    modelFallbackIndex: 0,
    bbEventSeq: 0,
    streamText: "Queued…",
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
  completeTurnThroughFinalization(store, fence, {
    turnId: first.id, controllerKey: first.controllerKey, responseText: "Hello.",
  });
  expect(store.claimNextControllerTurn(fence)).toMatchObject({ updateId: 202, ordinal: 2 });
});

it("persists a Telegram animation and its preview still", () => {
  const { store } = fixture();
  const image = {
    fileId: "animation-file-id",
    fileName: "telegram-clip.mp4",
    mimeType: "video/mp4" as const,
    sizeBytes: 400_000,
    kind: "animation" as const,
    durationSeconds: 3,
    thumbnail: {
      fileId: "thumb-file-id",
      fileName: "telegram-clip-thumb.jpg",
      sizeBytes: 12_000,
    },
  };

  expect(store.enqueueControllerTurn({ ...turnInput(110, "look at this"), image })).toMatchObject({
    inputText: "look at this",
    image,
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

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "queued",
    retryCount: 1,
    modelFallbackIndex: 0,
  });
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

it("rolls back a controller-owned write when its exact turn fence is stale", () => {
  const { store } = fixture();
  const turn = store.enqueueControllerTurn(turnInput(302));
  const fence = acquire(store);
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    ...fence,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, turnId: turn.id })).toBe(true);
  expect(store.releaseExecutorLease(fence.ownerId, fence.generation, fence.now)).toBe(true);

  expect(store.runControllerMutation({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    expectedThreadId: "thr_controller",
  }, (now) => store.rememberMemory({
    scope: "owner",
    kind: "fact",
    subject: "stale write",
    body: "must roll back",
    source: "agent",
    now,
  }))).toEqual({ outcome: "stale" });
  expect(store.countMemories("owner")).toBe(0);
});

it("requeues a stale claim that never persisted dispatch intent", () => {
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

  expect(store.listControllerTurns("owner-7-controller", 10).map((turn) => turn.state)).toEqual(["queued", "queued"]);
  expect(store.getControllerTurn(first.id)).toMatchObject({ inputText: "first", lastError: null });
  expect(store.getOutbox(`controller:${first.id}:reply`)).toMatchObject({
    status: "pending",
    payload: { text: "Queued…" },
  });
  expect(store.claimNextControllerTurn({
    ownerId: "successor",
    generation: successor.generation,
    now: 32_001,
  })).toMatchObject({ updateId: 351, state: "dispatching", inputText: "first" });
});

it("requeues one unaccepted controller turn in a fresh generation without losing FIFO order", () => {
  const { bb, store } = fixture();
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
    nextFallbackIndex: 1,
    ...fence,
  })).toBe(true);

  expect(store.listControllerTurns("owner-7-controller", 10)).toMatchObject([
    { id: first.id, state: "queued", retryCount: 0, modelFallbackIndex: 1, dispatchAfterSeq: 0 },
    { updateId: 372, state: "queued", retryCount: 0, modelFallbackIndex: 0 },
  ]);
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ threadId: null, state: "pending_spawn" });
  expect(store.claimNextControllerTurn(fence)).toMatchObject({
    id: first.id,
    state: "dispatching",
    retryCount: 0,
    modelFallbackIndex: 1,
  });
  expect(store.markControllerSpawned({
    turnId: first.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_failed_fallback_one",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: first.id, dispatchAfterSeq: 31, ...fence })).toBe(true);

  expect(store.retryUnacceptedControllerTurn({
    turnId: first.id,
    controllerKey: "owner-7-controller",
    expectedThreadId: "thr_failed_fallback_one",
    nextFallbackIndex: 2,
    ...fence,
  })).toBe(true);
  expect(store.claimNextControllerTurn(fence)).toMatchObject({
    id: first.id,
    state: "dispatching",
    retryCount: 0,
    modelFallbackIndex: 2,
  });
});

it("does not retry a turn once an accepted finalization is durable", () => {
  const { store } = fixture();
  const { turn, fence } = submittedTurn(store, "thr_retry_accepted");
  expect(store.proposeControllerFinalization({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    candidate: {
      disposition: "answered",
      segments: [{ type: "text", text: "Durably accepted." }],
      obligationRefs: [],
    },
  })).toMatchObject({ outcome: "accepted" });

  expect(store.retryUnacceptedControllerTurn({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    expectedThreadId: "thr_retry_accepted",
    nextFallbackIndex: 1,
  })).toBe(false);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "submitted", retryCount: 0 });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "active", threadId: "thr_retry_accepted" });
});

it("rolls back an unaccepted retry when its open generation changes after the turn write", () => {
  const { bb, store } = fixture();
  const { turn, fence } = submittedTurn(store, "thr_retry_generation_race");
  const db = bb.storage.database();
  db.exec(`
    CREATE TRIGGER remove_retry_generation
    AFTER UPDATE OF model_fallback_index ON controller_turns
    WHEN NEW.id = '${turn.id}'
    BEGIN
      UPDATE controller_generations SET ended_at = 1, end_reason = 'raced'
       WHERE controller_key = NEW.controller_key AND thread_id = 'thr_retry_generation_race';
    END
  `);

  expect(() => store.retryUnacceptedControllerTurn({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    expectedThreadId: "thr_retry_generation_race",
    nextFallbackIndex: 1,
  })).toThrow(/generation/i);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "submitted", retryCount: 0 });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "active", threadId: "thr_retry_generation_race" });
  expect(db.prepare(
    "SELECT ended_at FROM controller_generations WHERE controller_key = ? AND thread_id = ?",
  ).get(turn.controllerKey, "thr_retry_generation_race")).toEqual({ ended_at: null });
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
    payload: { text: CONTROLLER_PHASE_TEXT.connecting },
  });

  const leased = store.leaseOutbox(fence.ownerId, fence.generation, fence.now, 10, 30_000);
  expect(leased).toHaveLength(1);
  expect(store.completeOutbox(leased[0]!.logicalKey, fence.ownerId, fence.generation, 501, fence.now)).toBe(true);
  expect(store.listControllerTurns("owner-7-controller", 10)[0]?.telegramMessageId).toBe(501);

  expect(store.updateControllerStream({
    turnId: turn.id,
    cursor: 9,
    phase: "responding",
    ...fence,
  })).toBe(true);
  // Draft text is phase-only by contract: updateControllerStream no longer
  // accepts raw text at all, and only the phase placeholder may reach the
  // durable stream_text and the outbox.
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    messageId: 501,
    status: "pending",
    payload: { text: CONTROLLER_PHASE_TEXT.responding },
  });
  expect(store.listControllerTurns("owner-7-controller", 10)[0]?.streamText).toBe(CONTROLLER_PHASE_TEXT.responding);
  const edit = store.leaseOutbox(fence.ownerId, fence.generation, fence.now, 10, 30_000);
  expect(edit).toHaveLength(1);
  expect(store.completeOutbox(edit[0]!.logicalKey, fence.ownerId, fence.generation, 501, fence.now)).toBe(true);
  completeTurnThroughFinalization(store, fence, {
    turnId: turn.id, controllerKey: turn.controllerKey, responseText: "Hello final",
  });
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

it("ignores caller-supplied owner prose and renders failures only from the closed store mapping", () => {
  const { store } = fixture();
  const turn = store.enqueueControllerTurn(turnInput(402));
  const fence = acquire(store);
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  const input = {
    ...fence,
    turnId: turn.id,
    error: "bounded internal delivery summary",
    failureCode: "owner_message_delivery_uncertain",
    ownerMessage: "CALLER PROSE MUST NEVER REACH TELEGRAM",
  } as unknown as Parameters<typeof store.failControllerTurn>[0];

  expect(store.failControllerTurn(input)).toBe(true);

  const text = store.getOutbox(`controller:${turn.id}:reply`)?.payload.text;
  expect(text).toBe(
    "I preserved that message because its delivery could not be confirmed. It will be reconciled before any action is repeated.",
  );
  expect(text).not.toContain("CALLER PROSE");
  expect(text).not.toContain("bounded internal delivery summary");
});

it("sends the accepted answer byte-for-byte, with no rewriting and no parse mode", () => {
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

  completeTurnThroughFinalization(store, fence, {
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    responseText: "**Reduce complexity** — active\n- one item",
  });

  // The trust kernel delivers the accepted rendered message exactly. Markdown
  // rewriting is deliberately not applied: the owner must read the text the
  // finalization contract validated, not a transform of it.
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload).toEqual({
    text: "**Reduce complexity** — active\n- one item",
    disable_web_page_preview: true,
  });
});

it("completes a controller reply containing ordinary percent text", () => {
  const { store } = fixture();
  const turn = store.enqueueControllerTurn(turnInput(702));
  const fence = acquire(store);
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_percent",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: turn.id, ...fence })).toBe(true);

  completeTurnThroughFinalization(store, fence, {
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    responseText: "Still implementing; disk fine at 73%.",
  });

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "completed",
    responseText: "Still implementing; disk fine at 73%.",
  });
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload).toMatchObject({
    text: "Still implementing; disk fine at 73%.",
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

function submittedTurn(store: ReturnType<typeof openStore>, threadId: string) {
  const turn = store.enqueueControllerTurn(turnInput(900 + Math.floor(Math.random() * 1_000), "I ran into a wall"));
  const fence = acquire(store);
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: turn.id, ...fence })).toBe(true);
  return { store, turn, fence };
}

// A turn's evidence cursor has to start where its own message entered the
// thread. Left at 0 it rescans the whole conversation every turn, so the row
// count climbs with conversation length until it crosses the evidence cap and
// a turn that needed no evidence at all dies of the budget.
it("starts a submitted turn's evidence cursor at its own dispatch baseline", () => {
  const { store } = fixture();
  const turn = store.enqueueControllerTurn(turnInput(771, "what do you mean"));
  const fence = acquire(store);
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ...fence,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_evidence_baseline",
  })).toBe(true);

  expect(store.markControllerTurnSubmitted({
    turnId: turn.id,
    ...fence,
    dispatchAfterSeq: 1_528,
  })).toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    dispatchAfterSeq: 1_528,
    bbEventSeq: 1_528,
    evidenceEventSeq: 1_528,
  });
});

it("atomically fails and retires a submitted controller turn with a safe notice", () => {
  const { bb, store } = fixture();
  const { turn, fence } = submittedTurn(store, "thr_fail_retire");
  const db = bb.storage.database();

  expect(store.failAndRetireControllerTurn({
    turnId: turn.id,
    controllerKey: "owner-7-controller",
    expectedThreadId: "thr_fail_retire",
    error: "projector ran out of evidence",
    expectedAcceptedFinalizationId: null,
    ...fence,
  })).toBe("retired");

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "failed",
    lastError: "projector ran out of evidence",
    completedAt: 2_000,
  });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({
    state: "pending_spawn",
    threadId: null,
    projectId: null,
    hostId: null,
  });
  const generations = db.prepare(
    "SELECT ended_at, end_reason FROM controller_generations WHERE controller_key = 'owner-7-controller' AND thread_id = 'thr_fail_retire'",
  ).all();
  expect(generations).toHaveLength(1);
  expect(generations[0]).toMatchObject({ ended_at: 2_000, end_reason: "retired" });
  // The owner-facing notice is a fixed internally mapped safe message; the
  // caller's bounded internal `error` never reaches the Telegram payload.
  // This turn opened no tool and recorded no evidence, so its message is put
  // back rather than apologised for.
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload).toMatchObject({
    text: "I couldn't finish that one, but nothing had started yet, so I've put your message back and I'm picking it up again in a fresh conversation. Nothing was repeated.",
    disable_web_page_preview: true,
  });
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).not.toContain("projector ran out");
});

// A turn that did nothing may have its message put back, which changes the
// notice. Pass `didWork` to read the copy for a turn that cannot be replayed.
function failureNotice(failureCode: ControllerFailureCode, didWork = true): string {
  const { bb, store } = fixture();
  const { turn, fence } = submittedTurn(store, `thr_failure_code_${failureCode}`);
  if (didWork) {
    bb.storage.database().prepare("UPDATE controller_turns SET tool_calls = 4 WHERE id = ?").run(turn.id);
  }

  expect(store.failAndRetireControllerTurn({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    expectedThreadId: `thr_failure_code_${failureCode}`,
    error: "bounded internal summary",
    failureCode,
  })).toBe("retired");

  const text = store.getOutbox(`controller:${turn.id}:reply`)?.payload.text;
  expect(text).toBeTypeOf("string");
  expect(text).not.toContain("bounded internal summary");
  return text as string;
}

it.each([
  ["stalled", /stopped making progress/i],
  ["budget_exceeded", /safety limit/i],
  ["oauth_expired", /sign-in has expired/i],
  ["provider_rejected", /provider settings/i],
  ["recovery_exhausted", /tried that again/i],
  ["unknown", /couldn't finish/i],
  ["owner_message_delivery_uncertain", /preserved.*message/i],
  ["owner_message_delivery_exhausted", /couldn't confirm.*previous message.*missing or duplicated/i],
  ["owner_message_delivery_unresolved", /did not repeat.*review the conversation/i],
  ["owner_message_waiting_for_fresh_generation", /kept.*message queued.*fresh conversation/i],
  ["image_preparation_failed", /couldn't read that image safely/i],
] as const)("maps the closed %s failure code to store-owned vetted text", (failureCode, expectedText) => {
  expect(failureNotice(failureCode)).toMatch(expectedText);
});

// The owner reads this instead of the answer they asked for, so it has to say
// what became of their message. "unknown" used to borrow the recovery sentence
// and claim a recovery that never ran.
it("gives an unclassified failure its own copy that claims no recovery", () => {
  const unknown = failureNotice("unknown");
  expect(unknown).not.toBe(failureNotice("recovery_exhausted"));
  expect(unknown).not.toMatch(/after recovery|tried that again|retried/i);
});

it.each([
  "unknown",
  "recovery_exhausted",
  "stalled",
  "budget_exceeded",
  "oauth_expired",
  "provider_rejected",
] as const)("tells the owner what became of their message for %s", (failureCode) => {
  const text = failureNotice(failureCode);
  expect(text).toMatch(/your message|send it again|send your message again/i);
});

// Nothing ran, so inviting a resend cannot repeat an action.
it.each(["unknown", "recovery_exhausted", "stalled", "budget_exceeded"] as const)(
  "invites a safe resend for %s",
  (failureCode) => {
    expect(failureNotice(failureCode)).toMatch(/send it again/i);
    expect(failureNotice(failureCode)).toMatch(/nothing was repeated/i);
  },
);

// Turn 326 died 249ms after it arrived having done nothing at all, and the
// owner's message went with it. A message that provably cost nothing can be
// put back rather than apologised for.
it("requeues an owner message when the failed turn did nothing", () => {
  const { store } = fixture();
  const { turn, fence } = submittedTurn(store, "thr_requeue_untouched");

  expect(store.failAndRetireControllerTurn({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    expectedThreadId: "thr_requeue_untouched",
    error: "bounded internal summary",
  })).toBe("retired");

  const replacement = store.listControllerTurns("owner-7-controller", 10)
    .find((candidate) => candidate.id !== turn.id);
  expect(replacement).toMatchObject({
    state: "queued",
    inputText: turn.inputText,
    origin: "owner",
    recoverySourceTurnId: turn.id,
  });
  const text = store.getOutbox(`controller:${turn.id}:reply`)?.payload.text;
  expect(text).toMatch(/picking it up again/i);
  expect(text).not.toMatch(/send it again/i);
});

it.each([
  ["a tool ran", (db: ReturnType<typeof fixture>["bb"]["storage"], id: string) =>
    db.database().prepare("UPDATE controller_turns SET tool_calls = 9 WHERE id = ?").run(id)],
  // Self-reference is enough to mark it as already replaced once, and it keeps
  // the foreign key pointing at a turn that exists.
  ["it was already a replacement", (db: ReturnType<typeof fixture>["bb"]["storage"], id: string) =>
    db.database().prepare("UPDATE controller_turns SET recovery_source_turn_id = ? WHERE id = ?").run(id, id)],
  ["it carried an image", (db: ReturnType<typeof fixture>["bb"]["storage"], id: string) =>
    db.database().prepare(
      `UPDATE controller_turns
          SET image_file_id = 'file_1', image_file_name = 'shot.png',
              image_mime_type = 'image/png', image_size_bytes = 1024, image_kind = 'image'
        WHERE id = ?`,
    ).run(id)],
])("never requeues an owner message when %s", (_reason, taint) => {
  const { bb, store } = fixture();
  const { turn, fence } = submittedTurn(store, "thr_requeue_blocked");
  taint(bb.storage, turn.id);

  expect(store.failAndRetireControllerTurn({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    expectedThreadId: "thr_requeue_blocked",
    error: "bounded internal summary",
  })).toBe("retired");

  expect(store.listControllerTurns("owner-7-controller", 10)).toHaveLength(1);
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).toMatch(/send it again/i);
});

// A provider that refused once refuses again, so replaying only loops.
it.each(["oauth_expired", "provider_rejected"] as const)(
  "never requeues an owner message for %s",
  (failureCode) => {
    const { store } = fixture();
    const { turn, fence } = submittedTurn(store, `thr_no_requeue_${failureCode}`);

    expect(store.failAndRetireControllerTurn({
      ...fence,
      turnId: turn.id,
      controllerKey: turn.controllerKey,
      expectedThreadId: `thr_no_requeue_${failureCode}`,
      error: "bounded internal summary",
      failureCode,
    })).toBe("retired");

    expect(store.listControllerTurns("owner-7-controller", 10)).toHaveLength(1);
  },
);

// These describe a message whose delivery is unconfirmed, so a resend could
// duplicate an action that already happened.
it.each([
  "owner_message_delivery_uncertain",
  "owner_message_delivery_exhausted",
  "owner_message_delivery_unresolved",
] as const)("never invites a resend for %s", (failureCode) => {
  expect(failureNotice(failureCode)).not.toMatch(/send it again|resend/i);
});

it("persists acceptance and a bounded private draft without projecting the draft", () => {
  const { store } = fixture();
  const { turn, fence } = submittedTurn(store, "thr_private_draft");
  const privateDraft = `private-start-${"x".repeat(5_000)}`;

  expect(store.updateControllerStream({
    ...fence,
    turnId: turn.id,
    cursor: 4,
    phase: "responding",
    inputAccepted: true,
    assistantDraft: { itemId: "message-private", text: privateDraft },
  })).toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    inputAccepted: true,
    privateDraftItemId: "message-private",
  });
  expect(store.getControllerTurn(turn.id)?.privateDraftText).toHaveLength(4_000);
  expect(JSON.stringify(store.getOutbox(`controller:${turn.id}:reply`))).not.toContain("private-start");
});

it("atomically retires an accepted broken generation into one restart-safe recovery turn", () => {
  const { bb, store } = fixture();
  const { turn, fence } = submittedTurn(store, "thr_recovery_broken");
  expect(store.updateControllerStream({
    ...fence,
    turnId: turn.id,
    cursor: 5,
    phase: "responding",
    inputAccepted: true,
    assistantDraft: { itemId: "message-recovery", text: "Bounded unfinished answer" },
  })).toBe(true);
  const receipt = { turnId: turn.id, toolName: "telegram_agent_cancel", argsSha256: "a".repeat(64) };
  expect(store.claimToolReceipt({ ...receipt, controllerKey: turn.controllerKey, ...fence })).toEqual({ outcome: "fresh" });
  store.completeToolReceipt({ ...receipt, result: JSON.stringify({ cancelled: true }), now: fence.now });

  expect(store.beginControllerRecovery({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    expectedThreadId: "thr_recovery_broken",
    error: "provider process exited",
    nextFallbackIndex: 0,
  })).toBe("requeued");

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "queued",
    completionContinuations: 2,
    inputAccepted: false,
    privateDraftText: "Bounded unfinished answer",
    retryCount: 0,
  });
  expect(store.listToolReceipts(turn.id)).toMatchObject([{ toolName: "telegram_agent_cancel", state: "completed" }]);
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "pending_spawn", threadId: null });

  const restarted = openStore(bb.storage, bb.storage.kv, () => 2_001);
  expect(restarted.claimNextControllerTurn({ ...fence, now: 2_001 })).toMatchObject({
    id: turn.id,
    state: "dispatching",
    completionContinuations: 2,
    privateDraftText: "Bounded unfinished answer",
  });
});

// The owner asked a real question at 1:42am, it was folded into the running
// answer, and no bubble appeared at all. From Telegram that is identical to
// being ignored, so a folded message has to leave something visible behind.
it("acknowledges an owner message folded into the running answer", () => {
  const { store } = fixture();
  const { turn: running, fence } = submittedTurn(store, "thr_folded_ack");
  const waiting = store.enqueueControllerTurn(
    turnInput(78_010, "yeah but if hanoon started a new thread and gave it the context"),
  );
  expect(store.reserveControllerSteer({
    ...fence,
    runningTurnId: running.id,
    waitingTurnId: waiting.id,
    controllerKey: running.controllerKey,
    expectedThreadId: "thr_folded_ack",
  })).toBe(true);

  expect(store.settleControllerSteer({
    ...fence,
    runningTurnId: running.id,
    waitingTurnId: waiting.id,
    controllerKey: running.controllerKey,
    outcome: "applied",
  })).toBe("settled");

  expect(store.getControllerTurn(waiting.id)).toMatchObject({ state: "completed" });
  const notice = store.getOutbox(`controller:${waiting.id}:reply`);
  expect(notice?.payload.text).toMatch(/answer i'm already writing|already writing/i);
  expect(notice?.chatId).toBe("7");
});

it("preserves an ambiguously steered owner message and inherits exact receipts", () => {
  const { store } = fixture();
  const { turn: running, fence } = submittedTurn(store, "thr_ambiguous_preserve");
  const waiting = store.enqueueControllerTurn(turnInput(78_001, "actually cancel the second job"));
  const receipt = { turnId: running.id, toolName: "telegram_agent_cancel", argsSha256: "b".repeat(64) };
  expect(store.claimToolReceipt({ ...receipt, controllerKey: running.controllerKey, ...fence })).toEqual({ outcome: "fresh" });
  store.completeToolReceipt({ ...receipt, result: JSON.stringify({ cancelled: true }), now: fence.now });
  expect(store.reserveControllerSteer({
    ...fence,
    runningTurnId: running.id,
    waitingTurnId: waiting.id,
    controllerKey: running.controllerKey,
    expectedThreadId: "thr_ambiguous_preserve",
  })).toBe(true);

  expect(store.settleControllerSteer({
    ...fence,
    runningTurnId: running.id,
    waitingTurnId: waiting.id,
    controllerKey: running.controllerKey,
    outcome: "unknown",
  })).toBe("settled");

  expect(store.getControllerTurn(waiting.id)).toMatchObject({
    state: "queued",
    recoverySourceTurnId: running.id,
  });
  expect(store.getOutbox(`controller:${waiting.id}:reply`)).toBeNull();
  expect(store.claimToolReceipt({
    turnId: waiting.id,
    toolName: receipt.toolName,
    argsSha256: receipt.argsSha256,
    controllerKey: running.controllerKey,
    now: 2_001,
  })).toEqual({ outcome: "completed", result: JSON.stringify({ cancelled: true }) });
});

it("lets a durable acceptance win an unaccepted fail-and-retire attempt", () => {
  const { bb, store } = fixture();
  const { turn, fence } = submittedTurn(store, "thr_fail_retire_words");

  const accepted = store.proposeControllerFinalization({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    candidate: {
      disposition: "answered",
      segments: [{ type: "text", text: "SECRET accepted answer that must never be delivered" }],
      obligationRefs: [],
    },
  });
  expect(accepted).toMatchObject({ outcome: "accepted" });

  expect(store.failAndRetireControllerTurn({
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    expectedThreadId: "thr_fail_retire_words",
    error: "evidence cap reached",
    expectedAcceptedFinalizationId: null,
    ...fence,
  })).toBe("accepted_won");

  const outbox = store.getOutbox(`controller:${turn.id}:reply`);
  expect(outbox?.payload.text).toBe(CONTROLLER_PHASE_TEXT.connecting);
  expect(outbox?.payload.text).not.toContain("SECRET accepted answer");
  expect(store.getAcceptedControllerFinalization(turn.id)).toMatchObject({ consumedAt: null });
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "submitted" });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "active", threadId: "thr_fail_retire_words" });

  if (accepted.outcome !== "accepted") throw new Error("accepted finalization fixture was not accepted");
  expect(store.failAndRetireControllerTurn({
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    expectedThreadId: "thr_fail_retire_words",
    error: "evidence cap reached",
    expectedAcceptedFinalizationId: accepted.finalization.id,
    ...fence,
  })).toBe("retired");
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "failed" });
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text)
    .toBe("I couldn't finish that one, so your message didn't get an answer. Nothing was repeated. Send it again and I'll pick it up.");
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text)
    .not.toContain("SECRET accepted answer");
  expect(store.getAcceptedControllerFinalization(turn.id)).toMatchObject({ consumedAt: null });
});

it("rejects credential-shaped fail-and-retire error with no write", () => {
  const { store } = fixture();
  const { turn, fence } = submittedTurn(store, "thr_fail_retire_cred");

  expect(() => store.failAndRetireControllerTurn({
    turnId: turn.id,
    controllerKey: "owner-7-controller",
    expectedThreadId: "thr_fail_retire_cred",
    error: "token=do-not-leak-into-the-notice",
    expectedAcceptedFinalizationId: null,
    ...fence,
  })).toThrow(/credential/i);

  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "submitted" });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "active" });
});

// Regression for the duplicate-open generation crash loop observed on 2026-08-14.
it("repairs duplicate generations during fail-and-retire while preserving owner work", () => {
  const { bb, store } = fixture();
  const db = bb.storage.database();
  const key = "owner-7-controller";
  const thread = "thr_gen_repair_retire";
  const { turn, fence } = submittedTurn(store, thread);
  const waiting = store.enqueueControllerTurn(turnInput(78_900, "preserve queued follow-up"));
  const accepted = store.proposeControllerFinalization({
    ...fence,
    turnId: turn.id,
    controllerKey: key,
    candidate: {
      disposition: "answered",
      segments: [{ type: "text", text: "preserve accepted finalization" }],
      obligationRefs: [],
    },
  });
  if (accepted.outcome !== "accepted") throw new Error("accepted finalization fixture was not accepted");
  db.exec("DROP INDEX one_open_controller_generation");
  db.prepare("INSERT INTO controller_generations (id, controller_key, thread_id, started_at, ended_at, end_reason) VALUES ('gen-retire-foreign', ?, 'thr_retire_foreign', 1, NULL, NULL)")
    .run(key);

  expect(store.failAndRetireControllerTurn({
    turnId: turn.id,
    controllerKey: key,
    expectedThreadId: thread,
    error: "runtime caller prose must stay private",
    expectedAcceptedFinalizationId: accepted.finalization.id,
    ...fence,
  })).toBe("retired");

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "queued",
    inputText: "I ran into a wall",
    acceptedFinalizationId: accepted.finalization.id,
    completionContinuations: 2,
  });
  expect(store.getControllerTurn(waiting.id)).toMatchObject({
    state: "queued",
    inputText: "preserve queued follow-up",
  });
  expect(store.getAcceptedControllerFinalization(turn.id)).toMatchObject({
    id: accepted.finalization.id,
    consumedAt: null,
  });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "pending_spawn", threadId: null });
  expect(db.prepare(
    "SELECT COUNT(*) AS count FROM controller_generations WHERE controller_key = ? AND ended_at IS NULL",
  ).get(key)).toEqual({ count: 0 });
  expect(db.prepare(
    "SELECT generation_id, thread_id FROM controller_generation_quarantine WHERE controller_key = ? ORDER BY generation_id",
  ).all(key)).toHaveLength(2);
  const notices = store.listOutbox(100).filter((outbox) =>
    outbox.logicalKey === "controller-generation-recovery:owner-7-controller"
  );
  expect(notices).toHaveLength(1);
  expect(notices[0]?.payload.text).toBe(
    "I preserved that message because its delivery could not be confirmed. It will be reconciled before any action is repeated.",
  );
  expect(JSON.stringify(notices[0]?.payload)).not.toContain("runtime caller prose");
});

it("repairs duplicate generations during recovery while preserving receipts and finalization", () => {
  const { bb, store } = fixture();
  const db = bb.storage.database();
  const key = "owner-7-controller";
  const thread = "thr_gen_repair_recovery";
  const { turn, fence } = submittedTurn(store, thread);
  const waiting = store.enqueueControllerTurn(turnInput(78_901, "preserve second queued follow-up"));
  expect(store.updateControllerStream({
    ...fence,
    turnId: turn.id,
    cursor: 2,
    phase: "responding",
    inputAccepted: true,
    assistantDraft: { itemId: "message-corrupt-recovery", text: "preserve private draft" },
  })).toBe(true);
  const receipt = { turnId: turn.id, toolName: "telegram_agent_cancel", argsSha256: "e".repeat(64) };
  expect(store.claimToolReceipt({ ...receipt, controllerKey: key, ...fence })).toEqual({ outcome: "fresh" });
  store.completeToolReceipt({ ...receipt, result: JSON.stringify({ cancelled: true }), now: fence.now });
  const accepted = store.proposeControllerFinalization({
    ...fence,
    turnId: turn.id,
    controllerKey: key,
    candidate: {
      disposition: "answered",
      segments: [{ type: "text", text: "preserve recovery finalization" }],
      obligationRefs: [],
    },
  });
  if (accepted.outcome !== "accepted") throw new Error("accepted finalization fixture was not accepted");
  db.exec("DROP INDEX one_open_controller_generation");
  db.prepare("INSERT INTO controller_generations (id, controller_key, thread_id, started_at, ended_at, end_reason) VALUES ('gen-recovery-foreign', ?, 'thr_recovery_foreign', 1, NULL, NULL)")
    .run(key);

  expect(store.beginControllerRecovery({
    ...fence,
    turnId: turn.id,
    controllerKey: key,
    expectedThreadId: thread,
    error: "recovery caller prose must stay private",
    nextFallbackIndex: 1,
  })).toBe("requeued");

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "queued",
    inputText: "I ran into a wall",
    privateDraftText: "preserve private draft",
    acceptedFinalizationId: accepted.finalization.id,
    completionContinuations: 2,
  });
  expect(store.getControllerTurn(waiting.id)).toMatchObject({
    state: "queued",
    inputText: "preserve second queued follow-up",
  });
  expect(store.listToolReceipts(turn.id)).toMatchObject([
    { toolName: receipt.toolName, state: "completed", result: JSON.stringify({ cancelled: true }) },
  ]);
  expect(store.getAcceptedControllerFinalization(turn.id)).toMatchObject({
    id: accepted.finalization.id,
    consumedAt: null,
  });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "pending_spawn", threadId: null });
  expect(db.prepare(
    "SELECT COUNT(*) AS count FROM controller_generations WHERE controller_key = ? AND ended_at IS NULL",
  ).get(key)).toEqual({ count: 0 });
  const notices = store.listOutbox(100).filter((outbox) =>
    outbox.logicalKey === "controller-generation-recovery:owner-7-controller"
  );
  expect(notices).toHaveLength(1);
  expect(notices[0]?.payload.text).toBe(
    "I preserved that message because its delivery could not be confirmed. It will be reconciled before any action is repeated.",
  );
  expect(JSON.stringify(notices[0]?.payload)).not.toContain("recovery caller prose");
});

it("preserves the turn updated_at when a native batch does not advance the cursor", () => {
  const { store } = fixture();
  const { turn, fence } = submittedTurn(store, "thr_empty_batch");
  const initial = store.getControllerTurn(turn.id)!;

  // A zero-item, zero-advance batch (throughSeq === fromSeq) must not refresh
  // the durable stall clock.
  expect(store.recordControllerNativeEvidence({
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: initial.evidenceEventSeq,
    throughSeq: initial.evidenceEventSeq,
    items: [],
    ...fence,
    now: 9_000,
  })).toBe("recorded");

  const after = store.getControllerTurn(turn.id)!;
  expect(after.evidenceEventSeq).toBe(initial.evidenceEventSeq);
  expect(after.updatedAt).toBe(initial.updatedAt);
});

it("rewrites updated_at only when a native batch actually advances the cursor", () => {
  const { store } = fixture();
  const { turn, fence } = submittedTurn(store, "thr_advance_batch");
  const initial = store.getControllerTurn(turn.id)!;

  expect(store.recordControllerNativeEvidence({
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: initial.evidenceEventSeq,
    throughSeq: 5,
    items: [nativeEvidenceCandidate("item-1")],
    ...fence,
    now: 9_000,
  })).toBe("recorded");

  const after = store.getControllerTurn(turn.id)!;
  expect(after.evidenceEventSeq).toBe(5);
  expect(after.updatedAt).toBe(9_000);
});

it("repeated empty reconciliation cannot keep a stalled turn alive", () => {
  const { store } = fixture();
  const { turn, fence } = submittedTurn(store, "thr_stalled");
  const initial = store.getControllerTurn(turn.id)!;

  // Many empty zero-advance passes must leave the stall clock untouched, so a
  // wedged thread cannot be refreshed across restart by empty reconciliations.
  for (let i = 0; i < 5; i += 1) {
    expect(store.recordControllerNativeEvidence({
      turnId: turn.id,
      controllerKey: turn.controllerKey,
      fromSeq: initial.evidenceEventSeq,
      throughSeq: initial.evidenceEventSeq,
      items: [],
      ...fence,
      now: 9_000 + i,
    })).toBe("recorded");
  }
  const after = store.getControllerTurn(turn.id)!;
  expect(after.updatedAt).toBe(initial.updatedAt);
  // The durable stall clock still reflects the original submission time.
  expect(after.updatedAt).toBe(2_000);
});

it("normalizes a pre-cutover raw stream_text on a zero-advance pass without double-counting metrics", () => {
  const { bb, store } = fixture();
  const db = bb.storage.database();
  const turn = store.enqueueControllerTurn(turnInput(902, "normalize me"));
  const fence = acquire(store);
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id, ...fence, projectId: "proj_personal", hostId: "host_personal", threadId: "thr_normalize",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: turn.id, ...fence, dispatchAfterSeq: 4 })).toBe(true);
  // Pre-cutover raw prose plus an existing tool count: a zero-advance pass must
  // normalize the text to the phase literal without re-adding metrics.
  db.prepare("UPDATE controller_turns SET stream_text = ?, tool_calls = 3 WHERE id = ?")
    .run("pre-cutover RAWSECRET prose", turn.id);

  expect(store.updateControllerStream({
    turnId: turn.id,
    cursor: 4, // equals bb_event_seq: a zero-advance normalization pass
    phase: "thinking",
    toolCalls: 0,
    commandFailures: 0,
    totalTokens: 0,
    ...fence,
    now: 7_000,
  })).toBe(true);

  const stored = store.getControllerTurn(turn.id)!;
  expect(stored.streamText).toBe(CONTROLLER_PHASE_TEXT.thinking);
  expect(stored.streamText).not.toContain("RAWSECRET");
  expect(stored.toolCalls).toBe(3);
  expect(stored.bbEventSeq).toBe(4);
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).toBe(CONTROLLER_PHASE_TEXT.thinking);

  db.prepare("UPDATE outbox SET status = 'sent', updated_at = 7500 WHERE logical_key = ?")
    .run(`controller:${turn.id}:reply`);
  expect(store.updateControllerStream({
    turnId: turn.id,
    cursor: 4,
    phase: "thinking",
    toolCalls: 9,
    commandFailures: 7,
    totalTokens: 12_345,
    ...fence,
    now: 8_000,
  })).toBe(false);

  const replayed = store.getControllerTurn(turn.id)!;
  expect(replayed).toMatchObject({
    streamText: CONTROLLER_PHASE_TEXT.thinking,
    toolCalls: 3,
    commandFailures: 0,
    totalTokens: 0,
    updatedAt: 7_000,
  });
  expect(db.prepare("SELECT status, updated_at FROM outbox WHERE logical_key = ?")
    .get(`controller:${turn.id}:reply`)).toEqual({ status: "sent", updated_at: 7_500 });
});

it("refuses fail-and-retire when the expected live thread does not match", () => {
  const { store } = fixture();
  const { turn, fence } = submittedTurn(store, "thr_fail_retire_live");
  const outboxBefore = store.getOutbox(`controller:${turn.id}:reply`);

  expect(store.failAndRetireControllerTurn({
    turnId: turn.id,
    controllerKey: "owner-7-controller",
    expectedThreadId: "thr_some_other_thread",
    error: "boom",
    expectedAcceptedFinalizationId: null,
    ...fence,
  })).toBe("stale");

  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "submitted" });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({
    state: "active",
    threadId: "thr_fail_retire_live",
  });
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toEqual(outboxBefore);
});

it("refuses fail-and-retire under a stale executor lease with no write", () => {
  const { store } = fixture();
  const { turn, fence } = submittedTurn(store, "thr_fail_retire_lease");
  const outboxBefore = store.getOutbox(`controller:${turn.id}:reply`);

  expect(store.failAndRetireControllerTurn({
    turnId: turn.id,
    controllerKey: "owner-7-controller",
    expectedThreadId: "thr_fail_retire_lease",
    error: "boom",
    expectedAcceptedFinalizationId: null,
    ownerId: fence.ownerId,
    generation: fence.generation + 1,
    now: fence.now,
  })).toBe("stale");

  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "submitted" });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({
    state: "active",
    threadId: "thr_fail_retire_lease",
  });
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toEqual(outboxBefore);
});

it("rolls back turn, generation retirement, and outbox together on injected failure", () => {
  const { bb, store } = fixture();
  const { turn, fence } = submittedTurn(store, "thr_fail_retire_rollback");
  const db = bb.storage.database();
  const outboxBefore = store.getOutbox(`controller:${turn.id}:reply`);

  // Abort late, on the final logical outbox row rewrite, so the turn failure
  // and generation retirement writes have already happened and are proven
  // rolled back together with the outbox.
  db.exec(`
    CREATE TRIGGER boom_fail_and_retire
    AFTER UPDATE ON outbox
    WHEN NEW.logical_key = 'controller:${turn.id}:reply'
    BEGIN
      SELECT RAISE(ABORT, 'boom-fail-and-retire');
    END
  `);

  expect(() => store.failAndRetireControllerTurn({
    turnId: turn.id,
    controllerKey: "owner-7-controller",
    expectedThreadId: "thr_fail_retire_rollback",
    error: "boom",
    expectedAcceptedFinalizationId: null,
    ...fence,
  })).toThrow(/boom-fail-and-retire/);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "submitted",
    lastError: null,
    completedAt: null,
  });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({
    state: "active",
    threadId: "thr_fail_retire_rollback",
  });
  const generations = db.prepare(
    "SELECT ended_at FROM controller_generations WHERE controller_key = 'owner-7-controller' AND thread_id = 'thr_fail_retire_rollback'",
  ).all();
  expect(generations[0]).toMatchObject({ ended_at: null });
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toEqual(outboxBefore);
});

it("throws and rolls back fail-and-retire when its generation disappears after the turn write", () => {
  const { bb, store } = fixture();
  const { turn, fence } = submittedTurn(store, "thr_fail_retire_late_generation");
  const db = bb.storage.database();
  const outboxBefore = store.getOutbox(`controller:${turn.id}:reply`);
  db.exec(`
    CREATE TRIGGER remove_fail_generation
    AFTER UPDATE OF state ON controller_turns
    WHEN NEW.id = '${turn.id}' AND NEW.state = 'failed'
    BEGIN
      UPDATE controller_generations SET ended_at = 1, end_reason = 'raced'
       WHERE controller_key = NEW.controller_key AND thread_id = 'thr_fail_retire_late_generation';
    END
  `);

  expect(() => store.failAndRetireControllerTurn({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    expectedThreadId: "thr_fail_retire_late_generation",
    error: "late generation mismatch",
    expectedAcceptedFinalizationId: null,
  })).toThrow(/generation/i);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "submitted", completedAt: null, lastError: null });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "active", threadId: "thr_fail_retire_late_generation" });
  expect(db.prepare(
    "SELECT ended_at FROM controller_generations WHERE controller_key = ? AND thread_id = ?",
  ).get(turn.controllerKey, "thr_fail_retire_late_generation")).toEqual({ ended_at: null });
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toEqual(outboxBefore);
});

// The 1:50am failure: a thread the controller started raised a three-option
// design question and it arrived on the owner's phone as a menu to tap.
it("hands a spawned thread's question to the controller and leaves the owner alone", () => {
  const { store } = fixture();
  submittedTurn(store, "thr_controller_parent");

  expect(store.recordThreadInteraction({
    interactionId: "pint_design",
    threadId: "thr_spawned",
    title: "Tell the owner what I asked a thread to do",
    interaction: {
      kind: "user_question",
      interactionId: "pint_design",
      questions: [{
        id: "q1",
        prompt: "Which shape should the retry take?",
        shortLabel: "Approach",
        multiSelect: false,
        allowFreeText: false,
        options: [
          { value: "a", label: "Retry in place", description: null },
          { value: "b", label: "Fresh thread", description: null },
        ],
      }],
    },
    chatId: "7",
    now: 5_000,
    parentThreadId: "thr_controller_parent",
  })).toBe(true);

  expect(store.getOutbox("thread-interaction:pint_design")).toBeNull();
  const queued = store.getQueuedControllerTurn("owner-7-controller");
  expect(queued?.origin).toBe("system");
  expect(queued?.inputText).toMatch(/blocked and waiting on you/i);
  expect(queued?.inputText).toMatch(/Retry in place/);
  expect(queued?.inputText).toMatch(/telegram_agent_answer_thread/);
});

it("retries a controller-routed question whose first follow-up enqueue failed", () => {
  const { bb, store } = fixture();
  submittedTurn(store, "thr_controller_parent_retry");
  const db = bb.storage.database();
  db.exec(`
    CREATE TRIGGER fail_first_thread_follow_up
    BEFORE INSERT ON controller_turns
    WHEN NEW.origin = 'system'
    BEGIN
      SELECT RAISE(ABORT, 'injected controller follow-up failure');
    END
  `);
  const input = {
    interactionId: "pint_retry",
    threadId: "thr_spawned_retry",
    title: "Choose the retry",
    interaction: {
      kind: "unsupported" as const,
      interactionId: "pint_retry",
    },
    chatId: "7",
    now: 5_000,
    parentThreadId: "thr_controller_parent_retry",
  };

  expect(store.recordThreadInteraction(input)).toBe(true);
  expect(store.getQueuedControllerTurn("owner-7-controller")).toBeNull();
  db.exec("DROP TRIGGER fail_first_thread_follow_up");

  expect(store.recordThreadInteraction({ ...input, now: 5_001 })).toBe(true);
  expect(store.getQueuedControllerTurn("owner-7-controller")).toMatchObject({ origin: "system" });
  expect(db.prepare(
    "SELECT controller_key, controller_turn_id FROM thread_interactions WHERE interaction_id = ?",
  ).get(input.interactionId)).toEqual({
    controller_key: "owner-7-controller",
    controller_turn_id: expect.stringMatching(/^controller-turn-/),
  });
});

it("routes a spawned thread's question back to its exact parent controller", () => {
  const { bb, store } = fixture();
  submittedTurn(store, "thr_controller_parent_a");
  const db = bb.storage.database();
  db.prepare(
    `INSERT INTO controller_threads (
       controller_key, telegram_user_id, telegram_chat_id, bb_thread_id,
       state, created_at, updated_at
     ) VALUES ('owner-7-controller-b', '7', '7', 'thr_controller_parent_b', 'active', 4_000, 4_000)`,
  ).run();

  expect(store.recordThreadInteraction({
    interactionId: "pint_parent_b",
    threadId: "thr_spawned_b",
    title: "Question from B",
    interaction: { kind: "unsupported", interactionId: "pint_parent_b" },
    chatId: "7",
    now: 5_000,
    parentThreadId: "thr_controller_parent_b",
  })).toBe(true);

  expect(db.prepare(
    "SELECT controller_key FROM controller_turns WHERE origin = 'system' ORDER BY created_at DESC LIMIT 1",
  ).get()).toEqual({ controller_key: "owner-7-controller-b" });
  expect(db.prepare(
    "SELECT controller_key FROM thread_interactions WHERE interaction_id = 'pint_parent_b'",
  ).get()).toEqual({ controller_key: "owner-7-controller-b" });
});

it("does not enqueue a duplicate follow-up while the linked controller turn is live", () => {
  const { bb, store } = fixture();
  submittedTurn(store, "thr_controller_parent_live");
  const input = {
    interactionId: "pint_live",
    threadId: "thr_spawned_live",
    title: "One live question",
    interaction: { kind: "unsupported" as const, interactionId: "pint_live" },
    chatId: "7",
    now: 5_000,
    parentThreadId: "thr_controller_parent_live",
  };
  expect(store.recordThreadInteraction(input)).toBe(true);
  const db = bb.storage.database();
  const before = db.prepare("SELECT count(*) AS n FROM controller_turns WHERE origin = 'system'").get();

  expect(store.recordThreadInteraction({ ...input, now: 5_001 })).toBe(false);
  expect(db.prepare("SELECT count(*) AS n FROM controller_turns WHERE origin = 'system'").get()).toEqual(before);
});

it("moves a pending controller question to the owner after its controller is revoked", () => {
  const { bb, store } = fixture();
  submittedTurn(store, "thr_controller_parent_revoked");
  const input = {
    interactionId: "pint_revoked",
    threadId: "thr_spawned_revoked",
    title: "Question that must not be stranded",
    interaction: { kind: "unsupported" as const, interactionId: "pint_revoked" },
    chatId: "7",
    now: 5_000,
    parentThreadId: "thr_controller_parent_revoked",
  };
  expect(store.recordThreadInteraction(input)).toBe(true);
  expect(store.revokeOwner(5_001)).toBe(true);
  store.createPairingCode(hashSecret("pair-after-revoke"), 5_002, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair-after-revoke"), "7", "7", 5_003)).toEqual({ ok: true });

  expect(store.hasPendingThreadInteractionForThread(input.threadId)).toBe(true);
  expect(store.recordThreadInteraction({ ...input, now: 5_004 })).toBe(true);
  expect(store.getOutbox(`thread-interaction:${input.interactionId}`)).not.toBeNull();
  expect(bb.storage.database().prepare(
    "SELECT audience, controller_key, controller_turn_id FROM thread_interactions WHERE interaction_id = ?",
  ).get(input.interactionId)).toEqual({
    audience: "owner",
    controller_key: null,
    controller_turn_id: null,
  });
});

it("still asks the owner about a thread they opened themselves", () => {
  const { store } = fixture();
  submittedTurn(store, "thr_controller_parent");

  expect(store.recordThreadInteraction({
    interactionId: "pint_owned",
    threadId: "thr_owner_started",
    title: "Owner's own thread",
    interaction: { kind: "unsupported", interactionId: "pint_owned" },
    chatId: "7",
    now: 5_000,
    parentThreadId: null,
  })).toBe(true);

  expect(store.getOutbox("thread-interaction:pint_owned")).not.toBeNull();
});

// Merge, deploy, money, and credentials stay the owner's even on a thread the
// controller started.
it("keeps a spawned thread's merge approval with the owner", () => {
  const { store } = fixture();
  submittedTurn(store, "thr_controller_parent");

  expect(store.recordThreadInteraction({
    interactionId: "pint_merge",
    threadId: "thr_spawned",
    title: "Ship the fix",
    interaction: {
      kind: "approval",
      interactionId: "pint_merge",
      summary: "wants to run:\n\n`gh pr merge 42 --squash`",
      decisions: ["allow_once", "deny"],
    },
    chatId: "7",
    now: 5_000,
    parentThreadId: "thr_controller_parent",
  })).toBe(true);

  expect(store.getOutbox("thread-interaction:pint_merge")).not.toBeNull();
});

it("lets the controller answer a block routed to it and refuses one that was not", () => {
  const { store } = fixture();
  submittedTurn(store, "thr_controller_parent");
  const approval = (id: string, parentThreadId: string | null) => store.recordThreadInteraction({
    interactionId: id,
    threadId: "thr_spawned",
    title: "Run the suite",
    interaction: {
      kind: "approval",
      interactionId: id,
      summary: "wants to run:\n\n`npm test`",
      decisions: ["allow_once", "allow_for_session", "deny"],
    },
    chatId: "7",
    now: 5_000,
    parentThreadId,
  });

  expect(approval("pint_mine", "thr_controller_parent")).toBe(true);
  expect(approval("pint_owners", null)).toBe(true);

  expect(store.answerThreadInteractionAsController({
    interactionId: "pint_mine",
    threadId: "thr_spawned",
    decision: "allow_once",
    now: 6_000,
  })).toEqual({ ok: true });
  expect(store.getAnsweredThreadInteraction()).toMatchObject({
    interactionId: "pint_mine",
    resolution: { decision: "allow_once", grantedPermissions: null },
  });

  // The owner's own block is not the controller's to take over.
  expect(store.answerThreadInteractionAsController({
    interactionId: "pint_owners",
    threadId: "thr_spawned",
    decision: "allow_once",
    now: 6_001,
  })).toEqual({ ok: false, reason: "not_controller_routed" });
});

// A standing grant removes the boundary for everything the thread does next, so
// the controller may unblock a thread but never hand it one.
it("refuses a session-wide grant from the controller", () => {
  const { store } = fixture();
  submittedTurn(store, "thr_controller_parent");
  expect(store.recordThreadInteraction({
    interactionId: "pint_session",
    threadId: "thr_spawned",
    title: "Run the suite",
    interaction: {
      kind: "approval",
      interactionId: "pint_session",
      summary: "wants to run:\n\n`npm test`",
      decisions: ["allow_once", "allow_for_session", "deny"],
    },
    chatId: "7",
    now: 5_000,
    parentThreadId: "thr_controller_parent",
  })).toBe(true);

  expect(store.answerThreadInteractionAsController({
    interactionId: "pint_session",
    threadId: "thr_spawned",
    decision: "allow_for_session" as "allow_once",
    now: 6_000,
  })).toEqual({ ok: false, reason: "decision_not_allowed" });
});
