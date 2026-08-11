import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { expect, it } from "vitest";
import { AutonomyScheduler } from "../src/autonomy/scheduler";
import { JobLaneRunner } from "../src/services/job-lane-runner";
import { AutonomyRepository } from "../src/storage/autonomy-repository";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { policyFixture } from "./helpers";

type Deferred = Readonly<{ promise: Promise<void>; resolve(): void }>;

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

let fixtureNumber = 0;
function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-autonomy-integration-${fixtureNumber++}` });
  const db = bb.storage.database();
  return {
    db,
    store: openStore(bb.storage),
    repository: new AutonomyRepository(db),
  };
}

function queueProjectJob(
  store: TelegramAgentStore,
  input: { id: string; sourceUpdateId: number; projectId: string; now: number },
): void {
  const policy = policyFixture({
    projectId: input.projectId,
    alias: input.projectId.replace("proj_", "project-").replaceAll("_", "-"),
    githubRepository: `acme/${input.projectId}`,
    production: undefined,
  });
  const draft = store.createJob({
    id: input.id,
    sourceUpdateId: input.sourceUpdateId,
    requestText: `work ${input.id}`,
    now: input.now,
  });
  store.selectProjectAndQueueAdmission({
    jobId: draft.id,
    expectedVersion: draft.version,
    projectId: input.projectId,
    policyVersion: 1,
    policy,
    now: input.now,
  });
}

function releaseAtBoundary(
  db: Database.Database,
  repository: AutonomyRepository,
  jobId: string,
  now: number,
): void {
  // This integration-only hook models the executor's durable terminal cleanup
  // boundary without bypassing the repository's admission transition methods.
  const release = db.transaction(() => {
    db.prepare("UPDATE jobs SET state = 'cancelled', version = version + 1, updated_at = ? WHERE id = ?")
      .run(now, jobId);
    repository.markDrainingInTransaction(jobId, now);
    db.prepare(
      `UPDATE effects SET status = 'done', lease_owner = NULL, lease_generation = NULL,
       lease_expires_at = NULL, updated_at = ? WHERE job_id = ? AND status <> 'done'`,
    ).run(now, jobId);
    db.prepare(
      `UPDATE job_resource_claims SET state = 'released', lease_expires_at = 0,
       released_at = ?, release_reason = 'integration_release'
       WHERE job_id = ? AND state = 'held'`,
    ).run(now, jobId);
    repository.releaseInTransaction(jobId, now, "integration_release");
  });
  release.immediate();
}

it("runs two independent fake operations before admitting the third after release", async () => {
  const { db, store, repository } = fixture();
  queueProjectJob(store, { id: "integration-a", sourceUpdateId: 1, projectId: "proj_a", now: 100 });
  queueProjectJob(store, { id: "integration-b", sourceUpdateId: 2, projectId: "proj_b", now: 101 });
  queueProjectJob(store, { id: "integration-c", sourceUpdateId: 3, projectId: "proj_c", now: 102 });
  const lease = store.acquireExecutorLease("executor", 200, 60_000);
  if (!lease.acquired) throw new Error("executor lease was not acquired");
  const scheduler = new AutonomyScheduler(repository);

  expect(scheduler.run({
    maxConcurrentJobs: 2,
    ownerId: "executor",
    generation: lease.generation,
    now: 200,
    leaseMs: 60_000,
  }).admissions).toMatchObject([{ outcome: "admitted" }, { outcome: "admitted" }]);
  expect(store.listAdmissions(["admitted"], 10).map((admission) => admission.jobId)).toEqual([
    "integration-a",
    "integration-b",
  ]);
  expect(store.getAdmission("integration-c")?.state).toBe("queued");

  const gates = new Map([
    ["integration-a", deferred()],
    ["integration-b", deferred()],
    ["integration-c", deferred()],
  ]);
  const finished = new Map([
    ["integration-a", deferred()],
    ["integration-b", deferred()],
    ["integration-c", deferred()],
  ]);
  const started: string[] = [];
  const lanes = new JobLaneRunner({ maxPipelineLanes: () => 2, maxControlLanes: 1 });
  const start = (jobId: string) => lanes.tryStart({
    jobId,
    operationKey: `operation:${jobId}`,
    kind: "pipeline",
    run: async () => {
      started.push(jobId);
      await gates.get(jobId)?.promise;
      finished.get(jobId)?.resolve();
    },
  });

  expect(start("integration-a")).toBe(true);
  expect(start("integration-b")).toBe(true);
  expect(start("integration-c")).toBe(false);
  expect(started).toEqual(["integration-a", "integration-b"]);
  expect(lanes.snapshot()).toMatchObject({ pipelineActive: 2, busyJobIds: ["integration-a", "integration-b"] });

  gates.get("integration-a")?.resolve();
  await finished.get("integration-a")?.promise;
  await Promise.resolve();
  releaseAtBoundary(db, repository, "integration-a", 300);
  expect(scheduler.run({
    maxConcurrentJobs: 2,
    ownerId: "executor",
    generation: lease.generation,
    now: 301,
    leaseMs: 60_000,
  }).admissions).toMatchObject([{ outcome: "admitted", job: { id: "integration-c" } }]);
  expect(start("integration-c")).toBe(true);
  expect(lanes.snapshot()).toMatchObject({ pipelineActive: 2, busyJobIds: ["integration-b", "integration-c"] });
  expect(started).toEqual(["integration-a", "integration-b", "integration-c"]);

  gates.get("integration-b")?.resolve();
  gates.get("integration-c")?.resolve();
  await Promise.all([finished.get("integration-b")?.promise, finished.get("integration-c")?.promise]);
});

it("keeps two jobs for one project FIFO even when the global cap has room", () => {
  const { db, store, repository } = fixture();
  queueProjectJob(store, { id: "fifo-old", sourceUpdateId: 1, projectId: "proj_fifo", now: 100 });
  queueProjectJob(store, { id: "fifo-new", sourceUpdateId: 2, projectId: "proj_fifo", now: 101 });
  const lease = store.acquireExecutorLease("executor", 200, 60_000);
  if (!lease.acquired) throw new Error("executor lease was not acquired");
  const scheduler = new AutonomyScheduler(repository);

  expect(scheduler.run({
    maxConcurrentJobs: 2,
    ownerId: "executor",
    generation: lease.generation,
    now: 200,
    leaseMs: 60_000,
  }).admissions).toMatchObject([{ outcome: "admitted", job: { id: "fifo-old" } }]);
  expect(store.getAdmission("fifo-new")?.state).toBe("queued");

  releaseAtBoundary(db, repository, "fifo-old", 300);
  expect(scheduler.run({
    maxConcurrentJobs: 2,
    ownerId: "executor",
    generation: lease.generation,
    now: 301,
    leaseMs: 60_000,
  }).admissions).toMatchObject([{ outcome: "admitted", job: { id: "fifo-new" } }]);
  expect(store.listAdmissions(["released", "admitted"], 10).map((admission) => ({
    jobId: admission.jobId,
    state: admission.state,
    queueSeq: admission.queueSeq,
  }))).toEqual([
    { jobId: "fifo-old", state: "released", queueSeq: 1 },
    { jobId: "fifo-new", state: "admitted", queueSeq: 2 },
  ]);
});
