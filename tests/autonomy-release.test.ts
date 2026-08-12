import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { JobEffect } from "../src/domain/models";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { admitConfirmedJob, policyFixture } from "./helpers";

let fixtureNumber = 0;

function storeFixture(): { store: TelegramAgentStore; db: Database.Database } {
  const { bb } = createFakePluginHost({ pluginId: `telegram-agent-task5-release-${fixtureNumber++}` });
  return { store: openStore(bb.storage), db: bb.storage.database() };
}

function selectedJob(store: TelegramAgentStore, jobId: string, now = 1_000) {
  const draft = store.createJob({ id: jobId, sourceUpdateId: now, requestText: "release this work", now });
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

function admittedJob(store: TelegramAgentStore, jobId: string, now = 2_000) {
  const selected = selectedJob(store, jobId, now - 1_000);
  const lease = store.acquireExecutorLease("release-executor", now, 30_000);
  if (!lease.acquired) throw new Error("executor lease was not acquired");
  const admission = store.tryAdmit({
    jobId,
    maxConcurrentJobs: 8,
    ownerId: "release-executor",
    generation: lease.generation,
    now,
    leaseMs: 30_000,
  });
  if (admission.outcome !== "admitted") throw new Error(`job was not admitted: ${admission.reason}`);
  return { job: admission.job, ownerId: "release-executor", generation: lease.generation };
}

function settleSafeControls(store: TelegramAgentStore, ownerId: string, generation: number, now: number): void {
  const controls = store.leaseControlEffects({
    ownerId,
    generation,
    now,
    limit: 8,
    leaseMs: 10_000,
    busyJobIds: [],
  });
  for (const effect of controls) {
    if (!store.completeEffect(effect.idempotencyKey, ownerId, generation, now + 1)) {
      throw new Error(`safe control did not complete: ${effect.idempotencyKey}`);
    }
  }
}

function insertEffect(db: Database.Database, effect: JobEffect, now = 2_000): void {
  db.prepare(
    `INSERT INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
  ).run(effect.idempotencyKey, effect.jobId, effect.kind, JSON.stringify(effect.payload), now, now, now);
}

describe("autonomy draining and release", () => {
  it.each(["merged", "cancelled", "blocked", "complete", "production_failed"] as const)(
    "marks an admitted %s job draining without releasing its claim",
    (state) => {
      const { store, db } = storeFixture();
      const admission = admittedJob(store, `job_${state}`);
      db.prepare("UPDATE jobs SET state = ? WHERE id = ?").run(state, admission.job.id);

      expect(store.beginDraining({
        jobId: admission.job.id,
        ownerId: admission.ownerId,
        generation: admission.generation,
        now: 2_100,
      })).toMatchObject({ id: admission.job.id, state });
      expect(store.getAdmission(admission.job.id)?.state).toBe("draining");
      expect(store.listHeldResourceClaims(admission.job.id, 10)).toHaveLength(1);
    },
  );

  it("keeps failed admitted work admitted", () => {
    const { store } = storeFixture();
    const admission = admittedJob(store, "job_failed");
    const failed = store.applyExecutorJobEvent({
      jobId: admission.job.id,
      expectedVersion: admission.job.version,
      event: { type: "FAILED", error: "temporary worker failure" },
      ownerId: admission.ownerId,
      generation: admission.generation,
      now: 2_100,
    });
    expect(failed?.state).toBe("failed");
    expect(store.getAdmission(admission.job.id)?.state).toBe("admitted");
  });

  it("waits for active or unknown liveness, then releases only after safe cleanup settles", () => {
    const { store, db } = storeFixture();
    const admission = admittedJob(store, "job_release");
    db.prepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(admission.job.id);
    expect(store.beginDraining({
      jobId: admission.job.id,
      ownerId: admission.ownerId,
      generation: admission.generation,
      now: 2_100,
    })).toMatchObject({ id: admission.job.id, state: "cancelled" });
    insertEffect(db, {
      idempotencyKey: "job_release:incompatible",
      jobId: admission.job.id,
      kind: "spawn_implementation",
      payload: {},
    });
    store.enqueueOutbox({
      logicalKey: "status:job_release:draining",
      chatId: "70",
      payload: { jobId: admission.job.id, state: "cancelled" },
    }, 2_101);
    settleSafeControls(store, admission.ownerId, admission.generation, 2_102);

    store.upsertWorkerLiveness({
      jobId: admission.job.id,
      workerKind: "implementation",
      resourceKind: "bb_thread",
      resourceId: "thr_live",
      generation: 1,
      state: "active",
      sourceUpdatedAt: 2_100,
      observedAt: 2_103,
      staleNotifiedAt: null,
    });
    expect(store.finalizeRelease({
      jobId: admission.job.id,
      ownerId: admission.ownerId,
      generation: admission.generation,
      now: 2_104,
    })).toMatchObject({ outcome: "waiting" });
    expect(store.getAdmission(admission.job.id)?.state).toBe("draining");
    expect(store.listHeldResourceClaims(admission.job.id, 10)).toHaveLength(1);

    store.upsertWorkerLiveness({
      jobId: admission.job.id,
      workerKind: "implementation",
      resourceKind: "bb_thread",
      resourceId: "thr_live",
      generation: 1,
      state: "idle",
      sourceUpdatedAt: 2_105,
      observedAt: 2_105,
      staleNotifiedAt: null,
    });
    expect(store.finalizeRelease({
      jobId: admission.job.id,
      ownerId: admission.ownerId,
      generation: admission.generation,
      now: 2_106,
    })).toMatchObject({ outcome: "released" });
    expect(store.getAdmission(admission.job.id)?.state).toBe("released");
    expect(store.listHeldResourceClaims(admission.job.id, 10).filter((claim) => claim.state === "held")).toHaveLength(0);
    expect(store.getEffect(admission.job.id, "job_release:incompatible")).toMatchObject({
      status: "done",
      lastError: "superseded:job_released",
    });
    expect(store.getOutbox("status:job_release:draining")?.status).toBe("pending");
    expect(store.leaseControlEffects({
      ownerId: admission.ownerId,
      generation: admission.generation,
      now: 2_107,
      limit: 8,
      leaseMs: 10_000,
      busyJobIds: [],
    })).toEqual([]);
  });

  it("cancels queued work without acquiring a project claim or consuming capacity", () => {
    const { store } = storeFixture();
    const selected = selectedJob(store, "job_queued_cancel");
    const lease = store.acquireExecutorLease("queued-cancel", 2_000, 30_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const requested = store.applyExecutorJobEvent({
      jobId: selected.id,
      expectedVersion: selected.version,
      event: { type: "CANCEL_REQUESTED" },
      ownerId: "queued-cancel",
      generation: lease.generation,
      now: 2_001,
    });
    if (!requested) throw new Error("queued cancellation request was not persisted");
    const confirmed = store.applyExecutorJobEvent({
      jobId: selected.id,
      expectedVersion: requested.version,
      event: { type: "CANCEL_CONFIRMED" },
      ownerId: "queued-cancel",
      generation: lease.generation,
      now: 2_002,
    });
    expect(confirmed?.state).toBe("cancelled");
    expect(store.listHeldResourceClaims(selected.id, 10)).toHaveLength(0);
    settleSafeControls(store, "queued-cancel", lease.generation, 2_003);
    expect(store.finalizeRelease({
      jobId: selected.id,
      ownerId: "queued-cancel",
      generation: lease.generation,
      now: 2_004,
    })).toMatchObject({ outcome: "released" });
    expect(store.getAdmission(selected.id)?.state).toBe("released");
    expect(store.listHeldResourceClaims(selected.id, 10)).toHaveLength(0);
  });

  it("recovers a terminal status control stranded after admission release", () => {
    const { store, db } = storeFixture();
    const selected = selectedJob(store, "job_released_status");
    const lease = store.acquireExecutorLease("released-status", 2_000, 30_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const requested = store.applyExecutorJobEvent({
      jobId: selected.id,
      expectedVersion: selected.version,
      event: { type: "CANCEL_REQUESTED" },
      ownerId: "released-status",
      generation: lease.generation,
      now: 2_001,
    });
    if (!requested) throw new Error("queued cancellation request was not persisted");
    const cancelled = store.applyExecutorJobEvent({
      jobId: selected.id,
      expectedVersion: requested.version,
      event: { type: "CANCEL_CONFIRMED" },
      ownerId: "released-status",
      generation: lease.generation,
      now: 2_002,
    });
    if (!cancelled) throw new Error("queued cancellation was not confirmed");
    settleSafeControls(store, "released-status", lease.generation, 2_003);
    expect(store.finalizeRelease({
      jobId: selected.id,
      ownerId: "released-status",
      generation: lease.generation,
      now: 2_005,
    })).toMatchObject({ outcome: "released" });

    const terminalStatusKey = `${selected.id}:${cancelled.version}:render_status`;
    db.prepare(
      "UPDATE effects SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE idempotency_key = ?",
    ).run(2_006, 2_006, terminalStatusKey);
    expect(store.leaseControlEffects({
      ownerId: "released-status",
      generation: lease.generation,
      now: 2_007,
      limit: 1,
      leaseMs: 10_000,
      busyJobIds: [],
    }).map((effect) => effect.idempotencyKey)).toEqual([terminalStatusKey]);
  });
});

it("frees a project locked by a failed job once that job is cancelled", () => {
  {
    const { store, db: harnessDb } = storeFixture();
    store.upsertProjectPolicy(policyFixture({ projectId: "proj_locked", alias: "locked" }), 1_000);

    // A job fails and keeps its project claim so a retry could resume in place.
    const first = store.createJob({ id: "job_dead", sourceUpdateId: 8_101, requestText: "first", now: 1_001 });
    const selected = store.applyJobEvent(first.id, first.version, {
      type: "PROJECT_SELECTED",
      projectId: "proj_locked",
      policyVersion: 1,
      policy: policyFixture({ projectId: "proj_locked", alias: "locked" }),
    }, 1_002);
    const admitted = admitConfirmedJob(store, selected, 1_003);
    const failed = store.applyJobEvent(admitted.id, admitted.version, {
      type: "FAILED",
      error: "npm run check exited 1",
    }, 1_004);
    // Held, deliberately: a failed job keeps its project so a retry can resume.
    expect(store.listHeldResourceClaims(failed.id, 10).filter((c) => c.state === "held")).toHaveLength(1);

    // Nothing expires that claim, so a second job on the same project is stuck.
    const second = store.createJob({ id: "job_next", sourceUpdateId: 8_102, requestText: "second", now: 1_005 });
    const secondSelected = store.applyJobEvent(second.id, second.version, {
      type: "PROJECT_SELECTED",
      projectId: "proj_locked",
      policyVersion: 1,
      policy: policyFixture({ projectId: "proj_locked", alias: "locked" }),
    }, 1_006);
    const lease = store.acquireExecutorLease("releaser", 1_007, 30_000);
    if (!lease.acquired) throw new Error("missing lease");
    store.queueAdmission({
      jobId: secondSelected.id,
      expectedVersion: secondSelected.version,
      projectId: "proj_locked",
      resumeEvent: "CONFIRMED",
      now: 1_007,
    });
    expect(store.tryAdmit({
      jobId: secondSelected.id, maxConcurrentJobs: 8, ownerId: "releaser",
      generation: lease.generation, now: 1_008, leaseMs: 30_000,
    })).toMatchObject({ outcome: "not_admitted", reason: "project_busy" });

    // Cancelling the dead job is the recovery path the owner actually has.
    const cancelling = store.applyJobEvent(failed.id, failed.version, {
      type: "CANCEL_REQUESTED", activeWorker: null,
    }, 1_009);
    store.applyExecutorJobEvent({
      jobId: cancelling.id, expectedVersion: cancelling.version,
      event: { type: "CANCEL_CONFIRMED" }, ownerId: "releaser",
      generation: lease.generation, now: 1_010,
    });
    // Cancelling emits render_status and revoke_approvals; release waits for
    // those to settle, exactly as the executor drives them in production.
    harnessDb.prepare(
      "UPDATE effects SET status = 'done' WHERE job_id = ? AND kind IN ('render_status','revoke_approvals')",
    ).run(failed.id);
    for (const candidate of store.listReleaseCandidates(10)) {
      store.finalizeRelease({
        jobId: candidate.jobId, ownerId: "releaser", generation: lease.generation, now: 1_011,
      });
    }

    expect(store.listHeldResourceClaims(failed.id, 10).filter((c) => c.state === "held")).toHaveLength(0);
    expect(store.tryAdmit({
      jobId: secondSelected.id, maxConcurrentJobs: 8, ownerId: "releaser",
      generation: lease.generation, now: 1_012, leaseMs: 30_000,
    })).toMatchObject({ outcome: "admitted" });
  }
});
