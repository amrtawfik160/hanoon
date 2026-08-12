import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { JobEffect, StoredEffect, WorkerLiveness } from "../src/domain/models";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { policyFixture } from "./helpers";

let fixtureNumber = 0;

function storeFixture(): { store: TelegramAgentStore; db: Database.Database } {
  const { bb } = createFakePluginHost({ pluginId: `telegram-agent-task5-effects-${fixtureNumber++}` });
  return { store: openStore(bb.storage), db: bb.storage.database() };
}

function selectAndQueue(store: TelegramAgentStore, jobId: string, now = 1_000) {
  const draft = store.createJob({ id: jobId, sourceUpdateId: now, requestText: "fence this work", now });
  const selected = store.applyJobEvent(draft.id, draft.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_1",
    policyVersion: 1,
    policy: policyFixture(),
  }, now + 1);
  store.queueAdmission({
    jobId,
    expectedVersion: selected.version,
    projectId: "proj_1",
    resumeEvent: "CONFIRMED",
    now: now + 1,
  });
  return selected;
}

function admitWithLease(
  store: TelegramAgentStore,
  selected: ReturnType<typeof selectAndQueue>,
  ownerId = "executor",
  now = 2_000,
  leaseMs = 10_000,
) {
  const lease = store.acquireExecutorLease(ownerId, now, leaseMs);
  if (!lease.acquired) throw new Error("executor lease was not acquired");
  const admission = store.tryAdmit({
    jobId: selected.id,
    maxConcurrentJobs: 8,
    ownerId,
    generation: lease.generation,
    now,
    leaseMs,
  });
  if (admission.outcome !== "admitted") throw new Error(`job was not admitted: ${admission.reason}`);
  return { job: admission.job, ownerId, generation: lease.generation };
}

function insertEffect(db: Database.Database, effect: JobEffect, now = 2_000): void {
  db.prepare(
    `INSERT INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
  ).run(effect.idempotencyKey, effect.jobId, effect.kind, JSON.stringify(effect.payload), now, now, now);
}

function exactStop(jobId: string): JobEffect {
  return {
    idempotencyKey: `${jobId}:stop-exact`,
    jobId,
    kind: "stop_thread",
    payload: {
      generation: 7,
      resourceId: "thr_worker",
      resourceKind: "bb_thread",
      workerKind: "implementation",
    },
  };
}

function worker(jobId: string, overrides: Partial<WorkerLiveness> = {}): WorkerLiveness {
  return {
    jobId,
    workerKind: "implementation",
    resourceKind: "bb_thread",
    resourceId: "thr_worker",
    generation: 7,
    state: "active",
    sourceUpdatedAt: 2_000,
    observedAt: 2_000,
    staleNotifiedAt: null,
    ...overrides,
  };
}

describe("executor-fenced autonomy effect leasing", () => {
  it("rejects every stale-generation mutation and leaves the successor effect owner intact", () => {
    const { store } = storeFixture();
    const selected = selectAndQueue(store, "job_stale");
    const first = admitWithLease(store, selected, "executor-one", 2_000, 100);
    const effect = store.listEffectsForJob(selected.id).find((candidate) => candidate.kind === "spawn_plan");
    if (!effect) throw new Error("admitted job did not persist its plan effect");
    const oldClaim = store.leaseNextJobEffect({
      jobId: selected.id,
      ownerId: first.ownerId,
      generation: first.generation,
      now: 2_001,
      leaseMs: 100,
    });
    if (!oldClaim) throw new Error("generation one did not lease a job effect");

    const created = store.createExecutorAttempt({
      id: "attempt_stale",
      jobId: selected.id,
      kind: "implementation",
      ordinal: 1,
      ownerId: first.ownerId,
      generation: first.generation,
      now: 2_002,
    });
    if (!created) throw new Error("generation one did not create its setup attempt");

    const successor = store.acquireExecutorLease("executor-two", 2_201, 10_000);
    expect(successor).toEqual({ acquired: true, generation: 2 });
    if (!successor.acquired) throw new Error("successor lease was not acquired");

    expect(store.applyExecutorJobEvent({
      jobId: selected.id,
      expectedVersion: first.job.version,
      event: { type: "PLAN_READY", attemptId: created.id },
      ownerId: first.ownerId,
      generation: first.generation,
      now: 2_202,
    })).toBeNull();
    expect(store.createExecutorAttempt({
      id: "attempt_rejected",
      jobId: selected.id,
      kind: "review",
      ordinal: 1,
      ownerId: first.ownerId,
      generation: first.generation,
      now: 2_202,
    })).toBeNull();
    expect(store.updateExecutorAttempt({
      attemptId: created.id,
      patch: { threadId: "thr_stale" },
      ownerId: first.ownerId,
      generation: first.generation,
      now: 2_202,
    })).toBeNull();
    expect(store.registerExecutorReviewThread({
      jobId: selected.id,
      expectedVersion: first.job.version,
      threadId: "thr_stale_review",
      ownerId: first.ownerId,
      generation: first.generation,
      now: 2_202,
    })).toBeNull();
    expect(store.renewJobOperationFences({
      jobId: selected.id,
      effectIdempotencyKey: oldClaim.idempotencyKey,
      ownerId: first.ownerId,
      generation: first.generation,
      now: 2_202,
      leaseMs: 10_000,
    })).toBe(false);
    expect(store.completeEffect(oldClaim.idempotencyKey, first.ownerId, first.generation, 2_202)).toBe(false);
    expect(store.upsertExecutorWorkerLiveness({
      value: worker(selected.id, { state: "active" }),
      ownerId: "executor-two",
      generation: successor.generation,
      now: 2_202,
    })).toBe(true);
    expect(store.upsertExecutorWorkerLiveness({
      value: worker(selected.id, { state: "unknown", observedAt: 2_202 }),
      ownerId: first.ownerId,
      generation: first.generation,
      now: 2_202,
    })).toBe(false);
    expect(store.getWorkerLiveness(selected.id)).toMatchObject({ state: "active" });

    const successorClaim = store.leaseNextJobEffect({
      jobId: selected.id,
      ownerId: "executor-two",
      generation: successor.generation,
      now: 2_202,
      leaseMs: 10_000,
    });
    expect(successorClaim).toBeNull();
    expect(store.getEffect(selected.id, oldClaim.idempotencyKey)).toMatchObject({
      status: "leased",
      attempts: oldClaim.attempts,
      leaseOwner: first.ownerId,
      leaseGeneration: first.generation,
    });
    expect(store.getJob(selected.id)?.state).toBe("planning");
    expect(store.getAttempt(created.id)?.threadId).toBeNull();
    expect(store.getAdmission(selected.id)?.state).toBe("admitted");
    expect(store.listHeldResourceClaims(selected.id, 10)[0]).toMatchObject({
      ownerId: first.ownerId,
      generation: first.generation,
      state: "held",
    });
  });

  it.each([
    { label: "fractional limit", limit: 1.5, busyJobIds: [] as string[] },
    { label: "oversized limit", limit: 101, busyJobIds: [] as string[] },
    { label: "non-finite limit", limit: Number.POSITIVE_INFINITY, busyJobIds: [] as string[] },
    { label: "oversized busy list", limit: 8, busyJobIds: Array.from({ length: 101 }, (_, index) => `busy_${index}`) },
    { label: "invalid busy id", limit: 8, busyJobIds: [""] },
  ])("rejects $label before mutating control effects", ({ limit, busyJobIds }) => {
    const { store, db } = storeFixture();
    const selected = selectAndQueue(store, `job_busy_${String(limit)}`);
    const admission = admitWithLease(store, selected);
    const before = db.prepare(
      "SELECT idempotency_key, status, attempts, lease_owner, lease_generation FROM effects WHERE job_id = ? ORDER BY idempotency_key",
    ).all(selected.id);

    expect(() => store.leaseControlEffects({
      ownerId: admission.ownerId,
      generation: admission.generation,
      now: 2_001,
      limit,
      leaseMs: 10_000,
      busyJobIds,
    })).toThrow(TypeError);

    expect(db.prepare(
      "SELECT idempotency_key, status, attempts, lease_owner, lease_generation FROM effects WHERE job_id = ? ORDER BY idempotency_key",
    ).all(selected.id)).toEqual(before);
  });

  it("leases only safe controls for queued work and never leases its job operation", () => {
    const { store, db } = storeFixture();
    const selected = selectAndQueue(store, "job_queued");
    insertEffect(db, {
      idempotencyKey: "job_queued:spawn",
      jobId: selected.id,
      kind: "spawn_plan",
      payload: {},
    });
    insertEffect(db, {
      idempotencyKey: "job_queued:revoke",
      jobId: selected.id,
      kind: "revoke_approvals",
      payload: {},
    });
    const lease = store.acquireExecutorLease("executor", 2_000, 10_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");

    const controls = store.leaseControlEffects({
      ownerId: "executor",
      generation: lease.generation,
      now: 2_001,
      limit: 8,
      leaseMs: 10_000,
      busyJobIds: [],
    });
    expect(controls.map((effect) => effect.kind).sort()).toEqual(["render_status", "revoke_approvals"]);
    expect(store.leaseNextJobEffect({
      jobId: selected.id,
      ownerId: "executor",
      generation: lease.generation,
      now: 2_002,
      leaseMs: 10_000,
    })).toBeNull();
    expect(store.getEffect(selected.id, "job_queued:spawn")?.status).toBe("pending");
  });

  it("leases one oldest admitted operation and refuses a second tracked operation", () => {
    const { store } = storeFixture();
    const selected = selectAndQueue(store, "job_admitted");
    const admission = admitWithLease(store, selected);

    const claimed = store.leaseNextJobEffect({
      jobId: selected.id,
      ownerId: admission.ownerId,
      generation: admission.generation,
      now: 2_001,
      leaseMs: 10_000,
    });
    expect(claimed).toMatchObject({ jobId: selected.id, status: "leased", attempts: 1 });
    expect(store.leaseNextJobEffect({
      jobId: selected.id,
      ownerId: admission.ownerId,
      generation: admission.generation,
      now: 2_002,
      leaseMs: 10_000,
    })).toBeNull();
  });

  it("leases an exact draining stop but leaves mismatched and unsafe operations pending", () => {
    const { store, db } = storeFixture();
    const selected = selectAndQueue(store, "job_draining");
    const admission = admitWithLease(store, selected);
    const requested = store.applyExecutorJobEvent({
      jobId: selected.id,
      expectedVersion: admission.job.version,
      event: { type: "CANCEL_REQUESTED", activeWorker: worker(selected.id) },
      ownerId: admission.ownerId,
      generation: admission.generation,
      now: 2_001,
    });
    if (!requested) throw new Error("cancellation request was not persisted");
    const cancelled = store.applyExecutorJobEvent({
      jobId: selected.id,
      expectedVersion: requested.version,
      event: { type: "CANCEL_CONFIRMED" },
      ownerId: admission.ownerId,
      generation: admission.generation,
      now: 2_002,
    });
    if (!cancelled) throw new Error("cancellation confirmation was not persisted");
    expect(store.getAdmission(selected.id)?.state).toBe("draining");
    store.upsertWorkerLiveness(worker(selected.id));

    const stop = exactStop(selected.id);
    insertEffect(db, stop);
    insertEffect(db, {
      ...stop,
      idempotencyKey: `${selected.id}:stop-wrong-resource`,
      payload: { ...stop.payload, resourceId: "thr_other" },
    });
    insertEffect(db, {
      idempotencyKey: `${selected.id}:unsafe-deploy`,
      jobId: selected.id,
      kind: "deploy_production",
      payload: {},
    });

    const controls = store.leaseControlEffects({
      ownerId: admission.ownerId,
      generation: admission.generation,
      now: 2_003,
      limit: 8,
      leaseMs: 10_000,
      busyJobIds: [],
    });
    expect(controls.every((effect) => effect.kind === "render_status" || effect.kind === "revoke_approvals")).toBe(true);
    for (const control of controls) {
      expect(store.completeEffect(control.idempotencyKey, admission.ownerId, admission.generation, 2_003)).toBe(true);
    }
    const stopClaim = store.leaseNextJobEffect({
      jobId: selected.id,
      ownerId: admission.ownerId,
      generation: admission.generation,
      now: 2_004,
      leaseMs: 10_000,
    });
    expect(stopClaim).toMatchObject({ idempotencyKey: stop.idempotencyKey });
    expect(store.getEffect(selected.id, `${selected.id}:stop-wrong-resource`)?.status).toBe("pending");
    expect(store.getEffect(selected.id, `${selected.id}:unsafe-deploy`)?.status).toBe("pending");
  });

  it("does not lease released work or transfer a project claim when an effect lease expires", () => {
    const { store, db } = storeFixture();
    const selected = selectAndQueue(store, "job_released");
    const admission = admitWithLease(store, selected, "executor-one", 2_000);
    const effect: JobEffect = {
      idempotencyKey: "job_released:operation",
      jobId: selected.id,
      kind: "spawn_plan",
      payload: {},
    };
    insertEffect(db, effect);
    db.prepare("UPDATE job_admissions SET state = 'released', released_at = ?, release_reason = ? WHERE job_id = ?")
      .run(2_100, "test", selected.id);

    expect(store.leaseNextJobEffect({
      jobId: selected.id,
      ownerId: admission.ownerId,
      generation: admission.generation,
      now: 2_101,
      leaseMs: 10_000,
    })).toBeNull();
    expect(store.leaseControlEffects({
      ownerId: admission.ownerId,
      generation: admission.generation,
      now: 2_102,
      limit: 8,
      leaseMs: 10_000,
      busyJobIds: [],
    })).toEqual([]);
    expect(store.getEffect(selected.id, effect.idempotencyKey)?.status).toBe("pending");
    expect(store.listHeldResourceClaims(selected.id, 10)[0]).toMatchObject({ state: "held" });
  });

  it("renews the exact effect and all adopted claims atomically", () => {
    const { store } = storeFixture();
    const selected = selectAndQueue(store, "job_renew");
    const admission = admitWithLease(store, selected, "executor", 2_000);
    const claim = store.leaseNextJobEffect({
      jobId: selected.id,
      ownerId: admission.ownerId,
      generation: admission.generation,
      now: 2_001,
      leaseMs: 100,
    });
    if (!claim) throw new Error("effect was not leased");

    expect(store.renewJobOperationFences({
      jobId: selected.id,
      effectIdempotencyKey: claim.idempotencyKey,
      ownerId: admission.ownerId,
      generation: admission.generation,
      now: 2_050,
      leaseMs: 10_000,
    })).toBe(true);
    expect(store.getEffect(selected.id, claim.idempotencyKey)).toMatchObject({ leaseExpiresAt: 12_050 });
    expect(store.listHeldResourceClaims(selected.id, 10)[0]).toMatchObject({ leaseExpiresAt: 12_050 });
  });

  it("renews a pre-adoption safe control without renewing held claims", () => {
    const { store } = storeFixture();
    const selected = selectAndQueue(store, "job_control_renew");
    const first = admitWithLease(store, selected, "executor-one", 2_000, 100);
    const successor = store.acquireExecutorLease("executor-two", 2_101, 10_000);
    expect(successor).toEqual({ acquired: true, generation: 2 });
    if (!successor.acquired) throw new Error("successor lease was not acquired");
    const control = store.leaseControlEffects({
      ownerId: "executor-two",
      generation: successor.generation,
      now: 2_102,
      limit: 1,
      leaseMs: 10_000,
      busyJobIds: [],
    })[0];
    if (!control) throw new Error("pre-adoption control was not leased");

    expect(store.renewControlEffectFence({
      jobId: selected.id,
      effectIdempotencyKey: control.idempotencyKey,
      ownerId: "executor-two",
      generation: successor.generation,
      now: 2_150,
      leaseMs: 10_000,
    })).toBe(true);
    expect(store.getEffect(selected.id, control.idempotencyKey)).toMatchObject({
      status: "leased",
      leaseOwner: "executor-two",
      leaseGeneration: successor.generation,
      leaseExpiresAt: 12_150,
    });
    expect(store.listHeldResourceClaims(selected.id, 10)[0]).toMatchObject({
      ownerId: first.ownerId,
      generation: first.generation,
    });
  });

  it("adopts only the same job's held claims for a successor generation", () => {
    const { store } = storeFixture();
    const selected = selectAndQueue(store, "job_adopt");
    const first = admitWithLease(store, selected, "executor-one", 2_000, 100);
    const originalClaim = store.listHeldResourceClaims(selected.id, 10)[0];
    if (!originalClaim) throw new Error("admitted job did not receive a project claim");

    const successor = store.acquireExecutorLease("executor-two", 2_101, 10_000);
    expect(successor).toEqual({ acquired: true, generation: 2 });
    if (!successor.acquired) throw new Error("successor lease was not acquired");

    expect(store.adoptHeldClaims({
      jobId: selected.id,
      ownerId: "executor-two",
      generation: successor.generation,
      now: 2_102,
      leaseMs: 10_000,
    })).toBe(true);
    expect(store.listHeldResourceClaims(selected.id, 10)[0]).toMatchObject({
      claimId: originalClaim.claimId,
      jobId: selected.id,
      resourceKey: originalClaim.resourceKey,
      ownerId: "executor-two",
      generation: successor.generation,
      leaseExpiresAt: 12_102,
    });
    expect(store.adoptHeldClaims({
      jobId: selected.id,
      ownerId: first.ownerId,
      generation: first.generation,
      now: 2_103,
      leaseMs: 10_000,
    })).toBe(false);
  });

  it("adopts every held claim for the job after proving its project claim", () => {
    const { store, db } = storeFixture();
    const selected = selectAndQueue(store, "job_adopt_multiple");
    const first = admitWithLease(store, selected, "executor-one", 2_000, 100);
    const foreign = store.createJob({
      id: "job_adopt_foreign_claim",
      sourceUpdateId: 1_001,
      requestText: "foreign claim",
      now: 1_001,
    });
    const insertClaim = (input: {
      jobId: string;
      resourceKey: string;
      resourceKind: "repository_merge" | "production_target";
      state: "held" | "released";
      ownerId: string;
      generation: number;
      leaseExpiresAt: number;
    }): void => {
      db.prepare(
        `INSERT INTO job_resource_claims (
           job_id, resource_key, resource_kind, state, owner_id, generation,
           lease_expires_at, acquired_at, renewed_at, released_at, release_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 2000, 2000, ?, ?)`,
      ).run(
        input.jobId,
        input.resourceKey,
        input.resourceKind,
        input.state,
        input.ownerId,
        input.generation,
        input.leaseExpiresAt,
        input.state === "released" ? 2_050 : null,
        input.state === "released" ? "test-release" : null,
      );
    };
    insertClaim({
      jobId: selected.id,
      resourceKey: "repository:acme/test:merge",
      resourceKind: "repository_merge",
      state: "held",
      ownerId: first.ownerId,
      generation: first.generation,
      leaseExpiresAt: 2_100,
    });
    insertClaim({
      jobId: selected.id,
      resourceKey: "production:proj_1",
      resourceKind: "production_target",
      state: "held",
      ownerId: first.ownerId,
      generation: first.generation,
      leaseExpiresAt: 2_100,
    });
    insertClaim({
      jobId: selected.id,
      resourceKey: "repository:released:merge",
      resourceKind: "repository_merge",
      state: "released",
      ownerId: first.ownerId,
      generation: first.generation,
      leaseExpiresAt: 0,
    });
    insertClaim({
      jobId: foreign.id,
      resourceKey: "repository:foreign:merge",
      resourceKind: "repository_merge",
      state: "held",
      ownerId: "foreign-owner",
      generation: 7,
      leaseExpiresAt: 50_000,
    });

    const successor = store.acquireExecutorLease("executor-two", 2_101, 10_000);
    expect(successor).toEqual({ acquired: true, generation: 2 });
    if (!successor.acquired) throw new Error("successor lease was not acquired");

    expect(store.adoptHeldClaims({
      jobId: selected.id,
      ownerId: "executor-two",
      generation: successor.generation,
      now: 2_102,
      leaseMs: 10_000,
    })).toBe(true);
    expect(db.prepare(
      `SELECT resource_kind, state, owner_id, generation, lease_expires_at
         FROM job_resource_claims WHERE job_id = ? ORDER BY claim_id`,
    ).all(selected.id)).toEqual([
      { resource_kind: "project", state: "held", owner_id: "executor-two", generation: 2, lease_expires_at: 12_102 },
      { resource_kind: "repository_merge", state: "held", owner_id: "executor-two", generation: 2, lease_expires_at: 12_102 },
      { resource_kind: "production_target", state: "held", owner_id: "executor-two", generation: 2, lease_expires_at: 12_102 },
      { resource_kind: "repository_merge", state: "released", owner_id: "executor-one", generation: 1, lease_expires_at: 0 },
    ]);
    expect(db.prepare(
      `SELECT resource_kind, state, owner_id, generation, lease_expires_at
         FROM job_resource_claims WHERE job_id = ?`,
    ).get(foreign.id)).toEqual({
      resource_kind: "repository_merge",
      state: "held",
      owner_id: "foreign-owner",
      generation: 7,
      lease_expires_at: 50_000,
    });
  });

  it("rejects adoption when the required project claim is missing", () => {
    const { store, db } = storeFixture();
    const selected = selectAndQueue(store, "job_adopt_missing");
    const first = admitWithLease(store, selected, "executor-one", 2_000, 100);
    db.prepare("DELETE FROM job_resource_claims WHERE job_id = ?").run(selected.id);
    const successor = store.acquireExecutorLease("executor-two", 2_101, 10_000);
    expect(successor).toEqual({ acquired: true, generation: 2 });
    if (!successor.acquired) throw new Error("successor lease was not acquired");

    expect(store.adoptHeldClaims({
      jobId: selected.id,
      ownerId: "executor-two",
      generation: successor.generation,
      now: 2_102,
      leaseMs: 10_000,
    })).toBe(false);
    expect(store.listHeldResourceClaims(selected.id, 10)).toEqual([]);
    expect(first.generation).toBe(1);
  });

  it("rejects adoption when the required project claim is released", () => {
    const { store, db } = storeFixture();
    const selected = selectAndQueue(store, "job_adopt_released");
    const first = admitWithLease(store, selected, "executor-one", 2_000, 100);
    db.prepare(
      "UPDATE job_resource_claims SET state = 'released', lease_expires_at = 0, released_at = ?, release_reason = ? WHERE job_id = ?",
    ).run(2_050, "test", selected.id);
    const successor = store.acquireExecutorLease("executor-two", 2_101, 10_000);
    expect(successor).toEqual({ acquired: true, generation: 2 });
    if (!successor.acquired) throw new Error("successor lease was not acquired");

    expect(store.adoptHeldClaims({
      jobId: selected.id,
      ownerId: "executor-two",
      generation: successor.generation,
      now: 2_102,
      leaseMs: 10_000,
    })).toBe(false);
    expect(store.listHeldResourceClaims(selected.id, 10)[0]).toMatchObject({
      state: "released",
      ownerId: first.ownerId,
      generation: first.generation,
    });
    expect(first.generation).toBe(1);
  });

  it("rejects adoption when the project claim belongs to another job", () => {
    const { store, db } = storeFixture();
    const selected = selectAndQueue(store, "job_adopt_foreign");
    const foreign = selectAndQueue(store, "job_adopt_foreign_owner", 1_001);
    const first = admitWithLease(store, selected, "executor-one", 2_000, 100);
    db.prepare("UPDATE job_resource_claims SET job_id = ? WHERE job_id = ?").run(foreign.id, selected.id);
    const successor = store.acquireExecutorLease("executor-two", 2_101, 10_000);
    expect(successor).toEqual({ acquired: true, generation: 2 });
    if (!successor.acquired) throw new Error("successor lease was not acquired");

    expect(store.adoptHeldClaims({
      jobId: selected.id,
      ownerId: "executor-two",
      generation: successor.generation,
      now: 2_102,
      leaseMs: 10_000,
    })).toBe(false);
    expect(store.listHeldResourceClaims(foreign.id, 10)[0]).toMatchObject({
      ownerId: first.ownerId,
      generation: first.generation,
    });
  });
});
