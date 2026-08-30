import type Database from "better-sqlite3";
import { DEFAULT_MODEL_POOL_REGISTRY } from "../capabilities/models";
import type { ProjectPolicy } from "../domain/models";
import { productionResourceKey, projectResourceKey } from "../autonomy/models";
import { EffectRunner } from "../services/effect-runner";
import type { ProductionStageSnapshot } from "../services/production-runner";
import type { TelegramAgentStore } from "../storage/store";
import { stableWorkArtifactId, type CaptureWorkArtifactInput } from "../work-artifacts/repository";
import { trackerCreateDigest } from "../work-artifacts/tracker";
import { navigatorAcceptanceCriteria } from "./implementation-contracts";
import {
  NavigatorImplementationExecutor,
  type NavigatorGitObservationRequest,
  type NavigatorTicketWorkerAttempt,
} from "./implementation-executor";
import type { NavigatorEvaluationCase } from "./evaluation-corpus";
import type { DualEngineRestartPoint } from "./promotion";

const EXTERNAL_DIGEST = "e".repeat(64);
const BASE_HEAD = "1".repeat(40);
const NEXT_HEAD = "2".repeat(40);

function restartPolicyFor(projectId: string): ProjectPolicy {
  return {
    projectId,
    alias: "eval",
    enabled: true,
    githubRepository: "acme/eval",
    baseBranch: "main",
    implementation: { model: "implementation-model" },
    review: { model: "review-model" },
    validationCommands: [{ name: "unit", command: "npm test", timeoutMs: 600_000 }],
    requiredChecks: ["test"],
    outputRedactionPatterns: [],
    workerStartGraceMs: 120_000,
    workerLivenessWatchdogMs: 300_000,
    workerRecoveryLimit: 2,
    maxReviewCycles: 3,
    mergeMethod: "squash",
    production: {
      deployCommands: [{ name: "deploy", command: "./deploy", timeoutMs: 60_000 }],
      canaryCommands: [{ name: "canary", command: "./canary", timeoutMs: 60_000 }],
      rollbackCommand: { name: "rollback", command: "./rollback", timeoutMs: 60_000 },
      convexDeployRequired: false,
    },
  };
}

export type NavigatorRestartPointResult = Readonly<{
  matched: boolean;
  duplicateMutations: number;
  actual: Readonly<{ decision: string; reasonCode: string }>;
}>;

function proposalModelRoute() {
  return { pool: "strong" as const, ...DEFAULT_MODEL_POOL_REGISTRY.worker.strong };
}

function workerModelRoute() {
  return { pool: "standard" as const, ...DEFAULT_MODEL_POOL_REGISTRY.worker.standard };
}

function artifactInput(input: Readonly<{
  projectId: string;
  artifactId: string;
  operationId: string;
  kind: CaptureWorkArtifactInput["kind"];
  title: string;
  trackerOrder: number;
}>): CaptureWorkArtifactInput {
  return {
    artifactId: input.artifactId,
    projectId: input.projectId,
    effortId: "effort_restart",
    operationId: input.operationId,
    kind: input.kind,
    status: "ready",
    trackerKind: "github",
    trackerNamespace: "github:acme/eval",
    externalId: input.operationId,
    externalUrl: `https://github.com/acme/eval/issues/${input.operationId}`,
    externalRevision: `${input.operationId}:1`,
    externalStatus: "open",
    assignees: [],
    title: input.title,
    trackerOrder: input.trackerOrder,
    content: `# ${input.title}\n\nRestart evaluation artifact.`,
    acceptanceCriteria: [`${input.title} is accepted`],
    relationships: [],
    capturedAt: 1_000 + input.trackerOrder,
  };
}

function gitObservation(request: NavigatorGitObservationRequest) {
  return {
    kind: "navigator_git_observation" as const,
    worktreeId: request.worktreeId,
    branch: request.integrationBranch,
    headSha: request.expectedHeadSha,
    baseHeadSha: request.baseHeadSha,
    baseHeadIsAncestor: true,
    comparisonBaseHeadSha: request.comparisonBaseHeadSha,
    comparisonBaseHeadIsAncestor: true,
    clean: true,
    changedPaths: [...request.expectedChangedPaths],
    evidenceRef: `git-observation:${request.expectedHeadSha}`,
    observedAt: 2_000,
  };
}

function workerResult(attempt: NavigatorTicketWorkerAttempt, store: TelegramAgentStore) {
  if (attempt.kind === "implementation") {
    const ticketSnapshot = store.getWorkArtifactSnapshot(attempt.workOrder.ticket.snapshotId)!;
    return {
      kind: "implementation_result" as const,
      baseHeadSha: attempt.workOrder.baseHeadSha,
      headSha: NEXT_HEAD,
      summary: "Implemented.",
      changedPaths: ["src/app.ts"],
      focusedVerification: [{ command: "npm test", outcome: "passed" as const }],
      fullVerification: [{ command: "npm run check", outcome: "passed" as const }],
      acceptanceCriteria: navigatorAcceptanceCriteria(ticketSnapshot).map(({ id }) => ({
        criterionId: id,
        outcome: "passed" as const,
        evidenceRefs: [`acceptance:${id}`],
      })),
      capabilityOutcomes: attempt.profile.assignments.map(({ capabilityId }) => ({
        capabilityId, outcome: "passed" as const, evidenceRefs: [`worker:${attempt.id}`],
      })),
    };
  }
  return {
    kind: "code_review_result" as const,
    reviewedHeadSha: attempt.workOrder.baseHeadSha,
    outcome: "passed" as const,
    summary: "Passed.",
    axes: {
      requirements: { outcome: "passed" as const, evidenceRefs: [`requirements:${attempt.id}`] },
      standards: { outcome: "passed" as const, evidenceRefs: [`standards:${attempt.id}`] },
    },
    findings: [],
    capabilityOutcomes: attempt.profile.assignments.map(({ capabilityId }) => ({
      capabilityId, outcome: "passed" as const, evidenceRefs: [`worker:${attempt.id}`],
    })),
  };
}

function resultFromDuplicates(duplicateMutations: number): NavigatorRestartPointResult {
  return {
    duplicateMutations,
    matched: duplicateMutations === 0,
    actual: duplicateMutations === 0
      ? { decision: "accepted", reasonCode: "accepted" }
      : { decision: "rejected", reasonCode: "duplicate_mutation" },
  };
}

function openRestartJob(
  store: TelegramAgentStore,
  database: Database.Database,
  sequence: number,
  now: () => number,
): Readonly<{
  jobId: string;
  specificationId: string;
  ticketId: string;
  leaseGeneration: number;
}> {
  const projectId = `proj_rst_${sequence}`;
  const specificationId = stableWorkArtifactId(projectId, `restart-spec-${sequence}`);
  const ticketId = stableWorkArtifactId(projectId, `restart-ticket-${sequence}`);
  const specification = store.captureWorkArtifact(artifactInput({
    projectId,
    artifactId: specificationId,
    operationId: `restart-spec-${sequence}`,
    kind: "specification",
    title: "Restart specification",
    trackerOrder: 0,
  }));
  const ticket = store.captureWorkArtifact({
    ...artifactInput({
      projectId,
      artifactId: ticketId,
      operationId: `restart-ticket-${sequence}`,
      kind: "implementation_ticket",
      title: "Restart ticket",
      trackerOrder: 1,
    }),
    relationships: [{
      kind: "parent",
      sourceArtifactId: ticketId,
      sourceRef: `artifact:${ticketId}`,
      targetArtifactId: specificationId,
      targetRef: `artifact:${specificationId}`,
    }],
  });
  const draft = store.createJob({
    id: `job_restart_${sequence}`,
    sourceUpdateId: 91_000 + sequence,
    requestText: "Measure dual-engine restart safety.",
    workflow: { engine: "navigator-v1", mode: "deterministic" },
    now: now(),
  });
  const selected = store.applyJobEvent(draft.id, draft.version, {
    type: "PROJECT_SELECTED",
    projectId,
    policyVersion: 1,
    policy: restartPolicyFor(projectId),
  }, now());
  store.bindNavigatorJobArtifacts({
    jobId: selected.id,
    expectedVersion: selected.version,
    artifactBindings: [specification, ticket].map(({ artifact, snapshot }) => ({
      artifactId: artifact.id,
      snapshotId: snapshot.id,
      snapshotDigest: snapshot.snapshotDigest,
    })),
    now: now(),
  });
  database.prepare("UPDATE jobs SET task_outcome = ?, task_constraints_json = ?, state = 'implementing' WHERE id = ?")
    .run("shipped_change", JSON.stringify([]), selected.id);
  const lease = store.acquireExecutorLease(`restart-exec-${sequence}`, now(), 120_000);
  if (!lease.acquired) throw new Error("restart evaluation lease was unavailable");
  return { jobId: selected.id, specificationId, ticketId, leaseGeneration: lease.generation };
}

function claimTicket(
  store: TelegramAgentStore,
  ticketId: string,
  jobId: string,
  ownerId: string,
  generation: number,
  now: () => number,
) {
  const artifact = store.getWorkArtifact(ticketId);
  const snapshot = store.getCurrentWorkArtifactSnapshot(ticketId);
  if (!artifact || !snapshot) throw new Error("restart ticket is missing");
  store.observeWorkArtifact({
    artifactId: ticketId,
    expectedExternalRevision: artifact.externalRevision,
    externalRevision: `${artifact.externalRevision}:claimed`,
    externalStatus: "open",
    assignees: ["owner"],
    title: snapshot.title,
    content: snapshot.content,
    acceptanceCriteria: snapshot.acceptanceCriteria,
    relationships: snapshot.relationships,
    observedAt: now(),
  });
  return store.claimWorkArtifact({
    artifactId: ticketId,
    workflowStepId: `implement:${ticketId}`,
    jobId,
    snapshotId: snapshot.id,
    externalAssignee: "owner",
    ownerId,
    generation,
    now: now(),
    leaseMs: 100_000,
  });
}

function implementationExecutor(
  store: TelegramAgentStore,
  database: Database.Database,
  now: () => number,
) {
  return new NavigatorImplementationExecutor({
    store,
    database,
    workerRunner: {
      run: async (attempt, hooks) => {
        const resource = attempt.resource ?? { kind: "bb_thread" as const, id: `thr_${attempt.id}` };
        await hooks.bindResource(resource);
        return { resource, result: workerResult(attempt, store) };
      },
      reconcileUnavailableResource: async (resource) => ({
        resource,
        state: "missing" as const,
        evidenceRef: "unavailable",
        observedAt: 0,
      }),
    },
    gitObserver: { observe: async (request) => gitObservation(request) },
    pullRequests: {
      createOrRefresh: async (request) => ({
        jobId: request.jobId,
        number: 43,
        url: "https://github.com/acme/eval/pull/43",
        headSha: request.headSha,
        operationId: request.operationId,
      }),
    },
    modelRoute: () => workerModelRoute(),
    clock: { now },
  });
}

function uniqueEffectCount(store: TelegramAgentStore, jobId: string, kind: string): number {
  const effects = store.listEffectsForJob(jobId).filter((effect) => effect.kind === kind);
  return effects.length - new Set(effects.map((effect) => effect.idempotencyKey)).size;
}

function countRows(
  database: Database.Database,
  sql: string,
  params: readonly unknown[],
): number {
  const row = database.prepare(sql).get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}

function driveToMergeCall(
  store: TelegramAgentStore,
  jobId: string,
  now: () => number,
): void {
  const start = store.getJob(jobId)!;
  const released = store.applyJobEvent(start.id, start.version, {
    type: "RELEASE_STARTED",
    number: 43,
    url: "https://github.com/acme/eval/pull/43",
    environmentId: "env_eval_restart",
  }, now());
  const headed = store.applyJobEvent(released.id, released.version, {
    type: "PR_HEAD_RESOLVED",
    headSha: NEXT_HEAD,
  }, now());
  const validated = store.applyJobEvent(headed.id, headed.version, {
    type: "VALIDATION_PASSED",
    headSha: NEXT_HEAD,
  }, now());
  const reviewed = store.applyJobEvent(validated.id, validated.version, {
    type: "REVIEW_PASSED",
    headSha: NEXT_HEAD,
  }, now());
  store.applyJobEvent(reviewed.id, reviewed.version, {
    type: "APPROVAL_ACCEPTED",
    headSha: NEXT_HEAD,
  }, now());
}

function seedProductionSeam(
  store: TelegramAgentStore,
  database: Database.Database,
  jobId: string,
  ownerId: string,
  generation: number,
  now: () => number,
  state: "deploying" | "verifying_production",
): void {
  const job = store.getJob(jobId);
  if (!job?.policy || !job.projectId) throw new Error("restart production job is missing");
  database.prepare(
    `UPDATE jobs SET state = ?, environment_id = 'env_eval_restart', pr_number = 43,
       pr_url = 'https://github.com/acme/eval/pull/43', pr_head_sha = ?,
       merge_message = 'Merged pull request #43', merge_commit_sha = ?,
       merged_at = '2026-08-10T00:00:00.000Z', version = version + 1
     WHERE id = ?`,
  ).run(state, NEXT_HEAD, "d".repeat(40), jobId);
  database.prepare("UPDATE effects SET status = 'done' WHERE job_id = ?").run(jobId);
  database.prepare(
    `UPDATE job_admissions SET project_id = ?, state = 'admitted', admitted_at = ? WHERE job_id = ?`,
  ).run(job.projectId, now(), jobId);
  const held = database.prepare(
    "SELECT 1 FROM job_resource_claims WHERE job_id = ? AND state = 'held' LIMIT 1",
  ).get(jobId);
  if (!held) {
    const insertClaim = database.prepare(
      `INSERT INTO job_resource_claims (
         job_id, resource_key, resource_kind, state, owner_id, generation,
         lease_expires_at, acquired_at, renewed_at
       ) VALUES (?, ?, ?, 'held', ?, ?, 130000, 10100, 10100)`,
    );
    insertClaim.run(jobId, projectResourceKey(job.projectId), "project", ownerId, generation);
    insertClaim.run(jobId, productionResourceKey(job.policy), "production_target", ownerId, generation);
  }
  const current = store.getJob(jobId);
  if (!current) throw new Error("restart production job disappeared");
  const kind = state === "deploying" ? "deploy_production" : "verify_production";
  const key = `${current.id}:${current.version + 1}:${kind}`;
  database.prepare(
    `INSERT INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, '{}', 'pending', 0, ?, ?, ?)`,
  ).run(key, current.id, kind, now(), now(), now());
}

async function runNextProductionEffect(
  store: TelegramAgentStore,
  jobId: string,
  ownerId: string,
  generation: number,
  now: () => number,
  runProductionStage: () => Promise<ProductionStageSnapshot>,
): Promise<void> {
  const fence = { ownerId, generation, signal: new AbortController().signal };
  const lease = () => store.leaseNextJobEffect({
    jobId,
    ownerId,
    generation,
    now: now(),
    leaseMs: 30_000,
  });
  let claimed = lease();
  while (claimed?.kind === "render_status") {
    store.completeEffect(claimed.idempotencyKey, ownerId, generation, now());
    claimed = lease();
  }
  if (!claimed) return;
  const firstKey = claimed.idempotencyKey;
  const firstKind = claimed.kind;
  await new EffectRunner({ store, fence, now, runProductionStage }).run(claimed);
  store.completeEffect(claimed.idempotencyKey, ownerId, generation, now());
  let replay = lease();
  while (replay?.kind === "render_status") {
    store.completeEffect(replay.idempotencyKey, ownerId, generation, now());
    replay = lease();
  }
  if (replay && replay.kind === firstKind && replay.idempotencyKey !== firstKey) {
    await new EffectRunner({ store, fence, now, runProductionStage }).run(replay);
    store.completeEffect(replay.idempotencyKey, ownerId, generation, now());
  }
}

function passingStage(phase: "deploy" | "canary") {
  return {
    phase,
    outcome: "pass" as const,
    summary: `${phase} passed`,
    failedCommand: null,
    commandReceipts: [
      { name: "verify-merged-checkout", command: "git-head-check", outcome: "pass" as const, exitCode: 0, output: "ok" },
      { name: phase, command: `./${phase}`, outcome: "pass" as const, exitCode: 0, output: "ok" },
    ],
    terminalIds: [`term_${phase}`],
    completedAt: "2026-08-10T00:01:00.000Z",
  };
}

function failedStage(phase: "deploy" | "canary") {
  return {
    phase,
    outcome: "fail" as const,
    summary: `${phase} failed`,
    failedCommand: phase,
    commandReceipts: [
      { name: "verify-merged-checkout", command: "git-head-check", outcome: "pass" as const, exitCode: 0, output: "ok" },
      { name: phase, command: `./${phase}`, outcome: "fail" as const, exitCode: 1, output: "boom" },
    ],
    rollback: {
      name: "rollback",
      command: "./rollback",
      outcome: "pass" as const,
      exitCode: 0,
      output: "rolled",
    },
    terminalIds: [`term_${phase}`],
    completedAt: "2026-08-10T00:01:00.000Z",
  };
}

async function measureWorkerSeamOnJob(
  store: TelegramAgentStore,
  database: Database.Database,
  opened: Readonly<{
    jobId: string;
    specificationId: string;
    ticketId: string;
    leaseGeneration: number;
  }>,
  ownerId: string,
  now: () => number,
  point: Extract<DualEngineRestartPoint, "worker_dispatch" | "result_storage" | "head_change">,
): Promise<NavigatorRestartPointResult> {
  const executor = implementationExecutor(store, database, now);
  executor.startIntegration({
    jobId: opened.jobId,
    specificationArtifactId: opened.specificationId,
    implementationTicketIds: [opened.ticketId],
    baseBranch: "main",
    integrationBranch: `hanoon/restart-${opened.jobId}`,
    worktreeId: `env_${opened.jobId}`,
    baseHeadSha: BASE_HEAD,
    evidenceRefs: ["eval:restart"],
  });
  const firstClaim = claimTicket(store, opened.ticketId, opened.jobId, ownerId, opened.leaseGeneration, now);
  const replayClaim = claimTicket(store, opened.ticketId, opened.jobId, ownerId, opened.leaseGeneration, now);
  if (!firstClaim || !replayClaim || firstClaim.id !== replayClaim.id) {
    return resultFromDuplicates(1);
  }
  executor.beginClaimedTicket({
    jobId: opened.jobId,
    ticketArtifactId: opened.ticketId,
    claimId: firstClaim.id,
    taskEvidence: ["behavioral-change"],
    evidenceRefs: ["eval:restart:claim"],
    ownerId,
    generation: opened.leaseGeneration,
  });
  executor.beginClaimedTicket({
    jobId: opened.jobId,
    ticketArtifactId: opened.ticketId,
    claimId: firstClaim.id,
    taskEvidence: ["behavioral-change"],
    evidenceRefs: ["eval:restart:claim"],
    ownerId,
    generation: opened.leaseGeneration,
  });
  const fence = {
    ownerId,
    generation: opened.leaseGeneration,
    signal: new AbortController().signal,
  };
  await executor.processOne(fence, new AbortController().signal);
  await executor.processOne(fence, new AbortController().signal);
  const workerEffects = store.listEffectsForJob(opened.jobId)
    .filter((effect) => effect.kind === "run_navigator_ticket_worker");
  const duplicateEffects = workerEffects.length - new Set(workerEffects.map((effect) => effect.idempotencyKey)).size;
  const implementationAttempts = countRows(
    database,
    "SELECT COUNT(*) AS count FROM navigator_ticket_worker_attempts WHERE job_id = ? AND kind = 'implementation'",
    [opened.jobId],
  );
  const implementationOutcomes = countRows(
    database,
    `SELECT COUNT(*) AS count
       FROM navigator_ticket_worker_outcomes AS outcome
       JOIN navigator_ticket_worker_attempts AS attempt ON attempt.id = outcome.attempt_id
      WHERE attempt.job_id = ? AND attempt.kind = 'implementation'`,
    [opened.jobId],
  );
  const heads = countRows(
    database,
    "SELECT COUNT(DISTINCT current_head_sha) AS count FROM navigator_integrations WHERE job_id = ?",
    [opened.jobId],
  );
  if (point === "worker_dispatch") {
    return resultFromDuplicates(duplicateEffects + Math.max(0, implementationAttempts - 1));
  }
  if (point === "result_storage") {
    return resultFromDuplicates(Math.max(0, implementationOutcomes - 1));
  }
  return resultFromDuplicates(heads > 1 ? heads - 1 : 0);
}

async function withRestartLease<T>(
  store: TelegramAgentStore,
  sequence: number,
  generation: number,
  now: () => number,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } finally {
    store.releaseExecutorLease(`restart-exec-${sequence}`, generation, now());
  }
}

export async function measureNavigatorRestartPoint(
  store: TelegramAgentStore,
  database: Database.Database,
  evaluationCase: NavigatorEvaluationCase,
  sequence: number,
): Promise<NavigatorRestartPointResult> {
  const point = evaluationCase.restartPoint;
  if (!point) return resultFromDuplicates(1);
  let currentTime = 50_000 + sequence * 100;
  const now = () => currentTime++;
  const opened = openRestartJob(store, database, sequence, now);
  return withRestartLease(store, sequence, opened.leaseGeneration, now, async () => {
    if (point === "proposal") {
      const snapshot = store.createNavigatorSnapshot({
        jobId: opened.jobId,
        externalStateDigest: EXTERNAL_DIGEST,
        evidenceRefs: ["eval:restart"],
        now: now(),
      });
      const proposal = {
        basedOn: snapshot.identity,
        rationale: "Restart-safe dual-engine proposal.",
        evidenceRefs: ["eval:restart"],
        kind: "unresolved_next_step" as const,
        question: "Should this task use research or wayfinder next?",
        candidateSkillIds: ["research", "wayfinder"],
      };
      const observation = {
        nativeToolCalls: [] as const,
        claimedCodeWorktreeId: null,
        dynamicEffectToolIds: [] as const,
        externalStateDigest: EXTERNAL_DIGEST,
      };
      const first = store.recordNavigatorProposal({
        snapshotId: snapshot.snapshotId,
        rawProposal: proposal,
        observation,
        selectModelRoute: proposalModelRoute,
        now: now(),
      });
      const replay = store.recordNavigatorProposal({
        snapshotId: snapshot.snapshotId,
        rawProposal: proposal,
        observation,
        selectModelRoute: proposalModelRoute,
        now: now(),
      });
      const proposals = countRows(database, "SELECT COUNT(*) AS count FROM navigator_proposals WHERE job_id = ?", [opened.jobId]);
      const extraEffects = uniqueEffectCount(store, opened.jobId, "run_navigator_skill");
      const duplicates = (replay.proposalId === first.proposalId ? 0 : 1) + Math.max(0, proposals - 1) + extraEffects;
      return resultFromDuplicates(duplicates);
    }

    const ownerId = `restart-exec-${sequence}`;
    if (point === "claim") {
      const first = claimTicket(store, opened.ticketId, opened.jobId, ownerId, opened.leaseGeneration, now);
      const replay = claimTicket(store, opened.ticketId, opened.jobId, ownerId, opened.leaseGeneration, now);
      const claims = countRows(
        database,
        "SELECT COUNT(*) AS count FROM work_artifact_claims WHERE artifact_id = ?",
        [opened.ticketId],
      );
      const duplicates = (!first || !replay || first.id !== replay.id ? 1 : 0) + Math.max(0, claims - 1);
      return resultFromDuplicates(duplicates);
    }

    if (point === "tracker_create") {
      const artifactId = stableWorkArtifactId("proj_eval", `restart-create-${sequence}`);
      const createInput = {
        operationId: `restart-create-${sequence}`,
        kind: "implementation_ticket" as const,
        title: "Interrupted tracker create",
        body: "# Goal\n\nPersist create identity before the tracker effect.",
        acceptanceCriteria: ["Create identity survives restart"],
      };
      const intentInput = {
        artifactId,
        projectId: "proj_eval",
        effortId: opened.jobId,
        operationId: createInput.operationId,
        trackerKind: "github" as const,
        trackerNamespace: "github:acme/eval",
        trackerOperationId: createInput.operationId,
        createDigest: trackerCreateDigest(createInput),
        ownerId,
        generation: opened.leaseGeneration,
        now: now(),
      };
      const first = store.prepareWorkArtifactCreateIntent(intentInput);
      const replay = store.prepareWorkArtifactCreateIntent(intentInput);
      const intents = countRows(
        database,
        "SELECT COUNT(*) AS count FROM work_artifact_create_intents WHERE operation_id = ?",
        [createInput.operationId],
      );
      const duplicates = (first.artifactId === replay.artifactId ? 0 : 1) + Math.max(0, intents - 1);
      return resultFromDuplicates(duplicates);
    }

    if (point === "worker_dispatch" || point === "result_storage" || point === "head_change") {
      return measureWorkerSeamOnJob(store, database, opened, ownerId, now, point);
    }

    if (point === "merge_call_start") {
      driveToMergeCall(store, opened.jobId, now);
      const firstCount = store.listEffectsForJob(opened.jobId).filter((effect) => effect.kind === "merge_pr").length;
      try {
        const current = store.getJob(opened.jobId)!;
        store.applyJobEvent(current.id, current.version, {
          type: "APPROVAL_ACCEPTED",
          headSha: NEXT_HEAD,
        }, now());
      } catch {
        // Replay of merge-call start must not create a second merge effect.
      }
      const mergeEffects = store.listEffectsForJob(opened.jobId).filter((effect) => effect.kind === "merge_pr");
      return resultFromDuplicates(Math.max(0, mergeEffects.length - 1) + Math.max(0, firstCount - 1));
    }

    const productionState = point === "canary" ? "verifying_production" as const : "deploying" as const;
    seedProductionSeam(store, database, opened.jobId, ownerId, opened.leaseGeneration, now, productionState);

    if (point === "deploy") {
      await runNextProductionEffect(store, opened.jobId, ownerId, opened.leaseGeneration, now, async () => passingStage("deploy"));
      return resultFromDuplicates(uniqueEffectCount(store, opened.jobId, "deploy_production"));
    }

    if (point === "rollback") {
      await runNextProductionEffect(store, opened.jobId, ownerId, opened.leaseGeneration, now, async () => failedStage("deploy"));
      const incidents = store.countNavigatorReleaseIncidents({
        jobId: opened.jobId,
        phase: "deploy",
        failureSignature: "deploy",
        rollbackOutcome: "pass",
      });
      return resultFromDuplicates(Math.max(0, incidents - 1));
    }

    await runNextProductionEffect(store, opened.jobId, ownerId, opened.leaseGeneration, now, async () => failedStage("canary"));
    const canaryIncidents = countRows(
      database,
      "SELECT COUNT(*) AS count FROM navigator_release_incidents WHERE job_id = ? AND phase = 'canary'",
      [opened.jobId],
    );
    return resultFromDuplicates(Math.max(0, canaryIncidents - 1) + uniqueEffectCount(store, opened.jobId, "verify_production"));
  });
}
