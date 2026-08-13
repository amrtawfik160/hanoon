import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { ControllerInteractionService } from "../src/controller/interaction-service";
import { parseControllerInteraction, questionOptionToken, threadDecisionToken } from "../src/controller/questions";
import { ControllerInteractionRepository } from "../src/storage/controller-interaction-repository";
import type { ControllerInteraction } from "../src/controller/questions";
import { ALL_MIGRATIONS } from "../src/storage/migrations";

let sequence = 0;

function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolveWait, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (existsSync(path)) return resolveWait();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error(`interaction race barrier timed out: ${path}`));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function raceWorkerSource(): string {
  return String.raw`
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ControllerInteractionRepository } from "../src/storage/controller-interaction-repository";
const [databasePath, barrierDir, label, operation, token] = process.argv.slice(2);
if (!databasePath || !barrierDir || !label || !operation || !token) throw new Error("interaction race arguments missing");
const db = new Database(databasePath);
db.pragma("busy_timeout = 5000");
db.function("task10_race_pause", () => {
  writeFileSync(join(barrierDir, "entered-" + label), "entered");
  while (!existsSync(join(barrierDir, "release"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
});
const repository = new ControllerInteractionRepository(db);
writeFileSync(join(barrierDir, "ready-" + label), "ready");
while (!existsSync(join(barrierDir, "go"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
writeFileSync(join(barrierDir, "attempting-" + label), "attempting");
const answer = operation === "button"
  ? repository.answerByToken({ token, userId: "7", chatId: "7", now: 3 })
  : repository.answerWithText({ controllerKey: "owner-7-controller", userId: "7", chatId: "7", text: token, now: 3 });
process.stdout.write(JSON.stringify(answer) + "\n");
db.close();
`;
}

function startRaceWorker(scriptPath: string, databasePath: string, barrierDir: string, label: string, operation: "button" | "text", token: string) {
  const child = spawn(resolve("node_modules/.bin/vite-node"), ["--script", scriptPath, databasePath, barrierDir, label, operation, token], {
    cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const answer = new Promise<{ ok: boolean; resolution?: unknown }>((resolveAnswer, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`interaction race worker exited ${code}: ${stderr || stdout}`));
      resolveAnswer(JSON.parse(stdout.trim().split("\n").at(-1)!) as { ok: boolean; resolution?: unknown });
    });
  });
  return { child, answer };
}

function seededRaceDatabase(directory: string): { databasePath: string; db: Database.Database } {
  const databasePath = resolve(directory, "interactions.sqlite");
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const migration of ALL_MIGRATIONS) db.exec(migration);
  db.prepare("INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at) VALUES (1, '7', '7', 1)").run();
  db.prepare("INSERT INTO controller_threads (controller_key, telegram_user_id, telegram_chat_id, state, created_at, updated_at, bb_thread_id) VALUES ('owner-7-controller', '7', '7', 'active', 1, 1, 'thr-current')").run();
  db.prepare("INSERT INTO controller_turns (id, telegram_update_id, controller_key, ordinal, input_text, state, lease_owner, lease_generation, submitted_at, created_at, updated_at) VALUES ('turn-1', 1, 'owner-7-controller', 1, 'question', 'submitted', 'executor', 1, 1, 1, 1)").run();
  db.prepare("INSERT INTO controller_generations (id, controller_key, thread_id, started_at) VALUES ('gen-current', 'owner-7-controller', 'thr-current', 1)").run();
  db.prepare("UPDATE executor_lease SET owner_id = 'executor', generation = 1, heartbeat_at = 1, lease_expires_at = 100000 WHERE singleton = 1").run();
  const repository = new ControllerInteractionRepository(db);
  expect(repository.record({ ...fence, turnId: "turn-1", controllerKey: "owner-7-controller", bbThreadId: "thr-current", controllerGenerationId: "gen-current", interaction: question })).toBe(true);
  db.exec("CREATE TRIGGER pause_interaction_answer BEFORE UPDATE OF state ON controller_interactions WHEN OLD.state = 'pending' AND NEW.state = 'answered' BEGIN SELECT task10_race_pause(); END");
  return { databasePath, db };
}

function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `controller-interactions-${sequence++}` });
  const db = bb.storage.database();
  bb.storage.migrate(db, [...ALL_MIGRATIONS]);
  db.prepare("INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at) VALUES (1, '7', '7', 1)").run();
  db.prepare(
    `INSERT INTO controller_threads
       (controller_key, telegram_user_id, telegram_chat_id, state, created_at, updated_at, bb_thread_id)
     VALUES ('owner-7-controller', '7', '7', 'active', 1, 1, 'thr-current')`,
  ).run();
  db.prepare(
    `INSERT INTO controller_turns
       (id, telegram_update_id, controller_key, ordinal, input_text, state, lease_owner, lease_generation, submitted_at, created_at, updated_at)
     VALUES ('turn-1', 1, 'owner-7-controller', 1, 'question', 'submitted', 'executor', 1, 1, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO controller_generations (id, controller_key, thread_id, started_at)
     VALUES ('gen-current', 'owner-7-controller', 'thr-current', 1)`,
  ).run();
  db.prepare("UPDATE executor_lease SET owner_id = 'executor', generation = 1, heartbeat_at = 1, lease_expires_at = 100000 WHERE singleton = 1").run();
  return { db, repository: new ControllerInteractionRepository(db) };
}

const fence = { ownerId: "executor", generation: 1, now: 2 };
const question = {
  kind: "user_question" as const,
  interactionId: "int-question",
  questions: [{ id: "q1", prompt: "Choose", shortLabel: null, multiSelect: false, allowFreeText: true, options: [{ value: "yes", label: "Yes", description: null }] }],
};

function record(repository: ControllerInteractionRepository, interaction: ControllerInteraction = question, turnId = "turn-1", now = 2) {
  return repository.record({ ...fence, now, turnId, controllerKey: "owner-7-controller", bbThreadId: "thr-current", controllerGenerationId: "gen-current", interaction });
}

it("copies legacy questions without rewriting their historical table", () => {
  const { bb } = createFakePluginHost({ pluginId: `controller-interaction-migration-${sequence++}` });
  const db = bb.storage.database();
  bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(0, 29));
  db.prepare("INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at) VALUES (1, '7', '7', 1)").run();
  db.prepare("INSERT INTO controller_threads (controller_key, telegram_user_id, telegram_chat_id, state, created_at, updated_at, bb_thread_id) VALUES ('owner-7-controller', '7', '7', 'active', 1, 1, 'thr-current')").run();
  db.prepare("INSERT INTO controller_turns (id, telegram_update_id, controller_key, ordinal, input_text, state, submitted_at, created_at, updated_at) VALUES ('turn-1', 1, 'owner-7-controller', 1, 'question', 'submitted', 1, 1, 1)").run();
  db.prepare("INSERT INTO controller_generations (id, controller_key, thread_id, started_at) VALUES ('gen-current', 'owner-7-controller', 'thr-current', 1)").run();
  db.prepare("INSERT INTO controller_questions (interaction_id, turn_id, controller_key, questions_json, state, answers_json, asked_at, answered_at) VALUES ('legacy-1', 'turn-1', 'owner-7-controller', '[{\"id\":\"q1\"}]', 'answered', '{\"q1\":{\"selected\":[\"yes\"]}}', 2, 3)").run();

  bb.storage.migrate(db, [...ALL_MIGRATIONS]);

  expect(db.prepare("SELECT interaction_id, bb_thread_id, controller_generation_id, state FROM controller_interactions").get()).toEqual({ interaction_id: "legacy-1", bb_thread_id: "thr-current", controller_generation_id: "gen-current", state: "answered" });
  expect(db.prepare("SELECT questions_json FROM controller_questions WHERE interaction_id = 'legacy-1'").get()).toEqual({ questions_json: '[{"id":"q1"}]' });
});

it("copies pending, answered, and delivered legacy rows with exact lifecycle fields", () => {
  const { bb } = createFakePluginHost({ pluginId: `controller-interaction-copy-matrix-${sequence++}` });
  const db = bb.storage.database();
  bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(0, 29));
  db.prepare("INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at) VALUES (1, '7', '7', 1)").run();
  db.prepare("INSERT INTO controller_threads (controller_key, telegram_user_id, telegram_chat_id, state, created_at, updated_at, bb_thread_id) VALUES ('owner-7-controller', '7', '7', 'active', 1, 1, 'thr-current')").run();
  db.prepare("INSERT INTO controller_turns (id, telegram_update_id, controller_key, ordinal, input_text, state, submitted_at, created_at, updated_at) VALUES ('turn-copy', 1, 'owner-7-controller', 1, 'question', 'submitted', 1, 1, 1)").run();
  for (const [_ordinal, state, answers, askedAt, answeredAt] of [
    [1, "pending", "{}", 10, null],
    [2, "answered", '{"q1":{"selected":["yes"]}}', 20, 21],
    [3, "delivered", '{"q1":{"selected":["no"]}}', 30, 31],
  ] as const) {
    db.prepare("INSERT INTO controller_questions (interaction_id, turn_id, controller_key, questions_json, state, answers_json, asked_at, answered_at) VALUES (?, ?, 'owner-7-controller', ?, ?, ?, ?, ?)")
      .run(`legacy-${state}`, "turn-copy", JSON.stringify(question.questions), state, answers, askedAt, answeredAt);
  }
  db.prepare("INSERT INTO controller_generations (id, controller_key, thread_id, started_at) VALUES ('gen-current', 'owner-7-controller', 'thr-current', 1)").run();
  const legacyBefore = db.prepare("SELECT * FROM controller_questions ORDER BY interaction_id").all();

  bb.storage.migrate(db, [...ALL_MIGRATIONS]);

  expect(db.prepare("SELECT interaction_id, payload_json, state, answer_json, asked_at, answered_at, delivered_at, bb_thread_id, controller_generation_id FROM controller_interactions ORDER BY interaction_id").all())
    .toEqual([
      { interaction_id: "legacy-answered", payload_json: JSON.stringify({ kind: "user_question", interactionId: "legacy-answered", questions: question.questions }), state: "answered", answer_json: JSON.stringify({ kind: "user_answer", answers: { q1: { selected: ["yes"] } } }), asked_at: 20, answered_at: 21, delivered_at: null, bb_thread_id: "thr-current", controller_generation_id: "gen-current" },
      { interaction_id: "legacy-delivered", payload_json: JSON.stringify({ kind: "user_question", interactionId: "legacy-delivered", questions: question.questions }), state: "delivered", answer_json: JSON.stringify({ kind: "user_answer", answers: { q1: { selected: ["no"] } } }), asked_at: 30, answered_at: 31, delivered_at: 31, bb_thread_id: null, controller_generation_id: null },
      { interaction_id: "legacy-pending", payload_json: JSON.stringify({ kind: "user_question", interactionId: "legacy-pending", questions: question.questions }), state: "pending", answer_json: null, asked_at: 10, answered_at: null, delivered_at: null, bb_thread_id: "thr-current", controller_generation_id: "gen-current" },
    ]);
  expect(db.prepare("SELECT * FROM controller_questions ORDER BY interaction_id").all()).toEqual(legacyBefore);
});

it.each([
  ["missing thread", "UPDATE controller_threads SET bb_thread_id = NULL"],
  ["missing generation", "DELETE FROM controller_generations WHERE id = 'gen-current'"],
  ["two open generations", "INSERT INTO controller_generations (id, controller_key, thread_id, started_at) VALUES ('gen-second', 'owner-7-controller', 'thr-current', 2)"],
  ["turn/controller mismatch", "PRAGMA foreign_keys = OFF; UPDATE controller_questions SET controller_key = 'other-controller'; PRAGMA foreign_keys = ON"],
  ["non-submitted turn", "UPDATE controller_turns SET state = 'completed', completed_at = 3"],
])("rolls back the interaction migration for %s and permits a clean retry", (_scenario, corruption) => {
  const { bb } = createFakePluginHost({ pluginId: `controller-interaction-rollback-${sequence++}` });
  const db = bb.storage.database();
  bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(0, 29));
  db.prepare("INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at) VALUES (1, '7', '7', 1)").run();
  db.prepare("INSERT INTO controller_threads (controller_key, telegram_user_id, telegram_chat_id, state, created_at, updated_at, bb_thread_id) VALUES ('owner-7-controller', '7', '7', 'active', 1, 1, 'thr-current')").run();
  db.prepare("INSERT INTO controller_threads (controller_key, telegram_user_id, telegram_chat_id, state, created_at, updated_at, bb_thread_id) VALUES ('other-controller', '7', '7', 'revoked', 1, 1, NULL)").run();
  db.prepare("INSERT INTO controller_turns (id, telegram_update_id, controller_key, ordinal, input_text, state, submitted_at, created_at, updated_at) VALUES ('turn-1', 1, 'owner-7-controller', 1, 'question', 'submitted', 1, 1, 1)").run();
  db.prepare("INSERT INTO controller_generations (id, controller_key, thread_id, started_at) VALUES ('gen-current', 'owner-7-controller', 'thr-current', 1)").run();
  db.prepare("INSERT INTO controller_questions (interaction_id, turn_id, controller_key, questions_json, state, answers_json, asked_at) VALUES ('legacy', 'turn-1', 'owner-7-controller', ?, 'pending', '{}', 2)")
    .run(JSON.stringify(question.questions));
  db.exec(corruption);

  expect(() => bb.storage.migrate(db, [...ALL_MIGRATIONS])).toThrow();
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'controller_interactions'").get()).toBeUndefined();
  expect(db.prepare("SELECT COUNT(*) AS count FROM _bb_migrations").get()).toEqual({ count: 29 });
  expect(db.prepare("SELECT interaction_id FROM controller_questions").all()).toEqual([{ interaction_id: "legacy" }]);

  db.exec("PRAGMA foreign_keys = OFF; DELETE FROM controller_generations WHERE id = 'gen-second'; INSERT OR IGNORE INTO controller_generations (id, controller_key, thread_id, started_at) VALUES ('gen-current', 'owner-7-controller', 'thr-current', 1); UPDATE controller_threads SET bb_thread_id = CASE WHEN controller_key = 'owner-7-controller' THEN 'thr-current' ELSE NULL END; UPDATE controller_questions SET controller_key = 'owner-7-controller'; UPDATE controller_turns SET state = 'submitted', completed_at = NULL; PRAGMA foreign_keys = ON");
  bb.storage.migrate(db, [...ALL_MIGRATIONS]);
  expect(db.prepare("SELECT interaction_id FROM controller_interactions").all()).toEqual([{ interaction_id: "legacy" }]);
});

it("keeps the oldest active interaction parked and promotes the next only after delivery", () => {
  const { db, repository } = fixture();
  expect(record(repository)).toBe(true);
  expect(record(repository, { ...question, interactionId: "int-later" }, "turn-1", 3)).toBe(true);
  expect(db.prepare("SELECT awaiting_interaction_id FROM controller_turns WHERE id = 'turn-1'").get()).toEqual({ awaiting_interaction_id: "int-question" });
  expect(repository.answerWithText({ controllerKey: "owner-7-controller", userId: "7", chatId: "7", text: "yes", now: 4 })).toMatchObject({ ok: true, interactionId: "int-question" });
  expect(repository.markDelivered({ ...fence, now: 5, interactionId: "int-question", turnId: "turn-1", bbThreadId: "thr-current" })).toBe(true);
  expect(db.prepare("SELECT awaiting_interaction_id FROM controller_turns WHERE id = 'turn-1'").get()).toEqual({ awaiting_interaction_id: "int-later" });
});

it("selects and promotes only the current generation after a controller rollover", async () => {
  const { db, repository } = fixture();
  const staleApproval = {
    kind: "approval" as const,
    interactionId: "approval-generation-a",
    summary: "wants to write a protected path",
    decisions: ["deny" as const],
  };
  expect(record(repository, staleApproval, "turn-1", 2)).toBe(true);
  expect(repository.answerByToken({
    token: threadDecisionToken(staleApproval.interactionId, "deny"), userId: "7", chatId: "7", now: 3,
  })).toMatchObject({ ok: true, interactionId: staleApproval.interactionId });

  db.prepare("UPDATE controller_generations SET ended_at = 4 WHERE id = 'gen-current'").run();
  db.prepare("UPDATE controller_threads SET bb_thread_id = 'thr-next' WHERE controller_key = 'owner-7-controller'").run();
  db.prepare("INSERT INTO controller_generations (id, controller_key, thread_id, started_at) VALUES ('gen-next', 'owner-7-controller', 'thr-next', 4)").run();
  const activeApproval = { ...staleApproval, interactionId: "approval-generation-b" };
  expect(repository.record({
    ...fence,
    now: 5,
    turnId: "turn-1",
    controllerKey: "owner-7-controller",
    bbThreadId: "thr-next",
    controllerGenerationId: "gen-next",
    interaction: activeApproval,
  })).toBe(true);

  expect(repository.getPending("owner-7-controller")).toMatchObject({ interactionId: activeApproval.interactionId });
  expect(repository.getAnswered("owner-7-controller")).toBeNull();
  expect(db.prepare("SELECT awaiting_interaction_id FROM controller_turns WHERE id = 'turn-1'").get())
    .toEqual({ awaiting_interaction_id: activeApproval.interactionId });

  expect(repository.answerByToken({
    token: threadDecisionToken(activeApproval.interactionId, "deny"), userId: "7", chatId: "7", now: 6,
  })).toMatchObject({ ok: true, interactionId: activeApproval.interactionId });
  expect(repository.getAnswered("owner-7-controller")).toMatchObject({ interactionId: activeApproval.interactionId });
  const get = vi.fn(async () => ({ id: activeApproval.interactionId, threadId: "thr-next", status: "pending" }));
  const resolveInteraction = vi.fn(async () => ({ id: activeApproval.interactionId, threadId: "thr-next", status: "resolved" }));
  const service = new ControllerInteractionService({
    store: repository,
    interactions: { get, resolve: resolveInteraction } as never,
    clock: () => 7,
  });
  await expect(service.deliverAnswered({
    ...fence, now: 7, controllerKey: "owner-7-controller",
  })).resolves.toBe(true);
  expect(get).toHaveBeenCalledWith(expect.objectContaining({ interactionId: activeApproval.interactionId, threadId: "thr-next" }));
  expect(resolveInteraction).toHaveBeenCalledWith(expect.objectContaining({ interactionId: activeApproval.interactionId, threadId: "thr-next" }));
  expect(db.prepare("SELECT awaiting_interaction_id FROM controller_turns WHERE id = 'turn-1'").get())
    .toEqual({ awaiting_interaction_id: null });
});

it("orders equal timestamps by id and does not let out-of-order settlement skip the current row", () => {
  const { db, repository } = fixture();
  expect(record(repository, { ...question, interactionId: "z-later-id" }, "turn-1", 2)).toBe(true);
  expect(record(repository, { ...question, interactionId: "a-earlier-id" }, "turn-1", 2)).toBe(true);
  expect(db.prepare("SELECT awaiting_interaction_id FROM controller_turns WHERE id = 'turn-1'").get())
    .toEqual({ awaiting_interaction_id: "a-earlier-id" });
  expect(repository.markResolved({ ...fence, now: 3, interactionId: "z-later-id", turnId: "turn-1", bbThreadId: "thr-current" })).toBe(true);
  expect(db.prepare("SELECT awaiting_interaction_id FROM controller_turns WHERE id = 'turn-1'").get())
    .toEqual({ awaiting_interaction_id: "a-earlier-id" });
  expect(repository.markResolved({ ...fence, now: 4, interactionId: "a-earlier-id", turnId: "turn-1", bbThreadId: "thr-current" })).toBe(true);
  expect(db.prepare("SELECT awaiting_interaction_id FROM controller_turns WHERE id = 'turn-1'").get())
    .toEqual({ awaiting_interaction_id: null });
});

it("handles resolved-before-record reorder, restart, and generation-scoped id reuse", () => {
  const { db, repository } = fixture();
  expect(repository.markResolved({ ...fence, interactionId: "int-question", turnId: "turn-1", bbThreadId: "thr-current" })).toBe(false);
  expect(record(repository)).toBe(true);
  const reopened = new ControllerInteractionRepository(db);
  expect(reopened.getPending("owner-7-controller")).toMatchObject({ interactionId: "int-question", state: "pending" });
  expect(reopened.markResolved({ ...fence, now: 3, interactionId: "int-question", turnId: "turn-1", bbThreadId: "thr-current" })).toBe(true);
  expect(db.prepare("SELECT state, delivered_at FROM controller_interactions WHERE interaction_id = 'int-question'").get())
    .toEqual({ state: "delivered", delivered_at: 3 });
  db.prepare("UPDATE controller_generations SET ended_at = 3 WHERE id = 'gen-current'").run();
  db.prepare("INSERT INTO controller_generations (id, controller_key, thread_id, started_at) VALUES ('gen-successor', 'owner-7-controller', 'thr-current', 3)").run();
  expect(reopened.record({ ...fence, now: 4, turnId: "turn-1", controllerKey: "owner-7-controller", bbThreadId: "thr-current", controllerGenerationId: "gen-successor", interaction: question })).toBe(false);
});

it("blocks the previous executor and owner source after successor takeover", () => {
  const { db, repository } = fixture();
  expect(record(repository)).toBe(true);
  db.prepare("UPDATE executor_lease SET owner_id = 'successor', generation = 2, lease_expires_at = 100000 WHERE singleton = 1").run();
  db.prepare("UPDATE controller_turns SET lease_owner = 'successor', lease_generation = 2 WHERE id = 'turn-1'").run();
  db.prepare("UPDATE controller_threads SET state = 'revoked' WHERE controller_key = 'owner-7-controller'").run();
  expect(repository.sourceIsActive({ ...fence, interactionId: "int-question", turnId: "turn-1", bbThreadId: "thr-current" })).toBe(false);
  expect(repository.answerWithText({ controllerKey: "owner-7-controller", userId: "7", chatId: "7", text: "answer", now: 4 }))
    .toEqual({ ok: false, reason: "stale" });
});

it("allows exactly one owner answer when a button races free text", () => {
  const { repository } = fixture();
  record(repository);
  const token = "q:" + questionOptionToken("int-question", "q1", "yes");
  const button = repository.answerByToken({ token, userId: "7", chatId: "7", now: 3 });
  const text = repository.answerWithText({ controllerKey: "owner-7-controller", userId: "7", chatId: "7", text: "other", now: 3 });
  expect([button, text].filter((answer) => answer.ok)).toHaveLength(1);
});

it.each([
  ["user", "8", "7"],
  ["chat", "7", "8"],
])("rejects a mismatched owner %s", (_identityField, userId, chatId) => {
  const { repository } = fixture();
  expect(record(repository)).toBe(true);
  expect(repository.answerWithText({ controllerKey: "owner-7-controller", userId, chatId, text: "yes", now: 3 }))
    .toEqual({ ok: false, reason: "stale" });
});

it("rejects stale executor identity and a revoked owner", () => {
  const { db, repository } = fixture();
  expect(repository.record({ ...fence, generation: 2, turnId: "turn-1", controllerKey: "owner-7-controller", bbThreadId: "thr-current", controllerGenerationId: "gen-current", interaction: question })).toBe(false);
  record(repository);
  db.prepare("UPDATE owners SET revoked_at = 3").run();
  expect(repository.answerWithText({ controllerKey: "owner-7-controller", userId: "7", chatId: "7", text: "yes", now: 3 })).toEqual({ ok: false, reason: "stale" });
});

it("rejects free text when the current question disallows it", () => {
  const { db, repository } = fixture();
  const buttonsOnly = { ...question, questions: [{ ...question.questions[0]!, allowFreeText: false }] };
  expect(record(repository, buttonsOnly)).toBe(true);

  expect(repository.answerWithText({ controllerKey: "owner-7-controller", userId: "7", chatId: "7", text: "typed", now: 3 }))
    .toEqual({ ok: false, reason: "stale" });
  expect(db.prepare("SELECT state, answer_json, answered_at FROM controller_interactions WHERE interaction_id = 'int-question'").get())
    .toEqual({ state: "pending", answer_json: null, answered_at: null });
});

it("rejects a 2,000-code-point free-text answer above the canonical byte limit", () => {
  const { db, repository } = fixture();
  expect(record(repository)).toBe(true);

  expect(repository.answerWithText({ controllerKey: "owner-7-controller", userId: "7", chatId: "7", text: "€".repeat(2_000), now: 3 }))
    .toEqual({ ok: false, reason: "stale" });
  expect(db.prepare("SELECT state, answer_json, answered_at FROM controller_interactions WHERE interaction_id = 'int-question'").get())
    .toEqual({ state: "pending", answer_json: null, answered_at: null });
});

it("fails owner and executor mutations closed for a cross-controller interaction row", () => {
  const { db, repository } = fixture();
  expect(record(repository)).toBe(true);
  db.prepare("INSERT INTO controller_threads (controller_key, telegram_user_id, telegram_chat_id, state, created_at, updated_at, bb_thread_id) VALUES ('other-controller', '7', '7', 'active', 1, 1, 'thr-other')").run();
  db.prepare("INSERT INTO controller_generations (id, controller_key, thread_id, started_at) VALUES ('gen-other', 'other-controller', 'thr-other', 1)").run();
  db.exec("PRAGMA foreign_keys = OFF; UPDATE controller_interactions SET controller_key = 'other-controller', bb_thread_id = 'thr-other', controller_generation_id = 'gen-other' WHERE interaction_id = 'int-question'; PRAGMA foreign_keys = ON");

  expect(repository.answerWithText({ controllerKey: "other-controller", userId: "7", chatId: "7", text: "answer", now: 3 }))
    .toEqual({ ok: false, reason: "stale" });
  expect(repository.sourceIsActive({ ...fence, interactionId: "int-question", turnId: "turn-1", bbThreadId: "thr-other" })).toBe(false);
  expect(repository.markResolved({ ...fence, now: 3, interactionId: "int-question", turnId: "turn-1", bbThreadId: "thr-other" })).toBe(false);
  db.prepare("UPDATE controller_interactions SET state = 'answered', answer_json = ?, answered_at = 3 WHERE interaction_id = 'int-question'")
    .run(JSON.stringify({ kind: "user_answer", answers: { q1: { selected: ["yes"] } } }));
  expect(repository.markDelivered({ ...fence, now: 4, interactionId: "int-question", turnId: "turn-1", bbThreadId: "thr-other" })).toBe(false);
  expect(db.prepare("SELECT state, answer_json, delivered_at FROM controller_interactions WHERE interaction_id = 'int-question'").get())
    .toEqual({ state: "answered", answer_json: JSON.stringify({ kind: "user_answer", answers: { q1: { selected: ["yes"] } } }), delivered_at: null });
});

it("fails owner and executor mutations closed when the source has two open generations", () => {
  const { db, repository } = fixture();
  expect(record(repository)).toBe(true);
  db.prepare("INSERT INTO controller_generations (id, controller_key, thread_id, started_at) VALUES ('gen-second', 'owner-7-controller', 'thr-current', 2)").run();

  expect(repository.getPending("owner-7-controller")).toBeNull();
  expect(repository.answerByToken({ token: questionOptionToken("int-question", "q1", "yes"), userId: "7", chatId: "7", now: 3 }))
    .toEqual({ ok: false, reason: "stale" });
  expect(repository.sourceIsActive({ ...fence, interactionId: "int-question", turnId: "turn-1", bbThreadId: "thr-current" })).toBe(false);
  expect(repository.markResolved({ ...fence, now: 3, interactionId: "int-question", turnId: "turn-1", bbThreadId: "thr-current" })).toBe(false);
  db.prepare("UPDATE controller_interactions SET state = 'answered', answer_json = ?, answered_at = 3 WHERE interaction_id = 'int-question'")
    .run(JSON.stringify({ kind: "user_answer", answers: { q1: { selected: ["yes"] } } }));
  expect(repository.getAnswered("owner-7-controller")).toBeNull();
  expect(repository.markDelivered({ ...fence, now: 4, interactionId: "int-question", turnId: "turn-1", bbThreadId: "thr-current" })).toBe(false);
  expect(db.prepare("SELECT state, answer_json, delivered_at FROM controller_interactions WHERE interaction_id = 'int-question'").get())
    .toEqual({ state: "answered", answer_json: JSON.stringify({ kind: "user_answer", answers: { q1: { selected: ["yes"] } } }), delivered_at: null });
});

it("accepts an 800-byte Unicode interaction id through durable answer and settlement", () => {
  const { db, repository } = fixture();
  const interactionId = "🙂".repeat(200);
  const interaction = parseControllerInteraction(interactionId, {
    kind: "approval",
    subject: { kind: "file_change", writeScope: "src/controller/questions.ts" },
    availableDecisions: ["deny"],
  });
  expect([...interactionId]).toHaveLength(200);
  expect(Buffer.byteLength(interactionId, "utf8")).toBe(800);
  expect(interaction).toMatchObject({ kind: "approval", interactionId });
  if (!interaction) throw new Error("boundary interaction was not projected");

  expect(record(repository, interaction)).toBe(true);
  expect(repository.getPending("owner-7-controller")).toMatchObject({ interactionId });
  expect(repository.answerByToken({
    token: threadDecisionToken(interactionId, "deny"), userId: "7", chatId: "7", now: 3,
  })).toMatchObject({ ok: true, interactionId });
  expect(repository.getAnswered("owner-7-controller")).toMatchObject({ interactionId });
  expect(repository.sourceIsActive({
    ...fence, now: 4, interactionId, turnId: "turn-1", bbThreadId: "thr-current",
  })).toBe(true);
  expect(repository.markDelivered({
    ...fence, now: 4, interactionId, turnId: "turn-1", bbThreadId: "thr-current",
  })).toBe(true);
  expect(db.prepare("SELECT state, delivered_at FROM controller_interactions WHERE interaction_id = ?").get(interactionId))
    .toEqual({ state: "delivered", delivered_at: 4 });
});

it("accepts an 800-byte Unicode interaction id through external resolution settlement", () => {
  const { db, repository } = fixture();
  const externallyResolvedId = "🌍".repeat(200);
  const externallyResolved = parseControllerInteraction(externallyResolvedId, { kind: "plugin" });
  if (!externallyResolved) throw new Error("resolved boundary interaction was not projected");
  expect(record(repository, externallyResolved, "turn-1", 5)).toBe(true);
  expect(repository.markResolved({
    ...fence, now: 6, interactionId: externallyResolvedId, turnId: "turn-1", bbThreadId: "thr-current",
  })).toBe(true);
  expect(db.prepare("SELECT state, delivered_at FROM controller_interactions WHERE interaction_id = ?").get(externallyResolvedId))
    .toEqual({ state: "delivered", delivered_at: 6 });
});

it("rejects interaction ids above the code-point and UTF-8 byte limits at every repository boundary", () => {
  const { db, repository } = fixture();
  const interactionId = "🙂".repeat(201);
  const interaction = {
    kind: "unsupported" as const,
    interactionId,
    metadata: { sourceKind: "plugin" },
  };
  expect([...interactionId]).toHaveLength(201);
  expect(Buffer.byteLength(interactionId, "utf8")).toBeGreaterThan(800);
  expect(parseControllerInteraction(interactionId, { kind: "plugin" })).toBeNull();
  expect(record(repository, interaction)).toBe(false);
  expect(db.prepare("SELECT COUNT(*) AS count FROM controller_interactions").get()).toEqual({ count: 0 });
  db.prepare(
    `INSERT INTO controller_interactions
       (interaction_id, turn_id, controller_key, bb_thread_id, controller_generation_id, kind, payload_json, state, asked_at)
     VALUES (?, 'turn-1', 'owner-7-controller', 'thr-current', 'gen-current', 'unsupported', ?, 'pending', 2)`,
  ).run(interactionId, JSON.stringify(interaction));
  expect(repository.sourceIsActive({
    ...fence, interactionId, turnId: "turn-1", bbThreadId: "thr-current",
  })).toBe(false);
  expect(repository.markResolved({
    ...fence, interactionId, turnId: "turn-1", bbThreadId: "thr-current",
  })).toBe(false);
  expect(repository.markDelivered({
    ...fence, interactionId, turnId: "turn-1", bbThreadId: "thr-current",
  })).toBe(false);
  expect(db.prepare("SELECT state, delivered_at FROM controller_interactions WHERE interaction_id = ?").get(interactionId))
    .toEqual({ state: "pending", delivered_at: null });
});

it("reconstructs pending repository state after closing and reopening file-backed SQLite", () => {
  const directory = mkdtempSync(resolve(".task10-interaction-restart-"));
  let db: Database.Database | undefined;
  try {
    const seeded = seededRaceDatabase(directory);
    db = seeded.db;
    db.close();
    db = new Database(seeded.databasePath);
    db.pragma("foreign_keys = ON");
    const reopened = new ControllerInteractionRepository(db);
    expect(reopened.getPending("owner-7-controller")).toMatchObject({
      interactionId: "int-question",
      state: "pending",
      answer: null,
    });
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("persists a canonical partial button answer before the terminal question", () => {
  const { db, repository } = fixture();
  const twoQuestions = {
    ...question,
    questions: [question.questions[0]!, { ...question.questions[0]!, id: "q2" }],
  };
  expect(record(repository, twoQuestions)).toBe(true);
  expect(repository.answerByToken({ token: questionOptionToken("int-question", "q1", "yes"), userId: "7", chatId: "7", now: 3 }))
    .toMatchObject({ ok: true, interactionId: "int-question" });
  expect(db.prepare("SELECT state, answer_json, answered_at FROM controller_interactions WHERE interaction_id = 'int-question'").get())
    .toEqual({
      state: "pending",
      answer_json: JSON.stringify({ kind: "user_answer", answers: { q1: { selected: ["yes"] } } }),
      answered_at: null,
    });
  expect(repository.getPending("owner-7-controller")).toMatchObject({ state: "pending" });
});

it("does not bind a record unless the submitted turn is held by the exact executor lease", () => {
  const { db, repository } = fixture();
  db.prepare("UPDATE controller_turns SET lease_owner = 'other', lease_generation = 2 WHERE id = 'turn-1'").run();
  expect(record(repository)).toBe(false);
});

it("revalidates a new lifecycle source before its interaction exists", () => {
  const { db, repository } = fixture();
  expect(repository.sourceCanRecord({ ...fence, turnId: "turn-1", controllerKey: "owner-7-controller", bbThreadId: "thr-current", controllerGenerationId: "gen-current" })).toBe(true);
  db.prepare("UPDATE executor_lease SET generation = 2 WHERE singleton = 1").run();
  expect(repository.sourceCanRecord({ ...fence, turnId: "turn-1", controllerKey: "owner-7-controller", bbThreadId: "thr-current", controllerGenerationId: "gen-current" })).toBe(false);
});

it("accepts only an identical duplicate lifecycle replay", () => {
  const { repository } = fixture();
  expect(record(repository)).toBe(true);
  expect(record(repository)).toBe(true);
  expect(record(repository, { ...question, questions: [{ ...question.questions[0]!, prompt: "different" }] })).toBe(false);
});

it("does not persist an unsafe approval sentinel supplied outside the parser", () => {
  const { db, repository } = fixture();
  expect(record(repository, { kind: "approval", interactionId: "unsafe", summary: "wants to run:\n\n`TOKEN=secret`", decisions: ["deny"] })).toBe(false);
  expect(db.prepare("SELECT COUNT(*) AS count FROM controller_interactions").get()).toEqual({ count: 0 });
});

it("does not let a token or free text skip the oldest pending interaction", () => {
  const { repository } = fixture();
  expect(record(repository, { kind: "approval", interactionId: "older", summary: "wants to write a protected path", decisions: ["deny"] }, "turn-1", 1)).toBe(true);
  expect(record(repository, question, "turn-1", 2)).toBe(true);
  expect(repository.answerByToken({ token: questionOptionToken("int-question", "q1", "yes"), userId: "7", chatId: "7", now: 3 })).toEqual({ ok: false, reason: "stale" });
  expect(repository.answerWithText({ controllerKey: "owner-7-controller", userId: "7", chatId: "7", text: "yes", now: 3 })).toEqual({ ok: false, reason: "stale" });
});

it.each([
  ["malformed JSON", "{"],
  ["a mismatched interaction id", JSON.stringify({ ...question, interactionId: "other" })],
  ["a mismatched row kind", JSON.stringify({ ...question, kind: "approval", summary: "safe", decisions: ["deny"] })],
  ["a forbidden persisted session decision", JSON.stringify({ kind: "approval", interactionId: "int-question", summary: "safe", decisions: ["allow_for_session"] })],
])("fails closed before owner mutation for %s", (_scenario, payloadJson) => {
  const { db, repository } = fixture();
  expect(record(repository)).toBe(true);
  db.prepare("UPDATE controller_interactions SET payload_json = ? WHERE interaction_id = 'int-question'").run(payloadJson);

  expect(repository.getPending("owner-7-controller")).toBeNull();
  expect(repository.answerWithText({ controllerKey: "owner-7-controller", userId: "7", chatId: "7", text: "answer", now: 3 }))
    .toEqual({ ok: false, reason: "stale" });
  expect(db.prepare("SELECT state, answer_json, answered_at FROM controller_interactions WHERE interaction_id = 'int-question'").get())
    .toEqual({ state: "pending", answer_json: null, answered_at: null });
});

it.each([
  ["pending answer with answered timestamp", "pending", JSON.stringify({ decision: "deny" }), 3, null],
  ["answered row without an answer", "answered", null, 3, null],
  ["answered timestamp before asked", "answered", JSON.stringify({ kind: "user_answer", answers: { q1: { selected: ["yes"] } } }), 1, null],
  ["delivered row without delivery timestamp", "delivered", JSON.stringify({ kind: "user_answer", answers: { q1: { selected: ["yes"] } } }), 3, null],
])("rejects inconsistent persisted lifecycle: %s", (_scenario, state, answerJson, answeredAt, deliveredAt) => {
  const { db, repository } = fixture();
  expect(record(repository)).toBe(true);
  db.prepare("UPDATE controller_interactions SET state = ?, answer_json = ?, answered_at = ?, delivered_at = ? WHERE interaction_id = 'int-question'")
    .run(state, answerJson, answeredAt, deliveredAt);

  expect(repository.getPending("owner-7-controller")).toBeNull();
  expect(repository.getAnswered("owner-7-controller")).toBeNull();
});

it("rejects a delivered row with only half of its nullable source identity", () => {
  const { db, repository } = fixture();
  expect(record(repository)).toBe(true);
  expect(repository.markResolved({ ...fence, now: 3, interactionId: "int-question", turnId: "turn-1", bbThreadId: "thr-current" })).toBe(true);
  db.prepare("UPDATE controller_interactions SET controller_generation_id = NULL WHERE interaction_id = 'int-question'").run();

  expect(repository.getPending("owner-7-controller")).toBeNull();
  expect(repository.getAnswered("owner-7-controller")).toBeNull();
  expect(repository.markResolved({ ...fence, now: 4, interactionId: "int-question", turnId: "turn-1", bbThreadId: "thr-current" })).toBe(false);
});

it.each([
  ["malformed answer JSON", "{"],
  ["session approval answer", JSON.stringify({ decision: "allow_for_session", grantedPermissions: null })],
  ["answer for the wrong interaction kind", JSON.stringify({ decision: "deny" })],
])("fails closed on %s", (_scenario, answerJson) => {
  const { db, repository } = fixture();
  expect(record(repository)).toBe(true);
  db.prepare("UPDATE controller_interactions SET state = 'answered', answer_json = ?, answered_at = 3 WHERE interaction_id = 'int-question'").run(answerJson);
  expect(repository.getAnswered("owner-7-controller")).toBeNull();
  expect(repository.markDelivered({ ...fence, now: 4, interactionId: "int-question", turnId: "turn-1", bbThreadId: "thr-current" })).toBe(false);
  expect(db.prepare("SELECT state, delivered_at FROM controller_interactions WHERE interaction_id = 'int-question'").get())
    .toEqual({ state: "answered", delivered_at: null });
});

it.each([
  ["inactive controller", "UPDATE controller_threads SET state = 'revoked'"],
  ["wrong active thread", "UPDATE controller_threads SET bb_thread_id = 'thr-other'"],
  ["closed generation", "UPDATE controller_generations SET ended_at = 2"],
  ["expired lease", "UPDATE executor_lease SET lease_expires_at = 2"],
])("sourceCanRecord rejects an %s", (_scenario, mutation) => {
  const { db, repository } = fixture();
  db.exec(mutation);
  expect(repository.sourceCanRecord({ ...fence, turnId: "turn-1", controllerKey: "owner-7-controller", bbThreadId: "thr-current", controllerGenerationId: "gen-current" })).toBe(false);
});

it("rejects a source when a second open generation makes ownership ambiguous", () => {
  const { db, repository } = fixture();
  db.prepare("INSERT INTO controller_generations (id, controller_key, thread_id, started_at) VALUES ('gen-other', 'owner-7-controller', 'thr-current', 2)").run();
  expect(repository.sourceCanRecord({ ...fence, turnId: "turn-1", controllerKey: "owner-7-controller", bbThreadId: "thr-current", controllerGenerationId: "gen-current" })).toBe(false);
});

it.each([
  ["button versus button", "button", "button"],
  ["button versus free text", "button", "text"],
] as const)("persists exactly one durable answer in a real %s race", async (_scenario, firstOperation, secondOperation) => {
  const directory = mkdtempSync(resolve(".task10-interaction-race-"));
  const barrierDir = resolve(directory, "barriers");
  const scriptPath = resolve(directory, "race-worker.ts");
  let db: Database.Database | undefined;
  const workers: ReturnType<typeof startRaceWorker>[] = [];
  try {
    const seeded = seededRaceDatabase(directory);
    db = seeded.db;
    db.close();
    db = undefined;
    mkdirSync(barrierDir);
    writeFileSync(scriptPath, raceWorkerSource());
    const buttonToken = questionOptionToken("int-question", "q1", "yes");
    workers.push(
      startRaceWorker(scriptPath, seeded.databasePath, barrierDir, "0", firstOperation, buttonToken),
      startRaceWorker(scriptPath, seeded.databasePath, barrierDir, "1", secondOperation, secondOperation === "text" ? "typed answer" : buttonToken),
    );
    await Promise.all(workers.map((_, index) => waitForFile(resolve(barrierDir, `ready-${index}`))));
    writeFileSync(resolve(barrierDir, "go"), "go");
    await Promise.all(workers.map((_, index) => waitForFile(resolve(barrierDir, `attempting-${index}`))));
    await Promise.race(workers.map((_, index) => waitForFile(resolve(barrierDir, `entered-${index}`))));
    writeFileSync(resolve(barrierDir, "release"), "release");

    const answers = await Promise.all(workers.map((worker) => worker.answer));
    expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
    db = new Database(seeded.databasePath);
    const durable = db.prepare("SELECT state, answer_json, answered_at FROM controller_interactions WHERE interaction_id = 'int-question'").get() as { state: string; answer_json: string; answered_at: number };
    expect(durable.state).toBe("answered");
    expect(durable.answered_at).toBe(3);
    expect(JSON.parse(durable.answer_json)).toEqual(answers.find((answer) => answer.ok)!.resolution);
  } finally {
    for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill("SIGKILL");
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
