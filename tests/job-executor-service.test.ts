import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import type { JobEffect, StoredEffect } from "../src/domain/models";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { EffectRunner } from "../src/services/effect-runner";
import {
  runJobExecutorService,
  type JobExecutorDependencies,
} from "../src/services/job-executor-service";
import { TelegramApiError } from "../src/telegram/errors";
import { TelegramPresenceCoordinator } from "../src/services/telegram-presence";

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

function addSubmittedControllerTurn(store: TelegramAgentStore): void {
  store.createPairingCode(hashSecret("presence-pair"), 1_000, 60_000);
  expect(store.pairOwnerWithCode(hashSecret("presence-pair"), "7", "7", 1_000)).toEqual({ ok: true });
  const turn = store.enqueueControllerTurn({
    controllerKey: "executor-presence-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 900,
    inputText: "work",
    now: 1_000,
  });
  const lease = store.acquireExecutorLease("presence-setup", 1_000, 30_000);
  if (!lease.acquired) throw new Error("missing presence setup lease");
  const fence = { ownerId: "presence-setup", generation: lease.generation, now: 1_000 };
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    ...fence,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_presence",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, turnId: turn.id })).toBe(true);
  expect(store.releaseExecutorLease(fence.ownerId, fence.generation, 1_000)).toBe(true);
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

  it("completes an expired callback answer without retrying or crashing", async () => {
    const { store } = fixture();
    store.enqueueOutbox({ logicalKey: "callback:expired", chatId: "70", payload: { text: "Done" } }, 1_000);
    const abort = new AbortController();
    const answerCallback = vi.fn(async () => {
      throw new TelegramApiError({
        httpStatus: 400,
        errorCode: 400,
        description: "Bad Request: query is too old and response timeout expired",
        retryAfterSeconds: null,
      });
    });

    await runJobExecutorService({
      store,
      clock: { now: () => 1_000 },
      sleep: vi.fn(async () => abort.abort()),
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 }),
      telegram: () => ({
        sendMessage: vi.fn(async () => ({ message_id: 1 })),
        editMessage: vi.fn(async () => undefined),
        answerCallback,
      }),
    }, abort.signal);

    expect(answerCallback).toHaveBeenCalledOnce();
    expect(store.getOutbox("callback:expired")).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("replaces an unavailable status message and its durable identity atomically", async () => {
    const { store } = fixture();
    const created = store.createJob({ id: "job_replace", sourceUpdateId: 11, requestText: "work", now: 1_000 });
    const job = store.setJobStatusMessage(created.id, 101, created.version, 1_001);
    store.enqueueOutbox({
      logicalKey: `job:${job.id}:status`,
      chatId: "70",
      messageId: 101,
      payload: { text: "updated" },
    }, 1_002);
    const abort = new AbortController();
    const sendMessage = vi.fn(async () => ({ message_id: 202 }));

    await runJobExecutorService({
      store,
      clock: { now: () => 2_000 },
      sleep: vi.fn(async () => abort.abort()),
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 2_000 }),
      telegram: () => ({
        sendMessage,
        editMessage: vi.fn(async () => {
          throw new TelegramApiError({
            httpStatus: 400,
            errorCode: 400,
            description: "Bad Request: message to edit not found",
            retryAfterSeconds: null,
          });
        }),
      }),
    }, abort.signal);

    expect(sendMessage).toHaveBeenCalledWith("70", { text: "updated" });
    expect(store.getJob(job.id)?.statusMessageId).toBe(202);
    expect(store.getOutbox(`job:${job.id}:status`)).toMatchObject({ status: "sent", messageId: 202 });
  });

  it("retries malformed entities once without parse_mode", async () => {
    const { store } = fixture();
    const created = store.createJob({ id: "job_entities", sourceUpdateId: 12, requestText: "work", now: 1_000 });
    const job = store.setJobStatusMessage(created.id, 303, created.version, 1_001);
    store.enqueueOutbox({
      logicalKey: `job:${job.id}:status`,
      chatId: "70",
      messageId: 303,
      payload: { text: "<b>broken", parse_mode: "HTML" },
    }, 1_002);
    const abort = new AbortController();
    const editMessage = vi.fn()
      .mockRejectedValueOnce(new TelegramApiError({
        httpStatus: 400,
        errorCode: 400,
        description: "Bad Request: can't parse entities",
        retryAfterSeconds: null,
      }))
      .mockResolvedValueOnce(undefined);

    await runJobExecutorService({
      store,
      clock: { now: () => 2_000 },
      sleep: vi.fn(async () => abort.abort()),
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 2_000 }),
      telegram: () => ({ sendMessage: vi.fn(async () => ({ message_id: 1 })), editMessage }),
    }, abort.signal);

    expect(editMessage).toHaveBeenNthCalledWith(1, "70", 303, { text: "<b>broken", parse_mode: "HTML" });
    expect(editMessage).toHaveBeenNthCalledWith(2, "70", 303, { text: "<b>broken" });
    expect(store.getOutbox(`job:${job.id}:status`)).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("dead-letters a permanent Telegram 400 immediately", async () => {
    const { store } = fixture();
    store.enqueueOutbox({ logicalKey: "notice:permanent", chatId: "70", payload: { text: "hello" } }, 1_000);
    const abort = new AbortController();

    await runJobExecutorService({
      store,
      clock: { now: () => 1_000 },
      sleep: vi.fn(async () => abort.abort()),
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 }),
      telegram: () => ({
        sendMessage: vi.fn(async () => {
          throw new TelegramApiError({
            httpStatus: 400,
            errorCode: 400,
            description: "Bad Request: chat not found",
            retryAfterSeconds: null,
          });
        }),
        editMessage: vi.fn(async () => undefined),
      }),
    }, abort.signal);

    expect(store.getOutbox("notice:permanent")).toMatchObject({
      status: "dead",
      attempts: 1,
      lastError: expect.stringContaining("chat not found"),
    });
  });

  it("runs controller reconciliation and one dispatch before waiting through the nudge hook", async () => {
    const { store } = fixture();
    const abort = new AbortController();
    const order: string[] = [];
    const waitForWork = vi.fn(async () => abort.abort());

    await runJobExecutorService({
      store,
      clock: { now: () => 1_000 },
      sleep: vi.fn(async () => { throw new Error("ordinary loop sleep must not be used"); }),
      waitForWork,
      controller: {
        reconcile: vi.fn(async () => { order.push("reconcile"); return true; }),
        processOne: vi.fn(async () => { order.push("dispatch"); return true; }),
      },
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 }),
    }, abort.signal);

    expect(order).toEqual(["reconcile", "dispatch"]);
    expect(waitForWork).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));
  });

  it("streams a controller reply by editing the same durable Telegram message", async () => {
    const { store } = fixture();
    addSubmittedControllerTurn(store);
    const abort = new AbortController();
    const sendMessage = vi.fn(async () => ({ message_id: 501 }));
    const editMessage = vi.fn(async () => undefined);
    let loop = 0;
    const waitForWork = vi.fn(async () => {
      loop += 1;
      if (loop === 2) abort.abort();
    });

    await runJobExecutorService({
      store,
      clock: { now: () => 1_000 + loop * 1_000 },
      sleep: vi.fn(async () => { throw new Error("ordinary loop sleep must not be used"); }),
      waitForWork,
      telegram: () => ({ sendMessage, editMessage }),
      controller: {
        reconcile: vi.fn(async (fence) => {
          if (loop === 1) {
            expect(store.updateControllerStream({
              ownerId: fence.ownerId,
              generation: fence.generation,
              now: 2_000,
              turnId: "controller-turn-900",
              cursor: 1,
              text: "Luna is working live",
              phase: "responding",
            })).toBe(true);
          }
          return true;
        }),
        processOne: vi.fn(async () => false),
      },
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 + loop * 1_000 }),
    }, abort.signal);

    expect(sendMessage).toHaveBeenCalledWith("7", {
      text: "Connecting to Luna Max…",
      disable_web_page_preview: true,
    });
    expect(editMessage).toHaveBeenCalledWith("7", 501, {
      text: "Luna is working live",
      disable_web_page_preview: true,
    });
    expect(store.getOutbox("controller:controller-turn-900:reply")).toMatchObject({
      status: "sent",
      messageId: 501,
      payload: { text: "Luna is working live" },
    });
  });

  it.each(["idle", "active"] as const)("caps the %s executor wait at the active presence deadline", async (mode) => {
    const { store } = fixture();
    addSubmittedControllerTurn(store);
    const abort = new AbortController();
    const waitForWork = vi.fn(async () => abort.abort());
    const sendChatAction = vi.fn(async () => undefined);
    const presence = new TelegramPresenceCoordinator({
      store,
      telegram: { sendChatAction },
      warn: vi.fn(),
    });

    await runJobExecutorService({
      store,
      clock: { now: () => 1_000 },
      sleep: vi.fn(async () => { throw new Error("ordinary loop sleep must not be used"); }),
      waitForWork,
      controller: mode === "active" ? {
        reconcile: vi.fn(async () => true),
        processOne: vi.fn(async () => false),
      } : undefined,
      presence,
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 }),
    }, abort.signal);

    expect(sendChatAction).toHaveBeenCalledWith("7", "typing", expect.any(AbortSignal));
    expect(waitForWork).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));
  });

  it("preserves the ordinary wait when presence is inactive", async () => {
    const { store } = fixture();
    const abort = new AbortController();
    const waitForWork = vi.fn(async () => abort.abort());
    const presence = new TelegramPresenceCoordinator({
      store,
      telegram: { sendChatAction: vi.fn(async () => undefined) },
      warn: vi.fn(),
    });

    await runJobExecutorService({
      store,
      clock: { now: () => 1_000 },
      sleep: vi.fn(async () => { throw new Error("ordinary loop sleep must not be used"); }),
      waitForWork,
      presence,
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 }),
    }, abort.signal);

    expect(waitForWork).toHaveBeenCalledWith(60_000, expect.any(AbortSignal));
  });

  it("stops pulsing after lease loss and resets the stale lease state", async () => {
    const { store } = fixture();
    addSubmittedControllerTurn(store);
    const abort = new AbortController();
    let now = 1_000;
    const sendChatAction = vi.fn(async () => undefined);
    const presence = new TelegramPresenceCoordinator({
      store,
      telegram: { sendChatAction },
      warn: vi.fn(),
    });

    await runJobExecutorService({
      store,
      clock: { now: () => now },
      sleep: vi.fn(async () => abort.abort()),
      waitForWork: vi.fn(async () => {
        now = 31_001;
        expect(store.acquireExecutorLease("successor", now, 30_000)).toEqual({ acquired: true, generation: 2 });
      }),
      presence,
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => now }),
    }, abort.signal);

    expect(sendChatAction).toHaveBeenCalledTimes(1);
    await presence.pulse(now, new AbortController().signal);
    expect(sendChatAction).toHaveBeenCalledTimes(2);
  });

  it("stops cleanly when shutdown aborts an in-flight presence request", async () => {
    const { store } = fixture();
    addSubmittedControllerTurn(store);
    const abort = new AbortController();
    const presence = new TelegramPresenceCoordinator({
      store,
      telegram: {
        sendChatAction: vi.fn(async (_chatId, _action, signal) => {
          abort.abort(new Error("executor stopped"));
          throw signal?.reason ?? new Error("presence request was aborted");
        }),
      },
      warn: vi.fn(),
    });

    await expect(runJobExecutorService({
      store,
      clock: { now: () => 1_000 },
      sleep: vi.fn(async () => undefined),
      waitForWork: vi.fn(async () => undefined),
      presence,
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 }),
    }, abort.signal)).resolves.toBeUndefined();
  });
});
