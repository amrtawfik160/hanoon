import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { hashSecret } from "../src/crypto";
import {
  JOB_LEDGER_DRAIN_REASON,
  decideJobLedgerUpgrade,
} from "../src/domain/job-ledger";
import {
  persistJobTransition,
  readJobById,
} from "../src/storage/job-persistence";
import {
  readJobLedger,
  upgradeJobsOntoLedger,
} from "../src/storage/job-ledger";
import { openStore } from "../src/storage/store";
import { jobFixture, policyFixture, sha } from "./helpers";

const PLAN_HEAD = sha("b");

function storeFixture(pluginId: string) {
  const { bb } = createFakePluginHost({ pluginId });
  return { bb, db: bb.storage.database(), store: openStore(bb.storage) };
}

function stageAttemptCount(db: ReturnType<typeof storeFixture>["db"], jobId: string): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM pipeline_stage_attempts WHERE job_id = ?").get(jobId) as { count: number }).count;
}

function insertUpgradeJob(
  db: ReturnType<typeof storeFixture>["db"],
  row: { id: string; sourceUpdateId: number; requestText: string; state: string; branch: string; head: string },
): void {
  db.prepare(
    `INSERT INTO jobs (
       id, source_update_id, request_text, state, adopted_branch, adopted_head_sha, pr_head_sha,
       review_cycle, review_block_at, version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 3, 1, 1, 1)`,
  ).run(row.id, row.sourceUpdateId, row.requestText, row.state, row.branch, row.head, row.head);
}

function submittedController(store: ReturnType<typeof storeFixture>["store"], threadId: string): void {
  store.createPairingCode(hashSecret("pair-ledger"), 1_000, 20_000);
  expect(store.pairOwnerWithCode(hashSecret("pair-ledger"), "7", "7", 1_001)).toEqual({ ok: true });
  store.upsertProjectPolicy(policyFixture(), 1_002);
  store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 701,
    inputText: "Review and finish the existing pull request",
    now: 2_000,
  });
  const lease = store.acquireExecutorLease("executor", 10_000, 30_000);
  if (!lease.acquired) throw new Error("missing executor lease");
  const turn = store.claimNextControllerTurn({ ownerId: "executor", generation: lease.generation, now: 13_000 });
  if (!turn) throw new Error("missing controller turn");
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: "executor",
    generation: lease.generation,
    now: 10_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: "executor",
    generation: lease.generation,
    now: 10_000,
  })).toBe(true);
  expect(store.releaseExecutorLease("executor", lease.generation, 10_000)).toBe(true);
}

it("migrates a planning job onto a ledger row without advancing its stage", () => {
  expect(decideJobLedgerUpgrade({
    id: "job_plan",
    state: "planning",
    branch: "feat/intake",
    head: PLAN_HEAD,
  })).toEqual({
    action: "migrate",
    row: {
      id: "job_plan",
      stage: "planning",
      branch: "feat/intake",
      head: PLAN_HEAD,
    },
  });
});

it("drains a recovering worker instead of guessing a later pipeline stage", () => {
  expect(decideJobLedgerUpgrade({
    id: "job_recover",
    state: "recovering_worker",
    branch: "feat/intake",
    head: PLAN_HEAD,
  })).toEqual({
    action: "drain",
    id: "job_recover",
    reason: JOB_LEDGER_DRAIN_REASON,
  });
});

it("drains a job whose pipeline stage is not a known ledger stage", () => {
  expect(decideJobLedgerUpgrade({
    id: "job_legacy",
    state: "pipeline_v0_step_7",
    branch: null,
    head: null,
  })).toEqual({
    action: "drain",
    id: "job_legacy",
    reason: JOB_LEDGER_DRAIN_REASON,
  });
});

it("drains a job whose head cannot be copied onto the ledger", () => {
  expect(decideJobLedgerUpgrade({
    id: "job_bad_head",
    state: "planning",
    branch: "feat/intake",
    head: "not-a-sha",
  })).toEqual({
    action: "drain",
    id: "job_bad_head",
    reason: JOB_LEDGER_DRAIN_REASON,
  });
});

it("creates a job ledger row carrying id, stage, branch, and head", () => {
  const { store, db } = storeFixture("job-ledger-create");
  store.createJob({ id: "job_1", sourceUpdateId: 101, requestText: "do it", now: 1_000 });

  expect(readJobLedger(db, "job_1")).toEqual({
    id: "job_1",
    stage: "awaiting_project",
    branch: "",
    head: "",
  });
});

it("advances a job only by writing the ledger", () => {
  const { store, db } = storeFixture("job-ledger-advance");
  const job = store.createJob({ id: "job_1", sourceUpdateId: 101, requestText: "do it", now: 1_000 });
  const selected = store.applyJobEvent(job.id, job.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_1",
    policyVersion: 1,
    policy: policyFixture(),
  }, 1_100);

  expect(selected.state).toBe("awaiting_confirmation");
  expect(readJobLedger(db, job.id)).toEqual({
    id: "job_1",
    stage: "awaiting_confirmation",
    branch: "",
    head: "",
  });
});

it("leaves a job unmoved when the ledger write is rejected", () => {
  const { store, db } = storeFixture("job-ledger-reject");
  const created = store.createJob({ id: "job_1", sourceUpdateId: 101, requestText: "do it", now: 1_000 });
  const invalid = jobFixture({
    ...created,
    state: "not-a-stage" as typeof created.state,
    version: created.version + 1,
    updatedAt: 1_100,
  });

  expect(() => persistJobTransition(db, created.id, created.version, invalid)).toThrow(/ledger stage/i);
  expect(readJobById(db, created.id)?.state).toBe("awaiting_project");
  expect(readJobById(db, created.id)?.version).toBe(1);
  expect(readJobLedger(db, created.id)?.stage).toBe("awaiting_project");
});

it("upgrades in-flight jobs onto the ledger or drains them with an owner-visible outcome", () => {
  const { db } = storeFixture("job-ledger-upgrade");
  db.prepare(
    `INSERT INTO jobs (
       id, source_update_id, request_text, state, adopted_branch, adopted_head_sha, pr_head_sha,
       review_cycle, review_block_at, version, created_at, updated_at
     ) VALUES
       ('job_plan', 201, 'plan it', 'planning', 'feat/intake', ?, ?, 0, 3, 1, 1, 1),
       ('job_recover', 202, 'recover it', 'recovering_worker', 'feat/lost', ?, ?, 0, 3, 1, 1, 1)`,
  ).run(PLAN_HEAD, PLAN_HEAD, PLAN_HEAD, PLAN_HEAD);

  const outcomes = upgradeJobsOntoLedger(db, 5_000);

  expect(outcomes).toEqual([
    {
      action: "migrate",
      row: { id: "job_plan", stage: "planning", branch: "feat/intake", head: PLAN_HEAD },
    },
    {
      action: "drain",
      id: "job_recover",
      reason: JOB_LEDGER_DRAIN_REASON,
    },
  ]);
  expect(readJobLedger(db, "job_plan")).toEqual({
    id: "job_plan",
    stage: "planning",
    branch: "feat/intake",
    head: PLAN_HEAD,
  });
  expect(readJobById(db, "job_plan")?.state).toBe("planning");
  expect(readJobById(db, "job_recover")).toMatchObject({
    state: "cancelled",
    resumeState: "recovering_worker",
    lastError: JOB_LEDGER_DRAIN_REASON,
  });
  expect(readJobLedger(db, "job_recover")).toEqual({
    id: "job_recover",
    stage: "cancelled",
    branch: "feat/lost",
    head: PLAN_HEAD,
  });
  expect(db.prepare(
    `SELECT kind, payload_json FROM effects WHERE job_id = 'job_recover'`,
  ).get()).toEqual({
    kind: "render_status",
    payload_json: "{}",
  });
});

it("does not drain or advance a job that already has a ledger row", () => {
  const { store, db } = storeFixture("job-ledger-idempotent");
  store.createJob({ id: "job_1", sourceUpdateId: 101, requestText: "do it", now: 1_000 });

  expect(upgradeJobsOntoLedger(db, 6_000)).toEqual([]);
  expect(readJobLedger(db, "job_1")?.stage).toBe("awaiting_project");
  expect(readJobById(db, "job_1")?.version).toBe(1);
});

it("does not write pipeline stage attempts when adopting a pull request", () => {
  const { store, db } = storeFixture("job-ledger-adopt-no-stage");
  submittedController(store, "thr_controller");
  const headSha = sha("a");
  const job = store.createAdoptedControllerJob({
    controllerThreadId: "thr_controller",
    projectId: "proj_1",
    task: "Review and finish the existing pull request",
    prNumber: 17,
    prUrl: "https://github.com/acme/cyndra/pull/17",
    headSha,
    branchName: "telegram-agent/adopt-pr-17-aaaaaaaaaaaa",
    now: 10_010,
  });

  expect(readJobLedger(db, job.id)).toEqual({
    id: job.id,
    stage: "awaiting_confirmation",
    branch: "telegram-agent/adopt-pr-17-aaaaaaaaaaaa",
    head: headSha,
  });
  expect(store.getLatestPipelineStageAttempt(job.id, "PLAN")).toBeNull();
  expect(store.getLatestPipelineStageAttempt(job.id, "CRITIQUE")).toBeNull();
  expect(stageAttemptCount(db, job.id)).toBe(0);
});

it("does not write pipeline stage attempts from the live stage-machine API", () => {
  const { store, db } = storeFixture("job-ledger-no-stage-writes");
  const job = store.createJob({ id: "job_1", sourceUpdateId: 101, requestText: "do it", now: 1_000 });
  const lease = store.acquireExecutorLease("executor", 1_001, 30_000);
  if (!lease.acquired) throw new Error("missing executor lease");
  const fence = { ownerId: "executor", generation: lease.generation };
  const attempt = store.createPipelineStageAttempt({
    id: "stage_plan_1",
    jobId: job.id,
    role: "PLAN",
    ordinal: 1,
    inputSha256: "a".repeat(64),
    ...fence,
    now: 1_002,
  });

  expect(store.bindPipelineStageThread({
    id: attempt.id,
    threadId: "thr_plan",
    environmentId: "env_plan",
    ...fence,
    now: 1_003,
  })).toBe(true);
  expect(store.completePipelineStageAttempt({
    id: attempt.id,
    outputText: "# Plan\n",
    outputSha256: "b".repeat(64),
    outcome: { verdict: "success" },
    ...fence,
    now: 1_004,
  })).toBe(true);
  expect(store.getPipelineStageAttempt(attempt.id)).toBeNull();
  expect(store.getLatestPipelineStageAttempt(job.id, "PLAN")).toBeNull();
  expect(stageAttemptCount(db, job.id)).toBe(0);
});

it("drains an unreadable head on upgrade and still migrates sibling jobs", () => {
  const { bb, db } = storeFixture("job-ledger-unreadable-head");
  insertUpgradeJob(db, {
    id: "job_bad",
    sourceUpdateId: 301,
    requestText: "bad head",
    state: "planning",
    branch: "feat/lost",
    head: "not-a-sha",
  });
  insertUpgradeJob(db, {
    id: "job_ok",
    sourceUpdateId: 302,
    requestText: "good head",
    state: "planning",
    branch: "feat/intake",
    head: PLAN_HEAD,
  });

  expect(() => openStore(bb.storage, bb.storage.kv, () => 7_000)).not.toThrow();

  expect(readJobById(db, "job_bad")).toMatchObject({
    state: "cancelled",
    resumeState: "planning",
    lastError: JOB_LEDGER_DRAIN_REASON,
  });
  expect(readJobLedger(db, "job_bad")).toEqual({
    id: "job_bad",
    stage: "cancelled",
    branch: "feat/lost",
    head: "",
  });
  expect(db.prepare(
    `SELECT kind, payload_json FROM effects WHERE job_id = 'job_bad'`,
  ).get()).toEqual({
    kind: "render_status",
    payload_json: "{}",
  });
  expect(readJobById(db, "job_ok")?.state).toBe("planning");
  expect(readJobLedger(db, "job_ok")).toEqual({
    id: "job_ok",
    stage: "planning",
    branch: "feat/intake",
    head: PLAN_HEAD,
  });
});

it("does not report a drain when the cancel does not take the job version", () => {
  const { db } = storeFixture("job-ledger-stale-drain");
  insertUpgradeJob(db, {
    id: "job_plan",
    sourceUpdateId: 401,
    requestText: "plan it",
    state: "planning",
    branch: "feat/intake",
    head: PLAN_HEAD,
  });
  insertUpgradeJob(db, {
    id: "job_stale",
    sourceUpdateId: 402,
    requestText: "recover it",
    state: "recovering_worker",
    branch: "feat/lost",
    head: PLAN_HEAD,
  });
  db.exec(
    `CREATE TRIGGER job_stale_cancel
       BEFORE UPDATE ON jobs
       WHEN OLD.id = 'job_stale' AND NEW.state = 'cancelled'
     BEGIN
       SELECT RAISE(IGNORE);
     END;`,
  );

  expect(upgradeJobsOntoLedger(db, 8_000)).toEqual([
    {
      action: "migrate",
      row: { id: "job_plan", stage: "planning", branch: "feat/intake", head: PLAN_HEAD },
    },
  ]);
  expect(readJobById(db, "job_stale")).toMatchObject({
    state: "recovering_worker",
    version: 1,
    lastError: null,
  });
  expect(readJobLedger(db, "job_stale")).toBeNull();
  expect(db.prepare("SELECT COUNT(*) AS count FROM effects WHERE job_id = 'job_stale'").get())
    .toEqual({ count: 0 });
  expect(readJobLedger(db, "job_plan")).toEqual({
    id: "job_plan",
    stage: "planning",
    branch: "feat/intake",
    head: PLAN_HEAD,
  });
});
