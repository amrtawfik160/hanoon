import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import type { JobEffect, StoredEffect } from "../src/domain/models";
import { productionResourceKey, projectResourceKey } from "../src/autonomy/models";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { resolveMergeGrant } from "../src/services/merge-authority";
import { EffectRunner } from "../src/services/effect-runner";
import { policyFixture } from "./helpers";

/**
 * What happens to a project's standing authority when production broke and the
 * rollback could not put it back.
 *
 * A rollback that worked is a recovery and costs the project nothing. A rollback
 * that was missing or failed means recovery is exhausted, and from there both
 * sources of unattended merging have to stop — the owner's button grant and the
 * grant a policy file carries — and the project has to stop taking new work at
 * all, because queueing more changes for a project whose production is down is
 * the loop the failure brake exists to catch.
 */

let fixtureNumber = 0;

const PROJECT = "proj_1";
const NOW = 1_002;

function storeFixture(): { store: TelegramAgentStore; db: Database.Database } {
  const { bb } = createFakePluginHost({ pluginId: `telegram-agent-autonomy-withdrawal-${fixtureNumber++}` });
  const db = bb.storage.database();
  return { store: openStore(bb.storage), db };
}

/** `leaseEffects` is not on the published store interface; the executor uses it. */
type LeasingStore = TelegramAgentStore & {
  leaseEffects(ownerId: string, generation: number, now: number, limit: number, leaseMs: number): StoredEffect[];
};

function unattendedPolicy() {
  return policyFixture({
    autonomy: { unattendedMerge: true, mergeWithoutProduction: false },
    production: {
      ...policyFixture().production!,
      rollbackCommand: { name: "rollback", command: "./rollback", timeoutMs: 60_000 },
    },
  });
}

function seedDeployingJob(store: TelegramAgentStore, db: Database.Database, policy: ReturnType<typeof policyFixture>) {
  const job = store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "work", now: 1_000 });
  db.prepare(
    `UPDATE jobs SET state = 'deploying', project_id = ?, policy_version = 1, policy_json = ?,
       environment_id = 'env_1', pr_number = 7, pr_head_sha = ?, merge_message = 'Merged PR #7',
       merge_commit_sha = ?, merged_at = '2026-08-10T00:00:00.000Z', version = 2 WHERE id = ?`,
  ).run(policy.projectId, JSON.stringify(policy), "a".repeat(40), "d".repeat(40), job.id);
  db.prepare(
    `INSERT INTO job_admissions (job_id, project_id, queue_seq, state, resume_event, queued_at, admitted_at)
     VALUES (?, ?, 1, 'admitted', 'CONFIRMED', 1000, 1001)`,
  ).run(job.id, policy.projectId);
  const insertClaim = db.prepare(
    `INSERT INTO job_resource_claims (
       job_id, resource_key, resource_kind, state, owner_id, generation,
       lease_expires_at, acquired_at, renewed_at
     ) VALUES (?, ?, ?, 'held', 'owner-a', 1, 31000, 1000, 1000)`,
  );
  insertClaim.run(job.id, projectResourceKey(policy.projectId), "project");
  insertClaim.run(job.id, productionResourceKey(policy), "production_target");
  return job;
}

const DEPLOY_EFFECT: JobEffect = {
  idempotencyKey: "job_1:3:deploy_production",
  jobId: "job_1",
  kind: "deploy_production",
  payload: {},
};

function seedDeployEffect(db: Database.Database): void {
  db.prepare(
    `INSERT INTO effects (idempotency_key, job_id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, '{}', 'pending', 0, 1000, 1000, 1000)`,
  ).run(DEPLOY_EFFECT.idempotencyKey, DEPLOY_EFFECT.jobId, DEPLOY_EFFECT.kind);
}

async function runFailedDeploy(
  store: TelegramAgentStore,
  rollback: { outcome: "pass" | "fail" } | null,
): Promise<void> {
  const lease = store.acquireExecutorLease("owner-a", 1_001, 30_000);
  if (!lease.acquired) throw new Error("lease missing");
  const claimed = (store as LeasingStore).leaseEffects("owner-a", lease.generation, 1_001, 10, 30_000)
    .find((candidate) => candidate.idempotencyKey === DEPLOY_EFFECT.idempotencyKey);
  if (!claimed) throw new Error("production effect missing");

  await new EffectRunner({
    store,
    fence: { ownerId: "owner-a", generation: lease.generation, signal: new AbortController().signal },
    now: () => NOW,
    runProductionStage: vi.fn(async () => ({
      phase: "deploy" as const,
      outcome: "fail" as const,
      summary: "Production deploy failed",
      failedCommand: "deploy",
      commandReceipts: [
        { name: "verify-merged-checkout", command: "git-head-check", outcome: "pass" as const, exitCode: 0, output: "ok" },
        { name: "deploy", command: "./deploy", outcome: "fail" as const, exitCode: 1, output: "boom" },
      ],
      ...(rollback === null ? {} : {
        rollback: {
          name: "rollback",
          command: "./rollback",
          outcome: rollback.outcome,
          exitCode: rollback.outcome === "pass" ? 0 : 1,
          output: "rolled",
        },
      }),
      terminalIds: ["term_deploy"],
      completedAt: "2026-08-10T00:01:00.000Z",
    })),
  }).run(claimed);
}

function policyGrantIsLive(store: TelegramAgentStore, policy: ReturnType<typeof policyFixture>): boolean {
  return resolveMergeGrant({
    projectId: policy.projectId,
    policy,
    evidence: store.getMergeGrantEvidence(policy.projectId),
  }) !== null;
}

it("withdraws the grant and brakes the project when no rollback was configured", async () => {
  // A policy declaring unattended merging cannot reach this state — the schema
  // refuses it without a rollback command — so the project here is one the
  // owner granted by button.
  const { store, db } = storeFixture();
  const policy = policyFixture();
  store.upsertProjectPolicy(policy, 1_000);
  store.grantMergeAuthority({ projectId: PROJECT, userId: "7", chatId: "70", now: 1_000 });
  seedDeployingJob(store, db, policy);
  seedDeployEffect(db);

  await runFailedDeploy(store, null);

  expect(store.getJob("job_1")?.state).toBe("production_failed");
  expect(store.getMergeAuthority(PROJECT)?.revokedAt).toBe(NOW);
  expect(store.getMergeGrantEvidence(PROJECT).revokedAt).toBe(NOW);
  expect(store.listPausedProjectAdmissions()).toEqual([
    { projectId: PROJECT, reason: "production deploy failed with no rollback configured", pausedAt: NOW },
  ]);
});

it("withdraws both merge grants and brakes the project when the rollback itself failed", async () => {
  const { store, db } = storeFixture();
  const policy = unattendedPolicy();
  store.upsertProjectPolicy(policy, 1_000);
  store.grantMergeAuthority({ projectId: PROJECT, userId: "7", chatId: "70", now: 1_000 });
  expect(policyGrantIsLive(store, policy)).toBe(true);
  seedDeployingJob(store, db, policy);
  seedDeployEffect(db);

  await runFailedDeploy(store, { outcome: "fail" });

  expect(store.getMergeAuthority(PROJECT)?.revokedAt).toBe(NOW);
  // The policy file cannot hear about a withdrawal, so the durable revocation
  // is what silences the grant it declares.
  expect(store.getMergeGrantEvidence(PROJECT).revokedAt).toBe(NOW);
  expect(policyGrantIsLive(store, policy)).toBe(false);
  expect(store.listPausedProjectAdmissions().map((pause) => pause.projectId)).toEqual([PROJECT]);
});

it("leaves both grants and admission alone when the rollback recovered production", async () => {
  // Production is back. Nothing about that says this project may no longer be
  // trusted to deliver, and braking it would turn every recovered incident
  // into a manual restart.
  const { store, db } = storeFixture();
  const policy = unattendedPolicy();
  store.upsertProjectPolicy(policy, 1_000);
  store.grantMergeAuthority({ projectId: PROJECT, userId: "7", chatId: "70", now: 1_000 });
  seedDeployingJob(store, db, policy);
  seedDeployEffect(db);

  await runFailedDeploy(store, { outcome: "pass" });

  expect(store.getJob("job_1")?.state).toBe("production_failed");
  expect(store.getMergeAuthority(PROJECT)?.revokedAt).toBeNull();
  expect(store.getMergeGrantEvidence(PROJECT).revokedAt).toBeNull();
  expect(policyGrantIsLive(store, policy)).toBe(true);
  expect(store.listPausedProjectAdmissions()).toEqual([]);
});

it("takes over a brake the project was already under, rather than leaving it as it was", async () => {
  // The failure-loop brake carries a fingerprint, which is what lets the agent
  // lift it once after investigating. A job admitted before that brake can
  // still reach a deploy, and if that deploy fails with no way back, the
  // project must not be left holding the easier of the two brakes.
  const { store, db } = storeFixture();
  const policy = unattendedPolicy();
  store.upsertProjectPolicy(policy, 1_000);
  expect(store.pauseProjectAdmission({
    projectId: PROJECT,
    reason: "the same failure repeated 3 times",
    fingerprint: "f".repeat(64),
    now: 1_001,
  })).toBe(true);
  seedDeployingJob(store, db, policy);
  seedDeployEffect(db);

  await runFailedDeploy(store, { outcome: "fail" });

  const row = db.prepare(
    "SELECT reason, fingerprint FROM project_admission_pauses WHERE project_id = ? AND cleared_at IS NULL",
  ).get(PROJECT) as { reason: string; fingerprint: string | null } | undefined;
  expect(row?.fingerprint).toBeNull();
  expect(row?.reason).toBe("rollback failed after a bad deploy");
  // And what the operator is shown names the incident, not the older failure.
  expect(store.listPausedProjectAdmissions().map((pause) => pause.reason))
    .toEqual(["rollback failed after a bad deploy"]);
});

it("still reports the incident when the brake itself could not be recorded", async () => {
  // Production is down. Whatever went wrong with the brake row, the owner
  // hears about the failure, the job reaches its incident state, and the
  // report says the project may still be admitting work.
  const { store, db } = storeFixture();
  const policy = unattendedPolicy();
  store.upsertProjectPolicy(policy, 1_000);
  seedDeployingJob(store, db, policy);
  seedDeployEffect(db);
  const brakeRefused: TelegramAgentStore = Object.create(store, {
    escalateProjectAdmissionPause: { value: () => false },
  }) as TelegramAgentStore;

  await runFailedDeploy(brakeRefused, { outcome: "fail" });

  expect(store.getJob("job_1")?.state).toBe("production_failed");
  expect(store.getJob("job_1")?.lastError).toContain("failure brake could not be recorded");
  // What did work is still recorded: the grant is gone either way.
  expect(store.getMergeGrantEvidence(PROJECT).revokedAt).toBe(NOW);
  expect(policyGrantIsLive(store, policy)).toBe(false);
});

it("leaves the brake without a fingerprint, so lifting it is the owner's call", async () => {
  // The agent may clear a fingerprinted cause once after investigating it. A
  // production it could not roll back is not that kind of cause.
  const { store, db } = storeFixture();
  const policy = unattendedPolicy();
  store.upsertProjectPolicy(policy, 1_000);
  seedDeployingJob(store, db, policy);
  seedDeployEffect(db);

  await runFailedDeploy(store, { outcome: "fail" });

  const row = db.prepare(
    "SELECT fingerprint FROM project_admission_pauses WHERE project_id = ? AND cleared_at IS NULL",
  ).get(PROJECT) as { fingerprint: string | null } | undefined;
  expect(row).toBeDefined();
  expect(row?.fingerprint).toBeNull();
});
