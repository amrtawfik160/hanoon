import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { JobEffect, StoredEffect } from "../src/domain/models";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { EffectRunner } from "../src/services/effect-runner";
import {
  runJobExecutorService,
  type JobExecutorDependencies,
} from "../src/services/job-executor-service";

let fixtureNumber = 0;

function fixture(): { store: TelegramAgentStore; db: Database.Database } {
  const { bb } = createFakePluginHost({ pluginId: `telegram-agent-task10-executor-${fixtureNumber++}` });
  return {
    store: openStore(bb.storage, {
      async get() { return undefined; },
      async set() {},
      async delete() {},
      async list() { return []; },
    }),
    db: bb.storage.database(),
  };
}

function insertJobAndOutbox(store: TelegramAgentStore, db: Database.Database): void {
  const job = store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "work", now: 1_000 });
  store.enqueueOutbox({ logicalKey: `job:${job.id}:status`, chatId: "70", payload: { text: "initial" } }, 1_000);
  db.prepare("UPDATE jobs SET status_message_id = NULL WHERE id = ?").run(job.id);
}

describe("singleton job executor", () => {
  it("delivers one status message and edits the same message on the next desired state", async () => {
    const { store, db } = fixture();
    insertJobAndOutbox(store, db);
    const abort = new AbortController();
    const sent: Array<Record<string, unknown>> = [];
    const edited: Array<Record<string, unknown>> = [];
    let sleepCount = 0;
    const deps: JobExecutorDependencies = {
      store,
      clock: { now: () => 1_000 + sleepCount * 5_000 },
      sleep: vi.fn(async () => {
        sleepCount += 1;
        if (sleepCount === 1) {
          store.enqueueOutbox({ logicalKey: "job:job_1:status", chatId: "70", messageId: 101, payload: { text: "updated" } }, 1_001);
        } else abort.abort();
      }),
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 }),
      telegram: () => ({
        sendMessage: vi.fn(async (_chatId: string, payload: Record<string, unknown>) => {
          sent.push(payload);
          return { message_id: 101 };
        }),
        editMessage: vi.fn(async (_chatId: string, _messageId: number, payload: Record<string, unknown>) => {
          edited.push(payload);
        }),
        answerCallback: vi.fn(async () => undefined),
      }),
    };

    await runJobExecutorService(deps, abort.signal);

    expect(sent).toEqual([{ text: "initial" }]);
    expect(edited).toEqual([{ text: "updated" }]);
    expect(store.getJob("job_1")?.statusMessageId).toBe(101);
    expect(db.prepare("SELECT status, message_id FROM outbox WHERE logical_key = 'job:job_1:status'").get()).toEqual({
      status: "sent",
      message_id: 101,
    });
  });

  it("runs claimed effects sequentially and never runs a second instance after a lease loss", async () => {
    const { store, db } = fixture();
    store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "work", now: 1_000 });
    const effects: JobEffect[] = [
      { idempotencyKey: "job_1:2:one", jobId: "job_1", kind: "render_status", payload: {} },
      { idempotencyKey: "job_1:3:two", jobId: "job_1", kind: "render_status", payload: {} },
    ];
    for (const effect of effects) {
      db.prepare(
        `INSERT INTO effects (idempotency_key, job_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 0, 1000, 1000, 1000)`,
      ).run(effect.idempotencyKey, effect.jobId, effect.kind, JSON.stringify(effect.payload));
    }
    const abort = new AbortController();
    const order: string[] = [];
    let sleepCount = 0;
    const deps: JobExecutorDependencies = {
      store,
      clock: { now: () => 1_000 },
      sleep: vi.fn(async () => { sleepCount += 1; abort.abort(); }),
      effectRunnerFactory: (fence) => {
        const runner = new EffectRunner({ store, fence, now: () => 1_000 });
        return { run: async (effect: StoredEffect) => { order.push(effect.idempotencyKey); await runner.run(effect); } };
      },
    };
    await runJobExecutorService(deps, abort.signal);

    expect(order).toEqual(["job_1:2:one", "job_1:3:two"]);
    expect(db.prepare("SELECT status FROM effects ORDER BY idempotency_key").all()).toEqual([
      { status: "done" },
      { status: "done" },
    ]);
    expect(sleepCount).toBe(1);
    expect(store.acquireExecutorLease("other", 1_000, 30_000)).toEqual({ acquired: false });
  });

  it("does not complete an effect after the singleton lease is genuinely lost", async () => {
    const { store, db } = fixture();
    store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "work", now: 1_000 });
    db.prepare(
      `INSERT INTO effects (idempotency_key, job_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES ('job_1:2:one', 'job_1', 'render_status', '{}', 'pending', 0, 1000, 1000, 1000)`,
    ).run();
    const abort = new AbortController();
    let runCount = 0;
    const deps: JobExecutorDependencies = {
      store,
      clock: { now: () => 1_000 },
      sleep: vi.fn(async () => abort.abort()),
      effectRunnerFactory: (fence) => ({
        run: async () => {
          runCount += 1;
          expect(store.acquireExecutorLease("successor", 31_001, 30_000)).toEqual({ acquired: true, generation: 2 });
          await new EffectRunner({ store, fence, now: () => 31_001 }).run({
            idempotencyKey: "job_1:2:one",
            jobId: "job_1",
            kind: "render_status",
            payload: {},
            status: "leased",
            attempts: 1,
            leaseOwner: fence.ownerId,
            leaseGeneration: fence.generation,
            leaseExpiresAt: 31_000,
            nextAttemptAt: 1_000,
            lastError: null,
            createdAt: 1_000,
            updatedAt: 1_000,
          });
        },
      }),
    };

    await runJobExecutorService(deps, abort.signal);

    expect(runCount).toBe(1);
    expect(db.prepare("SELECT status, lease_owner FROM effects WHERE idempotency_key = 'job_1:2:one'").get()).toEqual({
      status: "leased",
      lease_owner: expect.any(String),
    });
  });

  it("dead-letters schema and idempotency conflicts without transient retries", async () => {
    const { store, db } = fixture();
    store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "work", now: 1_000 });
    db.prepare(
      `INSERT INTO effects (idempotency_key, job_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES ('job_1:2:one', 'job_1', 'render_status', '{}', 'pending', 0, 1000, 1000, 1000)`,
    ).run();
    const abort = new AbortController();
    const conflict = Object.assign(new Error("duplicate idempotency key"), { name: "IdempotencyConflictError" });
    const deps: JobExecutorDependencies = {
      store,
      clock: { now: () => 1_000 },
      sleep: vi.fn(async () => abort.abort()),
      effectRunnerFactory: () => ({ run: async () => { throw conflict; } }),
    };

    await runJobExecutorService(deps, abort.signal);

    expect(db.prepare("SELECT status, attempts FROM effects WHERE idempotency_key = 'job_1:2:one'").get()).toEqual({
      status: "dead",
      attempts: 1,
    });
  });

  it("releases the singleton lease on an explicit clean shutdown", async () => {
    const { store } = fixture();
    const abort = new AbortController();
    const deps: JobExecutorDependencies = {
      store,
      clock: { now: () => 1_000 },
      sleep: vi.fn(async () => abort.abort()),
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 }),
      releaseOnShutdown: true,
    };
    await runJobExecutorService(deps, abort.signal);
    expect(store.acquireExecutorLease("other", 1_000, 30_000)).toEqual({ acquired: true, generation: 2 });
  });
});
