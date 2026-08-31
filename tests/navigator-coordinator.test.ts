import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { DEFAULT_MODEL_POOL_REGISTRY } from "../src/capabilities/models";
import {
  DualEngineCoordinator,
  DUAL_ENGINE_RESTART_POINTS,
} from "../src/navigator/coordinator";
import {
  NAVIGATOR_EVALUATION_BUDGET_DIGEST,
  NAVIGATOR_EVALUATION_HARNESS_DIGEST,
} from "../src/navigator/evaluation-corpus";
import {
  navigatorAcceptanceCriteria,
} from "../src/navigator/implementation-contracts";
import {
  NavigatorImplementationExecutor,
  type NavigatorTicketWorkerAttempt,
} from "../src/navigator/implementation-executor";
import { DurableNavigatorPromotionEvidenceReader } from "../src/navigator/promotion-evidence";
import {
  NAVIGATOR_LIVE_SCENARIOS,
  NavigatorPromotionService,
} from "../src/navigator/promotion";
import { NavigatorEffectProtocol } from "../src/navigator/effect-protocol";
import { createNavigatorReleaseEffectAdapter } from "../src/navigator/plugin-runtime";
import { NavigatorReleaseExecutor } from "../src/navigator/release-executor";
import { EffectRunner } from "../src/services/effect-runner";
import { productionResourceKey, projectResourceKey, repositoryMergeResourceKey } from "../src/autonomy/models";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { stableWorkArtifactId, type CaptureWorkArtifactInput } from "../src/work-artifacts/repository";
import { policyFixture, productionPolicyFixture, sha } from "./helpers";
import { runRequiredNavigatorLiveScenarios } from "./support/navigator-live-scenarios";

const EXTERNAL_DIGEST = "e".repeat(64);
const HEAD = "1".repeat(40);
let fixtureSequence = 0;

function modelRoute() {
  return { pool: "strong" as const, ...DEFAULT_MODEL_POOL_REGISTRY.worker.strong };
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
    effortId: "effort_dual",
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
    content: `# ${input.title}\n\nDisposable dual-engine artifact.`,
    acceptanceCriteria: [`${input.title} is accepted`],
    relationships: [],
    capturedAt: 1_000 + input.trackerOrder,
  };
}

function openCoordinatorFixture() {
  fixtureSequence += 1;
  const { bb } = createFakePluginHost({ pluginId: `navigator-coordinator-${fixtureSequence}` });
  let currentTime = 20_000;
  const now = () => currentTime++;
  const store = openStore(bb.storage, bb.storage.kv, now);
  store.createPairingCode(hashSecret("pair"), 1_000, 20_000);
  if (!store.pairOwnerWithCode(hashSecret("pair"), "7", "7", 1_001).ok) throw new Error("owner pairing failed");
  store.upsertProjectPolicy(policyFixture({
    production: {
      ...productionPolicyFixture(),
      rollbackCommand: { name: "rollback", command: "./rollback", timeoutMs: 60_000 },
    },
  }), 1_002);
  const coordinator = new DualEngineCoordinator({
    store,
    database: bb.storage.database(),
    now,
  });
  return { bb, store, database: bb.storage.database(), now, coordinator };
}

function seedTrials(store: TelegramAgentStore, now: () => number) {
  const job = store.createJob({
    id: `job_trials_${fixtureSequence}`,
    sourceUpdateId: 80_000 + fixtureSequence,
    requestText: "Host navigator model trials",
    now: now(),
  });
  const candidateTrialIds: string[] = [];
  const baselineTrialIds: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const candidate = index < 5;
    const attemptId = `trial-attempt-${fixtureSequence}-${index}`;
    store.createAttempt({
      id: attemptId,
      jobId: job.id,
      kind: "implementation",
      ordinal: index + 1,
      now: now(),
    });
    const selected = store.recordModelRouteSelection({
      subjectKind: "worker_attempt",
      subjectId: attemptId,
      attempt: 1,
      stage: "implementation",
      operation: candidate ? "candidate" : "baseline",
      route: {
        pool: candidate ? "standard" : "strong",
        providerId: "codex",
        modelId: candidate ? "candidate-model" : "baseline-model",
        reasoning: "high",
        serviceTier: "default",
      },
      now: now(),
    });
    store.settleModelRouteTrial({
      subjectKind: "worker_attempt",
      subjectId: attemptId,
      attempt: 1,
      outcome: "passed",
      failureSignature: null,
      now: now(),
    });
    if (candidate) candidateTrialIds.push(selected.id);
    else baselineTrialIds.push(selected.id);
  }
  return { candidateTrialIds, baselineTrialIds };
}

function createLiveJob(
  store: TelegramAgentStore,
  database: Database.Database,
  scenario: typeof NAVIGATOR_LIVE_SCENARIOS[number],
  now: () => number,
) {
  const job = store.createJob({
    id: `job_live_${fixtureSequence}_${scenario}`.slice(0, 256),
    sourceUpdateId: 81_000 + fixtureSequence * 20 + NAVIGATOR_LIVE_SCENARIOS.indexOf(scenario),
    requestText: `Disposable ${scenario}`,
    workflow: { engine: "navigator-v1", mode: "deterministic" },
    now: now(),
  });
  const terminalState = scenario === "interrupted_tracker_create" ? "cancelled" as const : "complete" as const;
  database.prepare("UPDATE jobs SET state = ? WHERE id = ?").run(terminalState, job.id);
  return { jobId: job.id, terminalState };
}

function confirmNavigatorAdmission(
  store: TelegramAgentStore,
  now: () => number,
  task = "Navigate after promotion",
) {
  store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 91_000 + fixtureSequence,
    inputText: task,
    now: now(),
  });
  const lease = store.acquireExecutorLease("executor", now(), 120_000);
  if (!lease.acquired) throw new Error("missing executor lease");
  const turn = store.claimNextControllerTurn({
    ownerId: "executor",
    generation: lease.generation,
    now: now(),
  });
  if (!turn) throw new Error("missing controller turn");
  if (!store.markControllerSpawned({
    turnId: turn.id,
    ownerId: "executor",
    generation: lease.generation,
    now: now(),
    projectId: "proj_1",
    hostId: "host_1",
    threadId: "thr_coordinator_dual",
  })) throw new Error("controller spawn was not recorded");
  if (!store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: "executor",
    generation: lease.generation,
    now: now(),
  })) throw new Error("controller submission was not recorded");
  return {
    job: store.createConfirmedControllerJob({
      controllerThreadId: "thr_coordinator_dual",
      projectId: "proj_1",
      task,
      now: now(),
    }),
    leaseGeneration: lease.generation,
  };
}

describe("dual-engine coordinator", () => {
  it("refuses live evidence that is only a SQL-stamped terminal job", async () => {
    const { store, database, now, coordinator } = openCoordinatorFixture();
    const corpus = await coordinator.evaluateCorpus();
    const liveRuns = NAVIGATOR_LIVE_SCENARIOS.map((scenario) => {
      const live = createLiveJob(store, database, scenario, now);
      return {
        scenario,
        jobId: live.jobId,
        terminalState: live.terminalState,
        evidenceDigest: "c".repeat(64),
      };
    });
    const trials = seedTrials(store, now);
    expect(() => coordinator.persistEvaluationEvidence({
      corpus,
      liveRuns,
      candidateTrialIds: trials.candidateTrialIds,
      baselineTrialIds: trials.baselineTrialIds,
      harnessDigest: NAVIGATOR_EVALUATION_HARNESS_DIGEST,
      budgetDigest: NAVIGATOR_EVALUATION_BUDGET_DIGEST,
      reviewed: true,
    })).toThrow(/not an executed disposable run/);
  });

  it("evaluates the fixed corpus, persists reviewed evidence, and admits navigator-v1", async () => {
    const { store, database, now, coordinator } = openCoordinatorFixture();
    const corpus = await coordinator.evaluateCorpus();
    expect(corpus).toMatchObject({ total: 58, correct: 58, unauthorizedEffects: 0 });

    const liveRuns = await runRequiredNavigatorLiveScenarios({
      store, database, now, sequence: fixtureSequence,
    });
    const trials = seedTrials(store, now);
    coordinator.persistEvaluationEvidence({
      corpus,
      liveRuns,
      candidateTrialIds: trials.candidateTrialIds,
      baselineTrialIds: trials.baselineTrialIds,
      harnessDigest: NAVIGATOR_EVALUATION_HARNESS_DIGEST,
      budgetDigest: NAVIGATOR_EVALUATION_BUDGET_DIGEST,
      reviewed: true,
    });

    const promotions = new NavigatorPromotionService({
      store,
      readEvidence: () => new DurableNavigatorPromotionEvidenceReader(store).read(),
      now,
    });
    const decision = await promotions.promote();
    expect(decision.action).toBe("promote");
    const { job: admitted } = confirmNavigatorAdmission(store, now);
    expect(admitted).toMatchObject({ workflowEngine: "navigator-v1", workflowMode: "deterministic" });
  });

  it("names every restart injection point required for dual-engine promotion", () => {
    expect(DUAL_ENGINE_RESTART_POINTS).toEqual([
      "proposal",
      "claim",
      "tracker_create",
      "worker_dispatch",
      "result_storage",
      "head_change",
      "merge_call_start",
      "deploy",
      "rollback",
      "canary",
    ]);
  });

  it("does not persist restart as passed or safety zeros unless those were measured", async () => {
    const { store, database, now, coordinator } = openCoordinatorFixture();
    const corpus = await coordinator.evaluateCorpus();
    const liveRuns = await runRequiredNavigatorLiveScenarios({
      store, database, now, sequence: fixtureSequence,
    });
    const trials = seedTrials(store, now);
    coordinator.persistEvaluationEvidence({
      corpus: { ...corpus, unauthorizedEffects: 2, restartPointsMeasured: [] },
      liveRuns,
      candidateTrialIds: trials.candidateTrialIds,
      baselineTrialIds: trials.baselineTrialIds,
      harnessDigest: NAVIGATOR_EVALUATION_HARNESS_DIGEST,
      budgetDigest: NAVIGATOR_EVALUATION_BUDGET_DIGEST,
      reviewed: true,
    });

    const evidence = new DurableNavigatorPromotionEvidenceReader(store).read();
    expect(evidence?.deterministic.find((entry) => entry.category === "restart")).toMatchObject({
      outcome: "failed",
    });
    expect(evidence?.safetyCounters.find((entry) => entry.counter === "unauthorized_effects")).toMatchObject({
      count: 2,
    });
    const promotions = new NavigatorPromotionService({
      store,
      readEvidence: () => new DurableNavigatorPromotionEvidenceReader(store).read(),
      now,
    });
    await expect(promotions.promote()).rejects.toMatchObject({
      assessment: { status: "failed", ready: false },
    });
  });
});

describe("disposable navigator live path", () => {
  it("creates tickets, implements them sequentially with one repair, opens one pull request, and deploys", async () => {
    const { store, database, now } = openCoordinatorFixture();
    const specificationId = stableWorkArtifactId("proj_1", `spec-dual-${fixtureSequence}`);
    const firstTicketId = stableWorkArtifactId("proj_1", `ticket-dual-1-${fixtureSequence}`);
    const secondTicketId = stableWorkArtifactId("proj_1", `ticket-dual-2-${fixtureSequence}`);
    const specification = store.captureWorkArtifact(artifactInput({
      id: specificationId, operationId: "spec-dual", kind: "specification", title: "Canonical spec", trackerOrder: 0,
    }));
    const firstTicket = store.captureWorkArtifact({
      ...artifactInput({
        id: firstTicketId, operationId: "ticket-dual-1", kind: "implementation_ticket", title: "First ticket", trackerOrder: 1,
      }),
      relationships: [{
        kind: "parent",
        sourceArtifactId: firstTicketId,
        sourceRef: `artifact:${firstTicketId}`,
        targetArtifactId: specificationId,
        targetRef: `artifact:${specificationId}`,
      }],
    });
    const secondTicket = store.captureWorkArtifact({
      ...artifactInput({
        id: secondTicketId, operationId: "ticket-dual-2", kind: "implementation_ticket", title: "Second ticket", trackerOrder: 2,
      }),
      relationships: [{
        kind: "parent",
        sourceArtifactId: secondTicketId,
        sourceRef: `artifact:${secondTicketId}`,
        targetArtifactId: specificationId,
        targetRef: `artifact:${specificationId}`,
      }, {
        kind: "blocks",
        sourceArtifactId: firstTicketId,
        sourceRef: `artifact:${firstTicketId}`,
        targetArtifactId: secondTicketId,
        targetRef: `artifact:${secondTicketId}`,
      }],
    });
    store.appendWorkflowEngineRolloutDecision({
      action: "promote",
      reasonCode: "promotion_gates_passed",
      evidenceDigest: "a".repeat(64),
      now: now(),
    });
    const { job: draft, leaseGeneration } = confirmNavigatorAdmission(
      store,
      now,
      "Ship the disposable dual-engine tickets to production",
    );
    store.bindNavigatorJobArtifacts({
      jobId: draft.id,
      expectedVersion: draft.version,
      artifactBindings: [specification, firstTicket, secondTicket].map(({ artifact, snapshot }) => ({
        artifactId: artifact.id,
        snapshotId: snapshot.id,
        snapshotDigest: snapshot.snapshotDigest,
      })),
      now: now(),
    });
    database.prepare("UPDATE jobs SET state = 'implementing' WHERE id = ?").run(draft.id);
    const lease = { generation: leaseGeneration };

    const workerRunner = {
      run: vi.fn(async (attempt: NavigatorTicketWorkerAttempt, hooks: {
        bindResource(resource: { kind: "bb_thread"; id: string }): Promise<void>;
      }) => {
        const resource = attempt.resource ?? { kind: "bb_thread" as const, id: `thr_${attempt.id}` };
        await hooks.bindResource(resource);
        if (attempt.kind === "implementation") {
          const ticketSnapshot = store.getWorkArtifactSnapshot(attempt.workOrder.ticket.snapshotId)!;
          return {
            resource,
            result: {
              kind: "implementation_result",
              baseHeadSha: attempt.workOrder.baseHeadSha,
              headSha: attempt.ordinal === 1 ? "2".repeat(40) : "3".repeat(40),
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
          (attempt.workOrder.ticket.artifactId === firstTicketId && attempt.ordinal === 1);
        const findings = needsRepair
          ? attempt.workOrder.verificationOf?.findings ?? [{
            rootCauseId: "dual-engine-repair",
            capabilityId: "code-review",
            ruleId: "SPEC-DUAL-REPAIR",
            severity: "high" as const,
            subject: "src/app.ts",
            line: 1,
            requirementId: "SPEC-DUAL-REPAIR",
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
      reconcileUnavailableResource: vi.fn(),
    };
    const pullRequests = {
      createOrRefresh: vi.fn(async (request: Readonly<{ headSha: string; operationId: string }>) => ({
        jobId: draft.id,
        number: 43,
        url: "https://github.com/acme/cyndra/pull/43",
        headSha: request.headSha,
        operationId: request.operationId,
      })),
    };
    const executor = new NavigatorImplementationExecutor({
      store,
      database,
      workerRunner,
      gitObserver: {
        observe: async (request) => ({
          kind: "navigator_git_observation",
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
          observedAt: now(),
        }),
      },
      pullRequests,
      modelRoute: (kind) => ({
        pool: kind === "review" ? "strong" : "standard",
        ...DEFAULT_MODEL_POOL_REGISTRY.worker[kind === "review" ? "strong" : "standard"],
      }),
      clock: { now },
    });
    executor.startIntegration({
      jobId: draft.id,
      specificationArtifactId: specificationId,
      implementationTicketIds: [firstTicketId, secondTicketId],
      baseBranch: "main",
      integrationBranch: "hanoon/job-dual",
      worktreeId: "env_job_dual",
      baseHeadSha: HEAD,
      evidenceRefs: ["ticket:dual"],
    });

    const claim = (ticketId: string) => {
      const artifact = store.getWorkArtifact(ticketId)!;
      const snapshot = store.getCurrentWorkArtifactSnapshot(ticketId)!;
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
      const claimed = store.claimWorkArtifact({
        artifactId: ticketId,
        workflowStepId: `implement:${ticketId}`,
        jobId: draft.id,
        snapshotId: snapshot.id,
        externalAssignee: "owner",
        ownerId: "executor",
        generation: lease.generation,
        now: now(),
        leaseMs: 100_000,
      });
      if (!claimed) throw new Error(`ticket ${ticketId} was not claimed`);
      return claimed.id;
    };
    const close = (ticketId: string, reviewAttemptId: string) => {
      const claimRecord = store.getHeldWorkArtifactClaim(ticketId)!;
      store.releaseWorkArtifactClaim({
        claimId: claimRecord.id,
        ownerId: "executor",
        generation: lease.generation,
        reason: "accepted",
        now: now(),
      });
      const artifact = store.getWorkArtifact(ticketId)!;
      const snapshot = store.getCurrentWorkArtifactSnapshot(ticketId)!;
      const closed = store.observeWorkArtifact({
        artifactId: ticketId,
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
      const intent = store.authorizeWorkArtifactResolution({
        artifactId: ticketId,
        operationId: `resolve:${ticketId}`,
        outcome: "resolved",
        snapshotId: snapshot.id,
        expectedExternalRevision: closed.artifact.externalRevision,
        evidenceRefs: [`navigator-result:${reviewAttemptId}`],
        now: now(),
      });
      if (!intent) throw new Error(`ticket ${ticketId} resolution was not authorized`);
      store.finalizeWorkArtifactResolution({
        intentId: intent.id,
        externalRevision: closed.artifact.externalRevision,
        now: now(),
      });
    };

    const fence = { ownerId: "executor", generation: lease.generation, signal: new AbortController().signal };
    const firstClaimId = claim(firstTicketId);
    executor.beginClaimedTicket({
      jobId: draft.id,
      ticketArtifactId: firstTicketId,
      claimId: firstClaimId,
      taskEvidence: ["behavioral-change"],
      evidenceRefs: ["ticket:dual:1"],
      ownerId: "executor",
      generation: lease.generation,
    });
    await executor.processOne(fence, new AbortController().signal);
    await executor.processOne(fence, new AbortController().signal);
    await executor.processOne(fence, new AbortController().signal);
    const firstSlice = executor.snapshot(draft.id);
    expect(firstSlice.activeSlice?.state).toBe("repair_pending");
    const repairSnapshot = executor.prepareRepairNavigation({
      jobId: draft.id,
      ticketArtifactId: firstTicketId,
      evidenceRefs: ["review-finding:SPEC-DUAL-REPAIR"],
    });
    const repairDecision = executor.recordRepairProposal({
      snapshotId: repairSnapshot.snapshotId,
      rawProposal: {
        kind: "implementation",
        basedOn: { snapshotId: repairSnapshot.snapshotId, digest: repairSnapshot.digest },
        objective: "Repair the disposable finding.",
        taskEvidence: ["behavioral-change"],
        evidenceRefs: ["review-finding:SPEC-DUAL-REPAIR"],
      },
    });
    executor.scheduleRepair({
      jobId: draft.id,
      ticketArtifactId: firstTicketId,
      proposalId: repairDecision.proposalId,
    });
    await executor.processOne(fence, new AbortController().signal);
    await executor.processOne(fence, new AbortController().signal);
    const firstAccepted = executor.snapshot(draft.id);
    const firstReview = [...firstAccepted.attempts].reverse().find((attempt) => attempt.kind === "review")!;
    close(firstTicketId, firstReview.id);
    executor.markTicketResolved({ jobId: draft.id, ticketArtifactId: firstTicketId });

    const secondClaimId = claim(secondTicketId);
    executor.beginClaimedTicket({
      jobId: draft.id,
      ticketArtifactId: secondTicketId,
      claimId: secondClaimId,
      taskEvidence: ["behavioral-change"],
      evidenceRefs: ["ticket:dual:2"],
      ownerId: "executor",
      generation: lease.generation,
    });
    await executor.processOne(fence, new AbortController().signal);
    await executor.processOne(fence, new AbortController().signal);
    const secondAccepted = executor.snapshot(draft.id);
    const secondReview = [...secondAccepted.attempts].reverse().find((attempt) =>
      attempt.kind === "review" && attempt.workOrder.ticket.artifactId === secondTicketId)!;
    close(secondTicketId, secondReview.id);
    executor.markTicketResolved({ jobId: draft.id, ticketArtifactId: secondTicketId });

    const pullRequest = await executor.publishPullRequest({
      jobId: draft.id,
      title: "Disposable dual-engine tickets",
      body: "Implements both tickets with one repair.",
    });
    expect(pullRequest).toMatchObject({ number: 43 });
    expect(pullRequests.createOrRefresh).toHaveBeenCalledTimes(1);

    const snapshot = store.createNavigatorSnapshot({
      jobId: draft.id,
      externalStateDigest: EXTERNAL_DIGEST,
      evidenceRefs: ["ticket:dual"],
      now: now(),
    });
    const releaseDecision = store.recordNavigatorProposal({
      snapshotId: snapshot.snapshotId,
      rawProposal: {
        basedOn: snapshot.identity,
        rationale: "The disposable tickets are ready for release.",
        evidenceRefs: ["ticket:dual"],
        kind: "start_release",
        implementationTicketIds: [firstTicketId, secondTicketId],
      },
      observation: {
        nativeToolCalls: [],
        claimedCodeWorktreeId: null,
        dynamicEffectToolIds: [],
        externalStateDigest: EXTERNAL_DIGEST,
      },
      selectModelRoute: modelRoute,
      now: now(),
    });
    expect(releaseDecision.decision).toBe("accepted");
    const releaseClaimNow = now();
    const insertReleaseClaim = database.prepare(
      `INSERT INTO job_resource_claims (
         job_id, resource_key, resource_kind, state, owner_id, generation,
         lease_expires_at, acquired_at, renewed_at
       ) VALUES (?, ?, ?, 'held', 'executor', ?, ?, ?, ?)`,
    );
    insertReleaseClaim.run(draft.id, projectResourceKey("proj_1"), "project", lease.generation, 130_000, releaseClaimNow, releaseClaimNow);
    insertReleaseClaim.run(draft.id, repositoryMergeResourceKey("acme/cyndra"), "repository_merge", lease.generation, 130_000, releaseClaimNow, releaseClaimNow);
    insertReleaseClaim.run(draft.id, productionResourceKey(store.getJob(draft.id)!.policy!), "production_target", lease.generation, 130_000, releaseClaimNow, releaseClaimNow);
    const release = new NavigatorReleaseExecutor({
      publishPullRequest: async () => ({
        operationId: "pr-43",
        jobId: draft.id,
        number: 43,
        url: "https://github.com/acme/cyndra/pull/43",
        headSha: HEAD,
      }),
      integrationWorktreeId: () => "env_job_dual",
    });
    const releaseProtocol = new NavigatorEffectProtocol({
      store,
      clock: { now },
      adapters: [
        { kind: "run_navigator_skill", execute: async () => ({ outcome: "permanent" as const, reason: "unused" }) },
        { kind: "run_navigator_ticket_worker", execute: async () => ({ outcome: "permanent" as const, reason: "unused" }) },
        createNavigatorReleaseEffectAdapter(release),
      ],
    });
    expect(await releaseProtocol.processOne({
      ownerId: "executor",
      generation: lease.generation,
      signal: new AbortController().signal,
    }, new AbortController().signal)).toBe(true);

    const job = store.getJob(draft.id)!;
    database.prepare(
      `UPDATE jobs SET state = 'deploying', environment_id = 'env_job_dual', pr_number = 43,
         pr_url = 'https://github.com/acme/cyndra/pull/43', pr_head_sha = ?,
         merge_message = 'Merged pull request #43', merge_commit_sha = ?,
         merged_at = '2026-08-10T00:00:00.000Z', version = version + 1 WHERE id = ?`,
    ).run(sha("a"), sha("d"), job.id);
    database.prepare("UPDATE effects SET status = 'done' WHERE job_id = ?").run(draft.id);
    database.prepare(
      `UPDATE job_admissions SET project_id = ?, state = 'admitted', admitted_at = ? WHERE job_id = ?`,
    ).run("proj_1", now(), draft.id);
    const current = store.getJob(draft.id)!;
    const deployKey = `${current.id}:${current.version + 1}:deploy_production`;
    database.prepare(
      `INSERT INTO effects (
         idempotency_key, job_id, kind, payload_json, status, attempts,
         next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, 'deploy_production', '{}', 'pending', 0, ?, ?, ?)`,
    ).run(deployKey, current.id, now(), now(), now());
    const passingStage = (phase: "deploy" | "canary") => ({
      phase,
      outcome: "pass" as const,
      summary: phase === "deploy" ? "Deployed" : "Canary passed",
      failedCommand: null,
      commandReceipts: [
        { name: "verify-merged-checkout", command: "git-head-check", outcome: "pass" as const, exitCode: 0, output: "ok" },
        {
          name: phase,
          command: phase === "deploy" ? "./scripts/deploy-production.sh" : "./scripts/verify-production.sh",
          outcome: "pass" as const,
          exitCode: 0,
          output: "ok",
        },
      ],
      terminalIds: [`term_${phase}`],
      completedAt: "2026-08-10T00:01:00.000Z",
    });
    const claimed = store.leaseNextJobEffect({
      jobId: draft.id,
      ownerId: "executor",
      generation: lease.generation,
      now: now(),
      leaseMs: 30_000,
    });
    expect(claimed?.kind).toBe("deploy_production");
    await new EffectRunner({
      store,
      fence: { ownerId: "executor", generation: lease.generation, signal: new AbortController().signal },
      now,
      runProductionStage: vi.fn(async () => passingStage("deploy")),
    }).run(claimed!);
    store.completeEffect(claimed!.idempotencyKey, "executor", lease.generation, now());
    expect(store.getJob(draft.id)?.state).toBe("verifying_production");
    let canary = store.leaseNextJobEffect({
      jobId: draft.id,
      ownerId: "executor",
      generation: lease.generation,
      now: now(),
      leaseMs: 30_000,
    });
    if (canary?.kind === "render_status") {
      store.completeEffect(canary.idempotencyKey, "executor", lease.generation, now());
      canary = store.leaseNextJobEffect({
        jobId: draft.id,
        ownerId: "executor",
        generation: lease.generation,
        now: now(),
        leaseMs: 30_000,
      });
    }
    expect(canary?.kind).toBe("verify_production");
    await new EffectRunner({
      store,
      fence: { ownerId: "executor", generation: lease.generation, signal: new AbortController().signal },
      now,
      runProductionStage: vi.fn(async () => passingStage("canary")),
    }).run(canary!);
    store.completeEffect(canary!.idempotencyKey, "executor", lease.generation, now());
    expect(store.getJob(draft.id)?.state).toBe("complete");
    expect(new Set(store.listEffectsForJob(draft.id).map((effect) => effect.idempotencyKey)).size)
      .toBe(store.listEffectsForJob(draft.id).length);
  });

  it("replays a navigator proposal without duplicating the durable decision", () => {
    const { store, database, now } = openCoordinatorFixture();
    const job = store.createJob({
      id: `job_restart_proposal_${fixtureSequence}`,
      sourceUpdateId: 93_000 + fixtureSequence,
      requestText: "Restart after proposal",
      workflow: { engine: "navigator-v1", mode: "deterministic" },
      now: now(),
    });
    store.applyJobEvent(job.id, job.version, {
      type: "PROJECT_SELECTED",
      projectId: "proj_1",
      policyVersion: 1,
      policy: policyFixture(),
    }, now());
    const snapshot = store.createNavigatorSnapshot({
      jobId: job.id,
      externalStateDigest: EXTERNAL_DIGEST,
      evidenceRefs: ["restart"],
      now: now(),
    });
    const proposal = {
      basedOn: snapshot.identity,
      rationale: "Restart-safe dual-engine proposal.",
      evidenceRefs: ["restart"],
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
      selectModelRoute: modelRoute,
      now: now(),
    });
    const replay = store.recordNavigatorProposal({
      snapshotId: snapshot.snapshotId,
      rawProposal: proposal,
      observation,
      selectModelRoute: modelRoute,
      now: now(),
    });
    expect(replay.proposalId).toBe(first.proposalId);
    const effects = store.listEffectsForJob(job.id);
    expect(new Set(effects.map((effect) => effect.idempotencyKey)).size).toBe(effects.length);
    expect(database.prepare("SELECT COUNT(*) AS count FROM navigator_proposals WHERE job_id = ?").get(job.id))
      .toEqual({ count: 1 });
  });
});
