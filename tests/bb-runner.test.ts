import type { BbPluginApi } from "@bb/plugin-sdk";
import { expect, it, vi } from "vitest";
import { BbRunner } from "../src/bb/runner";
import { jobFixture, policyFixture } from "./helpers";

type SdkCalls = {
  attachments: unknown[];
  spawns: unknown[];
  forks: unknown[];
  sends: unknown[];
  stops: unknown[];
  gets: unknown[];
  statuses: unknown[];
  diffs: unknown[];
  pullRequests: unknown[];
};

function runnerFixture() {
  const calls: SdkCalls = {
    attachments: [],
    spawns: [],
    forks: [],
    sends: [],
    stops: [],
    gets: [],
    statuses: [],
    diffs: [],
    pullRequests: [],
  };
  const sdk = {
    projects: {
      attachments: {
        upload: vi.fn(async (args: unknown) => {
          calls.attachments.push(args);
          const filename = (args as { filename: string }).filename;
          return {
            type: "localFile",
            path: `attachments/${filename}`,
            name: filename,
            sizeBytes: 100,
            mimeType: "text/markdown",
          };
        }),
      },
    },
    threads: {
      spawn: vi.fn(async (args: unknown) => {
        calls.spawns.push(args);
        return { id: "thr_created", environmentId: "env_1" };
      }),
      fork: vi.fn(async (args: unknown) => {
        calls.forks.push(args);
        return { id: "thr_forked" };
      }),
      send: vi.fn(async (args: unknown) => {
        calls.sends.push(args);
        return { ok: true };
      }),
      stop: vi.fn(async (args: unknown) => {
        calls.stops.push(args);
        return { ok: true };
      }),
      get: vi.fn(async (args: unknown) => {
        calls.gets.push(args);
        return { id: "thr_i", status: "idle" };
      }),
    },
    environments: {
      status: vi.fn(async (args: unknown) => {
        calls.statuses.push(args);
        return { headSha: "a".repeat(40), clean: true };
      }),
      diff: vi.fn(async (args: unknown) => {
        calls.diffs.push(args);
        return { outcome: "available", diff: { diff: "diff --git a/src/a.ts b/src/a.ts", truncated: false } };
      }),
      pullRequest: vi.fn(async (args: unknown) => {
        calls.pullRequests.push(args);
        return { outcome: "absent" };
      }),
    },
  } as unknown as BbPluginApi["sdk"];
  return { calls, runner: new BbRunner(sdk) };
}

function attempt(id: string) {
  return { id, handoffPath: null as string | null, handoffSha256: null as string | null };
}

const selectedJob = jobFixture({
  projectId: "proj_1",
  policy: policyFixture(),
  environmentId: "env_1",
  implementationThreadId: "thr_i",
  prNumber: 42,
  prUrl: "https://github.com/acme/cyndra/pull/42",
  prHeadSha: "a".repeat(40),
});

it("spawns implementation in a visible managed worktree and records the immutable handoff", async () => {
  const { calls, runner } = runnerFixture();
  const implementationAttempt = attempt("attempt_impl_1");

  await runner.spawnImplementation(selectedJob, implementationAttempt, policyFixture({ baseBranch: "wrong" }));

  expect(calls.spawns[0]).toMatchObject({
    projectId: "proj_1",
    title: "Telegram job_1 implementation attempt_impl_1",
    visibility: "visible",
    environment: {
      type: "host",
      workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "main" } },
    },
    input: [
      { type: "text", text: expect.stringContaining("Read the attached immutable work order") },
      { type: "localFile", path: "attachments/work-order.md" },
    ],
    model: "implementation-model",
    executionInputSources: { model: "explicit" },
  });
  expect(calls.attachments).toHaveLength(1);
  expect(calls.forks).toHaveLength(0);
  expect(implementationAttempt.handoffPath).toBe("attachments/work-order.md");
  expect(implementationAttempt.handoffSha256).toMatch(/^[0-9a-f]{64}$/);
});

it("spawns review as a visible child in the exact implementation environment", async () => {
  const { calls, runner } = runnerFixture();
  const reviewAttempt = attempt("attempt_review_1");

  await runner.spawnReview(selectedJob, reviewAttempt, policyFixture({ baseBranch: "wrong" }));

  expect(calls.spawns[0]).toMatchObject({
    projectId: "proj_1",
    parentThreadId: "thr_i",
    title: "Telegram job_1 review attempt_review_1",
    visibility: "visible",
    environment: { type: "reuse", environmentId: "env_1" },
    input: [
      { type: "text", text: expect.stringContaining("Read the attached immutable review packet") },
      { type: "localFile", path: "attachments/review-packet.json" },
    ],
    model: "review-model",
    executionInputSources: { model: "explicit" },
  });
  expect(calls.statuses[0]).toEqual({ environmentId: "env_1", mergeBaseBranch: "main" });
  expect(calls.diffs[0]).toEqual({ environmentId: "env_1", target: "all", mergeBaseBranch: "main" });
  expect(calls.pullRequests[0]).toEqual({ environmentId: "env_1" });
  expect(calls.forks).toHaveLength(0);
});

it("blocks a truncated environment diff before uploading or spawning review", async () => {
  const { calls, runner } = runnerFixture();
  const reviewAttempt = attempt("attempt_review_truncated");

  (runner as unknown as { sdk: { environments: { diff: ReturnType<typeof vi.fn> } } }).sdk.environments.diff = vi.fn(async () => ({
    outcome: "available",
    diff: { diff: "partial", truncated: true },
  }));

  await expect(runner.spawnReview(selectedJob, reviewAttempt, policyFixture())).rejects.toThrow(/truncated/i);
  expect(calls.attachments).toHaveLength(0);
  expect(calls.spawns).toHaveLength(0);
});

it("uses exact send, stop, thread, environment, and pull-request SDK calls", async () => {
  const { calls, runner } = runnerFixture();

  await runner.sendSteering("thr_i", "Continue with the bounded check.");
  await runner.sendRemediation(selectedJob, [
    { severity: "high", file: "src/a.ts", line: 1, title: "Fix it", details: "Evidence" },
  ]);
  await runner.stopWorker("thr_i");
  await runner.getThread("thr_i");
  await runner.getEnvironmentSnapshot("env_1", "main");
  await runner.getPullRequestSnapshot("env_1");

  expect(calls.sends).toEqual([
    { threadId: "thr_i", mode: "auto", input: [{ type: "text", text: "Continue with the bounded check.", mentions: [] }] },
    { threadId: "thr_i", mode: "auto", input: [{ type: "text", text: expect.stringContaining("Fix it"), mentions: [] }] },
  ]);
  expect(calls.stops).toEqual([{ threadId: "thr_i" }]);
  expect(calls.gets).toEqual([{ threadId: "thr_i" }]);
  expect(calls.statuses).toContainEqual({ environmentId: "env_1", mergeBaseBranch: "main" });
  expect(calls.diffs).toContainEqual({ environmentId: "env_1", target: "all", mergeBaseBranch: "main" });
  expect(calls.pullRequests).toEqual([{ environmentId: "env_1" }]);
});
