import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/storage/migrations";
import {
  ControllerInteractionRepository,
  type ControllerInteraction,
} from "../src/storage/controller-interaction-repository";
import {
  controllerInteractionToken,
  parseControllerInteraction,
  questionOptionToken,
} from "../src/controller/questions";

const SHIPPED_MIGRATION_COUNT = 29;
const CURRENT_OWNER = "executor";
const CURRENT_GENERATION = 1;
const CURRENT_NOW = 2_000;

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
      cwd: "/workspace/project",
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

function currentInteractionFixture(): CurrentFixture {
  const directory = mkdtempSync(join(tmpdir(), "telegram-controller-interactions-"));
  const dbPath = join(directory, "controller-interactions.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  try {
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

function legacyQuestionDatabaseFixture() {
  const { bb } = createFakePluginHost({ pluginId: "telegram-controller-interaction-migration" });
  const db = bb.storage.database();
  bb.storage.migrate(db, [...ALL_MIGRATIONS].slice(0, SHIPPED_MIGRATION_COUNT));
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
    insertQuestion(state: "pending" | "answered" | "delivered", interactionId = "legacy_interaction") {
      db.prepare(
        `INSERT INTO controller_questions (
           interaction_id, turn_id, controller_key, questions_json, state, answers_json, asked_at, answered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        interactionId,
        turnId,
        controllerKey,
        JSON.stringify(questionPayload().questions),
        state,
        state === "pending" ? "{}" : JSON.stringify({ question_1: { selected: ["first"] } }),
        state === "pending" ? 2_000 : 2_001,
        state === "pending" ? null : 2_002,
      );
    },
    migrateRemaining() {
      bb.storage.migrate(db, [...ALL_MIGRATIONS]);
    },
  };
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

it("pins the shipped migration bytes and appends the interaction migration", () => {
  expect(ALL_MIGRATIONS).toHaveLength(30);
  expect(createHash("sha256").update([...ALL_MIGRATIONS].slice(0, 28).join("\u0000")).digest("hex")).toBe(
    "505dfd4781117dfb2c817d31640e833370189e6b3ef2c7c24e646fb1838eed56",
  );
  expect(createHash("sha256").update(ALL_MIGRATIONS[28]).digest("hex")).toBe(
    "4ec9eb259bbdce396ac0026c13ebd84ec71f25433092827cc9aae5fe903505d3",
  );
  expect(ALL_MIGRATIONS[29]).toContain("CREATE TABLE controller_interactions");
  expect(ALL_MIGRATIONS[29]).toContain("CHECK (state = 'delivered'");
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
    answer_json: JSON.stringify({ question_1: { selected: ["first"] } }),
    delivered_at: null,
  });
  expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM controller_questions").get()).toEqual({ count: 1 });
  expect(fixture.db.prepare("SELECT awaiting_interaction_id FROM controller_turns WHERE id = ?").get(fixture.turnId))
    .toEqual({ awaiting_interaction_id: "legacy_interaction" });

  fixture.migrateRemaining();
  expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM controller_interactions").get()).toEqual({ count: 1 });
});

it("copies a delivered legacy row with null source identity", () => {
  const fixture = legacyQuestionDatabaseFixture();
  fixture.db.prepare("UPDATE controller_threads SET bb_thread_id = NULL, state = 'pending_spawn'").run();
  fixture.insertQuestion("delivered");

  fixture.migrateRemaining();

  expect(fixture.db.prepare(
    "SELECT state, bb_thread_id, controller_generation_id, delivered_at FROM controller_interactions",
  ).get()).toEqual({ state: "delivered", bb_thread_id: null, controller_generation_id: null, delivered_at: 2_002 });
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
] as const)("aborts atomically for %s legacy identity", (_name, changeSource) => {
  const fixture = legacyQuestionDatabaseFixture();
  fixture.insertQuestion("pending");
  changeSource(fixture);

  expect(() => fixture.migrateRemaining()).toThrow();
  expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM _bb_migrations").get()).toEqual({
    count: SHIPPED_MIGRATION_COUNT,
  });
  expect(fixture.db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'controller_interactions'",
  ).get()).toBeUndefined();
  expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM controller_questions").get()).toEqual({ count: 1 });
});

it("projects only safe controller approval decisions", () => {
  expect(parseControllerInteraction("approval_1", approvalPayload())).toEqual({
    kind: "approval",
    interactionId: "approval_1",
    summary: "wants to run:\n\n`npm test`\n\nin project",
    decisions: ["allow_once", "deny"],
  });
});

it.each([
  ["a credential in the middle of the command", "echo before API_KEY=secret-value && echo after", "a redacted command"],
  ["callback-shaped command material", "curl --callback https://example.test/hook?token=secret-value", "a redacted command"],
] as const)("redacts %s as a whole", (_name, command, expectedCommand) => {
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
  expect(projection).toMatchObject({ kind: "approval" });
  expect(JSON.stringify(projection)).toContain(expectedCommand);
  expect(JSON.stringify(projection)).not.toContain("before");
  expect(JSON.stringify(projection)).not.toContain("after");
  expect(JSON.stringify(projection)).not.toContain("secret-value");
  expect(JSON.stringify(projection)).not.toContain("API_TOKEN");
  expect(JSON.stringify(projection)).not.toContain("secret output");
});

it("redacts credential material beyond the bounded command summary", () => {
  const command = `${"echo safe ".repeat(60)} API_KEY=secret-value`;
  const projection = parseControllerInteraction("approval_late_secret", approvalPayload({
    subject: { kind: "command", command, cwd: "/workspace/project" },
  }));
  expect(projection).toMatchObject({ kind: "approval", summary: expect.stringContaining("a redacted command") });
  expect(JSON.stringify(projection)).not.toContain("secret-value");
});

it.each([
  ["a safe basename", "/workspace/project/src/index.ts", "index.ts"],
  ["the filesystem root", "/", "a protected path"],
  ["a traversal to a secret file", "../../.env", "a protected path"],
] as const)("confines %s to %s", (_name, writeScope, expectedPath) => {
  const projection = parseControllerInteraction("approval_path", {
    kind: "approval",
    subject: { kind: "file_change", itemId: "file_1", writeScope, sessionGrant: null },
    availableDecisions: ["allow_once", "deny"],
  });
  expect(projection).toMatchObject({ kind: "approval" });
  expect(JSON.stringify(projection)).toContain(expectedPath);
  expect(JSON.stringify(projection)).not.toContain(writeScope);
});

it.each([
  ["missing decisions", { kind: "approval", subject: { kind: "command", command: "npm test" } }],
  ["session-only decisions", approvalPayload({ availableDecisions: ["allow_for_session"] })],
  ["unknown subject shape", approvalPayload({ subject: { kind: "permission_grant" } })],
  ["empty question", { kind: "user_question", questions: [] }],
] as const)("returns an unsupported projection for %s", (_name, payload) => {
  expect(parseControllerInteraction("unsupported_1", payload)).toEqual({
    kind: "unsupported",
    interactionId: "unsupported_1",
  });
});

it("bounds oversized question values without persisting unbounded text", () => {
  const projection = parseControllerInteraction("question_oversized", questionPayload("x".repeat(401)));
  expect(projection).toMatchObject({ kind: "user_question" });
  if (!projection || projection.kind !== "user_question") return;
  expect(projection.questions[0]?.prompt).toHaveLength(400);
});

it("records one identity and keeps an older interaction as the pointer", () => {
  const fixture = currentInteractionFixture();
  const first = controllerInteraction("interaction_first");
  const second = controllerInteraction("interaction_second", "approval");

  expect(fixture.repository.record(recordInput(fixture, first, 2_000))).toBe(true);
  expect(fixture.repository.record(recordInput(fixture, second, 2_001))).toBe(true);
  expect(fixture.repository.record(recordInput(fixture, first, 2_002))).toBe(false);
  expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM controller_interactions").get()).toEqual({ count: 2 });
  expect(fixture.db.prepare("SELECT awaiting_interaction_id FROM controller_turns WHERE id = ?").get(fixture.turnId))
    .toEqual({ awaiting_interaction_id: "interaction_first" });
  expect(fixture.repository.getPending(fixture.controllerKey)).toMatchObject({ interactionId: "interaction_first" });
  closeCurrentFixture(fixture);
});

it("rejects a reused interaction id with a different source identity", () => {
  const fixture = currentInteractionFixture();
  const interaction = controllerInteraction("interaction_reused");
  expect(fixture.repository.record(recordInput(fixture, interaction))).toBe(true);
  expect(fixture.repository.record({
    ...recordInput(fixture, interaction),
    bbThreadId: "thr_other",
    controllerGenerationId: "gen_other",
  })).toBe(false);
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
  })).toBe(false);
  expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM controller_interactions").get()).toEqual({ count: 0 });
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
  fixture.repository.record(recordInput(fixture, approval, 2_000));
  fixture.repository.record(recordInput(fixture, first, 2_001));
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
