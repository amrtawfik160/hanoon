import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import type { JobEffect, ProjectPolicy } from "../src/domain/models";
import { productionResourceKey, projectResourceKey, repositoryMergeResourceKey } from "../src/autonomy/models";
import { hashSecret } from "../src/crypto";
import { ApprovalService } from "../src/services/approval-service";
import { openStore, type DurableMergeReceipt } from "../src/storage/store";
import { policyFixture, productionPolicyFixture, sha } from "./helpers";

const NOW = 1_000;
const HEAD = sha();

let fixtureNumber = 0;
function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-autonomy-crash-${fixtureNumber++}` });
  return {
    bb,
    db: bb.storage.database(),
    store: openStore(bb.storage, bb.storage.kv, () => NOW + 10),
    reopen: () => openStore(bb.storage, bb.storage.kv, () => NOW + 10),
  };
}

function acquire(store: ReturnType<typeof fixture>["store"], ownerId = "executor", now = NOW): number {
  const lease = store.acquireExecutorLease(ownerId, now, 60_000);
  if (!lease.acquired) throw new Error("executor lease was not acquired");
  return lease.generation;
}

function insertAdmissionAndClaims(
  fixtureValue: ReturnType<typeof fixture>,
  input: {
    jobId: string;
    policy: ProjectPolicy;
    ownerId: string;
    generation: number;
    includeProduction?: boolean;
  },
): void {
  fixtureValue.db.prepare(
    `INSERT INTO job_admissions (
       job_id, project_id, queue_seq, state, resume_event, queued_at, admitted_at
     ) VALUES (?, ?, 1, 'admitted', 'CONFIRMED', ?, ?)`,
  ).run(input.jobId, input.policy.projectId, NOW, NOW);
  const claims = [
    { key: projectResourceKey(input.policy.projectId), kind: "project" },
    ...(input.includeProduction ? [{ key: productionResourceKey(input.policy), kind: "production_target" }] : []),
  ];
  for (const claim of claims) {
    fixtureValue.db.prepare(
      `INSERT INTO job_resource_claims (
         job_id, resource_key, resource_kind, state, owner_id, generation,
         lease_expires_at, acquired_at, renewed_at
       ) VALUES (?, ?, ?, 'held', ?, ?, ?, ?, ?)`,
    ).run(
      input.jobId,
      claim.key,
      claim.kind,
      input.ownerId,
      input.generation,
      NOW + 60_000,
      NOW,
      NOW,
    );
  }
}

function settleStatusEffects(value: ReturnType<typeof fixture>, jobId: string): void {
  value.db.prepare(
    `UPDATE effects SET status = 'done', updated_at = ?
      WHERE job_id = ? AND kind = 'render_status' AND status = 'pending'`,
  ).run(NOW + 2, jobId);
}

it("continues once after queued-admission and admitted-claim crash boundaries", () => {
  const value = fixture();
  const policy = policyFixture({ production: undefined });
  value.store.upsertProjectPolicy(policy, NOW);
  const draft = value.store.createJob({ id: "crash-admission", sourceUpdateId: 1, requestText: "work", now: NOW });
  const selected = value.store.selectProjectAndQueueAdmission({
    jobId: draft.id,
    expectedVersion: draft.version,
    projectId: policy.projectId,
    policyVersion: 1,
    policy,
    now: NOW + 1,
  });

  const afterQueue = value.reopen();
  expect(afterQueue.getAdmission(selected.id)).toMatchObject({ state: "queued", projectId: policy.projectId });
  expect(afterQueue.listEffectsForJob(selected.id).map((effect) => effect.kind)).toEqual(["render_status"]);
  const generation = acquire(afterQueue, "executor", NOW + 2);
  expect(afterQueue.tryAdmit({
    jobId: selected.id,
    maxConcurrentJobs: 2,
    ownerId: "executor",
    generation,
    now: NOW + 2,
    leaseMs: 60_000,
  })).toMatchObject({ outcome: "admitted" });

  const afterAdmission = value.reopen();
  expect(afterAdmission.getAdmission(selected.id)?.state).toBe("admitted");
  expect(afterAdmission.listHeldResourceClaims(selected.id, 10)).toHaveLength(1);
  expect(afterAdmission.listEffectsForJob(selected.id).filter((effect) => effect.kind === "spawn_plan")).toHaveLength(1);
  settleStatusEffects(value, selected.id);
  expect(afterAdmission.leaseNextJobEffect({
    jobId: selected.id,
    ownerId: "executor",
    generation,
    now: NOW + 3,
    leaseMs: 60_000,
  })).toMatchObject({ kind: "spawn_plan", attempts: 1 });
  expect(value.reopen().leaseNextJobEffect({
    jobId: selected.id,
    ownerId: "executor",
    generation,
    now: NOW + 4,
    leaseMs: 60_000,
  })).toBeNull();
});

it("reuses one durable pipeline attempt when BB spawn returned before thread binding", () => {
  const value = fixture();
  value.store.createJob({ id: "crash-spawn", sourceUpdateId: 1, requestText: "plan", now: NOW });
  const generation = acquire(value.store);
  const fence = { ownerId: "executor", generation };
  const attemptInput = {
    id: "stage-crash-spawn",
    jobId: "crash-spawn",
    role: "PLAN" as const,
    ordinal: 1,
    inputSha256: "a".repeat(64),
    now: NOW + 1,
    ...fence,
  };
  value.store.createPipelineStageAttempt(attemptInput);
  const spawned = new Map<string, { threadId: string; environmentId: string }>();
  const spawnMutation = vi.fn((key: string) => {
    const existing = spawned.get(key);
    if (existing) return existing;
    const created = { threadId: "thr-plan", environmentId: "env-plan" };
    spawned.set(key, created);
    return created;
  });
  const returnedBeforeCrash = spawnMutation(attemptInput.id);

  const restarted = value.reopen();
  expect(restarted.createPipelineStageAttempt(attemptInput)).toMatchObject({ state: "spawning", threadId: null });
  const reconciledSpawn = spawnMutation(attemptInput.id);
  expect(spawnMutation).toHaveBeenCalledTimes(2);
  expect(spawned.size).toBe(1);
  expect(reconciledSpawn).toEqual(returnedBeforeCrash);
  expect(restarted.bindPipelineStageThread({
    id: attemptInput.id,
    ...reconciledSpawn,
    now: NOW + 2,
    ...fence,
  })).toBe(true);
  expect(restarted.bindPipelineStageThread({
    id: attemptInput.id,
    ...reconciledSpawn,
    now: NOW + 3,
    ...fence,
  })).toBe(true);
  expect(restarted.bindPipelineStageThread({
    id: attemptInput.id,
    threadId: "thr-duplicate",
    environmentId: "env-duplicate",
    now: NOW + 3,
    ...fence,
  })).toBe(false);
  expect(restarted.completePipelineStageAttempt({
    id: attemptInput.id,
    outputText: "# Plan\n",
    outputSha256: "b".repeat(64),
    outcome: { verdict: "success" },
    now: NOW + 4,
    ...fence,
  })).toBe(true);
  expect(value.reopen().getPipelineStageAttempt(attemptInput.id)).toMatchObject({
    state: "completed",
    threadId: "thr-plan",
    environmentId: "env-plan",
  });
});

it("does not repeat an accepted approval or an ambiguously returned merge call", () => {
  const value = fixture();
  const policy = policyFixture({ requiredChecks: [] });
  value.store.createPairingCode(hashSecret("pair"), NOW, NOW + 60_000);
  expect(value.store.pairOwnerWithPrivateChatCode(hashSecret("pair"), "7", "70", NOW)).toEqual({ ok: true });
  value.store.createJob({ id: "crash-merge", sourceUpdateId: 1, requestText: "merge", now: NOW });
  value.db.prepare(
    `UPDATE jobs SET state = 'awaiting_merge_approval', project_id = ?, policy_version = 1,
       policy_json = ?, environment_id = 'env-merge', pr_number = 17,
       pr_url = 'https://github.com/acme/cyndra/pull/17', pr_head_sha = ?,
       version = 7, updated_at = ? WHERE id = 'crash-merge'`,
  ).run(policy.projectId, JSON.stringify(policy), HEAD, NOW);
  const generation = acquire(value.store);
  insertAdmissionAndClaims(value, { jobId: "crash-merge", policy, ownerId: "executor", generation });
  const approval = new ApprovalService(value.store, {
    now: () => NOW,
    randomBytes: () => Buffer.alloc(24, 1),
  }).issue("crash-merge", HEAD);
  const nonceHash = hashSecret(approval.nonce);
  const approvalRow = value.db.prepare(
    "SELECT expires_at FROM approvals WHERE nonce_hash = ?",
  ).get(nonceHash) as { expires_at: number };
  const effectKey = "crash-merge:8:merge_pr";
  const receipt: DurableMergeReceipt = {
    jobId: "crash-merge",
    effectIdempotencyKey: effectKey,
    approvalNonceHash: nonceHash,
    approvalOwnerUserId: "7",
    approvalOwnerChatId: "70",
    jobVersion: 8,
    approvalJobVersion: 7,
    projectId: policy.projectId,
    environmentId: "env-merge",
    prNumber: 17,
    baseBranch: policy.baseBranch,
    headSha: HEAD,
    reviewAttemptId: "review-crash",
    validationCompletedAt: new Date(NOW).toISOString(),
    requiredCheckNames: [],
    mergeMethod: policy.mergeMethod,
    expiresAt: new Date(approvalRow.expires_at).toISOString(),
  };
  const effect: JobEffect = {
    idempotencyKey: effectKey,
    jobId: "crash-merge",
    kind: "merge_pr",
    payload: { headSha: HEAD, receipt },
  };
  expect(value.store.acceptApprovalAndEnqueueMerge({
    nonceHash,
    expectedJobVersion: 7,
    effect,
    now: NOW + 1,
  })).toEqual({ ok: true, jobId: "crash-merge", headSha: HEAD });

  const afterApproval = value.reopen();
  expect(afterApproval.acceptApprovalAndEnqueueMerge({
    nonceHash,
    expectedJobVersion: 7,
    effect,
    now: NOW + 2,
  })).toEqual({ ok: true, jobId: "crash-merge", headSha: HEAD });
  expect(afterApproval.listEffectsForJob("crash-merge").filter((item) => item.kind === "merge_pr")).toHaveLength(1);
  settleStatusEffects(value, "crash-merge");
  expect(afterApproval.getJob("crash-merge")).toMatchObject({
    state: "merging",
    version: 8,
    projectId: policy.projectId,
    environmentId: "env-merge",
    prHeadSha: HEAD,
  });
  expect(afterApproval.getAdmission("crash-merge")).toMatchObject({ state: "admitted" });
  expect(afterApproval.listHeldResourceClaims("crash-merge", 10)).toMatchObject([{
    resourceKind: "project",
    ownerId: "executor",
    generation,
  }]);
  expect(afterApproval.getEffect("crash-merge", effectKey)).toMatchObject({
    status: "pending",
    payload: { headSha: HEAD, receipt },
  });
  expect(afterApproval.getApproval(nonceHash)).toMatchObject({
    outcome: "accepted",
    ownerUserId: "7",
    ownerChatId: "70",
    jobVersion: 7,
  });
  // The atomic lease/claim transaction has dedicated real-SQLite coverage. This
  // hook recreates its exact committed projection so this test can crash at the
  // next edge: after the provider returned but before its receipt completed.
  for (const claim of [
    { key: repositoryMergeResourceKey(policy.githubRepository), kind: "repository_merge" },
    { key: productionResourceKey(policy), kind: "production_target" },
  ] as const) {
    value.db.prepare(
      `INSERT INTO job_resource_claims (
         job_id, resource_key, resource_kind, state, owner_id, generation,
         lease_expires_at, acquired_at, renewed_at
       ) VALUES ('crash-merge', ?, ?, 'held', 'executor', ?, ?, ?, ?)`,
    ).run(claim.key, claim.kind, generation, NOW + 60_000, NOW + 2, NOW + 2);
  }
  value.db.prepare(
    `UPDATE effects SET status = 'leased', lease_owner = 'executor', lease_generation = ?,
       lease_expires_at = ?, attempts = 1, updated_at = ? WHERE idempotency_key = ?`,
  ).run(generation, NOW + 60_000, NOW + 2, effectKey);
  const leased = afterApproval.getEffect("crash-merge", effectKey);
  if (!leased) throw new Error("merge effect was not restored at the crash hook");
  expect(afterApproval.prepareMergeCall({
    jobId: leased.jobId,
    effectIdempotencyKey: leased.idempotencyKey,
    leaseOwner: "executor",
    leaseGeneration: generation,
    now: NOW + 3,
  })).toMatchObject({ ok: true, shouldCallProvider: true });
  const mergeProvider = vi.fn(() => ({ mergeCommitSha: sha("c") }));
  mergeProvider();

  const afterProviderReturn = value.reopen();
  expect(afterProviderReturn.prepareMergeCall({
    jobId: leased.jobId,
    effectIdempotencyKey: leased.idempotencyKey,
    leaseOwner: "executor",
    leaseGeneration: generation,
    now: NOW + 4,
  })).toMatchObject({ ok: true, shouldCallProvider: false });
  expect(mergeProvider).toHaveBeenCalledTimes(1);
  expect(afterProviderReturn.preserveUnknownMergeEffect({
    jobId: leased.jobId,
    effectIdempotencyKey: leased.idempotencyKey,
    leaseOwner: "executor",
    leaseGeneration: generation,
    now: NOW + 5,
  })).toBe(true);
  expect(afterProviderReturn.listHeldResourceClaims("crash-merge", 10)
    .filter((claim) => claim.state === "held")).toHaveLength(3);
});

it("persists deploy success before canary lease and drains terminal work before release", () => {
  const value = fixture();
  const policy = policyFixture({
    production: productionPolicyFixture({ targetKey: "crash.prod" }),
  });
  value.store.createJob({ id: "crash-production", sourceUpdateId: 1, requestText: "deploy", now: NOW });
  value.db.prepare(
    `UPDATE jobs SET state = 'deploying', project_id = ?, policy_version = 1,
       policy_json = ?, environment_id = 'env-production', merge_commit_sha = ?,
       merged_at = ?, version = 3, updated_at = ? WHERE id = 'crash-production'`,
  ).run(policy.projectId, JSON.stringify(policy), HEAD, new Date(NOW).toISOString(), NOW);
  const generation = acquire(value.store);
  insertAdmissionAndClaims(value, {
    jobId: "crash-production",
    policy,
    ownerId: "executor",
    generation,
    includeProduction: true,
  });

  expect(value.store.applyExecutorJobEvent({
    jobId: "crash-production",
    expectedVersion: 3,
    event: { type: "DEPLOY_SUCCEEDED", summary: "deploy passed" },
    ownerId: "executor",
    generation,
    now: NOW + 1,
  })).toMatchObject({ state: "verifying_production", version: 4 });
  const afterDeploy = value.reopen();
  expect(afterDeploy.applyExecutorJobEvent({
    jobId: "crash-production",
    expectedVersion: 3,
    event: { type: "DEPLOY_SUCCEEDED", summary: "deploy passed" },
    ownerId: "executor",
    generation,
    now: NOW + 2,
  })).toBeNull();
  expect(afterDeploy.listEffectsForJob("crash-production").filter((effect) => effect.kind === "verify_production")).toHaveLength(1);
  settleStatusEffects(value, "crash-production");
  const canary = afterDeploy.leaseNextJobEffect({
    jobId: "crash-production",
    ownerId: "executor",
    generation,
    now: NOW + 2,
    leaseMs: 60_000,
  });
  if (!canary) throw new Error("canary effect was not leased");
  expect(canary.kind).toBe("verify_production");
  expect(afterDeploy.applyExecutorJobEvent({
    jobId: "crash-production",
    expectedVersion: 4,
    event: { type: "CANARY_SUCCEEDED", summary: "canary passed" },
    ownerId: "executor",
    generation,
    now: NOW + 3,
  })).toMatchObject({ state: "complete" });
  expect(afterDeploy.completeEffect(canary.idempotencyKey, "executor", generation, NOW + 4)).toBe(true);
  expect(afterDeploy.getAdmission("crash-production")?.state).toBe("draining");

  const afterTerminal = value.reopen();
  expect(afterTerminal.listHeldResourceClaims("crash-production", 10)
    .filter((claim) => claim.resourceKind === "production_target" && claim.state === "held")).toHaveLength(0);
  expect(afterTerminal.finalizeRelease({
    jobId: "crash-production",
    ownerId: "executor",
    generation,
    now: NOW + 5,
  })).toMatchObject({ outcome: "waiting", reason: "safe_cleanup" });
  settleStatusEffects(value, "crash-production");
  expect(afterTerminal.finalizeRelease({
    jobId: "crash-production",
    ownerId: "executor",
    generation,
    now: NOW + 6,
  })).toMatchObject({ outcome: "released" });
  expect(afterTerminal.getAdmission("crash-production")?.state).toBe("released");
  expect(afterTerminal.listHeldResourceClaims("crash-production", 10)
    .filter((claim) => claim.state === "held")).toHaveLength(0);
});
