import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { productionResourceKey, projectResourceKey, repositoryMergeResourceKey } from "../src/autonomy/models";
import { CAPABILITY_BY_ID, CAPABILITY_GRAPH_DIGEST, CAPABILITY_REGISTRY_DIGEST } from "../src/capabilities/catalog";
import {
  assessGuardEnvelope,
  persistGuardEnvelopeSettlement,
  type GuardAssessmentPolicy,
  type GuardResultEnvelope,
} from "../src/capabilities/guards";
import { DEFAULT_MODEL_POOL_REGISTRY } from "../src/capabilities/models";
import { hashSecret } from "../src/crypto";
import type { Job } from "../src/domain/models";
import { assessReviewGroup } from "../src/domain/review-lenses";
import { NavigatorImplementationExecutor } from "../src/navigator/implementation-executor";
import type { NavigatorSnapshot } from "../src/navigator/models";
import { NavigatorReleaseExecutor } from "../src/navigator/release-executor";
import { navigatorReleaseOperationId } from "../src/navigator/release-contracts";
import {
  NavigatorEffectAmbiguousError,
  NavigatorEffectProtocol,
  type NavigatorEffectContext,
  type NavigatorEffectOutcome,
} from "../src/navigator/effect-protocol";
import { createNavigatorReleaseEffectAdapter } from "../src/navigator/plugin-runtime";
import {
  ALL_MIGRATIONS,
  MANAGED_AUTOMATION_MIGRATIONS,
  MANAGED_AUTOMATION_STATE_UPGRADE_MIGRATIONS,
  NAVIGATOR_EFFECT_PROTOCOL_MIGRATIONS,
  NAVIGATOR_PROMOTION_MIGRATIONS,
  NAVIGATOR_RELEASE_MIGRATIONS,
  NAVIGATOR_RELEASE_REVIEW_LEDGER_UPGRADE_MIGRATIONS,
  NAVIGATOR_REVIEW_LEDGER_MIGRATIONS,
} from "../src/storage/migrations";
import { EffectRunner } from "../src/services/effect-runner";
import { runJobExecutorService } from "../src/services/job-executor-service";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { stableWorkArtifactId, type CaptureWorkArtifactInput } from "../src/work-artifacts/repository";
import { policyFixture, sha } from "./helpers";

const HEAD = "1".repeat(40);
const EXTERNAL_DIGEST = "e".repeat(64);
let fixtureSequence = 0;

function productionPolicy() {
  return policyFixture({
    production: {
      ...policyFixture().production!,
      rollbackCommand: { name: "rollback", command: "./rollback", timeoutMs: 60_000 },
    },
  });
}

function artifactInput(input: Readonly<{
  id: string;
  operationId: string;
  kind: CaptureWorkArtifactInput["kind"];
  title: string;
  trackerOrder: number;
  relationships?: CaptureWorkArtifactInput["relationships"];
}>): CaptureWorkArtifactInput {
  return {
    artifactId: input.id,
    projectId: "proj_1",
    effortId: "job_42",
    operationId: input.operationId,
    kind: input.kind,
    status: "ready",
    trackerKind: "github",
    trackerNamespace: "github:acme/cyndra",
    externalId: input.operationId,
    externalUrl: `https://github.com/acme/cyndra/issues/${input.operationId}`,
    externalRevision: `${input.operationId}:1`,
    externalStatus: "open",
    assignees: [],
    title: input.title,
    trackerOrder: input.trackerOrder,
    content: `# ${input.title}\n\nImmutable ticket 42 fixture.`,
    acceptanceCriteria: [`${input.title} is accepted`],
    relationships: input.relationships ?? [],
    capturedAt: 1_000 + input.trackerOrder,
  };
}

function modelRoute() {
  return { pool: "standard" as const, ...DEFAULT_MODEL_POOL_REGISTRY.worker.standard };
}

type OwnedFixture = Readonly<{
  bb: ReturnType<typeof createFakePluginHost>["bb"];
  store: TelegramAgentStore;
  database: Database.Database;
  job: Job;
  specificationId: string;
  ticketIds: readonly [string, string];
  leaseGeneration: number;
  now(): number;
}>;

function bindNavigatorTickets(store: TelegramAgentStore, job: Job, now: () => number) {
  const specificationId = stableWorkArtifactId("proj_1", `spec-42-${job.id}`);
  const firstTicketId = stableWorkArtifactId("proj_1", `ticket-42-1-${job.id}`);
  const secondTicketId = stableWorkArtifactId("proj_1", `ticket-42-2-${job.id}`);
  const specification = store.captureWorkArtifact(artifactInput({
    id: specificationId,
    operationId: "42-spec",
    kind: "specification",
    title: "Ship accepted tickets through exact-head production",
    trackerOrder: 0,
  }));
  const firstTicket = store.captureWorkArtifact(artifactInput({
    id: firstTicketId,
    operationId: "42-1",
    kind: "implementation_ticket",
    title: "First release ticket",
    trackerOrder: 1,
    relationships: [{
      kind: "parent",
      sourceArtifactId: firstTicketId,
      sourceRef: `artifact:${firstTicketId}`,
      targetArtifactId: specificationId,
      targetRef: `artifact:${specificationId}`,
    }],
  }));
  const secondTicket = store.captureWorkArtifact(artifactInput({
    id: secondTicketId,
    operationId: "42-2",
    kind: "implementation_ticket",
    title: "Second release ticket",
    trackerOrder: 2,
    relationships: [{
      kind: "parent",
      sourceArtifactId: secondTicketId,
      sourceRef: `artifact:${secondTicketId}`,
      targetArtifactId: specificationId,
      targetRef: `artifact:${specificationId}`,
    }],
  }));
  const bound = store.bindNavigatorJobArtifacts({
    jobId: job.id,
    expectedVersion: job.version,
    artifactBindings: [specification, firstTicket, secondTicket].map(({ artifact, snapshot }) => ({
      artifactId: artifact.id,
      snapshotId: snapshot.id,
      snapshotDigest: snapshot.snapshotDigest,
    })),
    now: now(),
  });
  return { bound, specificationId, ticketIds: [firstTicketId, secondTicketId] as const };
}

function startResolvedIntegration(
  fixture: Pick<OwnedFixture, "store" | "database" | "job" | "specificationId" | "ticketIds" | "now">,
): void {
  const executor = new NavigatorImplementationExecutor({
    store: fixture.store,
    database: fixture.database,
    workerRunner: { run: vi.fn(), reconcileUnavailableResource: vi.fn() },
    gitObserver: {
      observe: vi.fn(async (request) => ({
        kind: "navigator_git_observation" as const,
        worktreeId: request.worktreeId,
        branch: request.integrationBranch,
        headSha: request.expectedHeadSha,
        baseHeadSha: request.baseHeadSha,
        baseHeadIsAncestor: true,
        comparisonBaseHeadSha: request.comparisonBaseHeadSha,
        comparisonBaseHeadIsAncestor: true,
        clean: true,
        changedPaths: request.expectedChangedPaths,
        evidenceRef: `git-observation:${request.expectedHeadSha}:${request.purpose}`,
        observedAt: 2_000,
      })),
    },
    pullRequests: {
      createOrRefresh: vi.fn(async (request) => ({
        operationId: request.operationId,
        jobId: request.jobId,
        number: 42,
        url: "https://github.com/acme/cyndra/pull/42",
        headSha: request.headSha,
      })),
    },
    modelRoute: () => modelRoute(),
    clock: { now: fixture.now },
  });
  executor.startIntegration({
    jobId: fixture.job.id,
    specificationArtifactId: fixture.specificationId,
    implementationTicketIds: fixture.ticketIds,
    baseBranch: "main",
    integrationBranch: "hanoon/job-42",
    worktreeId: "env_job_42",
    baseHeadSha: HEAD,
    evidenceRefs: ["ticket:42"],
  });
  const now = fixture.now();
  fixture.database.prepare(
    "UPDATE navigator_integration_tickets SET state = 'resolved', resolved_at = ? WHERE job_id = ?",
  ).run(now, fixture.job.id);
  fixture.database.prepare(
    "UPDATE navigator_integrations SET state = 'ready_for_pull_request', updated_at = ? WHERE job_id = ?",
  ).run(now, fixture.job.id);
}

function ownedFixture(
  task = "Ship the accepted navigator tickets to production",
  options: Readonly<{ engine?: "recipe-v1" | "navigator-v1"; admit?: boolean }> = {},
): OwnedFixture {
  fixtureSequence += 1;
  const { bb } = createFakePluginHost({ pluginId: `navigator-release-${fixtureSequence}` });
  let currentTime = 10_100;
  const now = () => currentTime++;
  const store = openStore(bb.storage, bb.storage.kv, now);
  const policy = productionPolicy();
  store.createPairingCode(hashSecret("pair"), 1_000, 20_000);
  if (!store.pairOwnerWithCode(hashSecret("pair"), "7", "7", 1_001).ok) throw new Error("owner pairing failed");
  store.upsertProjectPolicy(policy, 1_002);
  const lease = store.acquireExecutorLease("executor", 10_000, 120_000);
  if (!lease.acquired) throw new Error("missing executor lease");
  if (options.engine === "recipe-v1") {
    const leftover = store.createJob({
      id: `recipe-job-${String(fixtureSequence).padStart(10, "0")}`,
      sourceUpdateId: 43_000 + fixtureSequence,
      requestText: task,
      now: 10_001,
    });
    const selected = store.applyJobEvent(leftover.id, leftover.version, {
      type: "PROJECT_SELECTED",
      projectId: policy.projectId,
      policyVersion: 1,
      policy,
    }, 10_002);
    store.queueAdmission({
      jobId: selected.id,
      expectedVersion: selected.version,
      projectId: policy.projectId,
      resumeEvent: "CONFIRMED",
      now: 10_003,
    });
    return {
      bb,
      store,
      database: bb.storage.database(),
      job: selected,
      specificationId: "recipe-spec",
      ticketIds: ["recipe-ticket-1", "recipe-ticket-2"],
      leaseGeneration: lease.generation,
      now,
    };
  }
  store.appendWorkflowEngineRolloutDecision({
    action: "promote",
    reasonCode: "promotion_gates_passed",
    evidenceDigest: "a".repeat(64),
    now: 10_000,
  });
  store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 42_000 + fixtureSequence,
    inputText: task,
    now: 2_000,
  });
  const turn = store.claimNextControllerTurn({ ownerId: "executor", generation: lease.generation, now: 10_000 });
  if (!turn) throw new Error("missing controller turn");
  if (!store.markControllerSpawned({
    turnId: turn.id, ownerId: "executor", generation: lease.generation, now: 10_000,
    projectId: "proj_1", hostId: "host_1", threadId: "thr_controller_42",
  })) throw new Error("controller spawn was not recorded");
  if (!store.markControllerTurnSubmitted({
    turnId: turn.id, ownerId: "executor", generation: lease.generation, now: 10_000,
  })) throw new Error("controller submission was not recorded");
  const created = store.createConfirmedControllerJob({
    controllerThreadId: "thr_controller_42",
    projectId: "proj_1",
    task,
    now: 10_001,
  });
  const selected = store.getJob(created.id);
  if (!selected) throw new Error("converted navigator job is missing");
  const { bound, specificationId, ticketIds } = bindNavigatorTickets(store, selected, now);
  const fixture = {
    bb,
    store,
    database: bb.storage.database(),
    job: bound,
    specificationId,
    ticketIds,
    leaseGeneration: lease.generation,
    now,
  };
  startResolvedIntegration(fixture);
  if (options.admit) {
    const admission = store.tryAdmit({
      jobId: bound.id,
      maxConcurrentJobs: 8,
      ownerId: "executor",
      generation: lease.generation,
      now: now(),
      leaseMs: 120_000,
    });
    if (admission.outcome !== "admitted") throw new Error(`navigator job admission failed: ${admission.reason}`);
  } else {
    bb.storage.database().prepare("UPDATE jobs SET state = 'implementing' WHERE id = ?").run(bound.id);
  }
  const job = store.getJob(bound.id);
  if (!job) throw new Error("implementing navigator job is missing");
  return { ...fixture, job };
}

function propose(
  fixture: Pick<OwnedFixture, "store" | "job" | "now">,
  rawProposal: Record<string, unknown>,
  snapshot?: NavigatorSnapshot,
) {
  const current = snapshot ?? fixture.store.createNavigatorSnapshot({
    jobId: fixture.job.id,
    externalStateDigest: EXTERNAL_DIGEST,
    evidenceRefs: ["ticket:42"],
    now: fixture.now(),
  });
  const decision = fixture.store.recordNavigatorProposal({
    snapshotId: current.snapshotId,
    rawProposal: {
      basedOn: current.identity,
      rationale: "The implementation tickets are ready for exact-head release.",
      evidenceRefs: ["ticket:42"],
      ...rawProposal,
    },
    observation: {
      nativeToolCalls: [],
      claimedCodeWorktreeId: null,
      dynamicEffectToolIds: [],
      externalStateDigest: EXTERNAL_DIGEST,
    },
    selectModelRoute: () => modelRoute(),
    now: fixture.now(),
  });
  return { ...decision, snapshot: current };
}

function releaseExecutor(
  fixture: OwnedFixture,
  publish = vi.fn(async () => ({
    operationId: navigatorReleaseOperationId(fixture.job.id),
    jobId: fixture.job.id,
    number: 42,
    url: "https://github.com/acme/cyndra/pull/42",
    headSha: HEAD,
  })),
) {
  return {
    publish,
    executor: new NavigatorReleaseExecutor({
      publishPullRequest: publish,
      integrationWorktreeId: () => "env_job_42",
    }),
  };
}

function fence(fixture: OwnedFixture) {
  return {
    ownerId: "executor",
    generation: fixture.leaseGeneration,
    signal: new AbortController().signal,
  };
}

function releaseReceipt(context: NavigatorEffectContext): NavigatorEffectOutcome {
  if (context.kind !== "run_navigator_release") {
    return { outcome: "permanent", reason: "release receipt received another effect kind" };
  }
  return {
    outcome: "completed",
    receipt: {
      kind: "run_navigator_release",
      effectIdempotencyKey: context.effect.idempotencyKey,
      attemptId: context.attempt.id,
      jobId: context.effect.jobId,
      operationId: navigatorReleaseOperationId(context.effect.jobId),
      resource: { kind: "environment", id: "env_job_42" },
      number: 42,
      url: "https://github.com/acme/cyndra/pull/42",
      environmentId: "env_job_42",
    },
  };
}

function releaseReceiptWithIdentity(
  context: NavigatorEffectContext,
  identity: Readonly<{ jobId?: string; operationId?: string }>,
): NavigatorEffectOutcome {
  const outcome = releaseReceipt(context);
  if (outcome.outcome !== "completed" || outcome.receipt.kind !== "run_navigator_release") return outcome;
  return {
    ...outcome,
    receipt: {
      ...outcome.receipt,
      jobId: identity.jobId ?? outcome.receipt.jobId,
      operationId: identity.operationId ?? outcome.receipt.operationId,
    },
  };
}

function insertProjectClaim(fixture: OwnedFixture): void {
  const now = fixture.now();
  for (const requirement of releaseClaimRequirements(fixture)) {
    fixture.database.prepare(
      `INSERT INTO job_resource_claims (
         job_id, resource_key, resource_kind, state, owner_id, generation,
         lease_expires_at, acquired_at, renewed_at
       ) VALUES (?, ?, ?, 'held', ?, ?, ?, ?, ?)`,
    ).run(
      fixture.job.id,
      requirement.resourceKey,
      requirement.resourceKind,
      "executor",
      fixture.leaseGeneration,
      130_000,
      now,
      now,
    );
  }
}

type ClaimCase = "empty" | "unrelated" | "wrong key" | "wrong kind" | "wrong owner" | "wrong generation" | "expired" | "valid exact";
const CLAIM_CASES: readonly ClaimCase[] = [
  "empty", "unrelated", "wrong key", "wrong kind", "wrong owner", "wrong generation", "expired", "valid exact",
];

function releaseClaimRequirements(fixture: OwnedFixture): readonly {
  resourceKind: "project" | "repository_merge" | "production_target";
  resourceKey: string;
}[] {
  const policy = fixture.store.getJob(fixture.job.id)?.policy;
  if (!policy) throw new Error("release claim matrix policy is missing");
  return [
    { resourceKind: "project", resourceKey: projectResourceKey(policy.projectId) },
    { resourceKind: "repository_merge", resourceKey: repositoryMergeResourceKey(policy.githubRepository) },
    ...(policy.production === undefined ? [] : [{
      resourceKind: "production_target" as const,
      resourceKey: productionResourceKey(policy),
    }]),
  ];
}

function configureReleaseClaimCase(
  fixture: OwnedFixture,
  effectIdempotencyKey: string,
  claimCase: ClaimCase,
  now: number,
): void {
  const requirements = releaseClaimRequirements(fixture);
  if (claimCase !== "empty") {
    for (const [index, requirement] of requirements.entries()) {
      const resourceKind = claimCase === "wrong kind"
        ? requirement.resourceKind === "project" ? "repository_merge" : "project"
        : requirement.resourceKind;
      const resourceKey = claimCase === "unrelated"
        ? `unrelated:${String(index)}`
        : claimCase === "wrong key" && index === 0 ? `${requirement.resourceKey}:other` : requirement.resourceKey;
      const ownerId = claimCase === "wrong owner" ? "release-matrix-other" : "executor";
      const generation = claimCase === "wrong generation" ? 2 : 1;
      const expiresAt = claimCase === "expired" || claimCase === "valid exact" ? now : now + 30_000;
      fixture.database.prepare(
        `INSERT INTO job_resource_claims (
           job_id, resource_key, resource_kind, state, owner_id, generation,
           lease_expires_at, acquired_at, renewed_at
         ) VALUES (?, ?, ?, 'held', ?, ?, ?, ?, ?)`,
      ).run(fixture.job.id, resourceKey, resourceKind, ownerId, generation, expiresAt, now, now);
    }
  }
  if (claimCase === "valid exact") {
    fixture.database.prepare(
      `UPDATE effects SET status = 'leased', lease_owner = 'executor', lease_generation = 1, lease_expires_at = ?
        WHERE idempotency_key = ?`,
    ).run(now, effectIdempotencyKey);
  }
}

function expireReleaseLeases(
  fixture: OwnedFixture,
  effectIdempotencyKey: string,
  now: number,
): void {
  fixture.database.prepare(
    `UPDATE effects
        SET status = 'leased', lease_owner = 'stale-release', lease_generation = ?,
            lease_expires_at = ?, next_attempt_at = ?
      WHERE idempotency_key = ?`,
  ).run(fixture.leaseGeneration, now, now, effectIdempotencyKey);
  fixture.database.prepare(
    `UPDATE job_resource_claims
        SET lease_expires_at = ?, renewed_at = ?
      WHERE job_id = ? AND state = 'held'`,
  ).run(now, now, fixture.job.id);
}

function prepareExpiredReleaseForSuccessor(
  fixture: OwnedFixture,
  effectIdempotencyKey: string,
  now: number,
): void {
  expireReleaseLeases(fixture, effectIdempotencyKey, now);
  if (!fixture.store.releaseExecutorLease("executor", fixture.leaseGeneration, now)) {
    throw new Error("release predecessor lease was not released");
  }
}

function failedStage(
  phase: "deploy" | "canary",
  rollback: "pass" | "fail" | "missing" | "timed_out",
) {
  return {
    phase,
    outcome: "fail" as const,
    summary: `Production ${phase} failed`,
    failedCommand: phase,
    commandReceipts: [
      { name: "verify-merged-checkout", command: "git-head-check", outcome: "pass" as const, exitCode: 0, output: "ok" },
      { name: phase, command: `./${phase}`, outcome: "fail" as const, exitCode: 1, output: "boom" },
    ],
    ...(rollback === "missing" ? {} : {
      rollback: {
        name: "rollback",
        command: "./rollback",
        outcome: rollback === "timed_out" ? "timed_out" as const : rollback,
        exitCode: rollback === "pass" ? 0 : rollback === "timed_out" ? null : 1,
        output: "rolled",
      },
    }),
    terminalIds: [`term_${phase}`],
    completedAt: "2026-08-10T00:01:00.000Z",
  };
}

function seedProductionEffect(
  fixture: OwnedFixture,
  state: "deploying" | "verifying_production",
): string {
  const job = fixture.store.getJob(fixture.job.id);
  if (!job?.policy || !job.projectId) throw new Error("production job policy is missing");
  const policy = job.policy;
  const db = fixture.database;
  db.prepare(
    `UPDATE jobs SET state = ?, environment_id = 'env_job_42', pr_number = 42,
       pr_url = 'https://github.com/acme/cyndra/pull/42', pr_head_sha = ?,
       merge_message = 'Merged pull request #42', merge_commit_sha = ?,
       merged_at = '2026-08-10T00:00:00.000Z', version = version + 1
     WHERE id = ?`,
  ).run(state, sha("a"), sha("d"), job.id);
  db.prepare("UPDATE effects SET status = 'done' WHERE job_id = ?").run(job.id);
  db.prepare(
    `UPDATE job_admissions SET project_id = ?, state = 'admitted', admitted_at = 10100 WHERE job_id = ?`,
  ).run(job.projectId, job.id);
  const held = db.prepare(
    "SELECT 1 FROM job_resource_claims WHERE job_id = ? AND state = 'held' LIMIT 1",
  ).get(job.id);
  if (!held) {
    const insertClaim = db.prepare(
      `INSERT INTO job_resource_claims (
         job_id, resource_key, resource_kind, state, owner_id, generation,
         lease_expires_at, acquired_at, renewed_at
       ) VALUES (?, ?, ?, 'held', 'executor', ?, 130000, 10100, 10100)`,
    );
    insertClaim.run(job.id, projectResourceKey(job.projectId), "project", fixture.leaseGeneration);
    insertClaim.run(job.id, productionResourceKey(policy), "production_target", fixture.leaseGeneration);
  }
  const current = fixture.store.getJob(job.id);
  if (!current) throw new Error("production job disappeared");
  const kind = state === "deploying" ? "deploy_production" : "verify_production";
  const key = `${current.id}:${current.version + 1}:${kind}`;
  db.prepare(
    `INSERT INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, '{}', 'pending', 0, 10100, 10100, 10100)`,
  ).run(key, current.id, kind);
  return key;
}

async function runLeasedProduction(
  fixture: OwnedFixture,
  key: string,
  stage: ReturnType<typeof failedStage> | {
    phase: "deploy" | "canary";
    outcome: "pass";
    summary: string;
    failedCommand: null;
    commandReceipts: Array<{ name: string; command: string; outcome: "pass"; exitCode: number; output: string }>;
    terminalIds: string[];
    completedAt: string;
  },
): Promise<void> {
  const claimed = fixture.store.leaseNextJobEffect({
    jobId: fixture.job.id,
    ownerId: "executor",
    generation: fixture.leaseGeneration,
    now: fixture.now(),
    leaseMs: 30_000,
  });
  if (!claimed || claimed.idempotencyKey !== key) throw new Error("production effect was not leased");
  await new EffectRunner({
    store: fixture.store,
    fence: fence(fixture),
    now: fixture.now,
    runProductionStage: vi.fn(async () => stage),
  }).run(claimed);
  fixture.store.completeEffect(claimed.idempotencyKey, "executor", fixture.leaseGeneration, fixture.now());
}

function prepareApproval(fixture: OwnedFixture, headSha: string): string {
  const policy = fixture.store.getJob(fixture.job.id)?.policy ?? productionPolicy();
  const db = fixture.database;
  db.prepare(
    `UPDATE jobs SET state = 'awaiting_merge_approval', project_id = ?, policy_version = 1,
       policy_json = ?, environment_id = 'env_job_42', pr_number = 42,
       pr_url = 'https://github.com/acme/cyndra/pull/42', pr_head_sha = ?, version = version + 1
     WHERE id = ?`,
  ).run(policy.projectId, JSON.stringify(policy), headSha, fixture.job.id);
  db.prepare(
    `UPDATE job_admissions SET project_id = ?, state = 'admitted', admitted_at = 10100 WHERE job_id = ?`,
  ).run(policy.projectId, fixture.job.id);
  db.prepare("UPDATE effects SET status = 'done' WHERE job_id = ?").run(fixture.job.id);
  const current = fixture.store.getJob(fixture.job.id);
  if (!current) throw new Error("approval job is missing");
  const held = db.prepare(
    "SELECT 1 FROM job_resource_claims WHERE job_id = ? AND resource_kind = 'project' AND state = 'held'",
  ).get(current.id);
  if (!held) {
    db.prepare(
      `INSERT INTO job_resource_claims (
         job_id, resource_key, resource_kind, state, owner_id, generation,
         lease_expires_at, acquired_at, renewed_at
       ) VALUES (?, ?, 'project', 'held', 'executor', ?, 130000, 10100, 10100)`,
    ).run(current.id, projectResourceKey(policy.projectId), fixture.leaseGeneration);
  }
  const key = `${current.id}:${current.version}:issue_approval`;
  db.prepare(
    `INSERT INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, 'issue_approval', ?, 'pending', 0, 10100, 10100, 10100)`,
  ).run(key, current.id, JSON.stringify({ headSha }));
  return key;
}

async function runApproval(fixture: OwnedFixture, key: string): Promise<void> {
  const claimed = fixture.store.leaseNextJobEffect({
    jobId: fixture.job.id,
    ownerId: "executor",
    generation: fixture.leaseGeneration,
    now: fixture.now(),
    leaseMs: 30_000,
  });
  if (!claimed || claimed.idempotencyKey !== key) throw new Error("approval effect was not leased");
  await new EffectRunner({
    store: fixture.store,
    fence: fence(fixture),
    now: fixture.now,
  }).run(claimed);
}

function admitCompetingMerge(fixture: OwnedFixture): string {
  const policy = {
    ...productionPolicy(),
    projectId: "proj_2",
    alias: "cyndra-competitor",
  };
  fixture.store.upsertProjectPolicy(policy, fixture.now());
  const now = fixture.now();
  const controllerKey = "owner-7-competitor";
  const turn = fixture.store.enqueueControllerTurn({
    controllerKey,
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 50_000 + fixtureSequence,
    inputText: "Ship the competing release",
    now,
  });
  const claimed = fixture.store.claimNextControllerTurn({
    ownerId: "executor",
    generation: fixture.leaseGeneration,
    now,
  });
  if (!claimed || claimed.id !== turn.id) throw new Error("competing controller turn was not claimed");
  if (!fixture.store.markControllerSpawned({
    turnId: turn.id,
    ownerId: "executor",
    generation: fixture.leaseGeneration,
    now,
    projectId: policy.projectId,
    hostId: "host_competitor",
    threadId: "thr_controller_competitor",
  })) throw new Error("competing controller spawn was not recorded");
  if (!fixture.store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: "executor",
    generation: fixture.leaseGeneration,
    now,
  })) throw new Error("competing controller submission was not recorded");
  const created = fixture.store.createConfirmedControllerJob({
    controllerThreadId: "thr_controller_competitor",
    projectId: policy.projectId,
    task: "Ship the competing release",
    now,
  });
  const selected = fixture.store.getJob(created.id);
  if (!selected) throw new Error("competing navigator job is missing");
  const admission = fixture.store.tryAdmit({
    jobId: selected.id,
    maxConcurrentJobs: 8,
    ownerId: "executor",
    generation: fixture.leaseGeneration,
    now: fixture.now(),
    leaseMs: 120_000,
  });
  if (admission.outcome !== "admitted") throw new Error(`competing job admission failed: ${admission.reason}`);

  fixture.database.prepare(
    `UPDATE jobs SET state = 'awaiting_merge_approval', environment_id = 'env_competitor',
       pr_number = 99, pr_url = 'https://github.com/acme/cyndra/pull/99', pr_head_sha = ?,
       version = version + 1 WHERE id = ?`,
  ).run(HEAD, selected.id);
  const awaitingApproval = fixture.store.getJob(selected.id);
  if (!awaitingApproval) throw new Error("competing approval job is missing");
  const accepted = fixture.store.acceptTaskAuthorityAndEnqueueMerge({
    jobId: selected.id,
    expectedJobVersion: awaitingApproval.version,
    headSha: HEAD,
    ownerId: "executor",
    generation: fixture.leaseGeneration,
    now: fixture.now(),
  });
  if (!accepted.ok) throw new Error(`competing merge acceptance failed: ${accepted.reason}`);
  fixture.database.prepare("UPDATE effects SET status = 'done' WHERE job_id = ? AND kind <> 'merge_pr'").run(selected.id);
  const leased = fixture.store.leaseNextJobEffect({
    jobId: selected.id,
    ownerId: "executor",
    generation: fixture.leaseGeneration,
    now: fixture.now(),
    leaseMs: 120_000,
  });
  if (!leased || leased.kind !== "merge_pr") throw new Error("competing merge did not acquire its claims");
  return selected.id;
}

describe("navigator exact-head release", () => {
  it("preserves the shipped navigator order and appends schema repairs after it", () => {
    expect(ALL_MIGRATIONS.at(-1)).toBe(NAVIGATOR_EFFECT_PROTOCOL_MIGRATIONS.at(-1));
    const protocolOffset = NAVIGATOR_EFFECT_PROTOCOL_MIGRATIONS.length;
    [...MANAGED_AUTOMATION_STATE_UPGRADE_MIGRATIONS].reverse().forEach((migration, index) => {
      expect(ALL_MIGRATIONS.at(-(protocolOffset + index + 1))).toBe(migration);
    });
    const stateUpgradeOffset = MANAGED_AUTOMATION_STATE_UPGRADE_MIGRATIONS.length;
    expect(ALL_MIGRATIONS.at(-(protocolOffset + stateUpgradeOffset + 1))).toBe(
      NAVIGATOR_RELEASE_REVIEW_LEDGER_UPGRADE_MIGRATIONS.at(-1),
    );
    expect(ALL_MIGRATIONS.at(-(protocolOffset + stateUpgradeOffset + 2))).toBe(MANAGED_AUTOMATION_MIGRATIONS.at(-1));
    expect(ALL_MIGRATIONS.at(-(protocolOffset + stateUpgradeOffset + 3))).toBe(NAVIGATOR_REVIEW_LEDGER_MIGRATIONS.at(-1));
    expect(ALL_MIGRATIONS.at(-(protocolOffset + stateUpgradeOffset + 4))).toBe(NAVIGATOR_PROMOTION_MIGRATIONS.at(-1));
    expect(ALL_MIGRATIONS.at(-(protocolOffset + stateUpgradeOffset + 5))).toBe(NAVIGATOR_RELEASE_MIGRATIONS.at(-1));
    expect(NAVIGATOR_RELEASE_MIGRATIONS[0]).toContain("CREATE TABLE navigator_release_attempts");
    expect(NAVIGATOR_RELEASE_MIGRATIONS[0]).toContain("CREATE TABLE production_recovery_observations");
    expect(NAVIGATOR_RELEASE_MIGRATIONS[0]).toContain("production_recovery_required");
  });

  it("rejects start_release without resolved tickets or a permitted outcome", () => {
    const fixture = ownedFixture();
    fixture.database.prepare(
      "UPDATE navigator_integration_tickets SET state = 'pending', resolved_at = NULL WHERE job_id = ?",
    ).run(fixture.job.id);
    fixture.database.prepare(
      "UPDATE navigator_integrations SET state = 'implementing' WHERE job_id = ?",
    ).run(fixture.job.id);

    expect(propose(fixture, {
      kind: "start_release",
      implementationTicketIds: [...fixture.ticketIds],
    })).toMatchObject({ decision: "rejected", reasonCode: "release_prerequisites_incomplete" });

    fixture.database.prepare(
      "UPDATE jobs SET task_outcome = 'artifact', task_constraints_json = ? WHERE id = ?",
    ).run(JSON.stringify(["artifact_only"]), fixture.job.id);
    expect(propose(fixture, {
      kind: "start_release",
      implementationTicketIds: [...fixture.ticketIds],
    })).toMatchObject({ decision: "rejected", reasonCode: "release_outcome_not_permitted" });
  });

  it("accepts start_release once and leases one restart-safe release effect", async () => {
    const fixture = ownedFixture();
    const first = propose(fixture, {
      kind: "start_release",
      implementationTicketIds: [...fixture.ticketIds],
    });
    expect(first).toMatchObject({
      decision: "accepted",
      reasonCode: "accepted",
      workflowStepId: expect.any(String),
      effectIdempotencyKey: expect.stringContaining(":run_release"),
    });
    const job = fixture.store.getJob(fixture.job.id);
    expect(job).toMatchObject({
      currentWorkflowStepId: first.workflowStepId,
      state: "implementing",
    });
    expect(fixture.store.listEffectsForJob(fixture.job.id).filter((effect) => effect.kind === "run_navigator_release"))
      .toEqual([expect.objectContaining({
        idempotencyKey: first.effectIdempotencyKey,
        status: "pending",
      })]);

    const replay = propose(fixture, {
      kind: "start_release",
      implementationTicketIds: [...fixture.ticketIds],
    }, first.snapshot);
    expect(replay).toMatchObject({
      decision: "accepted",
      proposalId: first.proposalId,
      effectIdempotencyKey: first.effectIdempotencyKey,
    });
    expect(fixture.store.listEffectsForJob(fixture.job.id).filter((effect) => effect.kind === "run_navigator_release"))
      .toHaveLength(1);

    insertProjectClaim(fixture);

    const { executor, publish } = releaseExecutor(fixture);
    const protocol = new NavigatorEffectProtocol({
      store: fixture.store,
      clock: { now: fixture.now },
      adapters: [
        {
          kind: "run_navigator_skill",
          execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused in this test" })),
        },
        {
          kind: "run_navigator_ticket_worker",
          execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused in this test" })),
        },
        createNavigatorReleaseEffectAdapter(executor),
      ],
    });
    expect(await protocol.processOne(fence(fixture), new AbortController().signal)).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(fixture.store.getJob(fixture.job.id)).toMatchObject({
      state: "resolving_pr_head",
      prNumber: 42,
      environmentId: "env_job_42",
    });
    expect(await protocol.processOne(fence(fixture), new AbortController().signal)).toBe(false);
    expect(publish).toHaveBeenCalledTimes(1);
    const reopened = openStore(fixture.bb.storage, fixture.bb.storage.kv, fixture.now);
    expect(reopened.getJob(fixture.job.id)).toMatchObject({
      state: "resolving_pr_head",
      prNumber: 42,
      environmentId: "env_job_42",
    });
    expect(reopened.listEffectsForJob(fixture.job.id).find((effect) => effect.kind === "run_navigator_release"))
      .toMatchObject({ status: "done" });
  });

  it("leases and settles release claims acquired after ordinary admission", async () => {
    const fixture = ownedFixture("Ship normally admitted tickets to production", { admit: true });
    expect(fixture.store.listCurrentHeldResourceClaims(fixture.job.id, 10).map((claim) => claim.resourceKind))
      .toEqual(["project"]);
    const accepted = propose(fixture, {
      kind: "start_release",
      implementationTicketIds: [...fixture.ticketIds],
    });
    if (!accepted.effectIdempotencyKey) throw new Error("ordinary admission release effect was not stored");
    const now = fixture.now();
    prepareExpiredReleaseForSuccessor(fixture, accepted.effectIdempotencyKey, now);
    const { executor, publish } = releaseExecutor(fixture);
    const protocol = new NavigatorEffectProtocol({
      store: fixture.store,
      clock: { now: () => now },
      adapters: [
        { kind: "run_navigator_skill", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_ticket_worker", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        createNavigatorReleaseEffectAdapter(executor),
      ],
    });
    const abort = new AbortController();
    await runJobExecutorService({
      store: fixture.store,
      clock: { now: () => now },
      leaseMs: 1_000,
      navigatorEffects: protocol,
      effectRunnerFactory: () => ({ run: async () => undefined }),
      waitForWork: async () => abort.abort(),
      releaseOnShutdown: true,
    }, abort.signal);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      operationId: navigatorReleaseOperationId(fixture.job.id),
      jobId: fixture.job.id,
      title: "Ship normally admitted tickets to production",
      body: "Exact-head release of the accepted implementation tickets.",
    });
    expect(fixture.store.getEffect(fixture.job.id, accepted.effectIdempotencyKey)).toMatchObject({ status: "done" });
    expect(fixture.store.getJob(fixture.job.id)).toMatchObject({
      state: "resolving_pr_head",
      prNumber: 42,
      environmentId: "env_job_42",
    });
    expect(fixture.store.listCurrentHeldResourceClaims(fixture.job.id, 10)
      .map((claim) => `${claim.resourceKind}:${claim.resourceKey}`).sort()).toEqual(
      releaseClaimRequirements(fixture).map((claim) => `${claim.resourceKind}:${claim.resourceKey}`).sort(),
    );
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_effect_receipts WHERE effect_idempotency_key = ?",
    ).get(accepted.effectIdempotencyKey)).toEqual({ count: 1 });
    const receiptRow = fixture.database.prepare(
      "SELECT receipt_json FROM navigator_effect_receipts WHERE effect_idempotency_key = ?",
    ).get(accepted.effectIdempotencyKey) as { receipt_json: string } | undefined;
    expect(JSON.parse(receiptRow?.receipt_json ?? "{}")).toMatchObject({
      jobId: fixture.job.id,
      operationId: navigatorReleaseOperationId(fixture.job.id),
    });
  });

  it.each([
    ["execution", "jobId"],
    ["execution", "operationId"],
    ["reconciliation", "jobId"],
    ["reconciliation", "operationId"],
  ] as const)("rejects a mismatched release %s %s without a transition or receipt", async (phase, field) => {
    const fixture = ownedFixture("Reject mismatched release provider identity", { admit: true });
    const accepted = propose(fixture, {
      kind: "start_release",
      implementationTicketIds: [...fixture.ticketIds],
    });
    if (!accepted.effectIdempotencyKey) throw new Error("release identity effect was not stored");
    const identity = field === "jobId"
      ? { jobId: "job-release-other" }
      : { operationId: navigatorReleaseOperationId("job-release-other") };
    const adapter = {
      kind: "run_navigator_release" as const,
      execute: vi.fn(async (context: NavigatorEffectContext): Promise<NavigatorEffectOutcome> => phase === "execution"
        ? releaseReceiptWithIdentity(context, identity)
        : { outcome: "ambiguous" as const, reason: "release receipt was lost" }),
      reconcile: vi.fn(async (context: NavigatorEffectContext) => releaseReceiptWithIdentity(context, identity)),
    };
    const protocol = new NavigatorEffectProtocol({
      store: fixture.store,
      clock: { now: fixture.now },
      adapters: [
        { kind: "run_navigator_skill", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_ticket_worker", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        adapter,
      ],
    });

    await expect(protocol.processOne(fence(fixture), new AbortController().signal)).resolves.toBe(true);

    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(adapter.reconcile).toHaveBeenCalledTimes(phase === "reconciliation" ? 1 : 0);
    expect(fixture.store.getEffect(fixture.job.id, accepted.effectIdempotencyKey)).toMatchObject({ status: "failed" });
    expect(fixture.store.getJob(fixture.job.id)).toMatchObject({
      state: "implementing",
      currentWorkflowStepId: accepted.workflowStepId,
    });
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_effect_receipts WHERE effect_idempotency_key = ?",
    ).get(accepted.effectIdempotencyKey)).toEqual({ count: 0 });
  });

  it("refuses a stale release generation before acquiring its missing claims", () => {
    const fixture = ownedFixture("Reject a stale release generation", { admit: true });
    const accepted = propose(fixture, {
      kind: "start_release",
      implementationTicketIds: [...fixture.ticketIds],
    });
    if (!accepted.effectIdempotencyKey) throw new Error("stale release effect was not stored");
    const now = fixture.now();
    prepareExpiredReleaseForSuccessor(fixture, accepted.effectIdempotencyKey, now);
    const successor = fixture.store.acquireExecutorLease("successor", now, 1_000);
    if (!successor.acquired) throw new Error("successor executor lease was not acquired");

    expect(fixture.store.leaseNavigatorEffect({
      ownerId: "executor",
      generation: fixture.leaseGeneration,
      now,
      leaseMs: 1_000,
    })).toBeNull();
    expect(fixture.store.getEffect(fixture.job.id, accepted.effectIdempotencyKey)).toMatchObject({
      status: "leased",
      leaseOwner: "stale-release",
      leaseGeneration: fixture.leaseGeneration,
    });
    expect(fixture.store.listCurrentHeldResourceClaims(fixture.job.id, 10)).toHaveLength(1);
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_effect_receipts WHERE effect_idempotency_key = ?",
    ).get(accepted.effectIdempotencyKey)).toEqual({ count: 0 });
  });

  it("refuses a release claim conflict without partially leasing or acquiring claims", () => {
    const fixture = ownedFixture("Reject a competing repository release", { admit: true });
    const competingJobId = admitCompetingMerge(fixture);
    const accepted = propose(fixture, {
      kind: "start_release",
      implementationTicketIds: [...fixture.ticketIds],
    });
    if (!accepted.effectIdempotencyKey) throw new Error("conflicting release effect was not stored");
    const before = fixture.store.listCurrentHeldResourceClaims(fixture.job.id, 10);

    expect(fixture.store.leaseNavigatorEffect({
      ownerId: "executor",
      generation: fixture.leaseGeneration,
      now: fixture.now(),
      leaseMs: 120_000,
    })).toBeNull();
    expect(fixture.store.getEffect(fixture.job.id, accepted.effectIdempotencyKey)).toMatchObject({
      status: "pending",
      attempts: 0,
    });
    expect(fixture.store.listCurrentHeldResourceClaims(fixture.job.id, 10)).toEqual(before);
    expect(fixture.store.listCurrentHeldResourceClaims(competingJobId, 10)
      .map((claim) => claim.resourceKind).sort()).toEqual(["production_target", "project", "repository_merge"]);
  });

  it("does not complete a release effect when the adapter omits its receipt", async () => {
    const fixture = ownedFixture();
    const accepted = propose(fixture, {
      kind: "start_release",
      implementationTicketIds: [...fixture.ticketIds],
    });
    if (!accepted.effectIdempotencyKey) throw new Error("release receipt test effect was not stored");
    insertProjectClaim(fixture);
    const adapter = vi.fn(async (): Promise<NavigatorEffectOutcome> => ({
      outcome: "completed",
      receipt: undefined as never,
    }));
    const protocol = new NavigatorEffectProtocol({
      store: fixture.store,
      clock: { now: fixture.now },
      adapters: [
        { kind: "run_navigator_skill", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_ticket_worker", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_release", execute: adapter },
      ],
    });

    await expect(protocol.processOne(fence(fixture), new AbortController().signal)).resolves.toBe(true);

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(fixture.store.getEffect(fixture.job.id, accepted.effectIdempotencyKey)).toMatchObject({ status: "dead" });
  });

  it("rolls back a typed release receipt when receipt persistence fails", async () => {
    const fixture = ownedFixture();
    const accepted = propose(fixture, {
      kind: "start_release",
      implementationTicketIds: [...fixture.ticketIds],
    });
    if (!accepted.effectIdempotencyKey) throw new Error("release rollback effect was not stored");
    insertProjectClaim(fixture);
    fixture.database.exec(
      `CREATE TRIGGER navigator_test_fail_release_receipt
       BEFORE INSERT ON navigator_effect_receipts
       WHEN NEW.kind = 'run_navigator_release'
       BEGIN SELECT RAISE(ABORT, 'release receipt fault'); END`,
    );
    const protocol = new NavigatorEffectProtocol({
      store: fixture.store,
      clock: { now: fixture.now },
      adapters: [
        { kind: "run_navigator_skill", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_ticket_worker", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_release", execute: async (context) => releaseReceipt(context) },
      ],
    });

    await expect(protocol.processOne(fence(fixture), new AbortController().signal)).resolves.toBe(true);

    expect(fixture.store.getEffect(fixture.job.id, accepted.effectIdempotencyKey)).toMatchObject({ status: "failed" });
    expect(fixture.store.getJob(fixture.job.id)).toMatchObject({ state: "implementing" });
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_effect_receipts WHERE effect_idempotency_key = ?",
    ).get(accepted.effectIdempotencyKey)).toEqual({ count: 0 });
  });

  it("does not settle a release after an entry claim is lost before atomic settlement", async () => {
    const fixture = ownedFixture();
    const accepted = propose(fixture, {
      kind: "start_release",
      implementationTicketIds: [...fixture.ticketIds],
    });
    if (!accepted.effectIdempotencyKey) throw new Error("release claim fence effect was not stored");
    insertProjectClaim(fixture);
    const adapter = vi.fn(async (context: NavigatorEffectContext): Promise<NavigatorEffectOutcome> => {
      fixture.database.prepare(
        `UPDATE job_resource_claims
            SET state = 'released', released_at = ?, release_reason = 'entry claim lost'
          WHERE job_id = ? AND resource_kind = 'project' AND state = 'held'`,
      ).run(fixture.now(), fixture.job.id);
      return releaseReceipt(context);
    });
    const protocol = new NavigatorEffectProtocol({
      store: fixture.store,
      clock: { now: fixture.now },
      adapters: [
        { kind: "run_navigator_skill", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_ticket_worker", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_release", execute: adapter },
      ],
    });

    await expect(protocol.processOne(fence(fixture), new AbortController().signal)).resolves.toBe(true);

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(fixture.store.getEffect(fixture.job.id, accepted.effectIdempotencyKey)).toMatchObject({ status: "failed" });
    expect(fixture.store.getJob(fixture.job.id)).toMatchObject({ state: "implementing" });
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_effect_receipts WHERE effect_idempotency_key = ?",
    ).get(accepted.effectIdempotencyKey)).toEqual({ count: 0 });
  });

  it("reconciles an ambiguous release outcome with a typed receipt", async () => {
    const fixture = ownedFixture();
    const accepted = propose(fixture, {
      kind: "start_release",
      implementationTicketIds: [...fixture.ticketIds],
    });
    if (!accepted.effectIdempotencyKey) throw new Error("release reconciliation effect was not stored");
    insertProjectClaim(fixture);
    const execute = vi.fn(async () => ({ outcome: "ambiguous" as const, reason: "publish receipt was lost" }));
    const reconcile = vi.fn(async (context: NavigatorEffectContext) => releaseReceipt(context));
    const protocol = new NavigatorEffectProtocol({
      store: fixture.store,
      clock: { now: fixture.now },
      adapters: [
        { kind: "run_navigator_skill", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_ticket_worker", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_release", execute, reconcile },
      ],
    });

    await expect(protocol.processOne(fence(fixture), new AbortController().signal)).resolves.toBe(true);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(fixture.store.getEffect(fixture.job.id, accepted.effectIdempotencyKey)).toMatchObject({ status: "done" });
    expect(fixture.database.prepare(
      "SELECT kind FROM navigator_effect_receipts WHERE effect_idempotency_key = ?",
    ).get(accepted.effectIdempotencyKey)).toEqual({ kind: "run_navigator_release" });
  });

  it("reconciles ambiguous release entry through the shared release adapter", async () => {
    const fixture = ownedFixture();
    const accepted = propose(fixture, {
      kind: "start_release",
      implementationTicketIds: [...fixture.ticketIds],
    });
    if (!accepted.effectIdempotencyKey) throw new Error("release adapter reconciliation effect was not stored");
    insertProjectClaim(fixture);
    const executeEntry = vi.fn(async () => {
      throw new NavigatorEffectAmbiguousError("release publication receipt was lost");
    });
    const reconcileEntry = vi.fn(async () => ({
      operationId: navigatorReleaseOperationId(fixture.job.id),
      jobId: fixture.job.id,
      number: 42,
      url: "https://github.com/acme/cyndra/pull/42",
      headSha: HEAD,
    }));
    const adapter = createNavigatorReleaseEffectAdapter({
      executeEntry,
      reconcileEntry,
      integrationEnvironmentId: () => "env_job_42",
    });
    const protocol = new NavigatorEffectProtocol({
      store: fixture.store,
      clock: { now: fixture.now },
      adapters: [
        { kind: "run_navigator_skill", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_ticket_worker", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        adapter,
      ],
    });

    await expect(protocol.processOne(fence(fixture), new AbortController().signal)).resolves.toBe(true);

    expect(executeEntry).toHaveBeenCalledTimes(1);
    expect(reconcileEntry).toHaveBeenCalledTimes(1);
    expect(fixture.store.getEffect(fixture.job.id, accepted.effectIdempotencyKey)).toMatchObject({ status: "done" });
    expect(fixture.store.getJob(fixture.job.id)).toMatchObject({ state: "resolving_pr_head" });
  });

  it("reconciles an ambiguous release entry through the real executor service", async () => {
    const fixture = ownedFixture();
    const accepted = propose(fixture, {
      kind: "start_release",
      implementationTicketIds: [...fixture.ticketIds],
    });
    if (!accepted.effectIdempotencyKey) throw new Error("release service reconciliation effect was not stored");
    insertProjectClaim(fixture);
    const now = fixture.now();
    prepareExpiredReleaseForSuccessor(fixture, accepted.effectIdempotencyKey, now);
    const executeEntry = vi.fn(async () => {
      throw new NavigatorEffectAmbiguousError("release publication receipt was lost");
    });
    const reconcileEntry = vi.fn(async () => ({
      operationId: navigatorReleaseOperationId(fixture.job.id),
      jobId: fixture.job.id,
      number: 42,
      url: "https://github.com/acme/cyndra/pull/42",
      headSha: HEAD,
    }));
    const protocol = new NavigatorEffectProtocol({
      store: fixture.store,
      clock: { now: () => now },
      adapters: [
        { kind: "run_navigator_skill", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_ticket_worker", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        createNavigatorReleaseEffectAdapter({
          executeEntry,
          reconcileEntry,
          integrationEnvironmentId: () => "env_job_42",
        }),
      ],
    });
    const abort = new AbortController();
    await runJobExecutorService({
      store: fixture.store,
      clock: { now: () => now },
      leaseMs: 1_000,
      navigatorEffects: protocol,
      effectRunnerFactory: () => ({ run: async () => undefined }),
      waitForWork: async () => abort.abort(),
      releaseOnShutdown: true,
    }, abort.signal);

    expect(executeEntry).toHaveBeenCalledTimes(1);
    expect(reconcileEntry).toHaveBeenCalledTimes(1);
    expect(fixture.store.getEffect(fixture.job.id, accepted.effectIdempotencyKey)).toMatchObject({ status: "done" });
    expect(fixture.store.getJob(fixture.job.id)).toMatchObject({ state: "resolving_pr_head" });
  });

  it.each(CLAIM_CASES)("runs the release executor only with the exact claim set (%s)", async (claimCase) => {
    const fixture = ownedFixture();
    const accepted = propose(fixture, {
      kind: "start_release",
      implementationTicketIds: [...fixture.ticketIds],
    });
    if (!accepted.effectIdempotencyKey) throw new Error("release claim matrix effect was not stored");
    const now = fixture.now();
    configureReleaseClaimCase(fixture, accepted.effectIdempotencyKey, claimCase, now);
    if (!fixture.store.releaseExecutorLease("executor", fixture.leaseGeneration, now)) {
      throw new Error("release claim matrix predecessor lease was not released");
    }
    const execute = vi.fn(async (context: NavigatorEffectContext) => releaseReceipt(context));
    const protocol = new NavigatorEffectProtocol({
      store: fixture.store,
      clock: { now: () => now },
      leaseMs: 30,
      adapters: [
        { kind: "run_navigator_skill", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_ticket_worker", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_release", execute },
      ],
    });
    const abort = new AbortController();
    await runJobExecutorService({
      store: fixture.store,
      clock: { now: () => now },
      leaseMs: 1_000,
      navigatorEffects: protocol,
      effectRunnerFactory: () => ({ run: async () => undefined }),
      waitForWork: async () => abort.abort(),
      releaseOnShutdown: true,
    }, abort.signal);

    expect(execute).toHaveBeenCalledTimes(claimCase === "valid exact" ? 1 : 0);
    expect(fixture.store.getEffect(fixture.job.id, accepted.effectIdempotencyKey)).toMatchObject({
      status: claimCase === "valid exact" ? "done" : "pending",
    });
    if (claimCase === "valid exact") {
      const heldClaims = fixture.store.listCurrentHeldResourceClaims(fixture.job.id, 10);
      expect(heldClaims.map((claim) => `${claim.resourceKind}:${claim.resourceKey}`).sort()).toEqual(
        releaseClaimRequirements(fixture).map((claim) => `${claim.resourceKind}:${claim.resourceKey}`).sort(),
      );
    }
  });

  it("keeps release entry restartable when the executor lease is lost in flight", async () => {
    const fixture = ownedFixture();
    const accepted = propose(fixture, {
      kind: "start_release",
      implementationTicketIds: [...fixture.ticketIds],
    });
    if (!accepted.effectIdempotencyKey) throw new Error("release lease-loss effect was not stored");
    insertProjectClaim(fixture);
    const now = fixture.now();
    prepareExpiredReleaseForSuccessor(fixture, accepted.effectIdempotencyKey, now);
    const publish = vi.fn(async () => {
      const currentLease = fixture.database.prepare(
        "SELECT owner_id, generation FROM executor_lease WHERE singleton = 1",
      ).get() as { owner_id: string | null; generation: number } | undefined;
      if (!currentLease?.owner_id) throw new Error("release lease-loss executor was not acquired");
      const takeover = fixture.database.prepare(
        `UPDATE executor_lease SET owner_id = 'stale-release', generation = generation + 1,
            lease_expires_at = ?
          WHERE singleton = 1 AND owner_id = ? AND generation = ?`,
      ).run(now + 10_000, currentLease.owner_id, currentLease.generation);
      if (takeover.changes !== 1) throw new Error("release lease-loss takeover did not win");
      await new Promise<void>(() => undefined);
      return {
        operationId: navigatorReleaseOperationId(fixture.job.id),
        jobId: fixture.job.id,
        number: 42,
        url: "https://github.com/acme/cyndra/pull/42",
        headSha: HEAD,
      };
    });
    const release = new NavigatorReleaseExecutor({
      publishPullRequest: publish,
      integrationWorktreeId: () => "env_job_42",
    });
    const protocol = new NavigatorEffectProtocol({
      store: fixture.store,
      clock: { now: () => now },
      leaseMs: 30,
      adapters: [
        { kind: "run_navigator_skill", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_ticket_worker", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        createNavigatorReleaseEffectAdapter(release),
      ],
    });
    const abort = new AbortController();
    const sleep = vi.fn(async (_milliseconds: number, sleepSignal: AbortSignal) => {
      abort.abort();
      throw sleepSignal.reason ?? new Error("successor could not acquire the executor lease");
    });
    const service = runJobExecutorService({
      store: fixture.store,
      clock: { now: () => now },
      leaseMs: 1_000,
      sleep,
      navigatorEffects: protocol,
      effectRunnerFactory: () => ({ run: async () => undefined }),
      waitForWork: async () => { throw new Error("lease loss must stop before the ordinary wait"); },
      releaseOnShutdown: true,
    }, abort.signal);

    await service;

    expect(publish).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(fixture.store.getEffect(fixture.job.id, accepted.effectIdempotencyKey)).toMatchObject({ status: "leased" });
    expect(fixture.store.getJob(fixture.job.id)).toMatchObject({ state: "implementing" });
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_effect_receipts WHERE effect_idempotency_key = ?",
    ).get(accepted.effectIdempotencyKey)).toEqual({ count: 0 });
    expect(fixture.database.prepare(
      "SELECT owner_id FROM executor_lease WHERE singleton = 1",
    ).get()).toEqual({ owner_id: "stale-release" });
  });

  it("retries the same release operation after entry completed before a restart", async () => {
    const fixture = ownedFixture();
    const accepted = propose(fixture, {
      kind: "start_release",
      implementationTicketIds: [...fixture.ticketIds],
    });
    if (!accepted.effectIdempotencyKey) throw new Error("release restart effect was not stored");
    insertProjectClaim(fixture);
    const now = fixture.now();
    prepareExpiredReleaseForSuccessor(fixture, accepted.effectIdempotencyKey, now);
    let entryCount = 0;
    const publish = vi.fn(async () => {
      entryCount += 1;
      const currentLease = fixture.database.prepare(
        "SELECT owner_id, generation FROM executor_lease WHERE singleton = 1",
      ).get() as { owner_id: string | null; generation: number } | undefined;
      if (!currentLease?.owner_id) throw new Error("release restart executor was not acquired");
      if (entryCount === 1) {
        const takeover = fixture.database.prepare(
          `UPDATE executor_lease SET owner_id = 'stale-release', generation = generation + 1,
              lease_expires_at = ?
            WHERE singleton = 1 AND owner_id = ? AND generation = ?`,
        ).run(now + 10_000, currentLease.owner_id, currentLease.generation);
        if (takeover.changes !== 1) throw new Error("release restart takeover did not win");
      }
      return {
        operationId: navigatorReleaseOperationId(fixture.job.id),
        jobId: fixture.job.id,
        number: 42,
        url: "https://github.com/acme/cyndra/pull/42",
        headSha: HEAD,
      };
    });
    const release = new NavigatorReleaseExecutor({
      publishPullRequest: publish,
      integrationWorktreeId: () => "env_job_42",
    });
    const protocol = new NavigatorEffectProtocol({
      store: fixture.store,
      clock: { now: () => now },
      leaseMs: 30,
      adapters: [
        { kind: "run_navigator_skill", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_ticket_worker", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        createNavigatorReleaseEffectAdapter(release),
      ],
    });
    const firstAbort = new AbortController();
    const firstSleep = vi.fn(async (_milliseconds: number, sleepSignal: AbortSignal) => {
      firstAbort.abort();
      throw sleepSignal.reason ?? new Error("successor could not acquire the executor lease");
    });
    await runJobExecutorService({
      store: fixture.store,
      clock: { now: () => now },
      leaseMs: 1_000,
      sleep: firstSleep,
      navigatorEffects: protocol,
      effectRunnerFactory: () => ({ run: async () => undefined }),
      waitForWork: async () => { throw new Error("first release restart must stop after lease loss"); },
      releaseOnShutdown: true,
    }, firstAbort.signal);

    const takeoverLease = fixture.database.prepare(
      "SELECT owner_id, generation FROM executor_lease WHERE singleton = 1",
    ).get() as { owner_id: string | null; generation: number } | undefined;
    if (!takeoverLease?.owner_id) throw new Error("release restart takeover lease is missing");
    expect(fixture.store.releaseExecutorLease(takeoverLease.owner_id, takeoverLease.generation, now)).toBe(true);
    expireReleaseLeases(fixture, accepted.effectIdempotencyKey, now);

    const secondAbort = new AbortController();
    await runJobExecutorService({
      store: fixture.store,
      clock: { now: () => now },
      leaseMs: 1_000,
      navigatorEffects: protocol,
      effectRunnerFactory: () => ({ run: async () => undefined }),
      waitForWork: async () => secondAbort.abort(),
      releaseOnShutdown: true,
    }, secondAbort.signal);

    expect(firstSleep).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(fixture.store.getEffect(fixture.job.id, accepted.effectIdempotencyKey)).toMatchObject({ status: "done" });
    expect(fixture.store.getJob(fixture.job.id)).toMatchObject({
      state: "resolving_pr_head",
      prNumber: 42,
      environmentId: "env_job_42",
    });
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_effect_receipts WHERE effect_idempotency_key = ?",
    ).get(accepted.effectIdempotencyKey)).toEqual({ count: 1 });
  });

  it("restarts a release that was leased before entry began", async () => {
    const fixture = ownedFixture();
    const accepted = propose(fixture, {
      kind: "start_release",
      implementationTicketIds: [...fixture.ticketIds],
    });
    if (!accepted.effectIdempotencyKey) throw new Error("release pre-entry restart effect was not stored");
    insertProjectClaim(fixture);
    const now = fixture.now();
    prepareExpiredReleaseForSuccessor(fixture, accepted.effectIdempotencyKey, now);
    const firstExecute = vi.fn(async (): Promise<NavigatorEffectOutcome> => ({
      outcome: "lease_cancelled",
      reason: "executor restarted before release entry",
    }));
    const firstProtocol = new NavigatorEffectProtocol({
      store: fixture.store,
      clock: { now: () => now },
      adapters: [
        { kind: "run_navigator_skill", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_ticket_worker", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_release", execute: firstExecute },
      ],
    });
    const firstAbort = new AbortController();
    await runJobExecutorService({
      store: fixture.store,
      clock: { now: () => now },
      leaseMs: 1_000,
      navigatorEffects: firstProtocol,
      effectRunnerFactory: () => ({ run: async () => undefined }),
      waitForWork: async () => firstAbort.abort(),
      releaseOnShutdown: true,
    }, firstAbort.signal);

    expect(firstExecute).toHaveBeenCalledTimes(1);
    expect(fixture.store.getEffect(fixture.job.id, accepted.effectIdempotencyKey)).toMatchObject({ status: "failed" });
    expect(fixture.store.getJob(fixture.job.id)).toMatchObject({ state: "implementing" });
    expireReleaseLeases(fixture, accepted.effectIdempotencyKey, now);
    const publish = vi.fn(async () => ({
      operationId: navigatorReleaseOperationId(fixture.job.id),
      jobId: fixture.job.id,
      number: 42,
      url: "https://github.com/acme/cyndra/pull/42",
      headSha: HEAD,
    }));
    const secondProtocol = new NavigatorEffectProtocol({
      store: fixture.store,
      clock: { now: () => now },
      adapters: [
        { kind: "run_navigator_skill", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_ticket_worker", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        createNavigatorReleaseEffectAdapter(new NavigatorReleaseExecutor({
          publishPullRequest: publish,
          integrationWorktreeId: () => "env_job_42",
        })),
      ],
    });
    const secondAbort = new AbortController();
    await runJobExecutorService({
      store: fixture.store,
      clock: { now: () => now },
      leaseMs: 1_000,
      navigatorEffects: secondProtocol,
      effectRunnerFactory: () => ({ run: async () => undefined }),
      waitForWork: async () => secondAbort.abort(),
      releaseOnShutdown: true,
    }, secondAbort.signal);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(fixture.store.getEffect(fixture.job.id, accepted.effectIdempotencyKey)).toMatchObject({ status: "done" });
    expect(fixture.store.getJob(fixture.job.id)).toMatchObject({ state: "resolving_pr_head" });
    expect(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_effect_receipts WHERE effect_idempotency_key = ?",
    ).get(accepted.effectIdempotencyKey)).toEqual({ count: 1 });
  });

  it("auto-authorizes a shipped navigator merge without a standing grant and re-derives after head drift", async () => {
    const fixture = ownedFixture();
    const firstHead = sha("b");
    const firstKey = prepareApproval(fixture, firstHead);
    await runApproval(fixture, firstKey);

    expect(fixture.store.getJob(fixture.job.id)).toMatchObject({ state: "merging", prHeadSha: firstHead });
    expect(fixture.store.listEffectsForJob(fixture.job.id).some((effect) => effect.kind === "merge_pr")).toBe(true);
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM approvals WHERE job_id = ?").get(fixture.job.id))
      .toEqual({ count: 1 });
    expect(fixture.store.getMergeAuthority("proj_1")).toBeNull();

    fixture.database.prepare(
      "UPDATE jobs SET state = 'validating', pr_head_sha = ? WHERE id = ?",
    ).run(firstHead, fixture.job.id);
    const validating = fixture.store.getJob(fixture.job.id)!;
    fixture.store.applyJobEvent(validating.id, validating.version, {
      type: "VALIDATION_FAILED",
      headSha: firstHead,
      reason: "Validation did not pass",
    }, fixture.now());
    expect(fixture.store.getJob(fixture.job.id)).toMatchObject({ state: "implementing", prHeadSha: null });

    const secondHead = sha("c");
    const secondKey = prepareApproval(fixture, secondHead);
    await runApproval(fixture, secondKey);
    expect(fixture.store.getJob(fixture.job.id)).toMatchObject({ state: "merging", prHeadSha: secondHead });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM approvals WHERE job_id = ?").get(fixture.job.id))
      .toEqual({ count: 2 });
  });

  it("returns validation findings to navigation and leaves recipe remediating on the same event", () => {
    const fixture = ownedFixture();
    propose(fixture, {
      kind: "start_release",
      implementationTicketIds: [...fixture.ticketIds],
    });
    const current = fixture.store.getJob(fixture.job.id)!;
    const released = fixture.store.applyJobEvent(current.id, current.version, {
      type: "RELEASE_STARTED",
      number: 42,
      url: "https://github.com/acme/cyndra/pull/42",
      environmentId: "env_job_42",
    }, fixture.now());
    const headed = fixture.store.applyJobEvent(released.id, released.version, {
      type: "PR_HEAD_RESOLVED",
      headSha: sha("a"),
    }, fixture.now());
    const returned = fixture.store.applyJobEvent(headed.id, headed.version, {
      type: "VALIDATION_FAILED",
      headSha: sha("a"),
      reason: "Validation did not pass",
    }, fixture.now());
    expect(returned).toMatchObject({
      state: "implementing",
      prHeadSha: null,
      currentWorkflowStepId: null,
    });
    expect(fixture.store.listEffectsForJob(fixture.job.id).some((effect) => effect.kind === "send_remediation"))
      .toBe(false);
    expect(fixture.database.prepare(
      "SELECT reason_code, previous_state FROM navigator_release_findings WHERE job_id = ?",
    ).all(fixture.job.id)).toEqual([
      { reason_code: "validation_failed", previous_state: "validating" },
    ]);
  });

  it("records final exact-head review findings in the normalized release convergence ledger", () => {
    const fixture = ownedFixture();
    propose(fixture, {
      kind: "start_release",
      implementationTicketIds: [...fixture.ticketIds],
    });
    fixture.database.prepare(
      `UPDATE jobs
          SET state = 'final_reviewing', pr_head_sha = ?, review_thread_id = 'thr_final_quality',
              routing_mode = 'active', delivery_mode = 'small_fix'
        WHERE id = ?`,
    ).run(HEAD, fixture.job.id);
    const current = fixture.store.getJob(fixture.job.id)!;
    const attempt = fixture.store.createExecutorAttempt({
      id: "attempt_final_review_quality",
      jobId: fixture.job.id,
      kind: "review",
      reviewLens: "quality",
      reviewStage: "final_review",
      ordinal: 1,
      headSha: HEAD,
      ownerId: "executor",
      generation: fixture.leaseGeneration,
      now: fixture.now(),
    });
    if (!attempt) throw new Error("final review attempt was not created");
    const guard = CAPABILITY_BY_ID.get("docs-guard");
    if (!guard) throw new Error("docs guard is missing");
    const profile = fixture.store.createCapabilityProfile({
      subjectKind: "worker_attempt",
      subjectId: attempt.id,
      threadId: "thr_final_quality",
      recipeId: "bounded",
      recipeVersion: 1,
      registryDigest: CAPABILITY_REGISTRY_DIGEST,
      graphDigest: CAPABILITY_GRAPH_DIGEST,
      mode: "active",
      model: {
        pool: "strong",
        providerId: "codex-provider",
        modelId: "gpt-5.6-sol",
        reasoning: "high",
        serviceTier: "fast",
      },
      assignments: [{
        capabilityId: guard.id,
        descriptorDigest: guard.digest,
        capabilityKind: "skill",
        mandatory: true,
      }],
      reasonCodes: [],
      traits: ["docs-changed"],
      now: fixture.now(),
    });
    const diffDigest = "d".repeat(64);
    const guardPolicy: GuardAssessmentPolicy = {
      profileId: profile.id,
      profileRevision: profile.revision,
      reviewedHeadSha: HEAD,
      diffDigest,
      selectedGuards: [{
        capabilityId: guard.id,
        descriptorDigest: guard.digest,
        mandatory: true,
        substitutes: [],
      }],
      requirementIds: [],
      mustFixRuleIds: ["docs.required"],
      advisoryRuleIds: [],
    };
    const guardEnvelope: GuardResultEnvelope = {
      schemaVersion: 1,
      profileId: profile.id,
      profileRevision: profile.revision,
      reviewedHeadSha: HEAD,
      diffDigest,
      guards: [{
        capabilityId: guard.id,
        descriptorDigest: guard.digest,
        outcome: "findings",
        findings: [{
          ruleId: "docs.required",
          severity: "high",
          subject: "docs/usage.md",
          line: 4,
          evidence: "The exact-head behavior is not documented.",
          evidenceClass: "documentation",
          requirementId: null,
        }],
      }],
    };
    const assessment = assessGuardEnvelope(guardEnvelope, guardPolicy);
    expect(assessment.outcome).toBe("changes_requested");
    expect(fixture.store.updateExecutorAttempt({
      jobId: fixture.job.id,
      attemptId: attempt.id,
      patch: {
        threadId: "thr_final_quality",
        result: {
          outcome: "changes_requested",
          reviewedHeadSha: HEAD,
          reasons: assessment.reasons,
          guardEnvelope,
          guardPolicy,
        },
      },
      ownerId: "executor",
      generation: fixture.leaseGeneration,
      now: fixture.now(),
    })).not.toBeNull();
    persistGuardEnvelopeSettlement({
      repository: fixture.store,
      scopeId: `release-review:${fixture.job.id}`,
      envelope: guardEnvelope,
      policy: guardPolicy,
      now: fixture.now(),
    });
    const group = assessReviewGroup(
      fixture.store.listReviewAttempts(fixture.job.id, "final_review", 1),
      "small_fix",
      HEAD,
    );

    expect(fixture.store.applyExecutorJobEvent({
      jobId: fixture.job.id,
      expectedVersion: current.version,
      event: {
        type: "REVIEW_CHANGES_REQUESTED",
        headSha: HEAD,
        summary: group.summary ?? "",
        findings: group.findings,
        reasons: group.reasons,
      },
      ownerId: "executor",
      generation: fixture.leaseGeneration,
      now: fixture.now(),
    })).toMatchObject({ state: "implementing" });
    expect(fixture.database.prepare(
      `SELECT capability_id, rule_id, disposition, event, head_sha, blocking_burden
         FROM navigator_release_review_finding_events WHERE job_id = ?`,
    ).all(fixture.job.id)).toEqual([{
      capability_id: "docs-guard",
      rule_id: "docs.required",
      disposition: "must_fix",
      event: "opened",
      head_sha: HEAD,
      blocking_burden: 1,
    }]);
  });

  it("recovers one successful rollback to navigation and exhausts a repeated signature", async () => {
    const fixture = ownedFixture();
    const firstKey = seedProductionEffect(fixture, "deploying");
    await runLeasedProduction(fixture, firstKey, failedStage("deploy", "pass"));

    expect(fixture.store.getJob(fixture.job.id)).toMatchObject({
      state: "implementing",
      prHeadSha: null,
    });
    expect(fixture.store.countNavigatorReleaseIncidents({
      jobId: fixture.job.id,
      phase: "deploy",
      failureSignature: "deploy",
      rollbackOutcome: "pass",
    })).toBe(1);
    expect(fixture.store.getOutbox(`job:${fixture.job.id}:production-incident:deploy`)).toMatchObject({
      payload: {
        text: "Production deploy failed. The configured rollback restored the previous release. No action is required.",
      },
    });
    expect(fixture.store.listPausedProjectAdmissions()).toEqual([]);
    expect(fixture.store.getTaskAuthority(fixture.job.id)?.status).toBe("active");
    expect(fixture.store.listOwnerBoundaries(fixture.job.id)).toEqual([]);

    const secondKey = seedProductionEffect(fixture, "deploying");
    await runLeasedProduction(fixture, secondKey, failedStage("deploy", "pass"));
    expect(fixture.store.getJob(fixture.job.id)?.state).toBe("production_failed");
    expect(fixture.store.getTaskAuthority(fixture.job.id)?.status).toBe("suspended");
    expect(fixture.store.listPausedProjectAdmissions().map((pause) => pause.projectId)).toEqual(["proj_1"]);
    expect(fixture.store.listOwnerBoundaries(fixture.job.id)).toEqual([
      expect.objectContaining({ code: "production_recovery_required", status: "pending" }),
    ]);
    const reopened = openStore(fixture.bb.storage, fixture.bb.storage.kv, fixture.now);
    expect(reopened.listOwnerBoundaries(fixture.job.id)[0]).toMatchObject({
      code: "production_recovery_required",
      goal: "Restore production after a failed release",
    });
  });

  it("records a distinct owner notice for each successful rollback phase", async () => {
    const fixture = ownedFixture();
    await runLeasedProduction(fixture, seedProductionEffect(fixture, "deploying"), failedStage("deploy", "pass"));
    expect(fixture.store.getJob(fixture.job.id)).toMatchObject({
      state: "implementing",
      prHeadSha: null,
    });
    expect(fixture.store.getOutbox(`job:${fixture.job.id}:production-incident:deploy`)).toMatchObject({
      payload: {
        text: "Production deploy failed. The configured rollback restored the previous release. No action is required.",
      },
    });

    await runLeasedProduction(
      fixture,
      seedProductionEffect(fixture, "verifying_production"),
      failedStage("canary", "pass"),
    );
    expect(fixture.store.getJob(fixture.job.id)).toMatchObject({
      state: "implementing",
      prHeadSha: null,
    });
    expect(fixture.store.getOutbox(`job:${fixture.job.id}:production-incident:canary`)).toMatchObject({
      payload: {
        text: "Production canary failed. The configured rollback restored the previous release. No action is required.",
      },
    });
    expect(fixture.store.getOutbox(`job:${fixture.job.id}:production-incident:deploy`)).toMatchObject({
      payload: {
        text: "Production deploy failed. The configured rollback restored the previous release. No action is required.",
      },
    });
  });

  it("fails missing, failed, and indeterminate rollback into production recovery", async () => {
    const missing = ownedFixture();
    await runLeasedProduction(missing, seedProductionEffect(missing, "deploying"), failedStage("deploy", "missing"));
    expect(missing.store.getJob(missing.job.id)?.state).toBe("production_failed");
    expect(missing.store.listOwnerBoundaries(missing.job.id)[0]?.code).toBe("production_recovery_required");

    const failed = ownedFixture();
    await runLeasedProduction(failed, seedProductionEffect(failed, "verifying_production"), failedStage("canary", "fail"));
    expect(failed.store.getJob(failed.job.id)?.state).toBe("production_failed");
    expect(failed.store.getTaskAuthority(failed.job.id)?.status).toBe("suspended");

    const unknown = ownedFixture();
    await runLeasedProduction(unknown, seedProductionEffect(unknown, "deploying"), failedStage("deploy", "timed_out"));
    expect(unknown.store.getJob(unknown.job.id)?.state).toBe("production_failed");
    expect(unknown.store.countNavigatorReleaseIncidents({
      jobId: unknown.job.id,
      phase: "deploy",
      failureSignature: "deploy",
      rollbackOutcome: "indeterminate",
    })).toBe(1);
  });

  it("keeps recipe jobs failed after a successful rollback", async () => {
    const fixture = ownedFixture("Ship a recipe production rollback", { engine: "recipe-v1" });
    await runLeasedProduction(fixture, seedProductionEffect(fixture, "deploying"), failedStage("deploy", "pass"));
    expect(fixture.store.getJob(fixture.job.id)?.state).toBe("production_failed");
    expect(fixture.store.getOutbox(`job:${fixture.job.id}:production-incident:deploy`)).toBeNull();
    expect(fixture.store.listOwnerBoundaries(fixture.job.id)).toEqual([]);
  });

  it("rejects finish without durable release evidence and accepts it after complete", () => {
    const fixture = ownedFixture();
    expect(propose(fixture, {
      kind: "finish",
      artifactIds: [...fixture.ticketIds],
    })).toMatchObject({ decision: "rejected", reasonCode: "completion_evidence_missing" });

    fixture.database.prepare("UPDATE jobs SET state = 'complete' WHERE id = ?").run(fixture.job.id);
    const accepted = propose(fixture, {
      kind: "finish",
      artifactIds: [...fixture.ticketIds],
    });
    expect(accepted).toMatchObject({ decision: "accepted", reasonCode: "completion_recorded" });
    expect(fixture.store.listEffectsForJob(fixture.job.id).filter((effect) => effect.kind === "run_navigator_release"))
      .toEqual([]);
    const replay = propose(fixture, {
      kind: "finish",
      artifactIds: [...fixture.ticketIds],
    }, accepted.snapshot);
    expect(replay.proposalId).toBe(accepted.proposalId);
  });
});
