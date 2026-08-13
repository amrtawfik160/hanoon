import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { ALL_MIGRATIONS } from "../src/storage/migrations";
import {
  ControllerInteractionRepository,
  type ControllerInteraction,
} from "../src/storage/controller-interaction-repository";
import {
  ControllerInteractionService,
  type ControllerInteractionRemote,
} from "../src/controller/interaction-service";
import { controllerInteractionToken } from "../src/controller/questions";

const FENCE = { ownerId: "executor", generation: 1, now: 2_000 };

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "telegram-controller-interaction-service-"));
  const db = new Database(join(directory, "service.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  for (const migration of ALL_MIGRATIONS) db.exec(migration);
  const controllerKey = "owner-7-controller";
  const turnId = "turn_service_1";
  const threadId = "thr_service_1";
  const generationId = "gen_service_1";
  db.prepare("INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at) VALUES (1, '7', '70', 1, NULL)").run();
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
     ) VALUES (?, 1, ?, 1, 'service input', 'submitted', 'executor', 1, 2_000, 1, 2_000)`,
  ).run(turnId, controllerKey);
  db.prepare("INSERT INTO controller_generations (id, controller_key, thread_id, started_at, ended_at, end_reason) VALUES (?, ?, ?, 1, NULL, NULL)").run(generationId, controllerKey, threadId);
  db.prepare("UPDATE executor_lease SET owner_id = 'executor', generation = 1, heartbeat_at = 2_000, lease_expires_at = 30_000 WHERE singleton = 1").run();
  const repository = new ControllerInteractionRepository(db);
  const interaction: ControllerInteraction = {
    kind: "approval",
    interactionId: "service_approval",
    summary: "wants to run: npm test",
    decisions: ["allow_once", "deny"],
  };
  const source = {
    ...FENCE,
    turnId,
    controllerKey,
    bbThreadId: threadId,
    controllerGenerationId: generationId,
    interaction,
  };
  repository.record(source);
  repository.answerByToken({
    token: controllerInteractionToken(interaction.interactionId, "allow_once"),
    userId: "7",
    chatId: "70",
    now: 2_100,
  });
  return {
    db,
    directory,
    repository,
    controllerKey,
    turnId,
    threadId,
    interaction,
    service: (remote: ControllerInteractionRemote | null, resolve = vi.fn(async () => remote)) => {
      const get = vi.fn(async () => remote);
      return {
        get,
        resolve,
        service: new ControllerInteractionService({
          store: repository,
          interactions: { get, resolve },
        }),
      };
    },
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function remote(fixture: ReturnType<typeof setup>, status: string, overrides: Partial<ControllerInteractionRemote> = {}): ControllerInteractionRemote {
  return {
    id: fixture.interaction.interactionId,
    threadId: fixture.threadId,
    status,
    ...overrides,
  };
}

it("gets the exact pending interaction before resolving and marks it delivered after proof", async () => {
  const fixture = setup();
  let current = remote(fixture, "pending");
  const resolve = vi.fn(async (input: { threadId: string; interactionId: string; resolution: Record<string, unknown> }) => {
    expect(input).toEqual({
      threadId: fixture.threadId,
      interactionId: fixture.interaction.interactionId,
      resolution: { decision: "allow_once", grantedPermissions: null },
    });
    current = remote(fixture, "resolved");
    return current;
  });
  const get = vi.fn(async () => current);
  const service = new ControllerInteractionService({ store: fixture.repository, interactions: { get, resolve } });

  await expect(service.deliverAnswered(fixture.controllerKey, FENCE, AbortSignal.timeout(1_000))).resolves.toBe(true);
  expect(get).toHaveBeenCalledWith(fixture.threadId, fixture.interaction.interactionId, expect.any(AbortSignal));
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(fixture.repository.getAnswered(fixture.controllerKey)).toBeNull();
  fixture.close();
});

it.each(["resolved", "interrupted"] as const)("adopts an already-%s remote interaction without resolving again", async (status) => {
  const fixture = setup();
  const { get, resolve, service } = fixture.service(remote(fixture, status));

  await expect(service.deliverAnswered(fixture.controllerKey, FENCE, AbortSignal.timeout(1_000))).resolves.toBe(true);
  expect(get).toHaveBeenCalledTimes(1);
  expect(resolve).not.toHaveBeenCalled();
  expect(fixture.repository.getAnswered(fixture.controllerKey)).toBeNull();
  fixture.close();
});

it.each([
  ["missing", null],
  ["mismatched interaction", { id: "other", threadId: "thr_service_1", status: "pending" }],
  ["mismatched thread", { id: "service_approval", threadId: "thr_other", status: "pending" }],
  ["unknown status", { id: "service_approval", threadId: "thr_service_1", status: "unknown" }],
  ["ambiguous resolving status", { id: "service_approval", threadId: "thr_service_1", status: "resolving" }],
] as const)("leaves the durable answer for repair when the authoritative get is %s", async (_name, response) => {
  const fixture = setup();
  const { get, resolve, service } = fixture.service(response);

  await expect(service.deliverAnswered(fixture.controllerKey, FENCE, AbortSignal.timeout(1_000))).resolves.toBe(false);
  expect(get).toHaveBeenCalledTimes(1);
  expect(resolve).not.toHaveBeenCalled();
  expect(fixture.repository.getAnswered(fixture.controllerKey)).toMatchObject({ interactionId: fixture.interaction.interactionId });
  fixture.close();
});

it("keeps the answer when resolution throws after the authoritative pending read", async () => {
  const fixture = setup();
  const resolve = vi.fn(async () => { throw new Error("provider unavailable"); });
  const { get, service } = fixture.service(remote(fixture, "pending"), resolve);

  await expect(service.deliverAnswered(fixture.controllerKey, FENCE, AbortSignal.timeout(1_000))).resolves.toBe(false);
  expect(get).toHaveBeenCalledTimes(1);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(fixture.repository.getAnswered(fixture.controllerKey)).not.toBeNull();
  fixture.close();
});

it("does not contact BB from a stale executor fence", async () => {
  const fixture = setup();
  const { get, resolve, service } = fixture.service(remote(fixture, "pending"));

  await expect(service.deliverAnswered(
    fixture.controllerKey,
    { ...FENCE, generation: FENCE.generation + 1 },
    AbortSignal.timeout(1_000),
  )).resolves.toBe(false);
  expect(get).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
  expect(fixture.repository.getAnswered(fixture.controllerKey)).not.toBeNull();
  fixture.close();
});

it("does not resolve twice after a crash between BB resolution and local delivery", async () => {
  const fixture = setup();
  let current = remote(fixture, "pending");
  const resolve = vi.fn(async () => {
    current = remote(fixture, "resolved");
    fixture.db.prepare("UPDATE executor_lease SET owner_id = 'successor', generation = 2 WHERE singleton = 1").run();
    return current;
  });
  const firstGet = vi.fn(async () => current);
  const firstService = new ControllerInteractionService({
    store: fixture.repository,
    interactions: { get: firstGet, resolve },
  });
  await expect(firstService.deliverAnswered(fixture.controllerKey, FENCE, AbortSignal.timeout(1_000))).resolves.toBe(false);
  expect(resolve).toHaveBeenCalledTimes(1);

  const successorFence = { ownerId: "successor", generation: 2, now: 2_200 };
  const secondGet = vi.fn(async () => current);
  const secondService = new ControllerInteractionService({
    store: fixture.repository,
    interactions: { get: secondGet, resolve },
  });
  await expect(secondService.deliverAnswered(fixture.controllerKey, successorFence, AbortSignal.timeout(1_000))).resolves.toBe(true);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(secondGet).toHaveBeenCalledTimes(1);
  expect(fixture.repository.getAnswered(fixture.controllerKey)).toBeNull();
  fixture.close();
});
