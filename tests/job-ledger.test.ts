import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
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
  expect(db.prepare("SELECT COUNT(*) AS count FROM pipeline_stage_attempts WHERE job_id = ?").get(job.id))
    .toEqual({ count: 0 });
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
