import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import {
  ALL_MIGRATIONS,
  OWNER_BOUNDARY_MIGRATIONS,
  OWNER_BOUNDARY_SOURCE_MIGRATIONS,
  POLICY_APPROVAL_INTENT_MIGRATIONS,
  RELEASE_AUTHORITY_MIGRATIONS,
  TASK_AUTHORITY_MIGRATIONS,
  TASK_AUTHORITY_CLOSURE_MIGRATIONS,
  TASK_AUTHORITY_PUBLISH_MIGRATIONS,
  TASK_AUTHORITY_REVISION_MIGRATIONS,
  NAVIGATOR_RELEASE_MIGRATIONS,
  NAVIGATOR_PROMOTION_MIGRATIONS,
} from "../src/storage/migrations";
import {
  ControllerInteractionRepository,
  type ControllerInteractionAnswer,
  type ControllerInteraction,
} from "../src/storage/controller-interaction-repository";
import { migrateControllerInteractionStorage, openStore } from "../src/storage/store";
import { registerWorkArtifactRelationshipValidation } from "../src/work-artifacts/repository";
import {
  controllerInteractionToken,
  parseControllerInteractionResolution,
  parseControllerInteraction,
  questionOptionToken,
  threadDecisionToken,
} from "../src/controller/questions";

const SHIPPED_MIGRATION_COUNT = 29;
const CONTROLLER_INTERACTION_MIGRATION_INDEX = ALL_MIGRATIONS.findIndex((migration) =>
  migration.includes("CREATE TABLE controller_interactions"),
);
const CONTROLLER_INTERACTION_REPAIR_START = ALL_MIGRATIONS.findIndex((migration) =>
  migration.includes("CREATE TABLE controller_interaction_quarantine"),
);
if (CONTROLLER_INTERACTION_MIGRATION_INDEX < 0 || CONTROLLER_INTERACTION_REPAIR_START < 0) {
  throw new Error("controller interaction migration markers are missing");
}
const CURRENT_OWNER = "executor";
const CURRENT_GENERATION = 1;
const CURRENT_NOW = 2_000;
type LegacyInteractionId = string | number | Buffer | null;
const SENSITIVE_QUERY_KEYS = [
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "api_key",
  "auth",
  "authorization",
  "auth_token",
  "session",
  "session_token",
  "private",
  "private_key",
  "credentials",
  "password",
  "passwd",
  "secret",
  "token",
  "key",
  "jwt",
  "signature",
  "sig",
] as const;
const TICKET_41_MIGRATION_COUNT = TASK_AUTHORITY_MIGRATIONS.length +
  RELEASE_AUTHORITY_MIGRATIONS.length + OWNER_BOUNDARY_MIGRATIONS.length +
  TASK_AUTHORITY_REVISION_MIGRATIONS.length + TASK_AUTHORITY_CLOSURE_MIGRATIONS.length +
  TASK_AUTHORITY_PUBLISH_MIGRATIONS.length + OWNER_BOUNDARY_SOURCE_MIGRATIONS.length +
  POLICY_APPROVAL_INTENT_MIGRATIONS.length;

function percentEncodeLayers(value: string, layers: number): string {
  let encoded = value;
  for (let index = 0; index < layers; index += 1) encoded = encodeURIComponent(encoded);
  return encoded;
}

function unicodeEscapeLayer(value: string): string {
  return Array.from(value)
    .map((character) => `\\u{${character.codePointAt(0)!.toString(16)}}`)
    .join("");
}

type CurrentFixture = {
  db: Database.Database;
  directory: string;
  repository: ControllerInteractionRepository;
  controllerKey: string;
  turnId: string;
  threadId: string;
  generationId: string;
  fence: { ownerId: string; generation: number; now: number };
};

function approvalPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "approval",
    subject: {
      kind: "command",
      itemId: "item_1",
      command: "npm test",
      cwd: "project",
      actions: [],
    },
    availableDecisions: ["allow_once", "allow_for_session", "deny"],
    ...overrides,
  };
}

function questionPayload(prompt = "Which option should I use?"): Record<string, unknown> {
  return {
    kind: "user_question",
    questions: [{
      id: "question_1",
      prompt,
      shortLabel: "Choose",
      multiSelect: false,
      allowFreeText: true,
      options: [
        { value: "first", label: "First", description: "Use the first option." },
        { value: "second", label: "Second", description: "Use the second option." },
      ],
    }],
  };
}

function questionPayloadQuestion(): Record<string, unknown> {
  const question = (questionPayload().questions as unknown[])[0];
  if (typeof question !== "object" || question === null) throw new Error("question fixture is malformed");
  return question as Record<string, unknown>;
}

function unsupportedProjection(interactionId: string, sourceKind: "approval" | "user_question"): ControllerInteraction {
  return { kind: "unsupported", interactionId, metadata: { sourceKind } };
}

function legacyQuestionsJson(edit?: (questions: Record<string, unknown>[]) => void): string {
  const questions = JSON.parse(JSON.stringify(questionPayload().questions)) as Record<string, unknown>[];
  edit?.(questions);
  return JSON.stringify(questions);
}

function currentInteractionFixture(): CurrentFixture {
  const directory = mkdtempSync(join(tmpdir(), "telegram-controller-interactions-"));
  const dbPath = join(directory, "controller-interactions.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  try {
    registerWorkArtifactRelationshipValidation(db);
    for (const migration of ALL_MIGRATIONS) db.exec(migration);
    const controllerKey = "owner-7-controller";
    const turnId = "turn_interaction_1";
    const threadId = "thr_controller_1";
    const generationId = "gen_controller_1";
    db.prepare(
      `INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at)
       VALUES (1, '7', '70', 1_000, NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO controller_threads (
         controller_key, telegram_user_id, telegram_chat_id, project_id, host_id,
         bb_thread_id, state, pending_spawn_token, last_error, created_at, updated_at
       ) VALUES (?, '7', '70', 'proj_1', 'host_1', ?, 'active', NULL, NULL, 1, 1)`,
    ).run(controllerKey, threadId);
    db.prepare(
      `INSERT INTO controller_turns (
         id, telegram_update_id, controller_key, ordinal, input_text, state,
         lease_owner, lease_generation, submitted_at, created_at, updated_at
       ) VALUES (?, 1, ?, 1, 'controller input', 'submitted', ?, ?, ?, 1, ?)`,
    ).run(turnId, controllerKey, CURRENT_OWNER, CURRENT_GENERATION, CURRENT_NOW, CURRENT_NOW);
    db.prepare(
      `INSERT INTO controller_generations (id, controller_key, thread_id, started_at, ended_at, end_reason)
       VALUES (?, ?, ?, 1, NULL, NULL)`,
    ).run(generationId, controllerKey, threadId);
    db.prepare(
      `UPDATE executor_lease
          SET owner_id = ?, generation = ?, heartbeat_at = ?, lease_expires_at = ?
        WHERE singleton = 1`,
    ).run(CURRENT_OWNER, CURRENT_GENERATION, CURRENT_NOW, 30_000);
    return {
      db,
      directory,
      repository: new ControllerInteractionRepository(db),
      controllerKey,
      turnId,
      threadId,
      generationId,
      fence: { ownerId: CURRENT_OWNER, generation: CURRENT_GENERATION, now: CURRENT_NOW },
    };
  } catch (error) {
    db.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function closeCurrentFixture(fixture: CurrentFixture): void {
  fixture.db.close();
  rmSync(fixture.directory, { recursive: true, force: true });
}

function legacyQuestionDatabaseFixture(migrationCount = SHIPPED_MIGRATION_COUNT) {
  const { bb } = createFakePluginHost({ pluginId: "telegram-controller-interaction-migration" });
  const db = bb.storage.database();
  bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(0, migrationCount));
  const controllerKey = "owner-7-controller";
  const turnId = "turn_legacy_question";
  const threadId = "thr_legacy_controller";
  const generationId = "gen_legacy_controller";
  db.prepare(
    `INSERT INTO controller_threads (
       controller_key, telegram_user_id, telegram_chat_id, project_id, host_id,
       bb_thread_id, state, pending_spawn_token, last_error, created_at, updated_at
     ) VALUES (?, '7', '70', 'proj_1', 'host_1', ?, 'active', NULL, NULL, 1, 1)`,
  ).run(controllerKey, threadId);
  db.prepare(
    `INSERT INTO controller_turns (
       id, telegram_update_id, controller_key, ordinal, input_text, state,
       lease_owner, lease_generation, submitted_at, created_at, updated_at
     ) VALUES (?, 1, ?, 1, 'legacy input', 'submitted', 'executor', 1, 1_000, 1, 1)`,
  ).run(turnId, controllerKey);
  db.prepare(
    `INSERT INTO controller_generations (id, controller_key, thread_id, started_at, ended_at, end_reason)
     VALUES (?, ?, ?, 1, NULL, NULL)`,
  ).run(generationId, controllerKey, threadId);
  return {
    bb,
    db,
    controllerKey,
    turnId,
    threadId,
    generationId,
    insertQuestion(
      state: "pending" | "answered" | "delivered",
      interactionId: LegacyInteractionId = "legacy_interaction",
      answersJson: string | null = state === "pending" ? "{}" : JSON.stringify({ question_1: { selected: ["first"] } }),
      questionsJson = JSON.stringify(questionPayload().questions),
    ) {
      db.prepare(
        `INSERT INTO controller_questions (
           interaction_id, turn_id, controller_key, questions_json, state, answers_json, asked_at, answered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        interactionId,
        turnId,
        controllerKey,
        questionsJson,
        state,
        answersJson,
        state === "pending" ? 2_000 : 2_001,
        state === "pending" ? null : 2_002,
      );
    },
    legacyRows() {
      return db.prepare("SELECT * FROM controller_questions ORDER BY rowid").all();
    },
    migrateRemaining() {
      migrateControllerInteractionStorage(bb.storage);
    },
  };
}

function insertControllerQuestionQuarantine(
  fixture: ReturnType<typeof legacyQuestionDatabaseFixture>,
  interactionId: string,
  answerJson: string,
  priorState: "pending" | "answered",
  questionsJson = JSON.stringify(questionPayload()),
): void {
  fixture.db.prepare(
    `INSERT INTO controller_interactions (
       interaction_id, turn_id, controller_key, bb_thread_id, controller_generation_id,
       kind, payload_json, state, answer_json, asked_at, answered_at, delivered_at
     ) VALUES (?, ?, ?, ?, ?, 'user_question', ?, 'delivered', NULL, ?, NULL, ?)`,
  ).run(
    interactionId,
    fixture.turnId,
    fixture.controllerKey,
    fixture.threadId,
    fixture.generationId,
    questionsJson,
    2_000,
    2_100,
  );
  fixture.db.prepare(
    `INSERT INTO controller_interaction_quarantine (
       source, interaction_id, turn_id, controller_key, bb_thread_id,
       controller_generation_id, thread_id, title, kind, payload_json, answer_json,
       prior_state, asked_at, answered_at, quarantined_at
     ) VALUES ('controller', ?, ?, ?, ?, ?, NULL, NULL, 'user_question', ?, ?, ?, ?, ?, ?)`,
  ).run(
    interactionId,
    fixture.turnId,
    fixture.controllerKey,
    fixture.threadId,
    fixture.generationId,
    questionsJson,
    answerJson,
    priorState,
    2_000,
    priorState === "answered" ? 2_002 : null,
    2_100,
  );
}

function insertLegacyOwner(fixture: ReturnType<typeof legacyQuestionDatabaseFixture>): void {
  fixture.db.prepare(
    `INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at)
     VALUES (1, '7', '70', 1_000, NULL)`,
  ).run();
}

function expectLegacyMigrationRollback(
  fixture: ReturnType<typeof legacyQuestionDatabaseFixture>,
  originalRows: unknown[],
): void {
  const migrationIds = (fixture.db.prepare(
    "SELECT id FROM _bb_migrations ORDER BY id",
  ).all() as Array<{ id: number }>).map((row) => row.id);
  expect(migrationIds).toEqual([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    20, 21, 22, 23, 24, 25, 26, 27, 28,
  ]);
  expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM _bb_migrations").get()).toEqual({
    count: SHIPPED_MIGRATION_COUNT,
  });
  expect(fixture.db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'controller_interactions'",
  ).get()).toBeUndefined();
  expect(fixture.legacyRows()).toEqual(originalRows);
}

function expectLegacyMigrationQuarantine(
  fixture: ReturnType<typeof legacyQuestionDatabaseFixture>,
): void {
  expect(fixture.db.prepare("SELECT MAX(id) AS id FROM _bb_migrations").get()).toEqual({ id: ALL_MIGRATIONS.length - 1 });
  expect(fixture.db.prepare(
    "SELECT COUNT(*) AS count FROM controller_questions WHERE state IN ('pending', 'answered')",
  ).get()).toEqual({ count: 0 });
  expect(fixture.db.prepare(
    "SELECT COUNT(*) AS count FROM controller_interactions WHERE state IN ('pending', 'answered')",
  ).get()).toEqual({ count: 0 });
  expect(fixture.db.prepare(
    "SELECT COUNT(*) AS count FROM controller_interaction_quarantine WHERE source = 'controller_questions'",
  ).get()).toEqual({ count: 1 });
}

function controllerInteraction(
  interactionId: string,
  kind: ControllerInteraction["kind"] = "user_question",
): ControllerInteraction {
  if (kind === "user_question") {
    return {
      kind,
      interactionId,
      questions: [{
        id: "question_1",
        prompt: "Which option should I use?",
        shortLabel: "Choose",
        multiSelect: false,
        allowFreeText: true,
        options: [
          { value: "first", label: "First", description: "Use the first option." },
          { value: "second", label: "Second", description: "Use the second option." },
        ],
      }],
    };
  }
  if (kind === "approval") {
    return { kind, interactionId, summary: "wants to run: npm test", decisions: ["allow_once", "deny"] };
  }
  return { kind, interactionId };
}

function recordInput(fixture: CurrentFixture, interaction: ControllerInteraction, now = CURRENT_NOW) {
  return {
    ...fixture.fence,
    now,
    turnId: fixture.turnId,
    controllerKey: fixture.controllerKey,
    bbThreadId: fixture.threadId,
    controllerGenerationId: fixture.generationId,
    interaction,
  };
}

type InteractionRaceResult = ControllerInteractionAnswer;
type InteractionRaceWorker = Readonly<{
  child: ChildProcess;
  result: Promise<InteractionRaceResult>;
}>;

function interactionRaceWorkerSource(): string {
  return String.raw`
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ControllerInteractionRepository } from "REPOSITORY_MODULE";

const [dbPath, barrierDir, label, action, token] = process.argv.slice(2);
if (!dbPath || !barrierDir || !label || !action) throw new Error("interaction race arguments are incomplete");
const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");
const repository = new ControllerInteractionRepository(db);
writeFileSync(join(barrierDir, "ready-" + label), "ready");
const wait = () => {
  while (!existsSync(join(barrierDir, "go"))) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
};
wait();
const result = action === "button"
  ? repository.answerByToken({ token, userId: "7", chatId: "70", now: 2_100 })
  : repository.answerWithText({ controllerKey: "owner-7-controller", userId: "7", chatId: "70", text: "ordinary answer", now: 2_100 });
process.stdout.write(JSON.stringify(result) + "\n");
db.close();
`;
}

function waitForInteractionRaceFile(path: string, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolveWait, rejectWait) => {
    const startedAt = Date.now();
    const poll = () => {
      if (existsSync(path)) return resolveWait();
      if (Date.now() - startedAt >= timeoutMs) return rejectWait(new Error(`interaction race barrier timed out: ${path}`));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function startInteractionRaceWorker(
  scriptPath: string,
  fixture: CurrentFixture,
  barrierDir: string,
  label: string,
  action: "button" | "text",
  token = "",
): InteractionRaceWorker {
  const child = spawn(resolve("node_modules/.bin/vite-node"), [
    "--script",
    scriptPath,
    fixture.db.name,
    barrierDir,
    label,
    action,
    token,
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const result = new Promise<InteractionRaceResult>((resolveResult, rejectResult) => {
    child.once("error", rejectResult);
    child.once("close", (code) => {
      if (code !== 0) {
        rejectResult(new Error(`interaction race worker exited ${code}: ${stderr || stdout}`));
        return;
      }
      const line = stdout.trim().split("\n").at(-1);
      if (!line) {
        rejectResult(new Error(`interaction race worker returned no result: ${stderr}`));
        return;
      }
      try {
        resolveResult(JSON.parse(line) as InteractionRaceResult);
      } catch (error) {
        rejectResult(new Error(`interaction race worker returned invalid JSON: ${stdout}`, { cause: error }));
      }
    });
  });
  return { child, result };
}

async function runInteractionRace(
  fixture: CurrentFixture,
  interaction: ControllerInteraction,
  workers: readonly { label: string; action: "button" | "text"; token?: string }[],
): Promise<InteractionRaceResult[]> {
  const barrierDir = mkdtempSync(join(tmpdir(), "controller-interaction-race-"));
  const scriptPath = join(barrierDir, "worker.ts");
  writeFileSync(scriptPath, interactionRaceWorkerSource().replace("REPOSITORY_MODULE", resolve("src/storage/controller-interaction-repository.ts")));
  const handles = workers.map((worker) => startInteractionRaceWorker(scriptPath, fixture, barrierDir, worker.label, worker.action, worker.token));
  try {
    await Promise.all(workers.map((worker) => waitForInteractionRaceFile(join(barrierDir, `ready-${worker.label}`))));
    writeFileSync(join(barrierDir, "go"), "go");
    return await Promise.all(handles.map((handle) => handle.result));
  } finally {
    for (const handle of handles) {
      if (handle.child.exitCode === null) handle.child.kill("SIGKILL");
    }
    rmSync(barrierDir, { recursive: true, force: true });
  }
}

it("pins the shipped migration bytes and appends the runtime repair migrations", () => {
  expect(ALL_MIGRATIONS).toHaveLength(
    80 + TICKET_41_MIGRATION_COUNT + NAVIGATOR_RELEASE_MIGRATIONS.length + NAVIGATOR_PROMOTION_MIGRATIONS.length,
  );
  expect(createHash("sha256").update([...ALL_MIGRATIONS].slice(0, 28).join("\u0000")).digest("hex")).toBe(
    "505dfd4781117dfb2c817d31640e833370189e6b3ef2c7c24e646fb1838eed56",
  );
  expect(createHash("sha256").update(ALL_MIGRATIONS[40]).digest("hex")).toBe(
    "4ec9eb259bbdce396ac0026c13ebd84ec71f25433092827cc9aae5fe903505d3",
  );
  expect(ALL_MIGRATIONS[41]).toContain("CREATE TABLE controller_interactions");
  expect(ALL_MIGRATIONS[41]).toContain("CHECK (state = 'delivered'");
  expect(ALL_MIGRATIONS[45]).toContain("steer_reservation_turn_id");
  expect(ALL_MIGRATIONS[46]).toContain("controller_supervisor_steer_attempts");
  expect(ALL_MIGRATIONS[47]).toContain("controller_interaction_quarantine");
  expect(ALL_MIGRATIONS[48]).toContain("envelope_version");
  expect(ALL_MIGRATIONS[49]).toContain("consumed_at");
  expect(ALL_MIGRATIONS[50]).toContain("private_draft_text");
  expect(ALL_MIGRATIONS[51]).toContain("thread_follow_up_json");
  expect(ALL_MIGRATIONS[52]).toContain("controller_generation_quarantine");
  expect(ALL_MIGRATIONS[53]).toContain("one_open_controller_generation");
  expect(ALL_MIGRATIONS[54]).toContain("delivery_state");
  expect(ALL_MIGRATIONS[66]).toContain("thread_interactions ADD COLUMN controller_key");
  expect(ALL_MIGRATIONS[67]).toContain("CREATE TABLE reference_section_digests");
  expect(ALL_MIGRATIONS[68]).toContain("CREATE TABLE project_admission_pause_clear_history");
  expect(ALL_MIGRATIONS[69]).toContain("CREATE TABLE controller_voice_inbox");
  expect(ALL_MIGRATIONS[70]).toContain("attempts_before_consensus_lens");
  expect(ALL_MIGRATIONS[78]).toContain("CREATE TABLE navigator_integrations");
  expect(ALL_MIGRATIONS[79]).toContain("step_contract_json");
  expect(ALL_MIGRATIONS[71]).toContain("CREATE TABLE audit_intake_findings");
  expect(ALL_MIGRATIONS[72]).toContain("merge_pre_approved_at");
  expect(ALL_MIGRATIONS[73]).toContain("CREATE TABLE work_artifacts");
  expect(ALL_MIGRATIONS[74]).toContain("work_artifact_relationships_internal_refs");
  expect(ALL_MIGRATIONS[75]).toContain("work_artifact_relationships_canonical_insert");
  expect(ALL_MIGRATIONS[76]).toContain("CREATE TABLE navigator_snapshots");
  expect(ALL_MIGRATIONS[77]).toContain("CREATE TABLE navigator_planning_results");
});

it("copies legacy questions once, preserves their table, and restores the active pointer", () => {
  const fixture = legacyQuestionDatabaseFixture();
  fixture.insertQuestion("answered");

  fixture.migrateRemaining();
  expect(fixture.db.prepare(
    `SELECT interaction_id, turn_id, controller_key, bb_thread_id, controller_generation_id,
            kind, state, answer_json, delivered_at
       FROM controller_interactions`,
  ).get()).toEqual({
    interaction_id: "legacy_interaction",
    turn_id: fixture.turnId,
    controller_key: fixture.controllerKey,
    bb_thread_id: fixture.threadId,
    controller_generation_id: fixture.generationId,
    kind: "user_question",
    state: "answered",
    answer_json: JSON.stringify({
      kind: "user_answer",
      answers: { question_1: { selected: ["first"] } },
    }),
    delivered_at: null,
  });
  expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM controller_questions").get()).toEqual({ count: 1 });
  expect(fixture.db.prepare("SELECT awaiting_interaction_id FROM controller_turns WHERE id = ?").get(fixture.turnId))
    .toEqual({ awaiting_interaction_id: "legacy_interaction" });

  fixture.migrateRemaining();
  expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM controller_interactions").get()).toEqual({ count: 1 });
});

it("quarantines pre-repair controller and watched-thread approvals while revalidating user questions", () => {
  const fixture = legacyQuestionDatabaseFixture(CONTROLLER_INTERACTION_REPAIR_START);
  const { db } = fixture;
  db.prepare(
    `INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at)
     VALUES (1, '7', '70', 1, NULL)`,
  ).run();
  db.prepare(
    `UPDATE executor_lease SET owner_id = 'executor', generation = 1,
       heartbeat_at = 2_000, lease_expires_at = 30_000 WHERE singleton = 1`,
  ).run();

  const insertController = db.prepare(
    `INSERT INTO controller_interactions (
       interaction_id, turn_id, controller_key, bb_thread_id, controller_generation_id,
       kind, payload_json, state, answer_json, asked_at, answered_at, delivered_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  const insertButtonedOutbox = db.prepare(
    `INSERT INTO outbox (
       logical_key, chat_id, message_id, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, '70', 17, ?, 'sent', 0, 2_000, 2_000, 2_000)`,
  );
  const oldButtons = JSON.stringify({
    text: "old interaction",
    reply_markup: { inline_keyboard: [[{ text: "Act", callback_data: "old" }]] },
  });
  const controllerRow = {
    turnId: fixture.turnId,
    key: fixture.controllerKey,
    thread: fixture.threadId,
    generation: fixture.generationId,
  };
  const validQuestionId = "current_valid_question";
  const unsafeQuestionId = "current_unsafe_question";
  const approvalId = "current_approval";
  const sessionApprovalId = "current_session_approval";
  insertController.run(
    validQuestionId,
    controllerRow.turnId,
    controllerRow.key,
    controllerRow.thread,
    controllerRow.generation,
    "user_question",
    JSON.stringify(questionPayload()),
    "pending",
    null,
    2_000,
    null,
  );
  insertController.run(
    unsafeQuestionId,
    controllerRow.turnId,
    controllerRow.key,
    controllerRow.thread,
    controllerRow.generation,
    "user_question",
    JSON.stringify({
      kind: "user_question",
      questions: [{
        id: "question_1",
        prompt: "callback https://example.test/hook",
        options: [],
        allowFreeText: true,
      }],
    }),
    "pending",
    null,
    2_001,
    null,
  );
  insertController.run(
    approvalId,
    controllerRow.turnId,
    controllerRow.key,
    controllerRow.thread,
    controllerRow.generation,
    "approval",
    JSON.stringify(approvalPayload()),
    "answered",
    JSON.stringify({ decision: "deny" }),
    2_002,
    2_003,
  );
  insertController.run(
    sessionApprovalId,
    controllerRow.turnId,
    controllerRow.key,
    controllerRow.thread,
    controllerRow.generation,
    "approval",
    JSON.stringify(approvalPayload({ availableDecisions: ["allow_for_session"] })),
    "pending",
    null,
    2_004,
    null,
  );
  for (const interactionId of [validQuestionId, unsafeQuestionId, approvalId, sessionApprovalId]) {
    insertButtonedOutbox.run(`controller-interaction:${interactionId}:0`, oldButtons);
  }
  db.prepare("UPDATE controller_turns SET awaiting_interaction_id = ? WHERE id = ?")
    .run(validQuestionId, fixture.turnId);

  const threadQuestionId = "watched_valid_question";
  const threadApprovalId = "watched_approval";
  const threadAnsweredApprovalId = "watched_answered_approval";
  const insertThread = db.prepare(
    `INSERT INTO thread_interactions (
       interaction_id, thread_id, title, kind, payload_json, state, answer_json, asked_at, answered_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertThread.run(
    threadQuestionId,
    "watched-thread",
    "Watched question",
    "user_question",
    JSON.stringify(questionPayload()),
    "pending",
    null,
    2_000,
    null,
  );
  insertThread.run(
    threadApprovalId,
    "watched-thread",
    "Watched approval",
    "approval",
    JSON.stringify(approvalPayload()),
    "pending",
    null,
    2_001,
    null,
  );
  insertThread.run(
    threadAnsweredApprovalId,
    "watched-thread",
    "Watched answered approval",
    "approval",
    JSON.stringify(approvalPayload()),
    "answered",
    JSON.stringify({ decision: "deny" }),
    2_002,
    2_003,
  );
  for (const interactionId of [threadQuestionId, threadApprovalId, threadAnsweredApprovalId]) {
    insertButtonedOutbox.run(`thread-interaction:${interactionId}`, oldButtons);
  }

  fixture.migrateRemaining();

  expect(db.prepare(
    `SELECT state, kind, answer_json FROM controller_interactions
      WHERE interaction_id IN (?, ?, ?) ORDER BY interaction_id`,
  ).all(unsafeQuestionId, approvalId, sessionApprovalId)).toEqual([
    { state: "delivered", kind: "approval", answer_json: null },
    { state: "delivered", kind: "approval", answer_json: null },
    { state: "delivered", kind: "user_question", answer_json: null },
  ]);
  expect(db.prepare(
    `SELECT state, kind FROM controller_interactions WHERE interaction_id = ?`,
  ).get(validQuestionId)).toEqual({ state: "pending", kind: "user_question" });
  expect(db.prepare(
    "SELECT awaiting_interaction_id FROM controller_turns WHERE id = ?",
  ).get(fixture.turnId)).toEqual({ awaiting_interaction_id: validQuestionId });
  expect(db.prepare(
    `SELECT interaction_id, state, answer_json FROM thread_interactions
      WHERE interaction_id IN (?, ?, ?) ORDER BY interaction_id`,
  ).all(threadApprovalId, threadAnsweredApprovalId, threadQuestionId)).toEqual([
    { interaction_id: threadAnsweredApprovalId, state: "delivered", answer_json: null },
    { interaction_id: threadApprovalId, state: "delivered", answer_json: null },
    { interaction_id: threadQuestionId, state: "pending", answer_json: null },
  ]);
  expect(db.prepare(
    "SELECT COUNT(*) AS count FROM controller_interaction_quarantine",
  ).get()).toEqual({ count: 7 });

  for (const logicalKey of [
    `controller-interaction:${unsafeQuestionId}:0`,
    `controller-interaction:${approvalId}:0`,
    `controller-interaction:${sessionApprovalId}:0`,
    `thread-interaction:${threadApprovalId}`,
    `thread-interaction:${threadAnsweredApprovalId}`,
  ]) {
    const row = db.prepare("SELECT payload_json FROM outbox WHERE logical_key = ?").get(logicalKey) as { payload_json: string };
    expect(JSON.parse(row.payload_json)).toEqual({
      text: "This interaction is no longer available. Open BB to review it.",
      reply_markup: { inline_keyboard: [] },
      disable_web_page_preview: true,
    });
    expect(row.payload_json).not.toContain("old interaction");
  }
  expect(JSON.parse((db.prepare(
    "SELECT payload_json FROM outbox WHERE logical_key = ?",
  ).get(`controller-interaction:${validQuestionId}:0`) as { payload_json: string }).payload_json))
    .toMatchObject({ reply_markup: { inline_keyboard: expect.any(Array) } });
  expect(JSON.parse((db.prepare(
    "SELECT payload_json FROM outbox WHERE logical_key = ?",
  ).get(`thread-interaction:${threadQuestionId}`) as { payload_json: string }).payload_json))
    .toMatchObject({ reply_markup: { inline_keyboard: expect.any(Array) } });

  const repository = new ControllerInteractionRepository(db);
  expect(repository.answerByToken({
    token: controllerInteractionToken(approvalId, "deny"),
    userId: "7",
    chatId: "70",
    now: 2_010,
  })).toEqual({ ok: false, reason: "stale" });
  const store = openStore(fixture.bb.storage, fixture.bb.storage.kv, () => 2_010);
  expect(store.answerThreadInteraction({
    token: threadDecisionToken(threadApprovalId, "allow_once"),
    userId: "7",
    chatId: "70",
    now: 2_010,
  })).toEqual({ ok: false, reason: "stale" });
});

it("preserves and exposes a valid partial pending legacy answer", () => {
  const fixture = legacyQuestionDatabaseFixture();
  const questions = JSON.parse(legacyQuestionsJson()) as Record<string, unknown>[];
  questions.push({ ...questions[0], id: "question_2", prompt: "Which fallback should I use?" });
  const partial = JSON.stringify({ question_1: { selected: [], freeText: "keep this answer" } });
  fixture.insertQuestion("pending", "legacy_partial_interaction", partial, JSON.stringify(questions));

  fixture.migrateRemaining();

  expect(fixture.db.prepare(
    "SELECT state, answer_json FROM controller_interactions WHERE interaction_id = ?",
  ).get("legacy_partial_interaction")).toEqual({
    state: "pending",
    answer_json: JSON.stringify({
      kind: "user_answer",
      answers: { question_1: { selected: [], freeText: "keep this answer" } },
    }),
  });
  expect(new ControllerInteractionRepository(fixture.db).getPending(fixture.controllerKey)).toMatchObject({
    interactionId: "legacy_partial_interaction",
    answers: { question_1: { selected: [], freeText: "keep this answer" } },
  });
});

it("removes an empty keyed legacy answer before the remaining questions and final answer flow", () => {
  const fixture = legacyQuestionDatabaseFixture();
  insertLegacyOwner(fixture);
  const questions = JSON.parse(legacyQuestionsJson()) as Record<string, unknown>[];
  questions.push({ ...questions[0], id: "question_2", prompt: "Which fallback should I use?" });
  fixture.insertQuestion(
    "pending",
    "legacy_empty_first_partial",
    JSON.stringify({ question_1: { selected: [] } }),
    JSON.stringify(questions),
  );

  fixture.migrateRemaining();

  expect(fixture.db.prepare(
    "SELECT state, answer_json FROM controller_interactions WHERE interaction_id = ?",
  ).get("legacy_empty_first_partial")).toEqual({
    state: "pending",
    answer_json: JSON.stringify({ kind: "user_answer", answers: {} }),
  });
  const repository = new ControllerInteractionRepository(fixture.db);
  expect(repository.getPending(fixture.controllerKey)).toMatchObject({ answers: {} });
  expect(repository.answerWithText({
    controllerKey: fixture.controllerKey,
    userId: "7",
    chatId: "70",
    text: "answer the first question",
    now: 2_100,
  })).toMatchObject({ ok: true, complete: false });
  expect(repository.answerWithText({
    controllerKey: fixture.controllerKey,
    userId: "7",
    chatId: "70",
    text: "answer the second question",
    now: 2_101,
  })).toMatchObject({ ok: true, complete: true });
  expect(repository.getAnswered(fixture.controllerKey)).toMatchObject({
    answers: {
      question_1: { selected: [], freeText: "answer the first question" },
      question_2: { selected: [], freeText: "answer the second question" },
    },
  });
});

it("normalizes a complete legacy free-text answer with no selected option to answered", () => {
  const fixture = legacyQuestionDatabaseFixture();
  const answers = { question_1: { selected: [], freeText: "keep this answer" } };
  fixture.insertQuestion("pending", "legacy_complete_free_text", JSON.stringify(answers));

  fixture.migrateRemaining();

  expect(fixture.db.prepare(
    "SELECT state, answer_json, answered_at FROM controller_interactions WHERE interaction_id = ?",
  ).get("legacy_complete_free_text")).toEqual({
    state: "answered",
    answer_json: JSON.stringify({ kind: "user_answer", answers }),
    answered_at: 2_000,
  });
  expect(new ControllerInteractionRepository(fixture.db).getPending(fixture.controllerKey)).toBeNull();
});

it("normalizes an answered legacy free-text answer through quarantine restoration", () => {
  const fixture = legacyQuestionDatabaseFixture();
  const answers = { question_1: { selected: [], freeText: "keep this answered text" } };
  fixture.insertQuestion("answered", "legacy_answered_free_text", JSON.stringify(answers));

  fixture.migrateRemaining();

  expect(fixture.db.prepare(
    "SELECT state, answer_json, answered_at FROM controller_interactions WHERE interaction_id = ?",
  ).get("legacy_answered_free_text")).toEqual({
    state: "answered",
    answer_json: JSON.stringify({ kind: "user_answer", answers }),
    answered_at: 2_002,
  });
});

it("quarantines an all-key legacy answer map with no substantive answer", () => {
  const fixture = legacyQuestionDatabaseFixture();
  const answers = { question_1: { selected: [] } };
  fixture.insertQuestion("pending", "legacy_empty_complete", JSON.stringify(answers));

  fixture.migrateRemaining();

  expectLegacyMigrationQuarantine(fixture);
  expect(fixture.db.prepare(
    "SELECT state, answers_json FROM controller_questions WHERE interaction_id = ?",
  ).get("legacy_empty_complete")).toEqual({ state: "delivered", answers_json: null });
  expect(fixture.db.prepare(
    "SELECT state, answer_json FROM controller_interactions WHERE interaction_id = ?",
  ).get("legacy_empty_complete")).toEqual({ state: "delivered", answer_json: null });
});

it("normalizes a complete pending legacy answer map to answered", () => {
  const fixture = legacyQuestionDatabaseFixture();
  fixture.insertQuestion(
    "pending",
    "legacy_complete_pending",
    JSON.stringify({ question_1: { selected: ["first"] } }),
  );

  fixture.migrateRemaining();

  expect(fixture.db.prepare(
    "SELECT state, answer_json, answered_at FROM controller_interactions WHERE interaction_id = ?",
  ).get("legacy_complete_pending")).toEqual({
    state: "answered",
    answer_json: JSON.stringify({
      kind: "user_answer",
      answers: { question_1: { selected: ["first"] } },
    }),
    answered_at: 2_000,
  });
  expect(new ControllerInteractionRepository(fixture.db).getPending(fixture.controllerKey)).toBeNull();
});

it("sanitizes malformed legacy JSON before migration SQL evaluates it and quarantines the original bytes", () => {
  const fixture = legacyQuestionDatabaseFixture();
  fixture.insertQuestion("pending", "legacy_malformed_questions", "{}", "{not-json");
  fixture.db.prepare(
    `INSERT INTO outbox (
       logical_key, chat_id, message_id, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, '70', NULL, ?, 'sent', 0, 2_000, 2_000, 2_000)`,
  ).run(
    "controller-interaction:legacy_malformed_questions:0",
    JSON.stringify({
      text: "unsafe legacy text",
      reply_markup: { inline_keyboard: [[{ text: "unsafe", callback_data: "unsafe" }]] },
    }),
  );

  expect(() => fixture.migrateRemaining()).not.toThrow();
  expect(fixture.db.prepare(
    "SELECT state, questions_json, answers_json FROM controller_questions WHERE interaction_id = ?",
  ).get("legacy_malformed_questions")).toEqual({
    state: "delivered",
    questions_json: "[]",
    answers_json: null,
  });
  expect(fixture.db.prepare(
    "SELECT payload_json FROM controller_interaction_quarantine WHERE source = 'controller_questions' AND interaction_id = ?",
  ).get("legacy_malformed_questions")).toEqual({ payload_json: "{not-json" });
  expect(JSON.parse((fixture.db.prepare(
    "SELECT payload_json FROM outbox WHERE logical_key = ?",
  ).get("controller-interaction:legacy_malformed_questions:0") as { payload_json: string }).payload_json)).toEqual({
    text: "This interaction is no longer available. Open BB to review it.",
    reply_markup: { inline_keyboard: [] },
    disable_web_page_preview: true,
  });
});

it("sanitizes structurally malformed legacy questions and quarantines the original bytes", () => {
  const fixture = legacyQuestionDatabaseFixture();
  const malformedQuestions = JSON.stringify({ questions: "not-an-array" });
  fixture.insertQuestion("pending", "legacy_structurally_malformed", "{}", malformedQuestions);

  fixture.migrateRemaining();

  expect(fixture.db.prepare(
    "SELECT state, questions_json FROM controller_questions WHERE interaction_id = ?",
  ).get("legacy_structurally_malformed")).toEqual({ state: "delivered", questions_json: "[]" });
  expect(fixture.db.prepare(
    "SELECT payload_json FROM controller_interaction_quarantine WHERE source = 'controller_questions' AND interaction_id = ?",
  ).get("legacy_structurally_malformed")).toEqual({ payload_json: malformedQuestions });
});

it("consumes quarantine restoration once and does not resurrect a delivered interaction after restart", () => {
  const fixture = legacyQuestionDatabaseFixture();
  fixture.insertQuestion("pending", "legacy_one_shot_restore");

  fixture.migrateRemaining();
  fixture.db.prepare(
    `UPDATE controller_interactions
        SET state = 'delivered', answer_json = NULL, delivered_at = 2_100
      WHERE interaction_id = ?`,
  ).run("legacy_one_shot_restore");
  fixture.db.prepare(
    "UPDATE outbox SET status = 'sent', updated_at = 2_100 WHERE logical_key = ?",
  ).run("controller-interaction:legacy_one_shot_restore:0");

  fixture.migrateRemaining();

  expect(fixture.db.prepare(
    "SELECT state, delivered_at FROM controller_interactions WHERE interaction_id = ?",
  ).get("legacy_one_shot_restore")).toEqual({ state: "delivered", delivered_at: 2_100 });
  expect(fixture.db.prepare(
    "SELECT consumed_at FROM controller_interaction_quarantine WHERE source = 'controller' AND interaction_id = ?",
  ).get("legacy_one_shot_restore")).toMatchObject({ consumed_at: expect.any(Number) });
  expect(fixture.db.prepare(
    "SELECT status FROM outbox WHERE logical_key = ?",
  ).get("controller-interaction:legacy_one_shot_restore:0")).toEqual({ status: "sent" });
});

it.each([
  ["pending complete free-text", { question_1: { selected: [], freeText: "restore this answer" } }, "pending", "answered"],
  ["answered complete free-text", { question_1: { selected: [], freeText: "restore this answered text" } }, "answered", "answered"],
  ["pending all-key empty", { question_1: { selected: [] } }, "pending", "delivered"],
  ["answered all-key empty", { question_1: { selected: [] } }, "answered", "delivered"],
] as const)("handles %s answer maps safely during quarantine restoration", (_label, answers, priorState, expectedState) => {
  const fixture = legacyQuestionDatabaseFixture();
  fixture.migrateRemaining();
  insertControllerQuestionQuarantine(
    fixture,
    `quarantined_${priorState}_${expectedState}`,
    JSON.stringify({ kind: "user_answer", answers }),
    priorState,
  );

  fixture.migrateRemaining();

  expect(fixture.db.prepare(
    "SELECT state, answer_json FROM controller_interactions WHERE interaction_id = ?",
  ).get(`quarantined_${priorState}_${expectedState}`)).toEqual({
    state: expectedState,
    answer_json: expectedState === "answered"
      ? JSON.stringify({ kind: "user_answer", answers })
      : null,
  });
  expect(fixture.db.prepare(
    "SELECT consumed_at FROM controller_interaction_quarantine WHERE source = 'controller' AND interaction_id = ?",
  ).get(`quarantined_${priorState}_${expectedState}`)).toMatchObject({ consumed_at: expect.any(Number) });
});

it("removes an empty keyed answer before restoring a pending quarantine interaction and delivering its final answer", () => {
  const fixture = legacyQuestionDatabaseFixture();
  insertLegacyOwner(fixture);
  const questions = JSON.parse(legacyQuestionsJson()) as Record<string, unknown>[];
  questions.push({ ...questions[0], id: "question_2", prompt: "Which fallback should I use?" });
  const interactionPayloadJson = JSON.stringify({ kind: "user_question", questions });
  fixture.migrateRemaining();
  insertControllerQuestionQuarantine(
    fixture,
    "quarantined_empty_first_partial",
    JSON.stringify({ kind: "user_answer", answers: { question_1: { selected: [] } } }),
    "pending",
    interactionPayloadJson,
  );

  fixture.migrateRemaining();

  expect(fixture.db.prepare(
    "SELECT state, answer_json FROM controller_interactions WHERE interaction_id = ?",
  ).get("quarantined_empty_first_partial")).toEqual({
    state: "pending",
    answer_json: JSON.stringify({ kind: "user_answer", answers: {} }),
  });
  const repository = new ControllerInteractionRepository(fixture.db);
  expect(repository.answerWithText({
    controllerKey: fixture.controllerKey,
    userId: "7",
    chatId: "70",
    text: "answer the first restored question",
    now: 2_100,
  })).toMatchObject({ ok: true, complete: false });
  expect(repository.answerWithText({
    controllerKey: fixture.controllerKey,
    userId: "7",
    chatId: "70",
    text: "answer the second restored question",
    now: 2_101,
  })).toMatchObject({ ok: true, complete: true });
  expect(repository.getAnswered(fixture.controllerKey)).toMatchObject({
    answers: {
      question_1: { selected: [], freeText: "answer the first restored question" },
      question_2: { selected: [], freeText: "answer the second restored question" },
    },
  });
});

it("migrates valid Unicode questions and normalizes their complete answer bytes", () => {
  const fixture = legacyQuestionDatabaseFixture();
  const questions = JSON.parse(JSON.stringify(questionPayload().questions)) as Record<string, unknown>[];
  const question = questions[0]!;
  question.id = "質問一";
  question.prompt = "どの経路を使いますか？";
  const options = question.options as Record<string, unknown>[];
  options[0]!.value = "第一経路";
  options[0]!.label = "最初";
  const partial = JSON.stringify({ "質問一": { selected: ["第一経路"], freeText: "安全な回答" } });
  fixture.insertQuestion("pending", "legacy_unicode_interaction", partial, JSON.stringify(questions));

  fixture.migrateRemaining();

  expect(fixture.db.prepare(
    "SELECT state, answer_json FROM controller_interactions WHERE interaction_id = ?",
  ).get("legacy_unicode_interaction")).toEqual({
    state: "answered",
    answer_json: JSON.stringify({
      kind: "user_answer",
      answers: { "質問一": { selected: ["第一経路"], freeText: "安全な回答" } },
    }),
  });
  expect(new ControllerInteractionRepository(fixture.db).getAnswered(fixture.controllerKey)).toMatchObject({
    answers: { "質問一": { selected: ["第一経路"], freeText: "安全な回答" } },
  });
});

it("persists the bounded runtime projection for an oversized legacy prompt", () => {
  const fixture = legacyQuestionDatabaseFixture();
  fixture.insertQuestion(
    "pending",
    "legacy_bounded_projection",
    "{}",
    legacyQuestionsJson((questions) => { questions[0]!.prompt = "x".repeat(401); }),
  );

  fixture.migrateRemaining();

  const row = fixture.db.prepare(
    "SELECT payload_json FROM controller_interactions WHERE interaction_id = ?",
  ).get("legacy_bounded_projection") as { payload_json: string };
  const payload = JSON.parse(row.payload_json) as { questions: Array<{ prompt: string }> };
  expect(payload.questions[0]?.prompt).toHaveLength(400);
});

it("copies a delivered legacy row with null source identity", () => {
  const fixture = legacyQuestionDatabaseFixture();
  fixture.insertQuestion("delivered");

  fixture.migrateRemaining();

  expect(fixture.db.prepare(
    "SELECT state, bb_thread_id, controller_generation_id, answer_json, delivered_at FROM controller_interactions",
  ).get()).toEqual({
    state: "delivered",
    bb_thread_id: null,
    controller_generation_id: null,
    answer_json: null,
    delivered_at: 2_002,
  });
});

it.each([
  ["missing current controller thread", (fixture: ReturnType<typeof legacyQuestionDatabaseFixture>) => {
    fixture.db.prepare("UPDATE controller_threads SET bb_thread_id = NULL, state = 'pending_spawn'").run();
  }],
  ["ambiguous open generation", (fixture: ReturnType<typeof legacyQuestionDatabaseFixture>) => {
    fixture.db.prepare(
      `INSERT INTO controller_generations (id, controller_key, thread_id, started_at, ended_at, end_reason)
       VALUES ('gen_legacy_ambiguous', ?, 'thr_legacy_other', 2, NULL, NULL)`,
    ).run(fixture.controllerKey);
  }],
] as const)("quarantines a legacy row with %s identity", (_name, changeSource) => {
  const fixture = legacyQuestionDatabaseFixture();
  fixture.insertQuestion("pending");
  changeSource(fixture);
  fixture.migrateRemaining();
  expectLegacyMigrationQuarantine(fixture);
});

it.each([
  ["missing current controller thread", (fixture: ReturnType<typeof legacyQuestionDatabaseFixture>) => {
    fixture.db.prepare("UPDATE controller_threads SET bb_thread_id = NULL, state = 'pending_spawn'").run();
  }],
  ["ambiguous open generation", (fixture: ReturnType<typeof legacyQuestionDatabaseFixture>) => {
    fixture.db.prepare(
      `INSERT INTO controller_generations (id, controller_key, thread_id, started_at, ended_at, end_reason)
       VALUES ('gen_legacy_ambiguous_answered', ?, 'thr_legacy_other', 2, NULL, NULL)`,
    ).run(fixture.controllerKey);
  }],
] as const)("quarantines an answered legacy row for %s identity", (_name, changeSource) => {
  const fixture = legacyQuestionDatabaseFixture();
  fixture.insertQuestion("answered", "legacy_answered_identity");
  changeSource(fixture);
  fixture.migrateRemaining();
  expectLegacyMigrationQuarantine(fixture);
});

it.each([
  ["invalid JSON", "{not-json"],
  ["unknown question", JSON.stringify({ unknown: { selected: ["first"] } })],
  ["unknown option", JSON.stringify({ question_1: { selected: ["third"] } })],
] as const)("quarantines a pending legacy row with %s answers", (_name, answersJson) => {
  const fixture = legacyQuestionDatabaseFixture();
  fixture.insertQuestion("pending", "legacy_invalid_partial", answersJson);
  fixture.migrateRemaining();
  expectLegacyMigrationQuarantine(fixture);
});

const SHELL_ASSIGNMENT_TEXTS = [
  ["a command-substitution assignment", "$(lowercase=plain-value command)"],
  ["a quoted-script assignment", "sh -c 'lowercase=plain-value command'"],
  ["an exported generic assignment", "export lowercase=plain-value"],
  ["a backtick-nested generic assignment", "sh -c `lowercase=plain-value command`"],
] as const;

const RAW_TOKEN_SIGNATURES = [
  ["AKIA access key", `AKIA${"A".repeat(16)}`],
  ["sk- token", `sk-${"A".repeat(20)}`],
  ["rk- token", `rk-${"A".repeat(20)}`],
  ...(["p", "o", "u", "s", "r"] as const).map((prefix) => [
    `GitHub gh${prefix} token`,
    `gh${prefix}_${"A".repeat(20)}`,
  ] as const),
  ["Telegram bot token", `1234567890:${"A".repeat(35)}`],
] as const;

const EMBEDDED_RAW_TOKEN_TEXTS = RAW_TOKEN_SIGNATURES.map(([name, token]) => [
  `an embedded ${name}`,
  `prefix${token}suffix`,
] as const);

const SHELL_ASSIGNMENT_LEGACY_PROJECTIONS = SHELL_ASSIGNMENT_TEXTS.flatMap(([name, unsafeText]) => [
  [`${name} in the prompt`, "pending", legacyQuestionsJson((questions) => { questions[0]!.prompt = unsafeText; }), "{}"],
  [`${name} in the option label`, "pending", legacyQuestionsJson((questions) => {
    const options = questions[0]!.options as Record<string, unknown>[];
    options[0]!.label = unsafeText;
  }), "{}"],
  [`${name} in the option value`, "pending", legacyQuestionsJson((questions) => {
    const options = questions[0]!.options as Record<string, unknown>[];
    options[0]!.value = unsafeText;
  }), "{}"],
  [`${name} in owner free text`, "pending", legacyQuestionsJson(), JSON.stringify({
    question_1: { selected: [], freeText: unsafeText },
  })],
] as const);

const RAW_TOKEN_LEGACY_PROJECTIONS = [...RAW_TOKEN_SIGNATURES, ...EMBEDDED_RAW_TOKEN_TEXTS].map(([name, unsafeText]) => [
  name,
  "pending",
  legacyQuestionsJson((questions) => { questions[0]!.prompt = unsafeText; }),
  "{}",
] as const);

const INVALID_LEGACY_PROJECTIONS = [
  ...SHELL_ASSIGNMENT_LEGACY_PROJECTIONS,
  ...RAW_TOKEN_LEGACY_PROJECTIONS,
  ["missing prompt", "pending", legacyQuestionsJson((questions) => { delete questions[0]!.prompt; }), "{}"],
  ["empty question list", "pending", "[]", "{}"],
  ["too many questions", "pending", legacyQuestionsJson((questions) => {
    for (let index = 2; index <= 5; index += 1) questions.push({ ...questions[0], id: `question_${index}` });
  }), "{}"],
  ["duplicate question id", "pending", legacyQuestionsJson((questions) => { questions.push({ ...questions[0] }); }), "{}"],
  ["reserved question id", "pending", legacyQuestionsJson((questions) => { questions[0]!.id = "__proto__"; }), "{}"],
  ["too many options", "pending", legacyQuestionsJson((questions) => {
    const options = questions[0]!.options as unknown[];
    options.push(...options, ...options, ...options, ...options);
  }), "{}"],
  ["duplicate option value", "pending", legacyQuestionsJson((questions) => {
    const options = questions[0]!.options as Record<string, unknown>[];
    options[1]!.value = options[0]!.value;
  }), "{}"],
  ["invalid boolean type", "pending", legacyQuestionsJson((questions) => { questions[0]!.multiSelect = "false"; }), "{}"],
  ["invalid option type", "pending", legacyQuestionsJson((questions) => {
    const options = questions[0]!.options as Record<string, unknown>[];
    options[0]!.label = 7;
  }), "{}"],
  ["unsafe projection text", "pending", legacyQuestionsJson((questions) => { questions[0]!.prompt = "access_token=secret-value"; }), "{}"],
  ["NFKC secret assignment", "pending", legacyQuestionsJson((questions) => { questions[0]!.prompt = "ＡＰＩ＿ＫＥＹ＝secret-value"; }), "{}"],
  ["unsafe option text", "pending", legacyQuestionsJson((questions) => {
    const options = questions[0]!.options as Record<string, unknown>[];
    options[0]!.description = "https://inner.test/?private_key=secret-value";
  }), "{}"],
  ["boundaryless raw callback nonce", "pending", legacyQuestionsJson((questions) => {
    questions[0]!.prompt = `prefixxm:${"A".repeat(32)}suffix`;
  }), "{}"],
  ["raw token material", "pending", legacyQuestionsJson((questions) => {
    questions[0]!.prompt = `ghp_${"A".repeat(20)}`;
  }), "{}"],
  ["raw credential URL", "pending", legacyQuestionsJson((questions) => {
    const options = questions[0]!.options as Record<string, unknown>[];
    options[0]!.value = "https://user:pass@example.test/inner";
  }), "{}"],
  ["nested credential URL", "pending", legacyQuestionsJson((questions) => {
    questions[0]!.prompt = `https://outer.test/?next=${encodeURIComponent("https://inner.test/?token=secret-value")}`;
  }), "{}"],
  ["standalone auth query", "pending", legacyQuestionsJson((questions) => { questions[0]!.prompt = "https://example.test/?auth=abc"; }), "{}"],
  ["standalone session query", "pending", legacyQuestionsJson((questions) => { questions[0]!.prompt = "https://example.test/?session=abc"; }), "{}"],
  ["standalone private query", "pending", legacyQuestionsJson((questions) => { questions[0]!.prompt = "https://example.test/?private=abc"; }), "{}"],
  ["standalone key query", "pending", legacyQuestionsJson((questions) => { questions[0]!.prompt = "https://example.test/?key=abc"; }), "{}"],
  ["standalone credential query", "pending", legacyQuestionsJson((questions) => { questions[0]!.prompt = "https://example.test/?credential=abc"; }), "{}"],
  ["invalid selected shape", "pending", legacyQuestionsJson(), JSON.stringify({ question_1: { selected: "first" } })],
  ["duplicate selected option", "pending", legacyQuestionsJson(), JSON.stringify({ question_1: { selected: ["first", "first"] } })],
  ["unknown answer field", "pending", legacyQuestionsJson(), JSON.stringify({ question_1: { selected: [], note: "unexpected" } })],
  ["unsafe answer text", "pending", legacyQuestionsJson(), JSON.stringify({ question_1: { selected: [], freeText: "m:" + "A".repeat(32) } })],
  ["malformed percent projection", "pending", legacyQuestionsJson((questions) => { questions[0]!.prompt = "echo %ZZ"; }), "{}"],
  ["encoded callback option", "pending", legacyQuestionsJson((questions) => {
    const options = questions[0]!.options as Record<string, unknown>[];
    options[0]!.label = "https%3A%2F%2Fexample.test%2Fcallback";
  }), "{}"],
  ["nested encoded answer", "pending", legacyQuestionsJson(), JSON.stringify({
    question_1: { selected: [], freeText: percentEncodeLayers("https://inner.test/?token=abc", 2) },
  })],
  ["residual percent projection", "pending", legacyQuestionsJson((questions) => { questions[0]!.prompt = "safe%25"; }), "{}"],
  ["excess percent projection", "pending", legacyQuestionsJson((questions) => {
    questions[0]!.prompt = percentEncodeLayers("safe value", 4);
  }), "{}"],
  ["incomplete answered map", "answered", legacyQuestionsJson((questions) => {
    questions.push({ ...questions[0], id: "question_2" });
  }), JSON.stringify({ question_1: { selected: ["first"] } })],
  ["canonical duplicate question id", "pending", JSON.stringify([
    { ...questionPayloadQuestion(), id: "Ｆirst" },
    { ...questionPayloadQuestion(), id: "First" },
  ]), "{}"],
  ["canonical duplicate option value", "pending", legacyQuestionsJson((questions) => {
    const options = questions[0]!.options as Record<string, unknown>[];
    options[0]!.value = "Ｆirst";
    options[1]!.value = "First";
  }), "{}"],
  ["oversized question id", "pending", legacyQuestionsJson((questions) => {
    questions[0]!.id = "q".repeat(129);
  }), "{}"],
] as const;

it.each(INVALID_LEGACY_PROJECTIONS)(
  "quarantines an active legacy row with %s",
  (_name, state, questionsJson, answersJson) => {
    const fixture = legacyQuestionDatabaseFixture();
    fixture.insertQuestion(state, "legacy_invalid_projection", answersJson, questionsJson);
    fixture.migrateRemaining();
    expectLegacyMigrationQuarantine(fixture);
  },
);

const INVALID_LEGACY_INTERACTION_IDS = [
  ["a null interaction id", null],
  ["an empty interaction id", ""],
  // A BLOB is the closest faithful non-string corruption because TEXT affinity coerces numeric inserts.
  ["a non-string BLOB interaction id", Buffer.from("legacy_non_string")],
  ["an oversized interaction id", "i".repeat(257)],
] as const;

it.each(INVALID_LEGACY_INTERACTION_IDS)(
  "quarantines %s without creating callback authority",
  (_name, interactionId) => {
    const fixture = legacyQuestionDatabaseFixture();
    fixture.insertQuestion("pending", interactionId);
    fixture.migrateRemaining();
    expectLegacyMigrationQuarantine(fixture);
  },
);

it("preserves a valid pending legacy row without an answer map", () => {
  const fixture = legacyQuestionDatabaseFixture();
  fixture.insertQuestion("pending", "legacy_missing_pending_answers", null);
  fixture.migrateRemaining();
  expect(fixture.db.prepare(
    "SELECT state, answer_json FROM controller_interactions WHERE interaction_id = ?",
  ).get("legacy_missing_pending_answers")).toEqual({ state: "pending", answer_json: null });
  expect(fixture.db.prepare(
    "SELECT COUNT(*) AS count FROM controller_interaction_quarantine WHERE source = 'controller_questions'",
  ).get()).toEqual({ count: 0 });
});

it("rolls back a nested tail failure after the exact legacy preflight", () => {
  const fixture = legacyQuestionDatabaseFixture();
  fixture.insertQuestion("pending", "legacy_nested_failure", "{}", "{not-json");
  const originalRows = fixture.legacyRows();
  const originalMigrate = fixture.bb.storage.migrate.bind(fixture.bb.storage);
  fixture.bb.storage.migrate = (database, statements) => {
    const failingStatements = statements.length === ALL_MIGRATIONS.length
      ? [...statements.slice(0, -1), `${statements.at(-1)}\nSELECT missing_nested_migration_table;`]
      : statements;
    originalMigrate(database, failingStatements);
  };

  expect(() => migrateControllerInteractionStorage(fixture.bb.storage)).toThrow();
  expectLegacyMigrationRollback(fixture, originalRows);
});

it("projects only safe controller approval decisions", () => {
  expect(parseControllerInteraction("approval_1", approvalPayload())).toEqual({
    kind: "approval",
    interactionId: "approval_1",
    summary: "wants to run:\n\n`npm test`\n\nin project",
    decisions: ["allow_once", "deny"],
  });
});

it("fails closed for the provider-shaped absolute approval paths without an authoritative project root", () => {
  const payload = {
    kind: "approval",
    subject: {
      kind: "command",
      itemId: "bb-item-absolute-path",
      command: "git status",
      cwd: "/srv/bb/projects/controller",
      actions: [{
        type: "read",
        command: "cat /srv/bb/projects/controller/README.md",
        name: "README.md",
        path: "/srv/bb/projects/controller/README.md",
      }],
      sessionGrant: null,
    },
    reason: "provider approval request",
    availableDecisions: ["allow_once", "deny"],
  };

  const projection = parseControllerInteraction("provider_absolute_path", payload);
  expect(projection).toEqual(unsupportedProjection("provider_absolute_path", "approval"));
  expect(JSON.stringify(projection)).not.toContain("/srv/bb/projects/controller");
});

it.each([
  ["legacy-only decisions", { decisions: ["allow_once", "deny"] }],
  ["a malformed canonical field", { availableDecisions: "allow_once", decisions: ["allow_once", "deny"] }],
  ["conflicting canonical and legacy fields", {
    availableDecisions: ["allow_once"],
    decisions: ["deny"],
  }],
  ["a non-string canonical decision", { availableDecisions: ["allow_once", 7] }],
] as const)("rejects %s without a valid canonical availableDecisions array", (_name, overrides) => {
  expect(parseControllerInteraction("approval_decision_boundary", approvalPayload(overrides)))
    .toEqual(unsupportedProjection("approval_decision_boundary", "approval"));
});

it.each([
  ["a lowercase plain assignment", "lowercase=plain-value"],
  ["a lowercase single-quoted assignment", "lowercase='quoted value'"],
  ["a lowercase double-quoted assignment", 'lowercase="quoted value"'],
  ["an empty generic assignment", "lowercase="],
  ...SHELL_ASSIGNMENT_TEXTS,
  ...EMBEDDED_RAW_TOKEN_TEXTS,
  ["an embedded callback nonce", `prefixxm:${"A".repeat(32)}suffix`],
] as const)("rejects %s at every controller text boundary", (_name, unsafeText) => {
  const commandProjection = parseControllerInteraction("boundary_command", approvalPayload({
    subject: { kind: "command", command: `run ${unsafeText}`, cwd: "/workspace/project" },
  }));
  expect(commandProjection).toEqual(unsupportedProjection("boundary_command", "approval"));

  const questionProjection = parseControllerInteraction("boundary_question", questionPayload(unsafeText));
  expect(questionProjection).toEqual(unsupportedProjection("boundary_question", "user_question"));

  for (const [field, interactionId] of [["label", "boundary_option_label"], ["value", "boundary_option_value"]] as const) {
    const optionPayload = questionPayload();
    const optionQuestion = optionPayload.questions as Record<string, unknown>[];
    const optionList = optionQuestion[0]!.options as Record<string, unknown>[];
    optionList[0]![field] = unsafeText;
    const optionProjection = parseControllerInteraction(interactionId, optionPayload);
    expect(optionProjection).toEqual(unsupportedProjection(interactionId, "user_question"));
  }

  const fixture = currentInteractionFixture();
  const interaction = controllerInteraction("boundary_owner_text");
  expect(fixture.repository.record(recordInput(fixture, interaction))).toBe("recorded");
  expect(fixture.repository.answerWithText({
    controllerKey: fixture.controllerKey,
    userId: "7",
    chatId: "70",
    text: unsafeText,
    now: 2_100,
  })).toEqual({ ok: false, reason: "stale" });
  expect(fixture.db.prepare("SELECT state, answer_json FROM controller_interactions WHERE interaction_id = ?")
    .get(interaction.interactionId)).toEqual({ state: "pending", answer_json: null });
  closeCurrentFixture(fixture);
});

it.each([
  ["a credential in the middle of the command", "echo before API_KEY=secret-value && echo after"],
  ["callback-shaped command material", "curl --callback https://example.test/hook?token=secret-value"],
  ["a percent-encoded callback", "curl https%3A%2F%2Fexample.test%2Fcallback%3Ftoken%3Dsecret-value"],
  ["a percent-encoded credential URL", "open https%3A%2F%2Fuser%3Apass%40example.test"],
  ["a Unicode-normalized secret assignment", "ＰＡＳＳＷＯＲＤ＝secret-value"],
  ["a shell environment assignment", "FOO=bar npm test"],
] as const)("makes %s non-actionable", (_name, command) => {
  const projection = parseControllerInteraction("approval_secret", approvalPayload({
    subject: {
      kind: "command",
      itemId: "item_1",
      command,
      cwd: "/workspace/project",
      actions: [{ type: "unknown", command: "API_TOKEN=secret" }],
      env: { API_TOKEN: "secret" },
      output: "secret output",
    },
  }));
  expect(projection).toEqual(unsupportedProjection("approval_secret", "approval"));
  expect(JSON.stringify(projection)).not.toContain("before");
  expect(JSON.stringify(projection)).not.toContain("after");
  expect(JSON.stringify(projection)).not.toContain("secret-value");
  expect(JSON.stringify(projection)).not.toContain("API_TOKEN");
  expect(JSON.stringify(projection)).not.toContain("secret output");
});

it.each([
  ["Base64 of percent-encoded credentials", Buffer.from(encodeURIComponent("API_KEY=secret-value"), "utf8").toString("base64")],
  ["nested Base64url of Unicode-normalized credentials", Buffer.from("ＰＡＳＳＷＯＲＤ＝secret-value", "utf8").toString("base64url")],
] as const)("recursively rejects %s", (_name, encodedCommand) => {
  const projection = parseControllerInteraction("approval_nested_encoding", approvalPayload({
    subject: { kind: "command", command: `printf ${encodedCommand}`, cwd: "/workspace/project" },
  }));
  expect(projection).toEqual(unsupportedProjection("approval_nested_encoding", "approval"));
});

it("fails closed when another textual secret layer remains at the encoding depth cap", () => {
  let encoded = "API_KEY=secret-value";
  for (let depth = 0; depth < 5; depth += 1) encoded = Buffer.from(encoded, "utf8").toString("base64url");
  expect(parseControllerInteraction("approval_encoding_depth_cap", approvalPayload({
    subject: { kind: "command", command: `printf ${encoded}`, cwd: "project" },
  }))).toEqual(unsupportedProjection("approval_encoding_depth_cap", "approval"));
});

it("fails closed when nested Unicode escapes remain at the encoding depth cap", () => {
  let encoded = "API_KEY=secret-value";
  for (let depth = 0; depth < 5; depth += 1) encoded = unicodeEscapeLayer(encoded);
  expect(parseControllerInteraction("approval_unicode_depth_cap", approvalPayload({
    subject: { kind: "command", command: `printf ${encoded}`, cwd: "project" },
  }))).toEqual(unsupportedProjection("approval_unicode_depth_cap", "approval"));
});

it("keeps an opaque UUID command actionable while scanning encoded text", () => {
  expect(parseControllerInteraction("approval_uuid", approvalPayload({
    subject: {
      kind: "command",
      command: "echo 550e8400-e29b-41d4-a716-446655440000",
      cwd: "project",
    },
  }))).toMatchObject({ kind: "approval" });
});

it.each([
  ["an absolute workspace path", "cat /workspace/project/README.md"],
  ["a private path", "cat /private/data/report.txt"],
  ["a private filename", "cat .env"],
  ["a traversal path", "cat ../notes.txt"],
  ["a Windows absolute path", String.raw`type C:\workspace\project\README.md`],
] as const)("rejects %s in an approval command without rewriting its identity", (_name, command) => {
  const projection = parseControllerInteraction("approval_command_path", approvalPayload({
    subject: { kind: "command", command, cwd: "/workspace/project" },
  }));
  expect(projection).toEqual(unsupportedProjection("approval_command_path", "approval"));
  expect(JSON.stringify(projection)).not.toContain(command);
});

it.each([
  ["an absolute cwd", { kind: "command", command: "npm test", cwd: "/workspace/project" }],
  ["a private cwd", { kind: "command", command: "npm test", cwd: "/private/workspace" }],
  ["a relative private cwd", { kind: "command", command: "npm test", cwd: "private/workspace" }],
  ["a traversal cwd", { kind: "command", command: "npm test", cwd: "../private" }],
  ["an absolute write scope", { kind: "file_change", writeScope: "/workspace/project/src/index.ts" }],
  ["a private write scope", { kind: "file_change", writeScope: "/workspace/.env" }],
  ["a relative private write scope", { kind: "file_change", writeScope: "private/credentials.json" }],
  ["a session grant attached to a command", {
    kind: "command",
    command: "npm test",
    cwd: "project",
    sessionGrant: { network: null, fileSystem: null },
  }],
  ["a hidden absolute path field", {
    kind: "file_change",
    writeScope: "src",
    path: "/workspace/.env",
  }],
  ["an attached redirect", { kind: "command", command: "echo hi 2>/tmp/output", cwd: "project" }],
  ["an attached traversal redirect", { kind: "command", command: "echo hi >../output", cwd: "project" }],
  ["an option-attached relative cwd", { kind: "command", command: "npm test --cwd=project", cwd: "project" }],
] as const)("does not expose buttons for %s", (_name, subject) => {
  const projection = parseControllerInteraction("approval_strict_identity", approvalPayload({ subject }));
  expect(projection).toEqual(unsupportedProjection("approval_strict_identity", "approval"));
});

it("shows exact safe relative approval paths without basename rewriting", () => {
  expect(parseControllerInteraction("approval_relative_path", {
    kind: "approval",
    subject: { kind: "file_change", itemId: "file_1", writeScope: "src/index.ts" },
    availableDecisions: ["allow_once", "deny"],
  })).toEqual({
    kind: "approval",
    interactionId: "approval_relative_path",
    summary: "wants to write files under src/index.ts",
    decisions: ["allow_once", "deny"],
  });
});

it.each([
  ["a raw callback nonce", `printf m:${"A".repeat(32)}`],
  ["a once-encoded callback nonce", `printf ${percentEncodeLayers(`m:${"A".repeat(32)}`, 1)}`],
  ["a deeply encoded callback nonce", `printf ${percentEncodeLayers(`m:${"A".repeat(32)}`, 3)}`],
  ...SENSITIVE_QUERY_KEYS.map((key) => [`the ${key} credential query`, `open https://example.test/?${key}=secret-value`] as const),
  ["a nested credential URL", `open https://outer.test/?next=${encodeURIComponent("https://inner.test/?client_secret=secret-value")}`],
  ["a lowercase quoted assignment", "run secret='secret-value'"],
  ["a lowercase double-quoted assignment", 'run api_key="secret-value"'],
  ...RAW_TOKEN_SIGNATURES.map(([name, token]) => [`a standalone ${name}`, `run ${token}`] as const),
] as const)("makes %s non-actionable before clipping", (_name, command) => {
  const projection = parseControllerInteraction("approval_vocabulary", approvalPayload({
    subject: { kind: "command", command, cwd: "/workspace/project" },
  }));
  expect(projection).toEqual(unsupportedProjection("approval_vocabulary", "approval"));
  expect(JSON.stringify(projection)).not.toContain("secret-value");
});

it.each([
  ["malformed percent encoding", "echo %ZZ"],
  ["residual percent encoding", "echo%20safe%25"],
  ["excess percent encoding", `printf ${percentEncodeLayers(`m:${"A".repeat(32)}`, 4)}`],
] as const)("fails closed on %s", (_name, command) => {
  const projection = parseControllerInteraction("approval_bad_percent", approvalPayload({
    subject: { kind: "command", command, cwd: "/workspace/project" },
  }));
  expect(projection).toEqual(unsupportedProjection("approval_bad_percent", "approval"));
});

it("makes a command with credential material beyond the bounded summary non-actionable", () => {
  const command = `${"echo safe ".repeat(60)} API_KEY=secret-value`;
  const projection = parseControllerInteraction("approval_late_secret", approvalPayload({
    subject: { kind: "command", command, cwd: "/workspace/project" },
  }));
  expect(projection).toEqual(unsupportedProjection("approval_late_secret", "approval"));
  expect(JSON.stringify(projection)).not.toContain("secret-value");
});

it("does not offer buttons when an otherwise safe command cannot be shown losslessly", () => {
  const command = "printf safe ".repeat(80);
  expect(parseControllerInteraction("approval_clipped", approvalPayload({
    subject: { kind: "command", command, cwd: "/workspace/project" },
  }))).toEqual(unsupportedProjection("approval_clipped", "approval"));
  expect(parseControllerInteraction("approval_wrapper_clipped", approvalPayload({
    subject: { kind: "command", command: "x".repeat(390) },
  }))).toEqual(unsupportedProjection("approval_wrapper_clipped", "approval"));
});

it.each([
  ["the filesystem root", "/"],
  ["an absolute workspace path", "/workspace/project/src/index.ts"],
  ["a traversal to a secret file", "../../.env"],
  ["a credentials suffix", "/workspace/credentials.json"],
  ["a local environment file", "/workspace/.env.local"],
  ["a private key suffix", "/workspace/private-key.txt"],
  ["the shadow password file", "/etc/shadow"],
  ["an Ed25519 private key", "/workspace/.ssh/id_ed25519"],
  ["an ECDSA private key", "/workspace/.ssh/id_ecdsa"],
  ["a DSA private key", "/workspace/.ssh/id_dsa"],
  ["an SSH host key", "/etc/ssh/ssh_host_rsa_key"],
  ["an SSH host certificate", "/etc/ssh/ssh_host_rsa_key-cert"],
  ["a certificate file", "/workspace/client.crt"],
] as const)("does not expose a lossy projection for %s", (_name, writeScope) => {
  const projection = parseControllerInteraction("approval_path", {
    kind: "approval",
    subject: { kind: "file_change", itemId: "file_1", writeScope, sessionGrant: null },
    availableDecisions: ["allow_once", "deny"],
  });
  expect(projection).toEqual(unsupportedProjection("approval_path", "approval"));
});

it.each([
  ["missing decisions", { kind: "approval", subject: { kind: "command", command: "npm test" } }],
  ["session-only decisions", approvalPayload({ availableDecisions: ["allow_for_session"] })],
  ["unknown subject shape", approvalPayload({ subject: { kind: "permission_grant" } })],
  ["empty question", { kind: "user_question", questions: [] }],
] as const)("returns an unsupported projection for %s", (_name, payload) => {
  expect(parseControllerInteraction("unsupported_1", payload)).toEqual(
    unsupportedProjection("unsupported_1", payload.kind === "user_question" ? "user_question" : "approval"),
  );
});

it("bounds oversized question values without persisting unbounded text", () => {
  const projection = parseControllerInteraction("question_oversized", questionPayload("x".repeat(401)));
  expect(projection).toMatchObject({ kind: "user_question" });
  if (!projection || projection.kind !== "user_question") return;
  expect(projection.questions[0]?.prompt).toHaveLength(400);
});

it.each([
  ["a callback in the prompt", questionPayload("please visit https%3A%2F%2Fexample.test%2Fcallback")],
  ["a secret in an option label", {
    ...questionPayload(),
    questions: [{ ...questionPayloadQuestion(), options: [{ value: "first", label: "API_KEY=secret", description: null }] }],
  }],
  ["a credential in an option value", {
    ...questionPayload(),
    questions: [{ ...questionPayloadQuestion(), options: [{ value: "https%3A%2F%2Fuser%3Apass%40host", label: "First", description: null }] }],
  }],
] as const)("makes %s an unsupported projection", (_name, payload) => {
  expect(parseControllerInteraction("unsafe_question", payload)).toEqual(
    unsupportedProjection("unsafe_question", "user_question"),
  );
});

it.each([
  ["a sensitive question id", { ...questionPayload(), questions: [{ ...questionPayloadQuestion(), id: `m:${"A".repeat(32)}` }] }],
  ["a sensitive short label", { ...questionPayload(), questions: [{ ...questionPayloadQuestion(), shortLabel: "access_token='secret'" }] }],
  ["a sensitive option description", {
    ...questionPayload(),
    questions: [{ ...questionPayloadQuestion(), options: [{ value: "first", label: "First", description: "https://inner.test/?private_key=secret" }] }],
  }],
  ["a missing options array that also disallows free text", {
    ...questionPayload(),
    questions: [{ ...questionPayloadQuestion(), allowFreeText: false, options: undefined }],
  }],
  ["an invalid multi-select type", {
    ...questionPayload(),
    questions: [{ ...questionPayloadQuestion(), multiSelect: "false" }],
  }],
  ["an invalid free-text type", {
    ...questionPayload(),
    questions: [{ ...questionPayloadQuestion(), allowFreeText: "true" }],
  }],
  ["an empty option description", {
    ...questionPayload(),
    questions: [{ ...questionPayloadQuestion(), options: [{ value: "first", label: "First", description: "" }] }],
  }],
  ["a malformed percent option value", {
    ...questionPayload(),
    questions: [{ ...questionPayloadQuestion(), options: [{ value: "%ZZ", label: "First", description: null }] }],
  }],
] as const)("makes %s an unsupported projection across all question fields", (_name, payload) => {
  expect(parseControllerInteraction("unsafe_question_field", payload)).toEqual(
    unsupportedProjection("unsafe_question_field", "user_question"),
  );
});

it("accepts an SDK-valid free-text-only question without options", () => {
  const payload = questionPayload();
  const questions = payload.questions as Record<string, unknown>[];
  delete questions[0]!.options;
  expect(parseControllerInteraction("free_text_only", payload)).toEqual({
    kind: "user_question",
    interactionId: "free_text_only",
    questions: [{
      id: "question_1",
      prompt: "Which option should I use?",
      shortLabel: "Choose",
      multiSelect: false,
      allowFreeText: true,
      options: [],
    }],
  });
});

it("stores unsafe questions only as an unsupported projection", () => {
  const fixture = currentInteractionFixture();
  const unsafe: ControllerInteraction = {
    kind: "user_question",
    interactionId: "unsafe_persisted_question",
    questions: [{
      id: "question_1",
      prompt: "callback https://example.test/hook",
      shortLabel: null,
      multiSelect: false,
      allowFreeText: true,
      options: [{ value: "first", label: "First", description: null }],
    }],
  };
  expect(fixture.repository.record(recordInput(fixture, unsafe))).toBe("recorded");
  expect(fixture.repository.getPending(fixture.controllerKey)).toMatchObject({
    interaction: { kind: "unsupported", interactionId: unsafe.interactionId },
  });
  expect(fixture.db.prepare("SELECT payload_json FROM controller_interactions WHERE interaction_id = ?")
    .get(unsafe.interactionId)).toMatchObject({ payload_json: expect.not.stringContaining("https://example.test/hook") });
  closeCurrentFixture(fixture);
});

it("does not write unsafe owner text but keeps ordinary bounded text supported", () => {
  const fixture = currentInteractionFixture();
  const interaction = controllerInteraction("unsafe_owner_text");
  expect(fixture.repository.record(recordInput(fixture, interaction))).toBe("recorded");

  expect(fixture.repository.answerWithText({
    controllerKey: fixture.controllerKey,
    userId: "7",
    chatId: "70",
    text: "ＡＰＩ＿ＫＥＹ＝secret-value",
    now: 2_100,
  })).toEqual({ ok: false, reason: "stale" });
  expect(fixture.db.prepare("SELECT state, answer_json FROM controller_interactions WHERE interaction_id = ?")
    .get(interaction.interactionId)).toEqual({ state: "pending", answer_json: null });

  expect(fixture.repository.answerWithText({
    controllerKey: fixture.controllerKey,
    userId: "7",
    chatId: "70",
    text: "use the first route",
    now: 2_101,
  })).toMatchObject({ ok: true, complete: true });
  closeCurrentFixture(fixture);
});

it.each([
  "m:" + "A".repeat(32),
  "access_token=secret-value",
  "echo%20safe%25",
] as const)("does not persist unsafe owner free text: %s", (text) => {
  const fixture = currentInteractionFixture();
  const interaction = controllerInteraction(`unsafe_owner_${text.slice(0, 8)}`);
  expect(fixture.repository.record(recordInput(fixture, interaction))).toBe("recorded");

  expect(fixture.repository.answerWithText({
    controllerKey: fixture.controllerKey,
    userId: "7",
    chatId: "70",
    text,
    now: 2_100,
  })).toEqual({ ok: false, reason: "stale" });
  expect(fixture.db.prepare("SELECT state, answer_json FROM controller_interactions WHERE interaction_id = ?")
    .get(interaction.interactionId)).toEqual({ state: "pending", answer_json: null });
  closeCurrentFixture(fixture);
});

it.each([
  ["a corrupt approval envelope", "approval", JSON.stringify({ decision: "allow_once", grantedPermissions: "all" })],
  ["a corrupt question answer", "question", JSON.stringify({ kind: "user_answer", answers: { question_1: { selected: ["unknown"] } } })],
] as const)("fails closed on %s when reading persisted answers", (_name, kind, answerJson) => {
  const fixture = currentInteractionFixture();
  const interaction = controllerInteraction(`corrupt_${kind}`, kind === "approval" ? "approval" : "user_question");
  expect(fixture.repository.record(recordInput(fixture, interaction))).toBe("recorded");
  fixture.db.prepare(
    "UPDATE controller_interactions SET state = 'answered', answer_json = ?, answered_at = ? WHERE interaction_id = ?",
  ).run(answerJson, 2_100, interaction.interactionId);
  expect(fixture.repository.getAnswered(fixture.controllerKey)).toBeNull();
  closeCurrentFixture(fixture);
});

it.each(["__proto__", "constructor", "prototype", "toString"] as const)(
  "rejects a prototype-reserved question id: %s",
  (questionId) => {
    const payload = questionPayload();
    payload.questions = [{ ...questionPayloadQuestion(), id: questionId }];
    expect(parseControllerInteraction(`reserved_${questionId}`, payload)).toEqual(
      unsupportedProjection(`reserved_${questionId}`, "user_question"),
    );
  },
);

it("uses own answer fields and requires a complete map for answered questions", () => {
  const fixture = currentInteractionFixture();
  const base = controllerInteraction("state_aware_answers");
  if (base.kind !== "user_question") throw new Error("question fixture has the wrong kind");
  const interaction: ControllerInteraction = {
    ...base,
    questions: [
      base.questions[0]!,
      { ...base.questions[0]!, id: "question_2", prompt: "Which second option should I use?" },
    ],
  };
  expect(fixture.repository.record(recordInput(fixture, interaction))).toBe("recorded");

  const partial = { kind: "user_answer", answers: { question_1: { selected: ["first"] } } };
  expect(parseControllerInteractionResolution(interaction, partial, "pending")).not.toBeNull();
  expect(parseControllerInteractionResolution(interaction, partial, "answered")).toBeNull();
  fixture.db.prepare(
    "UPDATE controller_interactions SET state = 'answered', answer_json = ?, answered_at = ? WHERE interaction_id = ?",
  ).run(JSON.stringify(partial), 2_100, interaction.interactionId);
  expect(fixture.repository.getAnswered(fixture.controllerKey)).toBeNull();

  const complete = {
    kind: "user_answer",
    answers: {
      question_1: { selected: ["first"] },
      question_2: { selected: ["second"] },
    },
  };
  fixture.db.prepare("UPDATE controller_interactions SET answer_json = ? WHERE interaction_id = ?")
    .run(JSON.stringify(complete), interaction.interactionId);
  expect(fixture.repository.getAnswered(fixture.controllerKey)).toMatchObject({
    answers: complete.answers,
    resolution: complete,
  });

  const inheritedAnswer = Object.create({ selected: [] }) as Record<string, unknown>;
  expect(parseControllerInteractionResolution(interaction, {
    kind: "user_answer",
    answers: { question_1: inheritedAnswer, question_2: { selected: ["second"] } },
  }, "pending")).toBeNull();
  closeCurrentFixture(fixture);
});

it("records one identity and keeps an older interaction as the pointer", () => {
  const fixture = currentInteractionFixture();
  const first = controllerInteraction("interaction_first");
  const second = controllerInteraction("interaction_second", "approval");

  expect(fixture.repository.record(recordInput(fixture, first, 2_000))).toBe("recorded");
  expect(fixture.repository.record(recordInput(fixture, second, 2_001))).toBe("recorded");
  expect(fixture.repository.record(recordInput(fixture, first, 2_002))).toBe("replay");
  expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM controller_interactions").get()).toEqual({ count: 2 });
  expect(fixture.db.prepare("SELECT awaiting_interaction_id FROM controller_turns WHERE id = ?").get(fixture.turnId))
    .toEqual({ awaiting_interaction_id: "interaction_first" });
  expect(fixture.repository.getPending(fixture.controllerKey)).toMatchObject({ interactionId: "interaction_first" });
  closeCurrentFixture(fixture);
});

it("rejects a reused interaction id with a different source identity", () => {
  const fixture = currentInteractionFixture();
  const interaction = controllerInteraction("interaction_reused");
  expect(fixture.repository.record(recordInput(fixture, interaction))).toBe("recorded");
  expect(fixture.repository.record({
    ...recordInput(fixture, interaction),
    bbThreadId: "thr_other",
    controllerGenerationId: "gen_other",
  })).toBe("stale");
  expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM controller_interactions").get()).toEqual({ count: 1 });
  closeCurrentFixture(fixture);
});

it("distinguishes exact replay, stale fencing, and a conflicting source identity", () => {
  const fixture = currentInteractionFixture();
  const interaction = controllerInteraction("interaction_identity_outcomes");

  expect(fixture.repository.record(recordInput(fixture, interaction))).toBe("recorded");
  expect(fixture.repository.record(recordInput(fixture, interaction, CURRENT_NOW + 1))).toBe("replay");
  expect(fixture.repository.record({
    ...recordInput(fixture, controllerInteraction("interaction_stale_identity")),
    generation: CURRENT_GENERATION + 1,
  })).toBe("stale");

  fixture.db.prepare(
    "UPDATE controller_generations SET ended_at = ?, end_reason = ? WHERE id = ?",
  ).run(CURRENT_NOW + 2, "takeover", fixture.generationId);
  fixture.db.prepare(
    `INSERT INTO controller_generations (id, controller_key, thread_id, started_at, ended_at, end_reason)
     VALUES (?, ?, ?, ?, NULL, NULL)`,
  ).run("gen_controller_2", fixture.controllerKey, "thr_controller_2", CURRENT_NOW + 2);
  fixture.db.prepare(
    "UPDATE controller_threads SET bb_thread_id = ? WHERE controller_key = ?",
  ).run("thr_controller_2", fixture.controllerKey);

  expect(fixture.repository.record({
    ...recordInput(fixture, interaction, CURRENT_NOW + 3),
    bbThreadId: "thr_controller_2",
    controllerGenerationId: "gen_controller_2",
  })).toBe("conflict");
  expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM controller_interactions").get()).toEqual({ count: 1 });
  closeCurrentFixture(fixture);
});

it.each([
  ["stale executor generation", { generation: CURRENT_GENERATION + 1 }],
  ["wrong BB thread", { bbThreadId: "thr_other" }],
  ["wrong open generation", { controllerGenerationId: "gen_other" }],
  ["wrong submitted turn", { turnId: "turn_other" }],
] as const)("does not record with %s", (_name, override) => {
  const fixture = currentInteractionFixture();
  expect(fixture.repository.record({
    ...recordInput(fixture, controllerInteraction("interaction_stale")),
    ...override,
  })).toBe("stale");
  expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM controller_interactions").get()).toEqual({ count: 0 });
  closeCurrentFixture(fixture);
});

it("requires the submitted turn to adopt the executor lease before recording", () => {
  const fixture = currentInteractionFixture();
  fixture.db.prepare(
    "UPDATE controller_turns SET lease_owner = 'successor', lease_generation = 2 WHERE id = ?",
  ).run(fixture.turnId);

  expect(fixture.repository.record(recordInput(fixture, controllerInteraction("turn_lease_record")))).toBe("stale");
  expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM controller_interactions").get()).toEqual({ count: 0 });
  closeCurrentFixture(fixture);
});

it("requires the submitted turn to retain the executor lease before resolving", () => {
  const fixture = currentInteractionFixture();
  const interaction = controllerInteraction("turn_lease_resolve");
  expect(fixture.repository.record(recordInput(fixture, interaction))).toBe("recorded");
  fixture.db.prepare(
    "UPDATE controller_turns SET lease_owner = 'successor', lease_generation = 2 WHERE id = ?",
  ).run(fixture.turnId);

  expect(fixture.repository.markResolved({
    ...fixture.fence,
    now: 2_100,
    interactionId: interaction.interactionId,
    turnId: fixture.turnId,
    bbThreadId: fixture.threadId,
  })).toBe(false);
  expect(fixture.db.prepare("SELECT state FROM controller_interactions WHERE interaction_id = ?")
    .get(interaction.interactionId)).toEqual({ state: "pending" });
  closeCurrentFixture(fixture);
});

it("requires the submitted turn to retain the executor lease before delivery", () => {
  const fixture = currentInteractionFixture();
  const interaction = controllerInteraction("turn_lease_deliver", "approval");
  expect(fixture.repository.record(recordInput(fixture, interaction))).toBe("recorded");
  expect(fixture.repository.answerByToken({
    token: controllerInteractionToken(interaction.interactionId, "deny"),
    userId: "7",
    chatId: "70",
    now: 2_100,
  })).toMatchObject({ ok: true, complete: true });
  fixture.db.prepare(
    "UPDATE controller_turns SET lease_owner = 'successor', lease_generation = 2 WHERE id = ?",
  ).run(fixture.turnId);

  expect(fixture.repository.markDelivered({
    ...fixture.fence,
    now: 2_200,
    interactionId: interaction.interactionId,
    turnId: fixture.turnId,
    bbThreadId: fixture.threadId,
  })).toBe(false);
  expect(fixture.db.prepare("SELECT state FROM controller_interactions WHERE interaction_id = ?")
    .get(interaction.interactionId)).toEqual({ state: "answered" });
  closeCurrentFixture(fixture);
});

it("keeps an answer awaiting resolution and promotes the next row only on delivery", () => {
  const fixture = currentInteractionFixture();
  const first = controllerInteraction("interaction_answered", "approval");
  const second = controllerInteraction("interaction_next");
  fixture.repository.record(recordInput(fixture, first, 2_000));
  fixture.repository.record(recordInput(fixture, second, 2_001));

  const answer = fixture.repository.answerByToken({
    token: controllerInteractionToken(first.interactionId, "allow_once"),
    userId: "7",
    chatId: "70",
    now: 2_100,
  });
  expect(answer).toMatchObject({ ok: true, interactionId: first.interactionId });
  expect(fixture.db.prepare("SELECT controller_interactions.state, awaiting_interaction_id FROM controller_interactions JOIN controller_turns ON controller_turns.id = turn_id WHERE interaction_id = ?").get(first.interactionId))
    .toEqual({ state: "answered", awaiting_interaction_id: first.interactionId });
  expect(fixture.repository.getAnswered(fixture.controllerKey)).toMatchObject({ interactionId: first.interactionId });

  expect(fixture.repository.markDelivered({
    ...fixture.fence,
    now: 2_200,
    interactionId: first.interactionId,
    turnId: fixture.turnId,
    bbThreadId: fixture.threadId,
  })).toBe(true);
  expect(fixture.db.prepare("SELECT awaiting_interaction_id FROM controller_turns WHERE id = ?").get(fixture.turnId))
    .toEqual({ awaiting_interaction_id: second.interactionId });
  expect(fixture.repository.getPending(fixture.controllerKey)).toMatchObject({ interactionId: second.interactionId });
  closeCurrentFixture(fixture);
});

it("settles an externally resolved pending row without inventing an owner answer", () => {
  const fixture = currentInteractionFixture();
  const interaction = controllerInteraction("interaction_external");
  fixture.repository.record(recordInput(fixture, interaction));

  expect(fixture.repository.markResolved({
    ...fixture.fence,
    now: 2_100,
    interactionId: interaction.interactionId,
    turnId: fixture.turnId,
    bbThreadId: fixture.threadId,
  })).toBe(true);
  expect(fixture.db.prepare("SELECT state, answer_json, delivered_at FROM controller_interactions WHERE interaction_id = ?").get(interaction.interactionId))
    .toEqual({ state: "delivered", answer_json: null, delivered_at: 2_100 });
  closeCurrentFixture(fixture);
});

it("answers only the oldest pending user question with plain text", () => {
  const fixture = currentInteractionFixture();
  const first = controllerInteraction("question_oldest");
  const approval = controllerInteraction("approval_middle", "approval");
  const later = controllerInteraction("question_later");
  fixture.repository.record(recordInput(fixture, first, 2_000));
  fixture.repository.record(recordInput(fixture, approval, 2_001));
  fixture.repository.record(recordInput(fixture, later, 2_002));

  const answer = fixture.repository.answerWithText({
    controllerKey: fixture.controllerKey,
    userId: "7",
    chatId: "70",
    text: "use the first route",
    now: 2_100,
  });
  expect(answer).toMatchObject({ ok: true, interactionId: first.interactionId });
  expect(fixture.db.prepare("SELECT state FROM controller_interactions WHERE interaction_id = ?").get(first.interactionId))
    .toEqual({ state: "answered" });
  expect(fixture.db.prepare("SELECT state FROM controller_interactions WHERE interaction_id = ?").get(later.interactionId))
    .toEqual({ state: "pending" });
  closeCurrentFixture(fixture);
});

it("keeps a multi-question interaction pending until every question is answered", () => {
  const fixture = currentInteractionFixture();
  const first = controllerInteraction("interaction_multi");
  if (first.kind !== "user_question") throw new Error("fixture question has the wrong kind");
  const interaction: ControllerInteraction = {
    ...first,
    questions: [
      first.questions[0]!,
      { ...first.questions[0]!, id: "question_2", prompt: "Which second option should I use?" },
    ],
  };
  fixture.repository.record(recordInput(fixture, interaction));

  expect(fixture.repository.answerByToken({
    token: questionOptionToken(interaction.interactionId, "question_1", "first"),
    userId: "7",
    chatId: "70",
    now: 2_100,
  })).toMatchObject({ ok: true, complete: false });
  expect(fixture.db.prepare("SELECT state FROM controller_interactions WHERE interaction_id = ?")
    .get(interaction.interactionId)).toEqual({ state: "pending" });

  expect(fixture.repository.answerWithText({
    controllerKey: fixture.controllerKey,
    userId: "7",
    chatId: "70",
    text: "the second route",
    now: 2_200,
  })).toMatchObject({ ok: true, complete: true });
  expect(fixture.db.prepare("SELECT state FROM controller_interactions WHERE interaction_id = ?")
    .get(interaction.interactionId)).toEqual({ state: "answered" });
  closeCurrentFixture(fixture);
});

it("rejects wrong or revoked owner identities", () => {
  const fixture = currentInteractionFixture();
  const interaction = controllerInteraction("interaction_owner");
  fixture.repository.record(recordInput(fixture, interaction));
  const token = questionOptionToken(interaction.interactionId, "question_1", "first");

  expect(fixture.repository.answerByToken({ token, userId: "8", chatId: "80", now: 2_100 })).toEqual({
    ok: false,
    reason: "stale",
  });
  fixture.db.prepare("UPDATE owners SET revoked_at = 2_101 WHERE singleton = 1").run();
  expect(fixture.repository.answerByToken({ token, userId: "7", chatId: "70", now: 2_102 })).toEqual({
    ok: false,
    reason: "stale",
  });
  closeCurrentFixture(fixture);
});

it("fails closed when an interaction is cross-bound to a different controller", () => {
  const fixture = currentInteractionFixture();
  const interaction = controllerInteraction("cross_bound_owner");
  expect(fixture.repository.record(recordInput(fixture, interaction))).toBe("recorded");
  const otherControllerKey = "owner-7-controller-other";
  const otherThreadId = "thr_controller_other";
  const otherGenerationId = "gen_controller_other";
  fixture.db.prepare(
    `INSERT INTO controller_threads (
       controller_key, telegram_user_id, telegram_chat_id, project_id, host_id,
       bb_thread_id, state, pending_spawn_token, last_error, created_at, updated_at
     ) VALUES (?, '7', '70', 'proj_1', 'host_1', ?, 'active', NULL, NULL, 1, 1)`,
  ).run(otherControllerKey, otherThreadId);
  fixture.db.prepare(
    `INSERT INTO controller_generations (id, controller_key, thread_id, started_at, ended_at, end_reason)
     VALUES (?, ?, ?, 1, NULL, NULL)`,
  ).run(otherGenerationId, otherControllerKey, otherThreadId);
  fixture.db.prepare(
    `UPDATE controller_interactions
        SET controller_key = ?, bb_thread_id = ?, controller_generation_id = ?
      WHERE interaction_id = ?`,
  ).run(otherControllerKey, otherThreadId, otherGenerationId, interaction.interactionId);

  expect(fixture.repository.getPending(otherControllerKey)).toBeNull();
  expect(fixture.repository.answerByToken({
    token: questionOptionToken(interaction.interactionId, "question_1", "first"),
    userId: "7",
    chatId: "70",
    now: 2_100,
  })).toEqual({ ok: false, reason: "stale" });
  expect(fixture.repository.answerWithText({
    controllerKey: otherControllerKey,
    userId: "7",
    chatId: "70",
    text: "ordinary answer",
    now: 2_101,
  })).toEqual({ ok: false, reason: "stale" });
  closeCurrentFixture(fixture);
});

it("allows exactly one winner for a two-connection button race", () => {
  const fixture = currentInteractionFixture();
  const interaction = controllerInteraction("interaction_button_race", "approval");
  fixture.repository.record(recordInput(fixture, interaction));
  const secondary = new Database(fixture.db.name);
  secondary.pragma("busy_timeout = 5000");
  secondary.pragma("foreign_keys = ON");
  const competing = new ControllerInteractionRepository(secondary);
  try {
    const allowToken = controllerInteractionToken(interaction.interactionId, "allow_once");
    const denyToken = controllerInteractionToken(interaction.interactionId, "deny");
    const results = [
      fixture.repository.answerByToken({ token: allowToken, userId: "7", chatId: "70", now: 2_100 }),
      competing.answerByToken({ token: denyToken, userId: "7", chatId: "70", now: 2_101 }),
    ];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(fixture.db.prepare("SELECT state, answer_json FROM controller_interactions WHERE interaction_id = ?").get(interaction.interactionId))
      .toMatchObject({ state: "answered" });
  } finally {
    secondary.close();
    closeCurrentFixture(fixture);
  }
});

it("requires the complete current identity and lease fence before delivery", () => {
  const cases: Array<{
    name: string;
    invalidate: (fixture: CurrentFixture) => void;
    input?: (fixture: CurrentFixture) => Record<string, unknown>;
  }> = [
    {
      name: "global takeover",
      invalidate: (fixture) => {
        fixture.db.prepare(
          "UPDATE executor_lease SET owner_id = 'successor', generation = 2 WHERE singleton = 1",
        ).run();
      },
    },
    {
      name: "expired global lease",
      invalidate: (fixture) => {
        fixture.db.prepare("UPDATE executor_lease SET lease_expires_at = 2_000 WHERE singleton = 1").run();
      },
    },
    {
      name: "turn lease loss",
      invalidate: (fixture) => {
        fixture.db.prepare("UPDATE controller_turns SET lease_generation = 2 WHERE id = ?").run(fixture.turnId);
      },
    },
    {
      name: "turn state change",
      invalidate: (fixture) => {
        fixture.db.prepare("UPDATE controller_turns SET state = 'completed' WHERE id = ?").run(fixture.turnId);
      },
    },
    {
      name: "controller thread change",
      invalidate: (fixture) => {
        fixture.db.prepare("UPDATE controller_threads SET state = 'failed' WHERE controller_key = ?")
          .run(fixture.controllerKey);
      },
    },
    {
      name: "ended generation",
      invalidate: (fixture) => {
        fixture.db.prepare("UPDATE controller_generations SET ended_at = 2_100 WHERE id = ?").run(fixture.generationId);
      },
    },
    {
      name: "replacement generation ambiguity",
      invalidate: (fixture) => {
        fixture.db.prepare("UPDATE controller_generations SET ended_at = 2_100 WHERE id = ?").run(fixture.generationId);
        fixture.db.prepare(
          `INSERT INTO controller_generations (id, controller_key, thread_id, started_at, ended_at, end_reason)
           VALUES ('gen_replacement', ?, ?, 2_101, NULL, NULL)`,
        ).run(fixture.controllerKey, fixture.threadId);
      },
    },
    {
      name: "answered row identity",
      invalidate: () => {},
      input: (fixture) => ({
        interactionId: "other-interaction",
        turnId: fixture.turnId,
        controllerKey: fixture.controllerKey,
        bbThreadId: fixture.threadId,
        controllerGenerationId: fixture.generationId,
      }),
    },
    {
      name: "answered row state",
      invalidate: (fixture) => {
        fixture.db.prepare("UPDATE controller_interactions SET state = 'pending' WHERE interaction_id = ?")
          .run("interaction_delivery_fence");
      },
    },
  ];

  for (const testCase of cases) {
    const fixture = currentInteractionFixture();
    const interaction = controllerInteraction("interaction_delivery_fence", "approval");
    expect(fixture.repository.record(recordInput(fixture, interaction))).toBe("recorded");
    expect(fixture.repository.answerByToken({
      token: controllerInteractionToken(interaction.interactionId, "deny"),
      userId: "7",
      chatId: "70",
      now: 2_100,
    })).toMatchObject({ ok: true });
    const baseInput = {
      ...fixture.fence,
      now: 2_200,
      interactionId: interaction.interactionId,
      turnId: fixture.turnId,
      controllerKey: fixture.controllerKey,
      bbThreadId: fixture.threadId,
      controllerGenerationId: fixture.generationId,
    };
    expect(fixture.repository.isControllerInteractionDeliveryFenceCurrent(baseInput)).toBe(true);
    testCase.invalidate(fixture);
    const input = { ...baseInput, ...(testCase.input?.(fixture) ?? {}) };
    expect(fixture.repository.isControllerInteractionDeliveryFenceCurrent(input)).toBe(false);
    closeCurrentFixture(fixture);
  }
});

it("answers only the interaction exposed by the submitted turn pointer", () => {
  const fixture = currentInteractionFixture();
  const first = controllerInteraction("interaction_exposed_first");
  const second = controllerInteraction("interaction_exposed_second");
  expect(fixture.repository.record(recordInput(fixture, first, 2_000))).toBe("recorded");
  expect(fixture.repository.record(recordInput(fixture, second, 2_001))).toBe("recorded");

  expect(fixture.repository.answerByToken({
    token: questionOptionToken(second.interactionId, "question_1", "first"),
    userId: "7",
    chatId: "70",
    now: 2_100,
  })).toEqual({ ok: false, reason: "stale" });
  expect(fixture.db.prepare(
    "SELECT interaction_id FROM controller_interactions WHERE state = 'pending' ORDER BY asked_at",
  ).all()).toEqual([
    { interaction_id: first.interactionId },
    { interaction_id: second.interactionId },
  ]);

  expect(fixture.repository.answerByToken({
    token: questionOptionToken(first.interactionId, "question_1", "first"),
    userId: "7",
    chatId: "70",
    now: 2_101,
  })).toMatchObject({ ok: true, interactionId: first.interactionId });
  expect(fixture.repository.markDelivered({
    ...fixture.fence,
    now: 2_102,
    interactionId: first.interactionId,
    turnId: fixture.turnId,
    bbThreadId: fixture.threadId,
  })).toBe(true);
  expect(fixture.repository.answerByToken({
    token: questionOptionToken(second.interactionId, "question_1", "first"),
    userId: "7",
    chatId: "70",
    now: 2_103,
  })).toMatchObject({ ok: true, interactionId: second.interactionId });
  closeCurrentFixture(fixture);
});

it("does not let text skip an exposed approval to answer a later question", () => {
  const fixture = currentInteractionFixture();
  const approval = controllerInteraction("interaction_exposed_approval", "approval");
  const question = controllerInteraction("interaction_hidden_question");
  expect(fixture.repository.record(recordInput(fixture, approval, 2_000))).toBe("recorded");
  expect(fixture.repository.record(recordInput(fixture, question, 2_001))).toBe("recorded");

  expect(fixture.repository.answerWithText({
    controllerKey: fixture.controllerKey,
    userId: "7",
    chatId: "70",
    text: "answer the question",
    now: 2_100,
  })).toEqual({ ok: false, reason: "stale" });
  expect(fixture.db.prepare(
    "SELECT interaction_id FROM controller_interactions WHERE state = 'pending' ORDER BY asked_at",
  ).all()).toEqual([
    { interaction_id: approval.interactionId },
    { interaction_id: question.interactionId },
  ]);
  closeCurrentFixture(fixture);
});

it("allows exactly one winner for a two-connection button versus text race", () => {
  const fixture = currentInteractionFixture();
  const interaction = controllerInteraction("interaction_text_race");
  fixture.repository.record(recordInput(fixture, interaction));
  const secondary = new Database(fixture.db.name);
  secondary.pragma("busy_timeout = 5000");
  secondary.pragma("foreign_keys = ON");
  const competing = new ControllerInteractionRepository(secondary);
  try {
    const token = questionOptionToken(interaction.interactionId, "question_1", "first");
    const results = [
      fixture.repository.answerByToken({ token, userId: "7", chatId: "70", now: 2_100 }),
      competing.answerWithText({
        controllerKey: fixture.controllerKey,
        userId: "7",
        chatId: "70",
        text: "use the first route",
        now: 2_101,
      }),
    ];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(fixture.db.prepare("SELECT state FROM controller_interactions WHERE interaction_id = ?").get(interaction.interactionId))
      .toEqual({ state: "answered" });
  } finally {
    secondary.close();
    closeCurrentFixture(fixture);
  }
});

it("allows exactly one winner for a barrier-backed independent-worker button race", async () => {
  const fixture = currentInteractionFixture();
  const interaction = controllerInteraction("interaction_worker_button_race", "approval");
  expect(fixture.repository.record(recordInput(fixture, interaction))).toBe("recorded");
  const results = await runInteractionRace(fixture, interaction, [
    { label: "allow", action: "button", token: controllerInteractionToken(interaction.interactionId, "allow_once") },
    { label: "deny", action: "button", token: controllerInteractionToken(interaction.interactionId, "deny") },
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(fixture.db.prepare("SELECT state FROM controller_interactions WHERE interaction_id = ?")
    .get(interaction.interactionId)).toEqual({ state: "answered" });
  closeCurrentFixture(fixture);
});

it("allows exactly one winner for a barrier-backed independent-worker button versus text race", async () => {
  const fixture = currentInteractionFixture();
  const interaction = controllerInteraction("interaction_worker_text_race");
  expect(fixture.repository.record(recordInput(fixture, interaction))).toBe("recorded");
  const results = await runInteractionRace(fixture, interaction, [
    { label: "button", action: "button", token: questionOptionToken(interaction.interactionId, "question_1", "first") },
    { label: "text", action: "text" },
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(fixture.db.prepare("SELECT state FROM controller_interactions WHERE interaction_id = ?")
    .get(interaction.interactionId)).toEqual({ state: "answered" });
  closeCurrentFixture(fixture);
});

it.each([
  ["stale fence", { generation: CURRENT_GENERATION + 1 }],
  ["wrong thread", { bbThreadId: "thr_other" }],
  ["wrong interaction", { interactionId: "interaction_other" }],
] as const)("fails closed before %s can settle an answer", (_name, override) => {
  const fixture = currentInteractionFixture();
  const interaction = controllerInteraction("interaction_settle_guard", "approval");
  fixture.repository.record(recordInput(fixture, interaction));
  fixture.repository.answerByToken({
    token: controllerInteractionToken(interaction.interactionId, "deny"),
    userId: "7",
    chatId: "70",
    now: 2_100,
  });

  expect(fixture.repository.markDelivered({
    ...fixture.fence,
    now: 2_200,
    interactionId: interaction.interactionId,
    turnId: fixture.turnId,
    bbThreadId: fixture.threadId,
    ...override,
  })).toBe(false);
  expect(fixture.db.prepare("SELECT state FROM controller_interactions WHERE interaction_id = ?").get(interaction.interactionId))
    .toEqual({ state: "answered" });
  closeCurrentFixture(fixture);
});

it("fails closed when the stored open generation is no longer current", () => {
  const fixture = currentInteractionFixture();
  const interaction = controllerInteraction("interaction_generation_ended", "approval");
  fixture.repository.record(recordInput(fixture, interaction));
  fixture.repository.answerByToken({
    token: controllerInteractionToken(interaction.interactionId, "deny"),
    userId: "7",
    chatId: "70",
    now: 2_100,
  });
  fixture.db.prepare("UPDATE controller_generations SET ended_at = 2_150 WHERE id = ?").run(fixture.generationId);

  expect(fixture.repository.markDelivered({
    ...fixture.fence,
    now: 2_200,
    interactionId: interaction.interactionId,
    turnId: fixture.turnId,
    bbThreadId: fixture.threadId,
  })).toBe(false);
  expect(fixture.db.prepare("SELECT state FROM controller_interactions WHERE interaction_id = ?").get(interaction.interactionId))
    .toEqual({ state: "answered" });
  closeCurrentFixture(fixture);
});
