import { expect, it, vi } from "vitest";
import { ControllerInteractionService } from "../src/controller/interaction-service";
import { parseControllerInteraction } from "../src/controller/questions";

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
