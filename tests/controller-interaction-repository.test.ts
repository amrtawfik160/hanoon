import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { questionOptionToken } from "../src/controller/questions";
import { ControllerInteractionRepository } from "../src/storage/controller-interaction-repository";
import type { ControllerInteraction } from "../src/controller/questions";
import { ALL_MIGRATIONS } from "../src/storage/migrations";

let sequence = 0;

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

it("keeps the oldest active interaction parked and promotes the next only after delivery", () => {
  const { db, repository } = fixture();
  expect(record(repository)).toBe(true);
  expect(record(repository, { ...question, interactionId: "int-later" }, "turn-1", 3)).toBe(true);
  expect(db.prepare("SELECT awaiting_interaction_id FROM controller_turns WHERE id = 'turn-1'").get()).toEqual({ awaiting_interaction_id: "int-question" });
  expect(repository.answerWithText({ controllerKey: "owner-7-controller", userId: "7", chatId: "7", text: "yes", now: 4 })).toMatchObject({ ok: true, interactionId: "int-question" });
  expect(repository.markDelivered({ ...fence, now: 5, interactionId: "int-question", turnId: "turn-1", bbThreadId: "thr-current" })).toBe(true);
  expect(db.prepare("SELECT awaiting_interaction_id FROM controller_turns WHERE id = 'turn-1'").get()).toEqual({ awaiting_interaction_id: "int-later" });
});

it("allows exactly one owner answer when a button races free text", () => {
  const { repository } = fixture();
  record(repository);
  const token = "q:" + questionOptionToken("int-question", "q1", "yes");
  const button = repository.answerByToken({ token, userId: "7", chatId: "7", now: 3 });
  const text = repository.answerWithText({ controllerKey: "owner-7-controller", userId: "7", chatId: "7", text: "other", now: 3 });
  expect([button, text].filter((answer) => answer.ok)).toHaveLength(1);
});

it("rejects stale executor identity and a revoked or mismatched owner", () => {
  const { db, repository } = fixture();
  expect(repository.record({ ...fence, generation: 2, turnId: "turn-1", controllerKey: "owner-7-controller", bbThreadId: "thr-current", controllerGenerationId: "gen-current", interaction: question })).toBe(false);
  record(repository);
  expect(repository.answerWithText({ controllerKey: "owner-7-controller", userId: "8", chatId: "7", text: "yes", now: 3 })).toEqual({ ok: false, reason: "stale" });
  db.prepare("UPDATE owners SET revoked_at = 3").run();
  expect(repository.answerWithText({ controllerKey: "owner-7-controller", userId: "7", chatId: "7", text: "yes", now: 3 })).toEqual({ ok: false, reason: "stale" });
});

it("does not bind a record unless the submitted turn is held by the exact executor lease", () => {
  const { db, repository } = fixture();
  db.prepare("UPDATE controller_turns SET lease_owner = 'other', lease_generation = 2 WHERE id = 'turn-1'").run();
  expect(record(repository)).toBe(false);
});

it("does not let a token or free text skip the oldest pending interaction", () => {
  const { repository } = fixture();
  expect(record(repository, { kind: "approval", interactionId: "older", summary: "safe", decisions: ["deny"] }, "turn-1", 1)).toBe(true);
  expect(record(repository, question, "turn-1", 2)).toBe(true);
  expect(repository.answerByToken({ token: questionOptionToken("int-question", "q1", "yes"), userId: "7", chatId: "7", now: 3 })).toEqual({ ok: false, reason: "stale" });
  expect(repository.answerWithText({ controllerKey: "owner-7-controller", userId: "7", chatId: "7", text: "yes", now: 3 })).toEqual({ ok: false, reason: "stale" });
});
