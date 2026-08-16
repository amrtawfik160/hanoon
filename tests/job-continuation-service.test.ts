import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { MAX_AUTO_CONTINUES } from "../src/autonomy/job-continuation";
import { JobContinuationService } from "../src/services/job-continuation-service";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { policyFixture } from "./helpers";

let fixtureNumber = 0;

function storeFixture(): TelegramAgentStore {
  const { bb } = createFakePluginHost({ pluginId: `telegram-agent-continuation-${fixtureNumber++}` });
  return openStore(bb.storage);
}

const EXECUTOR = "continuation-executor";
/** Outlives the simulated clock, which advances by sweep intervals. */
const LEASE_MS = 24 * 60 * 60_000;

/**
 * A job admitted and working, under a lease the test keeps holding. Effect
 * leasing is fenced to the executor identity that admitted the job, so the
 * lease has to outlive admission for the test to settle effects at all.
 */
function workingJob(store: TelegramAgentStore, now: number) {
  const draft = store.createJob({ id: "job_1", sourceUpdateId: now, requestText: "ship this", now });
  const selected = store.applyJobEvent(draft.id, draft.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_1",
    policyVersion: 1,
    policy: policyFixture(),
  }, now);
  const lease = store.acquireExecutorLease(EXECUTOR, now, LEASE_MS);
  if (!lease.acquired) throw new Error("executor lease was not acquired");
  store.queueAdmission({
    jobId: selected.id,
    expectedVersion: selected.version,
    projectId: "proj_1",
    resumeEvent: "CONFIRMED",
    now,
  });
  const admission = store.tryAdmit({
    jobId: selected.id,
    maxConcurrentJobs: 8,
    ownerId: EXECUTOR,
    generation: lease.generation,
    now,
    leaseMs: LEASE_MS,
  });
  if (admission.outcome !== "admitted") throw new Error(`job was not admitted: ${admission.reason}`);
  return { id: admission.job.id, generation: lease.generation };
}

function serviceFor(store: TelegramAgentStore, at: { now: number }) {
  return new JobContinuationService({
    store,
    clock: { now: () => at.now },
    issueUpdateId: (now) => 2_000_000_000 + now,
  });
}

/** Kill one effect the way a failing provider does, and see what it costs. */
function blockOnDeadEffect(
  store: TelegramAgentStore,
  job: { id: string; generation: number },
  kind: string,
  now: number,
): void {
  // Effects lease one at a time, so walk to the one this test means to kill.
  for (let step = 0; step < 10; step += 1) {
    const claimed = store.leaseNextJobEffect({
      jobId: job.id,
      ownerId: EXECUTOR,
      generation: job.generation,
      now,
      leaseMs: LEASE_MS,
    });
    if (!claimed) break;
    if (claimed.kind !== kind) {
      store.completeEffect(claimed.idempotencyKey, EXECUTOR, job.generation, now);
      continue;
    }
    store.deadLetterEffect(claimed.idempotencyKey, EXECUTOR, job.generation, "provider exploded", now);
    return;
  }
  throw new Error(`job has no pending ${kind} effect`);
}

it("does not blame a job for a status card that could not be drawn", () => {
  // The Telegram 400 that killed a real job: the status text had not changed.
  const store = storeFixture();
  const job = workingJob(store, 1_000);
  blockOnDeadEffect(store, job, "render_status", 2_000);

  expect(store.getJob(job.id)?.state).not.toBe("blocked");
});

it("blocks the job when an effect that carries the pipeline dies", () => {
  const store = storeFixture();
  const job = workingJob(store, 1_000);
  blockOnDeadEffect(store, job, "spawn_plan", 2_000);

  const blocked = store.getJob(job.id);
  expect(blocked?.state).toBe("blocked");
  expect(blocked?.blockedReason).toBe("permanent_effect_failure");
});

it("carries a blocked job onward without the owner touching it", () => {
  const store = storeFixture();
  const job = workingJob(store, 1_000);
  blockOnDeadEffect(store, job, "spawn_plan", 2_000);
  expect(store.getJob(job.id)?.state).toBe("blocked");

  const at = { now: 3_000_000 };
  expect(serviceFor(store, at).processDue()).toBe(true);

  // Left its block and went back to the stage it died on, which is exactly
  // what the owner's retry button would have done.
  expect(store.getJob(job.id)?.state).not.toBe("blocked");
  expect(store.getJob(job.id)?.blockedReason).toBeNull();
});

it("stops pushing and tells the owner once the ladder is spent", () => {
  const store = storeFixture();
  const job = workingJob(store, 1_000);
  blockOnDeadEffect(store, job, "spawn_plan", 2_000);

  const told: string[] = [];
  const at = { now: 3_000_000 };
  const service = new JobContinuationService({
    store: {
      ...store,
      listContinuationCandidates: (limit: number) => store.listContinuationCandidates(limit),
      recordAutoContinue: (input: { jobId: string; key: string; now: number }) =>
        store.recordAutoContinue(input),
      recordContinuationEscalation: (input: { jobId: string; now: number }) =>
        store.recordContinuationEscalation(input),
      retryFailedJob: (id: string, version: number, now: number) => store.retryFailedJob(id, version, now),
      requeueReviewAdmission: (id: string, version: number, now: number) =>
        store.requeueReviewAdmission(id, version, now),
      listEnabledProjectPolicies: () => store.listEnabledProjectPolicies(),
      getOwner: () => ({ userId: "7", chatId: "70" }),
      getControllerForOwner: () => ({ controllerKey: "controller_1" }),
      enqueueControllerTurn: (input: { inputText: string }) => { told.push(input.inputText); },
    } as unknown as TelegramAgentStore,
    clock: { now: () => at.now },
    issueUpdateId: (now) => 2_000_000_000 + now,
  });

  for (let push = 0; push < MAX_AUTO_CONTINUES; push += 1) {
    at.now += 10 * 60_000;
    service.processDue();
    // Put it back where it was, as a job that keeps hitting the same wall does.
    blockOnDeadEffect(store, job, "spawn_plan", at.now + 1);
  }
  expect(told).toHaveLength(0);
  expect(store.listContinuationCandidates(10)[0]?.attempts).toBe(MAX_AUTO_CONTINUES);

  at.now += 10 * 60_000;
  service.processDue();

  expect(told).toHaveLength(1);
  expect(told[0]).toContain("cannot get it moving on my own");
  // Handed over, so it is never re-decided and never told twice.
  expect(store.listContinuationCandidates(10)).toHaveLength(0);
  at.now += 10 * 60_000;
  service.processDue();
  expect(told).toHaveLength(1);
});

it("hands over a job the guarded retry will never accept, rather than re-deciding it forever", () => {
  // Without counting a refused resume the sweep would try, be turned away, and
  // try again every five minutes for as long as the job existed, and the owner
  // would never learn it was stuck.
  const store = storeFixture();
  const job = workingJob(store, 1_000);
  blockOnDeadEffect(store, job, "spawn_plan", 2_000);

  const told: string[] = [];
  const at = { now: 3_000_000 };
  const service = new JobContinuationService({
    store: {
      ...store,
      listContinuationCandidates: (limit: number) => store.listContinuationCandidates(limit),
      recordAutoContinue: (input: { jobId: string; key: string; now: number }) =>
        store.recordAutoContinue(input),
      recordContinuationEscalation: (input: { jobId: string; now: number }) =>
        store.recordContinuationEscalation(input),
      retryFailedJob: () => ({ outcome: "unavailable" }),
      requeueReviewAdmission: () => ({ outcome: "unavailable" }),
      listEnabledProjectPolicies: () => store.listEnabledProjectPolicies(),
      getOwner: () => ({ userId: "7", chatId: "70" }),
      getControllerForOwner: () => ({ controllerKey: "controller_1" }),
      enqueueControllerTurn: (input: { inputText: string }) => { told.push(input.inputText); },
    } as unknown as TelegramAgentStore,
    clock: { now: () => at.now },
    issueUpdateId: (now) => 2_000_000_000 + now,
  });

  for (let sweep = 0; sweep <= MAX_AUTO_CONTINUES; sweep += 1) {
    at.now += 10 * 60_000;
    service.processDue();
  }
  expect(told).toHaveLength(1);
  expect(store.listContinuationCandidates(10)).toHaveLength(0);
});

it("paces itself instead of sweeping on every executor tick", () => {
  const store = storeFixture();
  const job = workingJob(store, 1_000);
  blockOnDeadEffect(store, job, "spawn_plan", 2_000);

  const at = { now: 3_000_000 };
  const service = serviceFor(store, at);
  expect(service.processDue()).toBe(true);
  at.now += 1_000;
  expect(service.processDue()).toBe(false);
});
