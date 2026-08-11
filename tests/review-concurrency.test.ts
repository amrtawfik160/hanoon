import { createFakePluginHost, makeThreadResponse } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import plugin from "../server";
import { projectResourceKey } from "../src/autonomy/models";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { policyFixture, sha } from "./helpers";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function reviewOutput(input: {
  verdict: "pass" | "changes_requested";
  reviewedHeadSha: string;
  summary: string;
  findings?: Array<Record<string, unknown>>;
}): string {
  return JSON.stringify({
    verdict: input.verdict,
    reviewedHeadSha: input.reviewedHeadSha,
    summary: input.summary,
    findings: input.findings ?? [],
    checks: [],
  });
}

function prepareReviewJob(
  store: TelegramAgentStore,
  db: Database.Database,
  input: {
    id: string;
    sourceUpdateId: number;
    projectId: string;
    environmentId: string;
    implementationThreadId: string;
    reviewThreadId: string;
    attemptId: string;
    headSha: string;
  },
) {
  const policy = policyFixture({
    projectId: input.projectId,
    alias: input.projectId.replace("_", "-"),
    baseBranch: `${input.projectId}-base`,
    githubRepository: `acme/${input.projectId}`,
  });
  const job = store.createJob({
    id: input.id,
    sourceUpdateId: input.sourceUpdateId,
    requestText: `review ${input.id}`,
    now: 1_000,
  });
  db.prepare(
    `UPDATE jobs SET state = 'reviewing', project_id = ?, policy_version = 1,
       policy_json = ?, environment_id = ?, implementation_thread_id = ?,
       review_thread_id = ?, pr_number = ?, pr_url = ?, pr_head_sha = ?,
       version = 2, updated_at = ? WHERE id = ?`,
  ).run(
    input.projectId,
    JSON.stringify(policy),
    input.environmentId,
    input.implementationThreadId,
    input.reviewThreadId,
    input.sourceUpdateId,
    `https://github.com/${policy.githubRepository}/pull/${input.sourceUpdateId}`,
    input.headSha,
    1_001,
    job.id,
  );
  store.createAttempt({
    id: input.attemptId,
    jobId: input.id,
    kind: "review",
    ordinal: 1,
    headSha: input.headSha,
    now: 1_000,
  });
  store.updateAttempt(input.attemptId, {
    threadId: input.reviewThreadId,
    headSha: input.headSha,
  });
  db.prepare(
    `INSERT INTO job_admissions (
       job_id, project_id, queue_seq, state, resume_event, queued_at, admitted_at
     ) VALUES (?, ?, ?, 'admitted', 'CONFIRMED', ?, ?)`,
  ).run(job.id, input.projectId, input.sourceUpdateId, 1_000, 1_001);
  db.prepare(
    `INSERT INTO job_resource_claims (
       job_id, resource_key, resource_kind, state, owner_id, generation,
       lease_expires_at, acquired_at, renewed_at, released_at, release_reason
     ) VALUES (?, ?, 'project', 'held', 'fixture-executor', 1, 50_000, 1_000, 1_000, NULL, NULL)`,
  ).run(job.id, projectResourceKey(input.projectId));
  return store.getJob(input.id)!;
}

it("keeps simultaneous opposite review verdicts bound to their own jobs", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "review-concurrency-plugin" });
  await plugin(bb);
  const store = openStore(bb.storage);
  const db = bb.storage.database();
  const headA = sha("a");
  const headB = sha("b");
  const jobA = prepareReviewJob(store, db, {
    id: "job_review_a",
    sourceUpdateId: 101,
    projectId: "proj_a",
    environmentId: "environment_a",
    implementationThreadId: "implementation_a",
    reviewThreadId: "review_a",
    attemptId: "attempt_a",
    headSha: headA,
  });
  const jobB = prepareReviewJob(store, db, {
    id: "job_review_b",
    sourceUpdateId: 102,
    projectId: "proj_b",
    environmentId: "environment_b",
    implementationThreadId: "implementation_b",
    reviewThreadId: "review_b",
    attemptId: "attempt_b",
    headSha: headB,
  });

  const environmentA = deferred<Record<string, unknown>>();
  const environmentB = deferred<Record<string, unknown>>();
  const environmentCalls: Array<{ environmentId: string; mergeBaseBranch: string }> = [];
  const outputCalls: string[] = [];
  harness.sdk.stub("environments.status", async (input: { environmentId: string; mergeBaseBranch: string }) => {
    environmentCalls.push({ environmentId: input.environmentId, mergeBaseBranch: input.mergeBaseBranch });
    return input.environmentId === "environment_a" ? environmentA.promise : environmentB.promise;
  });
  harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({
    id: threadId,
    projectId: threadId.endsWith("_a") ? "proj_a" : "proj_b",
    environmentId: threadId.endsWith("_a") ? "environment_a" : "environment_b",
    status: "idle",
    updatedAt: 2_000,
    runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
  }));
  harness.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => {
    outputCalls.push(threadId);
    return {
      output: threadId === "review_a"
        ? reviewOutput({ verdict: "pass", reviewedHeadSha: headA, summary: "A passed" })
        : reviewOutput({
            verdict: "changes_requested",
            reviewedHeadSha: headB,
            summary: "B needs changes",
            findings: [{ severity: "high", file: "src/b.ts", line: 4, title: "B finding", details: "B only" }],
          }),
    };
  });

  const run = harness.behavior.runService("job-executor");
  try {
    expect(store.listJobs(10).map((job) => [job.id, job.state])).toEqual([
      [jobB.id, "reviewing"],
      [jobA.id, "reviewing"],
    ]);
    await vi.waitFor(() => expect(environmentCalls).toHaveLength(2));
    expect(environmentCalls).toEqual(expect.arrayContaining([
      { environmentId: "environment_a", mergeBaseBranch: "proj_a-base" },
      { environmentId: "environment_b", mergeBaseBranch: "proj_b-base" },
    ]));
    environmentB.resolve({ available: true, clean: true, checkout: { headSha: headB } });
    environmentA.resolve({ available: true, clean: true, checkout: { headSha: headA } });

    await vi.waitFor(() => expect(outputCalls).toHaveLength(2));
    await vi.waitFor(() => expect(store.getJob(jobA.id)?.state).not.toBe("reviewing"));
    await vi.waitFor(() => expect(store.getJob(jobB.id)?.state).not.toBe("reviewing"));

    expect(outputCalls).toEqual(expect.arrayContaining(["review_a", "review_b"]));
    expect(store.getJob(jobA.id)?.state).toBe("documenting");
    expect(store.getJob(jobB.id)?.state).toBe("remediating");
    expect(JSON.parse(store.getAttempt("attempt_a")!.resultJson!)).toMatchObject({
      outcome: "pass",
      reviewedHeadSha: headA,
    });
    expect(JSON.parse(store.getAttempt("attempt_b")!.resultJson!)).toMatchObject({
      outcome: "changes_requested",
      reviewedHeadSha: headB,
      findings: [{ title: "B finding", details: "B only" }],
    });
  } finally {
    environmentA.resolve({ available: true, clean: true, checkout: { headSha: headA } });
    environmentB.resolve({ available: true, clean: true, checkout: { headSha: headB } });
    run.controller.abort();
    await run.done;
  }
});
