import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { REVERT_WINDOW_MS, decideCrashRevert, type RevertPolicy } from "../src/autonomy/crash-revert";
import type { ProjectPolicy } from "../src/domain/models";
import { hashSecret } from "../src/crypto";
import { CrashRevertService } from "../src/services/crash-revert-service";
import { openStore, type CompletedMergeRecord, type TelegramAgentStore } from "../src/storage/store";
import { policyFixture } from "./helpers";

let fixtureNumber = 0;
const NOW = 1_800_000_000_000;
const PROJECT = "proj_alpha";
const MERGE_SHA = "a".repeat(40);

function merge(overrides: Partial<CompletedMergeRecord> = {}): CompletedMergeRecord {
  return {
    jobId: "job_merged",
    mergeCommitSha: MERGE_SHA,
    mergedAt: NOW - 60_000,
    unattended: true,
    automaticRevert: false,
    ...overrides,
  };
}

/** A project whose own policy asked for unattended delivery. */
function declared(): RevertPolicy {
  return { enabled: true, autonomy: { unattendedMerge: true, mergeWithoutProduction: false } };
}

it("reverts only when the last merge here was one nobody was asked about", () => {
  expect(decideCrashRevert({ merge: merge(), policy: declared(), now: NOW }).outcome).toBe("revert");
  // The owner approved the last merge, so undoing it is their call, not this one's.
  expect(decideCrashRevert({ merge: merge({ unattended: false }), policy: declared(), now: NOW })).toMatchObject({
    outcome: "investigate",
  });
  expect(decideCrashRevert({ merge: null, policy: declared(), now: NOW })).toMatchObject({ outcome: "investigate" });
});

it("reverts nothing for a project whose policy never asked to merge unattended", () => {
  // Starting a repository change nobody requested is what the policy opts into.
  // A standing approval the owner tapped means only "merge this without asking".
  for (const policy of [
    null,
    { enabled: true, autonomy: undefined } as RevertPolicy,
    { enabled: true, autonomy: { unattendedMerge: false, mergeWithoutProduction: false } } as RevertPolicy,
    { enabled: false, autonomy: { unattendedMerge: true, mergeWithoutProduction: false } } as RevertPolicy,
  ]) {
    expect(decideCrashRevert({ merge: merge(), policy, now: NOW })).toMatchObject({
      outcome: "investigate",
    });
  }
});

it("will not revert a revert, which would put the broken merge back", () => {
  expect(decideCrashRevert({
    merge: merge({ automaticRevert: true }),
    policy: declared(),
    now: NOW,
  })).toMatchObject({ outcome: "investigate" });
});

it("will not blame a merge that landed too long ago to be the cause", () => {
  expect(decideCrashRevert({
    merge: merge({ mergedAt: NOW - REVERT_WINDOW_MS + 1_000 }),
    policy: declared(),
    now: NOW,
  }).outcome).toBe("revert");
  expect(decideCrashRevert({
    merge: merge({ mergedAt: NOW - REVERT_WINDOW_MS - 1_000 }),
    policy: declared(),
    now: NOW,
  })).toMatchObject({ outcome: "investigate" });
  // A merge timestamped in the future is unreadable evidence, not fresh evidence.
  expect(decideCrashRevert({ merge: merge({ mergedAt: NOW + 60_000 }), policy: declared(), now: NOW })).toMatchObject({
    outcome: "investigate",
  });
});

/** The policy a project must carry before anything here starts by itself. */
function unattendedPolicy(): ProjectPolicy {
  return policyFixture({
    projectId: PROJECT,
    alias: "alpha",
    enabled: true,
    production: {
      ...policyFixture().production!,
      rollbackCommand: { name: "rollback", command: "./rollback.sh", timeoutMs: 60_000 },
    },
    autonomy: { unattendedMerge: true, mergeWithoutProduction: false },
  });
}

function fixture(policy: ProjectPolicy = unattendedPolicy()): {
  store: TelegramAgentStore;
  database: ReturnType<ReturnType<typeof createFakePluginHost>["bb"]["storage"]["database"]>;
} {
  const { bb } = createFakePluginHost({ pluginId: `telegram-crash-revert-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => NOW);
  store.createPairingCode(hashSecret("pair"), NOW - 10_000, NOW + 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", NOW - 5_000)).toEqual({ ok: true });
  store.upsertProjectPolicy(policy, NOW - 3_000);
  return { store, database: bb.storage.database() };
}

/** A merge that already landed, exactly as the pipeline leaves one behind. */
function recordMerge(
  input: {
    store: TelegramAgentStore;
    database: ReturnType<typeof fixture>["database"];
    jobId: string;
    sha: string;
    mergedAt: number;
    unattended: boolean;
  },
): void {
  input.database.prepare(
    `INSERT INTO jobs (
       id, source_update_id, request_text, state, delivery_mode, task_recipe,
       recipe_version, recipe_promotion_count, routing_mode, task_traits_json,
       task_reason_codes_json, project_id, merge_commit_sha, merged_at,
       review_cycle, review_block_at, version, created_at, updated_at
     ) VALUES (?, ?, 'earlier work', 'merged', 'full', 'bounded', 1, 0, 'legacy', '[]', '[]', ?, ?, ?, 0, 3, 1, ?, ?)`,
  ).run(
    input.jobId,
    Math.abs(hashJobId(input.jobId)),
    PROJECT,
    input.sha,
    new Date(input.mergedAt).toISOString(),
    input.mergedAt,
    input.mergedAt,
  );
  if (input.unattended) {
    input.store.recordMergeAuthorityUse({ projectId: PROJECT, jobId: input.jobId, now: input.mergedAt });
  }
}

function hashJobId(jobId: string): number {
  let value = 7;
  for (const character of jobId) value = (value * 31 + character.charCodeAt(0)) % 1_000_000;
  return value;
}

/**
 * A started revert job carried all the way through: reviewed, merged on the
 * same standing grant, and out of the project's way.
 */
function landRevert(
  store: TelegramAgentStore,
  database: ReturnType<typeof fixture>["database"],
  jobId: string,
  sha: string,
  mergedAt: number,
): void {
  database.prepare(
    "UPDATE jobs SET state = 'merged', merge_commit_sha = ?, merged_at = ?, updated_at = ? WHERE id = ?",
  ).run(sha, new Date(mergedAt).toISOString(), mergedAt, jobId);
  database.prepare(
    "UPDATE job_admissions SET state = 'released', released_at = ?, release_reason = 'test' WHERE job_id = ?",
  ).run(mergedAt, jobId);
  store.recordMergeAuthorityUse({ projectId: PROJECT, jobId, now: mergedAt });
}

function service(store: TelegramAgentStore) {
  return new CrashRevertService({ store, warn: () => {} });
}

it("starts nothing for a project whose only standing approval is the owner's button", () => {
  // The button predates unattended delivery and means what it always meant:
  // merge this reviewed job without asking. It does not start work.
  const { store, database } = fixture(policyFixture({ projectId: PROJECT, alias: "alpha", enabled: true }));
  store.grantMergeAuthority({ projectId: PROJECT, userId: "7", chatId: "7", now: NOW - 2_000 });
  recordMerge({ store, database, jobId: "job_merged", sha: MERGE_SHA, mergedAt: NOW - 60_000, unattended: true });

  expect(service(store).start({ projectId: PROJECT, alias: "alpha", now: NOW })).toMatchObject({
    outcome: "investigate",
    reason: expect.stringContaining("has not asked to merge unattended"),
  });
  expect(store.getCrashRevertJob(MERGE_SHA)).toBeNull();
});

it("does not revert its own revert when production breaks again", () => {
  // Reverting a revert re-applies the merge that broke production, through the
  // same standing grant. The chain stops at one.
  const { store, database } = fixture();
  recordMerge({ store, database, jobId: "job_merged", sha: MERGE_SHA, mergedAt: NOW - 60_000, unattended: true });
  const first = service(store).start({ projectId: PROJECT, alias: "alpha", now: NOW });
  if (first.outcome !== "started") throw new Error("the first revert should have started");

  const revertSha = "e".repeat(40);
  landRevert(store, database, first.jobId, revertSha, NOW + 60_000);
  // The revert is the latest merge here, it was unattended, and it is well
  // inside the window: every other condition for a second revert is met.
  expect(store.getLatestCompletedMerge(PROJECT)).toMatchObject({
    mergeCommitSha: revertSha,
    unattended: true,
    automaticRevert: true,
  });

  const second = service(store).start({
    projectId: PROJECT,
    alias: "alpha",
    now: NOW + 12 * 60 * 60_000,
  });

  expect(second).toMatchObject({
    outcome: "investigate",
    reason: expect.stringContaining("itself an automatic revert"),
  });
  expect(store.getCrashRevertJob(revertSha)).toBeNull();
});

it("starts one revert job through the ordinary pipeline", () => {
  const { store, database } = fixture();
  recordMerge({ store, database, jobId: "job_merged", sha: MERGE_SHA, mergedAt: NOW - 60_000, unattended: true });

  const outcome = service(store).start({ projectId: PROJECT, alias: "alpha", now: NOW });

  expect(outcome).toMatchObject({ outcome: "started", mergeCommitSha: MERGE_SHA });
  if (outcome.outcome !== "started") throw new Error("the revert should have started");
  const job = store.getJob(outcome.jobId);
  expect(job).toMatchObject({
    projectId: PROJECT,
    state: "awaiting_confirmation",
    autonomousOrigin: "crash_revert",
    workflowEngine: "navigator-v1",
    routingMode: "legacy",
  });
  expect(job?.taskRecipe).not.toBe("bug");
  expect(job?.requestText).toContain(MERGE_SHA);
  // Queued for the executor like everything else, never pushed out of band.
  expect(store.getAdmission(outcome.jobId)?.state).toBe("queued");
  expect(store.getCrashRevertJob(MERGE_SHA)).toMatchObject({ jobId: outcome.jobId, mergedJobId: "job_merged" });
});

it("reverts one merge commit once, ever", () => {
  const { store, database } = fixture();
  recordMerge({ store, database, jobId: "job_merged", sha: MERGE_SHA, mergedAt: NOW - 60_000, unattended: true });
  const first = service(store).start({ projectId: PROJECT, alias: "alpha", now: NOW });
  expect(first.outcome).toBe("started");
  if (first.outcome !== "started") throw new Error("the revert should have started");

  // The revert job itself is out of the way, and production is still broken.
  database.prepare(
    "UPDATE job_admissions SET state = 'released', released_at = ?, release_reason = 'test' WHERE job_id = ?",
  ).run(NOW + 1, first.jobId);
  database.prepare("UPDATE jobs SET state = 'failed', updated_at = ? WHERE id = ?").run(NOW + 1, first.jobId);

  expect(service(store).start({ projectId: PROJECT, alias: "alpha", now: NOW + 2 })).toMatchObject({
    outcome: "investigate",
    reason: expect.stringContaining("already had its one automatic revert"),
  });
});

it("investigates instead when the failure brake is holding the project", () => {
  const { store, database } = fixture();
  recordMerge({ store, database, jobId: "job_merged", sha: MERGE_SHA, mergedAt: NOW - 60_000, unattended: true });
  store.pauseProjectAdmission({
    projectId: PROJECT,
    reason: "the same failure repeated 3 times",
    fingerprint: "abc",
    now: NOW,
  });

  expect(service(store).start({ projectId: PROJECT, alias: "alpha", now: NOW })).toMatchObject({
    outcome: "investigate",
    reason: expect.stringContaining("failure brake"),
  });
  expect(store.getCrashRevertJob(MERGE_SHA)).toBeNull();
});

it("investigates instead when the project already has work running", () => {
  const { store, database } = fixture();
  recordMerge({ store, database, jobId: "job_merged", sha: MERGE_SHA, mergedAt: NOW - 60_000, unattended: true });
  expect(service(store).start({ projectId: PROJECT, alias: "alpha", now: NOW }).outcome).toBe("started");

  const second = "b".repeat(40);
  recordMerge({ store, database, jobId: "job_merged_2", sha: second, mergedAt: NOW - 30_000, unattended: true });
  expect(service(store).start({ projectId: PROJECT, alias: "alpha", now: NOW + 1 })).toMatchObject({
    outcome: "investigate",
    reason: expect.stringContaining("already has work running"),
  });
  expect(store.getCrashRevertJob(second)).toBeNull();
});

it("investigates instead when the last merge here was the owner's", () => {
  const { store, database } = fixture();
  recordMerge({ store, database, jobId: "job_merged", sha: MERGE_SHA, mergedAt: NOW - 60_000, unattended: false });

  expect(service(store).start({ projectId: PROJECT, alias: "alpha", now: NOW })).toMatchObject({
    outcome: "investigate",
  });
  expect(store.getCrashRevertJob(MERGE_SHA)).toBeNull();
});

it("does not revert an old unattended merge just because a newer one is the owner's", () => {
  // The question is what landed last, not whether an unattended merge ever did.
  const { store, database } = fixture();
  recordMerge({ store, database, jobId: "job_old", sha: MERGE_SHA, mergedAt: NOW - 120_000, unattended: true });
  const newer = "c".repeat(40);
  recordMerge({ store, database, jobId: "job_new", sha: newer, mergedAt: NOW - 60_000, unattended: false });

  expect(service(store).start({ projectId: PROJECT, alias: "alpha", now: NOW })).toMatchObject({
    outcome: "investigate",
  });
});

it("investigates instead when the merge history cannot be read", () => {
  const { store } = fixture();
  const unreadable: TelegramAgentStore = Object.create(store, {
    getLatestCompletedMerge: {
      value: () => {
        throw new Error("database is locked");
      },
    },
  }) as TelegramAgentStore;
  const warn = vi.fn();

  expect(new CrashRevertService({ store: unreadable, warn }).start({
    projectId: PROJECT,
    alias: "alpha",
    now: NOW,
  })).toMatchObject({ outcome: "investigate" });
  expect(warn).toHaveBeenCalled();
});
