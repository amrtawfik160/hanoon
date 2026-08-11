import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import {
  IdempotencyConflictError,
  UpdateClaimConflictError,
  VersionConflictError,
  openStore,
} from "../src/storage/store";
import { admitConfirmedJob, policyFixture, sha } from "./helpers";

function storeFixture() {
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
  return { bb, db: bb.storage.database(), store: openStore(bb.storage) };
}

it("creates deterministic jobs idempotently and rejects replay conflicts", () => {
  const { store } = storeFixture();
  const input = { id: "job_1", sourceUpdateId: 101, requestText: "do it", now: 1_000 };
  const first = store.createJob(input);
  const replay = store.createJob(input);

  expect(first).toEqual(replay);
  expect(first.state).toBe("awaiting_project");
  expect(() => store.createJob({ ...input, requestText: "different" })).toThrow(
    IdempotencyConflictError,
  );
  expect(store.createJob({ ...input, id: "job_2" })).toEqual(first);
});

it("stores the validated policy snapshot and version on project selection", () => {
  const { store } = storeFixture();
  const selected = policyFixture();
  store.upsertProjectPolicy(selected, 1_000);
  const job = store.createJob({ id: "job_1", sourceUpdateId: 101, requestText: "do it", now: 1_000 });
  const selectedJob = store.applyJobEvent(job.id, job.version, {
    type: "PROJECT_SELECTED",
    projectId: selected.projectId,
    policyVersion: 1,
    policy: selected,
  }, 1_100);

  store.upsertProjectPolicy(policyFixture({ baseBranch: "develop" }), 1_200);

  expect(selectedJob.policyVersion).toBe(1);
  expect(selectedJob.policy).toEqual(selected);
  expect(store.getJob(job.id)?.policy).toEqual(selected);
  expect(store.getJob(job.id)?.policy?.baseBranch).toBe("main");
});

it("uses optimistic versions and leaves one durable effect after a stale replay", () => {
  const { store } = storeFixture();
  const job = store.createJob({ id: "job_1", sourceUpdateId: 101, requestText: "do it", now: 1_000 });
  const event = {
    type: "PROJECT_SELECTED" as const,
    projectId: "proj_1",
    policyVersion: 1,
    policy: policyFixture(),
  };

  const applied = store.applyJobEvent(job.id, job.version, event, 1_100);

  expect(applied.version).toBe(2);
  expect(() => store.applyJobEvent(job.id, job.version, event, 1_101)).toThrow(
    VersionConflictError,
  );
  expect(store.listEffectsForJob(job.id)).toHaveLength(1);
  expect(store.listEffectsForJob(job.id)[0]?.kind).toBe("render_status");
});

it.each([
  { name: "CONFIRMED", event: { type: "CONFIRMED" as const } },
  { name: "CONTINUE_REVIEW", event: { type: "CONTINUE_REVIEW" as const } },
])("rejects admission-only $name events at the public store boundary without mutation", ({ event }) => {
  const { db, store } = storeFixture();
  const draft = store.createJob({ id: `job_${event.type.toLowerCase()}`, sourceUpdateId: 101, requestText: "do it", now: 1_000 });
  const selected = store.applyJobEvent(draft.id, draft.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_1",
    policyVersion: 1,
    policy: policyFixture(),
  }, 1_100);
  store.queueAdmission({
    jobId: selected.id,
    expectedVersion: selected.version,
    projectId: "proj_1",
    resumeEvent: "CONFIRMED",
    now: 1_100,
  });
  if (event.type === "CONTINUE_REVIEW") {
    db.prepare("UPDATE jobs SET state = 'blocked', blocked_reason = 'review_limit' WHERE id = ?").run(selected.id);
  }

  const beforeJob = store.getJob(selected.id);
  const beforeAdmission = store.getAdmission(selected.id);
  const beforeEffects = store.listEffectsForJob(selected.id);
  const beforeClaims = store.listHeldResourceClaims(selected.id, 10);

  expect(() => store.applyJobEvent(selected.id, selected.version, event, 1_200)).toThrow(/admission/i);
  expect(store.getJob(selected.id)).toEqual(beforeJob);
  expect(store.getAdmission(selected.id)).toEqual(beforeAdmission);
  expect(store.listEffectsForJob(selected.id)).toEqual(beforeEffects);
  expect(store.listHeldResourceClaims(selected.id, 10)).toEqual(beforeClaims);
});

it("finds active and thread-owned jobs and returns bounded newest jobs", () => {
  const { db, store } = storeFixture();
  const first = store.createJob({ id: "job_1", sourceUpdateId: 101, requestText: "first", now: 1_000 });
  store.applyJobEvent(first.id, first.version, { type: "PROJECT_SELECTED", projectId: "proj_1", policyVersion: 1, policy: policyFixture() }, 1_100);
  const selected = store.getJob(first.id);
  if (!selected) throw new Error("selected job missing");
  const planning = admitConfirmedJob(store, selected, 1_200);
  const critiquing = store.applyJobEvent(first.id, planning.version, { type: "PLAN_READY", attemptId: "stage_plan" }, 1_250);
  const creating = store.applyJobEvent(first.id, critiquing.version, { type: "CRITIQUE_PASSED", attemptId: "stage_critique" }, 1_275);
  const implementing = store.applyJobEvent(first.id, creating.version, { type: "IMPLEMENTATION_CREATED", threadId: "thr_i", environmentId: "env_1" }, 1_300);
  db.prepare("UPDATE jobs SET state = 'blocked', blocked_reason = 'configuration' WHERE id = ?").run(first.id);
  const second = store.createJob({ id: "job_2", sourceUpdateId: 102, requestText: "second", now: 1_400 });

  expect(store.getActiveJob()?.id).toBe(second.id);
  expect(store.findJobByThreadId("thr_i")?.id).toBe(first.id);
  expect(store.findJobByThreadId("missing")).toBeNull();
  expect(store.listJobs(1).map((item) => item.id)).toEqual([second.id]);
  expect(implementing.implementationThreadId).toBe("thr_i");
});

it("deduplicates Telegram updates, advances the cursor monotonically, and records callbacks once", () => {
  const { store, db } = storeFixture();

  expect(store.beginTelegramUpdate(11, 1_000)).toBe("process");
  store.completeTelegramUpdate(11, "accepted", 1_100);
  expect(store.beginTelegramUpdate(11, 1_200)).toBe("processed");
  expect(store.getNextTelegramOffset()).toBe(12);

  expect(store.beginTelegramUpdate(13, 1_300)).toBe("process");
  store.failTelegramUpdate(13, "temporary", 1_400);
  expect(store.beginTelegramUpdate(13, 1_500)).toBe("process");
  store.completeTelegramUpdate(13, "retried", 1_600);
  expect(store.getNextTelegramOffset()).toBe(14);

  expect(store.recordCallback("cb_1", null, "cancel", "accepted", 1_700)).toBe(true);
  expect(store.recordCallback("cb_1", null, "cancel", "duplicate", 1_800)).toBe(false);
  expect(db.prepare("SELECT COUNT(*) AS count FROM callbacks").get()).toEqual({ count: 1 });
});

it("claims an update once and advances the cursor only after lower updates complete", () => {
  const { store } = storeFixture();

  expect(store.beginTelegramUpdate(21, 2_000)).toBe("process");
  expect(store.beginTelegramUpdate(21, 2_001)).toBe("processed");
  expect(store.beginTelegramUpdate(22, 2_002)).toBe("process");

  store.completeTelegramUpdate(22, "out-of-order", 2_003);
  expect(store.getNextTelegramOffset()).toBe(21);

  store.completeTelegramUpdate(21, "first", 2_004);
  expect(store.getNextTelegramOffset()).toBe(23);
});

it("abandons an exhausted update so it stops pinning the polling cursor", () => {
  const { store, db } = storeFixture();

  expect(store.beginTelegramUpdate(41, 3_000)).toBe("process");
  store.failTelegramUpdate(41, "Telegram API 400", 3_001);
  expect(store.beginTelegramUpdate(41, 3_002)).toBe("process");
  store.failTelegramUpdate(41, "Telegram API 400", 3_003);
  expect(store.beginTelegramUpdate(41, 3_004)).toBe("process");
  store.abandonTelegramUpdate(41, "Telegram API 400", 3_005);

  expect(db.prepare("SELECT status, outcome FROM telegram_updates WHERE update_id = 41").get()).toEqual({
    status: "processed",
    outcome: "abandoned",
  });
  expect(store.getNextTelegramOffset()).toBe(42);
});

it("stops letting an already exhausted failure pin the cursor once newer updates land", () => {
  const { store } = storeFixture();

  for (const now of [4_000, 4_002, 4_004]) {
    expect(store.beginTelegramUpdate(51, now)).toBe("process");
    store.failTelegramUpdate(51, "Telegram API 400", now + 1);
  }
  expect(store.getTelegramUpdateAttempts(51)).toBe(3);
  expect(store.getNextTelegramOffset()).toBe(0);

  expect(store.beginTelegramUpdate(52, 4_006)).toBe("process");
  store.completeTelegramUpdate(52, "processed", 4_007);

  expect(store.getNextTelegramOffset()).toBe(53);
});

it("reconciles a cursor left pinned by an exhausted update before polling resumes", () => {
  const { store, db } = storeFixture();

  db.prepare(
    `INSERT INTO telegram_updates (update_id, status, attempts, outcome, last_error, processed_at)
     VALUES (61, 'failed', 8, NULL, 'Telegram API 400', 5_000)`,
  ).run();
  expect(store.beginTelegramUpdate(62, 5_001)).toBe("process");
  store.completeTelegramUpdate(62, "processed", 5_002);
  db.prepare("UPDATE telegram_cursor SET next_offset = 61 WHERE singleton = 1").run();

  store.reconcileTelegramCursor();

  expect(store.getNextTelegramOffset()).toBe(63);
});

it("requires the store that claimed an update to complete or fail it", () => {
  const { bb, store } = storeFixture();
  const otherStore = openStore(bb.storage);

  expect(store.beginTelegramUpdate(31, 2_000)).toBe("process");
  expect(otherStore.beginTelegramUpdate(31, 2_001)).toBe("processed");
  expect(() => otherStore.completeTelegramUpdate(31, "foreign", 2_002)).toThrow(
    UpdateClaimConflictError,
  );
  store.failTelegramUpdate(31, "retry", 2_003);
});

it("reclaims an expired update claim and rejects the old owner", () => {
  const { bb, store } = storeFixture();
  const otherStore = openStore(bb.storage);

  expect(store.beginTelegramUpdate(41, 3_000)).toBe("process");
  expect(otherStore.beginTelegramUpdate(41, 3_001)).toBe("processed");
  expect(otherStore.beginTelegramUpdate(41, 303_001)).toBe("process");
  expect(() => store.completeTelegramUpdate(41, "stale-owner", 303_002)).toThrow(
    UpdateClaimConflictError,
  );
  otherStore.completeTelegramUpdate(41, "reclaimed", 303_003);
});

it("does not let a stale same-store handler reclaim and complete a newer generation", () => {
  const { bb, store } = storeFixture();
  const recoveringStore = openStore(bb.storage);

  expect(store.beginTelegramUpdate(61, 5_000)).toBe("process");
  expect(store.beginTelegramUpdate(61, 305_000)).toBe("processed");
  expect(recoveringStore.beginTelegramUpdate(61, 305_001)).toBe("process");

  expect(() => store.completeTelegramUpdate(61, "stale-generation-1", 305_002)).toThrow(
    UpdateClaimConflictError,
  );
  recoveringStore.completeTelegramUpdate(61, "generation-2", 305_003);
});

it("bounds and protects durable Telegram failure summaries", () => {
  const { store } = storeFixture();

  expect(store.beginTelegramUpdate(51, 4_000)).toBe("process");
  expect(() => store.failTelegramUpdate(51, "x".repeat(501), 4_001)).toThrow(TypeError);
  expect(() => store.failTelegramUpdate(51, "provider failed: api_key=secret-token", 4_002)).toThrow(TypeError);
  store.failTelegramUpdate(51, "temporary provider failure", 4_003);
});

it("enqueues one reconcile effect for a known worker thread", () => {
  const { store } = storeFixture();
  const job = store.createJob({ id: "job_1", sourceUpdateId: 101, requestText: "do it", now: 1_000 });
  store.applyJobEvent(job.id, job.version, { type: "PROJECT_SELECTED", projectId: "proj_1", policyVersion: 1, policy: policyFixture() }, 1_100);
  const selected = store.getJob(job.id);
  if (!selected) throw new Error("selected job missing");
  const planning = admitConfirmedJob(store, selected, 1_200);
  const critiquing = store.applyJobEvent(job.id, planning.version, { type: "PLAN_READY", attemptId: "stage_plan" }, 1_250);
  const creating = store.applyJobEvent(job.id, critiquing.version, { type: "CRITIQUE_PASSED", attemptId: "stage_critique" }, 1_275);
  store.applyJobEvent(job.id, creating.version, { type: "IMPLEMENTATION_CREATED", threadId: "thr_i", environmentId: "env_1" }, 1_300);

  expect(store.enqueueReconcileForThread("thr_i", 2_000)).toBe(true);
  expect(store.enqueueReconcileForThread("thr_i", 2_001)).toBe(false);
  expect(store.enqueueReconcileForThread("unknown", 2_002)).toBe(false);
  expect(store.listEffectsForJob(job.id).filter((effect) => effect.kind === "reconcile_job")).toHaveLength(1);
  expect(store.listEffectsForJob(job.id).find((effect) => effect.kind === "reconcile_job")?.payload).toEqual({ threadId: "thr_i" });
});

it("requeues a released review-limit block without a global active-job rejection", () => {
  const { db, store } = storeFixture();
  const blocked = store.createJob({ id: "job_blocked", sourceUpdateId: 101, requestText: "blocked", now: 1_000 });
  const selected = store.applyJobEvent(blocked.id, blocked.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_1",
    policyVersion: 1,
    policy: policyFixture(),
  }, 1_050);
  store.queueAdmission({
    jobId: blocked.id,
    expectedVersion: selected.version,
    projectId: "proj_1",
    resumeEvent: "CONFIRMED",
    now: 1_050,
  });
  db.prepare("UPDATE jobs SET state = 'blocked', blocked_reason = 'review_limit', review_cycle = 3 WHERE id = ?").run(blocked.id);
  db.prepare("UPDATE job_admissions SET state = 'released', released_at = 1_100, release_reason = 'review_limit' WHERE job_id = ?").run(blocked.id);
  const active = store.createJob({ id: "job_active", sourceUpdateId: 102, requestText: "active", now: 1_100 });

  const requeued = store.requeueReviewAdmission(blocked.id, selected.version, 1_200);

  expect(requeued).toMatchObject({ outcome: "queued", admission: {
    state: "queued",
    resumeEvent: "CONTINUE_REVIEW",
  } });
  expect(store.requeueReviewAdmission(blocked.id, selected.version, 1_300)).toEqual(requeued);
  expect(store.getJob(blocked.id)?.state).toBe("blocked");
  expect(store.getJob(active.id)?.state).toBe("awaiting_project");
});

it("rejects a queued CONFIRMED admission as a review continuation", () => {
  const { db, store } = storeFixture();
  const blocked = store.createJob({ id: "job_mismatched_review", sourceUpdateId: 104, requestText: "mismatched", now: 1_000 });
  const selected = store.applyJobEvent(blocked.id, blocked.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_1",
    policyVersion: 1,
    policy: policyFixture(),
  }, 1_050);
  store.queueAdmission({
    jobId: blocked.id,
    expectedVersion: selected.version,
    projectId: "proj_1",
    resumeEvent: "CONFIRMED",
    now: 1_050,
  });
  db.prepare("UPDATE jobs SET state = 'blocked', blocked_reason = 'review_limit' WHERE id = ?").run(blocked.id);
  const beforeJob = store.getJob(blocked.id);
  const beforeAdmission = store.getAdmission(blocked.id);
  const beforeEffects = store.listEffectsForJob(blocked.id);
  const beforeClaims = store.listHeldResourceClaims(blocked.id, 10);

  expect(store.requeueReviewAdmission(blocked.id, selected.version, 1_200)).toEqual({ outcome: "unavailable" });
  expect(store.getJob(blocked.id)).toEqual(beforeJob);
  expect(store.getAdmission(blocked.id)).toEqual(beforeAdmission);
  expect(store.listEffectsForJob(blocked.id)).toEqual(beforeEffects);
  expect(store.listHeldResourceClaims(blocked.id, 10)).toEqual(beforeClaims);
});

it("reports bounded cleanup while a blocked review admission is draining", () => {
  const { db, store } = storeFixture();
  const blocked = store.createJob({ id: "job_draining", sourceUpdateId: 103, requestText: "draining", now: 1_000 });
  const selected = store.applyJobEvent(blocked.id, blocked.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_1",
    policyVersion: 1,
    policy: policyFixture(),
  }, 1_050);
  store.queueAdmission({
    jobId: blocked.id,
    expectedVersion: selected.version,
    projectId: "proj_1",
    resumeEvent: "CONFIRMED",
    now: 1_050,
  });
  db.prepare("UPDATE jobs SET state = 'blocked', blocked_reason = 'review_limit', review_cycle = 3 WHERE id = ?").run(blocked.id);
  db.prepare("UPDATE job_admissions SET state = 'draining', admitted_at = 1_060, draining_at = 1_100 WHERE job_id = ?").run(blocked.id);

  const result = store.requeueReviewAdmission(blocked.id, selected.version, 1_200);

  expect(result).toMatchObject({ outcome: "still_cleaning_up", admission: { state: "draining" } });
  expect(store.getAdmission(blocked.id)?.state).toBe("draining");
});

it("keeps head receipts guarded by the pure transition before persisting validation", () => {
  const { store } = storeFixture();
  const job = store.createJob({ id: "job_1", sourceUpdateId: 101, requestText: "do it", now: 1_000 });
  const selected = store.applyJobEvent(job.id, job.version, { type: "PROJECT_SELECTED", projectId: "proj_1", policyVersion: 1, policy: policyFixture() }, 1_100);
  const confirmed = admitConfirmedJob(store, selected, 1_200);
  const planned = store.applyJobEvent(job.id, confirmed.version, { type: "PLAN_READY", attemptId: "stage_plan" }, 1_225);
  const critiqued = store.applyJobEvent(job.id, planned.version, { type: "CRITIQUE_PASSED", attemptId: "stage_critique" }, 1_250);
  const created = store.applyJobEvent(job.id, critiqued.version, { type: "IMPLEMENTATION_CREATED", threadId: "thr_i", environmentId: "env_1" }, 1_300);
  const implementing = store.applyJobEvent(job.id, created.version, { type: "IMPLEMENTATION_IDLE" }, 1_400);
  const locating = store.applyJobEvent(job.id, implementing.version, { type: "PR_LOCATED", number: 7, url: "https://github.test/pr/7" }, 1_500);
  const resolving = store.applyJobEvent(job.id, locating.version, { type: "PR_HEAD_RESOLVED", headSha: sha() }, 1_600);

  expect(resolving.state).toBe("validating");
  expect(resolving.prHeadSha).toBe(sha());
  expect(store.listEffectsForJob(job.id).map((effect) => effect.kind)).toEqual([
    "render_status",
    "spawn_plan",
    "spawn_critique",
    "spawn_implementation",
    "render_status",
    "inspect_implementation",
    "revoke_approvals",
    "resolve_pr_head",
    "run_validation",
  ]);
});
