import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { JobEffect, StoredEffect, WorkerLiveness } from "../src/domain/models";
import type { CapabilityWorkOrderEnvelope } from "../src/bb/handoffs";
import { productionResourceKey, projectResourceKey } from "../src/autonomy/models";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { admitConfirmedJob, policyFixture } from "./helpers";
import { settleEffectFailure } from "../src/services/job-executor-service";
import { DisjointHistoryError, disjointHistoryMessage } from "../src/bb/worktree-ancestry";
import {
  EffectRunner,
  PermanentEffectError,
  retryDelay,
  threadResultEnvironment,
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

function addProductionAdmissionAndClaims(
  db: Database.Database,
  jobId: string,
  policy: ReturnType<typeof policyFixture>,
  ownerId: string,
  generation: number,
  now: number,
  leaseExpiresAt: number,
): void {
  db.prepare(
    `INSERT INTO job_admissions (
       job_id, project_id, queue_seq, state, resume_event, queued_at, admitted_at
     ) VALUES (?, ?, 1, 'admitted', 'CONFIRMED', ?, ?)`,
  ).run(jobId, policy.projectId, now, now + 1);
  const insertClaim = db.prepare(
    `INSERT INTO job_resource_claims (
       job_id, resource_key, resource_kind, state, owner_id, generation,
       lease_expires_at, acquired_at, renewed_at
     ) VALUES (?, ?, ?, 'held', ?, ?, ?, ?, ?)`,
  );
  insertClaim.run(jobId, projectResourceKey(policy.projectId), "project", ownerId, generation, leaseExpiresAt, now, now);
  insertClaim.run(jobId, productionResourceKey(policy), "production_target", ownerId, generation, leaseExpiresAt, now, now);
}

function fence(store: TelegramAgentStore, now = 1_000): { ownerId: string; generation: number } {
  const lease = store.acquireExecutorLease("owner-a", now, 100);
  if (!lease.acquired) throw new Error("lease was not acquired");
  return { ownerId: "owner-a", generation: lease.generation };
}

type LegacyLeaseStore = TelegramAgentStore & {
  leaseEffects(ownerId: string, generation: number, now: number, limit: number, leaseMs: number): StoredEffect[];
};

function leaseEffectsForTest(
  store: TelegramAgentStore,
  ownerId: string,
  generation: number,
  now: number,
  limit: number,
  leaseMs: number,
): StoredEffect[] {
  return (store as LegacyLeaseStore).leaseEffects(ownerId, generation, now, limit, leaseMs);
}

function selectedJobForRecovery(
  store: TelegramAgentStore,
  db: Database.Database,
  id: string,
  state: "planning" | "creating_implementation",
): ReturnType<TelegramAgentStore["getJob"]> {
  const job = store.createJob({ id, sourceUpdateId: 1, requestText: "work", now: 1_000 });
  db.prepare(
    `UPDATE jobs SET state = ?, project_id = 'proj_1', policy_version = 1, policy_json = ?, version = 2 WHERE id = ?`,
  ).run(state, JSON.stringify(policyFixture()), job.id);
  return store.getJob(job.id);
}

function addPendingEffectForRecovery(db: Database.Database, effect: JobEffect): void {
  db.prepare(
    `INSERT INTO effects (idempotency_key, job_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, 1000, 1000, 1000)`,
  ).run(effect.idempotencyKey, effect.jobId, effect.kind, JSON.stringify(effect.payload));
}

describe("leased effect execution", () => {
  it("retires a silent worker and requeues the unanswered implementation stage", async () => {
    const { store, db } = storeFixture();
    const draft = store.createJob({ id: "job_silent_recovery", sourceUpdateId: 1, requestText: "work", now: 1_000 });
    const selected = store.applyJobEvent(draft.id, draft.version, {
      type: "PROJECT_SELECTED", projectId: "proj_1", policyVersion: 1, policy: policyFixture(),
    }, 1_001);
    const admitted = admitConfirmedJob(store, selected, 1_002);
    db.prepare(
      `UPDATE jobs SET state = 'implementing', resume_state = NULL,
         implementation_thread_id = 'thr_silent', environment_id = 'env_1',
         version = version + 1 WHERE id = ?`,
    ).run(admitted.id);
    db.prepare("UPDATE effects SET status = 'done' WHERE job_id = ?").run(admitted.id);
    const job = store.getJob(admitted.id)!;
    const lease = store.acquireExecutorLease("owner-a", 1_003, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    expect(store.adoptHeldClaims({
      jobId: job.id,
      ownerId: "owner-a",
      generation: lease.generation,
      now: 1_003,
      leaseMs: 30_000,
    })).toBe(true);
    const registration = store.registerExecutorWorkerRecovery({
      id: "recovery_silent",
      jobId: job.id,
      expectedVersion: job.version,
      projectId: "proj_1",
      jobState: "implementing",
      workerKind: "implementation",
      resourceId: "thr_silent",
      workerGeneration: 42,
      classification: "no_progress",
      signature: "no_progress:implementation:active",
      retryLimit: 2,
      ownerId: "owner-a",
      generation: lease.generation,
      now: 1_004,
    });
    expect(registration?.action).toBe("auto_retry");
    const recovering = store.applyExecutorJobEvent({
      jobId: job.id,
      expectedVersion: job.version,
      event: {
        type: "WORKER_RECOVERY_REQUESTED",
        recoveryId: "recovery_silent",
        workerKind: "implementation",
        resourceId: "thr_silent",
        classification: "no_progress",
        signature: "no_progress:implementation:active",
        retryPayload: { retireResourceIds: ["thr_sibling_review"] },
      },
      ownerId: "owner-a",
      generation: lease.generation,
      now: 1_005,
    });
    expect(recovering?.state).toBe("recovering_worker");
    expect(store.getWorkerRecovery("recovery_silent")?.state).toBe("retiring");
    db.prepare(
      "UPDATE effects SET status = 'done' WHERE job_id = ? AND kind <> 'recover_worker'",
    ).run(job.id);
    const effect = store.leaseNextJobEffect({
      jobId: job.id,
      ownerId: "owner-a",
      generation: lease.generation,
      now: 1_006,
      leaseMs: 30_000,
    });
    if (!effect || effect.kind !== "recover_worker") throw new Error("recovery effect missing");
    const retireWorker = vi.fn(async () => undefined);

    await new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      bb: { retireWorker },
      now: () => 1_007,
    }).run(effect);

    expect(retireWorker.mock.calls).toEqual([
      ["thr_silent", false],
      ["thr_sibling_review", true],
    ]);
    expect(store.getWorkerRecovery("recovery_silent")?.state).toBe("requeued");
    expect(store.getJob(job.id)).toMatchObject({
      state: "creating_implementation",
      implementationThreadId: null,
      environmentId: "env_1",
    });
    expect(store.listEffectsForJob(job.id).some((candidate) =>
      candidate.kind === "spawn_implementation" && candidate.status === "pending")).toBe(true);
  });

  it("spawns a replacement implementation after a worker recovery requeues the stage", async () => {
    // Every spawn_implementation effect carries a fresh idempotency key, so the
    // attempt it creates has a fresh id. The second spawn must still be storable:
    // a job whose first worker died can only be rebuilt by a second attempt.
    const { store, db } = storeFixture();
    const job = selectedJobForRecovery(store, db, "job_respawn", "creating_implementation");
    if (!job) throw new Error("job missing");
    const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    addProductionAdmissionAndClaims(db, job.id, policyFixture(), "owner-a", lease.generation, 1_001, 31_000);
    const fenceFor = (now: number) => ({
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      now: () => now,
    });
    const spawnImplementation = vi.fn(async () => ({ id: "thr_first", environmentId: "env_1" }));
    const runSpawn = async (idempotencyKey: string, now: number): Promise<void> => {
      const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, now, 10, 30_000)
        .find((candidate) => candidate.idempotencyKey === idempotencyKey);
      if (!claimed) throw new Error(`spawn effect ${idempotencyKey} missing`);
      await new EffectRunner({ ...fenceFor(now), bb: { spawnImplementation } }).run(claimed);
    };

    addPendingEffectForRecovery(db, {
      idempotencyKey: `${job.id}:2:spawn_implementation`,
      jobId: job.id,
      kind: "spawn_implementation",
      payload: {},
    });
    await runSpawn(`${job.id}:2:spawn_implementation`, 1_002);
    expect(store.getJob(job.id)).toMatchObject({ state: "implementing", implementationThreadId: "thr_first" });

    // The worker dies silently. Recovery clears the thread and requeues the
    // stage under a new effect key, exactly as `transitionRecoveringWorker` does.
    const implementing = store.getJob(job.id)!;
    store.registerExecutorWorkerRecovery({
      id: "recovery_respawn",
      jobId: job.id,
      expectedVersion: implementing.version,
      projectId: "proj_1",
      jobState: "implementing",
      workerKind: "implementation",
      resourceId: "thr_first",
      workerGeneration: 7,
      classification: "no_progress",
      signature: "no_progress:implementation:active",
      retryLimit: 2,
      ownerId: "owner-a",
      generation: lease.generation,
      now: 1_003,
    });
    const recovering = store.applyExecutorJobEvent({
      jobId: job.id,
      expectedVersion: implementing.version,
      event: {
        type: "WORKER_RECOVERY_REQUESTED",
        recoveryId: "recovery_respawn",
        workerKind: "implementation",
        resourceId: "thr_first",
        classification: "no_progress",
        signature: "no_progress:implementation:active",
      },
      ownerId: "owner-a",
      generation: lease.generation,
      now: 1_004,
    });
    expect(recovering?.state).toBe("recovering_worker");
    db.prepare("UPDATE effects SET status = 'done' WHERE job_id = ? AND kind <> 'recover_worker'").run(job.id);
    const recoverEffect = store.leaseNextJobEffect({
      jobId: job.id,
      ownerId: "owner-a",
      generation: lease.generation,
      now: 1_005,
      leaseMs: 30_000,
    });
    if (!recoverEffect || recoverEffect.kind !== "recover_worker") throw new Error("recovery effect missing");
    await new EffectRunner({ ...fenceFor(1_006), bb: { retireWorker: vi.fn(async () => undefined) } })
      .run(recoverEffect);
    const requeued = store.listEffectsForJob(job.id)
      .find((candidate) => candidate.kind === "spawn_implementation" && candidate.status === "pending");
    if (!requeued) throw new Error("requeued spawn effect missing");

    spawnImplementation.mockResolvedValue({ id: "thr_second", environmentId: "env_1" });
    await runSpawn(requeued.idempotencyKey, 1_007);

    expect(store.getJob(job.id)).toMatchObject({ state: "implementing", implementationThreadId: "thr_second" });
    const ordinals = db
      .prepare("SELECT ordinal FROM attempts WHERE job_id = ? AND kind = 'implementation' ORDER BY ordinal")
      .all(job.id) as { ordinal: number }[];
    expect(ordinals.map((row) => row.ordinal)).toEqual([1, 2]);
  });

  it("recovers an ordinary implementation thread by the centralized title bytes", async () => {
    const { store, db } = storeFixture();
    const job = selectedJobForRecovery(store, db, "job_ordinary_recovery", "creating_implementation");
    if (!job) throw new Error("job missing");
    const effect: JobEffect = {
      idempotencyKey: `${job.id}:2:spawn_implementation`,
      jobId: job.id,
      kind: "spawn_implementation",
      payload: {},
    };
    addPendingEffectForRecovery(db, effect);
    const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    addProductionAdmissionAndClaims(db, job.id, policyFixture(), "owner-a", lease.generation, 1_001, 31_000);
    const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, 1_001, 10, 30_000)
      .find((candidate) => candidate.idempotencyKey === effect.idempotencyKey);
    if (!claimed) throw new Error("ordinary spawn effect missing");
    const title = "Telegram job_ordinary_recovery implementation attempt:job_ordinary_recovery:2:spawn_implementation";
    const decoyTitle = "Telegram job_ordinary_recovery implementation attempt:job_ordinary_recovery:2:spawn_implementation:decoy";
    const spawnImplementation = vi.fn(async () => ({ id: "thr_spawned_ordinary", environmentId: "env_spawned" }));
    const prepareProgressScratchpad = vi.fn(async () => undefined);
    const listThreads = vi.fn(async () => ({
      threads: [{
        id: "thr_wrong_ordinary",
        projectId: "proj_1",
        environmentId: "env_ordinary",
        parentThreadId: null,
        title: decoyTitle,
        status: "active",
        updatedAt: 1_001,
        runtime: { displayStatus: "active", hostReconnectGraceExpiresAt: null },
      }, {
        id: "thr_recovered_ordinary",
        projectId: "proj_1",
        environmentId: "env_ordinary",
        parentThreadId: null,
        title,
        status: "active",
        updatedAt: 1_001,
        runtime: { displayStatus: "active", hostReconnectGraceExpiresAt: null },
      }],
      total: 1,
    }));

    await new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      bb: { listThreads, spawnImplementation, prepareProgressScratchpad },
      now: () => 1_002,
    }).run(claimed);

    expect(listThreads).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj_1" }));
    expect(spawnImplementation).not.toHaveBeenCalled();
    expect(prepareProgressScratchpad).toHaveBeenCalledWith("env_ordinary");
    expect(store.getJob(job.id)).toMatchObject({
      state: "implementing",
      implementationThreadId: "thr_recovered_ordinary",
      environmentId: "env_ordinary",
    });
  });

  it("refuses to start implementation work in a worktree cut from an unrelated history", async () => {
    const { store, db } = storeFixture();
    const job = selectedJobForRecovery(store, db, "job_disjoint_worktree", "creating_implementation");
    if (!job) throw new Error("job missing");
    const effect: JobEffect = {
      idempotencyKey: `${job.id}:2:spawn_implementation`,
      jobId: job.id,
      kind: "spawn_implementation",
      payload: {},
    };
    addPendingEffectForRecovery(db, effect);
    const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    addProductionAdmissionAndClaims(db, job.id, policyFixture(), "owner-a", lease.generation, 1_001, 31_000);
    const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, 1_001, 10, 30_000)
      .find((candidate) => candidate.idempotencyKey === effect.idempotencyKey);
    if (!claimed) throw new Error("spawn effect missing");
    const spawnImplementation = vi.fn(async () => ({ id: "thr_disjoint", environmentId: "env_disjoint" }));
    const prepareProgressScratchpad = vi.fn(async () => undefined);
    const assertWorktreeSharesTrunk = vi.fn(async () => {
      throw new DisjointHistoryError("main", disjointHistoryMessage("main"));
    });
    const listThreads = vi.fn(async () => ({ threads: [], total: 0 }));

    await expect(new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      bb: { listThreads, spawnImplementation, prepareProgressScratchpad, assertWorktreeSharesTrunk },
      now: () => 1_002,
    }).run(claimed)).rejects.toBeInstanceOf(DisjointHistoryError);

    expect(assertWorktreeSharesTrunk).toHaveBeenCalledWith("env_disjoint", policyFixture().baseBranch);
    // The worker must not get a scratchpad or be moved into implementing on a
    // worktree whose commits can never reach the base branch.
    expect(prepareProgressScratchpad).not.toHaveBeenCalled();
    expect(store.getJob(job.id)).toMatchObject({ state: "creating_implementation" });
  });

  it.each([
    ["shadow", "bug", ["systematic-debugging", "test-driven-development", "verification-before-completion"]],
    ["active", "bug", ["systematic-debugging", "test-driven-development", "verification-before-completion"]],
    ["active", "adopted-pr", ["verification-before-completion"]],
  ] as const)(
    "persists a least-capability profile before spawning a %s %s implementation worker",
    async (routingMode, taskRecipe, expectedCapabilities) => {
    const { store, db } = storeFixture();
    const selected = selectedJobForRecovery(
      store,
      db,
      `job_profiled_${routingMode}_${taskRecipe}`,
      "creating_implementation",
    );
    if (!selected) throw new Error("job missing");
    db.prepare(
      `UPDATE jobs SET routing_mode = ?, task_recipe = ?,
         task_traits_json = ?, task_reason_codes_json = ? WHERE id = ?`,
    ).run(
      routingMode,
      taskRecipe,
      JSON.stringify(taskRecipe === "bug" ? [{ id: "reproducible-bug", provenance: ["owner"] }] : []),
      JSON.stringify(taskRecipe === "bug" ? ["owner_reproducible_bug"] : ["origin_adopted_pr"]),
      selected.id,
    );
    const job = store.getJob(selected.id);
    if (!job) throw new Error("profiled job missing");
    const effect: JobEffect = {
      idempotencyKey: `${job.id}:2:spawn_implementation`,
      jobId: job.id,
      kind: "spawn_implementation",
      payload: {},
    };
    addPendingEffectForRecovery(db, effect);
    const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    addProductionAdmissionAndClaims(db, job.id, policyFixture(), "owner-a", lease.generation, 1_001, 31_000);
    const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, 1_001, 10, 30_000)
      .find((candidate) => candidate.idempotencyKey === effect.idempotencyKey);
    if (!claimed) throw new Error("spawn effect missing");
    const expectedAttemptId = `attempt:${effect.idempotencyKey}`;
    let attachedProfile: CapabilityWorkOrderEnvelope | undefined;

    await new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      now: () => 1_002,
      minimumModelPool: () => "strong",
      bb: {
        spawnImplementation: vi.fn(async (_activeJob, attempt) => {
          expect(store.getLatestCapabilityProfile("worker_attempt", expectedAttemptId)).not.toBeNull();
          attachedProfile = attempt.capabilityProfile;
          return { id: "thr_profiled", environmentId: "env_profiled" };
        }),
      },
    }).run(claimed);

    const profile = store.getLatestCapabilityProfile("worker_attempt", expectedAttemptId);
    expect(profile).toMatchObject({
      subjectId: expectedAttemptId,
      recipeId: taskRecipe,
      recipeVersion: 1,
      mode: routingMode,
      revision: 1,
      model: { pool: "strong", modelId: "gpt-5.6-sol" },
    });
    expect(profile?.assignments.map((assignment) => assignment.capabilityId)).toEqual(expectedCapabilities);
    expect(attachedProfile).toMatchObject({
      profileId: profile?.id,
      profileRevision: 1,
      recipeId: taskRecipe,
      recipeVersion: 1,
    });
    expect(store.listCapabilityReceipts(profile?.id ?? "missing", 20)
      .filter((receipt) => receipt.eventType === "selected")).toHaveLength(expectedCapabilities.length);
    const nativeOutcomes = db.prepare(
      `SELECT capability_id, outcome FROM capability_receipts
        WHERE capability_kind = 'native-adapter' AND event_type = 'outcome'
        ORDER BY capability_id ASC`,
    ).all();
    expect(nativeOutcomes).toEqual(routingMode === "active"
      ? [
          { capability_id: "hanoon-native-using-git-worktrees", outcome: "passed" },
          { capability_id: "hanoon-native-using-superpowers", outcome: "passed" },
        ]
      : []);
  });

  it("recovers a pipeline planner thread by the same centralized title bytes", async () => {
    const { store, db } = storeFixture();
    const job = selectedJobForRecovery(store, db, "job_pipeline_recovery", "planning");
    if (!job) throw new Error("job missing");
    const effect: JobEffect = {
      idempotencyKey: `${job.id}:2:spawn_plan`,
      jobId: job.id,
      kind: "spawn_plan",
      payload: {},
    };
    addPendingEffectForRecovery(db, effect);
    const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    addProductionAdmissionAndClaims(db, job.id, policyFixture(), "owner-a", lease.generation, 1_001, 31_000);
    const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, 1_001, 10, 30_000)
      .find((candidate) => candidate.idempotencyKey === effect.idempotencyKey);
    if (!claimed) throw new Error("pipeline spawn effect missing");
    const title = "Telegram job_pipeline_recovery plan stage:job_pipeline_recovery:2:spawn_plan";
    const decoyTitle = "Telegram job_pipeline_recovery plan stage:job_pipeline_recovery:2:spawn_plan:decoy";
    const spawnPlanner = vi.fn(async () => ({ id: "thr_spawned_pipeline", environmentId: "env_spawned" }));
    const listThreads = vi.fn(async () => ({
      threads: [{
        id: "thr_wrong_pipeline",
        projectId: "proj_1",
        environmentId: "env_pipeline",
        parentThreadId: null,
        title: decoyTitle,
        status: "active",
        updatedAt: 1_001,
        runtime: { displayStatus: "active", hostReconnectGraceExpiresAt: null },
      }, {
        id: "thr_recovered_pipeline",
        projectId: "proj_1",
        environmentId: "env_pipeline",
        parentThreadId: null,
        title,
        status: "active",
        updatedAt: 1_001,
        runtime: { displayStatus: "active", hostReconnectGraceExpiresAt: null },
      }],
      total: 1,
    }));

    await new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      bb: {
        listThreads,
        spawnPlanner,
      },
      now: () => 1_002,
    }).run(claimed);

    expect(listThreads).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj_1" }));
    expect(spawnPlanner).not.toHaveBeenCalled();
    expect(store.getJob(job.id)).toMatchObject({
      state: "planning",
      environmentId: "env_pipeline",
    });
    expect(store.getLatestPipelineStageAttempt(job.id, "PLAN")).toMatchObject({
      id: `stage:${effect.idempotencyKey}`,
      threadId: "thr_recovered_pipeline",
      environmentId: "env_pipeline",
    });
  });

  it("leaves an active model trial unresolved when the provider result has no usable environment", async () => {
    const { store, db } = storeFixture();
    const selected = selectedJobForRecovery(store, db, "job_invalid_provider_result", "creating_implementation");
    if (!selected) throw new Error("job missing");
    db.prepare(
      `UPDATE jobs SET routing_mode = 'active', task_recipe = 'direct', delivery_mode = 'small_fix',
         task_traits_json = '[]', task_reason_codes_json = '[]' WHERE id = ?`,
    ).run(selected.id);
    const effect: JobEffect = {
      idempotencyKey: `${selected.id}:2:spawn_implementation`,
      jobId: selected.id,
      kind: "spawn_implementation",
      payload: {},
    };
    addPendingEffectForRecovery(db, effect);
    const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    addProductionAdmissionAndClaims(db, selected.id, policyFixture(), "owner-a", lease.generation, 1_001, 31_000);
    const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, 1_001, 10, 30_000)
      .find((candidate) => candidate.idempotencyKey === effect.idempotencyKey);
    if (!claimed) throw new Error("spawn effect missing");

    await expect(new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      now: () => 1_002,
      bb: { spawnImplementation: vi.fn(async () => ({ id: "thr_unbound", environmentId: null })) },
    }).run(claimed)).rejects.toThrow(/environment id/i);

    expect(store.listModelRouteTrials(
      "worker_attempt",
      `attempt:${effect.idempotencyKey}`,
      10,
    )).toMatchObject([{ attempt: 1, outcome: "selected", failureSignature: null }]);
    expect(store.getJob(selected.id)).toMatchObject({ state: "creating_implementation" });
  });

  it("records what the implementation stage was dispatched on, escalated by a repeated review cycle", async () => {
    const { store, db } = storeFixture();
    const selected = selectedJobForRecovery(store, db, "job_stage_ledger", "creating_implementation");
    if (!selected) throw new Error("job missing");
    // No exact model pin, so the stage table's tiered default applies and a
    // repeated review cycle can escalate it.
    db.prepare("UPDATE jobs SET review_cycle = 1, policy_json = ? WHERE id = ?").run(
      JSON.stringify(policyFixture({ implementation: {} })),
      selected.id,
    );
    const effect: JobEffect = {
      idempotencyKey: `${selected.id}:2:spawn_implementation`,
      jobId: selected.id,
      kind: "spawn_implementation",
      payload: {},
    };
    addPendingEffectForRecovery(db, effect);
    const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    addProductionAdmissionAndClaims(db, selected.id, policyFixture(), "owner-a", lease.generation, 1_001, 31_000);
    const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, 1_001, 10, 30_000)
      .find((candidate) => candidate.idempotencyKey === effect.idempotencyKey);
    if (!claimed) throw new Error("spawn effect missing");

    await new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      now: () => 1_002,
      bb: { spawnImplementation: vi.fn(async () => ({ id: "thr_ledger", environmentId: "env_ledger" })) },
    }).run(claimed);

    expect(store.listStageExecutions(selected.id)).toMatchObject([{
      stage: "implementation",
      threadId: "thr_ledger",
      baseTier: "standard",
      tier: "strong",
      escalationSteps: 1,
      escalated: true,
      providerId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "xhigh",
      serviceTier: "default",
      source: "default",
      outcome: null,
      startedAt: 1_002,
    }]);
  });

  it("durably escalates a new model route only after two equivalent provider failures", async () => {
    const { store, db } = storeFixture();
    const selected = selectedJobForRecovery(store, db, "job_model_escalation", "creating_implementation");
    if (!selected) throw new Error("job missing");
    db.prepare(
      `UPDATE jobs SET routing_mode = 'active', task_recipe = 'direct', delivery_mode = 'small_fix',
         task_traits_json = '[]', task_reason_codes_json = '[]' WHERE id = ?`,
    ).run(selected.id);
    const job = store.getJob(selected.id);
    if (!job) throw new Error("selected job missing");
    const effect: JobEffect = {
      idempotencyKey: `${job.id}:2:spawn_implementation`,
      jobId: job.id,
      kind: "spawn_implementation",
      payload: {},
    };
    addPendingEffectForRecovery(db, effect);
    const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    addProductionAdmissionAndClaims(db, job.id, policyFixture(), "owner-a", lease.generation, 1_001, 31_000);
    const exactModels: string[] = [];
    const spawnImplementation = vi.fn(async (_activeJob, attempt: { capabilityProfile?: CapabilityWorkOrderEnvelope }) => {
      exactModels.push(attempt.capabilityProfile?.model?.modelId ?? "missing");
      if (exactModels.length <= 2) throw new Error("HTTP 503 provider unavailable for request volatile-id");
      return { id: "thr_model_escalated", environmentId: "env_model_escalated" };
    });
    const attemptId = `attempt:${effect.idempotencyKey}`;

    const runFailedAttempt = async (claimed: StoredEffect, now: number): Promise<void> => {
      let providerFailure: unknown;
      try {
        await new EffectRunner({
          store,
          fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
          now: () => now,
          bb: { spawnImplementation },
        }).run(claimed);
      } catch (error) {
        providerFailure = error;
      }
      expect(providerFailure).toBeInstanceOf(Error);
      expect(settleEffectFailure(
        store,
        claimed,
        "owner-a",
        lease.generation,
        now,
        providerFailure,
        () => 0,
      )).toBe(true);
    };

    const first = leaseEffectsForTest(store, "owner-a", lease.generation, 1_001, 10, 30_000)[0];
    if (!first) throw new Error("first model attempt missing");
    await runFailedAttempt(first, 1_002);
    const second = leaseEffectsForTest(store, "owner-a", lease.generation, 2_000, 10, 30_000)[0];
    if (!second) throw new Error("second model attempt missing");
    await runFailedAttempt(second, 2_001);
    const third = leaseEffectsForTest(store, "owner-a", lease.generation, 4_000, 10, 30_000)[0];
    if (!third) throw new Error("third model attempt missing");
    await new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      now: () => 4_001,
      bb: { spawnImplementation },
    }).run(third);

    expect(exactModels).toEqual(["gpt-5.6-luna", "gpt-5.6-luna", "gpt-5.6-terra"]);
    expect(store.listModelRouteTrials("worker_attempt", attemptId, 10)).toMatchObject([
      { attempt: 1, route: { pool: "fast" }, outcome: "failed", failureSignature: expect.stringMatching(/^[0-9a-f]{64}$/) },
      { attempt: 2, route: { pool: "fast" }, outcome: "failed", failureSignature: expect.stringMatching(/^[0-9a-f]{64}$/) },
      { attempt: 3, route: { pool: "standard" }, outcome: "passed", failureSignature: null },
    ]);
    const profiles = db.prepare(
      `SELECT id, revision, model_pool FROM capability_profiles
        WHERE subject_kind = 'worker_attempt' AND subject_id = ? ORDER BY revision`,
    ).all(attemptId) as Array<{ id: string; revision: number; model_pool: string }>;
    expect(profiles.map(({ revision, model_pool: modelPool }) => ({ revision, modelPool }))).toEqual([
      { revision: 1, modelPool: "fast" },
      { revision: 2, modelPool: "standard" },
    ]);
    expect(store.listMissingMandatoryCapabilityOutcomes(profiles[0]!.id)).toEqual([]);
  });

  it("allows exactly one executor generation to win a race", () => {
    const first = storeFixture();
    const one = first.store.acquireExecutorLease("one", 1_000, 30_000);
    const two = first.store.acquireExecutorLease("two", 1_000, 30_000);

    expect(one).toEqual({ acquired: true, generation: 1 });
    expect(two).toEqual({ acquired: false });
  });

  it("refuses to execute an effect that is not durably leased", async () => {
    const { store, db } = storeFixture();
    const effect: JobEffect = {
      idempotencyKey: "job_1:2:render_status",
      jobId: "job_1",
      kind: "render_status",
      payload: {},
    };
    addJobEffect(store, db, effect);
    const executor = fence(store);
    const pending = store.getEffect(effect.jobId, effect.idempotencyKey);
    if (!pending) throw new Error("pending effect missing");

    await expect(new EffectRunner({
      store,
      fence: { ...executor, signal: new AbortController().signal },
      now: () => 1_000,
    }).run(pending)).rejects.toThrow(/effect lease was lost/i);
    expect(db.prepare("SELECT COUNT(*) AS count FROM outbox").get()).toEqual({ count: 0 });
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
    const claimed = leaseEffectsForTest(store, first.ownerId, first.generation, 1_000, 1, 100);
    expect(claimed).toHaveLength(1);
    expect(store.acquireExecutorLease("owner-b", 1_101, 100)).toEqual({ acquired: true, generation: 2 });
    expect(store.renewExecutorLease(first.ownerId, first.generation, 1_102, 100)).toBe(false);
    expect(store.completeEffect(effect.idempotencyKey, first.ownerId, first.generation, 1_102)).toBe(false);
    expect(leaseEffectsForTest(store, "owner-b", 2, 1_102, 1, 100)[0]).toMatchObject({
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

  it.each([
    ["deploying", "deploy_production", "deploy", "DEPLOY", "verifying_production"],
    ["verifying_production", "verify_production", "canary", "CANARY", "complete"],
  ] as const)("persists terminal-bound production receipts for %s before advancing", async (state, kind, phase, role, nextState) => {
    const { store, db } = storeFixture();
    const policy = policyFixture();
    const job = store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "work", now: 1_000 });
    db.prepare(
      `UPDATE jobs SET state = ?, project_id = 'proj_1', policy_version = 1, policy_json = ?,
         environment_id = 'env_1', pr_number = 7, pr_head_sha = ?, merge_message = 'Merged PR #7',
         merge_commit_sha = ?, merged_at = '2026-08-10T00:00:00.000Z',
         deployment_summary = ?, version = 2 WHERE id = ?`,
    ).run(
      state,
      JSON.stringify(policy),
      "a".repeat(40),
      "d".repeat(40),
      phase === "canary" ? "Production deploy passed" : null,
      job.id,
    );
    const effect: JobEffect = {
      idempotencyKey: `job_1:3:${kind}`,
      jobId: job.id,
      kind,
      payload: {},
    };
    db.prepare(
      `INSERT INTO effects (idempotency_key, job_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, '{}', 'pending', 0, 1000, 1000, 1000)`,
    ).run(effect.idempotencyKey, effect.jobId, effect.kind);
    addProductionAdmissionAndClaims(db, job.id, policy, "owner-a", 1, 1_000, 31_000);
    const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, 1_001, 10, 30_000)
      .find((candidate) => candidate.idempotencyKey === effect.idempotencyKey);
    if (!claimed) throw new Error("production effect missing");
    const runStage = vi.fn(async (_job, _effect, calledPhase, _signal, observe) => {
      expect(calledPhase).toBe(phase);
      observe({ id: `term_${phase}`, status: "running", updatedAt: 1_001 });
      observe({ id: `term_${phase}`, status: "exited", updatedAt: 1_002, exitCode: 0 });
      return {
        phase,
        outcome: "pass" as const,
        summary: `Production ${phase} passed`,
        failedCommand: null,
        commandReceipts: [
          { name: "verify-merged-checkout", command: "git-head-check", outcome: "pass" as const, exitCode: 0, output: "ok" },
          { name: phase, command: `./${phase}`, outcome: "pass" as const, exitCode: 0, output: "ok" },
        ],
        terminalIds: [`term_${phase}`],
        completedAt: "2026-08-10T00:01:00.000Z",
      };
    });

    await new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      now: () => 1_002,
      runProductionStage: runStage,
    }).run(claimed);

    expect(store.getJob(job.id)?.state).toBe(nextState);
    expect(store.getLatestPipelineStageAttempt(job.id, role)).toMatchObject({
      state: "completed",
      resourceKind: "bb_terminal",
      resourceId: `term_${phase}`,
      startSha: "d".repeat(40),
      endSha: "d".repeat(40),
      outcome: expect.objectContaining({ phase, outcome: "pass" }),
    });
    expect(store.getWorkerLiveness(job.id)).toMatchObject({ workerKind: phase === "deploy" ? "deploy" : "canary" });
  });

  it("blocks production execution before any stage attempt or provider call after target claim loss", async () => {
    const { store, db } = storeFixture();
    const policy = policyFixture({
      projectId: "proj_production_gate",
      githubRepository: "acme/production-gate",
      production: {
        ...policyFixture().production!,
        targetKey: "production-gate",
      },
    });
    const job = store.createJob({ id: "job_production_gate", sourceUpdateId: 1, requestText: "work", now: 1_000 });
    db.prepare(
      `UPDATE jobs SET state = 'deploying', project_id = ?, policy_version = 1, policy_json = ?,
         environment_id = 'env_1', pr_number = 7, pr_head_sha = ?, merge_message = 'Merged',
         merge_commit_sha = ?, merged_at = '2026-08-10T00:00:00.000Z', version = 3 WHERE id = ?`,
    ).run(policy.projectId, JSON.stringify(policy), "a".repeat(40), "d".repeat(40), job.id);
    db.prepare(
      `INSERT INTO job_admissions (
         job_id, project_id, queue_seq, state, resume_event, queued_at, admitted_at
       ) VALUES (?, ?, 1, 'admitted', 'CONFIRMED', 1000, 1001)`,
    ).run(job.id, policy.projectId);
    const insertClaim = db.prepare(
      `INSERT INTO job_resource_claims (
         job_id, resource_key, resource_kind, state, owner_id, generation,
         lease_expires_at, acquired_at, renewed_at
       ) VALUES (?, ?, ?, 'held', 'owner-a', ?, ?, 1000, 1000)`,
    );
    insertClaim.run(job.id, projectResourceKey(policy.projectId), "project", 1, 31_000);
    insertClaim.run(job.id, productionResourceKey(policy), "production_target", 1, 31_000);
    const effect: JobEffect = {
      idempotencyKey: "job_production_gate:3:deploy_production",
      jobId: job.id,
      kind: "deploy_production",
      payload: {},
    };
    db.prepare(
      `INSERT INTO effects (idempotency_key, job_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, '{}', 'pending', 0, 1000, 1000, 1000)`,
    ).run(effect.idempotencyKey, effect.jobId, effect.kind);
    const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    const claimed = store.leaseNextJobEffect({
      jobId: job.id,
      ownerId: "owner-a",
      generation: lease.generation,
      now: 1_001,
      leaseMs: 30_000,
    });
    if (!claimed) throw new Error("production effect missing");
    db.prepare(
      `UPDATE job_resource_claims SET state = 'released', lease_expires_at = 0,
         released_at = 1002, release_reason = 'test_lost_production_claim'
       WHERE job_id = ? AND resource_kind = 'production_target'`,
    ).run(job.id);
    const runStage = vi.fn();

    await expect(new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      now: () => 1_002,
      runProductionStage: runStage,
    }).run(claimed)).rejects.toThrow();

    expect(runStage).not.toHaveBeenCalled();
    expect(store.getLatestPipelineStageAttempt(job.id, "DEPLOY")).toBeNull();
    expect(store.getJob(job.id)).toMatchObject({ state: "deploying", version: 3 });
    expect(db.prepare(
      "SELECT status, attempts FROM effects WHERE idempotency_key = ?",
    ).get(effect.idempotencyKey)).toEqual({ status: "leased", attempts: 1 });
  });

  it("fails closed without repeating a production command after executor interruption", async () => {
    const { store, db } = storeFixture();
    const policy = policyFixture();
    const job = store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "work", now: 1_000 });
    db.prepare(
      `UPDATE jobs SET state = 'deploying', project_id = 'proj_1', policy_version = 1, policy_json = ?,
         environment_id = 'env_1', pr_number = 7, pr_head_sha = ?, merge_message = 'Merged PR #7',
         merge_commit_sha = ?, merged_at = '2026-08-10T00:00:00.000Z', version = 2 WHERE id = ?`,
    ).run(JSON.stringify(policy), "a".repeat(40), "d".repeat(40), job.id);
    const effect: JobEffect = {
      idempotencyKey: "job_1:3:deploy_production",
      jobId: job.id,
      kind: "deploy_production",
      payload: {},
    };
    db.prepare(
      `INSERT INTO effects (idempotency_key, job_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, '{}', 'pending', 0, 1000, 1000, 1000)`,
    ).run(effect.idempotencyKey, effect.jobId, effect.kind);
    addProductionAdmissionAndClaims(db, job.id, policy, "owner-a", 1, 1_000, 31_000);

    const firstLease = store.acquireExecutorLease("owner-a", 1_001, 100);
    if (!firstLease.acquired) throw new Error("first lease missing");
    const firstClaim = leaseEffectsForTest(store, "owner-a", firstLease.generation, 1_001, 10, 100)[0];
    if (!firstClaim) throw new Error("first claim missing");
    const firstRun = vi.fn(async (_job, _effect, _phase, _signal, observe) => {
      observe({ id: "term_uncertain", status: "running", updatedAt: 1_001 });
      throw new Error("executor disconnected after command start");
    });
    await expect(new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: firstLease.generation, signal: new AbortController().signal },
      now: () => 1_001,
      runProductionStage: firstRun,
    }).run(firstClaim)).rejects.toThrow("executor disconnected");

    const secondLease = store.acquireExecutorLease("owner-b", 31_002, 30_000);
    if (!secondLease.acquired) throw new Error("second lease missing");
    expect(store.adoptHeldClaims({
      jobId: job.id,
      ownerId: "owner-b",
      generation: secondLease.generation,
      now: 31_002,
      leaseMs: 30_000,
    })).toBe(true);
    const secondClaim = leaseEffectsForTest(store, "owner-b", secondLease.generation, 31_002, 10, 30_000)[0];
    if (!secondClaim) throw new Error("second claim missing");
    const repeatedRun = vi.fn();
    await new EffectRunner({
      store,
      fence: { ownerId: "owner-b", generation: secondLease.generation, signal: new AbortController().signal },
      now: () => 31_002,
      runProductionStage: repeatedRun,
    }).run(secondClaim);

    expect(repeatedRun).not.toHaveBeenCalled();
    expect(store.getJob(job.id)).toMatchObject({
      state: "production_failed",
      mergeCommitSha: "d".repeat(40),
      lastError: "Production deploy outcome is unknown after executor interruption",
    });
    expect(store.getLatestPipelineStageAttempt(job.id, "DEPLOY")).toMatchObject({ state: "failed" });
  });

  it("dead-letters the twentieth transient failure and blocks the owning job", () => {
    const { store, db } = storeFixture();
    const effect: JobEffect = {
      idempotencyKey: "job_1:2:spawn_plan",
      jobId: "job_1",
      kind: "spawn_plan",
      payload: {},
    };
    addJobEffect(store, db, effect);
    const current = fence(store);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const claimed = leaseEffectsForTest(store, current.ownerId, current.generation, 1_000 + attempt, 1, 100);
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

  it("spends a status card's retries without costing the job", () => {
    // Redrawing the status card carries the pipeline nowhere, so exhausting its
    // retries says Telegram is unreachable, not that the work is unsound.
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
      const claimed = leaseEffectsForTest(store, current.ownerId, current.generation, 1_000 + attempt, 1, 100);
      expect(claimed).toHaveLength(1);
      expect(store.failEffect(effect.idempotencyKey, current.ownerId, current.generation, "bounded failure", 1_001 + attempt, 1_000 + attempt)).toBe(true);
    }
    expect(db.prepare("SELECT status FROM effects WHERE idempotency_key = ?").get(effect.idempotencyKey))
      .toEqual({ status: "dead" });
    expect(store.getJob("job_1")?.blockedReason).toBeNull();
    expect(store.getJob("job_1")?.state).not.toBe("blocked");
  });

  it("turns a permanent post-merge effect failure into a production incident", () => {
    const { store, db } = storeFixture();
    const policy = policyFixture();
    const job = store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "work", now: 1_000 });
    db.prepare(
      `UPDATE jobs SET state = 'deploying', project_id = ?, policy_version = 1, policy_json = ?,
         environment_id = 'env_1', merge_message = 'Merged PR #7', merge_commit_sha = ?,
         merged_at = '2026-08-10T00:00:00.000Z', version = 2 WHERE id = ?`,
    ).run(policy.projectId, JSON.stringify(policy), "d".repeat(40), job.id);
    const effect: JobEffect = {
      idempotencyKey: "job_1:3:deploy_production",
      jobId: job.id,
      kind: "deploy_production",
      payload: {},
    };
    db.prepare(
      `INSERT INTO effects (idempotency_key, job_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, '{}', 'pending', 0, 1000, 1000, 1000)`,
    ).run(effect.idempotencyKey, effect.jobId, effect.kind);
    addProductionAdmissionAndClaims(db, job.id, policy, "owner-a", 1, 1_000, 31_000);
    const lease = fence(store);
    const claimed = leaseEffectsForTest(store, lease.ownerId, lease.generation, 1_000, 1, 30_000)[0];
    if (!claimed) throw new Error("production effect missing");

    expect(store.deadLetterEffect(claimed.idempotencyKey, lease.ownerId, lease.generation, "Malformed deploy receipt", 1_001)).toBe(true);
    expect(store.getJob(job.id)).toMatchObject({
      state: "production_failed",
      resumeState: null,
      blockedReason: null,
      mergeCommitSha: "d".repeat(40),
      lastError: "Malformed deploy receipt",
    });
  });

  it("dispatches Start to a planner only through the injected BB runner after a live fence check", async () => {
    const { store, db } = storeFixture();
    const job = store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "work", now: 1_000 });
    store.applyJobEvent(job.id, job.version, {
      type: "PROJECT_SELECTED", projectId: "proj_1", policyVersion: 1, policy: policyFixture(),
    }, 1_001);
    admitConfirmedJob(store, store.getJob(job.id)!, 1_002);
    db.prepare(
      `UPDATE jobs SET routing_mode = 'active', task_recipe = 'architectural', delivery_mode = 'full',
         task_traits_json = '[]', task_reason_codes_json = '[]' WHERE id = ?`,
    ).run(job.id);
    const effect = store.listEffectsForJob(job.id).find((item) => item.kind === "spawn_plan");
    if (!effect) throw new Error("spawn effect missing");
    const lease = store.acquireExecutorLease("owner-a", 1_003, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    db.prepare("UPDATE job_resource_claims SET state = 'released', lease_expires_at = 0, released_at = ?, release_reason = ? WHERE job_id = ?")
      .run(1_003, "test-fence-setup", job.id);
    const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, 1_003, 10, 30_000)
      .find((item) => item.idempotencyKey === effect.idempotencyKey);
    if (!claimed) throw new Error("spawn effect was not leased");
    const spawnPlanner = vi.fn(async () => ({ id: "thr_plan", environmentId: "env_1" }));
    const deps = {
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      bb: { spawnPlanner },
      now: () => 1_004,
    } satisfies EffectRunnerDependencies;

    const runner = new EffectRunner(deps);
    await runner.run(claimed);

    expect(spawnPlanner).toHaveBeenCalledTimes(1);
    expect(store.getJob(job.id)).toMatchObject({ state: "planning", environmentId: "env_1" });
    expect(store.getLatestPipelineStageAttempt(job.id, "PLAN")).toMatchObject({
      state: "running",
      threadId: "thr_plan",
      environmentId: "env_1",
    });
    expect(store.listModelRouteTrials("worker_attempt", `stage:${effect.idempotencyKey}`, 10)).toMatchObject([
      { attempt: 1, route: { pool: "strong", modelId: "gpt-5.6-sol" }, outcome: "passed" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM effects WHERE kind = 'spawn_plan'").get()).toEqual({ count: 1 });
  });

  it("does not invoke BB after the executor fence is lost", async () => {
    const { store, db } = storeFixture();
    const job = store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "work", now: 1_000 });
    store.applyJobEvent(job.id, job.version, {
      type: "PROJECT_SELECTED", projectId: "proj_1", policyVersion: 1, policy: policyFixture(),
    }, 1_001);
    admitConfirmedJob(store, store.getJob(job.id)!, 1_002);
    const effect = store.listEffectsForJob(job.id).find((item) => item.kind === "spawn_plan");
    if (!effect) throw new Error("spawn effect missing");
    const first = store.acquireExecutorLease("owner-a", 1_003, 100);
    if (!first.acquired) throw new Error("lease missing");
    const claimed = leaseEffectsForTest(store, "owner-a", first.generation, 1_003, 10, 100)
      .find((item) => item.idempotencyKey === effect.idempotencyKey);
    if (!claimed) throw new Error("spawn effect was not leased");
    expect(store.acquireExecutorLease("owner-b", 1_104, 100)).toEqual({ acquired: true, generation: first.generation + 1 });
    const spawnPlanner = vi.fn(async () => ({ id: "thr_plan", environmentId: "env_1" }));

    await expect(new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: first.generation, signal: new AbortController().signal },
      bb: { spawnPlanner },
      now: () => 1_105,
    }).run(claimed)).rejects.toThrow("executor lease was lost");

    expect(spawnPlanner).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status, lease_owner, lease_generation FROM effects WHERE idempotency_key = ?").get(effect.idempotencyKey)).toEqual({
      status: "leased",
      lease_owner: "owner-a",
      lease_generation: first.generation,
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
    const claimed = leaseEffectsForTest(store, current.ownerId, current.generation, 1_000, 1, 100)[0];
    if (!claimed) throw new Error("effect missing");
    await expect(new EffectRunner({
      store,
      fence: { ownerId: current.ownerId, generation: current.generation, signal: new AbortController().signal },
      now: () => 1_001,
    }).run(claimed)).rejects.toBeInstanceOf(PermanentEffectError);
  });

  it.each([
    ["validating", "run_validation", "TEST", "reviewing"],
    ["final_validating", "run_final_validation", "FINAL_TEST", "final_reviewing"],
  ] as const)("persists terminal-bound %s receipts before advancing", async (state, kind, role, nextState) => {
    const { store, db } = storeFixture();
    const job = store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "work", now: 1_000 });
    db.prepare(
      `UPDATE jobs SET state = ?, project_id = 'proj_1', policy_version = 1, policy_json = ?,
         environment_id = 'env_1', pr_number = 7, pr_url = 'https://github.com/acme/cyndra/pull/7',
         pr_head_sha = ?, version = 2 WHERE id = ?`,
    ).run(state, JSON.stringify(policyFixture()), "a".repeat(40), job.id);
    const effect: JobEffect = {
      idempotencyKey: `job_1:3:${kind}`,
      jobId: job.id,
      kind,
      payload: { headSha: "a".repeat(40) },
    };
    db.prepare(
      `INSERT INTO effects (idempotency_key, job_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, 1000, 1000, 1000)`,
    ).run(effect.idempotencyKey, effect.jobId, effect.kind, JSON.stringify(effect.payload));
    const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, 1_001, 10, 30_000)
      .find((candidate) => candidate.idempotencyKey === effect.idempotencyKey);
    if (!claimed) throw new Error("validation effect missing");

    await new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      now: () => 1_002,
      runValidation: vi.fn(async () => ({
        headSha: "a".repeat(40),
        originRepository: "acme/cyndra",
        commandReceipts: [{ command: "npm test", outcome: "pass" as const, exitCode: 0, output: "42 passed" }],
        githubPr: {
          number: 7,
          url: "https://github.com/acme/cyndra/pull/7",
          state: "OPEN",
          isDraft: false,
          baseRefName: "main",
          headRefName: "feature/test",
          mergeStateStatus: "CLEAN",
          mergeable: "MERGEABLE",
          reviewDecision: null,
          changedFiles: 1,
          additions: 1,
          deletions: 0,
          mergeCommit: null,
          mergedAt: null,
        },
        requiredChecks: [{ name: "test", bucket: "pass", state: "SUCCESS", link: null }],
        validationOutcome: "pass" as const,
        completedAt: "2026-08-10T00:00:00.000Z",
        terminalIds: ["term_unit", "term_checks"],
      })),
    }).run(claimed);

    expect(store.getJob(job.id)?.state).toBe(nextState);
    expect(store.getLatestPipelineStageAttempt(job.id, role)).toMatchObject({
      state: "completed",
      resourceKind: "bb_terminal",
      resourceId: "term_checks",
      startSha: "a".repeat(40),
      endSha: "a".repeat(40),
      outcome: expect.objectContaining({ validationOutcome: "pass", headSha: "a".repeat(40) }),
    });
  });

  it("persists authoritative PR-head evidence before advancing to validation", async () => {
    const { store, db } = storeFixture();
    const job = store.createJob({ id: "job_head", sourceUpdateId: 91, requestText: "work", now: 1_000 });
    db.prepare(
      `UPDATE jobs SET state = 'resolving_pr_head', project_id = 'proj_1', policy_version = 1, policy_json = ?,
         environment_id = 'env_1', pr_number = 7, pr_url = 'https://github.com/acme/cyndra/pull/7',
         version = 2 WHERE id = ?`,
    ).run(JSON.stringify(policyFixture()), job.id);
    const effect: JobEffect = {
      idempotencyKey: "job_head:3:resolve_pr_head",
      jobId: job.id,
      kind: "resolve_pr_head",
      payload: { prNumber: 7 },
    };
    db.prepare(
      `INSERT INTO effects (idempotency_key, job_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, 1000, 1000, 1000)`,
    ).run(effect.idempotencyKey, effect.jobId, effect.kind, JSON.stringify(effect.payload));
    const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, 1_001, 10, 30_000)
      .find((candidate) => candidate.idempotencyKey === effect.idempotencyKey);
    if (!claimed) throw new Error("head effect missing");

    await new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      now: () => 1_002,
      resolvePrHead: vi.fn(async () => ({
        event: "PR_HEAD_RESOLVED" as const,
        headSha: "a".repeat(40),
        originRepository: "acme/cyndra",
      })),
    }).run(claimed);

    expect(store.getJob(job.id)).toMatchObject({ state: "validating", prHeadSha: "a".repeat(40) });
    expect(store.getLatestPipelineStageAttempt(job.id, "BUILD")).toMatchObject({
      state: "completed",
      startSha: "a".repeat(40),
      endSha: "a".repeat(40),
      outcome: {
        verdict: "success",
        prNumber: 7,
        headSha: "a".repeat(40),
        originRepository: "acme/cyndra",
      },
    });
  });

  it.each([
    ["full", ["quality", "risk"]],
    ["small_fix", ["quality"]],
  ] as const)("spawns the required %s review lenses at the same head", async (deliveryMode, expectedLenses) => {
    const { store, db } = storeFixture();
    const job = store.createJob({ id: `job_review_${deliveryMode}`, sourceUpdateId: deliveryMode === "full" ? 92 : 93, requestText: "work", now: 1_000 });
    db.prepare(
      `UPDATE jobs SET state = 'reviewing', project_id = 'proj_1', policy_version = 1, policy_json = ?,
         delivery_mode = ?, environment_id = 'env_1', implementation_thread_id = 'thr_impl',
         pr_number = 7, pr_url = 'https://github.com/acme/cyndra/pull/7', pr_head_sha = ?, version = 2
       WHERE id = ?`,
    ).run(JSON.stringify(policyFixture()), deliveryMode, "a".repeat(40), job.id);
    const effect: JobEffect = {
      idempotencyKey: `${job.id}:3:spawn_review`,
      jobId: job.id,
      kind: "spawn_review",
      payload: { headSha: "a".repeat(40) },
    };
    db.prepare(
      `INSERT INTO effects (idempotency_key, job_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, 1000, 1000, 1000)`,
    ).run(effect.idempotencyKey, effect.jobId, effect.kind, JSON.stringify(effect.payload));
    const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, 1_001, 10, 30_000)[0];
    if (!claimed) throw new Error("review effect missing");
    const spawned: string[] = [];

    await new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      now: () => 1_002,
      bb: {
        spawnReview: vi.fn(async (_job, attempt) => {
          spawned.push(attempt.id);
          return { id: `thr_${attempt.id}`, environmentId: "env_1" };
        }),
      },
    }).run(claimed);

    const attempts = store.listReviewAttempts(job.id, "review", 1);
    expect(attempts.map((attempt) => attempt.reviewLens)).toEqual(expectedLenses);
    expect(attempts.every((attempt) => attempt.headSha === "a".repeat(40) && attempt.threadId !== null)).toBe(true);
    expect(spawned).toHaveLength(expectedLenses.length);
    expect(store.getJob(job.id)?.reviewThreadId).toBe(attempts[0].threadId);
  });

  it("selects active review guards from the exact observed change surface", async () => {
    const { store, db } = storeFixture();
    const job = store.createJob({ id: "job_profiled_review", sourceUpdateId: 194, requestText: "review", now: 1_000 });
    db.prepare(
      `UPDATE jobs SET state = 'reviewing', project_id = 'proj_1', policy_version = 1, policy_json = ?,
         delivery_mode = 'full', routing_mode = 'active', task_recipe = 'bounded',
         task_traits_json = '[]', task_reason_codes_json = '[]',
         environment_id = 'env_1', implementation_thread_id = 'thr_impl',
         pr_number = 7, pr_url = 'https://github.com/acme/cyndra/pull/7', pr_head_sha = ?, version = 2
       WHERE id = ?`,
    ).run(JSON.stringify(policyFixture()), "a".repeat(40), job.id);
    const effect: JobEffect = {
      idempotencyKey: `${job.id}:3:spawn_review`,
      jobId: job.id,
      kind: "spawn_review",
      payload: { headSha: "a".repeat(40) },
    };
    db.prepare(
      `INSERT INTO effects (idempotency_key, job_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, 1000, 1000, 1000)`,
    ).run(effect.idempotencyKey, effect.jobId, effect.kind, JSON.stringify(effect.payload));
    const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, 1_001, 10, 30_000)[0];
    if (!claimed) throw new Error("review effect missing");
    const attachedSkills: string[][] = [];

    await new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      now: () => 1_002,
      minimumModelPool: () => "strong",
      bb: {
        getEnvironmentSnapshot: vi.fn(async () => ({
          status: { outcome: "available" } as never,
          diff: {
            outcome: "available",
            diff: {
              diff: [
                "diff --git a/src/feature.ts b/src/feature.ts",
                "+++ b/src/feature.ts",
                String.raw`diff --git "a/tests/\303\251xample.test.ts" "b/tests/\303\251xample.test.ts"`,
                String.raw`+++ "b/tests/\303\251xample.test.ts"`,
              ].join("\n"),
              truncated: false,
            },
          } as never,
        })),
        spawnReview: vi.fn(async (_activeJob, attempt) => {
          const profile = store.getActiveCapabilityProfile("worker_attempt", attempt.id);
          attachedSkills.push(profile?.assignments.map((assignment) => assignment.capabilityId) ?? []);
          expect(attempt.capabilityProfile?.profileId).toBe(profile?.id);
          expect(profile?.model).toMatchObject({ pool: "strong", modelId: "gpt-5.6-sol" });
          return { id: `thr_${attempt.id}`, environmentId: "env_1" };
        }),
      },
    }).run(claimed);

    expect(attachedSkills).toEqual([
      ["clean-code-guard", "test-guard"],
      [],
    ]);
    expect(db.prepare(
      `SELECT capability_id, outcome FROM capability_receipts
        WHERE capability_kind = 'native-adapter' AND event_type = 'outcome'
        ORDER BY capability_id ASC`,
    ).all()).toEqual([
      { capability_id: "hanoon-native-dispatching-parallel-agents", outcome: "passed" },
      { capability_id: "hanoon-native-requesting-code-review", outcome: "passed" },
      { capability_id: "hanoon-native-using-superpowers", outcome: "passed" },
    ]);
  });

  it.each([
    ["reviewing", "spawn_review", "spawnReview"],
    ["final_reviewing", "spawn_final_review", "spawnFinalReview"],
  ] as const)(
    "reconstructs one atomic native profile when %s review registration crashes",
    async (state, effectKind, spawnMethod) => {
      const { store, db } = storeFixture();
      const job = store.createJob({
        id: `job_review_crash_${state}`,
        sourceUpdateId: state === "reviewing" ? 296 : 297,
        requestText: "review",
        now: 1_000,
      });
      db.prepare(
        `UPDATE jobs SET state = ?, project_id = 'proj_1', policy_version = 1, policy_json = ?,
           delivery_mode = 'full', routing_mode = 'active', task_recipe = 'architectural',
           task_traits_json = '[]', task_reason_codes_json = '[]',
           environment_id = 'env_1', implementation_thread_id = 'thr_impl', review_thread_id = NULL,
           pr_number = 7, pr_url = 'https://github.com/acme/cyndra/pull/7', pr_head_sha = ?, version = 2
         WHERE id = ?`,
      ).run(state, JSON.stringify(policyFixture()), "a".repeat(40), job.id);
      const effect: JobEffect = {
        idempotencyKey: `${job.id}:3:${effectKind}`,
        jobId: job.id,
        kind: effectKind,
        payload: { headSha: "a".repeat(40) },
      };
      db.prepare(
        `INSERT INTO effects (idempotency_key, job_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 0, 1000, 1000, 1000)`,
      ).run(effect.idempotencyKey, effect.jobId, effect.kind, JSON.stringify(effect.payload));
      const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
      if (!lease.acquired) throw new Error("lease missing");
      const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, 1_001, 10, 30_000)[0];
      if (!claimed) throw new Error("review effect missing");
      const spawn = vi.fn(async (_activeJob, attempt: { id: string }) => ({
        id: `thr_${attempt.id}`,
        environmentId: "env_1",
      }));
      const bb = {
        getEnvironmentSnapshot: vi.fn(async () => ({
          status: { outcome: "available" } as never,
          diff: {
            outcome: "available",
            diff: { diff: "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts", truncated: false },
          } as never,
        })),
        [spawnMethod]: spawn,
      };
      const crash = vi.spyOn(store, "registerExecutorReviewThread")
        .mockImplementationOnce(() => { throw new Error("simulated crash after REVIEW_STARTED"); });

      await expect(new EffectRunner({
        store,
        fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
        now: () => 1_002,
        bb,
      }).run(claimed)).rejects.toThrow(/simulated crash/i);
      crash.mockRestore();

      expect(store.getJob(job.id)).toMatchObject({ state, reviewThreadId: null, version: 3 });
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(db.prepare(
        `SELECT COUNT(DISTINCT profile_id) AS count FROM capability_receipts
          WHERE capability_kind = 'native-adapter' AND event_type = 'outcome'`,
      ).get()).toEqual({ count: 1 });
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM capability_receipts
          WHERE capability_kind = 'native-adapter' AND event_type = 'outcome'`,
      ).get()).toEqual({ count: 3 });

      const retryRunner = new EffectRunner({
        store,
        fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
        now: () => 1_003,
        bb,
      });
      await retryRunner.run(claimed);
      const reconstructed = store.getJob(job.id);
      expect(reconstructed).toMatchObject({ state, reviewThreadId: expect.stringMatching(/^thr_/) });
      expect(spawn).toHaveBeenCalledTimes(2);
      const reconstructedVersion = reconstructed?.version;

      await retryRunner.run(claimed);
      expect(store.getJob(job.id)?.version).toBe(reconstructedVersion);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(db.prepare(
        `SELECT COUNT(*) AS count FROM capability_receipts
          WHERE capability_kind = 'native-adapter' AND event_type = 'outcome'`,
      ).get()).toEqual({ count: 3 });
    },
  );

  it("fails closed before active review spawn when the exact diff is unavailable", async () => {
    const { store, db } = storeFixture();
    const job = store.createJob({ id: "job_missing_review_diff", sourceUpdateId: 195, requestText: "review", now: 1_000 });
    db.prepare(
      `UPDATE jobs SET state = 'reviewing', project_id = 'proj_1', policy_version = 1, policy_json = ?,
         delivery_mode = 'small_fix', routing_mode = 'active', task_recipe = 'direct',
         task_traits_json = '[]', task_reason_codes_json = '[]',
         environment_id = 'env_1', implementation_thread_id = 'thr_impl',
         pr_number = 7, pr_url = 'https://github.com/acme/cyndra/pull/7', pr_head_sha = ?, version = 2
       WHERE id = ?`,
    ).run(JSON.stringify(policyFixture()), "a".repeat(40), job.id);
    const effect: JobEffect = {
      idempotencyKey: `${job.id}:3:spawn_review`,
      jobId: job.id,
      kind: "spawn_review",
      payload: { headSha: "a".repeat(40) },
    };
    db.prepare(
      `INSERT INTO effects (idempotency_key, job_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, 1000, 1000, 1000)`,
    ).run(effect.idempotencyKey, effect.jobId, effect.kind, JSON.stringify(effect.payload));
    const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, 1_001, 10, 30_000)[0];
    if (!claimed) throw new Error("review effect missing");
    const spawnReview = vi.fn(async () => ({ id: "thr_review", environmentId: "env_1" }));

    await expect(new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      now: () => 1_002,
      bb: {
        getEnvironmentSnapshot: vi.fn(async () => ({
          status: { outcome: "available" } as never,
          diff: { outcome: "available", diff: { diff: "partial", truncated: true } } as never,
        })),
        spawnReview,
      },
    }).run(claimed)).rejects.toThrow(/exact review change surface/i);

    expect(spawnReview).not.toHaveBeenCalled();
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
    const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, 1_001, 10, 30_000)
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

  it("stops and confirms every active reviewer before cancelling a two-lens job", async () => {
    const { store, db } = storeFixture();
    const draft = store.createJob({ id: "job_review_cancel", sourceUpdateId: 1, requestText: "work", now: 1_000 });
    db.prepare(
      "UPDATE jobs SET state = 'reviewing', review_thread_id = ?, version = ?, updated_at = ? WHERE id = ?",
    ).run("thr_quality", 2, 1_000, draft.id);
    const current = store.getJob(draft.id);
    if (!current) throw new Error("job missing");
    const workers = ["thr_quality", "thr_risk"].map((resourceId) => ({
      jobId: current.id,
      workerKind: "review" as const,
      resourceKind: "bb_thread" as const,
      resourceId,
      generation: 204,
      state: "active" as const,
      sourceUpdatedAt: 1_000,
      observedAt: 1_000,
      staleNotifiedAt: null,
    }));
    for (const worker of workers) store.upsertWorkerLiveness(worker);
    store.applyJobEvent(current.id, current.version, {
      type: "CANCEL_REQUESTED",
      activeWorker: workers[0],
      activeWorkers: workers,
    }, 1_001);
    const effect = store.listEffectsForJob(current.id).find((item) => item.kind === "stop_thread");
    if (!effect) throw new Error("stop effect missing");
    const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
    if (!lease.acquired) throw new Error("executor lease missing");
    const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, 1_001, 10, 30_000)
      .find((item) => item.idempotencyKey === effect.idempotencyKey);
    if (!claimed) throw new Error("stop effect was not leased");
    const stopWorker = vi.fn(async (_worker: WorkerLiveness) => undefined);

    await new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      bb: {
        stopWorker,
        getThread: vi.fn(async (threadId: string) => ({
          id: threadId,
          projectId: "proj_1",
          environmentId: null,
          parentThreadId: null,
          title: "review",
          status: "idle",
          updatedAt: 1_002,
          runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
        })),
      },
      now: () => 1_002,
    }).run(claimed);

    expect(stopWorker.mock.calls.map(([worker]) => worker.resourceId)).toEqual(["thr_quality", "thr_risk"]);
    expect(store.getJob(current.id)?.state).toBe("cancelled");
  });
});

it.each([null, undefined, ""])("retries rather than dies when the worktree has not attached yet (%p)", (environmentId) => {
  // A managed worktree attaches a few seconds after spawn returns, so an absent
  // environment id is timing, not breakage. Treating it as permanent killed
  // every job at its first spawn and blocked the whole pipeline.
  let thrown: unknown;
  try {
    threadResultEnvironment({ environmentId });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).not.toBeInstanceOf(PermanentEffectError);
});

it("accepts an environment id once the worktree has attached", () => {
  expect(threadResultEnvironment({ environmentId: "env_worker" })).toBe("env_worker");
});

describe("late managed worktree", () => {
  it("survives BB attaching the worktree after the spawn call returns", async () => {
    const { store, db } = storeFixture();
    const job = selectedJobForRecovery(store, db, "job_late_worktree", "creating_implementation");
    if (!job) throw new Error("job missing");
    const effect: JobEffect = {
      idempotencyKey: `${job.id}:2:spawn_implementation`,
      jobId: job.id,
      kind: "spawn_implementation",
      payload: {},
    };
    addPendingEffectForRecovery(db, effect);
    const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    addProductionAdmissionAndClaims(db, job.id, policyFixture(), "owner-a", lease.generation, 1_001, 31_000);
    const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, 1_001, 10, 30_000)
      .find((candidate) => candidate.idempotencyKey === effect.idempotencyKey);
    if (!claimed) throw new Error("spawn effect missing");

    // This is what BB really does: the thread exists immediately, its managed
    // worktree attaches a moment later. Every fake in this suite returned the
    // environment id straight away, which is why a bug that killed *every* job
    // in production could not be seen from here.
    let attempt = 0;
    const spawnImplementation = vi.fn(async () => ({
      id: "thr_late_worktree",
      environmentId: (attempt += 1) === 1 ? null : "env_attached",
    }));
    const listThreads = vi.fn(async () => ({ threads: [], total: 0 }));
    const runner = () => new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      bb: { listThreads, spawnImplementation },
      now: () => 1_002,
    }).run(claimed);

    // First pass: no environment yet. It must be retryable, never fatal.
    const firstFailure = await runner().then(() => null, (error: unknown) => error);
    expect(firstFailure).toBeInstanceOf(Error);
    expect(store.getJob(job.id)?.state).toBe("creating_implementation");

    // Settle it exactly as the executor does. This is the assertion that
    // matters: a late worktree must land in 'failed' with a retry backoff, not
    // in the dead letter that used to strand the whole pipeline.
    expect(settleEffectFailure(
      store, claimed, "owner-a", lease.generation, 1_003, firstFailure, () => 0,
    )).toBe(true);
    const afterFirst = store.getEffect(job.id, effect.idempotencyKey);
    expect(afterFirst?.status).toBe("failed");

    // Second pass, once the worktree has attached: the job proceeds. Stay
    // inside the executor lease taken at 1_001 — past it, leaseEffects returns
    // nothing because the executor, not the effect, is what expired.
    const retry = leaseEffectsForTest(store, "owner-a", lease.generation, 2_000, 10, 30_000)
      .find((candidate) => candidate.idempotencyKey === effect.idempotencyKey);
    if (!retry) throw new Error("effect was not retryable");
    await new EffectRunner({
      store,
      fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
      bb: { listThreads, spawnImplementation },
      now: () => 2_001,
    }).run(retry);

    expect(store.getJob(job.id)).toMatchObject({
      state: "implementing",
      implementationThreadId: "thr_late_worktree",
      environmentId: "env_attached",
    });
  });
});

describe("recovering the jobs this bug already blocked", () => {
  it("carries a blocked permanent_effect_failure job back through a plain retry", async () => {
    // The exact shape the four dead adopted-PR jobs are in: blocked on a
    // dead-lettered spawn_implementation, admission released, and the first
    // attempt still holding ordinal 1. Nothing here is repaired by hand.
    const { store, db } = storeFixture();
    const job = selectedJobForRecovery(store, db, "job_blocked_recovery", "creating_implementation");
    if (!job) throw new Error("job missing");
    const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    addProductionAdmissionAndClaims(db, job.id, policyFixture(), "owner-a", lease.generation, 1_001, 31_000);
    const spawnImplementation = vi.fn(async () => ({ id: "thr_first", environmentId: "env_1" }));
    const runSpawn = async (idempotencyKey: string, now: number): Promise<void> => {
      const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, now, 10, 30_000)
        .find((candidate) => candidate.idempotencyKey === idempotencyKey);
      if (!claimed) throw new Error(`spawn effect ${idempotencyKey} missing`);
      await new EffectRunner({
        store,
        fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
        bb: { spawnImplementation },
        now: () => now,
      }).run(claimed);
    };
    addPendingEffectForRecovery(db, {
      idempotencyKey: `${job.id}:2:spawn_implementation`,
      jobId: job.id,
      kind: "spawn_implementation",
      payload: {},
    });
    await runSpawn(`${job.id}:2:spawn_implementation`, 1_002);
    expect(store.getJob(job.id)?.implementationThreadId).toBe("thr_first");

    db.prepare(
      `UPDATE jobs SET state = 'blocked', blocked_reason = 'permanent_effect_failure',
         resume_state = 'creating_implementation', implementation_thread_id = NULL,
         last_error = 'Attempt was not stored', version = version + 1 WHERE id = ?`,
    ).run(job.id);
    db.prepare("UPDATE effects SET status = 'dead' WHERE job_id = ?").run(job.id);
    db.prepare("UPDATE job_admissions SET state = 'released', released_at = ?, release_reason = 'blocked' WHERE job_id = ?")
      .run(1_003, job.id);
    // Releasing an admission releases the job's resource claims with it; without
    // that the project still reads as busy and nothing could ever be readmitted.
    db.prepare("UPDATE job_resource_claims SET state = 'released', released_at = ? WHERE job_id = ?")
      .run(1_003, job.id);
    const blocked = store.getJob(job.id)!;

    // Step one: the owner's retry. It queues rather than transitions, which is
    // why the job looks untouched at this point.
    const queued = store.retryFailedJob(blocked.id, blocked.version, 1_004);
    expect(queued.outcome).toBe("queued");
    expect(store.getJob(job.id)).toMatchObject({ state: "blocked", updatedAt: blocked.updatedAt });

    // Step two: the scheduler admits it and the RETRY lands.
    expect(store.tryAdmit({
      jobId: job.id,
      maxConcurrentJobs: 8,
      ownerId: "owner-a",
      generation: lease.generation,
      now: 1_005,
      leaseMs: 30_000,
    }).outcome).toBe("admitted");
    expect(store.getJob(job.id)).toMatchObject({ state: "creating_implementation", blockedReason: null });

    // Step three: the requeued stage spawns, which is the step that used to die.
    const requeued = store.listEffectsForJob(job.id)
      .find((candidate) => candidate.kind === "spawn_implementation" && candidate.status === "pending");
    if (!requeued) throw new Error("retry did not requeue the implementation stage");
    spawnImplementation.mockResolvedValue({ id: "thr_second", environmentId: "env_1" });
    await runSpawn(requeued.idempotencyKey, 1_006);

    expect(store.getJob(job.id)).toMatchObject({ state: "implementing", implementationThreadId: "thr_second" });
    const ordinals = db
      .prepare("SELECT ordinal FROM attempts WHERE job_id = ? AND kind = 'implementation' ORDER BY ordinal")
      .all(job.id) as { ordinal: number }[];
    expect(ordinals.map((row) => row.ordinal)).toEqual([1, 2]);
  });
});

it("does not announce a located pull request while the job is still implementing", async () => {
  const { store, db } = storeFixture();
  const draft = store.createJob({ id: "job_pr_located_guard", sourceUpdateId: 1, requestText: "work", now: 1_000 });
  db.prepare(
    `UPDATE jobs SET state = 'implementing', project_id = 'proj_1', policy_version = 1, policy_json = ?,
       implementation_thread_id = 'thr_impl', environment_id = 'env_1', version = 2 WHERE id = ?`,
  ).run(JSON.stringify(policyFixture()), draft.id);

  const lease = store.acquireExecutorLease("owner-a", 1_003, 30_000);
  if (!lease.acquired) throw new Error("lease missing");
  addProductionAdmissionAndClaims(db, draft.id, policyFixture(), "owner-a", lease.generation, 1_003, 31_000);
  const effect = {
    jobId: draft.id,
    kind: "inspect_implementation",
    idempotencyKey: `${draft.id}:2:inspect_implementation`,
    payload: {},
  } as unknown as JobEffect;
  addPendingEffectForRecovery(db, effect);
  const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, 1_004, 10, 30_000)
    .find((candidate) => candidate.idempotencyKey === effect.idempotencyKey);
  if (!claimed) throw new Error("effect was not leased");

  // Looking for the pull request from `implementing` is the out-of-order step
  // that used to fail the job for good: whatever the lookup finds, the verdict
  // is not legal from this state. A retry re-entered `implementing` and walked
  // straight back into the same wall.
  await new EffectRunner({
    store,
    fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
    bb: {
      getEnvironmentSnapshot: async () => ({ status: { outcome: "available" } }),
      getPullRequestSnapshot: async () => ({ outcome: "available", number: 26, url: "https://example.test/pr/26" }),
    },
    now: () => 1_005,
  } as unknown as EffectRunnerDependencies).run(claimed);

  const after = store.getJob(draft.id);
  expect(after).toMatchObject({ state: "implementing", prNumber: null });
  expect(after?.blockedReason ?? null).toBeNull();
});

// Remediation edits the worktree but never commits: the work order forbids it,
// and the executor owns publishing. With a pull request already open, the
// lookup reported it and returned, so the head never moved and review blocked
// on "a new head is required after changes were requested" — forever. The
// publish command already commits, pushes, and tolerates an existing PR, so
// it must run on every pass, not only the first.
it("commits and pushes remediation work when the pull request already exists", async () => {
  const { store, db } = storeFixture();
  const draft = store.createJob({ id: "job_remediation_head", sourceUpdateId: 1, requestText: "fix it", now: 1_000 });
  db.prepare(
    `UPDATE jobs SET state = 'locating_pr', project_id = 'proj_1', policy_version = 1, policy_json = ?,
       implementation_thread_id = 'thr_impl', environment_id = 'env_1', pr_number = 42,
       pr_url = 'https://example.test/pr/42', version = 2 WHERE id = ?`,
  ).run(JSON.stringify(policyFixture()), draft.id);

  const lease = store.acquireExecutorLease("owner-a", 1_003, 30_000);
  if (!lease.acquired) throw new Error("lease missing");
  addProductionAdmissionAndClaims(db, draft.id, policyFixture(), "owner-a", lease.generation, 1_003, 31_000);
  const effect = {
    jobId: draft.id,
    kind: "inspect_implementation",
    idempotencyKey: `${draft.id}:2:inspect_implementation`,
    payload: {},
  } as unknown as JobEffect;
  addPendingEffectForRecovery(db, effect);
  const claimed = leaseEffectsForTest(store, "owner-a", lease.generation, 1_004, 10, 30_000)
    .find((candidate) => candidate.idempotencyKey === effect.idempotencyKey);
  if (!claimed) throw new Error("effect was not leased");

  const commands: string[] = [];
  await new EffectRunner({
    store,
    fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
    bb: {
      getEnvironmentSnapshot: async () => ({
        status: { outcome: "available", checkout: { kind: "branch", branchName: "bb/fix-it" } },
      }),
      getPullRequestSnapshot: async () => ({
        outcome: "available",
        pullRequest: { number: 42, url: "https://example.test/pr/42" },
      }),
    },
    terminal: {
      run: async (input: { command: string }) => {
        commands.push(input.command);
        return {
          outcome: "exited",
          exitCode: 0,
          output: '{"number":42,"url":"https://example.test/pr/42"}',
        };
      },
    },
    now: () => 1_005,
  } as unknown as EffectRunnerDependencies).run(claimed);

  expect(commands.join("\n")).toContain("git commit");
  expect(commands.join("\n")).toContain("git push -u origin HEAD");
  expect(store.getJob(draft.id)?.prNumber).toBe(42);
});
