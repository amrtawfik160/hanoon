import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";
import { buildHealthReport } from "../src/services/health-report";
import type { JobLaneSnapshot } from "../src/services/job-lane-runner";
import { EXPECTED_MIGRATION_ID, type RuntimeIdentity } from "../src/services/runtime-identity";

const NOW = 1_800_000_000_000;
const EMPTY_LANES: JobLaneSnapshot = { pipelineActive: 0, controlActive: 0, busyJobIds: [] };

let fixtureNumber = 0;
function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-agent-health-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => NOW);
  store.createPairingCode(hashSecret("pair-health"), NOW - 1_000, NOW + 10_000);
  expect(store.pairOwnerWithPrivateChatCode(hashSecret("pair-health"), "7", "70", NOW - 500)).toEqual({ ok: true });
  return { db: bb.storage.database(), store };
}

it("reports a healthy agent with nothing outstanding", () => {
  const { db, store } = fixture();
  expect(store.acquireExecutorLease("executor", NOW, 30_000).acquired).toBe(true);

  const report = buildHealthReport(db, NOW, 2, EMPTY_LANES);

  expect(report).toMatchObject({
    ok: true,
    problems: [],
    executor: { current: true },
    work: { pendingEffects: 0, deadEffects: 0 },
    memory: { live: 0, searchable: true },
    database: { integrity: "ok" },
  });
});

it("names what is wrong when the executor has stopped", () => {
  const { db } = fixture();

  const report = buildHealthReport(db, NOW, 2, EMPTY_LANES);

  expect(report.ok).toBe(false);
  expect(report.problems).toContain("the executor lease is not current");
});

it("makes a stale activation visible in the existing health report", () => {
  const { db, store } = fixture();
  expect(store.acquireExecutorLease("executor", NOW, 30_000).acquired).toBe(true);
  const runtime: RuntimeIdentity = {
    sourceRoot: "/registered/plugin",
    loadedAt: NOW - 10_000,
    loadedFingerprint: "old-build",
    expectedMigrationId: EXPECTED_MIGRATION_ID,
    currentFingerprint: () => "new-build",
  };

  const report = buildHealthReport(db, NOW, 2, EMPTY_LANES, runtime);

  expect(report.ok).toBe(false);
  expect(report.activation).toMatchObject({
    sourceRoot: "/registered/plugin",
    sourceChanged: true,
    expectedMigrationId: EXPECTED_MIGRATION_ID,
    appliedMigrationId: EXPECTED_MIGRATION_ID,
  });
  expect(report.problems).toContain("source changed since activation; reload required");
});

it("surfaces a stale executor heartbeat even while its lease still looks current", () => {
  const { db, store } = fixture();
  expect(store.acquireExecutorLease("executor", NOW - 60_000, 120_000).acquired).toBe(true);

  const report = buildHealthReport(db, NOW, 2, EMPTY_LANES);

  expect(report).toMatchObject({
    ok: false,
    executor: {
      current: false,
      heartbeatAt: NOW - 60_000,
      heartbeatAgeMs: 60_000,
      heartbeatStale: true,
    },
  });
  expect(report.problems).toContain("the executor heartbeat is stale");

  db.prepare("UPDATE executor_lease SET lease_expires_at = ? WHERE singleton = 1").run(NOW - 1);
  expect(buildHealthReport(db, NOW, 2, EMPTY_LANES).problems).toEqual(expect.arrayContaining([
    "the executor lease is not current",
    "the executor heartbeat is stale",
  ]));
});

it("surfaces undelivered messages and failed Telegram updates", () => {
  const { db, store } = fixture();
  expect(store.acquireExecutorLease("executor", NOW, 30_000).acquired).toBe(true);
  db.prepare(
    `INSERT INTO outbox (logical_key, chat_id, message_id, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES ('job:x:status', '70', NULL, '{}', 'dead', 20, ?, ?, ?)`,
  ).run(NOW, NOW, NOW);
  expect(store.beginTelegramUpdate(11, NOW)).toBe("process");
  store.failTelegramUpdate(11, "Telegram API 400", NOW);

  const report = buildHealthReport(db, NOW, 2, EMPTY_LANES);

  expect(report.ok).toBe(false);
  expect(report.problems).toEqual(expect.arrayContaining([
    "1 message(s) could not be delivered",
    "1 Telegram update(s) failed",
  ]));
});

it("counts what the agent is watching and remembering", () => {
  const { db, store } = fixture();
  expect(store.acquireExecutorLease("executor", NOW, 30_000).acquired).toBe(true);
  store.rememberMemory({
    scope: "owner",
    kind: "preference",
    subject: "deploy window",
    body: "Weekday mornings only.",
    source: "owner",
    now: NOW,
  });
  store.createMonitor({
    controllerKey: "owner-7-controller",
    kind: "thread_idle",
    threadId: "thr_watched",
    instruction: "Report when it lands.",
    dueAt: null,
    now: NOW,
  });

  expect(buildHealthReport(db, NOW, 2, EMPTY_LANES)).toMatchObject({
    ok: true,
    monitors: { armed: 1, failed: 0 },
    memory: { live: 1, searchable: true },
  });
});

it("reports durable admissions, live lanes, queue age, and held resource kinds separately", () => {
  const { db, store } = fixture();
  expect(store.acquireExecutorLease("executor", NOW, 30_000).acquired).toBe(true);
  const states = ["admitted", "draining", "queued", "queued"] as const;
  for (let index = 0; index < states.length; index += 1) {
    const jobId = `health-job-${index}`;
    db.prepare(
      "INSERT INTO jobs (id, source_update_id, request_text, state, created_at, updated_at) VALUES (?, ?, ?, 'planning', ?, ?)",
    ).run(jobId, 100 + index, `job ${index}`, NOW - 10_000, NOW - 10_000);
    db.prepare(
      `INSERT INTO job_admissions (
         job_id, project_id, queue_seq, state, resume_event, queued_at,
         admitted_at, draining_at
       ) VALUES (?, ?, ?, ?, 'CONFIRMED', ?, ?, ?)`,
    ).run(
      jobId,
      `proj_${index}`,
      index + 1,
      states[index],
      NOW - (index === 2 ? 5_000 : 2_000),
      states[index] === "queued" ? null : NOW - 1_000,
      states[index] === "draining" ? NOW - 500 : null,
    );
  }
  const claimKinds = ["project", "project", "repository_merge", "production_target"] as const;
  for (let index = 0; index < claimKinds.length; index += 1) {
    db.prepare(
      `INSERT INTO job_resource_claims (
         job_id, resource_key, resource_kind, state, owner_id, generation,
         lease_expires_at, acquired_at, renewed_at
       ) VALUES (?, ?, ?, 'held', 'executor', 1, ?, ?, ?)`,
    ).run(`health-job-${index}`, `resource:${index}`, claimKinds[index], NOW + 30_000, NOW, NOW);
  }
  const lanes: JobLaneSnapshot = { pipelineActive: 2, controlActive: 1, busyJobIds: ["health-job-0", "health-job-1"] };

  expect(buildHealthReport(db, NOW, 2, lanes)).toMatchObject({
    ok: true,
    autonomy: {
      maxConcurrentJobs: 2,
      admittedJobs: 1,
      drainingJobs: 1,
      queuedJobs: 2,
      occupiedJobs: 2,
      availableSlots: 0,
      pipelineActive: 2,
      controlActive: 1,
      oldestQueueAgeMs: 5_000,
      heldResources: {
        total: 4,
        project: 2,
        repositoryMerge: 1,
        productionTarget: 1,
      },
    },
  });
  expect(buildHealthReport(db, NOW, 1, lanes)).toMatchObject({
    ok: true,
    autonomy: { maxConcurrentJobs: 1, occupiedJobs: 2, availableSlots: 0 },
  });

  const invalid = buildHealthReport(db, NOW, null, lanes);
  expect(invalid).toMatchObject({
    ok: false,
    autonomy: { maxConcurrentJobs: null, availableSlots: null },
  });
  expect(invalid.problems).toContain("concurrency configuration is invalid");
});

it("names a paused project, because otherwise the jam it causes has no visible cause", () => {
  // The live fault: five queued jobs, five free slots, nothing held, none
  // admitted. The brake was the whole explanation and the report never said so,
  // so the agent reported a broken pipeline for five and a half hours.
  const { db, store } = fixture();
  store.pauseProjectAdmission({
    projectId: "proj_paused",
    reason: "the same failure repeated 3 times",
    fingerprint: "a".repeat(64),
    now: 1_000,
  });

  const report = buildHealthReport(db, 2_000, 5, EMPTY_LANES);

  expect(report.autonomy.pausedProjects).toEqual([
    { projectId: "proj_paused", reason: "the same failure repeated 3 times", pausedAtMs: 1_000 },
  ]);
  expect(report.problems.join(" ")).toContain("paused by the failure brake");
  expect(report.problems.join(" ")).toContain("/resume");
});

it("says nothing about pauses when none is held", () => {
  const { db } = fixture();
  const report = buildHealthReport(db, 2_000, 5, EMPTY_LANES);
  expect(report.autonomy.pausedProjects).toEqual([]);
  expect(report.problems.join(" ")).not.toContain("failure brake");
});
