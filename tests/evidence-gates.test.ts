import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { JobEvent, JobState } from "../src/domain/models";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { policyFixture } from "./helpers";

let fixtureId = 0;

function fixture(state: JobState): {
  store: TelegramAgentStore;
  db: Database.Database;
  fence: { ownerId: string; generation: number; now: number };
} {
  const { bb } = createFakePluginHost({ pluginId: `telegram-evidence-gate-${fixtureId++}` });
  const db = bb.storage.database();
  const store = openStore(bb.storage);
  const job = store.createJob({ id: "job_1", sourceUpdateId: fixtureId, requestText: "work", now: 1_000 });
  db.prepare(
    `UPDATE jobs SET state = ?, project_id = 'proj_1', policy_version = 1, policy_json = ?,
       environment_id = 'env_1', implementation_thread_id = 'thr_impl', review_thread_id = 'thr_review',
       pr_number = 7, pr_url = 'https://github.com/acme/cyndra/pull/7', pr_head_sha = ?, version = 2
     WHERE id = ?`,
  ).run(state, JSON.stringify(policyFixture()), "a".repeat(40), job.id);
  const lease = store.acquireExecutorLease("executor", 1_001, 30_000);
  if (!lease.acquired) throw new Error("executor lease missing");
  return { store, db, fence: { ownerId: "executor", generation: lease.generation, now: 1_002 } };
}

function reviewResult(
  outcome: "pass" | "changes_requested",
  headSha = "a".repeat(40),
): Record<string, unknown> {
  const findings = outcome === "pass" ? [] : [{
    severity: "high",
    file: "src/unsafe.ts",
    line: 4,
    title: "Unsafe operation",
    details: "The operation needs an authorization check.",
  }];
  return {
    outcome,
    reasons: outcome === "pass" ? [] : ["review verdict requested changes"],
    findings,
    reviewedHeadSha: headSha,
    verdict: {
      verdict: outcome,
      reviewedHeadSha: headSha,
      summary: `${outcome} summary`,
      findings,
      checks: [],
    },
  };
}

function addReviewAttempt(
  store: TelegramAgentStore,
  fence: { ownerId: string; generation: number; now: number },
  lens: "quality" | "risk",
  result: Record<string, unknown>,
  stage: "review" | "final_review" = "review",
): void {
  const attempt = store.createExecutorAttempt({
    id: `attempt_${stage}_${lens}`,
    jobId: "job_1",
    kind: "review",
    reviewLens: lens,
    reviewStage: stage,
    ordinal: 1,
    headSha: "a".repeat(40),
    ...fence,
  });
  if (!attempt) throw new Error("attempt was not created");
  const updated = store.updateExecutorAttempt({
    jobId: "job_1",
    attemptId: attempt.id,
    patch: { threadId: lens === "quality" ? "thr_review" : "thr_risk", result },
    ...fence,
  });
  if (!updated) throw new Error("attempt was not updated");
}

describe("executor evidence gates", () => {
  it.each([
    ["planning", { type: "PLAN_READY", attemptId: "missing-plan" }],
    ["critiquing", { type: "CRITIQUE_PASSED", attemptId: "missing-critique" }],
    ["resolving_pr_head", { type: "PR_HEAD_RESOLVED", headSha: "a".repeat(40) }],
    ["validating", { type: "VALIDATION_PASSED", headSha: "a".repeat(40) }],
    ["reviewing", { type: "REVIEW_PASSED", headSha: "a".repeat(40) }],
    ["documenting", { type: "DOCS_IDLE" }],
    ["final_validating", { type: "VALIDATION_PASSED", headSha: "a".repeat(40) }],
    ["final_reviewing", { type: "REVIEW_PASSED", headSha: "a".repeat(40) }],
  ] as Array<[JobState, JobEvent]>)('refuses %s advancement when its durable evidence is missing', (state, event) => {
    const { store, fence } = fixture(state);
    expect(store.applyExecutorJobEvent({
      jobId: "job_1",
      expectedVersion: 2,
      event,
      ...fence,
    })).toBeNull();
    expect(store.getJob("job_1")).toMatchObject({ state, version: 2 });
  });

  it("requires both full-job review lenses and atomically completes both attempts", () => {
    const { store, fence } = fixture("reviewing");
    addReviewAttempt(store, fence, "quality", reviewResult("pass"));

    expect(store.applyExecutorJobEvent({
      jobId: "job_1",
      expectedVersion: 2,
      event: { type: "REVIEW_PASSED", headSha: "a".repeat(40) },
      ...fence,
    })).toBeNull();

    addReviewAttempt(store, fence, "risk", reviewResult("pass"));
    expect(store.applyExecutorJobEvent({
      jobId: "job_1",
      expectedVersion: 2,
      event: { type: "REVIEW_PASSED", headSha: "a".repeat(40) },
      ...fence,
    })).toMatchObject({ state: "documenting", version: 3 });
    expect(store.listReviewAttempts("job_1", "review", 1).map((attempt) => attempt.completedAt)).toEqual([
      fence.now,
      fence.now,
    ]);
  });

  it("requires all full-job lenses to settle before requesting remediation", () => {
    const { store, fence } = fixture("reviewing");
    addReviewAttempt(store, fence, "quality", reviewResult("changes_requested"));

    const event: JobEvent = {
      type: "REVIEW_CHANGES_REQUESTED",
      headSha: "a".repeat(40),
      summary: "quality: changes_requested summary; risk: pass summary",
      findings: [{
        severity: "high",
        file: "src/unsafe.ts",
        line: 4,
        title: "Unsafe operation",
        details: "The operation needs an authorization check.",
      }],
      reasons: ["quality: review verdict requested changes"],
    };
    expect(store.applyExecutorJobEvent({ jobId: "job_1", expectedVersion: 2, event, ...fence })).toBeNull();

    addReviewAttempt(store, fence, "risk", reviewResult("pass"));
    expect(store.applyExecutorJobEvent({ jobId: "job_1", expectedVersion: 2, event, ...fence }))
      .toMatchObject({ state: "remediating", version: 3 });
  });

  it("does not let legacy verdict JSON advance an active review without capability evidence", () => {
    const { store, db, fence } = fixture("reviewing");
    db.prepare(
      `UPDATE jobs SET routing_mode = 'active', task_recipe = 'bounded', delivery_mode = 'full'
        WHERE id = 'job_1'`,
    ).run();
    addReviewAttempt(store, fence, "quality", reviewResult("pass"));
    addReviewAttempt(store, fence, "risk", reviewResult("pass"));

    expect(store.applyExecutorJobEvent({
      jobId: "job_1",
      expectedVersion: 2,
      event: { type: "REVIEW_PASSED", headSha: "a".repeat(40) },
      ...fence,
    })).toBeNull();
    expect(store.getJob("job_1")).toMatchObject({ state: "reviewing", version: 2 });
  });

  it("keeps the single quality-lens gate for small fixes", () => {
    const { store, db, fence } = fixture("reviewing");
    db.prepare("UPDATE jobs SET delivery_mode = 'small_fix' WHERE id = 'job_1'").run();
    addReviewAttempt(store, fence, "quality", reviewResult("pass"));

    expect(store.applyExecutorJobEvent({
      jobId: "job_1",
      expectedVersion: 2,
      event: { type: "REVIEW_PASSED", headSha: "a".repeat(40) },
      ...fence,
    })).toMatchObject({ state: "complete", version: 3 });
  });
});
