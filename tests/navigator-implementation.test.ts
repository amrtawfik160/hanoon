import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_POOL_REGISTRY } from "../src/capabilities/models";
import { SKILL_ADMISSION_CATALOG } from "../src/capabilities/catalog";
import {
  assessGuardEnvelope,
  guardRequirementBindings,
  type GuardAssessmentPolicy,
} from "../src/capabilities/guards";
import {
  navigatorAcceptanceCriteria,
  navigatorAcceptanceCriteriaAreSatisfied,
  navigatorCodeReviewResultSchema,
  navigatorJsonDigest,
  navigatorPersistedTicketStepContractSchema,
  type NavigatorReviewFinding,
} from "../src/navigator/implementation-contracts";
import {
  NavigatorImplementationExecutor,
  navigatorFindingDisposition,
  type NavigatorTicketWorkerAttempt,
} from "../src/navigator/implementation-executor";
import {
  NavigatorFindingLedger,
  navigatorFindingFingerprint,
  type NavigatorFindingAssessmentFacts,
  type NavigatorFindingLedgerDecision,
  type NavigatorFindingLedgerPersistence,
} from "../src/navigator/finding-ledger";
import { NavigatorFindingLedgerRepository } from "../src/navigator/finding-ledger-repository";
import {
  NavigatorTicketWorkerRetryableError,
  NavigatorTicketWorkerUnavailableError,
  type NavigatorGitObserver,
  type NavigatorTicketWorkerInput,
  type NavigatorTicketWorkerOperation,
} from "../src/navigator/ticket-adapter";
import {
  NavigatorEffectProtocol,
  type NavigatorEffectContext,
  type NavigatorEffectOutcome,
} from "../src/navigator/effect-protocol";
import { createNavigatorTicketEffectAdapter } from "../src/navigator/plugin-runtime";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import {
  ALL_MIGRATIONS,
  NAVIGATOR_FINDING_LEDGER_UPGRADE_MIGRATIONS,
  NAVIGATOR_IMPLEMENTATION_MIGRATIONS,
  NAVIGATOR_IMPLEMENTATION_UPGRADE_MIGRATIONS,
} from "../src/storage/migrations";
import {
  registerWorkArtifactRelationshipValidation,
  stableWorkArtifactId,
  type CaptureWorkArtifactInput,
} from "../src/work-artifacts/repository";
import { runJobExecutorService } from "../src/services/job-executor-service";
import { policyFixture } from "./helpers";
import type { WorkArtifactSnapshot } from "../src/work-artifacts/models";

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
    const projectClaim = bb.storage.database().prepare(
      `SELECT claim_id FROM job_resource_claims
        WHERE job_id = ? AND resource_key = 'project:proj_40:pipeline'
          AND resource_kind = 'project' AND state = 'held'`,
    ).get(draft.id);
    if (!projectClaim) {
      bb.storage.database().prepare(
        `INSERT INTO job_resource_claims (
           job_id, resource_key, resource_kind, state, owner_id, generation,
           lease_expires_at, acquired_at, renewed_at, released_at, release_reason
         ) VALUES (?, 'project:proj_40:pipeline', 'project', 'held', ?, ?, ?, ?, ?, NULL, NULL)`,
      ).run(draft.id, "executor-40", lease.generation, now() + 100_000, now(), now());
    }
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

function seedPreFindingLedgerSchema(database: Database.Database): void {
  const jobId = "legacy-ledger-job";
  const sliceId = "legacy-ledger-slice";
  const specificationArtifactId = "legacy-ledger-specification";
  const specificationSnapshotId = "legacy-ledger-specification-snapshot";
  const ticketArtifactId = "legacy-ledger-ticket";
  const ticketSnapshotId = "legacy-ledger-ticket-snapshot";
  const sourceAttemptId = "legacy-ledger-source-attempt";
  const resolutionAttemptId = "legacy-ledger-resolution-attempt";
  const sourceEffectKey = "legacy-ledger-source-effect";
  const resolutionEffectKey = "legacy-ledger-resolution-effect";
  const digest = "a".repeat(64);
  const finding = {
    rootCauseId: "legacy-open-root",
    capabilityId: "code-review",
    ruleId: "code-review.legacy-rule",
    severity: "high" as const,
    subject: "src/legacy.ts",
    line: 3,
    requirementId: null,
    evidenceClass: "review",
    summary: "A legacy open finding survives the schema upgrade.",
    evidenceRefs: ["legacy:open"],
  };

  database.pragma("foreign_keys = OFF");
  database.prepare(
    `INSERT INTO jobs (id, source_update_id, request_text, state, created_at, updated_at)
     VALUES (?, ?, ?, 'merged', ?, ?)`,
  ).run(jobId, -63, "Legacy finding ledger migration fixture", 1_000, 1_000);
  const insertArtifact = database.prepare(
    `INSERT INTO work_artifacts (
       id, project_id, effort_id, operation_id, kind, initial_status, status,
       tracker_kind, tracker_namespace, external_id, external_url, external_revision,
       external_status, assignees_json, title, tracker_order, current_revision,
       current_snapshot_id, remote_closed_at, created_at, updated_at
     ) VALUES (?, 'proj_legacy', ?, ?, ?, 'ready', 'ready', 'github',
       'github:legacy/widgets', ?, NULL, '1', 'open', '[]', ?, ?, 1, ?, NULL, 1_000, 1_000)`,
  );
  insertArtifact.run(
    specificationArtifactId, jobId, "legacy-specification", "specification", "legacy-specification",
    "Legacy specification", 0, specificationSnapshotId,
  );
  insertArtifact.run(
    ticketArtifactId, jobId, "legacy-ticket", "implementation_ticket", "legacy-ticket",
    "Legacy ticket", 1, ticketSnapshotId,
  );
  const insertSnapshot = database.prepare(
    `INSERT INTO work_artifact_snapshots (
       id, artifact_id, revision, title, content, content_digest, snapshot_digest,
       acceptance_criteria_json, relationships_json, external_revision, captured_at
     ) VALUES (?, ?, 1, ?, ?, ?, ?, '[]', '[]', '1', 1_000)`,
  );
  insertSnapshot.run(
    specificationSnapshotId, specificationArtifactId, "Legacy specification", "# Legacy specification", digest, digest,
  );
  insertSnapshot.run(
    ticketSnapshotId, ticketArtifactId, "Legacy ticket", "# Legacy ticket", digest, digest,
  );
  database.prepare(
    `INSERT INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, 'run_navigator_ticket_worker', ?, 'done', 1, 1_000, 1_000, 1_000)`,
  ).run(sourceEffectKey, jobId, JSON.stringify({ attemptId: sourceAttemptId }));
  database.prepare(
    `INSERT INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, 'run_navigator_ticket_worker', ?, 'done', 1, 1_000, 1_000, 1_000)`,
  ).run(resolutionEffectKey, jobId, JSON.stringify({ attemptId: resolutionAttemptId }));
  database.prepare(
    `INSERT INTO navigator_integrations (
       job_id, specification_artifact_id, specification_snapshot_id, specification_snapshot_digest,
       base_branch, integration_branch, worktree_id, project_policy_version, project_policy_json,
       project_policy_digest, base_head_sha, current_head_sha, state, active_slice_id,
       pull_request_number, pull_request_url, evidence_refs_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'main', 'legacy/integration', 'legacy-worktree', 1, ?, ?, ?, ?,
       'implementing', ?, NULL, NULL, '[]', 1_000, 1_000)`,
  ).run(
    jobId, specificationArtifactId, specificationSnapshotId, digest,
    JSON.stringify({ projectId: "proj_legacy", maxReviewCycles: 3 }), digest, SHA.base, SHA.base, sliceId,
  );
  database.prepare(
    `INSERT INTO navigator_integration_tickets (
       job_id, artifact_id, snapshot_id, snapshot_digest, ticket_order, state,
       accepted_head_sha, resolved_at
     ) VALUES (?, ?, ?, ?, 0, 'active', NULL, NULL)`,
  ).run(jobId, ticketArtifactId, ticketSnapshotId, digest);
  database.prepare(
    `INSERT INTO work_artifact_claims (
       id, artifact_id, workflow_step_id, job_id, snapshot_id, external_assignee,
       state, owner_id, generation, lease_expires_at, acquired_at, renewed_at,
       released_at, release_reason
     ) VALUES (1, ?, 'legacy:workflow', ?, ?, 'legacy-owner', 'held',
       'legacy-owner', 1, 2_000, 1_000, 1_000, NULL, NULL)`,
  ).run(ticketArtifactId, jobId, ticketSnapshotId);
  database.prepare(
    `INSERT INTO navigator_ticket_slices (
       id, job_id, ticket_artifact_id, ticket_snapshot_id, ticket_snapshot_digest,
       claim_id, integration_base_head_sha, state, accepted_head_sha, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, ?, 'review_pending', NULL, 1_000, 1_000)`,
  ).run(sliceId, jobId, ticketArtifactId, ticketSnapshotId, digest, SHA.base);
  const insertAttempt = database.prepare(
    `INSERT INTO navigator_ticket_worker_attempts (
       id, job_id, slice_id, kind, ordinal, effect_idempotency_key,
       work_order_json, work_order_digest, step_contract_id, step_contract_revision,
       step_contract_digest, profile_json, profile_digest, model_route_json,
       resource_kind, resource_id, created_at, updated_at
     ) VALUES (?, ?, ?, 'review', ?, ?, '{}', ?, 'navigator-ticket-code-review', 2,
       'b32624e6c687619ad840747a023b9f918108b8a409308f935723eb99de5f2f3c',
       '{}', ?, '{}', NULL, NULL, 1_000, 1_000)`,
  );
  insertAttempt.run(sourceAttemptId, jobId, sliceId, 1, sourceEffectKey, digest, digest);
  insertAttempt.run(resolutionAttemptId, jobId, sliceId, 2, resolutionEffectKey, digest, digest);
  database.prepare(
    `INSERT INTO navigator_review_finding_events (
       id, job_id, slice_id, source_review_attempt_id, verification_attempt_id,
       root_cause_id, capability_id, rule_id, disposition, event, head_sha,
       finding_json, evidence_refs_json, occurrence, blocking_burden, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'must_fix', 'opened', ?, ?, ?, 1, 1, 1_000)`,
  ).run(
    "legacy-ledger-open-event", jobId, sliceId, sourceAttemptId, sourceAttemptId,
    finding.rootCauseId, finding.capabilityId, finding.ruleId, SHA.base,
    JSON.stringify(finding), JSON.stringify(finding.evidenceRefs),
  );
  database.pragma("foreign_keys = ON");
}

function implementationResult(
  attempt: NavigatorTicketWorkerAttempt,
  headSha: string,
  ticket: WorkArtifactSnapshot,
) {
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
  findingOverride?: NavigatorReviewFinding,
) {
  const findings = outcome === "findings"
    ? attempt.workOrder.verificationOf?.findings ?? [findingOverride ?? {
      rootCauseId: "restart-durability",
      capabilityId: "code-review",
      ruleId: "SPEC-40-RESTART",
      severity: "high" as const,
      subject: "src/navigator/implementation-executor.ts",
      line: 1,
      requirementId: guardRequirementBindings(["test"])[0]!.id,
      evidenceClass: "review",
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

function prepareTicketEffectForExecutor(value: Fixture, now: number) {
  const executor = new NavigatorImplementationExecutor({
    store: value.store,
    database: value.database,
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
  const claimId = value.claim(value.ticketIds[0]);
  executor.beginClaimedTicket({
    jobId: value.jobId,
    ticketArtifactId: value.ticketIds[0],
    claimId,
    taskEvidence: ["behavioral-change"],
    evidenceRefs: ["ticket:40:claim"],
    ownerId: "executor-40",
    generation: 1,
  });
  value.database.prepare("UPDATE work_artifact_claims SET lease_expires_at = ? WHERE id = ?")
    .run(now, claimId);
  value.database.prepare(
    "UPDATE job_resource_claims SET lease_expires_at = ? WHERE job_id = ? AND state = 'held'",
  ).run(now, value.jobId);
  value.database.prepare(
    `UPDATE effects SET status = 'done', lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL
      WHERE job_id = ? AND kind <> 'run_navigator_ticket_worker'`,
  ).run(value.jobId);
  value.database.prepare(
    `UPDATE effects SET status = 'leased', lease_owner = 'executor-40', lease_generation = 1, lease_expires_at = ?
      WHERE job_id = ? AND kind = 'run_navigator_ticket_worker'`,
  ).run(now, value.jobId);
  const effect = value.store.listEffectsForJob(value.jobId).find((candidate) =>
    candidate.kind === "run_navigator_ticket_worker");
  if (!effect) throw new Error("navigator ticket executor effect was not stored");
  if (!value.store.releaseExecutorLease("executor-40", 1, now)) {
    throw new Error("navigator ticket predecessor lease was not released");
  }
  return { executor, claimId, effect };
}

function prepareTicketEffectForProtocol(value: Fixture, now: number) {
  const prepared = prepareTicketEffectForExecutor(value, now);
  value.database.prepare("UPDATE effects SET lease_expires_at = ? WHERE job_id = ? AND status = 'leased'")
    .run(now - 1, value.jobId);
  value.database.prepare("UPDATE job_resource_claims SET lease_expires_at = ? WHERE job_id = ? AND state = 'held'")
    .run(now + 1_000, value.jobId);
  value.database.prepare("UPDATE work_artifact_claims SET lease_expires_at = ? WHERE state = 'held'")
    .run(now + 1_000);
  value.database.prepare(
    "UPDATE executor_lease SET owner_id = 'executor-40', generation = 1, heartbeat_at = ?, lease_expires_at = ? WHERE singleton = 1",
  ).run(now, now + 1_000);
  return prepared;
}

function ticketProtocol(
  value: Fixture,
  operation: NavigatorTicketWorkerOperation,
  now: () => number = value.now,
  leaseMs = 30_000,
): NavigatorEffectProtocol {
  const unused = async () => ({ outcome: "permanent" as const, reason: "unused in this test" });
  return new NavigatorEffectProtocol({
    store: value.store,
    clock: { now },
    leaseMs,
    adapters: [
      { kind: "run_navigator_skill", execute: unused },
      createNavigatorTicketEffectAdapter(operation),
      { kind: "run_navigator_release", execute: unused },
    ],
  });
}

async function waitForAttemptResource(value: Fixture, attemptId: string, resourceId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = value.database.prepare(
      "SELECT resource_kind, resource_id FROM navigator_ticket_worker_attempts WHERE id = ?",
    ).get(attemptId) as { resource_kind: string | null; resource_id: string | null } | undefined;
    if (row?.resource_kind === "bb_thread" && row.resource_id === resourceId) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("navigator ticket worker resource was not durably bound");
}

function completedTicketReceipt(context: NavigatorEffectContext): NavigatorEffectOutcome {
  if (context.kind !== "run_navigator_ticket_worker") {
    return { outcome: "permanent", reason: "ticket receipt received another effect kind" };
  }
  return {
    outcome: "completed",
    receipt: {
      kind: "run_navigator_ticket_worker",
      effectIdempotencyKey: context.effect.idempotencyKey,
      attemptId: context.ticket.attempt.id,
      resource: { kind: "bb_thread", id: "thr_ticket_receipt" },
      exactHeadSha: SHA.base,
      result: {},
      gitObservation: null,
    },
  };
}

type ClaimCase = "empty" | "unrelated" | "wrong key" | "wrong kind" | "wrong owner" | "wrong generation" | "expired" | "valid exact";
const CLAIM_CASES: readonly ClaimCase[] = [
  "empty", "unrelated", "wrong key", "wrong kind", "wrong owner", "wrong generation", "expired", "valid exact",
];

function configureTicketClaimCase(
  value: Fixture,
  effect: Readonly<{ idempotencyKey: string }>,
  claimId: number,
  claimCase: ClaimCase,
  now: number,
): void {
  const projectKey = "project:proj_40:pipeline";
  if (claimCase !== "valid exact") {
    value.database.prepare(
      `UPDATE effects SET status = 'pending', lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL,
          next_attempt_at = ? WHERE idempotency_key = ?`,
    ).run(now, effect.idempotencyKey);
  }
  if (claimCase === "valid exact") {
    value.database.prepare(
      `UPDATE effects SET status = 'leased', lease_owner = 'ticket-matrix-predecessor',
          lease_generation = 1, lease_expires_at = ? WHERE idempotency_key = ?`,
    ).run(now, effect.idempotencyKey);
    value.database.prepare(
      `UPDATE job_resource_claims SET owner_id = 'ticket-matrix-predecessor', generation = 1,
          lease_expires_at = ? WHERE job_id = ? AND resource_kind = 'project' AND resource_key = ?`,
    ).run(now, value.jobId, projectKey);
    value.database.prepare(
      "UPDATE work_artifact_claims SET owner_id = 'ticket-matrix-predecessor', generation = 1, lease_expires_at = ? WHERE id = ?",
    ).run(now, claimId);
    return;
  }
  if (claimCase === "empty") {
    value.database.prepare(
      "UPDATE job_resource_claims SET state = 'released', released_at = ?, release_reason = 'claim matrix' WHERE job_id = ?",
    ).run(now, value.jobId);
    value.database.prepare(
      "UPDATE work_artifact_claims SET state = 'released', released_at = ?, release_reason = 'claim matrix' WHERE id = ?",
    ).run(now, claimId);
    return;
  }
  if (claimCase === "unrelated") {
    value.database.prepare(
      "UPDATE job_resource_claims SET resource_key = 'project:unrelated:pipeline' WHERE job_id = ? AND resource_kind = 'project'",
    ).run(value.jobId);
    return;
  }
  const resourceKind = claimCase === "wrong kind" ? "repository_merge" : "project";
  const resourceKey = claimCase === "wrong key" ? "project:proj_40:other" : projectKey;
  const ownerId = claimCase === "wrong owner" ? "ticket-matrix-other" : "executor-40";
  const generation = claimCase === "wrong generation" ? 2 : 1;
  const expiresAt = claimCase === "expired" ? now : now + 30_000;
  value.database.prepare(
    `UPDATE job_resource_claims SET resource_key = ?, resource_kind = ?, owner_id = ?, generation = ?, lease_expires_at = ?
      WHERE job_id = ?`,
  ).run(resourceKey, resourceKind, ownerId, generation, expiresAt, value.jobId);
}

describe("navigator ticket integration executor", () => {
  it("keeps finding identity stable across mutable review wording and formatting", () => {
    const finding = {
      rootCauseId: "wording-change",
      capabilityId: "code-review",
      ruleId: "requirement.behavior",
      severity: "high" as const,
      subject: "./src\\app.ts",
      line: 7,
      requirementId: "required-check:behavior",
      evidenceClass: "review",
      summary: "The first wording.",
      evidenceRefs: ["review:first"],
    };

    const descriptorDigest = "a".repeat(64);
    expect(navigatorFindingFingerprint(descriptorDigest, finding)).toBe(
      navigatorFindingFingerprint(descriptorDigest, {
        ...finding,
        severity: "low",
        line: 99,
        summary: "The revised wording.",
        evidenceRefs: ["review:second"],
        subject: "src/app.ts",
      }),
    );
    expect(navigatorFindingFingerprint(descriptorDigest, { ...finding, requirementId: null })).not.toBe(
      navigatorFindingFingerprint(descriptorDigest, {
        ...finding,
        requirementId: null,
        evidenceClass: "public-contract",
      }),
    );
  });

  it("derives confirmed disposition from the observed finding and marks older-head proof stale", async () => {
    const value = fixture();
    const { executor } = prepareTicketEffectForProtocol(value, 1_110);
    const proposedFinding: NavigatorReviewFinding = {
      rootCauseId: "critical-advisory-rule",
      capabilityId: "clean-code-guard",
      ruleId: "clean.rule-10",
      severity: "low",
      subject: ".\\src/app.ts",
      line: 1,
      requirementId: null,
      evidenceClass: "review",
      summary: "The initial review proposed an advisory finding.",
      evidenceRefs: ["review:proposal"],
    };
    const confirmedFinding: NavigatorReviewFinding = {
      ...proposedFinding,
      severity: "critical",
      summary: "An independent confirmation found a critical issue.",
      evidenceRefs: ["review:critical-confirmation"],
    };
    const run = vi.fn(async (input: NavigatorTicketWorkerInput) => {
      const resource = input.attempt.resource ?? { kind: "bb_thread" as const, id: `thr_${input.attempt.id}` };
      if (input.attempt.kind === "implementation") {
        return { resource, result: implementationResult(input.attempt, SHA.ticketOne, input.ticket) };
      }
      const result = reviewResult(input.attempt, "findings", proposedFinding);
      return input.attempt.workOrder.verificationOf === undefined
        ? { resource, result }
        : { resource, result: { ...result, findings: [confirmedFinding] } };
    });
    const protocol = ticketProtocol(value, { run, reconcile: run, observe: validGitObserver().observe }, () => 1_110);
    const fence = { ownerId: "executor-40", generation: 1, signal: new AbortController().signal };
    await protocol.processOne(fence, new AbortController().signal);
    await protocol.processOne(fence, new AbortController().signal);
    await protocol.processOne(fence, new AbortController().signal);

    const decision = value.store.getNavigatorFindingLedgerDecision(value.jobId);
    const entry = decision.entries[0]!;
    expect(decision).toMatchObject({
      outcome: "accepted",
      allowedNextAction: "repair",
      blockingBurden: 1,
      burdenDelta: 0,
    });
    expect(entry).toMatchObject({
      disposition: "must_fix",
      state: "open",
      finding: expect.objectContaining({ severity: "critical" }),
      normalizedSubject: "src/app.ts",
      requirementClass: "evidence:review",
      descriptorDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      descriptorVersion: expect.any(String),
      policyRevision: 1,
      policyDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      artifactSnapshotId: expect.any(String),
      artifactSnapshotDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      specificationSnapshotId: expect.any(String),
      specificationSnapshotDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      sourceAttemptDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      verificationAttemptDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    const event = value.database.prepare(
      `SELECT root_cause_id, head_sha, severity, normalized_subject, evidence_class, fingerprint,
              disposition, policy_revision, requirement_ids_json, root_cause_confirmed
         FROM navigator_review_finding_events ORDER BY sequence DESC LIMIT 1`,
    ).get();
    expect(event).toMatchObject({
      root_cause_id: "critical-advisory-rule",
      head_sha: SHA.ticketOne,
      severity: "critical",
      normalized_subject: "src/app.ts",
      evidence_class: "review",
      fingerprint: entry.fingerprint,
      disposition: "must_fix",
      policy_revision: 1,
      root_cause_confirmed: 1,
    });

    value.database.prepare("UPDATE navigator_integrations SET current_head_sha = ? WHERE job_id = ?")
      .run(SHA.repair, value.jobId);
    const stale = value.store.getNavigatorFindingLedgerDecision(value.jobId);
    expect(stale).toMatchObject({ allowedNextAction: "recheck", blockingBurden: 0, reasonCode: "stale_evidence" });
    expect(stale.entries[0]).toMatchObject({ state: "stale", headSha: SHA.ticketOne });
    expect(stale.staleEvidence).toEqual([{
      fingerprint: entry.fingerprint,
      assessedHeadSha: SHA.ticketOne,
      currentHeadSha: SHA.repair,
    }]);
    expect(executor.snapshot(value.jobId).findingLedger[0]).toMatchObject({ state: "stale" });
  });

  it("fails closed on unadmitted context and uses the registry default for unknown rules", () => {
    const finding = {
      rootCauseId: "spoofed-priority",
      capabilityId: "clean-code-guard",
      ruleId: "clean.rule-10",
      severity: "critical" as const,
      subject: "src/app.ts",
      line: 1,
      requirementId: "SPOOFED-REQUIREMENT",
      evidenceClass: "review",
      summary: "A reviewer tried to promote an advisory finding.",
      evidenceRefs: ["review:spoofed"],
    };

    expect(navigatorFindingDisposition(finding)).toBeNull();
    expect(navigatorFindingDisposition({
      ...finding,
      capabilityId: "code-review",
      ruleId: "requirement.behavior",
      severity: "low",
      requirementId: null,
      evidenceClass: "review",
    })).toBe("advisory");
  });

  it.each([
    { name: "critical", capabilityId: "clean-code-guard", overrides: { severity: "critical" as const }, expected: "must_fix" as const },
    { name: "high", capabilityId: "clean-code-guard", overrides: { severity: "high" as const }, expected: "must_fix" as const },
    {
      name: "requirement-linked",
      capabilityId: "clean-code-guard",
      overrides: { ruleId: "clean.rule-unknown", requirementId: guardRequirementBindings(["test"])[0]!.id },
      expected: "must_fix" as const,
    },
    {
      name: "public-contract",
      capabilityId: "clean-code-guard",
      overrides: { ruleId: "clean.rule-unknown", evidenceClass: "public-contract" },
      expected: "must_fix" as const,
    },
    { name: "explicit must-fix rule", capabilityId: "clean-code-guard", overrides: { ruleId: "clean.rule-1" }, expected: "must_fix" as const },
    { name: "explicit advisory rule", capabilityId: "clean-code-guard", overrides: { ruleId: "clean.rule-10" }, expected: "advisory" as const },
    { name: "unknown clean-code rule", capabilityId: "clean-code-guard", overrides: { ruleId: "clean.rule-unknown" }, expected: "advisory" as const },
    { name: "unknown code-review rule", capabilityId: "code-review", overrides: { ruleId: "code-review.rule-unknown" }, expected: "advisory" as const },
  ] as const)("derives $name the same way at every finding policy seam", ({ capabilityId, overrides, expected }) => {
    const descriptorDigest = SKILL_ADMISSION_CATALOG.find((entry) => entry.id === capabilityId)?.bundleDescriptorDigest;
    if (!descriptorDigest) throw new Error(`${capabilityId} admission is unavailable`);
    const requirementId = guardRequirementBindings(["test"])[0]!.id;
    const finding: NavigatorReviewFinding = {
      rootCauseId: "policy-matrix",
      capabilityId,
      ruleId: "clean.rule-10",
      severity: "low",
      subject: "src/app.ts",
      line: 1,
      requirementId: null,
      evidenceClass: "review",
      summary: "Mutable review prose does not choose disposition.",
      evidenceRefs: ["finding:policy-matrix"],
      ...overrides,
    };
    const guardFinding = {
      ruleId: finding.ruleId,
      severity: finding.severity,
      subject: finding.subject,
      line: finding.line,
      evidence: finding.summary,
      evidenceClass: finding.evidenceClass,
      requirementId: finding.requirementId,
    };
    const guardPolicy: GuardAssessmentPolicy = {
      profileId: "cap_profile:policy-matrix",
      profileRevision: 1,
      reviewedHeadSha: SHA.base,
      diffDigest: "f".repeat(64),
      selectedGuards: [{ capabilityId: finding.capabilityId, descriptorDigest, mandatory: true, substitutes: [] }],
      requirementIds: [requirementId],
      mustFixRuleIds: capabilityId === "clean-code-guard" ? ["clean.rule-1"] : [],
      advisoryRuleIds: capabilityId === "clean-code-guard" ? ["clean.rule-10"] : [],
    };
    const guardAssessment = assessGuardEnvelope({
      schemaVersion: 1,
      profileId: guardPolicy.profileId,
      profileRevision: guardPolicy.profileRevision,
      reviewedHeadSha: SHA.base,
      diffDigest: guardPolicy.diffDigest,
      guards: [{
        capabilityId: finding.capabilityId,
        descriptorDigest,
        outcome: "findings",
        findings: [guardFinding],
      }],
    }, guardPolicy);
    const recorded: { facts: NavigatorFindingAssessmentFacts | null } = { facts: null };
    const emptyDecision = (): NavigatorFindingLedgerDecision => ({
      outcome: "accepted",
      allowedNextAction: "accept",
      reasonCode: null,
      entries: [],
      currentRoots: [],
      blockingBurden: 0,
      burdenDelta: 0,
      staleEvidence: [],
      reasons: [],
    });
    new NavigatorFindingLedger({
      assess: (facts) => {
        recorded.facts = facts;
        return emptyDecision();
      },
      resolvePassingReview: emptyDecision,
      currentDecision: emptyDecision,
    }).assess({
      jobId: "job_policy_matrix",
      sliceId: "slice_policy_matrix",
      sourceReviewAttemptId: "attempt_policy_source",
      verificationAttemptId: "attempt_policy_confirmation",
      sourceAttemptDigest: "a".repeat(64),
      verificationAttemptDigest: "b".repeat(64),
      exactHeadSha: SHA.base,
      artifactSnapshotId: null,
      artifactSnapshotDigest: null,
      specificationSnapshotId: null,
      specificationSnapshotDigest: null,
      selectedGuards: [{ capabilityId: finding.capabilityId, descriptorDigest }],
      requirementIds: [requirementId],
      proposedFindings: [finding],
      confirmedFindings: [finding],
      evidenceRefs: ["review:policy-matrix"],
      now: 1,
      maxReviewCycles: 3,
    });

    expect(guardAssessment).toMatchObject({ outcome: expected === "must_fix" ? "changes_requested" : "pass_with_advisories" });
    expect(guardAssessment.findings[0]?.disposition).toBe(expected);
    expect(recorded.facts?.findings[0]?.disposition).toBe(expected);
    expect(navigatorFindingDisposition({
      ...finding,
      descriptorDigest,
      requirementIds: [requirementId],
    })).toBe(expected);
  });

  it.each([
    { name: "unknown capability", capabilityId: "not-admitted", requirementId: null, requirementIds: [] },
    { name: "unselected capability", capabilityId: "docs-guard", requirementId: null, requirementIds: [] },
    {
      name: "unknown requirement",
      capabilityId: "clean-code-guard",
      requirementId: "requirement:not-admitted",
      requirementIds: [guardRequirementBindings(["test"])[0]!.id],
    },
  ] as const)("fails closed for an $name", ({ capabilityId, requirementId, requirementIds }) => {
    const descriptorDigest = SKILL_ADMISSION_CATALOG.find((entry) => entry.id === "clean-code-guard")?.bundleDescriptorDigest;
    if (!descriptorDigest) throw new Error("clean-code-guard admission is unavailable");
    const finding: NavigatorReviewFinding = {
      rootCauseId: "policy-rejection",
      capabilityId,
      ruleId: "clean.rule-10",
      severity: "low",
      subject: "src/app.ts",
      line: 1,
      requirementId,
      evidenceClass: "review",
      summary: "Unadmitted policy input cannot reach persistence.",
      evidenceRefs: ["finding:policy-rejection"],
    };
    let called = false;
    const decision = new NavigatorFindingLedger({
      assess: () => {
        called = true;
        throw new Error("untrusted finding reached persistence");
      },
      resolvePassingReview: () => {
        throw new Error("unused");
      },
      currentDecision: () => {
        throw new Error("unused");
      },
    }).assess({
      jobId: "job_policy",
      sliceId: "slice_policy",
      sourceReviewAttemptId: "attempt_source",
      verificationAttemptId: "attempt_verification",
      sourceAttemptDigest: "a".repeat(64),
      verificationAttemptDigest: "b".repeat(64),
      exactHeadSha: SHA.base,
      artifactSnapshotId: null,
      artifactSnapshotDigest: null,
      specificationSnapshotId: null,
      specificationSnapshotDigest: null,
      selectedGuards: [{ capabilityId: "clean-code-guard", descriptorDigest }],
      requirementIds,
      proposedFindings: [finding],
      confirmedFindings: [finding],
      evidenceRefs: ["review:policy-rejection"],
      now: 1,
      maxReviewCycles: 3,
    });
    expect(decision).toMatchObject({ outcome: "blocked", allowedNextAction: "stop" });
    expect(called).toBe(false);
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

  it("upgrades a preceding-schema open finding ledger and resolves it in SQLite", () => {
    const findingUpgradeId = ALL_MIGRATIONS.indexOf(NAVIGATOR_FINDING_LEDGER_UPGRADE_MIGRATIONS[0]);
    expect(findingUpgradeId).toBeGreaterThan(0);
    const value = fixture(findingUpgradeId, seedPreFindingLedgerSchema);

    const readable = value.store.getNavigatorFindingLedgerDecision("legacy-ledger-job");
    expect(readable).toMatchObject({
      outcome: "accepted",
      allowedNextAction: "repair",
      blockingBurden: 1,
      entries: [{
        rootCauseId: "legacy-open-root",
        state: "open",
        disposition: "must_fix",
        normalizedSubject: "src/legacy.ts",
        requirementClass: "evidence:legacy",
      }],
    });

    const ledger = new NavigatorFindingLedger(new NavigatorFindingLedgerRepository(value.database));
    const resolved = ledger.resolvePassingReview({
      jobId: "legacy-ledger-job",
      sliceId: "legacy-ledger-slice",
      verificationAttemptId: "legacy-ledger-resolution-attempt",
      verificationAttemptDigest: "c".repeat(64),
      exactHeadSha: SHA.base,
      artifactSnapshotId: null,
      artifactSnapshotDigest: null,
      specificationSnapshotId: null,
      specificationSnapshotDigest: null,
      evidenceRefs: ["legacy:resolution"],
      now: 2_000,
      maxReviewCycles: 3,
    });

    expect(resolved).toMatchObject({
      outcome: "accepted",
      allowedNextAction: "accept",
      blockingBurden: 0,
      entries: [{ rootCauseId: "legacy-open-root", state: "resolved", blockingBurden: 0 }],
      currentRoots: [],
    });
    expect(value.database.prepare(
      `SELECT event, root_cause_id, fingerprint, normalized_subject, evidence_class
         FROM navigator_review_finding_events
        WHERE job_id = ? ORDER BY sequence`,
    ).all("legacy-ledger-job")).toEqual([
      {
        event: "opened",
        root_cause_id: "legacy-open-root",
        fingerprint: "",
        normalized_subject: "",
        evidence_class: "legacy",
      },
      {
        event: "resolved",
        root_cause_id: "legacy-open-root",
        fingerprint: "legacy:legacy-open-root",
        normalized_subject: "src/legacy.ts",
        evidence_class: "review",
      },
    ]);
  });

  it("rejects worker-reported Git evidence that disagrees with the executor observation", async () => {
    const value = fixture();
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
    const operation: NavigatorTicketWorkerOperation = {
      run: vi.fn(async (input) => ({
        resource: { kind: "bb_thread" as const, id: `thr_${input.attempt.id}` },
        result: implementationResult(input.attempt, SHA.ticketOne, input.ticket),
      })),
      reconcile: vi.fn(),
      observe: gitObserver.observe,
    };
    const protocol = new NavigatorEffectProtocol({
      store: value.store,
      clock: { now: value.now },
      adapters: [
        {
          kind: "run_navigator_skill",
          execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused in this test" })),
        },
        createNavigatorTicketEffectAdapter(operation),
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
    const worker = vi.fn(async (input: NavigatorTicketWorkerInput) => ({
      resource: { kind: "bb_thread" as const, id: `thr_${input.attempt.id}` },
      result: {},
    }));
    const executor = new NavigatorImplementationExecutor({
      store: value.store,
      database: value.database,
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
        createNavigatorTicketEffectAdapter({
          run: worker,
          reconcile: worker,
          observe: async () => ({}),
        }),
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

  it("renews and adopts the ticket work-artifact claim through runJobExecutorService", async () => {
    const value = fixture();
    const now = { value: 1_110 };
    const prepared = prepareTicketEffectForExecutor(value, now.value);
    let started = false;
    const abort = new AbortController();
    const gitObserver = validGitObserver();
    const run = vi.fn(async (input: NavigatorTicketWorkerInput) => {
      started = true;
      setTimeout(() => { now.value = 1_125; }, 15);
      await new Promise<void>((resolve) => setTimeout(resolve, 55));
      return {
        resource: { kind: "bb_thread" as const, id: "thr_ticket_executor" },
        result: implementationResult(input.attempt, SHA.ticketOne, input.ticket),
      };
    });
    const operation: NavigatorTicketWorkerOperation = {
      run,
      reconcile: vi.fn(),
      observe: gitObserver.observe,
    };
    const protocol = new NavigatorEffectProtocol({
      store: value.store,
      clock: { now: () => now.value },
      leaseMs: 30,
      adapters: [
        { kind: "run_navigator_skill", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        createNavigatorTicketEffectAdapter(operation),
        { kind: "run_navigator_release", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
      ],
    });
    const service = runJobExecutorService({
      store: value.store,
      clock: { now: () => now.value },
      leaseMs: 1_000,
      navigatorEffects: protocol,
      effectRunnerFactory: () => ({ run: async () => undefined }),
      waitForWork: async () => abort.abort(),
      releaseOnShutdown: true,
    }, abort.signal);

    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    const renewedClaim = value.store.getWorkArtifactClaim(prepared.claimId);
    expect(started).toBe(true);
    expect(renewedClaim).toMatchObject({
      ownerId: expect.not.stringMatching("executor-40"),
      generation: expect.any(Number),
      leaseExpiresAt: expect.any(Number),
    });
    expect(renewedClaim!.leaseExpiresAt).toBeGreaterThan(now.value);
    await service;

    expect(run).toHaveBeenCalledTimes(1);
    expect(value.store.getEffect(value.jobId, prepared.effect.idempotencyKey)).toMatchObject({ status: "done" });
  });

  it("cancels a ticket worker at its immutable step deadline and retries the fenced effect", async () => {
    const value = fixture();
    const now = { value: 1_110 };
    const prepared = prepareTicketEffectForExecutor(value, 1_110);
    const attemptId = String(prepared.effect.payload.attemptId);
    const timeoutMs = prepared.executor.snapshot(value.jobId).attempts[0]!.stepContract.timeoutMs;
    const abort = new AbortController();
    const gitObserver = validGitObserver();
    const run = vi.fn(async (input: NavigatorTicketWorkerInput, signal: AbortSignal) => {
      if (run.mock.calls.length > 1) {
        return { resource: input.attempt.resource!, result: implementationResult(input.attempt, SHA.ticketOne, input.ticket) };
      }
      return await new Promise<never>((_resolve, reject) => {
        const cancel = (): void => reject(signal.reason ?? new Error("worker cancelled"));
        if (signal.aborted) {
          cancel();
          return;
        }
        signal.addEventListener("abort", cancel, { once: true });
      });
    });
    const operation = {
      prepare: vi.fn(async () => ({ kind: "bb_thread" as const, id: "thr_timeout" })),
      run,
      reconcile: vi.fn(),
      observe: gitObserver.observe,
    };
    const protocol = ticketProtocol(value, operation, () => now.value, 15_000_000);
    vi.useFakeTimers();
    try {
      const service = runJobExecutorService({
        store: value.store,
        clock: { now: () => now.value },
        leaseMs: 15_000_000,
        navigatorEffects: protocol,
        effectRunnerFactory: () => ({ run: async () => undefined }),
        waitForWork: async () => abort.abort(),
        releaseOnShutdown: true,
      }, abort.signal);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(timeoutMs + 1);
      abort.abort(new Error("test safety stop"));
      await service;
    } finally {
      vi.useRealTimers();
    }

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1].aborted).toBe(true);
    expect(value.store.getEffect(value.jobId, prepared.effect.idempotencyKey)).toMatchObject({
      status: "failed",
      lastError: expect.stringContaining("deadline"),
      nextAttemptAt: expect.any(Number),
    });
    expect(value.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_ticket_worker_outcomes WHERE attempt_id = ?",
    ).get(attemptId)).toEqual({ count: 0 });

    now.value = 20_000_000;
    const successorAbort = new AbortController();
    vi.useFakeTimers();
    try {
      const successor = runJobExecutorService({
        store: value.store,
        clock: { now: () => now.value },
        leaseMs: 15_000_000,
        navigatorEffects: protocol,
        effectRunnerFactory: () => ({ run: async () => undefined }),
        waitForWork: async () => successorAbort.abort(),
        releaseOnShutdown: true,
      }, successorAbort.signal);
      await vi.advanceTimersByTimeAsync(0);
      await successor;
    } finally {
      vi.useRealTimers();
    }

    expect(operation.prepare).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0].attempt.resource).toEqual({ kind: "bb_thread", id: "thr_timeout" });
    expect(value.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_ticket_worker_attempts WHERE effect_idempotency_key = ?",
    ).get(prepared.effect.idempotencyKey)).toEqual({ count: 1 });
    expect(value.store.getEffect(value.jobId, prepared.effect.idempotencyKey)).toMatchObject({ status: "done" });
  });

  it("binds a spawned worker before waiting so takeover reuses one exact durable thread", async () => {
    const value = fixture();
    const now = { value: 1_110 };
    const prepared = prepareTicketEffectForExecutor(value, now.value);
    const attemptId = String(prepared.effect.payload.attemptId);
    const resource = { kind: "bb_thread" as const, id: "thr_spawned_once" };
    const firstAbort = new AbortController();
    const prepare = vi.fn(async () => resource);
    const run = vi.fn(async (input: NavigatorTicketWorkerInput, signal: AbortSignal) => {
      if (run.mock.calls.length === 1) {
        await new Promise<never>((_resolve, reject) => {
          const cancel = (): void => reject(signal.reason ?? new Error("first worker stopped"));
          if (signal.aborted) {
            cancel();
            return;
          }
          signal.addEventListener("abort", cancel, { once: true });
        });
      }
      return { resource: input.attempt.resource!, result: implementationResult(input.attempt, SHA.ticketOne, input.ticket) };
    });
    const operation = {
      prepare,
      run,
      reconcile: vi.fn(),
      observe: validGitObserver().observe,
    };
    const protocol = ticketProtocol(value, operation, () => now.value, 1_000);
    const firstService = runJobExecutorService({
      store: value.store,
      clock: { now: () => now.value },
      leaseMs: 1_000,
      navigatorEffects: protocol,
      effectRunnerFactory: () => ({ run: async () => undefined }),
      waitForWork: async () => firstAbort.abort(),
      releaseOnShutdown: true,
    }, firstAbort.signal);
    try {
      await waitForAttemptResource(value, attemptId, resource.id);
    } finally {
      firstAbort.abort(new Error("predecessor stopped after spawn"));
    }
    await firstService;

    expect(value.store.getNavigatorTicketAttemptContext({
      attemptId,
      effectIdempotencyKey: prepared.effect.idempotencyKey,
      ownerId: "executor-40",
      generation: 1,
      now: 1_110,
    })).toBeNull();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    now.value = 5_000;
    const successorAbort = new AbortController();
    await runJobExecutorService({
      store: value.store,
      clock: { now: () => now.value },
      leaseMs: 1_000,
      navigatorEffects: protocol,
      effectRunnerFactory: () => ({ run: async () => undefined }),
      waitForWork: async () => successorAbort.abort(),
      releaseOnShutdown: true,
    }, successorAbort.signal);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0].attempt.id).toBe(attemptId);
    expect(run.mock.calls[1]?.[0].attempt.resource).toEqual(resource);
    expect(value.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_ticket_worker_attempts WHERE effect_idempotency_key = ?",
    ).get(prepared.effect.idempotencyKey)).toEqual({ count: 1 });
    expect(value.store.getEffect(value.jobId, prepared.effect.idempotencyKey)).toMatchObject({ status: "done" });
  });

  it("rejects persisted integration-head drift before ticket worker preparation", async () => {
    const value = fixture();
    const prepared = prepareTicketEffectForExecutor(value, 1_110);
    const attemptId = String(prepared.effect.payload.attemptId);
    value.database.prepare(
      "UPDATE navigator_integrations SET current_head_sha = ? WHERE job_id = ?",
    ).run(SHA.ticketOne, value.jobId);
    const prepare = vi.fn(async () => ({ kind: "bb_thread" as const, id: "thr_persisted_drift" }));
    const run = vi.fn();
    const observe = vi.fn(validGitObserver().observe);
    const protocol = ticketProtocol(value, {
      prepare,
      run,
      reconcile: vi.fn(),
      observe,
    });
    const abort = new AbortController();
    await runJobExecutorService({
      store: value.store,
      clock: { now: () => 1_110 },
      leaseMs: 1_000,
      navigatorEffects: protocol,
      effectRunnerFactory: () => ({ run: async () => undefined }),
      waitForWork: async () => abort.abort(),
      releaseOnShutdown: true,
    }, abort.signal);

    expect(prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(value.store.getEffect(value.jobId, prepared.effect.idempotencyKey)).toMatchObject({ status: "dead" });
    expect(value.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_effect_receipts WHERE effect_idempotency_key = ?",
    ).get(prepared.effect.idempotencyKey)).toEqual({ count: 0 });
    expect(value.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_ticket_worker_outcomes WHERE attempt_id = ?",
    ).get(attemptId)).toEqual({ count: 0 });
  });

  it.each(["branch", "head", "dirty"] as const)(
    "rejects external Git %s drift before ticket worker preparation",
    async (drift) => {
      const value = fixture();
      const prepared = prepareTicketEffectForExecutor(value, 1_110);
      const attemptId = String(prepared.effect.payload.attemptId);
      const prepare = vi.fn(async () => ({ kind: "bb_thread" as const, id: "thr_external_drift" }));
      const run = vi.fn();
      const observe = vi.fn(async (request: Parameters<NavigatorGitObserver["observe"]>[0]) => ({
        kind: "navigator_git_observation" as const,
        worktreeId: request.worktreeId,
        branch: drift === "branch" ? "hanoon/drift" : request.integrationBranch,
        headSha: drift === "head" ? SHA.ticketOne : request.expectedHeadSha,
        baseHeadSha: request.baseHeadSha,
        baseHeadIsAncestor: true,
        comparisonBaseHeadSha: request.comparisonBaseHeadSha,
        comparisonBaseHeadIsAncestor: true,
        clean: drift !== "dirty",
        changedPaths: request.expectedChangedPaths,
        evidenceRef: `git-preflight:${drift}`,
        observedAt: 2_000,
      }));
      const protocol = ticketProtocol(value, {
        prepare,
        run,
        reconcile: vi.fn(),
        observe,
      });
      const abort = new AbortController();
      await runJobExecutorService({
        store: value.store,
        clock: { now: () => 1_110 },
        leaseMs: 1_000,
        navigatorEffects: protocol,
        effectRunnerFactory: () => ({ run: async () => undefined }),
        waitForWork: async () => abort.abort(),
        releaseOnShutdown: true,
      }, abort.signal);

      expect(observe).toHaveBeenCalledTimes(1);
      expect(prepare).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(value.store.getEffect(value.jobId, prepared.effect.idempotencyKey)).toMatchObject({ status: "dead" });
      expect(value.database.prepare(
        "SELECT COUNT(*) AS count FROM navigator_effect_receipts WHERE effect_idempotency_key = ?",
      ).get(prepared.effect.idempotencyKey)).toEqual({ count: 0 });
      expect(value.database.prepare(
        "SELECT COUNT(*) AS count FROM navigator_ticket_worker_outcomes WHERE attempt_id = ?",
      ).get(attemptId)).toEqual({ count: 0 });
    },
  );

  it("passes an immutable accepted ticket snapshot to the shared executor seam", async () => {
    const value = fixture();
    const prepared = prepareTicketEffectForExecutor(value, 1_110);
    const gitObserver = validGitObserver();
    const run = vi.fn(async (input: Readonly<{
      attempt: NavigatorTicketWorkerAttempt;
      specification: WorkArtifactSnapshot;
      ticket: WorkArtifactSnapshot;
    }>, _signal: AbortSignal) => {
      expect(Object.isFrozen(input.attempt)).toBe(true);
      expect(Object.isFrozen(input.attempt.workOrder)).toBe(true);
      expect(Object.isFrozen(input.specification)).toBe(true);
      expect(Object.isFrozen(input.ticket)).toBe(true);
      return {
        resource: { kind: "bb_thread" as const, id: "thr_ticket_protocol" },
        result: implementationResult(input.attempt, SHA.ticketOne, input.ticket),
      };
    });
    const operation = {
      run,
      reconcile: vi.fn(),
      observe: gitObserver.observe,
    };
    const protocol = new NavigatorEffectProtocol({
      store: value.store,
      clock: { now: () => 1_110 },
      adapters: [
        { kind: "run_navigator_skill", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        createNavigatorTicketEffectAdapter(operation),
        { kind: "run_navigator_release", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
      ],
    });

    const abort = new AbortController();
    await runJobExecutorService({
      store: value.store,
      clock: { now: () => 1_110 },
      leaseMs: 1_000,
      navigatorEffects: protocol,
      effectRunnerFactory: () => ({ run: async () => undefined }),
      waitForWork: async () => abort.abort(),
      releaseOnShutdown: true,
    }, abort.signal);

    expect(run).toHaveBeenCalledTimes(1);
    expect(value.store.getEffect(value.jobId, prepared.effect.idempotencyKey)).toMatchObject({ status: "done" });
    expect(prepared.effect.payload.attemptId).toBeDefined();
  });

  it("does not settle after the required project claim is lost during worker execution", async () => {
    const value = fixture();
    const prepared = prepareTicketEffectForExecutor(value, 1_110);
    const run = vi.fn(async (input: NavigatorTicketWorkerInput) => {
      value.database.prepare(
        `UPDATE job_resource_claims SET state = 'released', released_at = ?, release_reason = 'lease_lost'
          WHERE job_id = ? AND resource_kind = 'project' AND state = 'held'`,
      ).run(1_110, value.jobId);
      return {
        resource: { kind: "bb_thread" as const, id: `thr_${input.attempt.id}` },
        result: {
          kind: "worker_failure" as const,
          failureClass: "permanent" as const,
          retryClass: "bounded_exponential" as const,
          attempts: 1,
          summary: "worker completed after claim loss",
        },
      };
    });
    const protocol = ticketProtocol(value, {
      run,
      reconcile: vi.fn(),
      observe: validGitObserver().observe,
    }, () => 1_110);
    const abort = new AbortController();

    await runJobExecutorService({
      store: value.store,
      clock: { now: () => 1_110 },
      leaseMs: 1_000,
      navigatorEffects: protocol,
      effectRunnerFactory: () => ({ run: async () => undefined }),
      waitForWork: async () => abort.abort(),
      releaseOnShutdown: true,
    }, abort.signal);

    expect(run).toHaveBeenCalledTimes(1);
    expect(value.store.getEffect(value.jobId, prepared.effect.idempotencyKey)).toMatchObject({
      status: "failed",
      lastError: expect.stringContaining("settlement fence"),
    });
    expect(value.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_ticket_worker_outcomes WHERE attempt_id = ?",
    ).get(prepared.effect.payload.attemptId)).toEqual({ count: 0 });
  });

  it("does not complete a ticket effect when the adapter omits its receipt", async () => {
    const value = fixture();
    const prepared = prepareTicketEffectForExecutor(value, 1_110);
    const lease = value.store.acquireExecutorLease("ticket-receiptless", 1_110, 1_000);
    if (!lease.acquired) throw new Error("ticket receiptless executor lease was unavailable");
    const worker = vi.fn(async (): Promise<NavigatorEffectOutcome> => ({
      outcome: "completed",
      receipt: undefined as never,
    }));
    const protocol = new NavigatorEffectProtocol({
      store: value.store,
      clock: { now: () => 1_110 },
      adapters: [
        { kind: "run_navigator_skill", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_ticket_worker", execute: worker },
        { kind: "run_navigator_release", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
      ],
    });

    await expect(protocol.processOne(
      { ownerId: "ticket-receiptless", generation: lease.generation, signal: new AbortController().signal },
      new AbortController().signal,
    )).resolves.toBe(true);

    expect(worker).toHaveBeenCalledTimes(1);
    expect(value.store.getEffect(value.jobId, prepared.effect.idempotencyKey)).toMatchObject({ status: "dead" });
    expect(value.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_ticket_worker_outcomes WHERE attempt_id = ?",
    ).get(prepared.effect.payload.attemptId)).toEqual({ count: 0 });
  });

  it("prevents a stale ticket worker from settling after a successor fence takeover", async () => {
    const value = fixture();
    const now = 1_110;
    const prepared = prepareTicketEffectForExecutor(value, now);
    const abort = new AbortController();
    const execute = vi.fn(async (context: NavigatorEffectContext) => {
      if (context.kind !== "run_navigator_ticket_worker") throw new Error("wrong navigator effect context");
      const successorGeneration = context.fence.generation + 1;
      value.database.prepare(
        `UPDATE executor_lease SET owner_id = 'ticket-successor', generation = ?,
            heartbeat_at = ?, lease_expires_at = ? WHERE singleton = 1`,
      ).run(successorGeneration, now, now + 1_000);
      value.database.prepare(
        `UPDATE effects SET lease_owner = 'ticket-successor', lease_generation = ?, lease_expires_at = ?
          WHERE idempotency_key = ?`,
      ).run(successorGeneration, now + 1_000, prepared.effect.idempotencyKey);
      value.database.prepare(
        `UPDATE job_resource_claims SET owner_id = 'ticket-successor', generation = ?, lease_expires_at = ?
          WHERE job_id = ? AND state = 'held'`,
      ).run(successorGeneration, now + 1_000, value.jobId);
      value.database.prepare(
        `UPDATE work_artifact_claims SET owner_id = 'ticket-successor', generation = ?, lease_expires_at = ?
          WHERE id = ? AND state = 'held'`,
      ).run(successorGeneration, now + 1_000, prepared.claimId);
      abort.abort();
      return {
        outcome: "completed" as const,
        receipt: {
          kind: "run_navigator_ticket_worker" as const,
          effectIdempotencyKey: context.effect.idempotencyKey,
          attemptId: context.ticket.attempt.id,
          resource: { kind: "bb_thread" as const, id: "thr_stale_ticket" },
          exactHeadSha: SHA.base,
          result: {},
          gitObservation: null,
        },
      };
    });
    const protocol = new NavigatorEffectProtocol({
      store: value.store,
      clock: { now: () => now },
      leaseMs: 30,
      adapters: [
        { kind: "run_navigator_skill", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_ticket_worker", execute },
        { kind: "run_navigator_release", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
      ],
    });

    const timeout = setTimeout(() => abort.abort(), 100);
    await runJobExecutorService({
      store: value.store,
      clock: { now: () => now },
      leaseMs: 1_000,
      navigatorEffects: protocol,
      effectRunnerFactory: () => ({ run: async () => undefined }),
      waitForWork: async () => abort.abort(),
      releaseOnShutdown: true,
    }, abort.signal);
    clearTimeout(timeout);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(value.store.getEffect(value.jobId, prepared.effect.idempotencyKey)).toMatchObject({
      status: "leased",
      leaseOwner: "ticket-successor",
      leaseGeneration: expect.any(Number),
    });
    expect(value.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_ticket_worker_outcomes WHERE attempt_id = ?",
    ).get(prepared.effect.payload.attemptId)).toEqual({ count: 0 });
  });

  it("rolls back a typed ticket receipt when workflow settlement fails", async () => {
    const value = fixture();
    const prepared = prepareTicketEffectForExecutor(value, 1_110);
    const lease = value.store.acquireExecutorLease("ticket-rollback", 1_110, 1_000);
    if (!lease.acquired) throw new Error("ticket rollback executor lease was unavailable");
    value.database.exec(
      `CREATE TRIGGER navigator_test_fail_ticket_settlement
       BEFORE INSERT ON navigator_ticket_worker_outcomes
       BEGIN SELECT RAISE(ABORT, 'ticket settlement fault'); END`,
    );
    const protocol = new NavigatorEffectProtocol({
      store: value.store,
      clock: { now: () => 1_110 },
      adapters: [
        { kind: "run_navigator_skill", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_ticket_worker", execute: async (context) => completedTicketReceipt(context) },
        { kind: "run_navigator_release", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
      ],
    });

    await expect(protocol.processOne(
      { ownerId: "ticket-rollback", generation: lease.generation, signal: new AbortController().signal },
      new AbortController().signal,
    )).resolves.toBe(true);

    expect(value.store.getEffect(value.jobId, prepared.effect.idempotencyKey)).not.toMatchObject({ status: "done" });
    expect(value.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_effect_receipts WHERE effect_idempotency_key = ?",
    ).get(prepared.effect.idempotencyKey)).toEqual({ count: 0 });
    expect(value.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_ticket_worker_outcomes WHERE attempt_id = ?",
    ).get(prepared.effect.payload.attemptId)).toEqual({ count: 0 });
  });

  it("rolls back verified finding settlement after ledger insertion", async () => {
    const value = fixture();
    const prepared = prepareTicketEffectForProtocol(value, 1_110);
    const proposedFinding: NavigatorReviewFinding = {
      rootCauseId: "post-ledger-settlement-fault",
      capabilityId: "clean-code-guard",
      ruleId: "clean.rule-10",
      severity: "low",
      subject: "src/app.ts",
      line: 1,
      requirementId: null,
      evidenceClass: "review",
      summary: "The initial review proposed an advisory finding.",
      evidenceRefs: ["review:proposal"],
    };
    const confirmedFinding: NavigatorReviewFinding = {
      ...proposedFinding,
      severity: "critical",
      summary: "The independent confirmation found a critical issue.",
      evidenceRefs: ["review:confirmation"],
    };
    const run = vi.fn(async (input: NavigatorTicketWorkerInput) => {
      const resource = input.attempt.resource ?? { kind: "bb_thread" as const, id: `thr_${input.attempt.id}` };
      if (input.attempt.kind === "implementation") {
        return { resource, result: implementationResult(input.attempt, SHA.ticketOne, input.ticket) };
      }
      const result = reviewResult(input.attempt, "findings", proposedFinding);
      return input.attempt.workOrder.verificationOf === undefined
        ? { resource, result }
        : { resource, result: { ...result, findings: [confirmedFinding] } };
    });
    const protocol = ticketProtocol(value, {
      run,
      reconcile: run,
      observe: validGitObserver().observe,
    }, () => 1_110);
    const fence = { ownerId: "executor-40", generation: 1, signal: new AbortController().signal };
    await protocol.processOne(fence, new AbortController().signal);
    await protocol.processOne(fence, new AbortController().signal);

    const verificationAttempt = value.database.prepare(
      `SELECT id FROM navigator_ticket_worker_attempts
        WHERE slice_id = ? AND kind = 'review' ORDER BY ordinal DESC LIMIT 1`,
    ).get(prepared.effect.payload.sliceId) as { id: string } | undefined;
    if (!verificationAttempt) throw new Error("finding verification attempt was not created");
    const verificationEffect = value.store.listEffectsForJob(value.jobId).find((effect) =>
      effect.payload.attemptId === verificationAttempt.id);
    if (!verificationEffect) throw new Error("finding verification effect was not created");

    const before = {
      findingEvents: value.database.prepare(
        "SELECT COUNT(*) AS count FROM navigator_review_finding_events WHERE slice_id = ?",
      ).get(prepared.effect.payload.sliceId) as { count: number },
      convergence: value.database.prepare(
        "SELECT COUNT(*) AS count FROM navigator_review_convergence WHERE slice_id = ?",
      ).get(prepared.effect.payload.sliceId) as { count: number },
      receipt: value.database.prepare(
        "SELECT COUNT(*) AS count FROM navigator_effect_receipts WHERE effect_idempotency_key = ?",
      ).get(verificationEffect.idempotencyKey) as { count: number },
      outcome: value.database.prepare(
        "SELECT COUNT(*) AS count FROM navigator_ticket_worker_outcomes WHERE attempt_id = ?",
      ).get(verificationAttempt.id) as { count: number },
      attemptCount: value.database.prepare(
        "SELECT COUNT(*) AS count FROM navigator_ticket_worker_attempts WHERE slice_id = ?",
      ).get(prepared.effect.payload.sliceId) as { count: number },
      job: value.database.prepare("SELECT state, version FROM jobs WHERE id = ?")
        .get(value.jobId) as { state: string; version: number },
      integration: value.database.prepare(
        "SELECT state, current_head_sha, active_slice_id FROM navigator_integrations WHERE job_id = ?",
      ).get(value.jobId) as { state: string; current_head_sha: string; active_slice_id: string | null },
      ticket: value.database.prepare(
        "SELECT state, accepted_head_sha FROM navigator_integration_tickets WHERE job_id = ? AND artifact_id = ?",
      ).get(value.jobId, value.ticketIds[0]) as { state: string; accepted_head_sha: string | null },
      slice: value.database.prepare("SELECT state, accepted_head_sha FROM navigator_ticket_slices WHERE id = ?")
        .get(prepared.effect.payload.sliceId) as { state: string; accepted_head_sha: string | null },
    };
    expect(before.findingEvents).toEqual({ count: 0 });
    expect(before.convergence).toEqual({ count: 0 });
    expect(before.receipt).toEqual({ count: 0 });
    expect(before.outcome).toEqual({ count: 0 });
    expect(before.slice.state).toBe("review_pending");
    expect(value.store.getEffect(value.jobId, verificationEffect.idempotencyKey)).toMatchObject({ status: "pending" });

    value.database.exec(
      `CREATE TRIGGER navigator_test_fail_after_finding_ledger
       BEFORE UPDATE ON navigator_ticket_slices
       WHEN NEW.id = '${prepared.effect.payload.sliceId}' AND NEW.state = 'repair_pending'
       BEGIN
         SELECT RAISE(ABORT, 'finding settlement fault')
           WHERE EXISTS (
             SELECT 1 FROM navigator_review_finding_events
              WHERE slice_id = '${prepared.effect.payload.sliceId}' AND event = 'opened'
           );
       END`,
    );

    await expect(protocol.processOne(fence, new AbortController().signal)).resolves.toBe(true);

    expect(run).toHaveBeenCalledTimes(3);
    expect(value.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_review_finding_events WHERE slice_id = ?",
    ).get(prepared.effect.payload.sliceId)).toEqual(before.findingEvents);
    expect(value.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_review_convergence WHERE slice_id = ?",
    ).get(prepared.effect.payload.sliceId)).toEqual(before.convergence);
    expect(value.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_effect_receipts WHERE effect_idempotency_key = ?",
    ).get(verificationEffect.idempotencyKey)).toEqual(before.receipt);
    expect(value.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_ticket_worker_outcomes WHERE attempt_id = ?",
    ).get(verificationAttempt.id)).toEqual(before.outcome);
    expect(value.database.prepare(
      "SELECT COUNT(*) AS count FROM navigator_ticket_worker_attempts WHERE slice_id = ?",
    ).get(prepared.effect.payload.sliceId)).toEqual(before.attemptCount);
    expect(value.database.prepare("SELECT state, version FROM jobs WHERE id = ?").get(value.jobId)).toEqual(before.job);
    expect(value.database.prepare(
      "SELECT state, current_head_sha, active_slice_id FROM navigator_integrations WHERE job_id = ?",
    ).get(value.jobId)).toEqual(before.integration);
    expect(value.database.prepare(
      "SELECT state, accepted_head_sha FROM navigator_integration_tickets WHERE job_id = ? AND artifact_id = ?",
    ).get(value.jobId, value.ticketIds[0])).toEqual(before.ticket);
    expect(value.database.prepare("SELECT state, accepted_head_sha FROM navigator_ticket_slices WHERE id = ?")
      .get(prepared.effect.payload.sliceId)).toEqual(before.slice);
    expect(value.store.getNavigatorFindingLedgerDecision(value.jobId)).toMatchObject({
      blockingBurden: 0,
      entries: [],
      allowedNextAction: "accept",
    });
    expect(value.store.getEffect(value.jobId, verificationEffect.idempotencyKey)).toMatchObject({
      status: "failed",
      leaseOwner: null,
      leaseGeneration: null,
      leaseExpiresAt: null,
      lastError: expect.stringContaining("finding settlement fault"),
    });
  });

  it("reconciles an ambiguous ticket outcome with a typed receipt", async () => {
    const value = fixture();
    const prepared = prepareTicketEffectForExecutor(value, 1_110);
    const lease = value.store.acquireExecutorLease("ticket-reconcile", 1_110, 1_000);
    if (!lease.acquired) throw new Error("ticket reconciliation executor lease was unavailable");
    const execute = vi.fn(async () => ({ outcome: "ambiguous" as const, reason: "worker receipt was lost" }));
    const reconcile = vi.fn(async (context: NavigatorEffectContext) => completedTicketReceipt(context));
    const protocol = new NavigatorEffectProtocol({
      store: value.store,
      clock: { now: () => 1_110 },
      adapters: [
        { kind: "run_navigator_skill", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_ticket_worker", execute, reconcile },
        { kind: "run_navigator_release", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
      ],
    });

    await expect(protocol.processOne(
      { ownerId: "ticket-reconcile", generation: lease.generation, signal: new AbortController().signal },
      new AbortController().signal,
    )).resolves.toBe(true);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(value.store.getEffect(value.jobId, prepared.effect.idempotencyKey)).toMatchObject({ status: "done" });
    expect(value.database.prepare(
      "SELECT kind FROM navigator_effect_receipts WHERE effect_idempotency_key = ?",
    ).get(prepared.effect.idempotencyKey)).toEqual({ kind: "run_navigator_ticket_worker" });
  });

  it.each(CLAIM_CASES)("runs the ticket executor only with the exact claim set (%s)", async (claimCase) => {
    const value = fixture();
    const now = 1_110;
    const prepared = prepareTicketEffectForExecutor(value, now);
    configureTicketClaimCase(value, prepared.effect, prepared.claimId, claimCase, now);
    const execute = vi.fn(async (context: NavigatorEffectContext) => completedTicketReceipt(context));
    const protocol = new NavigatorEffectProtocol({
      store: value.store,
      clock: { now: () => now },
      leaseMs: 30,
      adapters: [
        { kind: "run_navigator_skill", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
        { kind: "run_navigator_ticket_worker", execute },
        { kind: "run_navigator_release", execute: vi.fn(async () => ({ outcome: "permanent" as const, reason: "unused" })) },
      ],
    });
    const abort = new AbortController();
    await runJobExecutorService({
      store: value.store,
      clock: { now: () => now },
      leaseMs: 1_000,
      navigatorEffects: protocol,
      effectRunnerFactory: () => ({ run: async () => undefined }),
      waitForWork: async () => abort.abort(),
      releaseOnShutdown: true,
    }, abort.signal);

    expect(execute).toHaveBeenCalledTimes(claimCase === "valid exact" ? 1 : 0);
    expect(value.store.getEffect(value.jobId, prepared.effect.idempotencyKey)).toMatchObject({
      status: claimCase === "valid exact" ? "done" : "pending",
    });
    expect(value.store.getWorkArtifactClaim(prepared.claimId)).toMatchObject({
      state: claimCase === "empty" ? "released" : "held",
    });
  });

  it("rejects a successful implementation that did not advance beyond its base head", async () => {
    const value = fixture();
    const executor = new NavigatorImplementationExecutor({
      store: value.store,
      database: value.database,
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

    const operation: NavigatorTicketWorkerOperation = {
      run: vi.fn(async (input) => ({
        resource: { kind: "bb_thread" as const, id: `thr_${input.attempt.id}` },
        result: implementationResult(input.attempt, input.attempt.workOrder.baseHeadSha, input.ticket),
      })),
      reconcile: vi.fn(),
      observe: validGitObserver().observe,
    };
    const protocol = ticketProtocol(value, operation);
    await protocol.processOne(
      { ownerId: "executor-40", generation: 1, signal: new AbortController().signal },
      new AbortController().signal,
    );
    await protocol.processOne(
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
    const executor = new NavigatorImplementationExecutor({
      store: value.store,
      database: value.database,
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
    const run = vi.fn(async (input: NavigatorTicketWorkerInput) => {
      throw new NavigatorTicketWorkerRetryableError(
        "BB provider unavailable",
        { kind: "bb_thread", id: `thr_${input.attempt.id}` },
      );
    });
    const operation: NavigatorTicketWorkerOperation = {
      run,
      reconcile: vi.fn(),
      observe: validGitObserver().observe,
    };
    const protocol = ticketProtocol(value, operation);

    await protocol.processOne(fence, new AbortController().signal);
    expect(await protocol.processOne(fence, new AbortController().signal)).toBe(false);
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
      await protocol.processOne(fence, new AbortController().signal);
    }

    expect(run).toHaveBeenCalledTimes(maximumAttempts);
    const exhausted = executor.snapshot(value.jobId);
    expect(exhausted.integration.state).toBe("invalidated");
    expect(exhausted.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: "dead_letter", reasonCode: "retry_exhausted" }),
    ]));
  });

  it("preserves retry attempts and backoff across repeated unavailable worker replacements", async () => {
    const value = fixture();
    const executor = new NavigatorImplementationExecutor({
      store: value.store,
      database: value.database,
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
    const run = vi.fn(async (input: NavigatorTicketWorkerInput) => {
      throw new NavigatorTicketWorkerUnavailableError("missing", {
        kind: "bb_thread",
        id: `thr_${input.attempt.id}`,
      });
    });
    const reconcile = vi.fn(async (input: NavigatorTicketWorkerInput) => {
      const resource = input.attempt.resource ?? { kind: "bb_thread" as const, id: `thr_${input.attempt.id}` };
      return {
        resource,
        result: {
          kind: "worker_unavailable" as const,
          reason: "missing" as const,
          resourceObservation: {
            resource,
            state: "missing" as const,
            evidenceRef: `reconciled:${resource.id}`,
            observedAt: value.now(),
          },
        },
      };
    });
    const protocol = ticketProtocol(value, { run, reconcile, observe: validGitObserver().observe });
    const contract = executor.snapshot(value.jobId).attempts[0]!.stepContract;
    const maximumAttempts = "maximumAttempts" in contract ? contract.maximumAttempts : 0;
    const backoffBaseMs = "backoffBaseMs" in contract ? contract.backoffBaseMs : 0;
    const backoffMaximumMs = "backoffMaximumMs" in contract ? contract.backoffMaximumMs : 0;

    for (let attemptNumber = 1; attemptNumber <= maximumAttempts; attemptNumber += 1) {
      await protocol.processOne(fence, new AbortController().signal);
      const current = executor.snapshot(value.jobId);
      if (attemptNumber < maximumAttempts) {
        const replacement = current.attempts.at(-1)!;
        expect(value.database.prepare(
          "SELECT attempts, next_attempt_at FROM effects WHERE idempotency_key = ?",
        ).get(replacement.effectIdempotencyKey)).toMatchObject({
          attempts: attemptNumber,
          next_attempt_at: expect.any(Number),
        });
        expect(await protocol.processOne(fence, new AbortController().signal)).toBe(false);
        value.advance(Math.min(
          backoffMaximumMs,
          backoffBaseMs * 2 ** (attemptNumber - 1),
        ));
      }
    }

    expect(run).toHaveBeenCalledTimes(maximumAttempts);
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
    const run = vi.fn(async (input: NavigatorTicketWorkerInput) => {
      const resource = { kind: "bb_thread" as const, id: `thr_${input.attempt.id}` };
      value.database.prepare(
        "UPDATE work_artifact_claims SET owner_id = 'stolen-executor', generation = 100 WHERE id = ?",
      ).run(claimId);
      return { resource, result: implementationResult(input.attempt, SHA.ticketOne, input.ticket) };
    });
    const executor = new NavigatorImplementationExecutor({
      store: value.store,
      database: value.database,
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
    const protocol = ticketProtocol(value, {
      run,
      reconcile: vi.fn(),
      observe: validGitObserver().observe,
    });
    await protocol.processOne(
      { ownerId: "executor-40", generation: 1, signal: new AbortController().signal },
      new AbortController().signal,
    );

    expect(executor.snapshot(value.jobId)).toMatchObject({
      integration: { state: "implementing", currentHeadSha: SHA.base },
      outcomes: [],
    });
    expect(value.store.getEffect(value.jobId, executor.snapshot(value.jobId).attempts[0]!.effectIdempotencyKey))
      .toMatchObject({ status: "failed" });
  });

  it("sequentially integrates fresh ticket workers, repairs review findings, and publishes one pull request", async () => {
    const value = fixture();
    let firstAttemptInterrupted = true;
    let secondAttemptMissing = true;
    const resourceEvents: string[] = [];
    const run = vi.fn(async (input: NavigatorTicketWorkerInput) => {
        const resource = input.attempt.resource ?? { kind: "bb_thread" as const, id: `thr_${input.attempt.id}` };
        resourceEvents.push(`run:${resource.id}`);
        if (input.attempt.kind === "implementation" && firstAttemptInterrupted) {
          firstAttemptInterrupted = false;
          throw new NavigatorTicketWorkerRetryableError("worker stopped after durable thread binding", resource);
        }
        if (
          input.attempt.kind === "implementation" && input.attempt.workOrder.ticket.artifactId === value.ticketIds[1] &&
          secondAttemptMissing
        ) {
          secondAttemptMissing = false;
          throw new NavigatorTicketWorkerUnavailableError("missing", resource);
        }
        if (input.attempt.kind === "implementation") {
          const head = input.attempt.ordinal === 1 && input.attempt.workOrder.ticket.artifactId === value.ticketIds[0]
            ? SHA.ticketOne
            : input.attempt.workOrder.ticket.artifactId === value.ticketIds[0]
              ? SHA.repair
              : SHA.ticketTwo;
          return { resource, result: implementationResult(input.attempt, head, input.ticket) };
        }
        const needsRepair = input.attempt.workOrder.verificationOf !== undefined ||
          (input.attempt.workOrder.ticket.artifactId === value.ticketIds[0] && input.attempt.ordinal === 1);
        return { resource, result: reviewResult(input.attempt, needsRepair ? "findings" : "passed") };
      });
    const reconcile = vi.fn(async (input: NavigatorTicketWorkerInput) => {
        const resource = input.attempt.resource ?? { kind: "bb_thread" as const, id: `thr_${input.attempt.id}` };
        resourceEvents.push(`reconcile:${resource.id}`);
        return {
          resource,
          result: {
            kind: "worker_unavailable" as const,
            reason: "missing" as const,
            resourceObservation: {
              resource,
              state: "missing" as const,
              evidenceRef: `bb-resource:${resource.id}:missing`,
              observedAt: value.now(),
            },
          },
        };
      });
    const operation: NavigatorTicketWorkerOperation = {
      run,
      reconcile,
      observe: validGitObserver().observe,
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
      gitObserver: validGitObserver(),
      pullRequests,
      modelRoute: (kind) => ({
        pool: kind === "review" ? "strong" : "standard",
        ...DEFAULT_MODEL_POOL_REGISTRY.worker[kind === "review" ? "strong" : "standard"],
      }),
      clock: { now: value.now },
    });
    const protocol = ticketProtocol(value, operation);
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
    await protocol.processOne(fence, new AbortController().signal);
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
    await protocol.processOne(fence, new AbortController().signal);
    await protocol.processOne(fence, new AbortController().signal);
    await protocol.processOne(fence, new AbortController().signal);
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
    await protocol.processOne(fence, new AbortController().signal);
    await protocol.processOne(fence, new AbortController().signal);
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
    await protocol.processOne(fence, new AbortController().signal);
    value.advance(500);
    await protocol.processOne(fence, new AbortController().signal);
    await protocol.processOne(fence, new AbortController().signal);
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
    const run = vi.fn(async (input: NavigatorTicketWorkerInput) => {
      const resource = input.attempt.resource ?? { kind: "bb_thread" as const, id: `thr_${input.attempt.id}` };
      if (input.attempt.kind === "implementation") {
        return {
          resource,
          result: implementationResult(input.attempt, String(input.attempt.ordinal + 1).repeat(40), input.ticket),
        };
      }
      return { resource, result: reviewResult(input.attempt, "findings") };
    });
    const executor = new NavigatorImplementationExecutor({
      store: value.store,
      database: value.database,
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
    const protocol = ticketProtocol(value, {
      run,
      reconcile: run,
      observe: validGitObserver().observe,
    });
    const fence = { ownerId: "executor-40", generation: 1, signal: new AbortController().signal };
    for (let occurrence = 1; occurrence <= 3; occurrence += 1) {
      await protocol.processOne(fence, new AbortController().signal);
      await protocol.processOne(fence, new AbortController().signal);
      await protocol.processOne(fence, new AbortController().signal);
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
    const run = vi.fn(async (input: NavigatorTicketWorkerInput) => {
        const resource = { kind: "bb_thread" as const, id: `thr_${input.attempt.id}` };
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
        return { resource, result: implementationResult(input.attempt, SHA.ticketOne, input.ticket) };
      });
    const executor = new NavigatorImplementationExecutor({
      store: value.store,
      database: value.database,
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
    const protocol = ticketProtocol(value, {
      run,
      reconcile: vi.fn(),
      observe: validGitObserver().observe,
    });
    await protocol.processOne(
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
