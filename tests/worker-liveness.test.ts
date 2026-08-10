import { describe, expect, it } from "vitest";
import { jobFixture, policyFixture } from "./helpers";
import {
  observeThreadWorker,
  observeUnknownWorker,
  projectWorkerLiveness,
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

  it("projects stale as an observation-gap warning without declaring the worker dead", () => {
    const job = jobFixture({ policy: policyFixture({ workerLivenessWatchdogMs: 60_000 }) });
    const value = observeThreadWorker(job, thread({ updatedAt: 1_000 }), 61_001);
    expect(value.state).toBe("stale");
    expect(value.resourceId).toBe("thr_1");
    expect(value.staleNotifiedAt).toBeNull();
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
    const current = projectWorkerLiveness(store, currentJob, thread({ id: "thr_new" }), 62_000);
    const older = projectWorkerLiveness(store, { ...currentJob, version: 1 }, thread({ id: "thr_old" }), 62_001);

    expect(current.resourceId).toBe("thr_new");
    expect(older.resourceId).toBe("thr_old");
    expect(store.getWorkerLiveness(job.id)?.resourceId).toBe("thr_new");
    expect(store.getWorkerLiveness(job.id)?.staleNotifiedAt).toBe(62_000);
    expect(store.markWorkerLivenessNotified(job.id, currentJob.version, 62_002)).toBe(false);
    expect(store.markWorkerLivenessNotified(job.id, currentJob.version, 62_003)).toBe(false);
  });
});
