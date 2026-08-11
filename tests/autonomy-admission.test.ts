import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import {
  AutonomyRepository,
  type AdmissionAttempt,
  type AdmissionAttemptInput,
} from "../src/storage/autonomy-repository";
import type { ProjectPolicy } from "../src/domain/models";
import { AutonomyScheduler } from "../src/autonomy/scheduler";
import { openStore } from "../src/storage/store";
import { projectResourceKey, type MaxConcurrentJobs } from "../src/autonomy/models";
import { policyFixture } from "./helpers";

type SqliteDatabase = Database.Database;
type RaceWorkerResult = {
  outcome: "admitted" | "not_admitted";
  reason?: string;
};
type RaceWorkerInput = Readonly<{
  dbPath: string;
  barrierDir: string;
  jobId: string;
  label: string;
  ownerId: string;
  generation: number;
}>;
type RaceWorkerHandle = Readonly<{
  child: ChildProcess;
  settlement: Promise<RaceWorkerResult>;
}>;
const RACE_BARRIER_TIMEOUT_MS = 3_000;
const RACE_CLEANUP_TIMEOUT_MS = 500;
let fixtureNumber = 0;

function projectPolicy(projectId: string): ProjectPolicy {
  return policyFixture({
    projectId,
    alias: `project-${projectId.slice(5)}`,
  });
}

function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-admission-${fixtureNumber++}` });
  const store = openStore(bb.storage);
  return { db: bb.storage.database(), repo: new AutonomyRepository(bb.storage.database()), store };
}

function seedJob(
  db: SqliteDatabase,
  input: {
    jobId: string;
    sourceUpdateId: number;
    projectId: string;
    state?: "awaiting_confirmation" | "planning" | "blocked";
    cancelRequestedAt?: number | null;
    blockedReason?: string | null;
    version?: number;
  },
): void {
  const policy = projectPolicy(input.projectId);
  db.prepare(
    `INSERT INTO jobs (
       id, source_update_id, request_text, state, project_id, policy_version, policy_json,
       review_cycle, review_block_at, cancel_requested_at, blocked_reason,
       version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, ?, 0, 3, ?, ?, ?, 900, 1_000)`,
  ).run(
    input.jobId,
    input.sourceUpdateId,
    `request ${input.jobId}`,
    input.state ?? "awaiting_confirmation",
    input.projectId,
    JSON.stringify(policy),
    input.cancelRequestedAt ?? null,
    input.blockedReason ?? null,
    input.version ?? 1,
  );
}

function seedAdmission(
  db: SqliteDatabase,
  input: {
    jobId: string;
    projectId: string;
    queueSeq: number;
    state: "queued" | "admitted" | "draining" | "released";
    resumeEvent?: "CONFIRMED" | "CONTINUE_REVIEW";
  },
): void {
  const admittedAt = input.state === "admitted" || input.state === "draining" ? 1_100 : null;
  const drainingAt = input.state === "draining" ? 1_150 : null;
  const releasedAt = input.state === "released" ? 1_200 : null;
  db.prepare(
    `INSERT INTO job_admissions (
       job_id, project_id, queue_seq, state, resume_event, queued_at,
       admitted_at, draining_at, released_at, release_reason
     ) VALUES (?, ?, ?, ?, ?, 1_000, ?, ?, ?, ?)`,
  ).run(
    input.jobId,
    input.projectId,
    input.queueSeq,
    input.state,
    input.resumeEvent ?? "CONFIRMED",
    admittedAt,
    drainingAt,
    releasedAt,
    input.state === "released" ? "test" : null,
  );
  db.prepare("UPDATE autonomy_sequence SET next_queue_seq = MAX(next_queue_seq, ?) WHERE singleton = 1")
    .run(input.queueSeq + 1);
}

function seedProjectClaim(
  db: SqliteDatabase,
  input: { jobId: string; projectId: string; ownerId?: string; generation?: number; state?: "held" | "released" },
): void {
  const state = input.state ?? "held";
  db.prepare(
    `INSERT INTO job_resource_claims (
       job_id, resource_key, resource_kind, state, owner_id, generation,
       lease_expires_at, acquired_at, renewed_at, released_at, release_reason
     ) VALUES (?, ?, 'project', ?, ?, ?, ?, 1_100, 1_100, ?, ?)`,
  ).run(
    input.jobId,
    projectResourceKey(input.projectId),
    state,
    input.ownerId ?? "other-executor",
    input.generation ?? 1,
    state === "held" ? 50_000 : 0,
    state === "released" ? 1_101 : null,
    state === "released" ? "test-release" : null,
  );
}

function seedHeldNonProjectClaim(
  db: SqliteDatabase,
  input: { jobId: string; resourceKey: string; resourceKind: "repository_merge" | "production_target" },
): void {
  db.prepare(
    `INSERT INTO job_resource_claims (
       job_id, resource_key, resource_kind, state, owner_id, generation,
       lease_expires_at, acquired_at, renewed_at, released_at, release_reason
     ) VALUES (?, ?, ?, 'held', 'other-executor', 1, 50_000, 1_100, 1_100, NULL, NULL)`,
  ).run(input.jobId, input.resourceKey, input.resourceKind);
}

function acquireLease(store: ReturnType<typeof fixture>["store"], now = 2_000): number {
  const lease = store.acquireExecutorLease("executor", now, 30_000);
  if (!lease.acquired) throw new Error("executor lease was not acquired");
  return lease.generation;
}

function admit(repo: AutonomyRepository, input: AdmissionAttemptInput): AdmissionAttempt {
  return repo.tryAdmit(input);
}

function scheduler(repo: AutonomyRepository): AutonomyScheduler {
  return new AutonomyScheduler(repo);
}

function waitForBarrier(path: string, timeoutMs = RACE_BARRIER_TIMEOUT_MS): Promise<void> {
  return new Promise((resolveBarrier, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (existsSync(path)) {
        resolveBarrier();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`race barrier timed out: ${path}`));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function raceWorkerArguments(input: RaceWorkerInput): string[] {
  return [
    resolve("tests/autonomy-admission-race-worker.ts"),
    input.dbPath,
    input.barrierDir,
    input.jobId,
    input.label,
    input.ownerId,
    String(input.generation),
  ];
}

function parseRaceWorkerResult(workerStdout: string, workerStderr: string): RaceWorkerResult {
  const line = workerStdout.trim().split("\n").at(-1);
  if (!line) throw new Error(`race worker returned no result: ${workerStderr}`);
  try {
    return JSON.parse(line) as RaceWorkerResult;
  } catch (error) {
    throw new Error(`race worker returned invalid JSON: ${workerStdout}`, { cause: error });
  }
}

function runRaceWorker(input: RaceWorkerInput): RaceWorkerHandle {
  const child = spawn(resolve("node_modules/.bin/vite-node"), raceWorkerArguments(input), {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let workerStdout = "";
  let workerStderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { workerStdout += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { workerStderr += chunk.toString(); });
  const settlement = new Promise<RaceWorkerResult>((resolveWorker, rejectWorker) => {
    child.once("error", rejectWorker);
    child.once("close", (code) => {
      if (code !== 0) {
        rejectWorker(new Error(`race worker exited ${code}: ${workerStderr || workerStdout}`));
        return;
      }
      try {
        resolveWorker(parseRaceWorkerResult(workerStdout, workerStderr));
      } catch (error) {
        rejectWorker(error);
      }
    });
  });
  void settlement.catch(() => undefined);
  return { child, settlement };
}

function raceWorkerIsRunning(worker: RaceWorkerHandle): boolean {
  return worker.child.exitCode === null && worker.child.signalCode === null;
}

function stopRaceWorker(worker: RaceWorkerHandle, timeoutMs = RACE_CLEANUP_TIMEOUT_MS): Promise<void> {
  if (!raceWorkerIsRunning(worker)) return Promise.resolve();
  return new Promise((resolveStop) => {
    let stopped = false;
    let killTimer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(killTimer);
      resolveStop();
    };
    killTimer = setTimeout(() => {
      if (raceWorkerIsRunning(worker)) worker.child.kill("SIGKILL");
      finish();
    }, timeoutMs);
    worker.child.once("close", finish);
    worker.child.kill("SIGTERM");
  });
}

function awaitRaceWorkerSettlement(worker: RaceWorkerHandle, timeoutMs = RACE_CLEANUP_TIMEOUT_MS): Promise<void> {
  return new Promise((resolveSettlement) => {
    const timeout = setTimeout(resolveSettlement, timeoutMs);
    worker.settlement.then(
      () => {
        clearTimeout(timeout);
        resolveSettlement();
      },
      () => {
        clearTimeout(timeout);
        resolveSettlement();
      },
    );
  });
}

function awaitRaceWorkerResult(worker: RaceWorkerHandle, timeoutMs = RACE_BARRIER_TIMEOUT_MS): Promise<RaceWorkerResult> {
  return new Promise((resolveResult, rejectResult) => {
    const timeout = setTimeout(() => rejectResult(new Error("race worker result timed out")), timeoutMs);
    worker.settlement.then(
      (workerResult) => {
        clearTimeout(timeout);
        resolveResult(workerResult);
      },
      (workerError) => {
        clearTimeout(timeout);
        rejectResult(workerError);
      },
    );
  });
}

async function cleanupRaceWorkers(barrierDir: string, workers: readonly RaceWorkerHandle[]): Promise<void> {
  if (existsSync(barrierDir)) writeFileSync(join(barrierDir, "release"), "release");
  await Promise.all(workers.map((worker) => stopRaceWorker(worker)));
  await Promise.all(workers.map((worker) => awaitRaceWorkerSettlement(worker)));
  if (existsSync(barrierDir)) rmSync(barrierDir, { recursive: true, force: true });
}

it("admits exactly the first two projects when the cap is two", () => {
  const { db, repo, store } = fixture();
  for (let index = 1; index <= 3; index += 1) {
    seedJob(db, { jobId: `job_${index}`, sourceUpdateId: index, projectId: `proj_${index}` });
    seedAdmission(db, { jobId: `job_${index}`, projectId: `proj_${index}`, queueSeq: index, state: "queued" });
  }
  const generation = acquireLease(store);

  const run = scheduler(repo).run({
    maxConcurrentJobs: 2,
    ownerId: "executor",
    generation,
    now: 2_000,
    leaseMs: 30_000,
  });

  expect(run.admissions.filter((entry) => entry.outcome === "admitted")).toHaveLength(2);
  expect(repo.listAdmissions(["admitted"], 10).map((entry) => entry.jobId)).toEqual(["job_1", "job_2"]);
  expect(repo.getAdmission("job_3")?.state).toBe("queued");
  expect(store.getJob("job_1")?.state).toBe("planning");
  expect(store.listEffectsForJob("job_1").map((effect) => effect.kind)).toEqual(["spawn_plan"]);
});

it("keeps same-project FIFO and admits only its oldest row", () => {
  const { db, repo, store } = fixture();
  seedJob(db, { jobId: "job_old", sourceUpdateId: 1, projectId: "proj_1" });
  seedJob(db, { jobId: "job_new", sourceUpdateId: 2, projectId: "proj_1" });
  seedAdmission(db, { jobId: "job_old", projectId: "proj_1", queueSeq: 1, state: "queued" });
  seedAdmission(db, { jobId: "job_new", projectId: "proj_1", queueSeq: 2, state: "queued" });
  const generation = acquireLease(store);

  scheduler(repo).run({
    maxConcurrentJobs: 2,
    ownerId: "executor",
    generation,
    now: 2_000,
    leaseMs: 30_000,
  });

  expect(repo.getAdmission("job_old")?.state).toBe("admitted");
  expect(repo.getAdmission("job_new")?.state).toBe("queued");
});

it("skips a busy oldest project and admits the next free project", () => {
  const { db, repo, store } = fixture();
  seedJob(db, { jobId: "busy_holder", sourceUpdateId: 4, projectId: "proj_busy", state: "planning" });
  seedJob(db, { jobId: "job_busy", sourceUpdateId: 1, projectId: "proj_busy" });
  seedJob(db, { jobId: "job_free", sourceUpdateId: 2, projectId: "proj_free" });
  seedAdmission(db, { jobId: "busy_holder", projectId: "proj_busy", queueSeq: 1, state: "admitted" });
  seedAdmission(db, { jobId: "job_busy", projectId: "proj_busy", queueSeq: 2, state: "queued" });
  seedAdmission(db, { jobId: "job_free", projectId: "proj_free", queueSeq: 3, state: "queued" });
  seedProjectClaim(db, { jobId: "busy_holder", projectId: "proj_busy" });
  const generation = acquireLease(store);

  scheduler(repo).run({
    maxConcurrentJobs: 2,
    ownerId: "executor",
    generation,
    now: 2_000,
    leaseMs: 30_000,
  });

  expect(repo.getAdmission("job_busy")?.state).toBe("queued");
  expect(repo.getAdmission("job_free")?.state).toBe("admitted");
});

it("ignores released project-claim history when selecting an eligible project", () => {
  const { db, repo, store } = fixture();
  seedJob(db, { jobId: "job_released_claim", sourceUpdateId: 1, projectId: "proj_released" });
  seedAdmission(db, { jobId: "job_released_claim", projectId: "proj_released", queueSeq: 1, state: "queued" });
  seedProjectClaim(db, { jobId: "job_released_claim", projectId: "proj_released", state: "released" });
  const generation = acquireLease(store);

  const run = scheduler(repo).run({
    maxConcurrentJobs: 1,
    ownerId: "executor",
    generation,
    now: 2_000,
    leaseMs: 30_000,
  });

  expect(run.admissions).toMatchObject([{ outcome: "admitted" }]);
  expect(repo.getAdmission("job_released_claim")?.state).toBe("admitted");
  expect(repo.listHeldClaims("job_released_claim", 10)).toHaveLength(2);
  expect(repo.listHeldClaims("job_released_claim", 10).filter((claim) => claim.state === "held")).toHaveLength(1);
});

it("skips a busy project when released claim history exceeds the held-query bound", () => {
  const { db, repo, store } = fixture();
  for (let index = 1; index <= 3; index += 1) {
    seedJob(db, { jobId: `job_claim_history_${index}`, sourceUpdateId: 100 + index, projectId: `proj_history-${index}` });
    seedProjectClaim(db, { jobId: `job_claim_history_${index}`, projectId: `proj_history-${index}`, state: "released" });
  }
  seedJob(db, { jobId: "job_occupied", sourceUpdateId: 200, projectId: "proj_occupied", state: "planning" });
  seedAdmission(db, { jobId: "job_occupied", projectId: "proj_occupied", queueSeq: 1, state: "admitted" });
  seedProjectClaim(db, { jobId: "job_occupied", projectId: "proj_occupied" });
  seedJob(db, { jobId: "job_busy_late", sourceUpdateId: 201, projectId: "proj_busy-late" });
  seedAdmission(db, { jobId: "job_busy_late", projectId: "proj_busy-late", queueSeq: 2, state: "queued" });
  seedProjectClaim(db, { jobId: "job_busy_late", projectId: "proj_busy-late" });
  seedJob(db, { jobId: "job_free_after_history", sourceUpdateId: 202, projectId: "proj_free-next" });
  seedAdmission(db, { jobId: "job_free_after_history", projectId: "proj_free-next", queueSeq: 3, state: "queued" });
  const generation = acquireLease(store);

  const run = scheduler(repo).run({
    maxConcurrentJobs: 2,
    ownerId: "executor",
    generation,
    now: 2_000,
    leaseMs: 30_000,
  });

  expect(run.admissions).toMatchObject([{ outcome: "admitted", job: { id: "job_free_after_history" } }]);
  expect(repo.getAdmission("job_busy_late")?.state).toBe("queued");
  expect(repo.getAdmission("job_free_after_history")?.state).toBe("admitted");
});

it("skips a busy project when held non-project claims consume the scheduler bound", () => {
  const { db, repo, store } = fixture();
  seedJob(db, { jobId: "job_merge_claim", sourceUpdateId: 101, projectId: "proj_merge" });
  seedJob(db, { jobId: "job_production_claim", sourceUpdateId: 102, projectId: "proj_production" });
  seedHeldNonProjectClaim(db, {
    jobId: "job_merge_claim",
    resourceKey: "repository:shared:merge",
    resourceKind: "repository_merge",
  });
  seedHeldNonProjectClaim(db, {
    jobId: "job_production_claim",
    resourceKey: "production:shared-target",
    resourceKind: "production_target",
  });
  seedJob(db, { jobId: "job_occupied_kind_bound", sourceUpdateId: 103, projectId: "proj_occupied-kind", state: "planning" });
  seedAdmission(db, { jobId: "job_occupied_kind_bound", projectId: "proj_occupied-kind", queueSeq: 1, state: "admitted" });
  seedProjectClaim(db, { jobId: "job_occupied_kind_bound", projectId: "proj_occupied-kind" });
  seedJob(db, { jobId: "job_busy_kind_bound", sourceUpdateId: 104, projectId: "proj_busy-kind" });
  seedAdmission(db, { jobId: "job_busy_kind_bound", projectId: "proj_busy-kind", queueSeq: 2, state: "queued" });
  seedProjectClaim(db, { jobId: "job_busy_kind_bound", projectId: "proj_busy-kind" });
  seedJob(db, { jobId: "job_free_after_kind_bound", sourceUpdateId: 105, projectId: "proj_free-kind" });
  seedAdmission(db, { jobId: "job_free_after_kind_bound", projectId: "proj_free-kind", queueSeq: 3, state: "queued" });
  const generation = acquireLease(store);

  const run = scheduler(repo).run({
    maxConcurrentJobs: 2,
    ownerId: "executor",
    generation,
    now: 2_000,
    leaseMs: 30_000,
  });

  expect(run.admissions).toMatchObject([{ outcome: "admitted", job: { id: "job_free_after_kind_bound" } }]);
  expect(repo.getAdmission("job_busy_kind_bound")?.state).toBe("queued");
  expect(repo.getAdmission("job_free_after_kind_bound")?.state).toBe("admitted");
});

it.each([1, 2, 3, 4, 5, 6, 7, 8])("admits the requested validated cap %s", (maxConcurrentJobs) => {
  const { db, repo, store } = fixture();
  for (let index = 1; index <= maxConcurrentJobs; index += 1) {
    seedJob(db, { jobId: `job_${index}`, sourceUpdateId: index, projectId: `proj_${index}` });
    seedAdmission(db, { jobId: `job_${index}`, projectId: `proj_${index}`, queueSeq: index, state: "queued" });
  }
  const generation = acquireLease(store);

  const run = scheduler(repo).run({
    maxConcurrentJobs: maxConcurrentJobs as MaxConcurrentJobs,
    ownerId: "executor",
    generation,
    now: 2_000,
    leaseMs: 30_000,
  });

  expect(run.admissions.filter((entry) => entry.outcome === "admitted")).toHaveLength(maxConcurrentJobs);
});

it("does not preempt occupied work when a lowered cap is below occupancy", () => {
  const { db, repo, store } = fixture();
  for (let index = 1; index <= 2; index += 1) {
    seedJob(db, { jobId: `job_occupied_${index}`, sourceUpdateId: index, projectId: `proj_${index}`, state: "planning" });
    seedAdmission(db, {
      jobId: `job_occupied_${index}`,
      projectId: `proj_${index}`,
      queueSeq: index,
      state: index === 2 ? "draining" : "admitted",
    });
    seedProjectClaim(db, { jobId: `job_occupied_${index}`, projectId: `proj_${index}` });
  }
  seedJob(db, { jobId: "job_waiting", sourceUpdateId: 3, projectId: "proj_3" });
  seedAdmission(db, { jobId: "job_waiting", projectId: "proj_3", queueSeq: 3, state: "queued" });
  const generation = acquireLease(store);

  const run = scheduler(repo).run({
    maxConcurrentJobs: 1,
    ownerId: "executor",
    generation,
    now: 2_000,
    leaseMs: 30_000,
  });

  expect(run.admissions).toEqual([]);
  expect(repo.listOccupiedAdmissions(10).map((entry) => entry.jobId)).toEqual([
    "job_occupied_1",
    "job_occupied_2",
  ]);
  expect(repo.getAdmission("job_waiting")?.state).toBe("queued");
});

it("loses the second winner in an overlapping two-process admission race without SQLite errors", async () => {
  const { db, repo, store } = fixture();
  seedJob(db, { jobId: "job_race", sourceUpdateId: 1, projectId: "proj_1" });
  seedAdmission(db, { jobId: "job_race", projectId: "proj_1", queueSeq: 1, state: "queued" });
  const generation = acquireLease(store);
  expect(db.name).not.toBe(":memory:");
  const barrierDir = mkdtempSync(join(tmpdir(), "telegram-admission-race-"));
  db.prepare(
    `CREATE TRIGGER task4_race_pause
       AFTER INSERT ON job_resource_claims
       WHEN NEW.job_id = 'job_race'
       BEGIN
         SELECT task4_race_pause();
       END`,
  ).run();

  const raceWorkers: RaceWorkerHandle[] = [];
  try {
    const firstWorker = runRaceWorker({
      dbPath: db.name,
      barrierDir,
      jobId: "job_race",
      label: "race-a",
      ownerId: "executor",
      generation,
    });
    raceWorkers.push(firstWorker);
    await waitForBarrier(join(barrierDir, "ready-race-a"));
    writeFileSync(join(barrierDir, "go-race-a"), "go");
    await waitForBarrier(join(barrierDir, "claim-started"));

    const secondWorker = runRaceWorker({
      dbPath: db.name,
      barrierDir,
      jobId: "job_race",
      label: "race-b",
      ownerId: "executor",
      generation,
    });
    raceWorkers.push(secondWorker);
    await waitForBarrier(join(barrierDir, "ready-race-b"));
    writeFileSync(join(barrierDir, "go-race-b"), "go");
    await waitForBarrier(join(barrierDir, "attempting-race-b"));
    let secondOutcome: RaceWorkerResult | null = null;
    let secondFailure: unknown = null;
    try {
      secondOutcome = await awaitRaceWorkerResult(secondWorker);
    } catch (error) {
      secondFailure = error;
    }
    writeFileSync(join(barrierDir, "release"), "release");
    const firstOutcome = await awaitRaceWorkerResult(firstWorker);
    if (secondFailure) throw secondFailure;
    if (!secondOutcome) throw new Error("race worker returned no second result");
    const outcomes = [firstOutcome, secondOutcome];

    expect(outcomes.filter((entry) => entry.outcome === "admitted")).toHaveLength(1);
    expect(outcomes.filter((entry) => entry.outcome === "not_admitted")).toHaveLength(1);
    expect(outcomes.find((entry) => entry.outcome === "not_admitted")?.reason).toBe("claim_conflict");
  } finally {
    await cleanupRaceWorkers(barrierDir, raceWorkers);
  }

  expect(repo.listHeldClaims("job_race", 10)).toHaveLength(1);
  expect(repo.getAdmission("job_race")?.state).toBe("admitted");
  expect(store.listEffectsForJob("job_race").map((effect) => effect.kind)).toEqual(["spawn_plan"]);
});

it("cleans up race workers after a pre-release barrier failure", async () => {
  const { db, store } = fixture();
  seedJob(db, { jobId: "job_race_cleanup", sourceUpdateId: 1, projectId: "proj_1" });
  seedAdmission(db, { jobId: "job_race_cleanup", projectId: "proj_1", queueSeq: 1, state: "queued" });
  const generation = acquireLease(store);
  const barrierDir = mkdtempSync(join(tmpdir(), "telegram-admission-race-cleanup-"));
  db.prepare(
    `CREATE TRIGGER task4_race_cleanup_pause
       AFTER INSERT ON job_resource_claims
       WHEN NEW.job_id = 'job_race_cleanup'
       BEGIN
         SELECT task4_race_pause();
       END`,
  ).run();
  const raceWorkers: RaceWorkerHandle[] = [];
  let injectedFailure: unknown = null;

  try {
    const firstWorker = runRaceWorker({
      dbPath: db.name,
      barrierDir,
      jobId: "job_race_cleanup",
      label: "cleanup-a",
      ownerId: "executor",
      generation,
    });
    raceWorkers.push(firstWorker);
    await waitForBarrier(join(barrierDir, "ready-cleanup-a"));
    await Promise.reject(new Error("task4 injected pre-release barrier failure"));
  } catch (error) {
    injectedFailure = error;
  } finally {
    await cleanupRaceWorkers(barrierDir, raceWorkers);
  }

  try {
    expect(injectedFailure).toMatchObject({ message: "task4 injected pre-release barrier failure" });
    expect(raceWorkers).toHaveLength(1);
    expect(raceWorkerIsRunning(raceWorkers[0]!)).toBe(false);
    expect(existsSync(barrierDir)).toBe(false);
  } finally {
    const remainingWorker = raceWorkers[0];
    if (remainingWorker && raceWorkerIsRunning(remainingWorker)) {
      remainingWorker.child.kill("SIGKILL");
      await awaitRaceWorkerSettlement(remainingWorker);
    }
  }
});

it("rejects a stale executor generation without changing durable rows", () => {
  const { db, repo, store } = fixture();
  seedJob(db, { jobId: "job_stale", sourceUpdateId: 1, projectId: "proj_1" });
  seedAdmission(db, { jobId: "job_stale", projectId: "proj_1", queueSeq: 1, state: "queued" });
  const oldLease = store.acquireExecutorLease("old-executor", 2_000, 1);
  if (!oldLease.acquired) throw new Error("old executor lease was not acquired");
  const freshLease = store.acquireExecutorLease("fresh-executor", 2_002, 30_000);
  if (!freshLease.acquired) throw new Error("fresh executor lease was not acquired");

  const attempt = admit(repo, {
    jobId: "job_stale",
    maxConcurrentJobs: 1,
    ownerId: "old-executor",
    generation: oldLease.generation,
    now: 2_002,
    leaseMs: 30_000,
  });

  expect(attempt.outcome).toBe("not_admitted");
  expect(repo.getAdmission("job_stale")?.state).toBe("queued");
  expect(repo.listHeldClaims("job_stale", 10)).toEqual([]);
  expect(store.listEffectsForJob("job_stale")).toEqual([]);
});

it("applies CONFIRMED and spawn_plan with admission and claim atomically", () => {
  const { db, repo, store } = fixture();
  seedJob(db, { jobId: "job_atomic", sourceUpdateId: 1, projectId: "proj_1" });
  seedAdmission(db, { jobId: "job_atomic", projectId: "proj_1", queueSeq: 1, state: "queued" });
  const generation = acquireLease(store);

  const attempt = admit(repo, {
    jobId: "job_atomic",
    maxConcurrentJobs: 1,
    ownerId: "executor",
    generation,
    now: 2_000,
    leaseMs: 30_000,
  });

  expect(attempt.outcome).toBe("admitted");
  expect(store.getJob("job_atomic")?.state).toBe("planning");
  expect(repo.getAdmission("job_atomic")).toMatchObject({ state: "admitted", admittedAt: 2_000 });
  expect(repo.listHeldClaims("job_atomic", 10)).toMatchObject([{
    resourceKey: "project:proj_1:pipeline",
    ownerId: "executor",
    generation,
    leaseExpiresAt: 32_000,
  }]);
  expect(store.listEffectsForJob("job_atomic").map((effect) => effect.kind)).toEqual(["spawn_plan"]);
});

it("refuses cancellation before claiming or applying the queued event", () => {
  const { db, repo, store } = fixture();
  seedJob(db, { jobId: "job_cancelled", sourceUpdateId: 1, projectId: "proj_1", cancelRequestedAt: 1_900 });
  seedAdmission(db, { jobId: "job_cancelled", projectId: "proj_1", queueSeq: 1, state: "queued" });
  const generation = acquireLease(store);

  const attempt = admit(repo, {
    jobId: "job_cancelled",
    maxConcurrentJobs: 1,
    ownerId: "executor",
    generation,
    now: 2_000,
    leaseMs: 30_000,
  });

  expect(attempt.outcome).toBe("not_admitted");
  expect(repo.getAdmission("job_cancelled")?.state).toBe("queued");
  expect(repo.listHeldClaims("job_cancelled", 10)).toEqual([]);
  expect(store.getJob("job_cancelled")?.state).toBe("awaiting_confirmation");
  expect(store.listEffectsForJob("job_cancelled")).toEqual([]);
});

it("rolls back claim and admission writes when effect persistence is aborted", () => {
  const { db, repo, store } = fixture();
  seedJob(db, { jobId: "job_rollback", sourceUpdateId: 1, projectId: "proj_1" });
  seedAdmission(db, { jobId: "job_rollback", projectId: "proj_1", queueSeq: 1, state: "queued" });
  db.prepare(
    `CREATE TRIGGER task4_fail_admission_effect
       BEFORE INSERT ON effects
       WHEN NEW.job_id = 'job_rollback'
       BEGIN
         SELECT RAISE(ABORT, 'task4 injected effect failure');
       END`,
  ).run();
  const generation = acquireLease(store);
  const beforeJob = store.getJob("job_rollback");
  const beforeAdmission = repo.getAdmission("job_rollback");

  expect(() => admit(repo, {
    jobId: "job_rollback",
    maxConcurrentJobs: 1,
    ownerId: "executor",
    generation,
    now: 2_000,
    leaseMs: 30_000,
  })).toThrow(/task4 injected effect failure/i);

  expect(store.getJob("job_rollback")).toEqual(beforeJob);
  expect(repo.getAdmission("job_rollback")).toEqual(beforeAdmission);
  expect(repo.listHeldClaims("job_rollback", 10)).toEqual([]);
  expect(store.listEffectsForJob("job_rollback")).toEqual([]);
});

it("propagates a primary-key claim integrity failure without mutation", () => {
  const { db, repo, store } = fixture();
  seedJob(db, { jobId: "job_primary_key_failure", sourceUpdateId: 1, projectId: "proj_1" });
  seedAdmission(db, { jobId: "job_primary_key_failure", projectId: "proj_1", queueSeq: 1, state: "queued" });
  db.prepare(
    `CREATE TRIGGER task4_primary_key_claim_failure
       AFTER INSERT ON job_resource_claims
       WHEN NEW.job_id = 'job_primary_key_failure'
       BEGIN
         INSERT INTO job_resource_claims (
           claim_id, job_id, resource_key, resource_kind, state, owner_id,
           generation, lease_expires_at, acquired_at, renewed_at, released_at, release_reason
         ) VALUES (
           NEW.claim_id, NEW.job_id, NEW.resource_key || ':integrity', 'project', 'held',
           'injected', 0, 0, 0, 0, NULL, NULL
         );
       END`,
  ).run();
  const generation = acquireLease(store);
  const beforeJob = store.getJob("job_primary_key_failure");
  const beforeAdmission = repo.getAdmission("job_primary_key_failure");
  let thrown: unknown;

  try {
    admit(repo, {
      jobId: "job_primary_key_failure",
      maxConcurrentJobs: 1,
      ownerId: "executor",
      generation,
      now: 2_000,
      leaseMs: 30_000,
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toMatchObject({ code: "SQLITE_CONSTRAINT_PRIMARYKEY" });
  expect(store.getJob("job_primary_key_failure")).toEqual(beforeJob);
  expect(repo.getAdmission("job_primary_key_failure")).toEqual(beforeAdmission);
  expect(repo.listHeldClaims("job_primary_key_failure", 10)).toEqual([]);
  expect(store.listEffectsForJob("job_primary_key_failure")).toEqual([]);
});
