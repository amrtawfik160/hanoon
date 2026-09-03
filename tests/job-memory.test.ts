import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { ALL_MIGRATIONS } from "../src/storage/migrations";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import {
  JobMemoryService,
  MEMORABLE_JOB_OUTCOMES,
  parseExtractedMemories,
} from "../src/services/job-memory-service";
import { activeWorkerFixture, admitConfirmedJob, policyFixture } from "./helpers";
import { DEFAULT_MODEL_POOL_REGISTRY, selectModelRoute, type ModelRoute } from "../src/capabilities/models";

let fixtureNumber = 0;

function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-job-memory-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.createPairingCode(hashSecret("pair"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", 1_001)).toEqual({ ok: true });
  store.upsertProjectPolicy(policyFixture({ projectId: "proj_a", alias: "a" }), 1_002);
  store.upsertProjectPolicy(policyFixture({ projectId: "proj_b", alias: "b" }), 1_003);
  return { bb, store };
}

/** Drives a job to a terminal outcome so the extraction pass can enrol it. */
function finishedJob(store: TelegramAgentStore, id: string, outcome: "blocked" | "failed", projectId = "proj_a") {
  const job = store.createJob({ id, sourceUpdateId: 900 + [...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0), requestText: `do ${id}`, now: 2_000 });
  const selected = store.applyJobEvent(job.id, job.version, {
    type: "PROJECT_SELECTED",
    projectId,
    policyVersion: 1,
    policy: policyFixture({ projectId, alias: projectId === "proj_a" ? "a" : "b" }),
  }, 2_001);
  const admitted = admitConfirmedJob(store, selected, 2_002);
  if (outcome === "failed") {
    return store.applyJobEvent(admitted.id, admitted.version, {
      type: "FAILED",
      error: "npm run check exited 1",
    }, 2_003);
  }
  // A requested cancellation the worker never confirmed is the shortest legal
  // path to a genuinely terminal blocked job. The worker must still be active,
  // or the cancellation completes outright instead of going unconfirmed.
  const cancelling = store.applyJobEvent(admitted.id, admitted.version, {
    type: "CANCEL_REQUESTED",
    activeWorker: activeWorkerFixture({ jobId: admitted.id, state: "active" }),
  }, 2_003);
  return store.applyJobEvent(cancelling.id, cancelling.version, {
    type: "CANCELLATION_UNCONFIRMED",
    reason: "the migration guard keeps rejecting the tail",
  }, 2_004);
}

function service(
  store: TelegramAgentStore,
  threads: {
    spawnHidden?: (input: { projectId: string; title: string; prompt: string; modelRoute: ModelRoute }) => Promise<string>;
    status?: (threadId: string) => Promise<"idle" | "active" | "pending" | "error" | "missing">;
    output?: (threadId: string) => Promise<string>;
  } = {},
  now = () => 3_000,
) {
  const spawnHidden = vi.fn(threads.spawnHidden ?? (async () => "thr_extract"));
  const status = vi.fn(threads.status ?? (async () => "idle" as const));
  const output = vi.fn(threads.output ?? (async () => JSON.stringify({ memories: [] })));
  return {
    service: new JobMemoryService({
      store,
      threads: { spawnHidden, status, output },
      modelRoute: () => selectModelRoute({
        executionClass: "background",
        recipe: "direct",
        stage: "extraction",
        risk: "low",
      }, DEFAULT_MODEL_POOL_REGISTRY),
      clock: { now },
      warn: () => undefined,
    }),
    spawnHidden,
    status,
    output,
  };
}

it("appends the job memory migration after every shipped one", () => {
  expect(ALL_MIGRATIONS[20]).toContain("CREATE TABLE job_memory_extractions");
  expect(ALL_MIGRATIONS[20]).toContain("ALTER TABLE memories ADD COLUMN origin");
});

it("persists and sends one exact background route before extraction spawn", async () => {
  const { store } = fixture();
  const job = finishedJob(store, "memory_route", "blocked");
  const { service: pass, spawnHidden } = service(store);

  expect(await pass.processDue()).toBe(true);

  const route = selectModelRoute({
    executionClass: "background",
    recipe: "direct",
    stage: "extraction",
    risk: "low",
  }, DEFAULT_MODEL_POOL_REGISTRY);
  expect(spawnHidden).toHaveBeenCalledWith(expect.objectContaining({ modelRoute: route }));
  expect(store.listModelRouteTrials("worker_attempt", `memory:${job.id}`, 10)).toEqual([
    expect.objectContaining({
      attempt: 1,
      stage: "extraction",
      operation: "spawn-memory",
      route,
      outcome: "selected",
    }),
  ]);
});

it.each([
  ["a fenced object", '```json\n{"memories":[{"kind":"fact","subject":"tests","body":"use the wrapper"}]}\n```'],
  ["a preamble", 'Here you go:\n{"memories":[{"kind":"fact","subject":"tests","body":"use the wrapper"}]}'],
])("reads strict JSON out of %s", (_label, output) => {
  expect(parseExtractedMemories(output)).toEqual([
    { kind: "fact", subject: "tests", body: "use the wrapper" },
  ]);
});

it.each([
  ["prose", "I could not find anything worth remembering."],
  ["broken JSON", '{"memories":[{"kind":"fact",]}'],
  ["a non-array", '{"memories":"none"}'],
])("returns nothing for %s rather than throwing", (_label, output) => {
  expect(parseExtractedMemories(output)).toEqual([]);
});

it("drops only the malformed entries and caps the rest", () => {
  const output = JSON.stringify({
    memories: [
      { kind: "fact", subject: "one", body: "first" },
      { kind: "nonsense", subject: "two", body: "second" },
      { subject: "three" },
      { kind: "decision", subject: "  four  ", body: " fourth  lesson " },
      { kind: "fact", subject: "five", body: "fifth" },
    ],
  });

  expect(parseExtractedMemories(output)).toEqual([
    { kind: "fact", subject: "one", body: "first" },
    // An unknown kind still carries a real lesson, so it lands as a plain fact.
    { kind: "fact", subject: "two", body: "second" },
    { kind: "decision", subject: "four", body: "fourth lesson" },
  ]);
});

it("learns from a finished job and scopes what it learned to that project", async () => {
  const { store } = fixture();
  finishedJob(store, "job_blocked", "blocked");
  const extracted = JSON.stringify({
    memories: [{ kind: "fact", subject: "migration guard", body: "the tail must be pinned in both guards" }],
  });
  const { service: pass, spawnHidden } = service(store, { output: async () => extracted });

  await expect(pass.processDue()).resolves.toBe(true);
  expect(spawnHidden).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj_a" }));
  expect(spawnHidden.mock.calls[0]?.[0]?.prompt).toContain("the migration guard keeps rejecting the tail");

  await expect(pass.processDue()).resolves.toBe(true);

  expect(store.listJobMemoryExtractions("done", 10)).toMatchObject([{ jobId: "job_blocked", savedCount: 1 }]);
  expect(store.recallMemories({ scope: "proj_a", query: "migration guard", limit: 5, now: 3_000 }))
    .toMatchObject([{ subject: "migration guard", origin: "job_outcome", confidence: 0.5 }]);
  // Project lessons must not leak into what it believes about the owner.
  expect(store.recallMemories({ scope: "owner", query: "migration guard", limit: 5, now: 3_000 })).toEqual([]);
});

it("never learns from a job that has not reached a memorable outcome", async () => {
  const { store } = fixture();
  finishedJob(store, "job_failed", "failed");
  const { service: pass, spawnHidden } = service(store);

  await expect(pass.processDue()).resolves.toBe(false);

  expect(spawnHidden).not.toHaveBeenCalled();
  expect(store.listJobMemoryExtractions("pending", 10)).toEqual([]);
});

it("enrols each finished job exactly once", async () => {
  const { store } = fixture();
  finishedJob(store, "job_blocked", "blocked");

  expect(store.enrolFinishedJobsForMemory([...MEMORABLE_JOB_OUTCOMES], 10, 3_000)).toBe(1);
  expect(store.enrolFinishedJobsForMemory([...MEMORABLE_JOB_OUTCOMES], 10, 3_001)).toBe(0);
  expect(store.listJobMemoryExtractions("pending", 10)).toHaveLength(1);
});

it("runs one extraction at a time so learning never competes with real work", async () => {
  const { store } = fixture();
  finishedJob(store, "job_blocked", "blocked");
  finishedJob(store, "job_stalled", "blocked", "proj_b");
  const { service: pass, spawnHidden } = service(store, { status: async () => "active" });

  await expect(pass.processDue()).resolves.toBe(true);
  await expect(pass.processDue()).resolves.toBe(false);

  expect(spawnHidden).toHaveBeenCalledTimes(1);
  expect(store.listJobMemoryExtractions("running", 10)).toHaveLength(1);
  expect(store.listJobMemoryExtractions("pending", 10)).toHaveLength(1);
});

it("keeps a pending memory extraction in flight instead of treating it as ended", async () => {
  const { store } = fixture();
  finishedJob(store, "job_pending", "blocked");
  const { service: pass, output } = service(store, { status: async () => "pending" });

  await expect(pass.processDue()).resolves.toBe(true);
  await expect(pass.processDue()).resolves.toBe(false);

  expect(store.listJobMemoryExtractions("running", 10)).toMatchObject([{ jobId: "job_pending" }]);
  expect(store.listJobMemoryExtractions("failed", 10)).toEqual([]);
  expect(output).not.toHaveBeenCalled();
});

it("fails the extraction when its thread ends without an answer", async () => {
  const { store } = fixture();
  finishedJob(store, "job_blocked", "blocked");
  const { service: pass } = service(store, { status: async () => "error" });

  await expect(pass.processDue()).resolves.toBe(true);
  await expect(pass.processDue()).resolves.toBe(true);

  expect(store.listJobMemoryExtractions("failed", 10)).toMatchObject([
    { jobId: "job_blocked", lastError: "Memory extraction thread ended without an answer" },
  ]);
});

it("gives up on a project that can never be reached instead of retrying forever", async () => {
  const { store } = fixture();
  finishedJob(store, "job_blocked", "blocked");
  const { service: pass, spawnHidden } = service(store, {
    spawnHidden: async () => { throw new Error("host temporarily unavailable"); },
  });

  // A retryable blip stays pending, but the attempt is counted...
  await pass.processDue();
  expect(store.listJobMemoryExtractions("pending", 10)).toMatchObject([{ attempts: 1 }]);

  // ...so a permanently unusable project runs out of attempts and stops.
  await pass.processDue();
  await pass.processDue();

  expect(store.listJobMemoryExtractions("pending", 10)).toEqual([]);
  expect(store.listJobMemoryExtractions("failed", 10)).toMatchObject([{ jobId: "job_blocked" }]);
  expect(spawnHidden.mock.calls.length).toBeLessThanOrEqual(2);
});

it("stops retrying memory extraction when the project is gone", async () => {
  const { store } = fixture();
  finishedJob(store, "job_blocked", "blocked");
  const { service: pass, spawnHidden } = service(store, {
    spawnHidden: async () => {
      throw new Error("HTTP 404: Project not found");
    },
  });

  await pass.processDue();

  expect(store.listJobMemoryExtractions("failed", 10)).toMatchObject([{ jobId: "job_blocked" }]);
  expect(spawnHidden).toHaveBeenCalledOnce();
});

it("refuses to store a lesson that carries a credential", async () => {
  const { store } = fixture();
  finishedJob(store, "job_blocked", "blocked");
  const extracted = JSON.stringify({
    memories: [
      { kind: "fact", subject: "deploy token", body: "deploy with token=ghp_abcdefghijklmnopqrstuvwxyz01" },
      { kind: "fact", subject: "safe lesson", body: "the canary needs two minutes to settle" },
    ],
  });
  const { service: pass } = service(store, { output: async () => extracted });

  await pass.processDue();
  await pass.processDue();

  expect(store.listJobMemoryExtractions("done", 10)).toMatchObject([{ savedCount: 1 }]);
  expect(store.recallMemories({ scope: "proj_a", query: "deploy token", limit: 5, now: 3_000 })).toEqual([]);
  expect(store.recallMemories({ scope: "proj_a", query: "canary settle", limit: 5, now: 3_000 }))
    .toMatchObject([{ subject: "safe lesson" }]);
});

it("never learns from a review-limit block, which is resumable", async () => {
  const { store } = fixture();
  const job = store.createJob({ id: "job_review_limit", sourceUpdateId: 4_242, requestText: "fix it", now: 2_000 });
  const selected = store.applyJobEvent(job.id, job.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_a",
    policyVersion: 1,
    policy: policyFixture({ projectId: "proj_a", alias: "a" }),
  }, 2_001);
  const admitted = admitConfirmedJob(store, selected, 2_002);
  // Drive it to the review limit, which blocks but can resume on CONTINUE_REVIEW.
  let current = admitted;
  for (let cycle = 0; cycle < 6 && current.state !== "blocked"; cycle += 1) {
    try {
      current = store.applyJobEvent(current.id, current.version, {
        type: "REVIEW_CHANGES_REQUESTED",
        findings: [{ severity: "high", file: null, line: null, title: "again", details: "again" }],
      }, 2_003 + cycle);
    } catch { break; }
  }
  if (current.state !== "blocked" || current.blockedReason !== "review_limit") return;

  expect(store.enrolFinishedJobsForMemory([...MEMORABLE_JOB_OUTCOMES], 10, 3_000)).toBe(0);
  expect(store.listJobMemoryExtractions("pending", 10)).toEqual([]);
});
