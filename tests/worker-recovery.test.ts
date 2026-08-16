import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openStore } from "../src/storage/store";
import { policyFixture } from "./helpers";

let fixtureNumber = 0;

function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-agent-worker-recovery-${fixtureNumber++}` });
  const store = openStore(bb.storage, {
    async get() { return undefined; },
    async set() {},
    async delete() {},
    async list() { return []; },
  });
  const draft = store.createJob({ id: "job_recovery", sourceUpdateId: 1, requestText: "work", now: 1_000 });
  const selected = store.applyJobEvent(draft.id, draft.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_1",
    policyVersion: 1,
    policy: policyFixture(),
  }, 1_001);
  bb.storage.database().prepare(
    `UPDATE jobs SET state = 'implementing', implementation_thread_id = 'thr_1',
       environment_id = 'env_1', version = version + 1 WHERE id = ?`,
  ).run(selected.id);
  const job = store.getJob(selected.id)!;
  const lease = store.acquireExecutorLease("executor", 1_002, 30_000);
  if (!lease.acquired) throw new Error("executor lease missing");
  return { store, job, generation: lease.generation };
}

describe("worker recovery ledger", () => {
  it("auto-retries bounded silent failures and deduplicates the same observation", () => {
    const { store, job, generation } = fixture();
    const first = store.registerExecutorWorkerRecovery({
      id: "recovery_1",
      jobId: job.id,
      expectedVersion: job.version,
      projectId: "proj_1",
      jobState: "implementing",
      workerKind: "implementation",
      resourceId: "thr_1",
      workerGeneration: 10,
      classification: "no_progress",
      signature: "no_progress:implementation:active",
      retryLimit: 2,
      ownerId: "executor",
      generation,
      now: 1_003,
    });
    expect(first).toMatchObject({ action: "auto_retry", record: { state: "detected" } });

    const duplicate = store.registerExecutorWorkerRecovery({
      id: "recovery_duplicate",
      jobId: job.id,
      expectedVersion: job.version,
      projectId: "proj_1",
      jobState: "implementing",
      workerKind: "implementation",
      resourceId: "thr_1",
      workerGeneration: 10,
      classification: "no_progress",
      signature: "no_progress:implementation:active",
      retryLimit: 2,
      ownerId: "executor",
      generation,
      now: 1_004,
    });
    expect(duplicate).toMatchObject({ action: "already_recorded", record: { id: "recovery_1" } });
  });

  it("requires an owner retry for a novel crash and trusts it only after recovery", () => {
    const { store, job, generation } = fixture();
    const register = (id: string, resourceId: string, now: number) => store.registerExecutorWorkerRecovery({
      id,
      jobId: job.id,
      expectedVersion: job.version,
      projectId: "proj_1",
      jobState: "implementing",
      workerKind: "implementation" as const,
      resourceId,
      workerGeneration: now,
      classification: "crash" as const,
      signature: "crash:implementation:provider-error",
      retryLimit: 2,
      ownerId: "executor",
      generation,
      now,
    });

    const novel = register("recovery_crash_1", "thr_crash_1", 1_003);
    expect(novel).toMatchObject({ action: "owner_required", record: { state: "owner_required" } });
    expect(store.markExecutorWorkerRecoveryRequeued({
      id: "recovery_crash_1", ownerId: "executor", generation, now: 1_004,
    })).toBe(true);
    expect(store.markExecutorWorkerRecoveryRecovered({
      jobId: job.id, ownerId: "executor", generation, now: 1_005,
    })).toBe(1);

    expect(register("recovery_crash_2", "thr_crash_2", 1_006))
      .toMatchObject({ action: "auto_retry", record: { state: "detected" } });
  });
});
