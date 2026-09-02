import { DEFAULT_MODEL_POOL_REGISTRY } from "../capabilities/models";
import type { ProjectPolicy } from "../domain/models";
import type { NavigatorEffectPersistence } from "./effect-persistence";
import type { NavigatorEvaluationPersistence } from "./evaluation-persistence";
import type { NavigatorImplementationPersistence } from "./implementation-persistence";
import { stableWorkArtifactId, type CaptureWorkArtifactInput } from "../work-artifacts/repository";
import { trackerCreateDigest } from "../work-artifacts/tracker";
import { navigatorAcceptanceCriteria } from "./implementation-contracts";
import {
  NavigatorImplementationExecutor,
  type NavigatorGitObservationRequest,
} from "./implementation-executor";
import {
  createNavigatorTicketEffectAdapter,
  type NavigatorTicketWorkerInput,
  type NavigatorTicketWorkerOperation,
} from "./ticket-adapter";
import { NavigatorEffectProtocol } from "./effect-protocol";
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

function workerResult(input: NavigatorTicketWorkerInput) {
  const { attempt, ticket: ticketSnapshot } = input;
  if (attempt.kind === "implementation") {
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
  evaluation: NavigatorEvaluationPersistence,
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
  const specification = evaluation.captureWorkArtifact(artifactInput({
    projectId,
    artifactId: specificationId,
    operationId: `restart-spec-${sequence}`,
    kind: "specification",
    title: "Restart specification",
    trackerOrder: 0,
  }));
  const ticket = evaluation.captureWorkArtifact({
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
  const draft = evaluation.createJob({
    id: `job_restart_${sequence}`,
    sourceUpdateId: 91_000 + sequence,
    requestText: "Measure dual-engine restart safety.",
    workflow: { engine: "navigator-v1", mode: "deterministic" },
    now: now(),
  });
  const selected = evaluation.applyJobEvent(draft.id, draft.version, {
    type: "PROJECT_SELECTED",
    projectId,
    policyVersion: 1,
    policy: restartPolicyFor(projectId),
  }, now());
  evaluation.bindNavigatorJobArtifacts({
    jobId: selected.id,
    expectedVersion: selected.version,
    artifactBindings: [specification, ticket].map(({ artifact, snapshot }) => ({
      artifactId: artifact.id,
      snapshotId: snapshot.id,
      snapshotDigest: snapshot.snapshotDigest,
    })),
    now: now(),
  });
  evaluation.setEvaluationJobFacts({
    jobId: selected.id,
    taskOutcome: "shipped_change",
    state: "implementing",
  });
  const ownerId = `restart-exec-${sequence}`;
  const lease = evaluation.acquireExecutorLease(ownerId, now(), 120_000);
  if (!lease.acquired) throw new Error("restart evaluation lease was unavailable");
  evaluation.holdEvaluationProjectClaim({
    jobId: selected.id,
    projectId,
    ownerId,
    generation: lease.generation,
    now: now(),
    leaseMs: 100_000,
  });
  return { jobId: selected.id, specificationId, ticketId, leaseGeneration: lease.generation };
}

function claimTicket(
  evaluation: NavigatorEvaluationPersistence,
  ticketId: string,
  jobId: string,
  ownerId: string,
  generation: number,
  now: () => number,
) {
  const artifact = evaluation.getWorkArtifact(ticketId);
  const snapshot = evaluation.getCurrentWorkArtifactSnapshot(ticketId);
  if (!artifact || !snapshot) throw new Error("restart ticket is missing");
  evaluation.observeWorkArtifact({
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
  return evaluation.claimWorkArtifact({
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
  store: NavigatorEvaluationPersistence,
  persistence: NavigatorImplementationPersistence,
  now: () => number,
) {
  return new NavigatorImplementationExecutor({
    store,
    persistence,
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

function ticketOperation(): NavigatorTicketWorkerOperation {
  return {
    run: async (input) => ({
      resource: input.attempt.resource ?? { kind: "bb_thread", id: `thr_${input.attempt.id}` },
      result: workerResult(input),
    }),
    reconcile: async (input) => ({
      resource: input.attempt.resource ?? { kind: "bb_thread", id: `thr_${input.attempt.id}` },
      result: workerResult(input),
    }),
    observe: async (request) => gitObservation(request),
  };
}

function navigatorEffects(
  persistence: NavigatorEffectPersistence,
  now: () => number,
): NavigatorEffectProtocol {
  const unused = async () => ({ outcome: "permanent" as const, reason: "unused restart evaluation adapter" });
  return new NavigatorEffectProtocol({
    store: persistence,
    clock: { now },
    adapters: [
      { kind: "run_navigator_skill", execute: unused },
      createNavigatorTicketEffectAdapter(ticketOperation()),
      { kind: "run_navigator_release", execute: unused },
    ],
  });
}

function uniqueEffectCount(evaluation: NavigatorEvaluationPersistence, jobId: string, kind: string): number {
  const effects = evaluation.listEffectsForJob(jobId).filter((effect) => effect.kind === kind);
  return effects.length - new Set(effects.map((effect) => effect.idempotencyKey)).size;
}

function driveToMergeCall(
  evaluation: NavigatorEvaluationPersistence,
  jobId: string,
  now: () => number,
): void {
  const start = evaluation.getJob(jobId)!;
  const released = evaluation.applyJobEvent(start.id, start.version, {
    type: "RELEASE_STARTED",
    number: 43,
    url: "https://github.com/acme/eval/pull/43",
    environmentId: "env_eval_restart",
  }, now());
  const headed = evaluation.applyJobEvent(released.id, released.version, {
    type: "PR_HEAD_RESOLVED",
    headSha: NEXT_HEAD,
  }, now());
  const validated = evaluation.applyJobEvent(headed.id, headed.version, {
    type: "VALIDATION_PASSED",
    headSha: NEXT_HEAD,
  }, now());
  const reviewed = evaluation.applyJobEvent(validated.id, validated.version, {
    type: "REVIEW_PASSED",
    headSha: NEXT_HEAD,
  }, now());
  evaluation.applyJobEvent(reviewed.id, reviewed.version, {
    type: "APPROVAL_ACCEPTED",
    headSha: NEXT_HEAD,
  }, now());
}

function seedProductionSeam(
  evaluation: NavigatorEvaluationPersistence,
  jobId: string,
  ownerId: string,
  generation: number,
  now: () => number,
  state: "deploying" | "verifying_production",
): void {
  evaluation.seedNavigatorProductionState({ jobId, ownerId, generation, now: now(), state });
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
  evaluation: NavigatorEvaluationPersistence,
  implementationPersistence: NavigatorImplementationPersistence,
  effectPersistence: NavigatorEffectPersistence,
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
  const executor = implementationExecutor(evaluation, implementationPersistence, now);
  const effects = navigatorEffects(effectPersistence, now);
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
  const firstClaim = claimTicket(evaluation, opened.ticketId, opened.jobId, ownerId, opened.leaseGeneration, now);
  const replayClaim = claimTicket(evaluation, opened.ticketId, opened.jobId, ownerId, opened.leaseGeneration, now);
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
  await effects.processOne(fence, new AbortController().signal);
  await effects.processOne(fence, new AbortController().signal);
  const workerEffects = evaluation.listEffectsForJob(opened.jobId)
    .filter((effect) => effect.kind === "run_navigator_ticket_worker");
  const duplicateEffects = workerEffects.length - new Set(workerEffects.map((effect) => effect.idempotencyKey)).size;
  const implementationAttempts = evaluation.countNavigatorImplementationAttempts(opened.jobId);
  const implementationOutcomes = evaluation.countNavigatorImplementationOutcomes(opened.jobId);
  const heads = evaluation.countNavigatorIntegrationHeads(opened.jobId);
  if (point === "worker_dispatch") {
    return resultFromDuplicates(duplicateEffects + Math.max(0, implementationAttempts - 1));
  }
  if (point === "result_storage") {
    return resultFromDuplicates(Math.max(0, implementationOutcomes - 1));
  }
  return resultFromDuplicates(heads > 1 ? heads - 1 : 0);
}

async function withRestartLease<T>(
  evaluation: NavigatorEvaluationPersistence,
  sequence: number,
  generation: number,
  now: () => number,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } finally {
    evaluation.releaseExecutorLease(`restart-exec-${sequence}`, generation, now());
  }
}

export async function measureNavigatorRestartPoint(
  evaluation: NavigatorEvaluationPersistence,
  persistence: Readonly<{
    effectPersistence: NavigatorEffectPersistence;
    implementationPersistence: NavigatorImplementationPersistence;
  }>,
  evaluationCase: NavigatorEvaluationCase,
  sequence: number,
): Promise<NavigatorRestartPointResult> {
  const point = evaluationCase.restartPoint;
  if (!point) return resultFromDuplicates(1);
  let currentTime = 50_000 + sequence * 100;
  const now = () => currentTime++;
  const opened = openRestartJob(evaluation, sequence, now);
  return withRestartLease(evaluation, sequence, opened.leaseGeneration, now, async () => {
    if (point === "proposal") {
      const snapshot = evaluation.createNavigatorSnapshot({
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
      const first = evaluation.recordNavigatorProposal({
        snapshotId: snapshot.snapshotId,
        rawProposal: proposal,
        observation,
        selectModelRoute: proposalModelRoute,
        now: now(),
      });
      const replay = evaluation.recordNavigatorProposal({
        snapshotId: snapshot.snapshotId,
        rawProposal: proposal,
        observation,
        selectModelRoute: proposalModelRoute,
        now: now(),
      });
      const proposals = evaluation.countNavigatorProposals(opened.jobId);
      const extraEffects = uniqueEffectCount(evaluation, opened.jobId, "run_navigator_skill");
      const duplicates = (replay.proposalId === first.proposalId ? 0 : 1) + Math.max(0, proposals - 1) + extraEffects;
      return resultFromDuplicates(duplicates);
    }

    const ownerId = `restart-exec-${sequence}`;
    if (point === "claim") {
      const first = claimTicket(evaluation, opened.ticketId, opened.jobId, ownerId, opened.leaseGeneration, now);
      const replay = claimTicket(evaluation, opened.ticketId, opened.jobId, ownerId, opened.leaseGeneration, now);
      const claims = evaluation.countWorkArtifactClaims(opened.ticketId);
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
      const first = evaluation.prepareWorkArtifactCreateIntent(intentInput);
      const replay = evaluation.prepareWorkArtifactCreateIntent(intentInput);
      const intents = evaluation.countWorkArtifactCreateIntents(createInput.operationId);
      const duplicates = (first.artifactId === replay.artifactId ? 0 : 1) + Math.max(0, intents - 1);
      return resultFromDuplicates(duplicates);
    }

    if (point === "worker_dispatch" || point === "result_storage" || point === "head_change") {
      return measureWorkerSeamOnJob(
        evaluation,
        persistence.implementationPersistence,
        persistence.effectPersistence,
        opened,
        ownerId,
        now,
        point,
      );
    }

    if (point === "merge_call_start") {
      driveToMergeCall(evaluation, opened.jobId, now);
      const firstCount = evaluation.listEffectsForJob(opened.jobId).filter((effect) => effect.kind === "merge_pr").length;
      try {
        const current = evaluation.getJob(opened.jobId)!;
        evaluation.applyJobEvent(current.id, current.version, {
          type: "APPROVAL_ACCEPTED",
          headSha: NEXT_HEAD,
        }, now());
      } catch {
        // Replay of merge-call start must not create a second merge effect.
      }
      const mergeEffects = evaluation.listEffectsForJob(opened.jobId).filter((effect) => effect.kind === "merge_pr");
      return resultFromDuplicates(Math.max(0, mergeEffects.length - 1) + Math.max(0, firstCount - 1));
    }

    const productionState = point === "canary" ? "verifying_production" as const : "deploying" as const;
    seedProductionSeam(evaluation, opened.jobId, ownerId, opened.leaseGeneration, now, productionState);

    if (point === "deploy") {
      await evaluation.runNavigatorProductionEffect({
        jobId: opened.jobId,
        ownerId,
        generation: opened.leaseGeneration,
        now,
        runProductionStage: async () => passingStage("deploy"),
      });
      return resultFromDuplicates(uniqueEffectCount(evaluation, opened.jobId, "deploy_production"));
    }

    if (point === "rollback") {
      await evaluation.runNavigatorProductionEffect({
        jobId: opened.jobId,
        ownerId,
        generation: opened.leaseGeneration,
        now,
        runProductionStage: async () => failedStage("deploy"),
      });
      const incidents = evaluation.countNavigatorReleaseIncidents({
        jobId: opened.jobId,
        phase: "deploy",
        failureSignature: "deploy",
        rollbackOutcome: "pass",
      });
      return resultFromDuplicates(Math.max(0, incidents - 1));
    }

    await evaluation.runNavigatorProductionEffect({
      jobId: opened.jobId,
      ownerId,
      generation: opened.leaseGeneration,
      now,
      runProductionStage: async () => failedStage("canary"),
    });
    const canaryIncidents = evaluation.countNavigatorReleaseIncidentsByPhase(opened.jobId, "canary");
    return resultFromDuplicates(Math.max(0, canaryIncidents - 1) + uniqueEffectCount(evaluation, opened.jobId, "verify_production"));
  });
}
