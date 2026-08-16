import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { JobEffect, ProjectPolicy } from "../src/domain/models";
import { openStore } from "../src/storage/store";
import {
  parseJobRow,
  persistPendingEffects,
  type JobRow,
} from "../src/storage/job-persistence";

const policySnapshot: ProjectPolicy = {
  projectId: "proj_contract",
  alias: "contract",
  enabled: true,
  githubRepository: "acme/contract",
  baseBranch: "main",
  implementation: { model: "implementation-model" },
  review: { model: "review-model" },
  validationCommands: [],
  production: {
    deployCommands: [{ name: "deploy", command: "./deploy.sh", timeoutMs: 1_000 }],
    canaryCommands: [{ name: "canary", command: "./canary.sh", timeoutMs: 1_000 }],
    convexDeployRequired: false,
  },
  requiredChecks: ["test"],
  outputRedactionPatterns: [],
  workerStartGraceMs: 120_000,
  workerLivenessWatchdogMs: 60_000,
  workerRecoveryLimit: 2,
  maxReviewCycles: 3,
  mergeMethod: "squash",
};

function databaseFixture(): Database.Database {
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent-job-persistence" });
  openStore(bb.storage);
  return bb.storage.database();
}

function insertEffectJob(db: Database.Database): void {
  db.prepare(
    `INSERT INTO jobs (
       id, source_update_id, request_text, state, review_cycle,
       review_block_at, version, created_at, updated_at
     ) VALUES ('job_effect', 778, 'effect job', 'awaiting_project', 0, 3, 1, 1, 1)`,
  ).run();
}

it("parses every persisted job field without losing policy or nullable production facts", () => {
  const persistedJob: JobRow = {
    id: "job_contract",
    source_update_id: 777,
    request_text: "preserve this request",
    state: "verifying_production",
    resume_state: "deploying",
    project_id: "proj_contract",
    policy_version: 7,
    policy_json: JSON.stringify(policySnapshot),
    environment_id: "env_contract",
    implementation_thread_id: "thr_implementation",
    review_thread_id: "thr_review",
    documentation_thread_id: "thr_docs",
    pr_number: 19,
    pr_url: "https://github.com/acme/contract/pull/19",
    pr_head_sha: "a".repeat(40),
    merge_message: null,
    merge_commit_sha: null,
    merged_at: null,
    deployment_summary: null,
    canary_summary: null,
    status_message_id: null,
    delivery_mode: "full",
    task_recipe: "adopted-pr",
    recipe_version: 1,
    recipe_promotion_count: 0,
    routing_mode: "shadow",
    task_traits_json: JSON.stringify([
      { id: "adopted-pr", provenance: ["origin"] },
      { id: "existing-flow", provenance: ["owner"] },
    ]),
    task_reason_codes_json: JSON.stringify(["recipe_adopted-pr"]),
    job_origin: "adopted_pr",
    adopted_branch: "telegram-agent/adopt-pr-19-aaaaaaaaaaaa",
    adopted_head_sha: "a".repeat(40),
    plan_cycle: 2,
    review_cycle: 1,
    review_block_at: 3,
    cancel_requested_at: null,
    blocked_reason: null,
    last_error: null,
    version: 11,
    created_at: 12_345,
    updated_at: 67_890,
  };

  expect(parseJobRow(persistedJob)).toEqual({
    id: "job_contract",
    sourceUpdateId: 777,
    requestText: "preserve this request",
    state: "verifying_production",
    resumeState: "deploying",
    projectId: "proj_contract",
    policyVersion: 7,
    policy: policySnapshot,
    environmentId: "env_contract",
    implementationThreadId: "thr_implementation",
    reviewThreadId: "thr_review",
    documentationThreadId: "thr_docs",
    prNumber: 19,
    prUrl: "https://github.com/acme/contract/pull/19",
    prHeadSha: "a".repeat(40),
    mergeMessage: null,
    mergeCommitSha: null,
    mergedAt: null,
    deploymentSummary: null,
    canarySummary: null,
    statusMessageId: null,
    deliveryMode: "full",
    taskRecipe: "adopted-pr",
    recipeVersion: 1,
    recipePromotionCount: 0,
    routingMode: "shadow",
    taskTraits: [
      { id: "adopted-pr", provenance: ["origin"] },
      { id: "existing-flow", provenance: ["owner"] },
    ],
    taskReasonCodes: ["recipe_adopted-pr"],
    origin: "adopted_pr",
    adoptedBranch: "telegram-agent/adopt-pr-19-aaaaaaaaaaaa",
    adoptedHeadSha: "a".repeat(40),
    planCycle: 2,
    reviewCycle: 1,
    reviewBlockAt: 3,
    cancelRequestedAt: null,
    blockedReason: null,
    lastError: null,
    version: 11,
    createdAt: 12_345,
    updatedAt: 67_890,
  });
});

it("persists duplicate effects only once", () => {
  const db = databaseFixture();
  insertEffectJob(db);
  const effect: JobEffect = {
    idempotencyKey: "job_effect:render_status",
    jobId: "job_effect",
    kind: "render_status",
    payload: { text: "status" },
  };

  persistPendingEffects(db, [effect], 4_000);
  persistPendingEffects(db, [effect], 4_001);

  expect(db.prepare(
    `SELECT idempotency_key, job_id, kind, payload_json, status, attempts,
            next_attempt_at, created_at, updated_at
       FROM effects WHERE job_id = 'job_effect'`,
  ).get()).toEqual({
    idempotency_key: "job_effect:render_status",
    job_id: "job_effect",
    kind: "render_status",
    payload_json: '{"text":"status"}',
    status: "pending",
    attempts: 0,
    next_attempt_at: 4_000,
    created_at: 4_000,
    updated_at: 4_000,
  });
  expect(db.prepare("SELECT COUNT(*) AS count FROM effects WHERE job_id = 'job_effect'").get()).toEqual({ count: 1 });
});

it.each([
  ["oversized", "job_effect:oversized", { text: "x".repeat(64_001) }, "effect payload must be bounded JSON"],
  ["callback-bearing", "job_effect:callback", { callback: `m:${"a".repeat(32)}` }, "effect payload must not contain a raw merge callback nonce"],
])("rejects %s effect payload", (_label, idempotencyKey, payload, message) => {
  const db = databaseFixture();
  insertEffectJob(db);
  expect(() => persistPendingEffects(db, [{
    idempotencyKey,
    jobId: "job_effect",
    kind: "render_status",
    payload,
  }], 4_002)).toThrow(message);
  expect(db.prepare("SELECT COUNT(*) AS count FROM effects WHERE idempotency_key = ?").get(idempotencyKey)).toEqual({ count: 0 });
});
