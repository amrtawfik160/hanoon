import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { CONTROLLER_PHASE_TEXT } from "../src/controller/models";
import type { JobEffect, StoredEffect } from "../src/domain/models";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { EffectRunner } from "../src/services/effect-runner";
import {
  runJobExecutorService,
  WORKER_RECONCILE_INTERVAL_MS,
  type JobExecutorDependencies,
} from "../src/services/job-executor-service";
import { TelegramRequestError } from "../src/telegram/client";
import { TelegramApiError } from "../src/telegram/errors";
import { TelegramPresenceCoordinator } from "../src/services/telegram-presence";
import { JobLaneSnapshotProvider } from "../src/services/job-lane-runner";
import type { WorkerLiveness } from "../src/domain/models";
import { AutonomyRepository } from "../src/storage/autonomy-repository";
import { AutonomyScheduler } from "../src/autonomy/scheduler";
import { policyFixture } from "./helpers";
import { completeTurnThroughFinalization } from "./support/controller-trust-fixtures";

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

async function runOutboxPass(
  store: TelegramAgentStore,
  now: number,
  telegram: NonNullable<JobExecutorDependencies["telegram"]>,
): Promise<void> {
  const abort = new AbortController();
  await runJobExecutorService({
    store,
    clock: { now: () => now },
    sleep: vi.fn(async () => abort.abort()),
    effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => now }),
    telegram,
    jitter: () => 0,
    releaseOnShutdown: true,
  }, abort.signal);
}

function insertJobAndOutbox(store: TelegramAgentStore, db: Database.Database): void {
  const job = store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "work", now: 1_000 });
  store.enqueueOutbox({ logicalKey: `job:${job.id}:status`, chatId: "70", payload: { text: "initial" } }, 1_000);
  db.prepare("UPDATE jobs SET status_message_id = NULL WHERE id = ?").run(job.id);
}

function prepareExecutorTestJob(
  store: TelegramAgentStore,
): NonNullable<JobExecutorDependencies["controller"]> {
  const draft = store.getJob("job_1") ?? store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "work", now: 1_000 });
  const selected = draft.state === "awaiting_confirmation"
    ? draft
    : store.applyJobEvent(draft.id, draft.version, {
      type: "PROJECT_SELECTED",
      projectId: "proj_1",
      policyVersion: 1,
      policy: {
        projectId: "proj_1",
        alias: "test-project",
        enabled: true,
        githubRepository: "acme/test",
        baseBranch: "main",
        implementation: { model: "implementation" },
        review: { model: "review" },
        validationCommands: [],
        production: {
          deployCommands: [{ name: "deploy", command: "./deploy", timeoutMs: 1_000 }],
          canaryCommands: [{ name: "canary", command: "./canary", timeoutMs: 1_000 }],
          convexDeployRequired: false,
        },
        requiredChecks: [],
        outputRedactionPatterns: [],
        workerStartGraceMs: 120_000,
        workerLivenessWatchdogMs: 60_000,
        workerRecoveryLimit: 2,
        maxReviewCycles: 3,
        mergeMethod: "squash",
      },
    }, 1_001);
  if (selected.state !== "awaiting_confirmation" || !selected.projectId) throw new Error("executor fixture was not selected");
  store.queueAdmission({
    jobId: selected.id,
    expectedVersion: selected.version,
    projectId: selected.projectId,
    resumeEvent: "CONFIRMED",
    now: 1_001,
  });
  let admitted = false;
  return {
    reconcile: vi.fn(async () => false),
    processOne: vi.fn(async (fence) => {
      if (admitted) return false;
      const admission = store.tryAdmit({
        jobId: selected.id,
        maxConcurrentJobs: 8,
        ownerId: fence.ownerId,
        generation: fence.generation,
        now: 1_002,
        leaseMs: 30_000,
      });
      if (admission.outcome !== "admitted") throw new Error(`executor fixture was not admitted: ${admission.reason}`);
      admitted = true;
      return true;
    }),
  };
}

function queueExecutorBoundaryJob(store: TelegramAgentStore, jobId: string, now = 1_000) {
  const draft = store.createJob({ id: jobId, sourceUpdateId: now, requestText: "executor boundary", now });
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

function queueOrdinaryAdmissions(
  store: TelegramAgentStore,
  count: number,
  prefix: string,
  now: number,
): void {
  for (let index = 0; index < count; index += 1) {
    queueExecutorBoundaryJob(store, `${prefix}_${index}`, now + index);
  }
}

function queueCancelledAdmissions(
  store: TelegramAgentStore,
  count: number,
  prefix: string,
  now: number,
): void {
  for (let index = 0; index < count; index += 1) {
    const selected = queueExecutorBoundaryJob(store, `${prefix}_${index}`, now + index);
    const requested = store.applyJobEvent(
      selected.id,
      selected.version,
      { type: "CANCEL_REQUESTED" },
      now + index + 1,
    );
    const cancelled = store.applyJobEvent(
      selected.id,
      requested.version,
      { type: "CANCEL_CONFIRMED" },
      now + index + 2,
    );
    if (cancelled.state !== "cancelled") throw new Error(`queued cancellation did not settle: ${selected.id}`);
  }
}

function settleAllSafeControls(store: TelegramAgentStore, now: number): void {
  const ownerId = "release-fixture";
  const lease = store.acquireExecutorLease(ownerId, now, 30_000);
  if (!lease.acquired) throw new Error("release fixture executor lease was not acquired");
  for (let pass = 0; pass < 50; pass += 1) {
    const controls = store.leaseControlEffects({
      ownerId,
      generation: lease.generation,
      now,
      limit: 8,
      leaseMs: 30_000,
      busyJobIds: [],
    });
    if (controls.length === 0) {
      if (!store.releaseExecutorLease(ownerId, lease.generation, now)) throw new Error("release fixture lease was not released");
      return;
    }
    for (const control of controls) {
      if (!store.completeEffect(control.idempotencyKey, ownerId, lease.generation, now)) {
        throw new Error(`release fixture control did not settle: ${control.idempotencyKey}`);
      }
    }
  }
  throw new Error("release fixture safe controls exceeded its bounded pass count");
}

function boundaryWorker(jobId: string, state: WorkerLiveness["state"], now: number): WorkerLiveness {
  return {
    jobId,
    workerKind: "implementation",
    resourceKind: "bb_thread",
    resourceId: `thread-${jobId}`,
    generation: 1,
    state,
    sourceUpdatedAt: now,
    observedAt: now,
    staleNotifiedAt: null,
  };
}

function terminalBoundaryController(
  store: TelegramAgentStore,
  jobId: string,
  now: number,
  liveness?: WorkerLiveness,
  settleControls = false,
): NonNullable<JobExecutorDependencies["controller"]> {
  let prepared = false;
  return {
    reconcile: vi.fn(async () => false),
    processOne: vi.fn(async (fence) => {
      if (prepared) return false;
      const queued = store.getJob(jobId);
      if (!queued) throw new Error("boundary job was not created");
      const admission = store.tryAdmit({
        jobId,
        maxConcurrentJobs: 8,
        ownerId: fence.ownerId,
        generation: fence.generation,
        now,
        leaseMs: 30_000,
      });
      if (admission.outcome !== "admitted") throw new Error(`boundary job was not admitted: ${admission.reason}`);
      const requested = store.applyExecutorJobEvent({
        jobId,
        expectedVersion: admission.job.version,
        event: { type: "CANCEL_REQUESTED", activeWorker: liveness ?? null },
        ownerId: fence.ownerId,
        generation: fence.generation,
        now,
      });
      if (!requested) throw new Error("boundary cancellation request was not persisted");
      // With no live worker to stop there is nothing to confirm: the request
      // already completed, and a second confirmation would be illegal.
      if (requested.state !== "cancelled" && !store.applyExecutorJobEvent({
        jobId,
        expectedVersion: requested.version,
        event: { type: "CANCEL_CONFIRMED" },
        ownerId: fence.ownerId,
        generation: fence.generation,
        now,
      })) throw new Error("boundary cancellation confirmation was not persisted");
      if (liveness) store.upsertWorkerLiveness(liveness);
      if (liveness?.state === "active") {
        expect(store.listEffectsForJob(jobId).some((effect) => effect.kind === "stop_thread")).toBe(true);
      }
      if (settleControls) {
        const controls = store.leaseControlEffects({
          ownerId: fence.ownerId,
          generation: fence.generation,
          now,
          limit: 8,
          leaseMs: 30_000,
          busyJobIds: [],
        });
        for (const control of controls) {
          if (!store.completeEffect(control.idempotencyKey, fence.ownerId, fence.generation, now)) {
            throw new Error(`boundary control did not settle: ${control.idempotencyKey}`);
          }
        }
      }
      prepared = true;
      return true;
    }),
  };
}

function queuedCancellationController(
  store: TelegramAgentStore,
  jobId: string,
  now: number,
): NonNullable<JobExecutorDependencies["controller"]> {
  let cancelled = false;
  return {
    reconcile: vi.fn(async () => false),
    processOne: vi.fn(async (fence) => {
      if (cancelled) return false;
      const job = store.getJob(jobId);
      if (!job) throw new Error("queued cancellation job was not created");
      const requested = store.applyExecutorJobEvent({
        jobId,
        expectedVersion: job.version,
        event: { type: "CANCEL_REQUESTED" },
        ownerId: fence.ownerId,
        generation: fence.generation,
        now,
      });
      if (!requested || !store.applyExecutorJobEvent({
        jobId,
        expectedVersion: requested.version,
        event: { type: "CANCEL_CONFIRMED" },
        ownerId: fence.ownerId,
        generation: fence.generation,
        now,
      })) throw new Error("queued cancellation was not persisted");
      cancelled = true;
      return true;
    }),
  };
}

type ExecutorDeferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function executorDeferred(): ExecutorDeferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function executorMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function queueProjectJob(
  store: TelegramAgentStore,
  jobId: string,
  projectId: string,
  now: number,
): NonNullable<ReturnType<TelegramAgentStore["getJob"]>> {
  const draft = store.createJob({ id: jobId, sourceUpdateId: now, requestText: "concurrent work", now });
  const selected = store.applyJobEvent(draft.id, draft.version, {
    type: "PROJECT_SELECTED",
    projectId,
    policyVersion: 1,
    policy: policyFixture({ projectId, alias: `alias-${projectId.slice(5).replaceAll("_", "-")}` }),
  }, now + 1);
  store.queueAdmission({
    jobId,
    expectedVersion: selected.version,
    projectId,
    resumeEvent: "CONFIRMED",
    now: now + 1,
  });
  return selected;
}

function settleSafeControlEffects(db: Database.Database, jobId: string): void {
  db.prepare(
    `UPDATE effects
        SET status = 'done', lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL
      WHERE job_id = ? AND kind IN ('render_status', 'revoke_approvals')`,
  ).run(jobId);
}

function admitPreparedJobs(
  store: TelegramAgentStore,
  selectedJobs: readonly NonNullable<ReturnType<TelegramAgentStore["getJob"]>>[],
  now: number,
): void {
  const ownerId = "lane-fixture-admitter";
  const lease = store.acquireExecutorLease(ownerId, now, 30_000);
  if (!lease.acquired) throw new Error("lane fixture executor lease was not acquired");
  for (const [index, selected] of selectedJobs.entries()) {
    const admission = store.tryAdmit({
      jobId: selected.id,
      maxConcurrentJobs: 8,
      ownerId,
      generation: lease.generation,
      now: now + selectedJobs.length - index,
      leaseMs: 30_000,
    });
    if (admission.outcome !== "admitted") throw new Error(`lane fixture admission failed: ${admission.reason}`);
  }
  if (!store.releaseExecutorLease(ownerId, lease.generation, now)) {
    throw new Error("lane fixture executor lease was not released");
  }
}

function addSubmittedControllerTurn(store: TelegramAgentStore): string {
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
  return turn.id;
}

function submitAnotherControllerTurn(
  store: TelegramAgentStore,
  fence: { ownerId: string; generation: number },
  updateId: number,
  now: number,
): string {
  const turn = store.enqueueControllerTurn({
    controllerKey: "executor-presence-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId,
    inputText: "next question",
    now,
  });
  const claim = { ownerId: fence.ownerId, generation: fence.generation, now };
  expect(store.claimNextControllerTurn(claim)?.id).toBe(turn.id);
  expect(store.markControllerTurnSubmitted({ ...claim, turnId: turn.id })).toBe(true);
  return turn.id;
}

describe("singleton job executor", () => {
  it("reconciles an otherwise silent admitted worker on a bounded interval", async () => {
    const { store, db } = fixture();
    const selected = queueProjectJob(store, "job_silent_sweep", "proj_silent_sweep", 1_000);
    admitPreparedJobs(store, [selected], 2_000);
    db.prepare(
      `UPDATE jobs SET state = 'implementing', implementation_thread_id = 'thr_silent',
         environment_id = 'env_silent' WHERE id = ?`,
    ).run(selected.id);
    db.prepare("UPDATE effects SET status = 'done' WHERE job_id = ?").run(selected.id);
    let now = 2_100;
    const waits: number[] = [];
    let reconciliations = 0;
    const abort = new AbortController();

    await runJobExecutorService({
      store,
      clock: { now: () => now },
      maxConcurrentJobs: () => 1,
      reconcileJob: async (job) => {
        if (job.id !== selected.id) return;
        reconciliations += 1;
        if (reconciliations === 2) abort.abort();
      },
      effectRunnerFactory: () => ({ run: vi.fn(async () => undefined) }),
      waitForWork: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
      releaseOnShutdown: true,
    }, abort.signal);

    expect(reconciliations).toBe(2);
    expect(waits.reduce((total, wait) => total + wait, 0)).toBe(WORKER_RECONCILE_INTERVAL_MS);
  });

  it.each([1, 2])("admits only the validated cap %s and starts that many pipeline lanes", async (cap) => {
    const { store, db } = fixture();
    const selectedJobs = [
      queueProjectJob(store, "job_cap_a", "proj_cap_a", 1_000),
      queueProjectJob(store, "job_cap_b", "proj_cap_b", 900),
      queueProjectJob(store, "job_cap_c", "proj_cap_c", 800),
    ];
    for (const job of selectedJobs) settleSafeControlEffects(db, job.id);
    const scheduler = new AutonomyScheduler(new AutonomyRepository(db));
    const holds = new Map(selectedJobs.map((job) => [job.id, executorDeferred()]));
    const started: string[] = [];
    const passGate = executorDeferred();
    const abort = new AbortController();
    const execution = runJobExecutorService({
      store,
      clock: { now: () => 2_000 },
      maxConcurrentJobs: () => cap,
      scheduler,
      reconcileJob: async (job) => {
        if (store.getAdmission(job.id)?.state !== "admitted") return;
        started.push(job.id);
        await holds.get(job.id)?.promise;
      },
      effectRunnerFactory: () => ({ run: vi.fn(async () => undefined) }),
      waitForWork: async () => passGate.promise,
    } as JobExecutorDependencies, abort.signal);

    try {
      await executorMicrotasks();
      expect(store.listAdmissions(["admitted", "draining"], 10)).toHaveLength(cap);
      expect(started).toHaveLength(cap);
    } finally {
      abort.abort();
      passGate.resolve();
      for (const hold of holds.values()) hold.resolve();
      await execution;
    }
  });

  it("lets existing occupied jobs continue after lowering the cap without admitting a queued job", async () => {
    const { store, db } = fixture();
    const selectedJobs = [
      queueProjectJob(store, "job_lower_a", "proj_lower_a", 1_000),
      queueProjectJob(store, "job_lower_b", "proj_lower_b", 900),
      queueProjectJob(store, "job_lower_c", "proj_lower_c", 800),
    ];
    for (const job of selectedJobs) settleSafeControlEffects(db, job.id);
    const scheduler = new AutonomyScheduler(new AutonomyRepository(db));
    const holds = new Map(selectedJobs.map((job) => [job.id, executorDeferred()]));
    const started: string[] = [];
    const firstPass = executorDeferred();
    const abort = new AbortController();
    let cap = 2;
    let waitCount = 0;
    const execution = runJobExecutorService({
      store,
      clock: { now: () => 2_000 },
      maxConcurrentJobs: () => cap,
      scheduler,
      reconcileJob: async (job) => {
        if (store.getAdmission(job.id)?.state !== "admitted") return;
        started.push(job.id);
        await holds.get(job.id)?.promise;
      },
      effectRunnerFactory: () => ({ run: vi.fn(async () => undefined) }),
      waitForWork: async (_milliseconds, signal) => {
        waitCount += 1;
        if (waitCount === 1) {
          await firstPass.promise;
          return;
        }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    } as JobExecutorDependencies, abort.signal);

    try {
      await executorMicrotasks();
      expect(store.listAdmissions(["admitted", "draining"], 10)).toHaveLength(2);
      cap = 1;
      firstPass.resolve();
      await executorMicrotasks();
      expect(store.listAdmissions(["admitted", "draining"], 10)).toHaveLength(2);
      expect(store.getAdmission(selectedJobs[2]!.id)?.state).toBe("queued");
      expect(started).toHaveLength(2);
    } finally {
      abort.abort();
      firstPass.resolve();
      for (const hold of holds.values()) hold.resolve();
      await execution;
    }
  });

  it("does not adopt a held claim while exact reconciliation is pending", async () => {
    vi.useFakeTimers();
    const { store, db } = fixture();
    const selected = queueProjectJob(store, "job_adoption_pending", "proj_adoption_pending", 1_000);
    admitPreparedJobs(store, [selected], 2_000);
    db.prepare("UPDATE effects SET status = 'done' WHERE job_id = ? AND kind IN ('render_status', 'revoke_approvals')")
      .run(selected.id);
    const originalClaim = store.listHeldResourceClaims(selected.id, 10)[0];
    if (!originalClaim) throw new Error("adoption fixture did not receive a held claim");
    const reconciliation = executorDeferred();
    const firstWait = executorDeferred();
    let waitCount = 0;
    let reconciliationStarted = false;
    const abort = new AbortController();
    const execution = runJobExecutorService({
      store,
      clock: { now: () => 2_000 },
      leaseMs: 30_000,
      maxConcurrentJobs: () => 1,
      reconcileJob: async () => {
        reconciliationStarted = true;
        await reconciliation.promise;
      },
      effectRunnerFactory: () => ({ run: async () => undefined }),
      waitForWork: async (_milliseconds, signal) => {
        waitCount += 1;
        if (waitCount === 1) {
          await firstWait.promise;
          return;
        }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    } as JobExecutorDependencies, abort.signal);

    try {
      for (let microtask = 0; microtask < 20; microtask += 1) await Promise.resolve();
      expect(reconciliationStarted).toBe(true);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(store.listHeldResourceClaims(selected.id, 10)[0]).toMatchObject({
        ownerId: originalClaim.ownerId,
        generation: originalClaim.generation,
      });

      reconciliation.resolve();
      firstWait.resolve();
      await executorMicrotasks();
      await executorMicrotasks();
      const adoptedClaim = store.listHeldResourceClaims(selected.id, 10)[0];
      expect(adoptedClaim?.ownerId).not.toBe(originalClaim.ownerId);
      expect(adoptedClaim?.generation).not.toBe(originalClaim.generation);
    } finally {
      abort.abort();
      reconciliation.resolve();
      firstWait.resolve();
      await execution;
      vi.useRealTimers();
    }
  });

  it("re-adopts an expired claim before dispatching a retried job effect", async () => {
    const { store, db } = fixture();
    const selected = queueProjectJob(store, "job_retry_after_claim_expiry", "proj_retry_claim", 1_000);
    admitPreparedJobs(store, [selected], 2_000);
    settleSafeControlEffects(db, selected.id);
    db.prepare("UPDATE effects SET next_attempt_at = ? WHERE job_id = ? AND kind = 'spawn_plan'")
      .run(100_000, selected.id);

    const firstPass = executorDeferred();
    const retryReady = executorDeferred();
    const abort = new AbortController();
    const dispatched: string[] = [];
    let now = 2_000;
    let waitCount = 0;
    const execution = runJobExecutorService({
      store,
      clock: { now: () => now },
      leaseMs: 30_000,
      maxConcurrentJobs: () => 1,
      reconcileJob: async () => undefined,
      effectRunnerFactory: () => ({
        run: async (effect: StoredEffect) => {
          dispatched.push(effect.kind);
        },
      }),
      waitForWork: async () => {
        waitCount += 1;
        if (waitCount === 1) {
          firstPass.resolve();
          await retryReady.promise;
        } else if (waitCount >= 3) {
          abort.abort();
        }
      },
    } as JobExecutorDependencies, abort.signal);

    try {
      await firstPass.promise;
      now = 32_001;
      db.prepare("UPDATE executor_lease SET heartbeat_at = ?, lease_expires_at = ? WHERE singleton = 1")
        .run(now, now + 30_000);
      db.prepare("UPDATE effects SET next_attempt_at = ? WHERE job_id = ? AND kind = 'spawn_plan'")
        .run(now, selected.id);
      retryReady.resolve();
      await execution;

      expect(dispatched).toEqual(["spawn_plan"]);
    } finally {
      abort.abort();
      retryReady.resolve();
      await execution;
    }
  });

  it("leaves the predecessor claim after reconciliation fails", async () => {
    const { store, db } = fixture();
    const selected = queueProjectJob(store, "job_reconcile_failure", "proj_reconcile_failure", 1_000);
    admitPreparedJobs(store, [selected], 2_000);
    db.prepare("UPDATE effects SET status = 'done' WHERE job_id = ? AND kind IN ('render_status', 'revoke_approvals')")
      .run(selected.id);
    const originalClaim = store.listHeldResourceClaims(selected.id, 10)[0];
    if (!originalClaim) throw new Error("failure fixture did not receive a held claim");
    const firstWait = executorDeferred();
    let waitCount = 0;
    let reconciliationCalls = 0;
    const abort = new AbortController();
    const execution = runJobExecutorService({
      store,
      clock: { now: () => 2_000 },
      maxConcurrentJobs: () => 1,
      reconcileJob: async () => {
        reconciliationCalls += 1;
        throw new Error("reconciliation failed safely");
      },
      effectRunnerFactory: () => ({ run: async () => undefined }),
      waitForWork: async (_milliseconds, signal) => {
        waitCount += 1;
        if (waitCount === 1) {
          await firstWait.promise;
          return;
        }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    } as JobExecutorDependencies, abort.signal);

    try {
      for (let microtask = 0; microtask < 20; microtask += 1) await Promise.resolve();
      expect(reconciliationCalls).toBe(1);
      expect(store.listHeldResourceClaims(selected.id, 10)[0]).toMatchObject({
        ownerId: originalClaim.ownerId,
        generation: originalClaim.generation,
      });
    } finally {
      abort.abort();
      firstWait.resolve();
      await execution;
    }
  });

  it("leaves the predecessor claim after reconciliation is aborted", async () => {
    const { store, db } = fixture();
    const selected = queueProjectJob(store, "job_reconcile_abort", "proj_reconcile_abort", 1_000);
    admitPreparedJobs(store, [selected], 2_000);
    db.prepare("UPDATE effects SET status = 'done' WHERE job_id = ? AND kind IN ('render_status', 'revoke_approvals')")
      .run(selected.id);
    const originalClaim = store.listHeldResourceClaims(selected.id, 10)[0];
    if (!originalClaim) throw new Error("abort fixture did not receive a held claim");
    const reconciliation = executorDeferred();
    const firstWait = executorDeferred();
    let waitCount = 0;
    let reconciliationStarted = false;
    const abort = new AbortController();
    const execution = runJobExecutorService({
      store,
      clock: { now: () => 2_000 },
      maxConcurrentJobs: () => 1,
      reconcileJob: async () => {
        reconciliationStarted = true;
        await reconciliation.promise;
      },
      effectRunnerFactory: () => ({ run: async () => undefined }),
      waitForWork: async (_milliseconds, signal) => {
        waitCount += 1;
        if (waitCount === 1) {
          await firstWait.promise;
          return;
        }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    } as JobExecutorDependencies, abort.signal);

    try {
      for (let microtask = 0; microtask < 20; microtask += 1) await Promise.resolve();
      expect(reconciliationStarted).toBe(true);
      abort.abort();
      firstWait.resolve();
      await execution;
      reconciliation.resolve();
      await executorMicrotasks();
      expect(store.listHeldResourceClaims(selected.id, 10)[0]).toMatchObject({
        ownerId: originalClaim.ownerId,
        generation: originalClaim.generation,
      });
    } finally {
      abort.abort();
      reconciliation.resolve();
      firstWait.resolve();
      await execution;
    }
  });

  it("runs a safe control for an occupied job before its reconciliation without same-job overlap", async () => {
    const { store } = fixture();
    const selected = queueProjectJob(store, "job_control_before_adoption", "proj_ctrl_adopt", 1_000);
    admitPreparedJobs(store, [selected], 2_000);
    const reconciliation = executorDeferred();
    const firstWait = executorDeferred();
    let waitCount = 0;
    let controlActive = false;
    let reconciliationStarted = false;
    let controlRan = false;
    let sameJobOverlap = false;
    const abort = new AbortController();
    const execution = runJobExecutorService({
      store,
      clock: { now: () => 2_000 },
      maxConcurrentJobs: () => 1,
      reconcileJob: async () => {
        if (controlActive) sameJobOverlap = true;
        reconciliationStarted = true;
        await reconciliation.promise;
      },
      effectRunnerFactory: () => ({
        run: async (effect: StoredEffect) => {
          if (effect.jobId !== selected.id || effect.kind !== "render_status") return;
          if (reconciliationStarted) sameJobOverlap = true;
          controlActive = true;
          controlRan = true;
          controlActive = false;
        },
      }),
      waitForWork: async (_milliseconds, signal) => {
        waitCount += 1;
        if (waitCount === 1) {
          await firstWait.promise;
          return;
        }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    } as JobExecutorDependencies, abort.signal);

    try {
      for (let microtask = 0; microtask < 20; microtask += 1) await Promise.resolve();
      expect(controlRan).toBe(true);
      expect(reconciliationStarted).toBe(false);
      expect(sameJobOverlap).toBe(false);
    } finally {
      abort.abort();
      reconciliation.resolve();
      firstWait.resolve();
      await execution;
    }
  });

  it("renews a pre-adoption control and aborts it when singleton renewal is lost", async () => {
    vi.useFakeTimers();
    const { store, db } = fixture();
    const selected = queueProjectJob(store, "job_control_renewal", "proj_control_renewal", 1_000);
    admitPreparedJobs(store, [selected], 2_000);
    const originalClaim = store.listHeldResourceClaims(selected.id, 10)[0];
    if (!originalClaim) throw new Error("control renewal fixture did not receive a held claim");
    const firstWait = executorDeferred();
    let waitCount = 0;
    let now = 2_000;
    let controlAborted = false;
    let controlStarted = false;
    const abort = new AbortController();
    const execution = runJobExecutorService({
      store,
      clock: { now: () => now },
      leaseMs: 30_000,
      maxConcurrentJobs: () => 1,
      effectRunnerFactory: (fence) => ({
        run: async (effect: StoredEffect) => {
          if (effect.jobId !== selected.id || effect.kind !== "render_status") return;
          fence.signal.addEventListener("abort", () => { controlAborted = true; }, { once: true });
          controlStarted = true;
          await new Promise<void>((resolve, reject) => {
            if (fence.signal.aborted) {
              reject(fence.signal.reason);
              return;
            }
            fence.signal.addEventListener("abort", () => reject(fence.signal.reason), { once: true });
          });
        },
      }),
      waitForWork: async (_milliseconds, signal) => {
        waitCount += 1;
        if (waitCount === 1) {
          await firstWait.promise;
          return;
        }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    } as JobExecutorDependencies, abort.signal);

    try {
      for (let microtask = 0; microtask < 20; microtask += 1) await Promise.resolve();
      expect(controlStarted).toBe(true);
      const control = store.listEffectsForJob(selected.id).find((effect) => effect.kind === "render_status");
      if (!control) throw new Error("control renewal fixture did not find its control effect");
      const originalLeaseOwner = control.leaseOwner;
      const originalLeaseGeneration = control.leaseGeneration;

      now = 12_000;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(store.getEffect(selected.id, control.idempotencyKey)).toMatchObject({
        status: "leased",
        leaseOwner: originalLeaseOwner,
        leaseGeneration: originalLeaseGeneration,
        leaseExpiresAt: 42_000,
      });
      expect(store.listHeldResourceClaims(selected.id, 10)[0]).toMatchObject({
        ownerId: originalClaim.ownerId,
        generation: originalClaim.generation,
      });

      await vi.advanceTimersByTimeAsync(9_999);
      db.prepare(
        "UPDATE executor_lease SET owner_id = ?, generation = generation + 1, heartbeat_at = ?, lease_expires_at = ? WHERE singleton = 1",
      ).run("successor", now, now + 30_000);
      now = 22_000;
      await vi.advanceTimersByTimeAsync(1);
      for (let microtask = 0; microtask < 10; microtask += 1) await Promise.resolve();
      expect(controlAborted).toBe(true);
      expect(store.getEffect(selected.id, control.idempotencyKey)).toMatchObject({
        status: "leased",
        leaseOwner: originalLeaseOwner,
        leaseGeneration: originalLeaseGeneration,
      });
      abort.abort();
      firstWait.resolve();
      await execution;
    } finally {
      abort.abort();
      firstWait.resolve();
      await execution;
      vi.useRealTimers();
    }
  });

  it("fails closed for an admitted job when exact reconciliation is unavailable", async () => {
    const { store } = fixture();
    const selected = queueProjectJob(store, "job_without_reconciler", "proj_without_reconciler", 1_000);
    admitPreparedJobs(store, [selected], 2_000);
    const originalClaim = store.listHeldResourceClaims(selected.id, 10)[0];
    if (!originalClaim) throw new Error("reconciler bypass fixture did not receive a held claim");
    const ordinaryEffect = store.listEffectsForJob(selected.id).find((effect) => effect.kind === "spawn_plan");
    if (!ordinaryEffect) throw new Error("reconciler bypass fixture did not receive an ordinary effect");
    const firstWait = executorDeferred();
    let waitCount = 0;
    let ordinaryRuns = 0;
    const abort = new AbortController();
    const execution = runJobExecutorService({
      store,
      clock: { now: () => 2_000 },
      maxConcurrentJobs: () => 1,
      effectRunnerFactory: () => ({
        run: async (effect: StoredEffect) => {
          if (effect.jobId === selected.id && effect.kind === "spawn_plan") ordinaryRuns += 1;
        },
      }),
      waitForWork: async (_milliseconds, signal) => {
        waitCount += 1;
        if (waitCount === 1) {
          await firstWait.promise;
          return;
        }
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    } as JobExecutorDependencies, abort.signal);

    try {
      await executorMicrotasks();
      expect(ordinaryRuns).toBe(0);
      expect(store.getEffect(selected.id, ordinaryEffect.idempotencyKey)).toMatchObject({ status: "pending" });
      expect(store.listHeldResourceClaims(selected.id, 10)[0]).toMatchObject({
        ownerId: originalClaim.ownerId,
        generation: originalClaim.generation,
      });
    } finally {
      abort.abort();
      firstWait.resolve();
      await execution;
    }
  });

  it("starts another admitted job before the first deferred reconciliation resolves", async () => {
    const { store, db } = fixture();
    const selectedA = queueProjectJob(store, "job_lane_a", "proj_lane_a", 1_000);
    const selectedB = queueProjectJob(store, "job_lane_b", "proj_lane_b", 900);
    admitPreparedJobs(store, [selectedA, selectedB], 2_000);
    settleSafeControlEffects(db, selectedA.id);
    settleSafeControlEffects(db, selectedB.id);
    const holds = new Map([
      [selectedA.id, executorDeferred()],
      [selectedB.id, executorDeferred()],
    ]);
    const started: string[] = [];
    const abort = new AbortController();
    const execution = runJobExecutorService({
      store,
      clock: { now: () => 2_000 },
      maxConcurrentJobs: () => 2,
      reconcileJob: async (job) => {
        if (store.getAdmission(job.id)?.state !== "admitted") return;
        started.push(job.id);
        await holds.get(job.id)?.promise;
      },
      effectRunnerFactory: () => ({ run: vi.fn(async () => undefined) }),
      waitForWork: async (_milliseconds, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    } as JobExecutorDependencies, abort.signal);

    try {
      await executorMicrotasks();
      expect(started).toContain(selectedA.id);
      expect(started).toContain(selectedB.id);
    } finally {
      abort.abort();
      for (const hold of holds.values()) hold.resolve();
      await execution;
    }
  });

  it("runs a queued status control while another project's pipeline lane is slow", async () => {
    const { store } = fixture();
    const selectedA = queueProjectJob(store, "job_control_a", "proj_control_a", 1_000);
    const selectedB = queueProjectJob(store, "job_control_b", "proj_control_b", 900);
    admitPreparedJobs(store, [selectedA], 2_000);
    const slowPipeline = executorDeferred();
    let controlRan = false;
    const abort = new AbortController();
    const execution = runJobExecutorService({
      store,
      clock: { now: () => 2_000 },
      maxConcurrentJobs: () => 1,
      reconcileJob: async (job) => {
        if (job.id !== selectedA.id) return;
        await slowPipeline.promise;
      },
      effectRunnerFactory: () => ({
        run: async (effect: StoredEffect) => {
          if (effect.jobId === selectedB.id && effect.kind === "render_status") {
            controlRan = true;
          }
        },
      }),
      waitForWork: async (_milliseconds, signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    } as JobExecutorDependencies, abort.signal);

    try {
      await executorMicrotasks();
      expect(store.getAdmission(selectedB.id)?.state).toBe("queued");
      expect(controlRan).toBe(true);
    } finally {
      abort.abort();
      slowPipeline.resolve();
      await execution;
    }
  });

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

  it("runs safe controls sequentially and never starts a second instance after a lease loss", async () => {
    const { store, db } = fixture();
    const controller = prepareExecutorTestJob(store);
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
    const firstControlStarted = executorDeferred();
    const releaseFirstControl = executorDeferred();
    const order: string[] = [];
    let now = 1_000;
    let active = 0;
    let sameJobOverlap = false;
    let successorAcquired = false;
    let successorGeneration: number | null = null;
    const deps: JobExecutorDependencies = {
      store,
      clock: { now: () => now },
      controller,
      effectRunnerFactory: () => ({
        run: async (effect: StoredEffect) => {
          active += 1;
          if (active > 1) sameJobOverlap = true;
          order.push(effect.idempotencyKey);
          try {
            if (effect.idempotencyKey === "job_1:2:one") {
              now = 31_001;
              const successor = store.acquireExecutorLease("successor", now, 30_000);
              successorAcquired = successor.acquired;
              successorGeneration = successor.acquired ? successor.generation : null;
              firstControlStarted.resolve();
              await releaseFirstControl.promise;
            }
          } finally {
            active -= 1;
          }
        },
      }),
    };

    const execution = runJobExecutorService(deps, abort.signal);
    try {
      await firstControlStarted.promise;
      expect(successorAcquired).toBe(true);
      expect(successorGeneration).toBe(2);
      expect(order).toEqual(["job_1:2:one"]);
      expect(active).toBe(1);
      expect(sameJobOverlap).toBe(false);
    } finally {
      abort.abort();
      releaseFirstControl.resolve();
      await execution;
    }

    expect(order).toEqual(["job_1:2:one"]);
    expect(db.prepare("SELECT status FROM effects WHERE idempotency_key IN ('job_1:2:one', 'job_1:3:two') ORDER BY idempotency_key").all()).toEqual([
      { status: "leased" },
      { status: "pending" },
    ]);
    expect(active).toBe(0);
    expect(sameJobOverlap).toBe(false);
    expect(store.acquireExecutorLease("other", now, 30_000)).toEqual({ acquired: false });
  });

  it("does not complete an effect after the singleton lease is genuinely lost", async () => {
    const { store, db } = fixture();
    const controller = prepareExecutorTestJob(store);
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
      controller,
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
    const controller = prepareExecutorTestJob(store);
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
      controller,
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

  it("persists the full Telegram retry_after without holding the outbox lease", async () => {
    const { store } = fixture();
    store.enqueueOutbox({ logicalKey: "notice:rate-limited", chatId: "70", payload: { text: "hello" } }, 1_000);
    store.enqueueOutbox({ logicalKey: "notice:ready", chatId: "70", payload: { text: "real reply" } }, 1_000);
    const delivered: string[] = [];
    const signals: Array<AbortSignal | undefined> = [];
    let attempts = 0;
    const sendMessage = vi.fn(async (
      _chatId: string,
      payload: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      attempts += 1;
      signals.push(signal);
      if (attempts === 1) {
        throw new TelegramApiError({
          httpStatus: 429,
          errorCode: 429,
          description: "Too Many Requests",
          retryAfterSeconds: 120,
        });
      }
      delivered.push(String(payload.text));
      return { message_id: 901 };
    });
    const telegram = () => ({ sendMessage, editMessage: vi.fn(async () => undefined) });

    await runOutboxPass(store, 1_000, telegram);
    expect(store.getOutbox("notice:rate-limited")).toMatchObject({
      status: "failed",
      attempts: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      nextAttemptAt: 121_000,
    });
    expect(store.getOutbox("notice:ready")).toMatchObject({ status: "sent", attempts: 1 });
    expect(delivered).toEqual(["real reply"]);

    await runOutboxPass(store, 120_999, telegram);
    expect(sendMessage).toHaveBeenCalledTimes(2);

    await runOutboxPass(store, 121_000, telegram);
    expect(store.getOutbox("notice:rate-limited")).toMatchObject({ status: "sent", attempts: 2 });
    expect(delivered).toEqual(["real reply", "hello"]);
    expect(signals).toEqual([
      expect.any(AbortSignal),
      expect.any(AbortSignal),
      expect.any(AbortSignal),
    ]);
  });

  it("durably retries a transient request that is known not to have been sent", async () => {
    const { store } = fixture();
    store.enqueueOutbox({ logicalKey: "notice:dns-retry", chatId: "70", payload: { text: "hello" } }, 1_000);
    let attempts = 0;
    const sendMessage = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new TelegramRequestError("Telegram request failed", "not_sent");
      return { message_id: 902 };
    });
    const telegram = () => ({ sendMessage, editMessage: vi.fn(async () => undefined) });

    await runOutboxPass(store, 1_000, telegram);
    expect(store.getOutbox("notice:dns-retry")).toMatchObject({
      status: "failed",
      attempts: 1,
      nextAttemptAt: 1_500,
    });

    await runOutboxPass(store, 1_499, telegram);
    expect(sendMessage).toHaveBeenCalledOnce();

    await runOutboxPass(store, 1_500, telegram);
    expect(store.getOutbox("notice:dns-retry")).toMatchObject({ status: "sent", attempts: 2 });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["the response was lost", new TelegramRequestError("Telegram request failed", "unknown")],
    ["the transient response was malformed", new TelegramApiError({
      httpStatus: 502,
      errorCode: 502,
      deliveryOutcome: "unknown",
    })],
  ])("retries an accepted new message when %s until delivery is confirmed", async (_scenario, deliveryError) => {
    const { store, db } = fixture();
    insertJobAndOutbox(store, db);
    const ownerMessages: string[] = [];
    let attempts = 0;
    const sendMessage = vi.fn(async (_chatId: string, payload: Record<string, unknown>) => {
      attempts += 1;
      ownerMessages.push(String(payload.text));
      if (attempts === 1) throw deliveryError;
      return { message_id: 903 };
    });
    const telegram = () => ({ sendMessage, editMessage: vi.fn(async () => undefined) });

    await runOutboxPass(store, 1_000, telegram);
    expect(store.getOutbox("job:job_1:status")).toMatchObject({
      status: "failed",
      attempts: 1,
      leaseOwner: null,
      nextAttemptAt: 1_500,
    });

    await runOutboxPass(store, 1_500, telegram);
    expect(store.getOutbox("job:job_1:status")).toMatchObject({ status: "sent", attempts: 2 });
    expect(ownerMessages).toEqual(["initial", "initial"]);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("replaces an exhausted uncertain delivery with a vetted owner-visible warning", async () => {
    const { store, db } = fixture();
    insertJobAndOutbox(store, db);
    const attemptedTexts: string[] = [];
    const deliveredTexts: string[] = [];
    let warningAttempts = 0;
    const sendMessage = vi.fn(async (_chatId: string, payload: Record<string, unknown>) => {
      const text = String(payload.text);
      attemptedTexts.push(text);
      if (text === "initial") throw new TelegramRequestError("Telegram request failed", "unknown");
      warningAttempts += 1;
      if (warningAttempts === 1) throw new TelegramRequestError("Telegram request failed", "not_sent");
      deliveredTexts.push(text);
      return { message_id: 904 };
    });
    const telegram = () => ({ sendMessage, editMessage: vi.fn(async () => undefined) });
    let now = 1_000;

    for (let attempt = 0; attempt < 21; attempt += 1) {
      await runOutboxPass(store, now, telegram);
      const outbox = store.getOutbox("job:job_1:status")!;
      if (outbox.status === "sent") break;
      now = outbox.nextAttemptAt;
    }

    const outbox = store.getOutbox("job:job_1:status");
    expect(outbox).toMatchObject({ status: "sent", messageId: 904 });
    expect(attemptedTexts.filter((text) => text === "initial")).toHaveLength(20);
    expect(attemptedTexts.filter((text) => text !== "initial")).toHaveLength(2);
    expect(deliveredTexts).toHaveLength(1);
    expect(deliveredTexts[0]).toMatch(/couldn't confirm.*previous message.*missing or duplicated/i);
    expect(outbox?.payload.text).toBe(deliveredTexts[0]);
  });

  it("retries an ambiguous edit against its stored Telegram message identity", async () => {
    const { store } = fixture();
    store.enqueueOutbox({
      logicalKey: "notice:known-message",
      chatId: "70",
      messageId: 77,
      payload: { text: "updated" },
    }, 1_000);
    let attempts = 0;
    const editMessage = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new TelegramRequestError("Telegram request failed", "unknown");
    });
    const sendMessage = vi.fn(async () => ({ message_id: 903 }));
    const telegram = () => ({ sendMessage, editMessage });

    await runOutboxPass(store, 1_000, telegram);
    expect(store.getOutbox("notice:known-message")).toMatchObject({
      status: "failed",
      nextAttemptAt: 1_500,
    });

    await runOutboxPass(store, 1_500, telegram);
    expect(store.getOutbox("notice:known-message")).toMatchObject({ status: "sent", messageId: 77 });
    expect(editMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("drains 25 queued messages in three bounded passes", async () => {
    const { store } = fixture();
    for (let index = 0; index < 25; index += 1) {
      store.enqueueOutbox({
        logicalKey: `notice:burst:${String(index).padStart(2, "0")}`,
        chatId: "70",
        payload: { text: `message ${index}` },
      }, 1_000);
    }
    const abort = new AbortController();
    let now = 1_000;
    const sendMessage = vi.fn(async () => ({ message_id: 904 }));
    const waitForWork = vi.fn(async () => {
      const allSent = store.listOutbox(25).every((outbox) => outbox.status === "sent");
      if (allSent) abort.abort();
      else now += 1_000;
    });

    await runJobExecutorService({
      store,
      clock: { now: () => now },
      waitForWork,
      telegram: () => ({ sendMessage, editMessage: vi.fn(async () => undefined) }),
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => now }),
      releaseOnShutdown: true,
    }, abort.signal);

    expect(sendMessage).toHaveBeenCalledTimes(25);
    expect(now).toBe(3_000);
    expect(store.listOutbox(25).every((outbox) => outbox.status === "sent")).toBe(true);
  });

  it("leases each burst message immediately before its bounded network call", async () => {
    const { store } = fixture();
    for (let index = 0; index < 10; index += 1) {
      store.enqueueOutbox({
        logicalKey: `notice:fresh-lease:${index}`,
        chatId: "70",
        payload: { text: `message ${index}` },
      }, 1_000);
    }
    const abort = new AbortController();
    let now = 1_000;
    const sendMessage = vi.fn(async (_chatId: string, payload: Record<string, unknown>, signal?: AbortSignal) => {
      const current = store.listOutbox(10).find((outbox) => outbox.payload.text === payload.text);
      expect(current).toMatchObject({
        status: "leased",
        leaseExpiresAt: now + 30_000,
      });
      expect(signal).toBeInstanceOf(AbortSignal);
      now += 4_000;
      expect(store.renewExecutorLease(current!.leaseOwner!, current!.leaseGeneration!, now, 30_000)).toBe(true);
      return { message_id: 905 };
    });

    await runJobExecutorService({
      store,
      clock: { now: () => now },
      waitForWork: vi.fn(async () => abort.abort()),
      telegram: () => ({ sendMessage, editMessage: vi.fn(async () => undefined) }),
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => now }),
      releaseOnShutdown: true,
    }, abort.signal);

    expect(sendMessage).toHaveBeenCalledTimes(10);
    expect(store.listOutbox(10).every((outbox) => outbox.status === "sent")).toBe(true);
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

    expect(sendMessage).toHaveBeenCalledWith("70", { text: "updated" }, expect.any(AbortSignal));
    expect(store.getJob(job.id)?.statusMessageId).toBe(202);
    expect(store.getOutbox(`job:${job.id}:status`)).toMatchObject({ status: "sent", messageId: 202 });
  });

  it("renews the row before a replacement send can consume the remaining lease", async () => {
    const { store } = fixture();
    const created = store.createJob({ id: "job_slow_replace", sourceUpdateId: 13, requestText: "work", now: 1_000 });
    const job = store.setJobStatusMessage(created.id, 101, created.version, 1_001);
    store.enqueueOutbox({
      logicalKey: `job:${job.id}:status`,
      chatId: "70",
      messageId: 101,
      payload: { text: "updated" },
    }, 1_002);
    const abort = new AbortController();
    let now = 2_000;
    const renewExecutor = (): void => {
      const outbox = store.getOutbox(`job:${job.id}:status`)!;
      expect(store.renewExecutorLease(outbox.leaseOwner!, outbox.leaseGeneration!, now, 30_000)).toBe(true);
    };
    const editMessage = vi.fn(async () => {
      now += 15_000;
      renewExecutor();
      throw new TelegramApiError({
        httpStatus: 400,
        errorCode: 400,
        description: "Bad Request: message to edit not found",
        retryAfterSeconds: null,
      });
    });
    const sendMessage = vi.fn(async () => {
      now += 15_000;
      renewExecutor();
      abort.abort();
      return { message_id: 202 };
    });

    await runJobExecutorService({
      store,
      clock: { now: () => now },
      telegram: () => ({ sendMessage, editMessage }),
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => now }),
      releaseOnShutdown: true,
    }, abort.signal);

    expect(sendMessage).toHaveBeenCalledOnce();
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

    expect(editMessage).toHaveBeenNthCalledWith(
      1,
      "70",
      303,
      { text: "<b>broken", parse_mode: "HTML" },
      expect.any(AbortSignal),
    );
    expect(editMessage).toHaveBeenNthCalledWith(
      2,
      "70",
      303,
      { text: "<b>broken" },
      expect.any(AbortSignal),
    );
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

  it("streams a submitted controller turn through one ephemeral Telegram draft", async () => {
    const { store } = fixture();
    addSubmittedControllerTurn(store);
    const abort = new AbortController();
    const sendMessage = vi.fn(async () => ({ message_id: 501 }));
    const editMessage = vi.fn(async () => undefined);
    const sendMessageDraft = vi.fn(async (_chatId: string, _draftId: number, _text: string) => undefined);
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
      telegram: () => ({ sendMessage, editMessage, sendMessageDraft }),
      controller: {
        reconcile: vi.fn(async (fence) => {
          if (loop === 1) {
            expect(store.updateControllerStream({
              ownerId: fence.ownerId,
              generation: fence.generation,
              now: 2_000,
              turnId: "controller-turn-900",
              cursor: 1,
              phase: "responding",
            })).toBe(true);
          }
          return true;
        }),
        processOne: vi.fn(async () => false),
      },
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 + loop * 1_000 }),
    }, abort.signal);

    expect(sendMessageDraft).toHaveBeenCalledTimes(2);
    expect(sendMessageDraft).toHaveBeenNthCalledWith(
      1,
      "7",
      expect.any(Number),
      CONTROLLER_PHASE_TEXT.connecting,
      expect.any(AbortSignal),
    );
    expect(sendMessageDraft).toHaveBeenNthCalledWith(
      2,
      "7",
      expect.any(Number),
      CONTROLLER_PHASE_TEXT.responding,
      expect.any(AbortSignal),
    );
    expect(sendMessageDraft.mock.calls[0]?.[1]).toBe(sendMessageDraft.mock.calls[1]?.[1]);
    expect(sendMessageDraft.mock.calls[0]?.[1]).toBeGreaterThan(0);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(editMessage).not.toHaveBeenCalled();
    expect(store.getOutbox("controller:controller-turn-900:reply")).toMatchObject({
      status: "sent",
      messageId: null,
      payload: { text: CONTROLLER_PHASE_TEXT.responding },
    });
  });

  it("coalesces repeated controller phase edits before they reach Telegram", async () => {
    const { store } = fixture();
    const turnId = addSubmittedControllerTurn(store);
    const abort = new AbortController();
    const sendMessage = vi.fn(async () => ({ message_id: 501 }));
    const editMessage = vi.fn(async () => undefined);
    let loop = 0;
    let executorFence: { ownerId: string; generation: number } | null = null;
    const waitForWork = vi.fn(async () => {
      loop += 1;
      if (executorFence && (loop === 1 || loop === 2)) {
        expect(store.updateControllerStream({
          ownerId: executorFence.ownerId,
          generation: executorFence.generation,
          now: 1_000 + loop * 1_000,
          turnId,
          cursor: loop,
          phase: "responding",
        })).toBe(true);
      }
      if (loop === 3) abort.abort();
    });
    const reconcile = vi.fn(async (fence: Parameters<NonNullable<JobExecutorDependencies["controller"]>["reconcile"]>[0]) => {
      executorFence = fence;
      return true;
    });

    await runJobExecutorService({
      store,
      clock: { now: () => 1_000 + loop * 1_000 },
      sleep: vi.fn(async () => { throw new Error("ordinary loop sleep must not be used"); }),
      waitForWork,
      telegram: () => ({ sendMessage, editMessage }),
      controller: {
        reconcile,
        processOne: vi.fn(async () => false),
      },
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 + loop * 1_000 }),
    }, abort.signal);

    expect(waitForWork).toHaveBeenCalledTimes(3);
    expect(reconcile).toHaveBeenCalledTimes(3);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(editMessage).toHaveBeenCalledOnce();
    expect(editMessage).toHaveBeenCalledWith("7", 501, {
      text: CONTROLLER_PHASE_TEXT.responding,
      disable_web_page_preview: true,
    }, expect.any(AbortSignal));
  });

  it("does not let a slow stream edit hold back the terminal reply", async () => {
    const { store } = fixture();
    const turnId = addSubmittedControllerTurn(store);
    const abort = new AbortController();
    let nextMessageId = 500;
    const sendMessage = vi.fn(async () => ({ message_id: ++nextMessageId }));
    let resolveEdit!: () => void;
    const editMessage = vi.fn(() => new Promise<void>((resolve) => {
      resolveEdit = resolve;
    }));
    let loop = 0;
    let executorFence: { ownerId: string; generation: number } | null = null;
    const waitForWork = vi.fn(async () => {
      loop += 1;
      if (loop === 1 && executorFence) {
        expect(store.updateControllerStream({
          ownerId: executorFence.ownerId,
          generation: executorFence.generation,
          now: 2_000,
          turnId,
          cursor: 1,
          phase: "responding",
        })).toBe(true);
      }
      if (loop === 3) abort.abort();
    });
    const reconcile = vi.fn(async (fence: Parameters<NonNullable<JobExecutorDependencies["controller"]>["reconcile"]>[0]) => {
      executorFence = fence;
      if (loop === 2) {
        completeTurnThroughFinalization(store, {
          ownerId: fence.ownerId,
          generation: fence.generation,
          now: 3_000,
        }, { turnId, controllerKey: "executor-presence-controller", responseText: "Final answer" });
      }
      return true;
    });

    const run = runJobExecutorService({
      store,
      clock: { now: () => 1_000 + loop * 1_000 },
      sleep: vi.fn(async () => { throw new Error("ordinary loop sleep must not be used"); }),
      waitForWork,
      telegram: () => ({ sendMessage, editMessage }),
      controller: {
        reconcile,
        processOne: vi.fn(async () => false),
      },
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 + loop * 1_000 }),
    }, abort.signal);

    try {
      const completed = await Promise.race([
        run.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
      expect(completed).toBe(true);
      expect(sendMessage).toHaveBeenCalledWith("7", {
        text: "Final answer",
        disable_web_page_preview: true,
      }, expect.any(AbortSignal));
    } finally {
      resolveEdit();
      await run;
    }
  });

  it("keeps delivering a reply when Telegram presence fails", async () => {
    const { store } = fixture();
    const turnId = addSubmittedControllerTurn(store);
    const abort = new AbortController();
    let nextMessageId = 500;
    const sendMessage = vi.fn(async () => ({ message_id: ++nextMessageId }));
    const editMessage = vi.fn(async () => undefined);
    const sendChatAction = vi.fn(async () => {
      throw new Error("typing unavailable");
    });
    const presence = new TelegramPresenceCoordinator({
      store,
      telegram: { sendChatAction },
      warn: vi.fn(),
    });
    let loop = 0;
    const waitForWork = vi.fn(async () => {
      loop += 1;
      if (loop === 3) abort.abort();
    });
    const reconcile = vi.fn(async (fence: Parameters<NonNullable<JobExecutorDependencies["controller"]>["reconcile"]>[0]) => {
      if (loop === 1) {
        completeTurnThroughFinalization(store, {
          ownerId: fence.ownerId,
          generation: fence.generation,
          now: 2_000,
        }, { turnId, controllerKey: "executor-presence-controller", responseText: "Final answer" });
      }
      return true;
    });

    await runJobExecutorService({
      store,
      clock: { now: () => 1_000 + loop * 1_000 },
      sleep: vi.fn(async () => { throw new Error("ordinary loop sleep must not be used"); }),
      waitForWork,
      telegram: () => ({ sendMessage, editMessage }),
      presence,
      controller: {
        reconcile,
        processOne: vi.fn(async () => false),
      },
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 + loop * 1_000 }),
    }, abort.signal);

    expect(sendChatAction).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith("7", {
      text: CONTROLLER_PHASE_TEXT.connecting,
      disable_web_page_preview: true,
    }, expect.any(AbortSignal));
    expect(editMessage).toHaveBeenCalledWith("7", 501, {
      text: "Final answer",
      disable_web_page_preview: true,
    }, expect.any(AbortSignal));
  });

  it("derives an ephemeral draft from the phase, never a legacy raw stream_text token", async () => {
    const { store, db } = fixture();
    const turnId = addSubmittedControllerTurn(store);
    // A pre-cutover durable stream_text carrying raw provider prose must never
    // reach Telegram as a preview: the draft is the phase literal only.
    db.prepare("UPDATE controller_turns SET stream_text = ?, stream_phase = ? WHERE id = ?")
      .run("pre-cutover RAW-SECRET token", "thinking", turnId);
    const abort = new AbortController();
    const sendMessage = vi.fn(async () => ({ message_id: 1 }));
    const editMessage = vi.fn(async () => undefined);
    const sendMessageDraft = vi.fn(async (_chatId: string, _draftId: number, _text: string) => undefined);
    const waitForWork = vi.fn(async () => abort.abort());

    await runJobExecutorService({
      store,
      clock: { now: () => 1_000 },
      sleep: vi.fn(async () => { throw new Error("ordinary loop sleep must not be used"); }),
      waitForWork,
      telegram: () => ({ sendMessage, editMessage, sendMessageDraft }),
      controller: {
        reconcile: vi.fn(async () => false),
        processOne: vi.fn(async () => false),
      },
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 }),
    }, abort.signal);

    expect(sendMessageDraft).toHaveBeenCalledTimes(1);
    expect(sendMessageDraft).toHaveBeenCalledWith(
      "7",
      expect.any(Number),
      CONTROLLER_PHASE_TEXT.thinking,
      expect.any(AbortSignal),
    );
    expect(sendMessageDraft.mock.calls[0]?.[2]).not.toContain("RAW-SECRET");
    expect(sendMessageDraft.mock.calls[0]?.[2]).not.toContain("token");
  });

  it("suppresses a pending draft send for a submitted terminal-phase turn", async () => {
    const { store, db } = fixture();
    const turnId = addSubmittedControllerTurn(store);
    // The phase flipped to a terminal literal while a stale placeholder draft
    // still sits in the outbox: it must be retired, never redrawn or sent.
    db.prepare("UPDATE controller_turns SET stream_text = ?, stream_phase = ? WHERE id = ?")
      .run("pre-cutover RAW-SECRET token", "failed", turnId);
    const abort = new AbortController();
    const sendMessage = vi.fn(async () => ({ message_id: 1 }));
    const editMessage = vi.fn(async () => undefined);
    const sendMessageDraft = vi.fn(async (_chatId: string, _draftId: number, _text: string) => undefined);
    const waitForWork = vi.fn(async () => abort.abort());

    await runJobExecutorService({
      store,
      clock: { now: () => 1_000 },
      sleep: vi.fn(async () => { throw new Error("ordinary loop sleep must not be used"); }),
      waitForWork,
      telegram: () => ({ sendMessage, editMessage, sendMessageDraft }),
      controller: {
        reconcile: vi.fn(async () => false),
        processOne: vi.fn(async () => false),
      },
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 }),
    }, abort.signal);

    expect(sendMessageDraft).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(editMessage).not.toHaveBeenCalled();
    expect(store.getOutbox(`controller:${turnId}:reply`)).toMatchObject({
      status: "sent",
      messageId: null,
    });
  });

  it("suppresses a terminal controller draft before the known-message edit path", async () => {
    const { store, db } = fixture();
    const turnId = addSubmittedControllerTurn(store);
    db.prepare("UPDATE controller_turns SET stream_text = ?, stream_phase = 'complete' WHERE id = ?")
      .run("pre-cutover RAW-EDIT token", turnId);
    db.prepare("UPDATE outbox SET message_id = 808, status = 'pending' WHERE logical_key = ?")
      .run(`controller:${turnId}:reply`);
    const abort = new AbortController();
    const sendMessage = vi.fn(async () => ({ message_id: 1 }));
    const editMessage = vi.fn(async () => undefined);
    const sendMessageDraft = vi.fn(async () => undefined);

    await runJobExecutorService({
      store,
      clock: { now: () => 1_000 },
      waitForWork: vi.fn(async () => abort.abort()),
      telegram: () => ({ sendMessage, editMessage, sendMessageDraft }),
      controller: {
        reconcile: vi.fn(async () => false),
        processOne: vi.fn(async () => false),
      },
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 }),
    }, abort.signal);

    expect(sendMessageDraft).not.toHaveBeenCalled();
    expect(editMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.getOutbox(`controller:${turnId}:reply`)).toMatchObject({ status: "sent", messageId: 808 });
  });

  it("suppresses a terminal controller draft when Telegram has no draft API", async () => {
    const { store, db } = fixture();
    const turnId = addSubmittedControllerTurn(store);
    db.prepare("UPDATE controller_turns SET stream_text = ?, stream_phase = 'failed' WHERE id = ?")
      .run("pre-cutover RAW-SEND token", turnId);
    const abort = new AbortController();
    const sendMessage = vi.fn(async () => ({ message_id: 1 }));
    const editMessage = vi.fn(async () => undefined);

    await runJobExecutorService({
      store,
      clock: { now: () => 1_000 },
      waitForWork: vi.fn(async () => abort.abort()),
      telegram: () => ({ sendMessage, editMessage }),
      controller: {
        reconcile: vi.fn(async () => false),
        processOne: vi.fn(async () => false),
      },
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 }),
    }, abort.signal);

    expect(editMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.getOutbox(`controller:${turnId}:reply`)).toMatchObject({ status: "sent", messageId: null });
  });

  it("persists exactly one final controller message after ephemeral draft streaming", async () => {
    const { store } = fixture();
    const turnId = addSubmittedControllerTurn(store);
    const abort = new AbortController();
    const sendMessage = vi.fn(async () => ({ message_id: 777 }));
    const editMessage = vi.fn(async () => undefined);
    const sendMessageDraft = vi.fn(async (_chatId: string, _draftId: number, _text: string) => undefined);
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
      telegram: () => ({ sendMessage, editMessage, sendMessageDraft }),
      controller: {
        reconcile: vi.fn(async (fence) => {
          if (loop === 1) {
            completeTurnThroughFinalization(
              store,
              { ownerId: fence.ownerId, generation: fence.generation, now: 2_000 },
              { turnId, controllerKey: "executor-presence-controller", responseText: "Final answer" },
            );
          }
          return true;
        }),
        processOne: vi.fn(async () => false),
      },
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 + loop * 1_000 }),
    }, abort.signal);

    expect(sendMessageDraft).toHaveBeenCalledOnce();
    expect(sendMessageDraft).toHaveBeenCalledWith(
      "7",
      expect.any(Number),
      CONTROLLER_PHASE_TEXT.connecting,
      expect.any(AbortSignal),
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith("7", {
      text: "Final answer",
      disable_web_page_preview: true,
    }, expect.any(AbortSignal));
    expect(editMessage).not.toHaveBeenCalled();
    expect(store.getOutbox(`controller:${turnId}:reply`)).toMatchObject({
      status: "sent",
      messageId: 777,
      payload: { text: "Final answer" },
    });
  });

  it("reuses one Telegram draft id per chat so a stale preview cannot linger beside the next answer", async () => {
    const { store } = fixture();
    const firstTurnId = addSubmittedControllerTurn(store);
    const abort = new AbortController();
    const sendMessage = vi.fn(async () => ({ message_id: 811 }));
    const editMessage = vi.fn(async () => undefined);
    const sendMessageDraft = vi.fn(async (_chatId: string, _draftId: number, _text: string) => undefined);
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
      telegram: () => ({ sendMessage, editMessage, sendMessageDraft }),
      controller: {
        reconcile: vi.fn(async (fence) => {
          // The owner reads the answer and immediately asks the next question,
          // while Telegram still shows the previous 30-second preview.
          if (loop === 1) {
            completeTurnThroughFinalization(
              store,
              { ownerId: fence.ownerId, generation: fence.generation, now: 2_000 },
              { turnId: firstTurnId, controllerKey: "executor-presence-controller", responseText: "First answer" },
            );
            submitAnotherControllerTurn(store, fence, 901, 2_000);
          }
          return true;
        }),
        processOne: vi.fn(async () => false),
      },
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 + loop * 1_000 }),
    }, abort.signal);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessageDraft).toHaveBeenCalledTimes(2);
    expect(sendMessageDraft.mock.calls[0]?.[1]).toBe(sendMessageDraft.mock.calls[1]?.[1]);
  });

  it("polls fast while a controller answer streams so the draft animates instead of jumping", async () => {
    const { store } = fixture();
    const abort = new AbortController();
    const waitForWork = vi.fn(async () => abort.abort());

    await runJobExecutorService({
      store,
      clock: { now: () => 1_000 },
      sleep: vi.fn(async () => { throw new Error("ordinary loop sleep must not be used"); }),
      waitForWork,
      controller: {
        reconcile: vi.fn(async () => true),
        processOne: vi.fn(async () => false),
        isStreaming: () => true,
      },
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 }),
    }, abort.signal);

    expect(waitForWork).toHaveBeenCalledWith(250, expect.any(AbortSignal));
  });

  it.each(["idle", "active"] as const)("caps the %s executor wait at the active presence deadline", async (mode) => {
    const { store } = fixture();
    addSubmittedControllerTurn(store);
    const abort = new AbortController();
    const waitForWork = vi.fn(async () => abort.abort());
    const sendChatAction = vi.fn(async () => undefined);
    const laneSnapshots = new JobLaneSnapshotProvider();
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
      laneSnapshots,
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 }),
    }, abort.signal);

    expect(sendChatAction).toHaveBeenCalledWith("7", "typing", expect.any(AbortSignal));
    expect(waitForWork).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));
  });

  it("preserves the ordinary wait when presence is inactive", async () => {
    const { store } = fixture();
    const abort = new AbortController();
    const waitForWork = vi.fn(async () => abort.abort());
    const laneSnapshots = new JobLaneSnapshotProvider();
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
      laneSnapshots,
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 }),
    }, abort.signal);

    expect(waitForWork).toHaveBeenCalledWith(60_000, expect.any(AbortSignal));
  });

  it("stops pulsing after lease loss and resumes once the prior deadline passes", async () => {
    const { store } = fixture();
    addSubmittedControllerTurn(store);
    const abort = new AbortController();
    let now = 1_000;
    const sendChatAction = vi.fn(async () => undefined);
    const laneSnapshots = new JobLaneSnapshotProvider();
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
      laneSnapshots,
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => now }),
    }, abort.signal);

    expect(sendChatAction).toHaveBeenCalledTimes(1);
    await presence.pulse(now, new AbortController().signal);
    expect(sendChatAction).toHaveBeenCalledTimes(2);
  });

  it("keeps presence throttled across rapid executor lease turnover after the 2026-08-12 incident", async () => {
    const { store, db } = fixture();
    addSubmittedControllerTurn(store);
    const abort = new AbortController();
    let now = 1_000;
    let waits = 0;
    const sendChatAction = vi.fn(async () => undefined);
    const laneSnapshots = new JobLaneSnapshotProvider();
    const presence = new TelegramPresenceCoordinator({
      store,
      telegram: { sendChatAction },
      warn: vi.fn(),
    });

    await runJobExecutorService({
      store,
      clock: { now: () => now },
      sleep: vi.fn(async () => { throw new Error("ordinary loop sleep must not be used"); }),
      waitForWork: vi.fn(async () => {
        waits += 1;
        if (waits === 1) {
          const lease = db.prepare(
            "SELECT owner_id, generation FROM executor_lease WHERE singleton = 1",
          ).get() as { owner_id: string; generation: number };
          expect(store.releaseExecutorLease(lease.owner_id, lease.generation, now)).toBe(true);
          now += 1;
          return;
        }
        abort.abort();
      }),
      presence,
      laneSnapshots,
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => now }),
    }, abort.signal);

    expect(waits).toBe(2);
    expect(sendChatAction).toHaveBeenCalledOnce();
  });

  it("stops cleanly when shutdown aborts an in-flight presence request", async () => {
    const { store } = fixture();
    addSubmittedControllerTurn(store);
    const abort = new AbortController();
    const laneSnapshots = new JobLaneSnapshotProvider();
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
      laneSnapshots,
      effectRunnerFactory: (fence) => new EffectRunner({ store, fence, now: () => 1_000 }),
    }, abort.signal)).resolves.toBeUndefined();
  });

  it("finalizes terminal admitted work in the sequential pass and frees its project capacity", async () => {
    const { store } = fixture();
    const jobId = "job_executor_release";
    queueExecutorBoundaryJob(store, jobId);
    const abort = new AbortController();
    const controller = terminalBoundaryController(store, jobId, 2_000);
    let passes = 0;

    await runJobExecutorService({
      store,
      clock: { now: () => 2_000 },
      sleep: vi.fn(async () => {
        passes += 1;
        if (passes >= 10) abort.abort();
      }),
      controller,
      effectRunnerFactory: () => ({ run: vi.fn(async () => undefined) }),
      releaseOnShutdown: true,
    }, abort.signal);

    expect(store.getJob(jobId)?.state).toBe("cancelled");
    expect(store.getAdmission(jobId)?.state).toBe("released");
    expect(store.listHeldResourceClaims(jobId, 10).filter((claim) => claim.state === "held")).toHaveLength(0);

    const nextJob = queueExecutorBoundaryJob(store, "job_executor_capacity", 3_000);
    const successor = store.acquireExecutorLease("capacity-check", 3_000, 30_000);
    expect(successor).toEqual({ acquired: true, generation: 2 });
    if (!successor.acquired) throw new Error("capacity-check executor lease was not acquired");
    expect(store.tryAdmit({
      jobId: nextJob.id,
      maxConcurrentJobs: 1,
      ownerId: "capacity-check",
      generation: successor.generation,
      now: 3_000,
      leaseMs: 30_000,
    }).outcome).toBe("admitted");
  });

  it("releases a queued cancellation after its safe controls settle", async () => {
    const { store } = fixture();
    const jobId = "job_executor_queued_cancel";
    const queued = queueExecutorBoundaryJob(store, jobId);
    store.applyJobEvent(queued.id, queued.version, { type: "CANCEL_REQUESTED" }, 1_999);
    const abort = new AbortController();
    let passes = 0;

    await runJobExecutorService({
      store,
      clock: { now: () => 2_000 },
      sleep: vi.fn(async () => {
        passes += 1;
        if (passes >= 2) abort.abort();
      }),
      effectRunnerFactory: () => ({ run: vi.fn(async () => undefined) }),
      releaseOnShutdown: true,
    }, abort.signal);

    expect(store.getJob(jobId)?.state).toBe("cancelled");
    expect(store.getAdmission(jobId)?.state).toBe("released");
    expect(store.listEffectsForJob(jobId)
      .filter((effect) => effect.kind === "render_status")
      .every((effect) => effect.status === "done")).toBe(true);
    expect(store.listHeldResourceClaims(jobId, 10)).toHaveLength(0);
  });

  it.each(["active", "unknown"] as const)(
    "keeps a terminal job draining while worker liveness is %s",
    async (state) => {
      const { store } = fixture();
      const jobId = `job_executor_${state}`;
      queueExecutorBoundaryJob(store, jobId);
      const abort = new AbortController();
      await runJobExecutorService({
        store,
        clock: { now: () => 2_000 },
        sleep: vi.fn(async () => abort.abort()),
        controller: terminalBoundaryController(store, jobId, 2_000, boundaryWorker(jobId, state, 2_000)),
        effectRunnerFactory: () => ({ run: vi.fn(async () => undefined) }),
        releaseOnShutdown: true,
      }, abort.signal);

      expect(store.getAdmission(jobId)?.state).toBe("draining");
      expect(store.listHeldResourceClaims(jobId, 10).filter((claim) => claim.state === "held")).toHaveLength(1);
    },
  );

  it("refreshes stale BB worker liveness before releasing a terminal job", async () => {
    const { store } = fixture();
    const jobId = "job_executor_stale_release";
    queueExecutorBoundaryJob(store, jobId);
    const abort = new AbortController();
    const getWorkerThread = vi.fn(async (threadId: string) => ({
      id: threadId,
      status: "idle",
      updatedAt: 20_000,
      runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
    }));

    await runJobExecutorService({
      store,
      clock: { now: () => 20_000 },
      sleep: vi.fn(async () => abort.abort()),
      controller: terminalBoundaryController(store, jobId, 20_000, boundaryWorker(jobId, "stale", 1_000), true),
      getWorkerThread,
      effectRunnerFactory: () => ({ run: vi.fn(async () => undefined) }),
      releaseOnShutdown: true,
    }, abort.signal);

    expect(store.getWorkerLiveness(jobId)).toMatchObject({ state: "idle", observedAt: 20_000 });
    expect(store.getAdmission(jobId)?.state).toBe("released");
    expect(store.listHeldResourceClaims(jobId, 10).filter((claim) => claim.state === "held")).toHaveLength(0);
  });

  it("keeps the claim and records an unknown worker when the BB refresh fails", async () => {
    const { store } = fixture();
    const jobId = "job_executor_stale_lookup_failure";
    queueExecutorBoundaryJob(store, jobId);
    const abort = new AbortController();
    const getWorkerThread = vi.fn(async () => {
      throw new Error("BB temporarily unavailable");
    });

    await runJobExecutorService({
      store,
      clock: { now: () => 20_000 },
      sleep: vi.fn(async () => abort.abort()),
      controller: terminalBoundaryController(store, jobId, 20_000, boundaryWorker(jobId, "stale", 1_000), true),
      getWorkerThread,
      effectRunnerFactory: () => ({ run: vi.fn(async () => undefined) }),
      releaseOnShutdown: true,
    }, abort.signal);

    expect(store.getWorkerLiveness(jobId)).toMatchObject({ state: "unknown", observedAt: 20_000 });
    expect(store.getAdmission(jobId)?.state).toBe("draining");
    expect(store.listHeldResourceClaims(jobId, 10).filter((claim) => claim.state === "held")).toHaveLength(1);
  });

  it("does not finalize a draining job while its sequential operation is still in memory", async () => {
    const { store } = fixture();
    const jobId = "job_executor_in_flight";
    queueExecutorBoundaryJob(store, jobId);
    const abort = new AbortController();
    let markStarted!: () => void;
    let releaseRun!: () => void;
    const operationStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const operationRelease = new Promise<void>((resolve) => { releaseRun = resolve; });
    const reconciliationComplete = executorDeferred();
    const finalized = executorDeferred();
    let waitCount = 0;
    const run = vi.fn(async (effect: StoredEffect) => {
      if (effect.kind === "stop_thread") {
        markStarted();
        await operationRelease;
      }
    });
    const execution = runJobExecutorService({
      store,
      clock: { now: () => 2_000 },
      controller: terminalBoundaryController(store, jobId, 2_000, boundaryWorker(jobId, "active", 2_000), true),
      reconcileJob: async () => {
        reconciliationComplete.resolve();
      },
      effectRunnerFactory: () => ({ run }),
      waitForWork: async (_milliseconds, signal) => {
        waitCount += 1;
        if (waitCount === 1) {
          await reconciliationComplete.promise;
          return;
        }
        if (store.getAdmission(jobId)?.state === "released") finalized.resolve();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
      releaseOnShutdown: true,
    }, abort.signal);

    await operationStarted;
    expect(store.getAdmission(jobId)?.state).toBe("draining");
    expect(store.listHeldResourceClaims(jobId, 10).filter((claim) => claim.state === "held")).toHaveLength(1);

    store.upsertWorkerLiveness(boundaryWorker(jobId, "idle", 2_001));
    releaseRun();
    await finalized.promise;
    abort.abort();
    await execution;
    expect(store.getAdmission(jobId)?.state).toBe("released");
  });

  it("releases an occupied terminal candidate hidden behind more than 100 ordinary queued admissions", async () => {
    const { store } = fixture();
    queueOrdinaryAdmissions(store, 101, "job_executor_ordinary", 10_000);
    settleAllSafeControls(store, 20_000);
    const jobId = "job_executor_occupied_after_queue";
    queueExecutorBoundaryJob(store, jobId, 30_000);
    const abort = new AbortController();

    await runJobExecutorService({
      store,
      clock: { now: () => 40_000 },
      sleep: vi.fn(async () => abort.abort()),
      controller: terminalBoundaryController(store, jobId, 40_000, undefined, true),
      effectRunnerFactory: () => ({ run: vi.fn(async () => undefined) }),
      releaseOnShutdown: true,
    }, abort.signal);

    expect(store.getAdmission(jobId)?.state).toBe("released");
    expect(store.listHeldResourceClaims(jobId, 10).filter((claim) => claim.state === "held")).toHaveLength(0);

    const nextJob = queueExecutorBoundaryJob(store, "job_executor_occupied_successor", 41_000);
    const successor = store.acquireExecutorLease("occupied-successor", 41_000, 30_000);
    expect(successor).toEqual({ acquired: true, generation: 3 });
    if (!successor.acquired) throw new Error("occupied successor executor lease was not acquired");
    expect(store.tryAdmit({
      jobId: nextJob.id,
      maxConcurrentJobs: 1,
      ownerId: "occupied-successor",
      generation: successor.generation,
      now: 31_000,
      leaseMs: 30_000,
    }).outcome).toBe("admitted");
  });

  it("releases a queued cancellation hidden behind more than 100 ordinary queued admissions", async () => {
    const { store } = fixture();
    queueOrdinaryAdmissions(store, 101, "job_executor_queued_ordinary", 50_000);
    settleAllSafeControls(store, 60_000);
    const jobId = "job_executor_queued_cancel_after_queue";
    queueExecutorBoundaryJob(store, jobId, 70_000);
    const abort = new AbortController();

    await runJobExecutorService({
      store,
      clock: { now: () => 80_000 },
      sleep: vi.fn(async () => abort.abort()),
      controller: queuedCancellationController(store, jobId, 80_000),
      effectRunnerFactory: () => ({ run: vi.fn(async () => undefined) }),
      releaseOnShutdown: true,
    }, abort.signal);

    expect(store.getJob(jobId)?.state).toBe("cancelled");
    expect(store.getAdmission(jobId)?.state).toBe("released");
    expect(store.listHeldResourceClaims(jobId, 10)).toHaveLength(0);
  });

  it("prioritizes occupied terminal release over more than 100 queued cancellations", async () => {
    const { store } = fixture();
    queueCancelledAdmissions(store, 101, "job_executor_cancel_backlog", 70_000);
    settleAllSafeControls(store, 80_000);
    const jobId = "job_executor_occupied_priority";
    queueExecutorBoundaryJob(store, jobId, 80_000);
    const abort = new AbortController();

    await runJobExecutorService({
      store,
      clock: { now: () => 90_000 },
      sleep: vi.fn(async () => abort.abort()),
      controller: terminalBoundaryController(store, jobId, 90_000, undefined, true),
      effectRunnerFactory: () => ({ run: vi.fn(async () => undefined) }),
      releaseOnShutdown: true,
    }, abort.signal);

    expect(store.getAdmission(jobId)?.state).toBe("released");
    expect(store.listHeldResourceClaims(jobId, 10).filter((claim) => claim.state === "held")).toHaveLength(0);
    // Draining a 101-deep cancellation backlog against a real SQLite store is
    // the slowest case in this file; it needs more than the default budget
    // without loosening the budget for every other test.
  }, 15_000);
});

describe("controller stall deadline", () => {
  // A wedged turn produces no provider events, so an executor that only woke
  // for provider activity never reached the stall check: a turn sat sixteen
  // minutes past its eight minute deadline until the plugin was restarted by
  // hand. The loop must sleep up to the deadline, not past it.
  it("shortens the wait to the in-flight turn's deadline and leaves it alone otherwise", async () => {
    for (const [deadlineMs, expectShortened] of [[25, true], [null, false]] as const) {
      const { store } = fixture();
      const waits: number[] = [];
      let now = 2_000;
      const abort = new AbortController();

      await runJobExecutorService({
        store,
        clock: { now: () => now },
        maxConcurrentJobs: () => 1,
        controller: {
          processOne: async () => false,
          reconcile: async () => false,
          // Far shorter than any ordinary poll interval, so a wait this short
          // can only have been bounded by the deadline.
          nextStallDeadlineMs: () => deadlineMs,
        },
        effectRunnerFactory: () => ({ run: vi.fn(async () => undefined) }),
        waitForWork: async (milliseconds) => {
          waits.push(milliseconds);
          now += milliseconds;
          if (waits.length === 2) abort.abort();
        },
        releaseOnShutdown: true,
      } as JobExecutorDependencies, abort.signal);

      expect(waits.length).toBeGreaterThan(0);
      expect(waits.every((wait) => wait === 25)).toBe(expectShortened);
    }
  });
});
