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
type DeliveryStage = "before-get" | "before-resolve" | "before-mark";

class LeaseLossRepository extends ControllerInteractionRepository {
  private calls = 0;

  public constructor(
    private readonly database: Database.Database,
    private readonly loseOnCall: number,
  ) {
    super(database);
  }

  public override isControllerInteractionDeliveryFenceCurrent(
    input: Parameters<ControllerInteractionRepository["isControllerInteractionDeliveryFenceCurrent"]>[0],
  ): boolean {
    this.calls += 1;
    if (this.calls === this.loseOnCall) {
      this.database.prepare("UPDATE executor_lease SET owner_id = 'successor', generation = 2 WHERE singleton = 1").run();
    }
    return super.isControllerInteractionDeliveryFenceCurrent(input);
  }
}

class DeliveryFenceRejectRepository extends ControllerInteractionRepository {
  public override isControllerInteractionDeliveryFenceCurrent(
    _input: Parameters<ControllerInteractionRepository["isControllerInteractionDeliveryFenceCurrent"]>[0],
  ): boolean {
    return false;
  }
}

class FreshFenceRepository extends ControllerInteractionRepository {
  public readonly fenceTimes: number[] = [];
  public markedFence: { now: number } | null = null;

  public override isControllerInteractionDeliveryFenceCurrent(
    input: Parameters<ControllerInteractionRepository["isControllerInteractionDeliveryFenceCurrent"]>[0],
  ): boolean {
    this.fenceTimes.push(input.now);
    return super.isControllerInteractionDeliveryFenceCurrent(input);
  }

  public override markDelivered(
    input: Parameters<ControllerInteractionRepository["markDelivered"]>[0],
  ): boolean {
    this.markedFence = input;
    return super.markDelivered(input);
  }
}

type PredicateBoundaryObservation = Readonly<{
  call: number;
  providerStatus: "pending" | "resolved" | null;
  predicateResult: boolean;
}>;

class PredicateBoundaryRepository extends ControllerInteractionRepository {
  public readonly observations: PredicateBoundaryObservation[] = [];
  private predicateCalls = 0;

  public constructor(
    database: Database.Database,
    private readonly stage: DeliveryStage,
    private readonly providerStatus: () => "pending" | "resolved" | null,
    private readonly beforePredicate: (observation: Omit<PredicateBoundaryObservation, "predicateResult">) => void,
  ) {
    super(database);
  }

  public override isControllerInteractionDeliveryFenceCurrent(
    input: Parameters<ControllerInteractionRepository["isControllerInteractionDeliveryFenceCurrent"]>[0],
  ): boolean {
    const call = ++this.predicateCalls;
    const targetCall = this.stage === "before-get" ? 1 : 2;
    const observed = { call, providerStatus: this.providerStatus() } as const;
    if (call === targetCall) this.beforePredicate(observed);
    const predicateResult = super.isControllerInteractionDeliveryFenceCurrent(input);
    this.observations.push({ ...observed, predicateResult });
    return predicateResult;
  }
}

class TransitionFenceLossRepository extends ControllerInteractionRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly turnId: string,
  ) {
    super(database);
  }

  protected override beforeExecutorInteractionTransition(): void {
    this.database.prepare(
      "UPDATE executor_lease SET owner_id = 'successor', generation = 2 WHERE singleton = 1",
    ).run();
    this.database.prepare(
      "UPDATE controller_turns SET lease_owner = 'successor', lease_generation = 2 WHERE id = ?",
    ).run(this.turnId);
  }
}

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
    dbPath: db.name,
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
          clock: { now: () => FENCE.now },
          interactions: { get, resolve },
        }),
      };
    },
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
    closeDatabase() {
      db.close();
    },
  };
}

function openIndependentDatabase(dbPath: string): Database.Database {
  const database = new Database(dbPath);
  database.pragma("busy_timeout = 5000");
  database.pragma("foreign_keys = ON");
  return database;
}

function remote(fixture: ReturnType<typeof setup>, status: string, overrides: Partial<ControllerInteractionRemote> = {}): ControllerInteractionRemote {
  return {
    id: fixture.interaction.interactionId,
    threadId: fixture.threadId,
    status,
    resolution: status === "resolved"
      ? { decision: "allow_once", grantedPermissions: null }
      : null,
    ...overrides,
  };
}

function remoteWithResolution(
  fixture: ReturnType<typeof setup>,
  status: string,
  resolution: Record<string, unknown> | null,
): ControllerInteractionRemote {
  return { ...remote(fixture, status), resolution };
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
  const service = new ControllerInteractionService({
    store: fixture.repository,
    clock: { now: () => FENCE.now },
    interactions: { get, resolve },
  });

  await expect(service.deliverAnswered(fixture.controllerKey, FENCE, AbortSignal.timeout(1_000))).resolves.toBe(true);
  expect(get).toHaveBeenCalledWith(fixture.threadId, fixture.interaction.interactionId, expect.any(AbortSignal));
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(fixture.repository.getAnswered(fixture.controllerKey)).toBeNull();
  fixture.close();
});

it("adopts an already-resolved remote interaction only with the exact durable resolution", async () => {
  const fixture = setup();
  const { get, resolve, service } = fixture.service(remote(fixture, "resolved"));

  await expect(service.deliverAnswered(fixture.controllerKey, FENCE, AbortSignal.timeout(1_000))).resolves.toBe(true);
  expect(get).toHaveBeenCalledTimes(1);
  expect(resolve).not.toHaveBeenCalled();
  expect(fixture.repository.getAnswered(fixture.controllerKey)).toBeNull();
  fixture.close();
});

it.each([
  ["interrupted", "interrupted", { decision: "allow_once", grantedPermissions: null }],
  ["resolved without a resolution", "resolved", null],
  ["resolved with a mismatched resolution", "resolved", { decision: "deny" }],
] as const)("keeps an answered interaction undelivered when BB reports %s", async (label, status, resolution) => {
  const fixture = setup();
  const observed = remoteWithResolution(fixture, status, resolution);
  const { get, resolve, service } = fixture.service(observed);

  await expect(service.deliverAnswered(fixture.controllerKey, FENCE, AbortSignal.timeout(1_000))).resolves.toBe(false);
  expect(get).toHaveBeenCalledTimes(1);
  expect(resolve).not.toHaveBeenCalled();
  expect(fixture.repository.getAnswered(fixture.controllerKey)).toMatchObject({ interactionId: fixture.interaction.interactionId });
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

it("does not contact BB when the exact delivery fence is rejected", async () => {
  const fixture = setup();
  const { get, resolve } = fixture.service(remote(fixture, "pending"));
  const repository = new DeliveryFenceRejectRepository(fixture.db);
  const service = new ControllerInteractionService({
    store: repository,
    clock: { now: () => FENCE.now },
    interactions: { get, resolve },
  });

  await expect(service.deliverAnswered(fixture.controllerKey, FENCE, AbortSignal.timeout(1_000))).resolves.toBe(false);
  expect(get).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
  expect(fixture.repository.getAnswered(fixture.controllerKey)).not.toBeNull();
  fixture.close();
});

it("does not contact BB when the delivery signal is already aborted", async () => {
  const fixture = setup();
  const { get, resolve, service } = fixture.service(remote(fixture, "pending"));
  const controller = new AbortController();
  controller.abort();

  await expect(service.deliverAnswered(fixture.controllerKey, FENCE, controller.signal)).resolves.toBe(false);
  expect(get).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
  fixture.close();
});

it("does not resolve after the delivery signal aborts during the authoritative get", async () => {
  const fixture = setup();
  const controller = new AbortController();
  const get = vi.fn(async () => {
    controller.abort();
    return remote(fixture, "pending");
  });
  const resolve = vi.fn(async () => remote(fixture, "resolved"));
  const service = new ControllerInteractionService({
    store: fixture.repository,
    clock: { now: () => FENCE.now },
    interactions: { get, resolve },
  });

  await expect(service.deliverAnswered(fixture.controllerKey, FENCE, controller.signal)).resolves.toBe(false);
  expect(get).toHaveBeenCalledTimes(1);
  expect(resolve).not.toHaveBeenCalled();
  expect(fixture.repository.getAnswered(fixture.controllerKey)).not.toBeNull();
  fixture.close();
});

it("fails closed when the fence is lost immediately before authoritative resolve", async () => {
  const fixture = setup();
  let current = remote(fixture, "pending");
  const resolve = vi.fn(async () => {
    current = remote(fixture, "resolved");
    return current;
  });
  const get = vi.fn(async () => current);
  const repository = new LeaseLossRepository(fixture.db, 2);
  const service = new ControllerInteractionService({
    store: repository,
    clock: { now: () => FENCE.now },
    interactions: { get, resolve },
  });

  await expect(service.deliverAnswered(fixture.controllerKey, FENCE, AbortSignal.timeout(1_000))).resolves.toBe(false);
  expect(resolve).not.toHaveBeenCalled();
  expect(repository.getAnswered(fixture.controllerKey)).not.toBeNull();
  fixture.close();
});

it("fails closed when the fence is lost at the repository mark-delivered transition", async () => {
  const fixture = setup();
  const { get, resolve } = fixture.service(remote(fixture, "resolved"));
  const repository = new TransitionFenceLossRepository(fixture.db, fixture.turnId);
  const service = new ControllerInteractionService({
    store: repository,
    clock: { now: () => FENCE.now },
    interactions: { get, resolve },
  });

  await expect(service.deliverAnswered(fixture.controllerKey, FENCE, AbortSignal.timeout(1_000))).resolves.toBe(false);
  expect(resolve).not.toHaveBeenCalled();
  expect(fixture.db.prepare("SELECT state FROM controller_interactions WHERE interaction_id = ?")
    .get(fixture.interaction.interactionId)).toEqual({ state: "answered" });
  expect(repository.getAnswered(fixture.controllerKey)).not.toBeNull();
  fixture.close();
});

it("keeps an ambiguous resolve available for an authoritative retry", async () => {
  const fixture = setup();
  let current = remote(fixture, "pending");
  const resolve = vi.fn(async () => remote(fixture, "resolving"));
  const first = fixture.service(current, resolve);

  await expect(first.service.deliverAnswered(fixture.controllerKey, FENCE, AbortSignal.timeout(1_000))).resolves.toBe(false);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(fixture.repository.getAnswered(fixture.controllerKey)).not.toBeNull();

  current = remote(fixture, "resolved");
  const secondGet = vi.fn(async () => current);
  const secondResolve = vi.fn(async () => current);
  const secondService = new ControllerInteractionService({
    store: fixture.repository,
    clock: { now: () => FENCE.now },
    interactions: { get: secondGet, resolve: secondResolve },
  });
  await expect(secondService.deliverAnswered(fixture.controllerKey, FENCE, AbortSignal.timeout(1_000))).resolves.toBe(true);
  expect(secondGet).toHaveBeenCalledTimes(1);
  expect(secondResolve).not.toHaveBeenCalled();
  expect(fixture.repository.getAnswered(fixture.controllerKey)).toBeNull();
  fixture.close();
});

it("recovers the durable answer after a real database close and reopen", async () => {
  const fixture = setup();
  const dbPath = fixture.dbPath;
  const directory = fixture.directory;
  fixture.closeDatabase();
  const reopened = new Database(dbPath);
  reopened.pragma("busy_timeout = 5000");
  reopened.pragma("foreign_keys = ON");
  const repository = new ControllerInteractionRepository(reopened);
  const get = vi.fn(async () => remote(fixture, "resolved"));
  const resolve = vi.fn(async () => remote(fixture, "resolved"));
  const service = new ControllerInteractionService({
    store: repository,
    clock: { now: () => FENCE.now },
    interactions: { get, resolve },
  });

  await expect(service.deliverAnswered(fixture.controllerKey, FENCE, AbortSignal.timeout(1_000))).resolves.toBe(true);
  expect(get).toHaveBeenCalledTimes(1);
  expect(resolve).not.toHaveBeenCalled();
  expect(repository.getAnswered(fixture.controllerKey)).toBeNull();
  reopened.close();
  rmSync(directory, { recursive: true, force: true });
});

it("does not resolve twice after a crash between BB resolution and local delivery", async () => {
  const fixture = setup();
  let current = remote(fixture, "pending");
  const resolve = vi.fn(async () => {
    current = remote(fixture, "resolved");
    fixture.db.prepare("UPDATE executor_lease SET owner_id = 'successor', generation = 2 WHERE singleton = 1").run();
    fixture.db.prepare("UPDATE controller_turns SET lease_owner = 'successor', lease_generation = 2 WHERE id = ?").run(fixture.turnId);
    return current;
  });
  const firstGet = vi.fn(async () => current);
  const firstService = new ControllerInteractionService({
    store: fixture.repository,
    clock: { now: () => FENCE.now },
    interactions: { get: firstGet, resolve },
  });
  await expect(firstService.deliverAnswered(fixture.controllerKey, FENCE, AbortSignal.timeout(1_000))).resolves.toBe(false);
  expect(resolve).toHaveBeenCalledTimes(1);

  const successorFence = { ownerId: "successor", generation: 2, now: 2_200 };
  const secondGet = vi.fn(async () => current);
  const secondService = new ControllerInteractionService({
    store: fixture.repository,
    clock: { now: () => successorFence.now },
    interactions: { get: secondGet, resolve },
  });
  await expect(secondService.deliverAnswered(fixture.controllerKey, successorFence, AbortSignal.timeout(1_000))).resolves.toBe(true);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(secondGet).toHaveBeenCalledTimes(1);
  expect(fixture.repository.getAnswered(fixture.controllerKey)).toBeNull();
  fixture.close();
});

it("uses one fresh final boundary timestamp for the predicate and durable delivery", async () => {
  const fixture = setup();
  const deliveryNow = 2_345;
  const repository = new FreshFenceRepository(fixture.db);
  const get = vi.fn(async () => remote(fixture, "resolved"));
  const resolve = vi.fn(async () => remote(fixture, "resolved"));
  const service = new ControllerInteractionService({
    store: repository,
    clock: { now: () => deliveryNow },
    interactions: { get, resolve },
  });

  await expect(service.deliverAnswered(fixture.controllerKey, FENCE, AbortSignal.timeout(1_000))).resolves.toBe(true);

  expect(fixture.db.prepare(
    "SELECT state, delivered_at FROM controller_interactions WHERE interaction_id = ?",
  ).get(fixture.interaction.interactionId)).toEqual({ state: "delivered", delivered_at: deliveryNow });
  expect(repository.markedFence?.now).toBe(deliveryNow);
  expect(repository.fenceTimes).toEqual([deliveryNow, deliveryNow, deliveryNow]);
  fixture.close();
});

it("fails closed when the lease expires at the fresh final delivery boundary", async () => {
  const fixture = setup();
  const secondary = openIndependentDatabase(fixture.dbPath);
  let now = 2_100;
  const get = vi.fn(async () => {
    secondary.prepare("UPDATE executor_lease SET lease_expires_at = ? WHERE singleton = 1").run(2_200);
    now = 2_200;
    return remote(fixture, "resolved");
  });
  const resolve = vi.fn(async () => remote(fixture, "resolved"));
  const service = new ControllerInteractionService({
    store: fixture.repository,
    clock: { now: () => now },
    interactions: { get, resolve },
  });

  await expect(service.deliverAnswered(fixture.controllerKey, FENCE, AbortSignal.timeout(1_000))).resolves.toBe(false);

  expect(get).toHaveBeenCalledTimes(1);
  expect(resolve).not.toHaveBeenCalled();
  expect(fixture.db.prepare(
    "SELECT state, delivered_at FROM controller_interactions WHERE interaction_id = ?",
  ).get(fixture.interaction.interactionId)).toEqual({ state: "answered", delivered_at: null });
  secondary.close();
  fixture.close();
});

const DELIVERY_STAGE_INVALIDATIONS = [
  { name: "abort", apply: () => undefined },
  {
    name: "global takeover",
    apply: (database: Database.Database) => database.prepare(
      "UPDATE executor_lease SET owner_id = 'successor', generation = 2 WHERE singleton = 1",
    ).run(),
  },
  {
    name: "global expiry",
    apply: (database: Database.Database) => database.prepare(
      "UPDATE executor_lease SET lease_expires_at = 2_100 WHERE singleton = 1",
    ).run(),
  },
  {
    name: "submitted-turn lease change",
    apply: (database: Database.Database) => database.prepare(
      "UPDATE controller_turns SET lease_owner = 'successor', lease_generation = 2 WHERE id = 'turn_service_1'",
    ).run(),
  },
  {
    name: "submitted-turn state change",
    apply: (database: Database.Database) => database.prepare(
      "UPDATE controller_turns SET state = 'completed' WHERE id = 'turn_service_1'",
    ).run(),
  },
  {
    name: "active controller state change",
    apply: (database: Database.Database) => database.prepare(
      "UPDATE controller_threads SET state = 'failed' WHERE controller_key = 'owner-7-controller'",
    ).run(),
  },
  {
    name: "active controller thread change",
    apply: (database: Database.Database) => database.prepare(
      "UPDATE controller_threads SET bb_thread_id = 'thr_other' WHERE controller_key = 'owner-7-controller'",
    ).run(),
  },
  {
    name: "generation end",
    apply: (database: Database.Database) => database.prepare(
      "UPDATE controller_generations SET ended_at = 2_100, end_reason = 'takeover' WHERE id = 'gen_service_1'",
    ).run(),
  },
  {
    name: "generation replacement",
    apply: (database: Database.Database) => {
      database.prepare(
        "UPDATE controller_generations SET ended_at = 2_100, end_reason = 'replacement' WHERE id = 'gen_service_1'",
      ).run();
      database.prepare(
        "INSERT INTO controller_generations (id, controller_key, thread_id, started_at, ended_at, end_reason) VALUES ('gen_service_2', 'owner-7-controller', 'thr_service_1', 2_101, NULL, NULL)",
      ).run();
    },
  },
  {
    name: "ambiguous open generation",
    apply: (database: Database.Database) => {
      database.exec("DROP INDEX one_open_controller_generation");
      database.prepare(
        "INSERT INTO controller_generations (id, controller_key, thread_id, started_at, ended_at, end_reason) VALUES ('gen_service_2', 'owner-7-controller', 'thr_service_1', 2_101, NULL, NULL)",
      ).run();
    },
  },
  {
    name: "answered-row identity change",
    apply: (database: Database.Database) => database.prepare(
      "UPDATE controller_interactions SET bb_thread_id = 'thr_other' WHERE interaction_id = 'service_approval'",
    ).run(),
  },
  {
    name: "answered-row state change",
    apply: (database: Database.Database) => database.prepare(
      "UPDATE controller_interactions SET state = 'pending', answered_at = NULL WHERE interaction_id = 'service_approval'",
    ).run(),
  },
] as const;

it.each(["before-get", "before-resolve", "before-mark"] as const)(
  "blocks stale or aborted delivery at the %s boundary across the full SQLite fence matrix",
  async (stage: DeliveryStage) => {
    for (const invalidation of DELIVERY_STAGE_INVALIDATIONS) {
      const fixture = setup();
      const secondary = openIndependentDatabase(fixture.dbPath);
      const controller = new AbortController();
      let providerStatus: "pending" | "resolved" | null = null;
      let hookCalls = 0;
      const repository = new PredicateBoundaryRepository(
        fixture.db,
        stage,
        () => providerStatus,
        (observation) => {
          hookCalls += 1;
          expect(observation.call).toBe(stage === "before-get" ? 1 : 2);
          expect(observation.providerStatus).toBe(stage === "before-get" ? null : stage === "before-resolve" ? "pending" : "resolved");
          secondary.prepare("SELECT 1").get();
          if (invalidation.name === "abort") controller.abort();
          else invalidation.apply(secondary);
        },
      );
      const get = vi.fn(async () => {
        const status = stage === "before-mark" ? "resolved" : "pending";
        providerStatus = status;
        return remote(fixture, status);
      });
      const resolve = vi.fn(async () => remote(fixture, "resolved"));
      const service = new ControllerInteractionService({
        store: repository,
        clock: { now: () => 2_100 },
        interactions: { get, resolve },
      });

      await expect(service.deliverAnswered(fixture.controllerKey, FENCE, controller.signal)).resolves.toBe(false);

      expect(hookCalls).toBe(1);
      expect(repository.observations).toHaveLength(stage === "before-get" ? 1 : 2);
      expect(repository.observations).toContainEqual({
        call: stage === "before-get" ? 1 : 2,
        providerStatus: stage === "before-get" ? null : stage === "before-resolve" ? "pending" : "resolved",
        predicateResult: invalidation.name === "abort",
      });
      expect(get).toHaveBeenCalledTimes(stage === "before-get" ? 0 : 1);
      expect(resolve).not.toHaveBeenCalled();
      const stored = fixture.db.prepare(
        "SELECT state, delivered_at FROM controller_interactions WHERE interaction_id = ?",
      ).get(fixture.interaction.interactionId) as { state: string; delivered_at: number | null };
      expect(stored.state).toBe(invalidation.name === "answered-row state change" ? "pending" : "answered");
      expect(stored.delivered_at).toBeNull();
      secondary.close();
      fixture.close();
    }
  },
);
