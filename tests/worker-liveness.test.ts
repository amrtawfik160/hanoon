import { describe, expect, it } from "vitest";
import { jobFixture, policyFixture } from "./helpers";
import {
  classifyThreadRecovery,
  observeTerminalWorker,
  observeThreadWorker,
  observeUnknownWorker,
  projectWorkerLiveness,
  workerRegistrationGeneration,
} from "../src/services/worker-liveness";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { openStore, type TelegramAgentStore } from "../src/storage/store";

let fixtureNumber = 0;

function thread(overrides: Record<string, unknown> = {}): any {
  return {
    id: "thr_1",
    projectId: "proj_1",
    environmentId: "env_1",
    providerId: "provider",
    title: "worker",
    titleFallback: null,
    sectionId: null,
    status: "active",
    parentThreadId: null,
    sourceThreadId: null,
    originKind: null,
    childOrigin: null,
    originPluginId: "telegram-agent",
    visibility: "visible",
    archivedAt: null,
    pinnedAt: null,
    deletedAt: null,
    lastReadAt: null,
    latestAttentionAt: 1_000,
    createdAt: 1_000,
    updatedAt: 1_000,
    runtime: { displayStatus: "active", hostReconnectGraceExpiresAt: null },
    canSpawnChild: true,
    ...overrides,
  };
}

function storeFixture(): TelegramAgentStore {
  const { bb } = createFakePluginHost({ pluginId: `telegram-agent-task10-liveness-${fixtureNumber++}` });
  return openStore(bb.storage, {
    async get() { return undefined; },
    async set() {},
    async delete() {},
    async list() { return []; },
  });
}

describe("worker liveness projection", () => {
  it.each([
    ["starting", { status: "starting" }, "starting"],
    ["provisioning", { runtime: { displayStatus: "provisioning", hostReconnectGraceExpiresAt: null } }, "starting"],
    ["active", { status: "active" }, "active"],
    ["stopping", { status: "stopping", runtime: { displayStatus: "stopping", hostReconnectGraceExpiresAt: null } }, "stopping"],
    ["idle", { status: "idle", runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null } }, "idle"],
    ["failed", { status: "error", runtime: { displayStatus: "error", hostReconnectGraceExpiresAt: null } }, "failed"],
    ["reconnecting", { runtime: { displayStatus: "host-reconnecting", hostReconnectGraceExpiresAt: 5_000 } }, "unknown"],
  ] as const)("maps fresh BB state %s without using provider prose", (_label, overrides, expected) => {
    const job = jobFixture({ policy: policyFixture({ workerLivenessWatchdogMs: 300_000 }) });
    expect(observeThreadWorker(job, thread(overrides), 1_500)).toMatchObject({
      resourceId: "thr_1",
      generation: job.version,
      state: expected,
      sourceUpdatedAt: 1_000,
      observedAt: 1_500,
    });
  });

  it("marks a long-running thread stale when BB reports no new activity", () => {
    const job = jobFixture({ policy: policyFixture({ workerLivenessWatchdogMs: 60_000 }) });
    const value = observeThreadWorker(job, thread({ updatedAt: 1_000 }), 61_001);
    expect(value.state).toBe("stale");
    expect(value.resourceId).toBe("thr_1");
    expect(value.sourceUpdatedAt).toBe(1_000);
    expect(value.staleNotifiedAt).toBeNull();
  });

  it("classifies never-started and no-progress workers but honors host reconnect grace", () => {
    const job = jobFixture({
      policy: policyFixture({
        workerLivenessWatchdogMs: 60_000,
        workerStartGraceMs: 30_000,
      }),
    });

    expect(classifyThreadRecovery(job, thread({ status: "starting", updatedAt: 1_000 }), null, 31_001))
      .toMatchObject({ classification: "never_started" });
    expect(classifyThreadRecovery(job, thread({ status: "active", updatedAt: 1_000 }), null, 61_001))
      .toMatchObject({ classification: "no_progress" });
    expect(classifyThreadRecovery(job, thread({
      updatedAt: 1_000,
      runtime: { displayStatus: "host-reconnecting", hostReconnectGraceExpiresAt: 90_000 },
    }), null, 61_001)).toBeNull();
  });

  it("requires two missing observations before retiring an unknown worker", () => {
    const job = jobFixture({ policy: policyFixture({ workerLivenessWatchdogMs: 60_000 }) });
    const first = observeUnknownWorker(job, "thr_missing", 10_000, "implementation", 3);
    expect(classifyThreadRecovery(job, null, first, 10_001)).toBeNull();
    expect(classifyThreadRecovery(job, null, { ...first, observedAt: 10_000 }, 70_002))
      .toMatchObject({ classification: "missing" });
  });

  it("still treats an old cached active observation as stale when no live poll or command activity exists", () => {
    const job = jobFixture({ policy: policyFixture({ workerLivenessWatchdogMs: 60_000 }) });
    const value = observeThreadWorker(job, thread({
      updatedAt: 1_000,
      status: "active",
      runtime: { displayStatus: "host-reconnecting", hostReconnectGraceExpiresAt: null },
    }), 61_001);
    expect(value.state).toBe("unknown");
  });

  it("maps a failed BB lookup to unknown and preserves the current resource identity", () => {
    const job = jobFixture({ policy: policyFixture() });
    expect(observeUnknownWorker(job, "thr_1", 2_000)).toMatchObject({
      resourceId: "thr_1",
      state: "unknown",
      generation: job.version,
      observedAt: 2_000,
    });
  });

  it("uses the generation guard so a late older observation cannot replace the current worker", () => {
    const store = storeFixture();
    const job = jobFixture({ id: "abcdefghijklmnopqrstuv", policy: policyFixture({ workerLivenessWatchdogMs: 60_000 }) });
    store.createJob({ id: job.id, sourceUpdateId: job.sourceUpdateId, requestText: job.requestText, now: job.createdAt });
    const currentJob = { ...job, version: 2 };
    const current = projectWorkerLiveness(store, currentJob, thread({ id: "thr_new", updatedAt: 62_000 }), 62_000);
    const older = projectWorkerLiveness(store, { ...currentJob, version: 1 }, thread({ id: "thr_old", updatedAt: 62_001 }), 62_001);

    expect(current.resourceId).toBe("thr_new");
    expect(older.resourceId).toBe("thr_old");
    expect(store.getWorkerLiveness(job.id)?.resourceId).toBe("thr_new");
    expect(store.getWorkerLiveness(job.id)?.state).toBe("active");
    expect(store.getWorkerLiveness(job.id)?.staleNotifiedAt).toBeNull();
    expect(store.markWorkerLivenessNotified(job.id, currentJob.version, 62_002)).toBe(false);
    expect(store.markWorkerLivenessNotified(job.id, currentJob.version, 62_003)).toBe(false);
  });

  it("keeps independent liveness observations for concurrent review lenses", () => {
    const { bb } = createFakePluginHost({ pluginId: `telegram-agent-task10-liveness-${fixtureNumber++}` });
    const store = openStore(bb.storage, {
      async get() { return undefined; },
      async set() {},
      async delete() {},
      async list() { return []; },
    });
    const job = jobFixture({ id: "reviewlenslivenessjob1", policy: policyFixture() });
    store.createJob({ id: job.id, sourceUpdateId: job.sourceUpdateId, requestText: job.requestText, now: job.createdAt });
    bb.storage.database().prepare(
      "UPDATE jobs SET state = 'reviewing', delivery_mode = 'full', review_thread_id = 'thr_quality' WHERE id = ?",
    ).run(job.id);
    bb.storage.database().prepare(
      `INSERT INTO attempts (
         id, job_id, kind, review_lens, review_stage, ordinal, thread_id, head_sha, created_at
       ) VALUES
         ('attempt_quality', ?, 'review', 'quality', 'review', 1, 'thr_quality', ?, 1000),
         ('attempt_risk', ?, 'review', 'risk', 'review', 1, 'thr_risk', ?, 1000)`,
    ).run(job.id, "a".repeat(40), job.id, "a".repeat(40));
    store.upsertWorkerLiveness({
      jobId: job.id,
      workerKind: "review",
      resourceKind: "bb_thread",
      resourceId: "thr_quality",
      generation: 7,
      state: "active",
      sourceUpdatedAt: 2_000,
      observedAt: 2_001,
      staleNotifiedAt: null,
    });
    store.upsertWorkerLiveness({
      jobId: job.id,
      workerKind: "review",
      resourceKind: "bb_thread",
      resourceId: "thr_risk",
      generation: 7,
      state: "unknown",
      sourceUpdatedAt: 2_000,
      observedAt: 2_002,
      staleNotifiedAt: null,
    });

    expect(store.getWorkerLivenessForResource(job.id, "thr_quality")).toMatchObject({
      resourceId: "thr_quality",
      state: "active",
    });
    expect(store.getWorkerLivenessForResource(job.id, "thr_risk")).toMatchObject({
      resourceId: "thr_risk",
      state: "unknown",
    });
    expect(store.getWorkerLiveness(job.id)?.resourceId).toBe("thr_risk");
    expect(store.getCurrentWorkerLiveness(job.id)?.map((worker) => worker.resourceId))
      .toEqual(["thr_quality", "thr_risk"]);
    bb.storage.database().prepare(
      "DELETE FROM worker_liveness WHERE job_id = ? AND resource_id = 'thr_risk'",
    ).run(job.id);
    expect(store.getCurrentWorkerLiveness(job.id)).toBeNull();
  });

  it("uses distinct role generations and projects terminal command failures", () => {
    const job = jobFixture({ policy: policyFixture() });
    expect(workerRegistrationGeneration(job, "implementation"))
      .not.toBe(workerRegistrationGeneration(job, "review"));
    expect(observeTerminalWorker(job, {
      id: "term_1",
      status: "timed_out",
      updatedAt: 2_000,
      exitCode: null,
    }, "validation", 2_001)).toMatchObject({
      resourceKind: "bb_terminal",
      resourceId: "term_1",
      workerKind: "validation",
      state: "failed",
    });
  });
});
