import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { expect, it } from "vitest";
import {
  productionResourceKey,
  projectResourceKey,
  repositoryMergeResourceKey,
} from "../src/autonomy/models";
import { JobLaneRunner } from "../src/services/job-lane-runner";
import {
  fileBackedAutonomyHarness,
  policyFixture,
  productionPolicyFixture,
} from "./helpers";

type SqliteDatabase = Database.Database;

function seedSelectedJob(
  db: SqliteDatabase,
  input: { id: string; sourceUpdateId: number; projectId: string; repository?: string },
): void {
  const policy = policyFixture({
    projectId: input.projectId,
    alias: input.projectId.replace("proj_", "project-"),
    githubRepository: input.repository ?? `acme/${input.projectId}`,
  });
  db.prepare(
    `INSERT INTO jobs (
       id, source_update_id, request_text, state, project_id, policy_version,
       policy_json, version, created_at, updated_at
     ) VALUES (?, ?, ?, 'awaiting_confirmation', ?, 1, ?, 1, 100, 100)`,
  ).run(input.id, input.sourceUpdateId, `request ${input.id}`, input.projectId, JSON.stringify(policy));
}

function queueJob(
  repository: ReturnType<typeof fileBackedAutonomyHarness>["primaryRepository"],
  jobId: string,
  projectId: string,
  now: number,
): void {
  repository.queueAdmission({
    jobId,
    expectedVersion: 1,
    projectId,
    resumeEvent: "CONFIRMED",
    now,
  });
}

function setExecutor(db: SqliteDatabase, ownerId: string, generation: number, now: number, leaseMs: number): void {
  db.prepare(
    `UPDATE executor_lease
        SET owner_id = ?, generation = ?, heartbeat_at = ?, lease_expires_at = ?
      WHERE singleton = 1`,
  ).run(ownerId, generation, now, now + leaseMs);
}

function insertHeldClaim(
  db: SqliteDatabase,
  input: {
    jobId: string;
    key: string;
    kind: "repository_merge" | "production_target";
    ownerId?: string;
    generation?: number;
    expiresAt?: number;
  },
): void {
  db.prepare(
    `INSERT INTO job_resource_claims (
       job_id, resource_key, resource_kind, state, owner_id, generation,
       lease_expires_at, acquired_at, renewed_at
     ) VALUES (?, ?, ?, 'held', ?, ?, ?, 100, 100)`,
  ).run(
    input.jobId,
    input.key,
    input.kind,
    input.ownerId ?? "executor-old",
    input.generation ?? 1,
    input.expiresAt ?? 1_000,
  );
}

it("gives one queued identity one winner across WAL connections and executor generations", () => {
  const harness = fileBackedAutonomyHarness();
  const directory = harness.directory;
  try {
    seedSelectedJob(harness.primary, { id: "race-job", sourceUpdateId: 1, projectId: "proj_race" });
    queueJob(harness.primaryRepository, "race-job", "proj_race", 100);
    setExecutor(harness.primary, "executor-current", 2, 200, 1_000);

    expect(harness.primaryRepository.tryAdmit({
      jobId: "race-job",
      maxConcurrentJobs: 2,
      ownerId: "executor-old",
      generation: 1,
      now: 200,
      leaseMs: 1_000,
    })).toMatchObject({ outcome: "not_admitted", reason: "executor_lease_lost" });
    expect(harness.secondaryRepository.tryAdmit({
      jobId: "race-job",
      maxConcurrentJobs: 2,
      ownerId: "executor-current",
      generation: 2,
      now: 200,
      leaseMs: 1_000,
    })).toMatchObject({ outcome: "admitted" });
    expect(harness.primaryRepository.tryAdmit({
      jobId: "race-job",
      maxConcurrentJobs: 2,
      ownerId: "executor-current",
      generation: 2,
      now: 201,
      leaseMs: 1_000,
    })).toMatchObject({ outcome: "not_admitted", reason: "admission_missing" });
    expect(harness.primaryRepository.listOccupiedAdmissions(10)).toHaveLength(1);
    expect(harness.secondaryRepository.listCurrentHeldClaims("race-job", 10)).toMatchObject([{
      resourceKey: projectResourceKey("proj_race"),
      ownerId: "executor-current",
      generation: 2,
    }]);
  } finally {
    harness.close();
  }
  expect(existsSync(directory)).toBe(false);
});

it("serializes one project while distinct projects fill the configured cap", () => {
  const harness = fileBackedAutonomyHarness();
  try {
    seedSelectedJob(harness.primary, { id: "same-a", sourceUpdateId: 1, projectId: "proj_same" });
    seedSelectedJob(harness.primary, { id: "same-b", sourceUpdateId: 2, projectId: "proj_same" });
    seedSelectedJob(harness.primary, { id: "free-c", sourceUpdateId: 3, projectId: "proj_free" });
    queueJob(harness.primaryRepository, "same-a", "proj_same", 100);
    queueJob(harness.primaryRepository, "same-b", "proj_same", 101);
    queueJob(harness.primaryRepository, "free-c", "proj_free", 102);
    setExecutor(harness.primary, "executor", 1, 200, 1_000);
    const attempt = (jobId: string) => harness.secondaryRepository.tryAdmit({
      jobId,
      maxConcurrentJobs: 2,
      ownerId: "executor",
      generation: 1,
      now: 200,
      leaseMs: 1_000,
    });

    expect(attempt("same-a")).toMatchObject({ outcome: "admitted" });
    expect(attempt("same-b")).toMatchObject({ outcome: "not_admitted", reason: "project_busy" });
    expect(attempt("free-c")).toMatchObject({ outcome: "admitted" });
    expect(harness.primaryRepository.listOccupiedAdmissions(10).map((row) => row.jobId)).toEqual([
      "same-a",
      "free-c",
    ]);
    expect(harness.primaryRepository.listCurrentHeldProjectClaims(10).map((claim) => claim.resourceKey).sort()).toEqual([
      projectResourceKey("proj_free"),
      projectResourceKey("proj_same"),
    ]);
  } finally {
    harness.close();
  }
});

it("keeps normalized repository and production ownership exclusive even after lease expiry", () => {
  const harness = fileBackedAutonomyHarness();
  try {
    seedSelectedJob(harness.primary, { id: "resource-a", sourceUpdateId: 1, projectId: "proj_a" });
    seedSelectedJob(harness.primary, { id: "resource-b", sourceUpdateId: 2, projectId: "proj_b" });
    const repositoryKey = repositoryMergeResourceKey("Acme/Shared");
    expect(repositoryKey).toBe(repositoryMergeResourceKey("acme/shared"));
    insertHeldClaim(harness.primary, {
      jobId: "resource-a",
      key: repositoryKey,
      kind: "repository_merge",
      expiresAt: 0,
    });
    expect(() => insertHeldClaim(harness.secondary, {
      jobId: "resource-b",
      key: repositoryMergeResourceKey("acme/shared"),
      kind: "repository_merge",
    })).toThrow(/UNIQUE/);

    const firstPolicy = policyFixture({
      projectId: "proj_a",
      production: productionPolicyFixture({ targetKey: "shared.prod" }),
    });
    const secondPolicy = policyFixture({
      projectId: "proj_b",
      production: productionPolicyFixture({ targetKey: "shared.prod" }),
    });
    const productionKey = productionResourceKey(firstPolicy);
    expect(productionKey).toBe(productionResourceKey(secondPolicy));
    insertHeldClaim(harness.primary, {
      jobId: "resource-a",
      key: productionKey,
      kind: "production_target",
    });
    expect(() => insertHeldClaim(harness.secondary, {
      jobId: "resource-b",
      key: productionKey,
      kind: "production_target",
    })).toThrow(/UNIQUE/);
    expect(harness.primaryRepository.listCurrentHeldClaims("resource-a", 10)).toHaveLength(2);
    expect(harness.secondaryRepository.listCurrentHeldClaims("resource-b", 10)).toHaveLength(0);
  } finally {
    harness.close();
  }
});

it("lets only the successor adopt every expired same-job claim", () => {
  const harness = fileBackedAutonomyHarness();
  try {
    seedSelectedJob(harness.primary, { id: "adopt-job", sourceUpdateId: 1, projectId: "proj_adopt" });
    queueJob(harness.primaryRepository, "adopt-job", "proj_adopt", 100);
    setExecutor(harness.primary, "executor-old", 1, 100, 10);
    expect(harness.primaryRepository.tryAdmit({
      jobId: "adopt-job",
      maxConcurrentJobs: 1,
      ownerId: "executor-old",
      generation: 1,
      now: 100,
      leaseMs: 10,
    })).toMatchObject({ outcome: "admitted" });
    insertHeldClaim(harness.primary, {
      jobId: "adopt-job",
      key: repositoryMergeResourceKey("acme/adopt"),
      kind: "repository_merge",
      expiresAt: 110,
    });
    setExecutor(harness.secondary, "executor-new", 2, 200, 1_000);

    expect(harness.secondaryRepository.adoptHeldClaims({
      jobId: "adopt-job",
      ownerId: "executor-new",
      generation: 2,
      now: 200,
      leaseMs: 1_000,
    })).toBe(true);
    expect(harness.primaryRepository.adoptHeldClaims({
      jobId: "adopt-job",
      ownerId: "executor-old",
      generation: 1,
      now: 201,
      leaseMs: 1_000,
    })).toBe(false);
    expect(harness.secondaryRepository.listCurrentHeldClaims("adopt-job", 10)).toMatchObject([
      { ownerId: "executor-new", generation: 2, leaseExpiresAt: 1_200 },
      { ownerId: "executor-new", generation: 2, leaseExpiresAt: 1_200 },
    ]);
  } finally {
    harness.close();
  }
});

it("overlaps two slow independent lanes without starting a third above the cap", async () => {
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  let completions = 0;
  let finishCompletions!: () => void;
  const bothComplete = new Promise<void>((resolve) => { finishCompletions = resolve; });
  const lanes = new JobLaneRunner({
    maxPipelineLanes: () => 2,
    maxControlLanes: 1,
    onCompletion: () => {
      completions += 1;
      if (completions === 2) finishCompletions();
    },
  });

  expect(lanes.tryStart({ jobId: "lane-a", operationKey: "a", kind: "pipeline", run: () => firstGate })).toBe(true);
  expect(lanes.tryStart({ jobId: "lane-b", operationKey: "b", kind: "pipeline", run: () => secondGate })).toBe(true);
  expect(lanes.tryStart({ jobId: "lane-c", operationKey: "c", kind: "pipeline", run: async () => undefined })).toBe(false);
  expect(lanes.snapshot()).toMatchObject({ pipelineActive: 2, busyJobIds: ["lane-a", "lane-b"] });

  releaseFirst();
  releaseSecond();
  await bothComplete;
  expect(lanes.tryStart({ jobId: "lane-c", operationKey: "c", kind: "pipeline", run: async () => undefined })).toBe(true);
  lanes.abortAll(new Error("verification complete"));
});
