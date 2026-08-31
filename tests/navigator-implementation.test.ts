import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_POOL_REGISTRY } from "../src/capabilities/models";
import {
  navigatorAcceptanceCriteria,
  navigatorAcceptanceCriteriaAreSatisfied,
  navigatorCodeReviewResultSchema,
  navigatorJsonDigest,
  navigatorPersistedTicketStepContractSchema,
} from "../src/navigator/implementation-contracts";
import {
  NavigatorImplementationExecutor,
  NavigatorTicketWorkerRetryableError,
  NavigatorTicketWorkerUnavailableError,
  navigatorFindingDisposition,
  type NavigatorTicketWorkerAttempt,
  type NavigatorGitObserver,
  type NavigatorTicketWorkerRunner,
} from "../src/navigator/implementation-executor";
import {
  createNavigatorCompatibilityAdapter,
  NavigatorEffectProtocol,
} from "../src/navigator/effect-protocol";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import {
  ALL_MIGRATIONS,
  NAVIGATOR_IMPLEMENTATION_MIGRATIONS,
  NAVIGATOR_IMPLEMENTATION_UPGRADE_MIGRATIONS,
} from "../src/storage/migrations";
import {
  registerWorkArtifactRelationshipValidation,
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
  advance(milliseconds: number): void;
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

function fixture(
  migrationCount: number = ALL_MIGRATIONS.length,
  beforeOpen?: (database: Database.Database) => void,
): Fixture {
  fixtureSequence += 1;
  const { bb } = createFakePluginHost({ pluginId: `navigator-implementation-${fixtureSequence}` });
  if (migrationCount !== ALL_MIGRATIONS.length) {
    registerWorkArtifactRelationshipValidation(bb.storage.database());
    bb.storage.migrate(bb.storage.database(), [...ALL_MIGRATIONS].slice(0, migrationCount));
  }
  beforeOpen?.(bb.storage.database());
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
    advance: (milliseconds) => {
      currentTime += milliseconds;
    },
    claim,
    close,
  };
}

function implementationResult(
  attempt: NavigatorTicketWorkerAttempt,
  headSha: string,
  store: TelegramAgentStore,
) {
  const ticket = store.getWorkArtifactSnapshot(attempt.workOrder.ticket.snapshotId)!;
  return {
    kind: "implementation_result" as const,
    baseHeadSha: attempt.workOrder.baseHeadSha,
    headSha,
    summary: `Implemented ${attempt.workOrder.ticket.artifactId}.`,
    changedPaths: ["src/navigator/implementation-executor.ts", "tests/navigator-implementation.test.ts"],
    focusedVerification: [{ command: "npm test -- navigator-implementation", outcome: "passed" as const }],
    fullVerification: [{ command: "npm run check", outcome: "passed" as const }],
    acceptanceCriteria: navigatorAcceptanceCriteria(ticket).map(({ id }) => ({
      criterionId: id,
      outcome: "passed" as const,
      evidenceRefs: [`acceptance:${id}`],
    })),
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
  const findings = outcome === "findings"
    ? attempt.workOrder.verificationOf?.findings ?? [{
      rootCauseId: "restart-durability",
      capabilityId: "code-review",
      ruleId: "SPEC-40-RESTART",
      severity: "high" as const,
      subject: "src/navigator/implementation-executor.ts",
      line: 1,
      requirementId: "SPEC-40-RESTART",
      summary: "The interrupted worker path is not yet durable.",
      evidenceRefs: [`head:${attempt.workOrder.baseHeadSha}`],
    }]
    : [];
  return {
    kind: "code_review_result" as const,
    reviewedHeadSha: attempt.workOrder.baseHeadSha,
    outcome,
    summary: outcome === "passed" ? "The exact head passes review." : "One exact-head finding needs repair.",
    axes: {
      requirements: { outcome, evidenceRefs: [`requirements:${attempt.id}`] },
      standards: { outcome: "passed" as const, evidenceRefs: [`standards:${attempt.id}`] },
    },
    findings,
    capabilityOutcomes: attempt.profile.assignments.map(({ capabilityId }) => ({
      capabilityId,
      outcome: outcome === "findings" ? "findings" as const : "passed" as const,
      evidenceRefs: [`worker:${attempt.id}:${capabilityId}`],
    })),
  };
}

function validGitObserver(): NavigatorGitObserver {
  return {
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
  };
}

describe("navigator ticket integration executor", () => {
  it("classifies findings from the trusted capability registry, not reviewer-supplied severity", () => {
    const finding = {
      rootCauseId: "spoofed-priority",
      capabilityId: "clean-code-guard",
      ruleId: "clean.rule-10",
      severity: "critical" as const,
      subject: "src/app.ts",
      line: 1,
      requirementId: "SPOOFED-REQUIREMENT",
      summary: "A reviewer tried to promote an advisory finding.",
      evidenceRefs: ["review:spoofed"],
    };

    expect(navigatorFindingDisposition(finding)).toBe("advisory");
    expect(navigatorFindingDisposition({
      ...finding,
      capabilityId: "code-review",
      ruleId: "requirement.behavior",
      severity: "low",
      requirementId: null,
    })).toBe("must_fix");
  });

  it("requires every stable acceptance criterion and both review axes", () => {
    const value = fixture();
    const ticket = value.store.getCurrentWorkArtifactSnapshot(value.ticketIds[0])!;
    const criteria = navigatorAcceptanceCriteria(ticket);
    expect(navigatorAcceptanceCriteriaAreSatisfied(ticket, criteria.map(({ id }) => ({
      criterionId: id,
      outcome: "passed" as const,
    })))).toBe(true);
    expect(navigatorAcceptanceCriteriaAreSatisfied(ticket, [])).toBe(false);
    expect(navigatorAcceptanceCriteriaAreSatisfied(ticket, criteria.map(({ id }) => ({
      criterionId: id,
      outcome: "blocked" as const,
    })))).toBe(false);

    expect(navigatorCodeReviewResultSchema.safeParse({
      kind: "code_review_result",
      reviewedHeadSha: SHA.ticketOne,
      outcome: "passed",
      summary: "Standards pass without a requirements review.",
      findings: [],
      capabilityOutcomes: [{ capabilityId: "code-review", outcome: "passed", evidenceRefs: ["review:standards"] }],
    }).success).toBe(false);
  });

  it("appends the navigator persistence upgrade after the shipped implementation migration", () => {
    const implementationMigrationId = ALL_MIGRATIONS.indexOf(NAVIGATOR_IMPLEMENTATION_MIGRATIONS[0]);
    const upgradeMigrationId = ALL_MIGRATIONS.indexOf(NAVIGATOR_IMPLEMENTATION_UPGRADE_MIGRATIONS[0]);
    expect(implementationMigrationId).toBeGreaterThanOrEqual(0);
    expect(upgradeMigrationId).toBe(implementationMigrationId + 1);
    expect(ALL_MIGRATIONS[implementationMigrationId]).not.toContain("step_contract_json");
    expect(ALL_MIGRATIONS[implementationMigrationId]).not.toContain("navigator_ticket_repair_snapshots");
    expect(ALL_MIGRATIONS[implementationMigrationId]).not.toContain("git_observation_json");
    expect(ALL_MIGRATIONS[upgradeMigrationId]).toContain("step_contract_json");
    expect(ALL_MIGRATIONS[upgradeMigrationId]).toContain("navigator_ticket_repair_snapshots");
    expect(ALL_MIGRATIONS[upgradeMigrationId]).toContain("git_observation_json");
  });

  it("backfills an existing v1 navigator attempt before enabling repair and Git evidence", () => {
    const legacyEffect = "legacy-navigator-effect";
    const legacyAttempt = "legacy-navigator-attempt";
    const upgradeMigrationId = ALL_MIGRATIONS.indexOf(NAVIGATOR_IMPLEMENTATION_UPGRADE_MIGRATIONS[0]);
    const value = fixture(upgradeMigrationId, (database) => {
      database.pragma("foreign_keys = OFF");
      database.prepare(
        `INSERT INTO effects (
           idempotency_key, job_id, kind, payload_json, status, attempts,
           next_attempt_at, created_at, updated_at
         ) VALUES (?, 'legacy-job', 'run_navigator_ticket_worker', ?, 'done', 1, 1000, 1000, 1000)`,
      ).run(legacyEffect, JSON.stringify({ attemptId: legacyAttempt }));
      database.prepare(
        `INSERT INTO navigator_ticket_slices (
           id, job_id, ticket_artifact_id, ticket_snapshot_id, ticket_snapshot_digest,
           claim_id, integration_base_head_sha, state, accepted_head_sha, created_at, updated_at
         ) VALUES ('legacy-slice', 'legacy-job', 'legacy-ticket', 'legacy-snapshot', ?, 1, ?, 'invalidated', NULL, 1000, 1000)`,
      ).run("a".repeat(64), SHA.base);
      database.prepare(
        `INSERT INTO navigator_ticket_worker_attempts (
           id, job_id, slice_id, kind, ordinal, effect_idempotency_key,
           work_order_json, work_order_digest, step_contract_id, step_contract_revision,
           step_contract_digest, profile_json, profile_digest, model_route_json,
           resource_kind, resource_id, created_at, updated_at
         ) VALUES (?, 'legacy-job', 'legacy-slice', 'implementation', 1, ?, '{}', ?,
           'navigator-ticket-implementation', 1,
           'c3d183d0b7c961ad1cbc223aa38a025f6ec8b52496e40137ce5e7bd6ae77f851',
           '{}', ?, '{}', NULL, NULL, 1000, 1000)`,
      ).run(legacyAttempt, legacyEffect, navigatorJsonDigest({}), navigatorJsonDigest({}));
      database.prepare(
        `INSERT INTO navigator_ticket_worker_outcomes (
           attempt_id, slice_id, outcome, reason_code, exact_head_sha,
           result_json, result_digest, recorded_at
         ) VALUES (?, 'legacy-slice', 'worker_unavailable', 'worker_missing', ?, '{}', ?, 1000)`,
      ).run(legacyAttempt, SHA.base, navigatorJsonDigest({}));
      database.pragma("foreign_keys = ON");
    });

    const attempt = value.database.prepare(
      "SELECT step_contract_json FROM navigator_ticket_worker_attempts WHERE id = ?",
    ).get(legacyAttempt) as { step_contract_json: string };
    const contract = navigatorPersistedTicketStepContractSchema.parse(JSON.parse(attempt.step_contract_json));
    expect(contract).toMatchObject({
      id: "navigator-ticket-implementation",
      revision: 1,
      maximumResultBytes: 256_000,
    });
    expect(value.database.prepare(
      "SELECT outcome, git_observation_json, git_observation_digest FROM navigator_ticket_worker_outcomes WHERE attempt_id = ?",
    ).get(legacyAttempt)).toEqual({
      outcome: "worker_unavailable",
      git_observation_json: null,
      git_observation_digest: null,
    });
    expect(value.database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)",
    ).all(
      "navigator_ticket_repair_snapshots",
      "navigator_ticket_repair_proposals",
      "navigator_ticket_repair_dispatches",
    )).toHaveLength(3);
  });

  it("rejects worker-reported Git evidence that disagrees with the executor observation", async () => {
    const value = fixture();
    const workerRunner: NavigatorTicketWorkerRunner = {
      run: vi.fn(async (attempt, hooks) => {
        const resource = { kind: "bb_thread" as const, id: `thr_${attempt.id}` };
        await hooks.bindResource(resource);
        return { resource, result: implementationResult(attempt, SHA.ticketOne, value.store) };
      }),
      reconcileUnavailableResource: vi.fn(),
    };
    const gitObserver = validGitObserver();
    vi.mocked(gitObserver.observe).mockResolvedValueOnce({
      kind: "navigator_git_observation",
      worktreeId: "env_job_40",
      branch: "hanoon/job-40",
      headSha: SHA.repair,
      baseHeadSha: SHA.base,
      baseHeadIsAncestor: true,
      comparisonBaseHeadSha: SHA.base,
      comparisonBaseHeadIsAncestor: true,
      clean: true,
      changedPaths: ["src/navigator/implementation-executor.ts"],
      evidenceRef: "git-observation:forged-worker-result",
      observedAt: 2_000,
    });
    const executor = new NavigatorImplementationExecutor({
      store: value.store,
      database: value.database,
      workerRunner,
      gitObserver,
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
      ownerId: "executor-40",
      generation: 1,
    });
    value.database.prepare(
      `INSERT INTO job_resource_claims (
         job_id, resource_key, resource_kind, state, owner_id, generation,
         lease_expires_at, acquired_at, renewed_at, released_at, release_reason
       ) VALUES (?, 'project:proj_40:pipeline', 'project', 'held', ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(value.jobId, "executor-40", 1, 101_100, 1_100, 1_100);
    const protocol = new NavigatorEffectProtocol({
      store: value.store,
      clock: { now: value.now },
      adapters: [
        {
          kind: "run_navigator_skill",
          execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused in this test" })),
        },
        createNavigatorCompatibilityAdapter(
          "run_navigator_ticket_worker",
          (effect, fence, signal) => executor.processLeased(effect, fence, signal),
        ),
        {
          kind: "run_navigator_release",
          execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused in this test" })),
        },
      ],
    });
    await protocol.processOne(
      { ownerId: "executor-40", generation: 1, signal: new AbortController().signal },
      new AbortController().signal,
    );
    expect(executor.snapshot(value.jobId)).toMatchObject({
      integration: { state: "invalidated", currentHeadSha: SHA.base },
      outcomes: [expect.objectContaining({
        outcome: "policy_failure",
        reasonCode: "git_observation_rejected",
      })],
    });
  });

  it("does not call a worker when the persisted ticket attempt context is stale", async () => {
    const value = fixture();
    const worker = vi.fn(async () => ({ outcome: "permanent" as const, reason: "not called" }));
    const executor = new NavigatorImplementationExecutor({
      store: value.store,
      database: value.database,
      workerRunner: { run: vi.fn(), reconcileUnavailableResource: vi.fn() },
      gitObserver: validGitObserver(),
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
    const slice = executor.beginClaimedTicket({
      jobId: value.jobId,
      ticketArtifactId: value.ticketIds[0],
      claimId: value.claim(value.ticketIds[0]),
      taskEvidence: ["behavioral-change"],
      evidenceRefs: ["ticket:40:claim"],
      ownerId: "executor-40",
      generation: 1,
    });
    value.database.prepare(
      `INSERT INTO job_resource_claims (
         job_id, resource_key, resource_kind, state, owner_id, generation,
         lease_expires_at, acquired_at, renewed_at, released_at, release_reason
       ) VALUES (?, 'project:proj_40:pipeline', 'project', 'held', ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(value.jobId, "executor-40", 1, 101_100, 1_100, 1_100);
    value.database.prepare("UPDATE navigator_ticket_slices SET state = 'invalidated' WHERE id = ?")
      .run(slice.id);
    const effect = value.store.listEffectsForJob(value.jobId).find((candidate) =>
      candidate.kind === "run_navigator_ticket_worker");
    if (!effect) throw new Error("navigator ticket worker effect was not stored");

    const protocol = new NavigatorEffectProtocol({
      store: value.store,
      clock: { now: value.now },
      adapters: [
        {
          kind: "run_navigator_skill",
          execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })),
        },
        {
          kind: "run_navigator_ticket_worker",
          execute: worker,
        },
        {
          kind: "run_navigator_release",
          execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })),
        },
      ],
    });

    await expect(protocol.processOne(
      { ownerId: "executor-40", generation: 1, signal: new AbortController().signal },
      new AbortController().signal,
    )).resolves.toBe(true);

    expect(worker).not.toHaveBeenCalled();
    expect(value.store.getEffect(value.jobId, effect.idempotencyKey)).toMatchObject({ status: "dead" });
  });

  it("rejects a successful implementation that did not advance beyond its base head", async () => {
    const value = fixture();
    const workerRunner: NavigatorTicketWorkerRunner = {
      run: vi.fn(async (attempt, hooks) => {
        const resource = { kind: "bb_thread" as const, id: `thr_${attempt.id}` };
        await hooks.bindResource(resource);
        return { resource, result: implementationResult(attempt, attempt.workOrder.baseHeadSha, value.store) };
      }),
      reconcileUnavailableResource: vi.fn(),
    };
    const executor = new NavigatorImplementationExecutor({
      store: value.store,
      database: value.database,
      workerRunner,
      gitObserver: validGitObserver(),
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
      ownerId: "executor-40",
      generation: 1,
    });

    await executor.processOne(
      { ownerId: "executor-40", generation: 1, signal: new AbortController().signal },
      new AbortController().signal,
    );
    await executor.processOne(
      { ownerId: "executor-40", generation: 1, signal: new AbortController().signal },
      new AbortController().signal,
    );

    expect(executor.snapshot(value.jobId)).toMatchObject({
      integration: { state: "invalidated", currentHeadSha: SHA.base },
      outcomes: [expect.objectContaining({
        outcome: "policy_failure",
        reasonCode: "implementation_head_not_advanced",
      })],
    });
  });

  it("reads a durable attempt from its immutable contract payload after the registry revision changes", () => {
    const value = fixture();
    const executor = new NavigatorImplementationExecutor({
      store: value.store,
      database: value.database,
      workerRunner: { run: vi.fn(), reconcileUnavailableResource: vi.fn() },
      gitObserver: validGitObserver(),
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
      ownerId: "executor-40",
      generation: 1,
    });
    const current = executor.snapshot(value.jobId).attempts[0]!;
    const unsignedHistorical = { ...current.stepContract, revision: 99, digest: undefined };
    delete unsignedHistorical.digest;
    const historical = { ...unsignedHistorical, digest: navigatorJsonDigest(unsignedHistorical) };
    const historicalId = `${current.id}_historical`;
    const historicalEffect = `${current.effectIdempotencyKey}:historical`;
    value.database.prepare(
      `INSERT INTO effects (
         idempotency_key, job_id, kind, payload_json, status, attempts,
         next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, 'run_navigator_ticket_worker', ?, 'done', 0, ?, ?, ?)`,
    ).run(historicalEffect, value.jobId, JSON.stringify({ attemptId: historicalId }), value.now(), value.now(), value.now());
    value.database.prepare(
      `INSERT INTO navigator_ticket_worker_attempts (
         id, job_id, slice_id, kind, ordinal, effect_idempotency_key,
         work_order_json, work_order_digest, step_contract_id, step_contract_revision,
         step_contract_digest, step_contract_json, profile_json, profile_digest,
         model_route_json, resource_kind, resource_id, created_at, updated_at
       ) SELECT ?, job_id, slice_id, kind, 99, ?, work_order_json, work_order_digest,
                ?, ?, ?, ?, profile_json, profile_digest, model_route_json,
                NULL, NULL, ?, ?
           FROM navigator_ticket_worker_attempts WHERE id = ?`,
    ).run(
      historicalId,
      historicalEffect,
      historical.id,
      historical.revision,
      historical.digest,
      JSON.stringify(historical),
      value.now(),
      value.now(),
      current.id,
    );

    expect(executor.snapshot(value.jobId).attempts.at(-1)?.stepContract).toEqual(historical);
  });

  it("backs off retryable worker failures and dead-letters after the contract ceiling", async () => {
    const value = fixture();
    const workerRunner: NavigatorTicketWorkerRunner = {
      run: vi.fn(async () => {
        throw new NavigatorTicketWorkerRetryableError("BB provider unavailable");
      }),
      reconcileUnavailableResource: vi.fn(),
    };
    const executor = new NavigatorImplementationExecutor({
      store: value.store,
      database: value.database,
      workerRunner,
      gitObserver: validGitObserver(),
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
      ownerId: "executor-40",
      generation: 1,
    });
    const fence = { ownerId: "executor-40", generation: 1, signal: new AbortController().signal };

    await executor.processOne(fence, new AbortController().signal);
    expect(await executor.processOne(fence, new AbortController().signal)).toBe(false);
    const contract = executor.snapshot(value.jobId).attempts[0]!.stepContract;
    expect(contract).toMatchObject({
      retryClass: "bounded_exponential",
      maximumAttempts: 5,
      backoffBaseMs: 500,
      backoffMaximumMs: 30_000,
    });
    const maximumAttempts = "maximumAttempts" in contract ? contract.maximumAttempts : 0;
    const backoffBaseMs = "backoffBaseMs" in contract ? contract.backoffBaseMs : 0;
    const backoffMaximumMs = "backoffMaximumMs" in contract ? contract.backoffMaximumMs : 0;
    for (let attempt = 2; attempt <= maximumAttempts; attempt += 1) {
      value.advance(Math.min(backoffMaximumMs, backoffBaseMs * 2 ** (attempt - 2)));
      await executor.processOne(fence, new AbortController().signal);
    }

    expect(workerRunner.run).toHaveBeenCalledTimes(maximumAttempts);
    const exhausted = executor.snapshot(value.jobId);
    expect(exhausted.integration.state).toBe("invalidated");
    expect(exhausted.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: "dead_letter", reasonCode: "retry_exhausted" }),
    ]));
  });

  it("preserves retry attempts and backoff across repeated unavailable worker replacements", async () => {
    const value = fixture();
    const workerRunner: NavigatorTicketWorkerRunner = {
      run: vi.fn(async (attempt, hooks) => {
        await hooks.bindResource({ kind: "bb_thread", id: `thr_${attempt.id}` });
        throw new NavigatorTicketWorkerUnavailableError("missing");
      }),
      reconcileUnavailableResource: vi.fn(async (resource) => ({
        resource,
        state: "missing" as const,
        evidenceRef: `reconciled:${resource.id}`,
        observedAt: value.now(),
      })),
    };
    const executor = new NavigatorImplementationExecutor({
      store: value.store,
      database: value.database,
      workerRunner,
      gitObserver: validGitObserver(),
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
      ownerId: "executor-40",
      generation: 1,
    });
    const fence = { ownerId: "executor-40", generation: 1, signal: new AbortController().signal };
    const contract = executor.snapshot(value.jobId).attempts[0]!.stepContract;
    const maximumAttempts = "maximumAttempts" in contract ? contract.maximumAttempts : 0;
    const backoffBaseMs = "backoffBaseMs" in contract ? contract.backoffBaseMs : 0;
    const backoffMaximumMs = "backoffMaximumMs" in contract ? contract.backoffMaximumMs : 0;

    for (let attemptNumber = 1; attemptNumber <= maximumAttempts; attemptNumber += 1) {
      await executor.processOne(fence, new AbortController().signal);
      const current = executor.snapshot(value.jobId);
      if (attemptNumber < maximumAttempts) {
        const replacement = current.attempts.at(-1)!;
        expect(value.database.prepare(
          "SELECT attempts, next_attempt_at FROM effects WHERE idempotency_key = ?",
        ).get(replacement.effectIdempotencyKey)).toMatchObject({
          attempts: attemptNumber,
          next_attempt_at: expect.any(Number),
        });
        expect(await executor.processOne(fence, new AbortController().signal)).toBe(false);
        value.advance(Math.min(
          backoffMaximumMs,
          backoffBaseMs * 2 ** (attemptNumber - 1),
        ));
      }
    }

    expect(workerRunner.run).toHaveBeenCalledTimes(maximumAttempts);
    const exhausted = executor.snapshot(value.jobId);
    expect(exhausted.integration.state).toBe("invalidated");
    expect(exhausted.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: "dead_letter", reasonCode: "retry_exhausted" }),
    ]));
  });

  it("adopts the ticket claim and rejects settlement after its executor fence changes", async () => {
    const value = fixture();
    const claimId = value.claim(value.ticketIds[0]);
    value.database.prepare(
      "UPDATE work_artifact_claims SET owner_id = 'retired-executor', generation = 99, lease_expires_at = 0 WHERE id = ?",
    ).run(claimId);
    const workerRunner: NavigatorTicketWorkerRunner = {
      run: vi.fn(async (attempt, hooks) => {
        const resource = { kind: "bb_thread" as const, id: `thr_${attempt.id}` };
        await hooks.bindResource(resource);
        value.database.prepare(
          "UPDATE work_artifact_claims SET owner_id = 'stolen-executor', generation = 100 WHERE id = ?",
        ).run(claimId);
        return { resource, result: implementationResult(attempt, SHA.ticketOne, value.store) };
      }),
      reconcileUnavailableResource: vi.fn(),
    };
    const executor = new NavigatorImplementationExecutor({
      store: value.store,
      database: value.database,
      workerRunner,
      gitObserver: validGitObserver(),
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
    const claimInput = {
      jobId: value.jobId,
      ticketArtifactId: value.ticketIds[0],
      claimId,
      taskEvidence: ["behavioral-change"] as const,
      evidenceRefs: ["ticket:40:claim"],
      ownerId: "executor-40",
      generation: 1,
    };
    executor.beginClaimedTicket(claimInput);

    expect(value.store.getWorkArtifactClaim(claimId)).toMatchObject({
      ownerId: "executor-40",
      generation: 1,
    });
    await executor.processOne(
      { ownerId: "executor-40", generation: 1, signal: new AbortController().signal },
      new AbortController().signal,
    );

    expect(executor.snapshot(value.jobId)).toMatchObject({
      integration: { state: "invalidated", currentHeadSha: SHA.base },
      outcomes: [expect.objectContaining({ outcome: "policy_failure", reasonCode: "claim_fence_lost" })],
    });
  });

  it("sequentially integrates fresh ticket workers, repairs review findings, and publishes one pull request", async () => {
    const value = fixture();
    let firstAttemptInterrupted = true;
    let secondAttemptMissing = true;
    const resourceEvents: string[] = [];
    const workerRunner: NavigatorTicketWorkerRunner = {
      run: vi.fn(async (attempt, hooks) => {
        const resource = attempt.resource ?? { kind: "bb_thread" as const, id: `thr_${attempt.id}` };
        resourceEvents.push(`run:${resource.id}`);
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
          return { resource, result: implementationResult(attempt, head, value.store) };
        }
        const needsRepair = attempt.workOrder.verificationOf !== undefined ||
          (attempt.workOrder.ticket.artifactId === value.ticketIds[0] && attempt.ordinal === 1);
        return { resource, result: reviewResult(attempt, needsRepair ? "findings" : "passed") };
      }),
      reconcileUnavailableResource: vi.fn(async (resource, reason) => {
        resourceEvents.push(`reconcile:${resource.id}`);
        return {
          resource,
          state: reason === "missing" ? "missing" as const : "terminal" as const,
          evidenceRef: `bb-resource:${resource.id}:${reason}`,
          observedAt: value.now(),
        };
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
      gitObserver: validGitObserver(),
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
      ownerId: "executor-40",
      generation: 1,
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
    value.advance(500);
    await executor.processOne(fence, new AbortController().signal);
    await executor.processOne(fence, new AbortController().signal);
    await executor.processOne(fence, new AbortController().signal);
    const confirmedFinding = executor.snapshot(value.jobId);
    expect(confirmedFinding.activeSlice?.state).toBe("repair_pending");
    expect(confirmedFinding.findingLedger).toEqual([
      expect.objectContaining({
        rootCauseId: "restart-durability",
        disposition: "must_fix",
        state: "open",
        occurrence: 1,
        blockingBurden: 1,
      }),
    ]);
    const repairSnapshot = executor.prepareRepairNavigation({
      jobId: value.jobId,
      ticketArtifactId: value.ticketIds[0],
      evidenceRefs: ["review-finding:SPEC-40-RESTART"],
    });
    expect(repairSnapshot).toMatchObject({
      reviewedHeadSha: SHA.ticketOne,
      findings: [expect.objectContaining({ ruleId: "SPEC-40-RESTART" })],
    });
    const repairDecision = executor.recordRepairProposal({
      snapshotId: repairSnapshot.snapshotId,
      rawProposal: {
        kind: "implementation",
        basedOn: { snapshotId: repairSnapshot.snapshotId, digest: repairSnapshot.digest },
        objective: "Repair the exact-head restart finding.",
        taskEvidence: ["behavioral-change"],
        evidenceRefs: ["review-finding:SPEC-40-RESTART"],
      },
    });
    expect(repairDecision).toMatchObject({ decision: "accepted", route: "implementation" });
    const repair = executor.scheduleRepair({
      jobId: value.jobId,
      ticketArtifactId: value.ticketIds[0],
      proposalId: repairDecision.proposalId,
    });
    expect(repair.kind).toBe("implementation");
    await executor.processOne(fence, new AbortController().signal);
    await executor.processOne(fence, new AbortController().signal);
    const firstAccepted = executor.snapshot(value.jobId);
    expect(firstAccepted.activeSlice?.state).toBe("accepted");
    expect(firstAccepted.findingLedger).toEqual([
      expect.objectContaining({
        rootCauseId: "restart-durability",
        disposition: "must_fix",
        state: "resolved",
        occurrence: 1,
        blockingBurden: 0,
      }),
    ]);
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
      ownerId: "executor-40",
      generation: 1,
    });
    await executor.processOne(fence, new AbortController().signal);
    value.advance(500);
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
    expect(pullRequests.createOrRefresh.mock.calls.at(-1)?.[0]).toMatchObject({
      headSha: SHA.ticketTwo,
      gitObservation: {
        branch: "hanoon/job-40",
        headSha: SHA.ticketTwo,
        baseHeadIsAncestor: true,
        clean: true,
      },
      gitObservationDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      evidenceRefs: expect.arrayContaining([
        `git-observation:${SHA.ticketOne}:implementation`,
        `git-observation:${SHA.repair}:review`,
        `git-observation:${SHA.ticketTwo}:review`,
        `git-observation:${SHA.ticketTwo}:pull_request`,
      ]),
    });
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
    const unavailableAttempts = executor.snapshot(value.jobId).attempts.filter((attempt) =>
      attempt.workOrder.ticket.artifactId === value.ticketIds[1] && attempt.kind === "implementation");
    expect(resourceEvents.indexOf(`reconcile:${unavailableAttempts[0]!.resource!.id}`)).toBeLessThan(
      resourceEvents.indexOf(`run:${unavailableAttempts[1]!.resource!.id}`),
    );
  });

  it("blocks the third confirmed recurrence of one root cause", async () => {
    const value = fixture();
    const workerRunner: NavigatorTicketWorkerRunner = {
      run: vi.fn(async (attempt, hooks) => {
        const resource = attempt.resource ?? { kind: "bb_thread" as const, id: `thr_${attempt.id}` };
        await hooks.bindResource(resource);
        if (attempt.kind === "implementation") {
          return {
            resource,
            result: implementationResult(attempt, String(attempt.ordinal + 1).repeat(40), value.store),
          };
        }
        return { resource, result: reviewResult(attempt, "findings") };
      }),
      reconcileUnavailableResource: vi.fn(),
    };
    const executor = new NavigatorImplementationExecutor({
      store: value.store,
      database: value.database,
      workerRunner,
      gitObserver: validGitObserver(),
      pullRequests: { createOrRefresh: vi.fn() },
      modelRoute: (kind) => kind === "implementation"
        ? ({ pool: "standard", ...DEFAULT_MODEL_POOL_REGISTRY.worker.standard })
        : ({ pool: "strong", ...DEFAULT_MODEL_POOL_REGISTRY.worker.strong }),
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
      evidenceRefs: ["ticket:40:recurrence"],
    });
    executor.beginClaimedTicket({
      jobId: value.jobId,
      ticketArtifactId: value.ticketIds[0],
      claimId: value.claim(value.ticketIds[0]),
      taskEvidence: ["behavioral-change"],
      evidenceRefs: ["ticket:40:recurrence:claim"],
      ownerId: "executor-40",
      generation: 1,
    });
    const fence = { ownerId: "executor-40", generation: 1, signal: new AbortController().signal };
    for (let occurrence = 1; occurrence <= 3; occurrence += 1) {
      await executor.processOne(fence, new AbortController().signal);
      await executor.processOne(fence, new AbortController().signal);
      await executor.processOne(fence, new AbortController().signal);
      const snapshot = executor.snapshot(value.jobId);
      if (occurrence === 3) {
        expect(snapshot.integration.state).toBe("invalidated");
        expect(snapshot.findingLedger).toEqual([
          expect.objectContaining({ rootCauseId: "restart-durability", occurrence: 3, state: "open" }),
        ]);
        expect(snapshot.outcomes.at(-1)).toMatchObject({
          outcome: "policy_failure",
          reasonCode: "finding_recurrence_limit",
        });
        break;
      }
      expect(snapshot.activeSlice?.state).toBe("repair_pending");
      const repairSnapshot = executor.prepareRepairNavigation({
        jobId: value.jobId,
        ticketArtifactId: value.ticketIds[0],
        evidenceRefs: [`review-finding:recurrence:${String(occurrence)}`],
      });
      const repairDecision = executor.recordRepairProposal({
        snapshotId: repairSnapshot.snapshotId,
        rawProposal: {
          kind: "implementation",
          basedOn: { snapshotId: repairSnapshot.snapshotId, digest: repairSnapshot.digest },
          objective: "Repair the recurring root cause.",
          taskEvidence: ["behavioral-change"],
          evidenceRefs: [`review-finding:recurrence:${String(occurrence)}`],
        },
      });
      executor.scheduleRepair({
        jobId: value.jobId,
        ticketArtifactId: value.ticketIds[0],
        proposalId: repairDecision.proposalId,
      });
    }
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
        return { resource, result: implementationResult(attempt, SHA.ticketOne, value.store) };
      }),
      reconcileUnavailableResource: vi.fn(),
    };
    const executor = new NavigatorImplementationExecutor({
      store: value.store,
      database: value.database,
      workerRunner,
      gitObserver: validGitObserver(),
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
      ownerId: "executor-40",
      generation: 1,
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
