import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { JobEffect } from "../src/domain/models";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { policyFixture } from "./helpers";
import {
  EffectRunner,
  PermanentEffectError,
  retryDelay,
  type EffectRunnerDependencies,
} from "../src/services/effect-runner";

let fixtureNumber = 0;

function storeFixture(): { store: TelegramAgentStore; db: Database.Database } {
  const { bb } = createFakePluginHost({ pluginId: `telegram-agent-task10-effect-${fixtureNumber++}` });
  const db = bb.storage.database();
  const store = openStore(bb.storage, {
    async get() { return undefined; },
    async set() {},
    async delete() {},
    async list() { return []; },
  });
  return { store, db };
}

function addJobEffect(store: TelegramAgentStore, db: Database.Database, effect: JobEffect): void {
  store.createJob({ id: effect.jobId, sourceUpdateId: 1, requestText: "work", now: 1_000 });
  db.prepare(
    `INSERT INTO effects (idempotency_key, job_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
  ).run(effect.idempotencyKey, effect.jobId, effect.kind, JSON.stringify(effect.payload), 1_000, 1_000, 1_000);
}

function fence(store: TelegramAgentStore, now = 1_000): { ownerId: string; generation: number } {
  const lease = store.acquireExecutorLease("owner-a", now, 100);
  if (!lease.acquired) throw new Error("lease was not acquired");
  return { ownerId: "owner-a", generation: lease.generation };
}

describe("leased effect execution", () => {
  it("allows exactly one executor generation to win a race", () => {
    const first = storeFixture();
    const one = first.store.acquireExecutorLease("one", 1_000, 30_000);
    const two = first.store.acquireExecutorLease("two", 1_000, 30_000);

    expect(one).toEqual({ acquired: true, generation: 1 });
    expect(two).toEqual({ acquired: false });
  });

  it("fences an expired owner before a successor can mutate a claimed effect", () => {
    const { store, db } = storeFixture();
    const effect: JobEffect = {
      idempotencyKey: "job_1:2:render_status",
      jobId: "job_1",
      kind: "render_status",
      payload: {},
    };
    addJobEffect(store, db, effect);
    const first = fence(store);
    const claimed = store.leaseEffects(first.ownerId, first.generation, 1_000, 1, 100);
    expect(claimed).toHaveLength(1);
    expect(store.acquireExecutorLease("owner-b", 1_101, 100)).toEqual({ acquired: true, generation: 2 });
    expect(store.renewExecutorLease(first.ownerId, first.generation, 1_102, 100)).toBe(false);
    expect(store.completeEffect(effect.idempotencyKey, first.ownerId, first.generation, 1_102)).toBe(false);
    expect(store.leaseEffects("owner-b", 2, 1_102, 1, 100)[0]).toMatchObject({
      idempotencyKey: effect.idempotencyKey,
      attempts: 2,
      leaseOwner: "owner-b",
      leaseGeneration: 2,
    });
  });

  it.each([
    [1, 0, 500],
    [20, 250, 30_250],
  ])("uses capped jittered retry delay for attempt %s", (attempts, jitter, expected) => {
    expect(retryDelay(attempts, () => jitter)).toBe(expected);
  });

  it("dead-letters the twentieth transient failure and blocks the owning job", () => {
    const { store, db } = storeFixture();
    const effect: JobEffect = {
      idempotencyKey: "job_1:2:render_status",
      jobId: "job_1",
      kind: "render_status",
      payload: {},
    };
    addJobEffect(store, db, effect);
    const current = fence(store);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const claimed = store.leaseEffects(current.ownerId, current.generation, 1_000 + attempt, 1, 100);
      expect(claimed).toHaveLength(1);
      if (attempt === 19) {
        expect(store.failEffect(effect.idempotencyKey, current.ownerId, current.generation, "bounded failure", 1_020, 1_020)).toBe(true);
      } else {
        expect(store.failEffect(effect.idempotencyKey, current.ownerId, current.generation, "bounded failure", 1_001 + attempt, 1_000 + attempt)).toBe(true);
      }
    }
    expect(db.prepare("SELECT status, attempts FROM effects WHERE idempotency_key = ?").get(effect.idempotencyKey)).toEqual({
      status: "dead",
      attempts: 20,
    });
    expect(store.getJob("job_1")?.blockedReason).toBe("permanent_effect_failure");
  });

  it("dispatches Start work only through the injected BB runner after a live fence check", async () => {
    const { store, db } = storeFixture();
    const job = store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "work", now: 1_000 });
    const selected = store.applyJobEvent(job.id, job.version, {
      type: "PROJECT_SELECTED", projectId: "proj_1", policyVersion: 1, policy: policyFixture(),
    }, 1_001);
    store.applyJobEvent(job.id, selected.version, { type: "CONFIRMED" }, 1_002);
    const effect = store.listEffectsForJob(job.id).find((item) => item.kind === "spawn_implementation");
    if (!effect) throw new Error("spawn effect missing");
    const lease = store.acquireExecutorLease("owner-a", 1_003, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    const claimed = store.leaseEffects("owner-a", lease.generation, 1_003, 10, 30_000)
      .find((item) => item.idempotencyKey === effect.idempotencyKey);
    if (!claimed) throw new Error("spawn effect was not leased");
    const spawnImplementation = vi.fn(async () => ({ id: "thr_impl", environmentId: "env_1" }));
    const deps = {
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      bb: { spawnImplementation },
      now: () => 1_004,
    } satisfies EffectRunnerDependencies;

    const runner = new EffectRunner(deps);
    await runner.run(claimed);

    expect(spawnImplementation).toHaveBeenCalledTimes(1);
    expect(store.getJob(job.id)?.implementationThreadId).toBe("thr_impl");
    expect(db.prepare("SELECT COUNT(*) AS count FROM effects WHERE kind = 'spawn_implementation'").get()).toEqual({ count: 1 });
  });

  it("does not invoke BB after the executor fence is lost", async () => {
    const { store, db } = storeFixture();
    const job = store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "work", now: 1_000 });
    const selected = store.applyJobEvent(job.id, job.version, {
      type: "PROJECT_SELECTED", projectId: "proj_1", policyVersion: 1, policy: policyFixture(),
    }, 1_001);
    store.applyJobEvent(job.id, selected.version, { type: "CONFIRMED" }, 1_002);
    const effect = store.listEffectsForJob(job.id).find((item) => item.kind === "spawn_implementation");
    if (!effect) throw new Error("spawn effect missing");
    const first = store.acquireExecutorLease("owner-a", 1_003, 100);
    if (!first.acquired) throw new Error("lease missing");
    const claimed = store.leaseEffects("owner-a", first.generation, 1_003, 10, 100)
      .find((item) => item.idempotencyKey === effect.idempotencyKey);
    if (!claimed) throw new Error("spawn effect was not leased");
    expect(store.acquireExecutorLease("owner-b", 1_104, 100)).toEqual({ acquired: true, generation: 2 });
    const spawnImplementation = vi.fn(async () => ({ id: "thr_impl", environmentId: "env_1" }));

    await expect(new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: first.generation, signal: new AbortController().signal },
      bb: { spawnImplementation },
      now: () => 1_105,
    }).run(claimed)).rejects.toThrow("executor lease was lost");

    expect(spawnImplementation).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status, lease_owner, lease_generation FROM effects WHERE idempotency_key = ?").get(effect.idempotencyKey)).toEqual({
      status: "leased",
      lease_owner: "owner-a",
      lease_generation: 1,
    });
  });

  it("classifies unknown effect kinds as permanent failures", async () => {
    const { store, db } = storeFixture();
    const effect = {
      idempotencyKey: "job_1:2:future_effect",
      jobId: "job_1",
      kind: "future_effect",
      payload: {},
    } as unknown as JobEffect;
    addJobEffect(store, db, effect);
    const current = fence(store);
    const claimed = store.leaseEffects(current.ownerId, current.generation, 1_000, 1, 100)[0];
    if (!claimed) throw new Error("effect missing");
    await expect(new EffectRunner({
      store,
      fence: { ownerId: current.ownerId, generation: current.generation, signal: new AbortController().signal },
      now: () => 1_001,
    }).run(claimed)).rejects.toBeInstanceOf(PermanentEffectError);
  });

  it("blocks cancellation when the stopped BB worker never reaches a terminal state", async () => {
    const { store, db } = storeFixture();
    const job = store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "work", now: 1_000 });
    db.prepare(
      "UPDATE jobs SET state = 'implementing', implementation_thread_id = ?, version = ?, updated_at = ? WHERE id = ?",
    ).run("thr_cancel", 2, 1_000, job.id);
    const current = store.getJob(job.id);
    if (!current) throw new Error("job missing");
    store.upsertWorkerLiveness({
      jobId: job.id,
      workerKind: "implementation",
      resourceKind: "bb_thread",
      resourceId: "thr_cancel",
      generation: current.version,
      state: "active",
      sourceUpdatedAt: 1_000,
      observedAt: 1_000,
      staleNotifiedAt: null,
    });
    const cancelled = store.applyJobEvent(job.id, current.version, {
      type: "CANCEL_REQUESTED",
      activeWorker: store.getWorkerLiveness(job.id),
    }, 1_001);
    const effect = store.listEffectsForJob(job.id).find((item) => item.kind === "stop_thread");
    if (!effect) throw new Error("stop effect missing");
    const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
    if (!lease.acquired) throw new Error("executor lease missing");
    const claimed = store.leaseEffects("owner-a", lease.generation, 1_001, 10, 30_000)
      .find((item) => item.idempotencyKey === effect.idempotencyKey);
    if (!claimed) throw new Error("stop effect was not leased");
    const controller = new AbortController();

    vi.useFakeTimers();
    try {
      const running = new EffectRunner({
        store,
        fence: { ownerId: "owner-a", generation: lease.generation, signal: controller.signal },
        bb: {
          stopWorker: vi.fn(async () => undefined),
          getThread: vi.fn(async () => ({
            id: "thr_cancel",
            projectId: "proj_1",
            environmentId: null,
            parentThreadId: null,
            title: "worker",
            status: "stopping",
            updatedAt: 1_000,
            runtime: { displayStatus: "stopping", hostReconnectGraceExpiresAt: null },
          })),
        },
        now: () => 1_001,
      }).run(claimed);
      await vi.advanceTimersByTimeAsync(750);
      await expect(running).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }

    expect(store.getJob(job.id)).toMatchObject({
      state: "blocked",
      blockedReason: "cancellation_unconfirmed",
    });
    expect(store.getWorkerLiveness(job.id)?.state).toBe("stopping");
    expect(cancelled.cancelRequestedAt).not.toBeNull();
  });
});
