import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { expect, it } from "vitest";
import type { AdmissionState, AdmissionResumeEvent } from "../src/autonomy/models";
import { AutonomyRepository } from "../src/storage/autonomy-repository";
import { VersionConflictError } from "../src/storage/job-persistence";
import { openStore } from "../src/storage/store";
import type { ProjectPolicy } from "../src/domain/models";
import { policyFixture } from "./helpers";

type SqliteDatabase = Database.Database;

let fixtureNumber = 0;

function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-autonomy-repository-${fixtureNumber++}` });
  const store = openStore(bb.storage);
  const db = bb.storage.database();
  return { db, repo: new AutonomyRepository(db), store };
}

function policyFor(projectId: string): ProjectPolicy {
  return policyFixture({
    projectId,
    alias: projectId === "proj_1" ? "cyndra" : `alias-${projectId.slice(5).replace(/[^a-z0-9-]/g, "-")}`,
  });
}

function seedJob(
  db: SqliteDatabase,
  input: {
    id: string;
    sourceUpdateId: number;
    projectId: string;
    state?: string;
    version?: number;
    updatedAt?: number;
    statusMessageId?: number | null;
    policy?: ProjectPolicy;
  },
): void {
  const policy = input.policy ?? policyFor(input.projectId);
  db.prepare(
    `INSERT INTO jobs (
       id, source_update_id, request_text, state, project_id, policy_version, policy_json,
       status_message_id, version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.sourceUpdateId,
    `private request for ${input.id}`,
    input.state ?? "planning",
    input.projectId,
    1,
    JSON.stringify(policy),
    input.statusMessageId ?? null,
    input.version ?? 1,
    (input.updatedAt ?? 1_000) - 100,
    input.updatedAt ?? 1_000,
  );
}

function seedAdmission(
  db: SqliteDatabase,
  input: {
    jobId: string;
    projectId: string;
    queueSeq: number;
    state: AdmissionState;
    resumeEvent?: AdmissionResumeEvent;
    queuedAt?: number;
    admittedAt?: number | null;
    releasedAt?: number | null;
    releaseReason?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO job_admissions (
       job_id, project_id, queue_seq, state, resume_event, queued_at,
       admitted_at, draining_at, released_at, release_reason
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    input.jobId,
    input.projectId,
    input.queueSeq,
    input.state,
    input.resumeEvent ?? "CONFIRMED",
    input.queuedAt ?? 1_000,
    input.admittedAt ?? (input.state === "admitted" || input.state === "draining" ? 1_100 : null),
    input.releasedAt ?? (input.state === "released" ? 1_200 : null),
    input.releaseReason ?? (input.state === "released" ? "complete" : null),
  );
}

function seedClaim(
  db: SqliteDatabase,
  input: {
    jobId: string;
    resourceKey: string;
    state: "held" | "released";
    ownerId: string;
    claimTime: number;
    releaseReason?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO job_resource_claims (
       job_id, resource_key, resource_kind, state, owner_id, generation,
       lease_expires_at, acquired_at, renewed_at, released_at, release_reason
     ) VALUES (?, ?, 'project', ?, ?, 0, ?, ?, ?, ?, ?)`,
  ).run(
    input.jobId,
    input.resourceKey,
    input.state,
    input.ownerId,
    input.state === "held" ? 10_000 : 0,
    input.claimTime,
    input.claimTime,
    input.state === "released" ? input.claimTime + 1 : null,
    input.releaseReason ?? (input.state === "released" ? "released" : null),
  );
}

function queueInput(
  jobId: string,
  projectId: string,
  resumeEvent: AdmissionResumeEvent = "CONFIRMED",
  now = 2_000,
) {
  return { jobId, expectedVersion: 1, projectId, resumeEvent, now };
}

it("caps plural reads at 100 and scheduler candidates at 16", () => {
  const { db, repo } = fixture();

  for (let index = 0; index < 105; index += 1) {
    const projectId = `proj_queue_${index}`;
    seedJob(db, { id: `job_queued_${index}`, sourceUpdateId: 1_000 + index, projectId });
    seedAdmission(db, {
      jobId: `job_queued_${index}`,
      projectId,
      queueSeq: index + 1,
      state: "queued",
    });
  }
  for (let index = 0; index < 105; index += 1) {
    const projectId = `proj_occupied_${index}`;
    seedJob(db, { id: `job_occupied_${index}`, sourceUpdateId: 2_000 + index, projectId });
    seedAdmission(db, {
      jobId: `job_occupied_${index}`,
      projectId,
      queueSeq: 106 + index,
      state: "admitted",
    });
  }

  expect(repo.listAdmissions(["queued"], 1_000)).toHaveLength(100);
  expect(repo.listOldestQueuedPerProject(1_000)).toHaveLength(16);
  expect(repo.listOccupiedAdmissions(1_000)).toHaveLength(100);
});

it("finds the exact status-message owner through the unique identity", () => {
  const { db, repo } = fixture();
  seedJob(db, {
    id: "job_status_old",
    sourceUpdateId: 301,
    projectId: "proj_1",
    statusMessageId: 901,
    updatedAt: 1_000,
  });
  seedJob(db, {
    id: "job_status_target",
    sourceUpdateId: 302,
    projectId: "proj_2",
    statusMessageId: 902,
    updatedAt: 9_000,
  });

  expect(repo.findJobByStatusMessageId(901)).toMatchObject({
    id: "job_status_old",
    statusMessageId: 901,
  });
  expect(repo.findJobByStatusMessageId(903)).toBeNull();
});

it("allocates monotonic queue sequences when timestamps are equal", () => {
  const { db, repo } = fixture();
  seedJob(db, { id: "job_sequence_one", sourceUpdateId: 401, projectId: "proj_1", updatedAt: 7_000 });
  seedJob(db, { id: "job_sequence_two", sourceUpdateId: 402, projectId: "proj_2", updatedAt: 7_000 });

  const first = repo.queueAdmission(queueInput("job_sequence_one", "proj_1", "CONFIRMED", 7_000));
  const second = repo.queueAdmission(queueInput("job_sequence_two", "proj_2", "CONFIRMED", 7_000));

  expect(first.queueSeq).toBe(1);
  expect(second.queueSeq).toBe(2);
  expect(repo.listAdmissions(["queued"], 10).map((admission) => admission.queueSeq)).toEqual([1, 2]);
  expect(db.prepare("SELECT next_queue_seq FROM autonomy_sequence WHERE singleton = 1").get()).toEqual({ next_queue_seq: 3 });
});

it("replays the same queue identity without consuming a second sequence", () => {
  const { db, repo } = fixture();
  seedJob(db, { id: "job_replay", sourceUpdateId: 501, projectId: "proj_1" });

  const first = repo.queueAdmission(queueInput("job_replay", "proj_1"));
  const replay = repo.queueAdmission(queueInput("job_replay", "proj_1"));

  expect(replay).toEqual(first);
  expect(db.prepare("SELECT next_queue_seq FROM autonomy_sequence WHERE singleton = 1").get()).toEqual({ next_queue_seq: 2 });
});

it("replaces only a released admission and replays that replacement idempotently", () => {
  const { db, repo } = fixture();
  seedJob(db, { id: "job_requeue", sourceUpdateId: 601, projectId: "proj_1" });
  db.prepare("UPDATE jobs SET state = 'blocked', blocked_reason = 'review_limit' WHERE id = ?").run("job_requeue");
  repo.queueAdmission(queueInput("job_requeue", "proj_1"));
  db.prepare(
    "UPDATE job_admissions SET state = 'released', released_at = ?, release_reason = ? WHERE job_id = ?",
  ).run(2_100, "failed", "job_requeue");

  const first = repo.requeueAdmission(queueInput("job_requeue", "proj_1", "CONTINUE_REVIEW", 2_200));
  const replay = repo.requeueAdmission(queueInput("job_requeue", "proj_1", "CONTINUE_REVIEW", 2_200));

  expect(first).toMatchObject({
    queueSeq: 2,
    state: "queued",
    resumeEvent: "CONTINUE_REVIEW",
    queuedAt: 2_200,
    releasedAt: null,
  });
  expect(replay).toEqual(first);
  expect(db.prepare("SELECT next_queue_seq FROM autonomy_sequence WHERE singleton = 1").get()).toEqual({ next_queue_seq: 3 });
});

it("rejects changed project or resume-event replay identities without consuming sequence", () => {
  const { db, repo } = fixture();
  seedJob(db, { id: "job_conflict", sourceUpdateId: 701, projectId: "proj_1" });
  repo.queueAdmission(queueInput("job_conflict", "proj_1"));

  expect(() => repo.queueAdmission(queueInput("job_conflict", "proj_2"))).toThrow(/identity|project/i);
  expect(() => repo.queueAdmission(queueInput("job_conflict", "proj_1", "CONTINUE_REVIEW"))).toThrow(/identity|event/i);
  expect(db.prepare("SELECT next_queue_seq FROM autonomy_sequence WHERE singleton = 1").get()).toEqual({ next_queue_seq: 2 });
});

it("requires the exact job version and matching immutable policy project", () => {
  const { db, repo } = fixture();
  seedJob(db, { id: "job_version", sourceUpdateId: 801, projectId: "proj_1", version: 2 });
  expect(() => repo.queueAdmission(queueInput("job_version", "proj_1"))).toThrow(VersionConflictError);

  seedJob(db, {
    id: "job_policy_mismatch",
    sourceUpdateId: 802,
    projectId: "proj_1",
    policy: policyFor("proj_2"),
  });
  expect(() => repo.queueAdmission(queueInput("job_policy_mismatch", "proj_1"))).toThrow(/policy|project/i);
});

it("preserves released claim history while the partial unique index protects held resources", () => {
  const { db, repo } = fixture();
  seedJob(db, { id: "job_claim_one", sourceUpdateId: 901, projectId: "proj_1" });
  seedJob(db, { id: "job_claim_two", sourceUpdateId: 902, projectId: "proj_2" });
  const resourceKey = "project:shared:pipeline";
  seedClaim(db, {
    jobId: "job_claim_one",
    resourceKey,
    state: "held",
    ownerId: "executor-one",
    claimTime: 3_000,
  });
  expect(() => seedClaim(db, {
    jobId: "job_claim_two",
    resourceKey,
    state: "held",
    ownerId: "executor-two",
    claimTime: 3_001,
  })).toThrow();

  db.prepare(
    "UPDATE job_resource_claims SET state = 'released', lease_expires_at = 0, released_at = ?, release_reason = ? WHERE job_id = ?",
  ).run(3_100, "complete", "job_claim_one");
  seedClaim(db, {
    jobId: "job_claim_two",
    resourceKey,
    state: "held",
    ownerId: "executor-two",
    claimTime: 3_200,
  });

  const claims = repo.listHeldClaims(null, 100);
  expect(claims).toHaveLength(2);
  expect(claims.map((claim) => [claim.jobId, claim.state])).toEqual([
    ["job_claim_one", "released"],
    ["job_claim_two", "held"],
  ]);
  expect(Object.keys(claims[0] ?? {}).sort()).toEqual([
    "acquiredAt",
    "claimId",
    "generation",
    "jobId",
    "leaseExpiresAt",
    "ownerId",
    "releaseReason",
    "releasedAt",
    "renewedAt",
    "resourceKey",
    "resourceKind",
    "state",
  ]);
});

it("delegates typed autonomy queries and admits failed jobs through their admission", () => {
  const { db, repo, store } = fixture();
  seedJob(db, { id: "job_active_queued", sourceUpdateId: 1_001, projectId: "proj_1", statusMessageId: 1_001 });
  seedJob(db, { id: "job_active_failed", sourceUpdateId: 1_002, projectId: "proj_2", state: "failed" });
  seedJob(db, { id: "job_active_draining", sourceUpdateId: 1_003, projectId: "proj_3" });
  seedJob(db, { id: "job_released", sourceUpdateId: 1_004, projectId: "proj_4" });
  seedAdmission(db, { jobId: "job_active_queued", projectId: "proj_1", queueSeq: 1, state: "queued" });
  seedAdmission(db, { jobId: "job_active_failed", projectId: "proj_2", queueSeq: 2, state: "admitted", admittedAt: 1_100 });
  seedAdmission(db, { jobId: "job_active_draining", projectId: "proj_3", queueSeq: 3, state: "draining", admittedAt: 1_100 });
  seedAdmission(db, { jobId: "job_released", projectId: "proj_4", queueSeq: 4, state: "released" });
  seedClaim(db, {
    jobId: "job_active_failed",
    resourceKey: "project:proj_2:pipeline",
    state: "held",
    ownerId: "executor",
    claimTime: 4_000,
  });

  expect(store.getAdmission("job_active_failed")).toEqual(repo.getAdmission("job_active_failed"));
  expect(store.listAdmissions(["queued", "admitted", "draining"], 10).map((admission) => admission.jobId)).toEqual([
    "job_active_queued",
    "job_active_failed",
    "job_active_draining",
  ]);
  expect(store.listHeldResourceClaims("job_active_failed", 10)).toEqual(
    repo.listHeldClaims("job_active_failed", 10),
  );
  expect(store.findJobByStatusMessageId(1_001)?.id).toBe("job_active_queued");
  expect(store.listActiveJobs(10).map((job) => job.id)).toEqual([
    "job_active_queued",
    "job_active_failed",
    "job_active_draining",
  ]);
  expect(store.listActiveJobs(10).find((job) => job.id === "job_active_failed")?.state).toBe("failed");
});
