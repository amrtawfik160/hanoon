import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { JobEffect, StoredEffect } from "../src/domain/models";
import { productionResourceKey, projectResourceKey } from "../src/autonomy/models";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { admitConfirmedJob, policyFixture } from "./helpers";
import { settleEffectFailure } from "../src/services/job-executor-service";
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
      bb: { listThreads, spawnImplementation },
      now: () => 1_002,
    }).run(claimed);

    expect(listThreads).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj_1" }));
    expect(spawnImplementation).not.toHaveBeenCalled();
    expect(store.getJob(job.id)).toMatchObject({
      state: "implementing",
      implementationThreadId: "thr_recovered_ordinary",
      environmentId: "env_ordinary",
    });
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
