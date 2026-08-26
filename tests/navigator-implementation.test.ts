import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_POOL_REGISTRY } from "../src/capabilities/models";
import {
  NavigatorImplementationExecutor,
  NavigatorTicketWorkerUnavailableError,
  type NavigatorTicketWorkerAttempt,
  type NavigatorTicketWorkerRunner,
} from "../src/navigator/implementation-executor";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import {
  stableWorkArtifactId,
  type CaptureWorkArtifactInput,
} from "../src/work-artifacts/repository";
import { policyFixture } from "./helpers";

const SHA = {
  base: "1".repeat(40),
  ticketOne: "2".repeat(40),
  repair: "3".repeat(40),
  ticketTwo: "4".repeat(40),
} as const;

let fixtureSequence = 0;

type Fixture = Readonly<{
  store: TelegramAgentStore;
  database: Database.Database;
  jobId: string;
  specificationId: string;
  ticketIds: readonly [string, string];
  now(): number;
  claim(ticketId: string): number;
  close(ticketId: string, reviewAttemptId: string): void;
}>;

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
    projectId: "proj_40",
    effortId: "job_40",
    operationId: input.operationId,
    kind: input.kind,
    status: "ready",
    trackerKind: "github",
    trackerNamespace: "github:acme/widgets",
    externalId: input.operationId,
    externalUrl: `https://github.com/acme/widgets/issues/${input.operationId}`,
    externalRevision: `${input.operationId}:1`,
    externalStatus: "open",
    assignees: [],
    title: input.title,
    trackerOrder: input.trackerOrder,
    content: `# ${input.title}\n\nImmutable ticket 40 fixture.`,
    acceptanceCriteria: [`${input.title} is accepted`],
    relationships: input.relationships ?? [],
    capturedAt: 1_000 + input.trackerOrder,
  };
}

function fixture(): Fixture {
  fixtureSequence += 1;
  const { bb } = createFakePluginHost({ pluginId: `navigator-implementation-${fixtureSequence}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 1_000);
  let currentTime = 1_100;
  const now = () => currentTime++;
  const specificationId = stableWorkArtifactId("proj_40", "specification-35");
  const firstTicketId = stableWorkArtifactId("proj_40", "ticket-40-1");
  const secondTicketId = stableWorkArtifactId("proj_40", "ticket-40-2");
  const specification = store.captureWorkArtifact(artifactInput({
    id: specificationId,
    operationId: "35",
    kind: "specification",
    title: "Agent-owned engineering workflow",
    trackerOrder: 0,
  }));
  const firstTicket = store.captureWorkArtifact(artifactInput({
    id: firstTicketId,
    operationId: "40-1",
    kind: "implementation_ticket",
    title: "Add the integration lane",
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
    operationId: "40-2",
    kind: "implementation_ticket",
    title: "Prove restart behavior",
    trackerOrder: 2,
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
  }));
  const draft = store.createJob({
    id: "job_40",
    sourceUpdateId: 40,
    requestText: "Implement the specification tickets in one integration lane.",
    workflow: { engine: "navigator-v1", mode: "deterministic" },
    now: now(),
  });
  const selected = store.applyJobEvent(draft.id, draft.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_40",
    policyVersion: 1,
    policy: policyFixture({ projectId: "proj_40" }),
  }, now());
  store.bindNavigatorJobArtifacts({
    jobId: selected.id,
    expectedVersion: selected.version,
    artifactBindings: [specification, firstTicket, secondTicket].map(({ artifact, snapshot }) => ({
      artifactId: artifact.id,
      snapshotId: snapshot.id,
      snapshotDigest: snapshot.snapshotDigest,
    })),
    now: now(),
  });
  bb.storage.database().prepare("UPDATE jobs SET state = 'implementing' WHERE id = ?").run(draft.id);
  const lease = store.acquireExecutorLease("executor-40", now(), 100_000);
  if (!lease.acquired) throw new Error("executor fixture lease was unavailable");

  const claim = (ticketId: string): number => {
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
      ownerId: "executor-40",
      generation: lease.generation,
      now: now(),
      leaseMs: 100_000,
    });
    if (!claimed) throw new Error(`ticket ${ticketId} was not claimed`);
    return claimed.id;
  };

  const close = (ticketId: string, reviewAttemptId: string): void => {
    const claimRecord = store.getHeldWorkArtifactClaim(ticketId)!;
    store.releaseWorkArtifactClaim({
      claimId: claimRecord.id,
      ownerId: "executor-40",
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
    const resolved = store.finalizeWorkArtifactResolution({
      intentId: intent.id,
      externalRevision: closed.artifact.externalRevision,
      now: now(),
    });
    if (!resolved) throw new Error(`ticket ${ticketId} resolution was not finalized`);
  };

  return {
    store,
    database: bb.storage.database(),
    jobId: draft.id,
    specificationId,
    ticketIds: [firstTicketId, secondTicketId],
    now,
    claim,
    close,
  };
}

function implementationResult(attempt: NavigatorTicketWorkerAttempt, headSha: string) {
  return {
    kind: "implementation_result" as const,
    baseHeadSha: attempt.workOrder.baseHeadSha,
    headSha,
    summary: `Implemented ${attempt.workOrder.ticket.artifactId}.`,
    changedPaths: ["src/navigator/implementation-executor.ts", "tests/navigator-implementation.test.ts"],
    focusedVerification: [{ command: "npm test -- navigator-implementation", outcome: "passed" as const }],
    fullVerification: [{ command: "npm run check", outcome: "passed" as const }],
    capabilityOutcomes: attempt.profile.assignments.map(({ capabilityId }) => ({
      capabilityId,
      outcome: "passed" as const,
      evidenceRefs: [`worker:${attempt.id}:${capabilityId}`],
    })),
  };
}

function reviewResult(
  attempt: NavigatorTicketWorkerAttempt,
  outcome: "passed" | "findings",
) {
  return {
    kind: "code_review_result" as const,
    reviewedHeadSha: attempt.workOrder.baseHeadSha,
    outcome,
    summary: outcome === "passed" ? "The exact head passes review." : "One exact-head finding needs repair.",
    findings: outcome === "findings" ? [{
      ruleId: "SPEC-40-RESTART",
      severity: "high" as const,
      summary: "The interrupted worker path is not yet durable.",
      evidenceRefs: [`head:${attempt.workOrder.baseHeadSha}`],
    }] : [],
    capabilityOutcomes: attempt.profile.assignments.map(({ capabilityId }) => ({
      capabilityId,
      outcome: outcome === "findings" ? "findings" as const : "passed" as const,
      evidenceRefs: [`worker:${attempt.id}:${capabilityId}`],
    })),
  };
}

describe("navigator ticket integration executor", () => {
  it("sequentially integrates fresh ticket workers, repairs review findings, and publishes one pull request", async () => {
    const value = fixture();
    let firstAttemptInterrupted = true;
    let secondAttemptMissing = true;
    const workerRunner: NavigatorTicketWorkerRunner = {
      run: vi.fn(async (attempt, hooks) => {
        const resource = attempt.resource ?? { kind: "bb_thread" as const, id: `thr_${attempt.id}` };
        await hooks.bindResource(resource);
        if (attempt.kind === "implementation" && firstAttemptInterrupted) {
          firstAttemptInterrupted = false;
          throw new Error("worker stopped after durable thread binding");
        }
        if (
          attempt.kind === "implementation" && attempt.workOrder.ticket.artifactId === value.ticketIds[1] &&
          secondAttemptMissing
        ) {
          secondAttemptMissing = false;
          throw new NavigatorTicketWorkerUnavailableError("missing");
        }
        if (attempt.kind === "implementation") {
          const head = attempt.ordinal === 1 && attempt.workOrder.ticket.artifactId === value.ticketIds[0]
            ? SHA.ticketOne
            : attempt.workOrder.ticket.artifactId === value.ticketIds[0]
              ? SHA.repair
              : SHA.ticketTwo;
          return { resource, result: implementationResult(attempt, head) };
        }
        const needsRepair = attempt.workOrder.ticket.artifactId === value.ticketIds[0] && attempt.ordinal === 1;
        return { resource, result: reviewResult(attempt, needsRepair ? "findings" : "passed") };
      }),
    };
    let pullRequestCreated = false;
    const pullRequests = {
      createOrRefresh: vi.fn(async (request: Readonly<{ headSha: string; operationId: string }>) => {
        if (!pullRequestCreated) {
          pullRequestCreated = true;
          throw new Error("publisher stopped after the idempotent pull request write");
        }
        return {
          jobId: value.jobId,
          number: 40,
          url: "https://github.com/acme/widgets/pull/40",
          headSha: request.headSha,
          operationId: request.operationId,
        };
      }),
    };
    const newExecutor = () => new NavigatorImplementationExecutor({
      store: value.store,
      database: value.database,
      workerRunner,
      pullRequests,
      modelRoute: (kind) => ({
        pool: kind === "review" ? "strong" : "standard",
        ...DEFAULT_MODEL_POOL_REGISTRY.worker[kind === "review" ? "strong" : "standard"],
      }),
      clock: { now: value.now },
    });
    let executor = newExecutor();
    executor.startIntegration({
      jobId: value.jobId,
      specificationArtifactId: value.specificationId,
      implementationTicketIds: value.ticketIds,
      baseBranch: "main",
      integrationBranch: "hanoon/job-40",
      worktreeId: "env_job_40",
      baseHeadSha: SHA.base,
      evidenceRefs: ["specification:35", "ticket:40"],
    });

    const firstClaimId = value.claim(value.ticketIds[0]);
    const firstSlice = executor.beginClaimedTicket({
      jobId: value.jobId,
      ticketArtifactId: value.ticketIds[0],
      claimId: firstClaimId,
      taskEvidence: ["reproducible-bug", "behavioral-change", "interface-design", "merge-conflict", "agent-instructions"],
      evidenceRefs: ["ticket:40:claim"],
    });
    expect(firstSlice.state).toBe("implementation_pending");
    const fence = { ownerId: "executor-40", generation: 1, signal: new AbortController().signal };
    await executor.processOne(fence, new AbortController().signal);
    const interrupted = executor.snapshot(value.jobId).attempts[0]!;
    expect(interrupted.resource?.id).toBe(`thr_${interrupted.id}`);
    expect(interrupted.stepContract).toMatchObject({
      skillId: "implement",
      freshContext: true,
      codeWriting: true,
    });
    expect(interrupted.workOrder).toMatchObject({
      projectPolicyVersion: 1,
      projectPolicyDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(interrupted.profile.assignments.map(({ capabilityId }) => capabilityId)).toEqual([
      "codebase-design",
      "diagnosing-bugs",
      "implement",
      "resolving-merge-conflicts",
      "tdd",
      "writing-for-agents",
    ]);

    executor = newExecutor();
    await executor.processOne(fence, new AbortController().signal);
    await executor.processOne(fence, new AbortController().signal);
    expect(executor.snapshot(value.jobId).activeSlice?.state).toBe("repair_pending");
    const repair = executor.scheduleRepair({
      jobId: value.jobId,
      ticketArtifactId: value.ticketIds[0],
      taskEvidence: ["behavioral-change"],
      evidenceRefs: ["review-finding:SPEC-40-RESTART"],
    });
    expect(repair.kind).toBe("implementation");
    await executor.processOne(fence, new AbortController().signal);
    await executor.processOne(fence, new AbortController().signal);
    const firstAccepted = executor.snapshot(value.jobId);
    expect(firstAccepted.activeSlice?.state).toBe("accepted");
    const firstReview = [...firstAccepted.attempts].reverse().find((attempt) => attempt.kind === "review")!;
    expect(firstReview.stepContract).toMatchObject({
      skillId: "code-review",
      freshContext: true,
      codeWriting: false,
    });
    expect(firstReview.profile.assignments.map(({ capabilityId }) => capabilityId)).toEqual([
      "clean-code-guard",
      "code-review",
      "test-guard",
    ]);
    value.close(value.ticketIds[0], firstReview.id);
    executor.markTicketResolved({ jobId: value.jobId, ticketArtifactId: value.ticketIds[0] });

    const secondClaimId = value.claim(value.ticketIds[1]);
    executor.beginClaimedTicket({
      jobId: value.jobId,
      ticketArtifactId: value.ticketIds[1],
      claimId: secondClaimId,
      taskEvidence: ["behavioral-change"],
      evidenceRefs: ["ticket:40:second-claim"],
    });
    await executor.processOne(fence, new AbortController().signal);
    await executor.processOne(fence, new AbortController().signal);
    await executor.processOne(fence, new AbortController().signal);
    const secondAccepted = executor.snapshot(value.jobId);
    const secondReview = [...secondAccepted.attempts].reverse().find((attempt) =>
      attempt.kind === "review" && attempt.workOrder.ticket.artifactId === value.ticketIds[1])!;
    value.close(value.ticketIds[1], secondReview.id);
    executor.markTicketResolved({ jobId: value.jobId, ticketArtifactId: value.ticketIds[1] });

    const pullRequestInput = {
      jobId: value.jobId,
      title: "Run navigator tickets in one restart-safe integration lane",
      body: "Implements both accepted tickets from specification #35 with exact-head verification and review evidence.",
    } as const;
    await expect(executor.publishPullRequest(pullRequestInput)).rejects.toThrow("publisher stopped");
    executor = newExecutor();
    const pullRequest = await executor.publishPullRequest(pullRequestInput);
    expect(pullRequest).toMatchObject({ number: 40, headSha: SHA.ticketTwo });
    expect(pullRequests.createOrRefresh).toHaveBeenCalledTimes(2);
    expect(executor.snapshot(value.jobId)).toMatchObject({
      integration: {
        state: "ready_for_release",
        currentHeadSha: SHA.ticketTwo,
        pullRequestNumber: 40,
      },
      tickets: [
        expect.objectContaining({ artifactId: value.ticketIds[0], state: "resolved" }),
        expect.objectContaining({ artifactId: value.ticketIds[1], state: "resolved" }),
      ],
    });
    const resources = executor.snapshot(value.jobId).attempts.map((attempt) => attempt.resource?.id);
    expect(new Set(resources).size).toBe(resources.length);
    expect(executor.snapshot(value.jobId).outcomes).toContainEqual(expect.objectContaining({
      outcome: "worker_unavailable",
      reasonCode: "worker_missing",
    }));
  });

  it("invalidates a running ticket when its specification snapshot changes", async () => {
    const value = fixture();
    const workerRunner: NavigatorTicketWorkerRunner = {
      run: vi.fn(async (attempt, hooks) => {
        const resource = { kind: "bb_thread" as const, id: `thr_${attempt.id}` };
        await hooks.bindResource(resource);
        const specification = value.store.getWorkArtifact(value.specificationId)!;
        const snapshot = value.store.getCurrentWorkArtifactSnapshot(value.specificationId)!;
        value.store.observeWorkArtifact({
          artifactId: value.specificationId,
          expectedExternalRevision: specification.externalRevision,
          externalRevision: "35:material-edit",
          externalStatus: "open",
          assignees: [],
          title: snapshot.title,
          content: `${snapshot.content}\n\nMaterially changed requirement.`,
          acceptanceCriteria: snapshot.acceptanceCriteria,
          relationships: snapshot.relationships,
          observedAt: value.now(),
        });
        return { resource, result: implementationResult(attempt, SHA.ticketOne) };
      }),
    };
    const executor = new NavigatorImplementationExecutor({
      store: value.store,
      database: value.database,
      workerRunner,
      pullRequests: { createOrRefresh: vi.fn() },
      modelRoute: () => ({ pool: "standard", ...DEFAULT_MODEL_POOL_REGISTRY.worker.standard }),
      clock: { now: value.now },
    });
    executor.startIntegration({
      jobId: value.jobId,
      specificationArtifactId: value.specificationId,
      implementationTicketIds: value.ticketIds,
      baseBranch: "main",
      integrationBranch: "hanoon/job-40",
      worktreeId: "env_job_40",
      baseHeadSha: SHA.base,
      evidenceRefs: ["ticket:40"],
    });
    executor.beginClaimedTicket({
      jobId: value.jobId,
      ticketArtifactId: value.ticketIds[0],
      claimId: value.claim(value.ticketIds[0]),
      taskEvidence: ["behavioral-change"],
      evidenceRefs: ["ticket:40:claim"],
    });
    await executor.processOne(
      { ownerId: "executor-40", generation: 1, signal: new AbortController().signal },
      new AbortController().signal,
    );

    expect(executor.snapshot(value.jobId)).toMatchObject({
      integration: { state: "invalidated", currentHeadSha: SHA.base },
      activeSlice: { state: "invalidated" },
      outcomes: [expect.objectContaining({ outcome: "policy_failure", reasonCode: "stale_specification" })],
    });
  });
});
