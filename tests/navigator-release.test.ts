import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { productionResourceKey, projectResourceKey } from "../src/autonomy/models";
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
import {
  ALL_MIGRATIONS,
  MANAGED_AUTOMATION_MIGRATIONS,
  MANAGED_AUTOMATION_STATE_UPGRADE_MIGRATIONS,
  NAVIGATOR_PROMOTION_MIGRATIONS,
  NAVIGATOR_RELEASE_MIGRATIONS,
  NAVIGATOR_RELEASE_REVIEW_LEDGER_UPGRADE_MIGRATIONS,
  NAVIGATOR_REVIEW_LEDGER_MIGRATIONS,
} from "../src/storage/migrations";
import { EffectRunner } from "../src/services/effect-runner";
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
  options: Readonly<{ engine?: "recipe-v1" | "navigator-v1" }> = {},
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
  bb.storage.database().prepare("UPDATE jobs SET state = 'implementing' WHERE id = ?").run(bound.id);
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
    operationId: "pr-42",
    jobId: fixture.job.id,
    number: 42,
    url: "https://github.com/acme/cyndra/pull/42",
    headSha: HEAD,
  })),
) {
  return {
    publish,
    executor: new NavigatorReleaseExecutor({
      store: fixture.store,
      publishPullRequest: publish,
      integrationWorktreeId: () => "env_job_42",
      clock: { now: fixture.now },
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

describe("navigator exact-head release", () => {
  it("preserves the shipped navigator order and appends schema repairs after it", () => {
    [...MANAGED_AUTOMATION_STATE_UPGRADE_MIGRATIONS].reverse().forEach((migration, index) => {
      expect(ALL_MIGRATIONS.at(-(index + 1))).toBe(migration);
    });
    const stateUpgradeOffset = MANAGED_AUTOMATION_STATE_UPGRADE_MIGRATIONS.length;
    expect(ALL_MIGRATIONS.at(-(stateUpgradeOffset + 1))).toBe(NAVIGATOR_RELEASE_REVIEW_LEDGER_UPGRADE_MIGRATIONS.at(-1));
    expect(ALL_MIGRATIONS.at(-(stateUpgradeOffset + 2))).toBe(MANAGED_AUTOMATION_MIGRATIONS.at(-1));
    expect(ALL_MIGRATIONS.at(-(stateUpgradeOffset + 3))).toBe(NAVIGATOR_REVIEW_LEDGER_MIGRATIONS.at(-1));
    expect(ALL_MIGRATIONS.at(-(stateUpgradeOffset + 4))).toBe(NAVIGATOR_PROMOTION_MIGRATIONS.at(-1));
    expect(ALL_MIGRATIONS.at(-(stateUpgradeOffset + 5))).toBe(NAVIGATOR_RELEASE_MIGRATIONS.at(-1));
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

    const { executor, publish } = releaseExecutor(fixture);
    expect(await executor.processOne(fence(fixture), new AbortController().signal)).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(fixture.store.getJob(fixture.job.id)).toMatchObject({
      state: "resolving_pr_head",
      prNumber: 42,
      environmentId: "env_job_42",
    });
    expect(await executor.processOne(fence(fixture), new AbortController().signal)).toBe(false);
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
