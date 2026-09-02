import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { vi } from "vitest";
import { productionResourceKey, projectResourceKey } from "../../src/autonomy/models";
import { DEFAULT_MODEL_POOL_REGISTRY } from "../../src/capabilities/models";
import { navigatorAcceptanceCriteria } from "../../src/navigator/implementation-contracts";
import {
  NavigatorImplementationExecutor,
} from "../../src/navigator/implementation-executor";
import type { NavigatorImplementationPersistence } from "../../src/navigator/implementation-persistence";
import {
  createNavigatorTicketEffectAdapter,
  type NavigatorTicketWorkerInput,
  type NavigatorTicketWorkerOperation,
} from "../../src/navigator/ticket-adapter";
import { NavigatorEffectProtocol } from "../../src/navigator/effect-protocol";
import { NavigatorReleaseOperation } from "../../src/navigator/release-operation";
import type { NavigatorEffectPersistence } from "../../src/navigator/effect-persistence";
import { createNavigatorReleaseEffectAdapter } from "../../src/navigator/plugin-runtime";
import { assertNavigatorLiveScenarioEvidence } from "../../src/navigator/live-evidence";
import type { NavigatorEvaluationPersistence } from "../../src/navigator/evaluation-persistence";
import { NAVIGATOR_LIVE_SCENARIOS, type NavigatorLiveScenario } from "../../src/navigator/promotion";
import { EffectRunner } from "../../src/services/effect-runner";
import type { ProductionStageSnapshot } from "../../src/services/production-runner";
import type { TelegramAgentStore } from "../../src/storage/store";
import { trackerCreateDigest } from "../../src/work-artifacts/tracker";
import { stableWorkArtifactId, type CaptureWorkArtifactInput } from "../../src/work-artifacts/repository";
import { policyFixture, sha } from "../helpers";

const EXTERNAL_DIGEST = "e".repeat(64);
const BASE_HEAD = "1".repeat(40);
const NEXT_HEAD = "2".repeat(40);
const REPAIR_HEAD = "3".repeat(40);
const STALE_HEAD = "9".repeat(40);

export type NavigatorLiveScenarioRecord = Readonly<{
  scenario: NavigatorLiveScenario;
  jobId: string;
  terminalState: "complete" | "merged" | "cancelled";
  evidenceDigest: string;
}>;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function modelRoute() {
  return { pool: "strong" as const, ...DEFAULT_MODEL_POOL_REGISTRY.worker.strong };
}

function workerRoute() {
  return { pool: "standard" as const, ...DEFAULT_MODEL_POOL_REGISTRY.worker.standard };
}

function livePolicy() {
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
}>): CaptureWorkArtifactInput {
  return {
    artifactId: input.id,
    projectId: "proj_1",
    effortId: "effort_live",
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
    content: `# ${input.title}\n\nDisposable live scenario artifact.`,
    acceptanceCriteria: [`${input.title} is accepted`],
    relationships: [],
    capturedAt: 1_000 + input.trackerOrder,
  };
}

function cancelJob(store: TelegramAgentStore, jobId: string, now: () => number) {
  const job = store.getJob(jobId);
  if (!job) throw new Error(`live job ${jobId} is missing`);
  if (job.state === "cancelled" || job.state === "complete" || job.state === "merged") return job;
  return store.applyJobEvent(job.id, job.version, {
    type: "CANCEL_REQUESTED",
    activeWorker: null,
    activeWorkers: [],
  }, now());
}

function releaseHeldClaims(database: Database.Database, now: number): void {
  database.prepare(
    "UPDATE job_resource_claims SET state = 'released', released_at = ?, release_reason = 'scenario_complete' WHERE state = 'held'",
  ).run(now);
}

function terminalOf(
  store: TelegramAgentStore,
  jobId: string,
  expected: "complete" | "cancelled",
): "complete" | "merged" | "cancelled" {
  const state = store.getJob(jobId)?.state;
  if (state !== expected) throw new Error(`live job ${jobId} ended in ${state}, expected ${expected}`);
  return expected;
}

function openLiveJob(
  store: TelegramAgentStore,
  database: Database.Database,
  now: () => number,
  sequence: number,
  scenario: NavigatorLiveScenario,
) {
  const specificationId = stableWorkArtifactId("proj_1", `live-spec-${sequence}-${scenario}`);
  const ticketId = stableWorkArtifactId("proj_1", `live-ticket-${sequence}-${scenario}`);
  const specification = store.captureWorkArtifact(artifactInput({
    id: specificationId, operationId: `live-spec-${sequence}-${scenario}`,
    kind: "specification", title: `${scenario} spec`, trackerOrder: 0,
  }));
  const ticket = store.captureWorkArtifact({
    ...artifactInput({
      id: ticketId, operationId: `live-ticket-${sequence}-${scenario}`,
      kind: "implementation_ticket", title: `${scenario} ticket`, trackerOrder: 1,
    }),
    relationships: [{
      kind: "parent",
      sourceArtifactId: ticketId,
      sourceRef: `artifact:${ticketId}`,
      targetArtifactId: specificationId,
      targetRef: `artifact:${specificationId}`,
    }],
  });
  const job = store.createJob({
    id: `job_live_${sequence}_${scenario}`.slice(0, 256),
    sourceUpdateId: 82_000 + sequence * 20 + NAVIGATOR_LIVE_SCENARIOS.indexOf(scenario),
    requestText: `Disposable ${scenario}`,
    workflow: { engine: "navigator-v1", mode: "deterministic" },
    now: now(),
  });
  const selected = store.applyJobEvent(job.id, job.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_1",
    policyVersion: 1,
    policy: livePolicy(),
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
  if (scenario !== "interrupted_tracker_create") {
    database.prepare(
      "UPDATE jobs SET state = 'implementing', task_outcome = NULL, task_constraints_json = '[]' WHERE id = ?",
    ).run(selected.id);
  }
  database.prepare(
    `INSERT INTO job_admissions (
       job_id, project_id, queue_seq, state, resume_event, queued_at, admitted_at
     ) VALUES (?, 'proj_1', ?, 'admitted', 'CONFIRMED', ?, ?)`,
  ).run(selected.id, 100_000 + sequence * 100 + NAVIGATOR_LIVE_SCENARIOS.indexOf(scenario), now(), now());
  return { jobId: selected.id, specificationId, ticketId };
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
  if (!artifact || !snapshot) throw new Error(`live ticket ${ticketId} is missing`);
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
  const first = store.claimWorkArtifact({
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
  const replay = store.claimWorkArtifact({
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
  if (!first || !replay || first.id !== replay.id) throw new Error(`ticket ${ticketId} was not claimed`);
  return first;
}

function claimProjectResource(
  database: Database.Database,
  jobId: string,
  ownerId: string,
  generation: number,
  now: () => number,
): void {
  const acquiredAt = now();
  database.prepare(
    `INSERT INTO job_resource_claims (
       job_id, resource_key, resource_kind, state, owner_id, generation,
       lease_expires_at, acquired_at, renewed_at
     ) VALUES (?, ?, 'project', 'held', ?, ?, ?, ?, ?)`,
  ).run(jobId, projectResourceKey("proj_1"), ownerId, generation, acquiredAt + 100_000, acquiredAt, acquiredAt);
}

function implementationExecutor(
  store: TelegramAgentStore,
  navigatorEffects: NavigatorEffectPersistence,
  persistence: NavigatorImplementationPersistence,
  now: () => number,
  options: Readonly<{ staleHead: boolean; findingsOnFirstReview: boolean }>,
) {
  const gitObserver = {
    observe: async (request: Readonly<{
      worktreeId: string;
      integrationBranch: string;
      expectedHeadSha: string;
      baseHeadSha: string;
      comparisonBaseHeadSha: string;
      expectedChangedPaths: readonly string[];
    }>) => ({
      kind: "navigator_git_observation" as const,
      worktreeId: request.worktreeId,
      branch: request.integrationBranch,
      headSha: options.staleHead ? STALE_HEAD : request.expectedHeadSha,
      baseHeadSha: request.baseHeadSha,
      baseHeadIsAncestor: true,
      comparisonBaseHeadSha: request.comparisonBaseHeadSha,
      comparisonBaseHeadIsAncestor: true,
      clean: true,
      changedPaths: [...request.expectedChangedPaths],
      evidenceRef: `git-observation:${request.expectedHeadSha}`,
      observedAt: 2_000,
    }),
  };
  const ticketOperation: NavigatorTicketWorkerOperation = {
    run: vi.fn(async (input: NavigatorTicketWorkerInput) => {
      const { attempt, ticket: ticketSnapshot } = input;
      const resource = attempt.resource ?? { kind: "bb_thread" as const, id: `thr_${attempt.id}` };
      if (attempt.kind === "implementation") {
        return {
          resource,
          result: {
            kind: "implementation_result",
            baseHeadSha: attempt.workOrder.baseHeadSha,
            headSha: attempt.ordinal === 1 ? NEXT_HEAD : REPAIR_HEAD,
            summary: "Implemented.",
            changedPaths: ["src/app.ts"],
            focusedVerification: [{ command: "npm test", outcome: "passed" }],
            fullVerification: [{ command: "npm run check", outcome: "passed" }],
            acceptanceCriteria: navigatorAcceptanceCriteria(ticketSnapshot).map(({ id }) => ({
              criterionId: id,
              outcome: "passed",
              evidenceRefs: [`acceptance:${id}`],
            })),
            capabilityOutcomes: attempt.profile.assignments.map(({ capabilityId }) => ({
              capabilityId, outcome: "passed", evidenceRefs: [`worker:${attempt.id}`],
            })),
          },
        };
      }
      const needsRepair = attempt.workOrder.verificationOf !== undefined ||
        (options.findingsOnFirstReview && attempt.ordinal === 1);
      const findings = needsRepair
        ? attempt.workOrder.verificationOf?.findings ?? [{
          rootCauseId: "live-repair",
          capabilityId: "code-review",
          ruleId: "LIVE-REPAIR",
          severity: "high" as const,
          subject: "src/app.ts",
          line: 1,
          requirementId: null,
          summary: "Repair this finding.",
          evidenceRefs: ["review:1"],
        }]
        : [];
      return {
        resource,
        result: {
          kind: "code_review_result",
          reviewedHeadSha: attempt.workOrder.baseHeadSha,
          outcome: needsRepair ? "findings" : "passed",
          summary: needsRepair ? "Repair the finding." : "Passed.",
          axes: {
            requirements: {
              outcome: needsRepair ? "findings" : "passed",
              evidenceRefs: [`requirements:${attempt.id}`],
            },
            standards: { outcome: "passed", evidenceRefs: [`standards:${attempt.id}`] },
          },
          findings,
          capabilityOutcomes: attempt.profile.assignments.map(({ capabilityId }) => ({
            capabilityId,
            outcome: needsRepair ? "findings" : "passed",
            evidenceRefs: [`worker:${attempt.id}`],
          })),
        },
      };
    }),
    reconcile: vi.fn(),
    observe: gitObserver.observe,
  };
  const executor = new NavigatorImplementationExecutor({
    store,
    persistence,
    gitObserver,
    pullRequests: {
      createOrRefresh: vi.fn(async (request) => ({
        jobId: request.jobId,
        number: 43,
        url: "https://github.com/acme/cyndra/pull/43",
        headSha: request.headSha,
        operationId: request.operationId,
      })),
    },
    modelRoute: (kind) => kind === "review" ? modelRoute() : workerRoute(),
    clock: { now },
  });
  const unused = async () => ({ outcome: "permanent" as const, reason: "unused in live scenario" });
  const protocol = new NavigatorEffectProtocol({
    store: navigatorEffects,
    clock: { now },
    adapters: [
      { kind: "run_navigator_skill", execute: unused },
      createNavigatorTicketEffectAdapter(ticketOperation),
      { kind: "run_navigator_release", execute: unused },
    ],
  });
  return { executor, protocol };
}

function isolateLiveIntegration(database: Database.Database, jobId: string): void {
  database.prepare(
    "UPDATE navigator_integrations SET state = 'invalidated' WHERE job_id <> ? AND state = 'implementing'",
  ).run(jobId);
}

async function processTicketUntil(
  executor: NavigatorImplementationExecutor,
  protocol: NavigatorEffectProtocol,
  jobId: string,
  fence: { ownerId: string; generation: number; signal: AbortSignal },
  desired: "repair_pending" | "accepted" | "failed",
): Promise<void> {
  for (let step = 0; step < 8; step += 1) {
    const slice = executor.snapshot(jobId).activeSlice;
    if (slice?.state === desired) return;
    const progressed = await protocol.processOne(fence, new AbortController().signal);
    if (!progressed) {
      throw new Error(`ticket worker for ${jobId} stopped in ${slice?.state ?? "no-slice"}, wanted ${desired}`);
    }
  }
  throw new Error(`ticket worker never reached ${desired}`);
}

async function processUntilOutcome(
  executor: NavigatorImplementationExecutor,
  protocol: NavigatorEffectProtocol,
  jobId: string,
  fence: { ownerId: string; generation: number; signal: AbortSignal },
): Promise<void> {
  for (let step = 0; step < 8; step += 1) {
    if (executor.snapshot(jobId).outcomes.length > 0) return;
    const progressed = await protocol.processOne(fence, new AbortController().signal);
    if (!progressed) throw new Error("ticket worker produced no outcome");
  }
  throw new Error("ticket worker never recorded an outcome");
}

async function runImplementation(
  store: TelegramAgentStore,
  navigatorEffects: NavigatorEffectPersistence,
  persistence: NavigatorImplementationPersistence,
  database: Database.Database,
  now: () => number,
  opened: Readonly<{ jobId: string; specificationId: string; ticketId: string }>,
  ownerId: string,
  generation: number,
  options: Readonly<{ staleHead: boolean; findingsOnFirstReview: boolean }>,
) {
  isolateLiveIntegration(database, opened.jobId);
  const running = implementationExecutor(store, navigatorEffects, persistence, now, options);
  const executor = running.executor;
  executor.startIntegration({
    jobId: opened.jobId,
    specificationArtifactId: opened.specificationId,
    implementationTicketIds: [opened.ticketId],
    baseBranch: "main",
    integrationBranch: `hanoon/${opened.jobId}`,
    worktreeId: `env_${opened.jobId}`,
    baseHeadSha: BASE_HEAD,
    evidenceRefs: ["live:scenario"],
  });
  const claimed = claimTicket(store, opened.ticketId, opened.jobId, ownerId, generation, now);
  claimProjectResource(database, opened.jobId, ownerId, generation, now);
  executor.beginClaimedTicket({
    jobId: opened.jobId,
    ticketArtifactId: opened.ticketId,
    claimId: claimed.id,
    taskEvidence: ["behavioral-change"],
    evidenceRefs: ["live:claim"],
    ownerId,
    generation,
  });
  const fence = { ownerId, generation, signal: new AbortController().signal };
  if (options.staleHead) {
    await processUntilOutcome(executor, running.protocol, opened.jobId, fence);
  } else {
    await processTicketUntil(
      executor,
      running.protocol,
      opened.jobId,
      fence,
      options.findingsOnFirstReview ? "repair_pending" : "accepted",
    );
  }
  return { executor, protocol: running.protocol, fence, claimed };
}

async function repairAndAccept(
  running: Awaited<ReturnType<typeof runImplementation>>,
  opened: Readonly<{ jobId: string; ticketId: string }>,
) {
  const repairSnapshot = running.executor.prepareRepairNavigation({
    jobId: opened.jobId,
    ticketArtifactId: opened.ticketId,
    evidenceRefs: ["review-finding:LIVE-REPAIR"],
  });
  const repairDecision = running.executor.recordRepairProposal({
    snapshotId: repairSnapshot.snapshotId,
    rawProposal: {
      kind: "implementation",
      basedOn: { snapshotId: repairSnapshot.snapshotId, digest: repairSnapshot.digest },
      objective: "Repair the disposable finding.",
      taskEvidence: ["behavioral-change"],
      evidenceRefs: ["review-finding:LIVE-REPAIR"],
    },
  });
  running.executor.scheduleRepair({
    jobId: opened.jobId,
    ticketArtifactId: opened.ticketId,
    proposalId: repairDecision.proposalId,
  });
  await processTicketUntil(running.executor, running.protocol, opened.jobId, running.fence, "accepted");
}

function closeTicket(
  store: TelegramAgentStore,
  executor: NavigatorImplementationExecutor,
  opened: Readonly<{ jobId: string; ticketId: string }>,
  ownerId: string,
  generation: number,
  now: () => number,
) {
  const claimRecord = store.getHeldWorkArtifactClaim(opened.ticketId);
  if (claimRecord) {
    store.releaseWorkArtifactClaim({
      claimId: claimRecord.id,
      ownerId,
      generation,
      reason: "accepted",
      now: now(),
    });
  }
  const artifact = store.getWorkArtifact(opened.ticketId)!;
  const snapshot = store.getCurrentWorkArtifactSnapshot(opened.ticketId)!;
  const closed = store.observeWorkArtifact({
    artifactId: opened.ticketId,
    expectedExternalRevision: artifact.externalRevision,
    externalRevision: `${artifact.externalRevision}:closed`,
    externalStatus: "closed",
    assignees: [],
    title: snapshot.title,
    content: snapshot.content,
    acceptanceCriteria: snapshot.acceptanceCriteria,
    relationships: snapshot.relationships,
    observedAt: now(),
  });
  const review = [...executor.snapshot(opened.jobId).attempts].reverse()
    .find((attempt) => attempt.kind === "review" && attempt.workOrder.ticket.artifactId === opened.ticketId);
  if (!review) throw new Error("accepted review attempt is missing");
  const intent = store.authorizeWorkArtifactResolution({
    artifactId: opened.ticketId,
    operationId: `resolve:${opened.ticketId}`,
    outcome: "resolved",
    snapshotId: snapshot.id,
    expectedExternalRevision: closed.artifact.externalRevision,
    evidenceRefs: [`navigator-result:${review.id}`],
    now: now(),
  });
  if (!intent) throw new Error(`ticket ${opened.ticketId} resolution was not authorized`);
  store.finalizeWorkArtifactResolution({
    intentId: intent.id,
    externalRevision: closed.artifact.externalRevision,
    now: now(),
  });
  executor.markTicketResolved({ jobId: opened.jobId, ticketArtifactId: opened.ticketId });
}

function markShippedChange(database: Database.Database, jobId: string): void {
  database.prepare("UPDATE jobs SET task_outcome = ?, task_constraints_json = ? WHERE id = ?")
    .run("shipped_change", JSON.stringify([]), jobId);
}

function propose(
  store: TelegramAgentStore,
  jobId: string,
  now: () => number,
  raw: Record<string, unknown>,
) {
  const snapshot = store.createNavigatorSnapshot({
    jobId,
    externalStateDigest: EXTERNAL_DIGEST,
    evidenceRefs: ["live:scenario"],
    now: now(),
  });
  const proposal = {
    basedOn: snapshot.identity,
    rationale: "Live scenario.",
    evidenceRefs: ["live:scenario"],
    ...raw,
  };
  const observation = {
    nativeToolCalls: [],
    claimedCodeWorktreeId: null,
    dynamicEffectToolIds: [],
    externalStateDigest: EXTERNAL_DIGEST,
  };
  const first = store.recordNavigatorProposal({
    snapshotId: snapshot.snapshotId,
    rawProposal: proposal,
    observation,
    selectModelRoute: modelRoute,
    now: now(),
  });
  store.recordNavigatorProposal({
    snapshotId: snapshot.snapshotId,
    rawProposal: proposal,
    observation,
    selectModelRoute: modelRoute,
    now: now(),
  });
  return first;
}

function driveToMergeCall(store: TelegramAgentStore, jobId: string, now: () => number): void {
  const start = store.getJob(jobId)!;
  const released = store.applyJobEvent(start.id, start.version, {
    type: "RELEASE_STARTED",
    number: 43,
    url: "https://github.com/acme/cyndra/pull/43",
    environmentId: "env_live",
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

function seedProduction(
  store: TelegramAgentStore,
  database: Database.Database,
  jobId: string,
  ownerId: string,
  generation: number,
  now: () => number,
  state: "deploying" | "verifying_production",
  queueSeq: number,
): void {
  const job = store.getJob(jobId);
  if (!job?.policy || !job.projectId) throw new Error("live production job is missing");
  releaseHeldClaims(database, now());
  database.prepare(
    `UPDATE jobs SET state = ?, environment_id = 'env_live', pr_number = 43,
       pr_url = 'https://github.com/acme/cyndra/pull/43', pr_head_sha = ?,
       merge_message = 'Merged pull request #43', merge_commit_sha = ?,
       merged_at = '2026-08-10T00:00:00.000Z', task_outcome = NULL, version = version + 1 WHERE id = ?`,
  ).run(state, sha("a"), sha("d"), jobId);
  database.prepare("UPDATE effects SET status = 'done' WHERE job_id = ?").run(jobId);
  const admitted = database.prepare(
    "UPDATE job_admissions SET project_id = ?, state = 'admitted', admitted_at = ? WHERE job_id = ?",
  ).run(job.projectId, now(), jobId);
  if (admitted.changes !== 1) {
    database.prepare(
      `INSERT INTO job_admissions (
         job_id, project_id, queue_seq, state, resume_event, queued_at, admitted_at
       ) VALUES (?, ?, ?, 'admitted', 'CONFIRMED', ?, ?)`,
    ).run(jobId, job.projectId, queueSeq, now(), now());
  }
  const expires = now() + 180_000;
  const insertClaim = database.prepare(
    `INSERT INTO job_resource_claims (
       job_id, resource_key, resource_kind, state, owner_id, generation,
       lease_expires_at, acquired_at, renewed_at
     ) VALUES (?, ?, ?, 'held', ?, ?, ?, ?, ?)`,
  );
  const acquired = now();
  insertClaim.run(jobId, projectResourceKey(job.projectId), "project", ownerId, generation, expires, acquired, acquired);
  insertClaim.run(jobId, productionResourceKey(job.policy), "production_target", ownerId, generation, expires, acquired, acquired);
  const current = store.getJob(jobId)!;
  const kind = state === "deploying" ? "deploy_production" : "verify_production";
  database.prepare(
    `INSERT INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, ?, '{}', 'pending', 0, ?, ?, ?)`,
  ).run(`${current.id}:${current.version + 1}:${kind}`, current.id, kind, now(), now(), now());
}

function passingStage(phase: "deploy" | "canary"): ProductionStageSnapshot {
  return {
    phase,
    outcome: "pass",
    summary: `${phase} passed`,
    failedCommand: null,
    commandReceipts: [
      { name: "verify-merged-checkout", command: "git-head-check", outcome: "pass", exitCode: 0, output: "ok" },
      { name: phase, command: `./${phase}`, outcome: "pass", exitCode: 0, output: "ok" },
    ],
    terminalIds: [`term_${phase}`],
    completedAt: "2026-08-10T00:01:00.000Z",
  };
}

function failingStage(phase: "deploy" | "canary"): ProductionStageSnapshot {
  return {
    phase,
    outcome: "fail",
    summary: `${phase} failed`,
    failedCommand: phase,
    commandReceipts: [
      { name: "verify-merged-checkout", command: "git-head-check", outcome: "pass", exitCode: 0, output: "ok" },
      { name: phase, command: `./${phase}`, outcome: "fail", exitCode: 1, output: "boom" },
    ],
    rollback: {
      name: "rollback",
      command: "./rollback",
      outcome: "pass",
      exitCode: 0,
      output: "rolled",
    },
    terminalIds: [`term_${phase}`],
    completedAt: "2026-08-10T00:01:00.000Z",
  };
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
    jobId, ownerId, generation, now: now(), leaseMs: 30_000,
  });
  let claimed = lease();
  while (claimed?.kind === "render_status") {
    store.completeEffect(claimed.idempotencyKey, ownerId, generation, now());
    claimed = lease();
  }
  if (!claimed) throw new Error(`production effect was not leased for ${jobId}`);
  await new EffectRunner({ store, fence, now, runProductionStage }).run(claimed);
  store.completeEffect(claimed.idempotencyKey, ownerId, generation, now());
}

function startResolvedIntegration(
  store: TelegramAgentStore,
  navigatorEffects: NavigatorEffectPersistence,
  persistence: NavigatorImplementationPersistence,
  database: Database.Database,
  now: () => number,
  opened: Readonly<{ jobId: string; specificationId: string; ticketId: string }>,
): void {
  isolateLiveIntegration(database, opened.jobId);
  const running = implementationExecutor(store, navigatorEffects, persistence, now, {
    staleHead: false,
    findingsOnFirstReview: false,
  });
  const executor = running.executor;
  executor.startIntegration({
    jobId: opened.jobId,
    specificationArtifactId: opened.specificationId,
    implementationTicketIds: [opened.ticketId],
    baseBranch: "main",
    integrationBranch: `hanoon/${opened.jobId}`,
    worktreeId: `env_${opened.jobId}`,
    baseHeadSha: BASE_HEAD,
    evidenceRefs: ["live:scenario"],
  });
  const at = now();
  database.prepare(
    "UPDATE navigator_integration_tickets SET state = 'resolved', resolved_at = ? WHERE job_id = ?",
  ).run(at, opened.jobId);
  database.prepare(
    "UPDATE navigator_integrations SET state = 'ready_for_pull_request', updated_at = ? WHERE job_id = ?",
  ).run(at, opened.jobId);
}

export async function runRequiredNavigatorLiveScenarios(input: Readonly<{
  store: TelegramAgentStore;
  navigatorEffects: NavigatorEffectPersistence;
  implementationPersistence: NavigatorImplementationPersistence;
  evaluationPersistence: NavigatorEvaluationPersistence;
  database: Database.Database;
  now: () => number;
  sequence: number;
}>): Promise<readonly NavigatorLiveScenarioRecord[]> {
  const ownerId = `live-exec-${input.sequence}`;
  const lease = input.store.acquireExecutorLease(ownerId, input.now(), 180_000);
  if (!lease.acquired) throw new Error("live scenario lease was unavailable");
  const runs: NavigatorLiveScenarioRecord[] = [];
  try {
    for (const [index, scenario] of NAVIGATOR_LIVE_SCENARIOS.entries()) {
      releaseHeldClaims(input.database, input.now());
      const opened = openLiveJob(input.store, input.database, input.now, input.sequence, scenario);
      const queueSeq = 20_000 + input.sequence * 20 + index;

      if (scenario === "interrupted_tracker_create") {
        const artifactId = stableWorkArtifactId("proj_1", `live-create-${input.sequence}`);
        const createInput = {
          operationId: `live-create-${input.sequence}`,
          kind: "implementation_ticket" as const,
          title: "Interrupted tracker create",
          body: "# Goal\n\nPersist create identity before the tracker effect.",
          acceptanceCriteria: ["Create identity survives restart"],
        };
        const intent = {
          artifactId,
          projectId: "proj_1",
          effortId: opened.jobId,
          operationId: createInput.operationId,
          trackerKind: "github" as const,
          trackerNamespace: "github:acme/cyndra",
          trackerOperationId: createInput.operationId,
          createDigest: trackerCreateDigest(createInput),
          ownerId,
          generation: lease.generation,
          now: input.now(),
        };
        input.store.prepareWorkArtifactCreateIntent(intent);
        input.store.prepareWorkArtifactCreateIntent(intent);
        cancelJob(input.store, opened.jobId, input.now);
        runs.push(finishRun(input.store, input.evaluationPersistence, scenario, opened.jobId, "cancelled"));
        continue;
      }

      if (scenario === "stale_head") {
        await runImplementation(
          input.store, input.navigatorEffects, input.implementationPersistence, input.database, input.now, opened, ownerId, lease.generation,
          { staleHead: true, findingsOnFirstReview: false },
        );
        cancelJob(input.store, opened.jobId, input.now);
        runs.push(finishRun(input.store, input.evaluationPersistence, scenario, opened.jobId, "cancelled"));
        continue;
      }

      if (scenario === "repair") {
        const running = await runImplementation(
          input.store, input.navigatorEffects, input.implementationPersistence, input.database, input.now, opened, ownerId, lease.generation,
          { staleHead: false, findingsOnFirstReview: true },
        );
        await repairAndAccept(running, opened);
        cancelJob(input.store, opened.jobId, input.now);
        runs.push(finishRun(input.store, input.evaluationPersistence, scenario, opened.jobId, "cancelled"));
        continue;
      }

      if (scenario === "ambiguous_merge") {
        driveToMergeCall(input.store, opened.jobId, input.now);
        const current = input.store.getJob(opened.jobId)!;
        try {
          input.store.applyJobEvent(current.id, current.version, {
            type: "APPROVAL_ACCEPTED",
            headSha: NEXT_HEAD,
          }, input.now());
        } catch {
          // Replay of merge-call start must not replace the first merge effect.
        }
        const merge = input.store.listEffectsForJob(opened.jobId).find((effect) => effect.kind === "merge_pr");
        if (!merge) throw new Error("ambiguous merge never emitted merge_pr");
        input.database.prepare(
          `INSERT INTO effects (
             idempotency_key, job_id, kind, payload_json, status, attempts,
             next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, 'merge_pr', ?, 'pending', 0, ?, ?, ?)`,
        ).run(
          `${merge.idempotencyKey}:duplicate`,
          opened.jobId,
          JSON.stringify(merge.payload),
          input.now(),
          input.now(),
          input.now(),
        );
        cancelJob(input.store, opened.jobId, input.now);
        runs.push(finishRun(input.store, input.evaluationPersistence, scenario, opened.jobId, "cancelled"));
        continue;
      }

      if (scenario === "canary_failure" || scenario === "successful_rollback") {
        seedProduction(
          input.store, input.database, opened.jobId, ownerId, lease.generation, input.now,
          scenario === "canary_failure" ? "verifying_production" : "deploying",
          queueSeq,
        );
        await runNextProductionEffect(
          input.store, opened.jobId, ownerId, lease.generation, input.now,
          async () => failingStage(scenario === "canary_failure" ? "canary" : "deploy"),
        );
        cancelJob(input.store, opened.jobId, input.now);
        releaseHeldClaims(input.database, input.now());
        runs.push(finishRun(input.store, input.evaluationPersistence, scenario, opened.jobId, "cancelled"));
        continue;
      }

      if (scenario === "re_release") {
        startResolvedIntegration(input.store, input.navigatorEffects, input.implementationPersistence, input.database, input.now, opened);
        markShippedChange(input.database, opened.jobId);
        propose(input.store, opened.jobId, input.now, {
          kind: "start_release",
          implementationTicketIds: [opened.ticketId],
        });
        const current = input.store.getJob(opened.jobId)!;
        const released = input.store.applyJobEvent(current.id, current.version, {
          type: "RELEASE_STARTED",
          number: 43,
          url: "https://github.com/acme/cyndra/pull/43",
          environmentId: "env_live",
        }, input.now());
        const headed = input.store.applyJobEvent(released.id, released.version, {
          type: "PR_HEAD_RESOLVED",
          headSha: NEXT_HEAD,
        }, input.now());
        input.store.applyJobEvent(headed.id, headed.version, {
          type: "VALIDATION_FAILED",
          headSha: NEXT_HEAD,
          reason: "Validation did not pass",
        }, input.now());
        propose(input.store, opened.jobId, input.now, {
          kind: "start_release",
          implementationTicketIds: [opened.ticketId],
        });
        cancelJob(input.store, opened.jobId, input.now);
        runs.push(finishRun(input.store, input.evaluationPersistence, scenario, opened.jobId, "cancelled"));
        continue;
      }

      const running = await runImplementation(
        input.store, input.navigatorEffects, input.implementationPersistence, input.database, input.now, opened, ownerId, lease.generation,
        { staleHead: false, findingsOnFirstReview: true },
      );
      await repairAndAccept(running, opened);
      closeTicket(input.store, running.executor, opened, ownerId, lease.generation, input.now);
      await running.executor.publishPullRequest({
        jobId: opened.jobId,
        title: "Disposable live tickets",
        body: "Implements the live scenario with one repair.",
      });
      markShippedChange(input.database, opened.jobId);
      propose(input.store, opened.jobId, input.now, {
        kind: "start_release",
        implementationTicketIds: [opened.ticketId],
      });
      const release = new NavigatorReleaseOperation({
        publishPullRequest: async () => ({
          operationId: "pr-43",
          jobId: opened.jobId,
          number: 43,
          url: "https://github.com/acme/cyndra/pull/43",
          headSha: NEXT_HEAD,
        }),
        integrationWorktreeId: () => `env_${opened.jobId}`,
      });
      const releaseProtocol = new NavigatorEffectProtocol({
        store: input.navigatorEffects,
        clock: { now: input.now },
        adapters: [
          { kind: "run_navigator_skill", execute: async () => ({ outcome: "permanent" as const, reason: "unused" }) },
          { kind: "run_navigator_ticket_worker", execute: async () => ({ outcome: "permanent" as const, reason: "unused" }) },
          createNavigatorReleaseEffectAdapter(release),
        ],
      });
      await releaseProtocol.processOne({
        ownerId,
        generation: lease.generation,
        signal: new AbortController().signal,
      }, new AbortController().signal);
      seedProduction(
        input.store, input.database, opened.jobId, ownerId, lease.generation, input.now, "deploying",
        queueSeq,
      );
      await runNextProductionEffect(
        input.store, opened.jobId, ownerId, lease.generation, input.now,
        async () => passingStage("deploy"),
      );
      await runNextProductionEffect(
        input.store, opened.jobId, ownerId, lease.generation, input.now,
        async () => passingStage("canary"),
      );
      releaseHeldClaims(input.database, input.now());
      runs.push(finishRun(input.store, input.evaluationPersistence, scenario, opened.jobId, "complete"));
    }
  } finally {
    input.store.releaseExecutorLease(ownerId, lease.generation, input.now());
  }
  return runs;
}

function finishRun(
  store: TelegramAgentStore,
  evaluationPersistence: NavigatorEvaluationPersistence,
  scenario: NavigatorLiveScenario,
  jobId: string,
  expected: "complete" | "cancelled",
): NavigatorLiveScenarioRecord {
  const terminalState = terminalOf(store, jobId, expected);
  const run = {
    scenario,
    jobId,
    terminalState,
    evidenceDigest: digest(`${scenario}:${jobId}`),
  };
  assertNavigatorLiveScenarioEvidence(evaluationPersistence, run);
  return run;
}
