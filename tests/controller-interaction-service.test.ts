import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { ControllerInteractionService } from "../src/controller/interaction-service";
import { parseControllerInteraction, renderQuestion, threadDecisionToken } from "../src/controller/questions";
import { ControllerInteractionRepository } from "../src/storage/controller-interaction-repository";
import { ALL_MIGRATIONS } from "../src/storage/migrations";

let deliverySequence = 0;

function deliveryFixture() {
  const { bb } = createFakePluginHost({ pluginId: `controller-delivery-${deliverySequence++}` });
  const db = bb.storage.database();
  bb.storage.migrate(db, [...ALL_MIGRATIONS]);
  db.prepare("INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at) VALUES (1, '7', '7', 1)").run();
  db.prepare("INSERT INTO controller_threads (controller_key, telegram_user_id, telegram_chat_id, state, created_at, updated_at, bb_thread_id) VALUES ('owner-7-controller', '7', '7', 'active', 1, 1, 'thread-1')").run();
  db.prepare("INSERT INTO controller_turns (id, telegram_update_id, controller_key, ordinal, input_text, state, lease_owner, lease_generation, submitted_at, created_at, updated_at) VALUES ('turn-1', 1, 'owner-7-controller', 1, 'question', 'submitted', 'executor', 1, 1, 1, 1)").run();
  db.prepare("INSERT INTO controller_generations (id, controller_key, thread_id, started_at) VALUES ('generation-1', 'owner-7-controller', 'thread-1', 1)").run();
  db.prepare("UPDATE executor_lease SET owner_id = 'executor', generation = 1, heartbeat_at = 1, lease_expires_at = 100000 WHERE singleton = 1").run();
  const repository = new ControllerInteractionRepository(db);
  const approval = { kind: "approval" as const, interactionId: "approval-1", summary: "wants to write file.ts", decisions: ["deny" as const] };
  expect(repository.record({ ownerId: "executor", generation: 1, now: 2, turnId: "turn-1", controllerKey: "owner-7-controller", bbThreadId: "thread-1", controllerGenerationId: "generation-1", interaction: approval })).toBe(true);
  expect(repository.answerByToken({ token: threadDecisionToken("approval-1", "deny"), userId: "7", chatId: "7", now: 3 })).toMatchObject({ ok: true });
  return { db, repository };
}

it("projects a safe approval while removing session approval and command credentials", () => {
  const interaction = parseControllerInteraction("approval-1", {
    kind: "approval",
    subject: { kind: "command", command: "curl https://user:secret@example.test --header 'Authorization: Bearer token'", cwd: "/private/work" },
    availableDecisions: ["allow_once", "allow_for_session", "deny"],
  });

  expect(interaction).toEqual({
    kind: "approval",
    interactionId: "approval-1",
    summary: "wants to run:\n\n`a redacted command`",
    decisions: ["allow_once", "deny"],
  });
});

it("fails closed for unsupported approvals and projects only bounded safe metadata", () => {
  expect(parseControllerInteraction("approval-2", {
    kind: "approval",
    subject: { kind: "permission_grant", permissions: { network: { enabled: true } } },
    availableDecisions: ["allow_once"],
  })).toEqual({ kind: "unsupported", interactionId: "approval-2", metadata: { sourceKind: "approval" } });
});

it("uses a basename only for safe file-change paths", () => {
  expect(parseControllerInteraction("approval-3", {
    kind: "approval",
    subject: { kind: "file_change", writeScope: "src/controller/service.ts" },
    availableDecisions: ["allow_once", "deny"],
  })).toMatchObject({ kind: "approval", summary: "wants to write service.ts" });
  expect(parseControllerInteraction("approval-4", {
    kind: "approval",
    subject: { kind: "file_change", writeScope: "/root/.env" },
    availableDecisions: ["allow_once", "deny"],
  })).toMatchObject({ kind: "approval", summary: "wants to write a protected path" });
});

it.each(["--callback-url=https://x?nonce=secret", "TOKEN=secret echo hi", "echo $HOME", "curl https://u:p@host", "curl '?%74oken=secret'", "m%253AabcdefghijklmnopqrstuvwxyzABCDEF", "%ZZ"]) (
  "redacts command material that could disclose a secret: %s", (command) => {
    const projection = parseControllerInteraction("approval-safe", { kind: "approval", subject: { kind: "command", command }, availableDecisions: ["allow_once"] });
    expect(projection).toMatchObject({ kind: "approval", summary: "wants to run:\n\n`a redacted command`" });
    expect(JSON.stringify(projection)).not.toContain("secret");
  },
);

it("rejects oversized question identifiers and option values", () => {
  expect(parseControllerInteraction("i".repeat(201), { kind: "user_question", questions: [] })).toBeNull();
  expect(parseControllerInteraction("safe", { kind: "user_question", questions: [{ id: "q".repeat(121), prompt: "question", multiSelect: false, allowFreeText: true, options: [] }] }))
    .toMatchObject({ kind: "unsupported" });
  expect(parseControllerInteraction("safe", { kind: "user_question", questions: [{ id: "q", prompt: "question", multiSelect: false, allowFreeText: false, options: [{ value: "v".repeat(121), label: "value" }] }] }))
    .toMatchObject({ kind: "unsupported" });
});

it.each([
  ["missing decisions", undefined],
  ["malformed decisions", "deny"],
  ["session-only decisions", ["allow_for_session"]],
  ["unknown decisions", ["approve"]],
])("does not synthesize approval choices for %s", (_scenario, availableDecisions) => {
  expect(parseControllerInteraction("approval-invalid", {
    kind: "approval",
    subject: { kind: "command", command: "npm test" },
    ...(availableDecisions === undefined ? {} : { availableDecisions }),
  })).toEqual({ kind: "unsupported", interactionId: "approval-invalid", metadata: { sourceKind: "approval" } });
});

it("preserves an answered row when BB resolve throws with an unknown outcome", async () => {
  const { db, repository } = deliveryFixture();
  const service = new ControllerInteractionService({
    store: repository,
    interactions: {
      get: vi.fn(async () => ({ id: "approval-1", threadId: "thread-1", status: "pending" })),
      resolve: vi.fn(async () => { throw new Error("connection lost after send"); }),
    } as never,
    clock: () => 4,
  });
  await expect(service.deliverAnswered({ ownerId: "executor", generation: 1, now: 4, controllerKey: "owner-7-controller" }))
    .rejects.toThrow("connection lost after send");
  expect(db.prepare("SELECT state, delivered_at FROM controller_interactions WHERE interaction_id = 'approval-1'").get())
    .toEqual({ state: "answered", delivered_at: null });
});

it.each([
  "/root/.env",
  "C:/Users/owner/.env",
  "C:\\Users\\owner\\.env",
  "\\\\server\\share\\file",
  "~/secret",
  "./secret",
  "src/../secret",
  "src//secret",
])("projects unsafe file path %s as protected", (writeScope) => {
  expect(parseControllerInteraction("approval-path", {
    kind: "approval",
    subject: { kind: "file_change", writeScope },
    availableDecisions: ["deny"],
  })).toMatchObject({ kind: "approval", summary: "wants to write a protected path" });
});

it("rejects question and option counts above the projection limits", () => {
  const validQuestion = { id: "q", prompt: "Choose", shortLabel: null, multiSelect: false, allowFreeText: true, options: [] };
  expect(parseControllerInteraction("too-many-questions", { kind: "user_question", questions: Array.from({ length: 5 }, (_, index) => ({ ...validQuestion, id: `q${index}` })) }))
    .toMatchObject({ kind: "unsupported" });
  expect(parseControllerInteraction("too-many-options", { kind: "user_question", questions: [{ ...validQuestion, options: Array.from({ length: 7 }, (_, index) => ({ value: `v${index}`, label: "yes", description: null })) }] }))
    .toMatchObject({ kind: "unsupported" });
});

it("bounds Unicode question projections to Telegram UTF-8 limits", () => {
  const validQuestion = { id: "q", prompt: "Choose", shortLabel: null, multiSelect: false, allowFreeText: true, options: [] };
  const parsed = parseControllerInteraction("utf8", { kind: "user_question", questions: [{
    ...validQuestion,
    prompt: "🙂".repeat(500),
    options: [{ value: "value", label: "🙂".repeat(100), description: "🙂".repeat(300) }],
  }] });
  expect(parsed).toMatchObject({ kind: "user_question" });
  if (!parsed || parsed.kind !== "user_question") throw new Error("bounded question was not projected");
  const rendered = renderQuestion(parsed.interactionId, parsed.questions[0]!);
  expect(Buffer.byteLength(rendered.text, "utf8")).toBeLessThanOrEqual(4096);
  expect(Buffer.byteLength(rendered.reply_markup.inline_keyboard[0]![0]!.text, "utf8")).toBeLessThanOrEqual(64);
  expect(Buffer.byteLength(rendered.reply_markup.inline_keyboard[0]![0]!.callback_data, "utf8")).toBeLessThanOrEqual(64);
  expect(Buffer.byteLength(`w:${threadDecisionToken("approval", "allow_once")}`, "utf8")).toBeLessThanOrEqual(64);
});

it("reads the exact BB interaction before resolving a durable answer", async () => {
  const calls: string[] = [];
  const store = {
    getAnswered: vi.fn(() => ({
      interactionId: "approval-1", turnId: "turn-1", controllerKey: "owner-7-controller",
      bbThreadId: "thread-1", controllerGenerationId: "generation-1", state: "answered",
      interaction: { kind: "approval", interactionId: "approval-1", summary: "wants to write file.ts", decisions: ["allow_once"] },
      answer: { decision: "allow_once", grantedPermissions: null }, askedAt: 1, answeredAt: 2, deliveredAt: null,
    })),
    markDelivered: vi.fn(() => true), markResolved: vi.fn(() => true),
    sourceIsActive: vi.fn(() => true),
  };
  const interactions = {
    get: vi.fn(async () => {
      calls.push("get");
      return { id: "approval-1", threadId: "thread-1", status: "pending" };
    }),
    resolve: vi.fn(async () => {
      calls.push("resolve");
      return { id: "approval-1", threadId: "thread-1", status: "resolved" };
    }),
  };
  const service = new ControllerInteractionService({
    store: store as never,
    interactions: interactions as never,
    clock: () => 3,
  });

  await expect(service.deliverAnswered({ ownerId: "executor", generation: 1, now: 2, controllerKey: "owner-7-controller" })).resolves.toBe(true);
  expect(calls).toEqual(["get", "resolve"]);
  expect(store.markDelivered).toHaveBeenCalledWith(expect.objectContaining({ interactionId: "approval-1", bbThreadId: "thread-1" }));
});

it("adopts an already resolved interaction without sending a second resolution", async () => {
  const store = {
    getAnswered: vi.fn(() => ({
      interactionId: "approval-1", turnId: "turn-1", controllerKey: "owner-7-controller",
      bbThreadId: "thread-1", controllerGenerationId: "generation-1", state: "answered",
      interaction: { kind: "approval", interactionId: "approval-1", summary: "wants to write file.ts", decisions: ["deny"] },
      answer: { decision: "deny" }, askedAt: 1, answeredAt: 2, deliveredAt: null,
    })),
    markDelivered: vi.fn(() => true), markResolved: vi.fn(() => true),
    sourceIsActive: vi.fn(() => true),
  };
  const interactions = {
    get: vi.fn(async () => ({ id: "approval-1", threadId: "thread-1", status: "resolved" })),
    resolve: vi.fn(),
  };
  const service = new ControllerInteractionService({ store: store as never, interactions: interactions as never, clock: () => 3 });

  await expect(service.deliverAnswered({ ownerId: "executor", generation: 1, now: 2, controllerKey: "owner-7-controller" })).resolves.toBe(true);
  expect(interactions.resolve).not.toHaveBeenCalled();
});

it("does no BB I/O when the durable interaction fence is stale", async () => {
  const store = {
    getAnswered: vi.fn(() => ({ interactionId: "approval-1", turnId: "turn-1", controllerKey: "owner-7-controller", bbThreadId: "thread-1", controllerGenerationId: "generation-1", state: "answered", interaction: { kind: "approval", interactionId: "approval-1", summary: "safe", decisions: ["deny"] }, answer: { decision: "deny" }, askedAt: 1, answeredAt: 2, deliveredAt: null })),
    sourceIsActive: vi.fn(() => false), markDelivered: vi.fn(() => true), markResolved: vi.fn(() => true),
  };
  const interactions = { get: vi.fn(), resolve: vi.fn() };
  const service = new ControllerInteractionService({ store: store as never, interactions: interactions as never, clock: () => 3 });
  await expect(service.deliverAnswered({ ownerId: "stale", generation: 99, now: 2, controllerKey: "owner-7-controller" })).resolves.toBe(false);
  expect(interactions.get).not.toHaveBeenCalled();
  expect(interactions.resolve).not.toHaveBeenCalled();
});

it("uses a fresh clock boundary after a slow get before resolving", async () => {
  let now = 2;
  const sourceIsActive = vi.fn(() => now < 3);
  const store = { getAnswered: vi.fn(() => ({ interactionId: "approval-1", turnId: "turn-1", controllerKey: "owner-7-controller", bbThreadId: "thread-1", controllerGenerationId: "generation-1", state: "answered", interaction: { kind: "approval", interactionId: "approval-1", summary: "safe", decisions: ["deny"] }, answer: { decision: "deny" }, askedAt: 1, answeredAt: 2, deliveredAt: null })), sourceIsActive, markDelivered: vi.fn(), markResolved: vi.fn() };
  const interactions = { get: vi.fn(async () => { now = 3; return { id: "approval-1", threadId: "thread-1", status: "pending" }; }), resolve: vi.fn() };
  const service = new ControllerInteractionService({ store: store as never, interactions: interactions as never, clock: () => now });
  await expect(service.deliverAnswered({ ownerId: "executor", generation: 1, now: 2, controllerKey: "owner-7-controller" })).resolves.toBe(false);
  expect(interactions.resolve).not.toHaveBeenCalled();
  expect(sourceIsActive).toHaveBeenLastCalledWith(expect.objectContaining({ now: 3 }));
});

it("keeps the answer durable before resolve and adopts interrupted state without resolving", async () => {
  const { db, repository } = deliveryFixture();
  const resolve = vi.fn();
  const service = new ControllerInteractionService({
    store: repository,
    interactions: { get: vi.fn(async () => {
      expect(db.prepare("SELECT state, answer_json FROM controller_interactions WHERE interaction_id = 'approval-1'").get())
        .toEqual({ state: "answered", answer_json: JSON.stringify({ decision: "deny" }) });
      return { id: "approval-1", threadId: "thread-1", status: "interrupted" };
    }), resolve } as never,
    clock: () => 4,
  });
  await expect(service.deliverAnswered({ ownerId: "executor", generation: 1, now: 4, controllerKey: "owner-7-controller" })).resolves.toBe(true);
  expect(resolve).not.toHaveBeenCalled();
  expect(db.prepare("SELECT state, delivered_at FROM controller_interactions WHERE interaction_id = 'approval-1'").get())
    .toEqual({ state: "delivered", delivered_at: 4 });
});

it.each([
  ["mismatched get", async () => ({ id: "other", threadId: "thread-1", status: "pending" }), async () => ({ id: "approval-1", threadId: "thread-1", status: "resolved" })],
  ["unknown get state", async () => ({ id: "approval-1", threadId: "thread-1", status: "resolving" }), async () => ({ id: "approval-1", threadId: "thread-1", status: "resolved" })],
  ["ambiguous resolve", async () => ({ id: "approval-1", threadId: "thread-1", status: "pending" }), async () => ({ id: "approval-1", threadId: "thread-1", status: "pending" })],
] as const)("leaves the durable answer repairable after %s", async (_scenario, get, resolve) => {
  const { db, repository } = deliveryFixture();
  const service = new ControllerInteractionService({ store: repository, interactions: { get: vi.fn(get), resolve: vi.fn(resolve) } as never, clock: () => 4 });
  await expect(service.deliverAnswered({ ownerId: "executor", generation: 1, now: 4, controllerKey: "owner-7-controller" })).resolves.toBe(false);
  expect(db.prepare("SELECT state, delivered_at FROM controller_interactions WHERE interaction_id = 'approval-1'").get())
    .toEqual({ state: "answered", delivered_at: null });
});

it("recovers after a crash boundary following successful BB resolve without resolving twice", async () => {
  const { db, repository } = deliveryFixture();
  expect(repository.record({ ownerId: "executor", generation: 1, now: 4, turnId: "turn-1", controllerKey: "owner-7-controller", bbThreadId: "thread-1", controllerGenerationId: "generation-1", interaction: { kind: "unsupported", interactionId: "later", metadata: { sourceKind: "plugin" } } })).toBe(true);
  const resolve = vi.fn(async () => {
    db.prepare("UPDATE executor_lease SET owner_id = 'successor', generation = 2, lease_expires_at = 100000 WHERE singleton = 1").run();
    db.prepare("UPDATE controller_turns SET lease_owner = 'successor', lease_generation = 2 WHERE id = 'turn-1'").run();
    return { id: "approval-1", threadId: "thread-1", status: "resolved" };
  });
  const firstService = new ControllerInteractionService({
    store: repository,
    interactions: { get: vi.fn(async () => ({ id: "approval-1", threadId: "thread-1", status: "pending" })), resolve } as never,
    clock: () => 4,
  });
  await expect(firstService.deliverAnswered({ ownerId: "executor", generation: 1, now: 4, controllerKey: "owner-7-controller" })).resolves.toBe(false);
  expect(db.prepare("SELECT state FROM controller_interactions WHERE interaction_id = 'approval-1'").get()).toEqual({ state: "answered" });

  const reopened = new ControllerInteractionRepository(db);
  const retryResolve = vi.fn();
  const retryService = new ControllerInteractionService({
    store: reopened,
    interactions: { get: vi.fn(async () => ({ id: "approval-1", threadId: "thread-1", status: "resolved" })), resolve: retryResolve } as never,
    clock: () => 5,
  });
  await expect(retryService.deliverAnswered({ ownerId: "successor", generation: 2, now: 5, controllerKey: "owner-7-controller" })).resolves.toBe(true);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(retryResolve).not.toHaveBeenCalled();
  expect(db.prepare("SELECT state FROM controller_interactions WHERE interaction_id = 'approval-1'").get()).toEqual({ state: "delivered" });
  expect(db.prepare("SELECT awaiting_interaction_id FROM controller_turns WHERE id = 'turn-1'").get()).toEqual({ awaiting_interaction_id: "later" });
});
