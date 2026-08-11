import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { ALL_MIGRATIONS } from "../src/storage/migrations";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import {
  JobMemoryService,
  MEMORABLE_JOB_OUTCOMES,
  parseExtractedMemories,
} from "../src/services/job-memory-service";
import { admitConfirmedJob, policyFixture } from "./helpers";

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
  // path to a genuinely terminal blocked job.
  const cancelling = store.applyJobEvent(admitted.id, admitted.version, {
    type: "CANCEL_REQUESTED",
    activeWorker: null,
  }, 2_003);
  return store.applyJobEvent(cancelling.id, cancelling.version, {
    type: "CANCELLATION_UNCONFIRMED",
    reason: "the migration guard keeps rejecting the tail",
  }, 2_004);
}

function service(
  store: TelegramAgentStore,
  threads: {
    spawnHidden?: (input: { projectId: string; title: string; prompt: string }) => Promise<string>;
    status?: (threadId: string) => Promise<"idle" | "active" | "error" | "missing">;
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

it("leaves the extraction pending when the thread cannot be spawned", async () => {
  const { store } = fixture();
  finishedJob(store, "job_blocked", "blocked");
  const { service: pass } = service(store, {
    spawnHidden: async () => { throw new Error("no connected host"); },
  });

  await expect(pass.processDue()).resolves.toBe(false);

  expect(store.listJobMemoryExtractions("pending", 10)).toHaveLength(1);
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
