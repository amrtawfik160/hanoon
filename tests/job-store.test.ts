import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import {
  ActiveJobConflictError,
  IdempotencyConflictError,
  UpdateClaimConflictError,
  VersionConflictError,
  openStore,
} from "../src/storage/store";
import { policyFixture, sha } from "./helpers";

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

it("finds active and thread-owned jobs and returns bounded newest jobs", () => {
  const { db, store } = storeFixture();
  const first = store.createJob({ id: "job_1", sourceUpdateId: 101, requestText: "first", now: 1_000 });
  store.applyJobEvent(first.id, first.version, { type: "PROJECT_SELECTED", projectId: "proj_1", policyVersion: 1, policy: policyFixture() }, 1_100);
  store.applyJobEvent(first.id, 2, { type: "CONFIRMED" }, 1_200);
  const creating = store.applyJobEvent(first.id, 3, { type: "IMPLEMENTATION_CREATED", threadId: "thr_i", environmentId: "env_1" }, 1_300);
  db.prepare("UPDATE jobs SET state = 'blocked', blocked_reason = 'configuration' WHERE id = ?").run(first.id);
  const second = store.createJob({ id: "job_2", sourceUpdateId: 102, requestText: "second", now: 1_400 });

  expect(store.getActiveJob()?.id).toBe(second.id);
  expect(store.findJobByThreadId("thr_i")?.id).toBe(first.id);
  expect(store.findJobByThreadId("missing")).toBeNull();
  expect(store.listJobs(1).map((item) => item.id)).toEqual([second.id]);
  expect(creating.implementationThreadId).toBe("thr_i");
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
  store.applyJobEvent(job.id, 2, { type: "CONFIRMED" }, 1_200);
  store.applyJobEvent(job.id, 3, { type: "IMPLEMENTATION_CREATED", threadId: "thr_i", environmentId: "env_1" }, 1_300);

  expect(store.enqueueReconcileForThread("thr_i", 2_000)).toBe(true);
  expect(store.enqueueReconcileForThread("thr_i", 2_001)).toBe(false);
  expect(store.enqueueReconcileForThread("unknown", 2_002)).toBe(false);
  expect(store.listEffectsForJob(job.id).filter((effect) => effect.kind === "reconcile_job")).toHaveLength(1);
  expect(store.listEffectsForJob(job.id).find((effect) => effect.kind === "reconcile_job")?.payload).toEqual({ threadId: "thr_i" });
});

it("rejects continuing a review-limit block while another job is active", () => {
  const { db, store } = storeFixture();
  const blocked = store.createJob({ id: "job_blocked", sourceUpdateId: 101, requestText: "blocked", now: 1_000 });
  db.prepare("UPDATE jobs SET state = 'blocked', blocked_reason = 'review_limit', review_cycle = 3 WHERE id = ?").run(blocked.id);
  const active = store.createJob({ id: "job_active", sourceUpdateId: 102, requestText: "active", now: 1_100 });

  expect(() => store.applyJobEvent(blocked.id, 1, { type: "CONTINUE_REVIEW" }, 1_200)).toThrow(
    ActiveJobConflictError,
  );
  expect(store.getJob(blocked.id)?.state).toBe("blocked");
  expect(store.getJob(active.id)?.state).toBe("awaiting_project");
});

it("keeps head receipts guarded by the pure transition before persisting validation", () => {
  const { store } = storeFixture();
  const job = store.createJob({ id: "job_1", sourceUpdateId: 101, requestText: "do it", now: 1_000 });
  const selected = store.applyJobEvent(job.id, job.version, { type: "PROJECT_SELECTED", projectId: "proj_1", policyVersion: 1, policy: policyFixture() }, 1_100);
  const confirmed = store.applyJobEvent(job.id, selected.version, { type: "CONFIRMED" }, 1_200);
  const created = store.applyJobEvent(job.id, confirmed.version, { type: "IMPLEMENTATION_CREATED", threadId: "thr_i", environmentId: "env_1" }, 1_300);
  const implementing = store.applyJobEvent(job.id, created.version, { type: "IMPLEMENTATION_IDLE" }, 1_400);
  const locating = store.applyJobEvent(job.id, implementing.version, { type: "PR_LOCATED", number: 7, url: "https://github.test/pr/7" }, 1_500);
  const resolving = store.applyJobEvent(job.id, locating.version, { type: "PR_HEAD_RESOLVED", headSha: sha() }, 1_600);

  expect(resolving.state).toBe("reviewing");
  expect(resolving.prHeadSha).toBe(sha());
  expect(store.listEffectsForJob(job.id).map((effect) => effect.kind)).toEqual([
    "render_status",
    "spawn_implementation",
    "render_status",
    "inspect_implementation",
    "revoke_approvals",
    "resolve_pr_head",
    "spawn_review",
  ]);
});
