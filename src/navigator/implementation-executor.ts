import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ModelRoute } from "../capabilities/models";
import { CAPABILITY_GRAPH_DIGEST, CAPABILITY_REGISTRY_DIGEST } from "../capabilities/catalog";
import type { StoredEffect } from "../domain/models";
import type { EffectFence } from "../services/effect-runner";
import type { TelegramAgentStore } from "../storage/store";
import type { WorkArtifactClaim } from "../work-artifacts/models";
import {
  NAVIGATOR_TICKET_STEP_CONTRACTS,
  navigatorAcceptanceCriteriaAreSatisfied,
  navigatorCodeReviewResultSchema,
  navigatorGitObservationSchema,
  navigatorImplementationResultSchema,
  navigatorJsonDigest,
  navigatorPersistedTicketStepContractSchema,
  navigatorPullRequestRequestSchema,
  navigatorReviewFindingSchema,
  navigatorTicketWorkerProfile,
  navigatorTicketWorkerProfileSchema,
  navigatorTicketWorkerResultSchema,
  navigatorTicketRepairProposalSchema,
  navigatorTicketRepairSnapshotSchema,
  navigatorTicketWorkOrderSchema,
  parseNavigatorTicketModelRoute,
  type NavigatorPullRequestRecord,
  type NavigatorPullRequestRequest,
  type NavigatorGitObservation,
  type NavigatorPersistedTicketStepContract,
  type NavigatorReviewFinding,
  type NavigatorTicketRepairSnapshot,
  type NavigatorTicketTaskEvidence,
  type NavigatorTicketWorkerProfile,
  type NavigatorTicketWorkerResult,
  type NavigatorTicketWorkOrder,
} from "./implementation-contracts";
import { artifactBindingSchema, type NavigatorArtifactBinding } from "./models";
import {
  navigatorEffectReceiptSchema,
  type NavigatorTicketReceipt,
  type NavigatorTicketSettlementInput,
} from "./effect-contracts";

const GIT_SHA = /^[0-9a-f]{40}$/u;
const IDENTIFIER = /^[A-Za-z0-9_.:/-]{1,256}$/u;

export type NavigatorTicketWorkerAttempt = Readonly<{
  id: string;
  jobId: string;
  sliceId: string;
  kind: "implementation" | "review";
  ordinal: number;
  effectIdempotencyKey: string;
  workOrder: NavigatorTicketWorkOrder;
  workOrderDigest: string;
  stepContract: NavigatorPersistedTicketStepContract;
  profile: NavigatorTicketWorkerProfile;
  modelRoute: ModelRoute;
  resource: { kind: "bb_thread"; id: string } | null;
  capabilityProfileId?: string | null;
  capabilityProfileRevision?: number | null;
  createdAt: number;
  updatedAt: number;
}>;

export type NavigatorTicketWorkerOutcome = Readonly<{
  attemptId: string;
  sliceId: string;
  outcome: "succeeded" | "findings" | "worker_unavailable" | "policy_failure" | "dead_letter";
  reasonCode: string;
  exactHeadSha: string;
  result: unknown;
  resultDigest: string;
  gitObservation: NavigatorGitObservation | null;
  recordedAt: number;
}>;

export type NavigatorTicketWorkerExecution = Readonly<{
  resource: { kind: "bb_thread"; id: string };
  exactHeadSha: string;
  result: unknown;
  gitObservation: NavigatorGitObservation | null;
}>;

type NavigatorTicketSettlementRequest = Readonly<{
  attemptId: string;
  effectKey: string;
  rawResult: unknown;
  rawGitObservation: unknown;
  fence: EffectFence;
  now: number;
  expectedHeadSha?: string;
  receipt?: NavigatorTicketReceipt;
}>;

export type NavigatorIntegrationSnapshot = Readonly<{
  integration: Readonly<{
    jobId: string;
    specification: NavigatorArtifactBinding;
    baseBranch: string;
    integrationBranch: string;
    worktreeId: string;
    baseHeadSha: string;
    currentHeadSha: string;
    state: "implementing" | "invalidated" | "ready_for_pull_request" | "publishing_pull_request" | "ready_for_release";
    activeSliceId: string | null;
    pullRequestNumber: number | null;
    pullRequestUrl: string | null;
    evidenceRefs: readonly string[];
  }>;
  tickets: readonly Readonly<{
    artifactId: string;
    snapshotId: string;
    snapshotDigest: string;
    order: number;
    state: "pending" | "active" | "accepted" | "resolved" | "invalidated";
    acceptedHeadSha: string | null;
  }>[];
  activeSlice: Readonly<{
    id: string;
    ticketArtifactId: string;
    claimId: number;
    state: string;
    acceptedHeadSha: string | null;
  }> | null;
  attempts: readonly NavigatorTicketWorkerAttempt[];
  outcomes: readonly NavigatorTicketWorkerOutcome[];
  findingLedger: readonly NavigatorFindingLedgerEntry[];
}>;

export type NavigatorFindingLedgerEntry = Readonly<{
  rootCauseId: string;
  sliceId: string;
  sourceReviewAttemptId: string;
  verificationAttemptId: string;
  disposition: "must_fix" | "advisory";
  state: "open" | "resolved" | "disputed";
  occurrence: number;
  blockingBurden: number;
  headSha: string;
  finding: NavigatorReviewFinding;
}>;

export interface NavigatorTicketWorkerRunner {
  run(
    attempt: NavigatorTicketWorkerAttempt,
    hooks: Readonly<{ bindResource(resource: { kind: "bb_thread"; id: string }): Promise<void> }>,
    signal: AbortSignal,
  ): Promise<Readonly<{
    resource: { kind: "bb_thread"; id: string };
    result: unknown;
  }>>;
  reconcileUnavailableResource(
    resource: { kind: "bb_thread"; id: string },
    reason: "missing" | "stale",
    signal: AbortSignal,
  ): Promise<Readonly<{
    resource: { kind: "bb_thread"; id: string };
    state: "terminal" | "missing";
    evidenceRef: string;
    observedAt: number;
  }>>;
}

export type NavigatorGitObservationRequest = Readonly<{
  purpose: "implementation" | "review" | "pull_request";
  worktreeId: string;
  integrationBranch: string;
  expectedHeadSha: string;
  baseHeadSha: string;
  comparisonBaseHeadSha: string;
  expectedChangedPaths: readonly string[];
}>;

export interface NavigatorGitObserver {
  observe(request: NavigatorGitObservationRequest): Promise<unknown>;
}

export class NavigatorTicketWorkerUnavailableError extends Error {
  public readonly name = "NavigatorTicketWorkerUnavailableError";

  public constructor(public readonly reason: "missing" | "stale") {
    super(`navigator ticket worker is ${reason}`);
  }
}

export class NavigatorTicketWorkerRetryableError extends Error {
  public readonly name = "NavigatorTicketWorkerRetryableError";
}

export class NavigatorTicketWorkerPermanentError extends Error {
  public readonly name = "NavigatorTicketWorkerPermanentError";
}

export interface NavigatorPullRequestPublisher {
  createOrRefresh(request: NavigatorPullRequestRequest): Promise<NavigatorPullRequestRecord>;
}

type AttemptRow = Readonly<{
  id: string;
  job_id: string;
  slice_id: string;
  kind: "implementation" | "review";
  ordinal: number;
  effect_idempotency_key: string;
  work_order_json: string;
  work_order_digest: string;
  step_contract_id: string;
  step_contract_revision: number;
  step_contract_digest: string;
  step_contract_json: string;
  profile_json: string;
  profile_digest: string;
  model_route_json: string;
  resource_kind: "bb_thread" | null;
  resource_id: string | null;
  created_at: number;
  updated_at: number;
  capability_profile_id: string | null;
  capability_profile_revision: number | null;
}>;

type IntegrationRow = Readonly<{
  job_id: string;
  specification_artifact_id: string;
  specification_snapshot_id: string;
  specification_snapshot_digest: string;
  base_branch: string;
  integration_branch: string;
  worktree_id: string;
  project_policy_version: number;
  project_policy_json: string;
  project_policy_digest: string;
  base_head_sha: string;
  current_head_sha: string;
  state: NavigatorIntegrationSnapshot["integration"]["state"];
  active_slice_id: string | null;
  pull_request_number: number | null;
  pull_request_url: string | null;
  evidence_refs_json: string;
}>;

type TicketRow = Readonly<{
  job_id: string;
  artifact_id: string;
  snapshot_id: string;
  snapshot_digest: string;
  ticket_order: number;
  state: NavigatorIntegrationSnapshot["tickets"][number]["state"];
  accepted_head_sha: string | null;
}>;

type SliceRow = Readonly<{
  id: string;
  job_id: string;
  ticket_artifact_id: string;
  ticket_snapshot_id: string;
  ticket_snapshot_digest: string;
  claim_id: number;
  integration_base_head_sha: string;
  state: string;
  accepted_head_sha: string | null;
}>;

type OutcomeRow = Readonly<{
  attempt_id: string;
  slice_id: string;
  outcome: NavigatorTicketWorkerOutcome["outcome"];
  reason_code: string;
  exact_head_sha: string;
  result_json: string;
  result_digest: string;
  git_observation_json: string | null;
  git_observation_digest: string | null;
  recorded_at: number;
}>;

type FindingEventRow = Readonly<{
  sequence: number;
  id: string;
  job_id: string;
  slice_id: string;
  source_review_attempt_id: string;
  verification_attempt_id: string;
  root_cause_id: string;
  capability_id: string;
  rule_id: string;
  disposition: "must_fix" | "advisory";
  event: "opened" | "reobserved" | "resolved" | "disputed";
  head_sha: string;
  finding_json: string;
  evidence_refs_json: string;
  occurrence: number;
  blocking_burden: number;
  created_at: number;
}>;

type ConvergenceRow = Readonly<{
  slice_id: string;
  last_blocking_burden: number;
  plateau_recoveries: number;
  review_cycles: number;
  updated_at: number;
}>;

type NavigatorImplementationExecutorDependencies = Readonly<{
  store: TelegramAgentStore;
  database: Database.Database;
  workerRunner: NavigatorTicketWorkerRunner;
  gitObserver: NavigatorGitObserver;
  pullRequests: NavigatorPullRequestPublisher;
  modelRoute(kind: "implementation" | "review"): ModelRoute;
  clock: { now(): number };
  leaseMs?: number;
}>;

function assertIdentifier(value: string, field: string): string {
  if (!IDENTIFIER.test(value)) throw new TypeError(`${field} is invalid`);
  return value;
}

function assertGitSha(value: string, field: string): string {
  if (!GIT_SHA.test(value)) throw new TypeError(`${field} must be a full Git SHA`);
  return value;
}

function boundedRefs(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > 128) throw new TypeError("evidenceRefs must be bounded");
  const refs = values.map((value) => {
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > 1_024) throw new TypeError("evidence ref is invalid");
    return normalized;
  });
  if (new Set(refs).size !== refs.length) throw new TypeError("evidence refs contain duplicates");
  return refs;
}

function mergeEvidenceRefs(...groups: readonly (readonly string[])[]): readonly string[] {
  return boundedRefs([...new Set(groups.flat())]);
}

type NavigatorTicketRetryPolicy = Readonly<{
  retryClass: "bounded_exponential";
  maximumAttempts: number;
  backoffBaseMs: number;
  backoffMaximumMs: number;
}>;

function retryPolicy(contract: NavigatorPersistedTicketStepContract): NavigatorTicketRetryPolicy {
  if (
    "retryClass" in contract &&
    contract.retryClass !== undefined && contract.maximumAttempts !== undefined &&
    contract.backoffBaseMs !== undefined && contract.backoffMaximumMs !== undefined
  ) return {
    retryClass: contract.retryClass,
    maximumAttempts: contract.maximumAttempts,
    backoffBaseMs: contract.backoffBaseMs,
    backoffMaximumMs: contract.backoffMaximumMs,
  };
  return {
    retryClass: "bounded_exponential",
    maximumAttempts: 1,
    backoffBaseMs: 1,
    backoffMaximumMs: 1,
  };
}

function retryDelay(
  contract: NavigatorPersistedTicketStepContract,
  attempts: number,
): number {
  const policy = retryPolicy(contract);
  const exponential = policy.backoffBaseMs * 2 ** Math.max(0, attempts - 1);
  return Math.min(policy.backoffMaximumMs, exponential);
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\0"), "utf8").digest("base64url").slice(0, 24)}`;
}

const NAVIGATOR_FINDING_POLICY = Object.freeze({
  "code-review": Object.freeze({ defaultDisposition: "must_fix" as const, mustFixRuleIds: Object.freeze([]) }),
  "clean-code-guard": Object.freeze({
    defaultDisposition: "advisory" as const,
    mustFixRuleIds: Object.freeze(["clean.rule-1"]),
  }),
  "docs-guard": Object.freeze({
    defaultDisposition: "advisory" as const,
    mustFixRuleIds: Object.freeze(["docs.rule-1"]),
  }),
  "test-guard": Object.freeze({
    defaultDisposition: "advisory" as const,
    mustFixRuleIds: Object.freeze(["tests.rule-1"]),
  }),
});

export function navigatorFindingDisposition(
  finding: NavigatorReviewFinding,
): "must_fix" | "advisory" | null {
  const policy = NAVIGATOR_FINDING_POLICY[
    finding.capabilityId as keyof typeof NAVIGATOR_FINDING_POLICY
  ];
  if (!policy) return null;
  return policy.mustFixRuleIds.some((ruleId) => ruleId === finding.ruleId)
    ? "must_fix"
    : policy.defaultDisposition;
}

function findingState(event: FindingEventRow["event"]): NavigatorFindingLedgerEntry["state"] {
  if (event === "opened" || event === "reobserved") return "open";
  return event === "resolved" ? "resolved" : "disputed";
}

function sameRootCause(left: NavigatorReviewFinding, right: NavigatorReviewFinding): boolean {
  return left.rootCauseId === right.rootCauseId && left.capabilityId === right.capabilityId &&
    left.ruleId === right.ruleId && left.subject === right.subject && left.line === right.line &&
    left.requirementId === right.requirementId;
}

function parseRepairSnapshot(rawSnapshot: unknown): NavigatorTicketRepairSnapshot {
  const snapshot = navigatorTicketRepairSnapshotSchema.parse(rawSnapshot);
  const { snapshotId: _snapshotId, digest: _digest, ...payload } = snapshot;
  if (
    navigatorJsonDigest(payload) !== snapshot.digest ||
    stableId("navrepair", snapshot.sliceId, snapshot.reviewAttemptId, snapshot.digest) !== snapshot.snapshotId
  ) throw new Error(`navigator repair snapshot ${snapshot.snapshotId} has invalid durable identity`);
  return snapshot;
}

function parseAttempt(row: AttemptRow): NavigatorTicketWorkerAttempt {
  const workOrder = navigatorTicketWorkOrderSchema.parse(JSON.parse(row.work_order_json));
  const profile = navigatorTicketWorkerProfileSchema.parse(JSON.parse(row.profile_json));
  const stepContract = navigatorPersistedTicketStepContractSchema.parse(JSON.parse(row.step_contract_json));
  const { digest: _digest, ...unsignedContract } = stepContract;
  if (
    navigatorJsonDigest(workOrder) !== row.work_order_digest ||
    stepContract.id !== row.step_contract_id ||
    stepContract.revision !== row.step_contract_revision ||
    stepContract.digest !== row.step_contract_digest ||
    navigatorJsonDigest(unsignedContract) !== stepContract.digest ||
    profile.digest !== row.profile_digest
  ) {
    throw new Error(`navigator ticket attempt ${row.id} has invalid durable identity`);
  }
  return {
    id: row.id,
    jobId: row.job_id,
    sliceId: row.slice_id,
    kind: row.kind,
    ordinal: row.ordinal,
    effectIdempotencyKey: row.effect_idempotency_key,
    workOrder,
    workOrderDigest: row.work_order_digest,
    stepContract,
    profile,
    modelRoute: parseNavigatorTicketModelRoute(JSON.parse(row.model_route_json), row.kind),
    resource: row.resource_kind === null ? null : { kind: row.resource_kind, id: row.resource_id! },
    capabilityProfileId: row.capability_profile_id,
    capabilityProfileRevision: row.capability_profile_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseOutcome(row: OutcomeRow): NavigatorTicketWorkerOutcome {
  const result = JSON.parse(row.result_json) as unknown;
  if (navigatorJsonDigest(result) !== row.result_digest) {
    throw new Error(`navigator ticket outcome ${row.attempt_id} has invalid digest`);
  }
  const gitObservation = row.git_observation_json === null
    ? null
    : navigatorGitObservationSchema.parse(JSON.parse(row.git_observation_json));
  if (
    (gitObservation === null) !== (row.git_observation_digest === null) ||
    (gitObservation !== null && navigatorJsonDigest(gitObservation) !== row.git_observation_digest)
  ) throw new Error(`navigator ticket outcome ${row.attempt_id} has invalid Git observation`);
  return {
    attemptId: row.attempt_id,
    sliceId: row.slice_id,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    exactHeadSha: row.exact_head_sha,
    result,
    resultDigest: row.result_digest,
    gitObservation,
    recordedAt: row.recorded_at,
  };
}

function effectPayload(effect: StoredEffect, key: string): string {
  const value = effect.payload[key];
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(`navigator ticket effect ${key} is invalid`);
  }
  return value;
}

function resultCapabilitiesAreAccepted(
  result: NavigatorTicketWorkerResult,
  profile: NavigatorTicketWorkerProfile,
): boolean {
  const outcomes = new Map(result.capabilityOutcomes.map((outcome) => [outcome.capabilityId, outcome]));
  return outcomes.size === result.capabilityOutcomes.length &&
    profile.assignments.every((selected) => {
      const outcome = outcomes.get(selected.capabilityId)?.outcome;
      return outcome === "passed" || (result.kind === "code_review_result" && result.outcome === "findings" && outcome === "findings");
    }) &&
    result.capabilityOutcomes.every((outcome) =>
      profile.assignments.some((selected) => selected.capabilityId === outcome.capabilityId));
}

export class NavigatorImplementationExecutor {
  private readonly db: Database.Database;

  public constructor(private readonly dependencies: NavigatorImplementationExecutorDependencies) {
    this.db = dependencies.database;
    dependencies.store.registerNavigatorTicketSettlement((input) => this.settleNavigatorTicketWorkerAttempt(input));
  }

  public startIntegration(input: Readonly<{
    jobId: string;
    specificationArtifactId: string;
    implementationTicketIds: readonly string[];
    baseBranch: string;
    integrationBranch: string;
    worktreeId: string;
    baseHeadSha: string;
    evidenceRefs: readonly string[];
  }>): NavigatorIntegrationSnapshot {
    assertIdentifier(input.jobId, "jobId");
    assertIdentifier(input.specificationArtifactId, "specificationArtifactId");
    assertIdentifier(input.baseBranch, "baseBranch");
    assertIdentifier(input.integrationBranch, "integrationBranch");
    assertIdentifier(input.worktreeId, "worktreeId");
    assertGitSha(input.baseHeadSha, "baseHeadSha");
    const evidenceRefs = boundedRefs(input.evidenceRefs);
    if (evidenceRefs.length === 0) throw new TypeError("navigator integration evidence is required");
    if (input.implementationTicketIds.length === 0 || input.implementationTicketIds.length > 128 ||
      new Set(input.implementationTicketIds).size !== input.implementationTicketIds.length) {
      throw new TypeError("implementation ticket ids must be a bounded unique list");
    }
    const job = this.dependencies.store.getJob(input.jobId);
    if (!job || job.workflowEngine !== "navigator-v1" || job.workflowMode !== "deterministic") {
      throw new TypeError("navigator integration requires a deterministic navigator job");
    }
    if (job.policyVersion === null || job.policy === null) {
      throw new TypeError("navigator integration requires an immutable project policy");
    }
    const projectPolicyJson = JSON.stringify(job.policy);
    const projectPolicyDigest = navigatorJsonDigest(job.policy);
    const specification = this.boundCurrentArtifact(job.artifactBindings, input.specificationArtifactId, "specification");
    const tickets = input.implementationTicketIds.map((artifactId) =>
      this.boundCurrentArtifact(job.artifactBindings, artifactId, "implementation_ticket"));
    this.db.transaction(() => {
      const existing = this.integrationRow(input.jobId);
      if (existing) {
        const storedTicketIds = this.ticketRows(input.jobId).map((ticket) => ticket.artifact_id);
        if (
          existing.specification_artifact_id !== specification.artifactId ||
          existing.specification_snapshot_id !== specification.snapshotId ||
          existing.specification_snapshot_digest !== specification.snapshotDigest ||
          existing.project_policy_version !== job.policyVersion ||
          existing.project_policy_digest !== projectPolicyDigest ||
          existing.base_branch !== input.baseBranch ||
          existing.integration_branch !== input.integrationBranch || existing.worktree_id !== input.worktreeId ||
          existing.base_head_sha !== input.baseHeadSha ||
          existing.evidence_refs_json !== JSON.stringify(evidenceRefs) ||
          JSON.stringify(storedTicketIds) !== JSON.stringify(input.implementationTicketIds)
        ) throw new TypeError("navigator integration identity changed during replay");
        return;
      }
      const now = this.dependencies.clock.now();
      this.db.prepare(
        `INSERT INTO navigator_integrations (
           job_id, specification_artifact_id, specification_snapshot_id,
           specification_snapshot_digest, base_branch, integration_branch, worktree_id,
           project_policy_version, project_policy_json, project_policy_digest,
           base_head_sha, current_head_sha, state, active_slice_id,
           pull_request_number, pull_request_url, evidence_refs_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'implementing', NULL, NULL, NULL, ?, ?, ?)`,
      ).run(
        input.jobId,
        specification.artifactId,
        specification.snapshotId,
        specification.snapshotDigest,
        input.baseBranch,
        input.integrationBranch,
        input.worktreeId,
        job.policyVersion,
        projectPolicyJson,
        projectPolicyDigest,
        input.baseHeadSha,
        input.baseHeadSha,
        JSON.stringify(evidenceRefs),
        now,
        now,
      );
      const insertTicket = this.db.prepare(
        `INSERT INTO navigator_integration_tickets (
           job_id, artifact_id, snapshot_id, snapshot_digest, ticket_order,
           state, accepted_head_sha, resolved_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL)`,
      );
      tickets.forEach((ticket, order) => insertTicket.run(
        input.jobId,
        ticket.artifactId,
        ticket.snapshotId,
        ticket.snapshotDigest,
        order,
      ));
    }).immediate();
    return this.snapshot(input.jobId);
  }

  public beginClaimedTicket(input: Readonly<{
    jobId: string;
    ticketArtifactId: string;
    claimId: number;
    taskEvidence: readonly string[];
    evidenceRefs: readonly string[];
    ownerId: string;
    generation: number;
  }>) {
    assertIdentifier(input.jobId, "jobId");
    assertIdentifier(input.ticketArtifactId, "ticketArtifactId");
    if (!Number.isSafeInteger(input.claimId) || input.claimId < 1) throw new TypeError("claimId is invalid");
    const claimEvidenceRefs = boundedRefs(input.evidenceRefs);
    const leaseMs = this.dependencies.leaseMs ?? 30_000;
    const claim = this.dependencies.store.getWorkArtifactClaim(input.claimId);
    const ticketBeforeAdoption = this.requireTicket(input.jobId, input.ticketArtifactId);
    if (
      !claim || claim.jobId !== input.jobId || claim.artifactId !== ticketBeforeAdoption.artifact_id ||
      claim.snapshotId !== ticketBeforeAdoption.snapshot_id ||
      !this.bindingIsCurrent({
        artifactId: ticketBeforeAdoption.artifact_id,
        snapshotId: ticketBeforeAdoption.snapshot_id,
        snapshotDigest: ticketBeforeAdoption.snapshot_digest,
      }) || !this.dependencies.store.adoptWorkArtifactClaim({
        artifactId: claim.artifactId,
        workflowStepId: claim.workflowStepId,
        jobId: input.jobId,
        externalAssignee: claim.externalAssignee,
        ownerId: input.ownerId,
        generation: input.generation,
        expectedOwnerId: claim.ownerId,
        expectedGeneration: claim.generation,
        expectedLeaseExpiresAt: claim.leaseExpiresAt,
        now: this.dependencies.clock.now(),
        leaseMs,
      })
    ) throw new TypeError("implementation ticket claim could not be adopted by the current executor");
    return this.db.transaction(() => {
      const integration = this.requireWritableIntegration(input.jobId);
      const evidenceRefs = mergeEvidenceRefs(
        JSON.parse(integration.evidence_refs_json) as readonly string[],
        claimEvidenceRefs,
      );
      const existing = this.sliceForTicket(input.jobId, input.ticketArtifactId);
      if (existing) {
        if (existing.claim_id !== input.claimId) throw new TypeError("ticket claim changed during replay");
        return this.sliceValue(existing);
      }
      if (integration.active_slice_id !== null) throw new Error("navigator integration already has an active writer");
      const ticket = this.ticketRows(input.jobId).find((candidate) => candidate.artifact_id === input.ticketArtifactId);
      if (!ticket || ticket.state !== "pending" || this.nextEligibleTicket(input.jobId)?.artifact_id !== ticket.artifact_id) {
        throw new TypeError("claimed ticket is not the next eligible implementation ticket");
      }
      const now = this.dependencies.clock.now();
      this.assertClaim({
        claim: this.dependencies.store.getWorkArtifactClaim(input.claimId),
        jobId: input.jobId,
        ticket,
        ownerId: input.ownerId,
        generation: input.generation,
        now,
      });
      const sliceId = stableId("navslice", input.jobId, ticket.artifact_id, ticket.snapshot_digest);
      this.db.prepare(
        `INSERT INTO navigator_ticket_slices (
           id, job_id, ticket_artifact_id, ticket_snapshot_id, ticket_snapshot_digest,
           claim_id, integration_base_head_sha, state, accepted_head_sha, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'implementation_pending', NULL, ?, ?)`,
      ).run(
        sliceId,
        input.jobId,
        ticket.artifact_id,
        ticket.snapshot_id,
        ticket.snapshot_digest,
        input.claimId,
        integration.current_head_sha,
        now,
        now,
      );
      this.db.prepare(
        "UPDATE navigator_integration_tickets SET state = 'active' WHERE job_id = ? AND artifact_id = ?",
      ).run(input.jobId, ticket.artifact_id);
      this.db.prepare(
        "UPDATE navigator_integrations SET active_slice_id = ?, updated_at = ? WHERE job_id = ?",
      ).run(sliceId, now, input.jobId);
      this.createAttempt({
        integration,
        sliceId,
        ticket,
        kind: "implementation",
        ordinal: 1,
        taskEvidence: input.taskEvidence,
        evidenceRefs,
        changedPaths: [],
        baseHeadSha: integration.current_head_sha,
        comparisonBaseHeadSha: integration.current_head_sha,
        now,
      });
      return this.sliceValue(this.requireSlice(sliceId));
    }).immediate();
  }

  public prepareRepairNavigation(input: Readonly<{
    jobId: string;
    ticketArtifactId: string;
    evidenceRefs: readonly string[];
  }>): NavigatorTicketRepairSnapshot {
    return this.db.transaction(() => {
      const integration = this.requireWritableIntegration(input.jobId);
      const slice = this.requireSliceForTicket(input.jobId, input.ticketArtifactId);
      if (slice.state !== "repair_pending" || integration.active_slice_id !== slice.id) {
        throw new TypeError("ticket findings are not awaiting navigator reconsideration");
      }
      const priorReview = this.latestAttempt(slice.id, "review");
      const reviewOutcome = this.getOutcome(priorReview.id);
      if (
        reviewOutcome?.outcome !== "findings" ||
        reviewOutcome.exactHeadSha !== priorReview.workOrder.baseHeadSha ||
        reviewOutcome.gitObservation === null
      ) {
        throw new TypeError("ticket repair navigation requires exact-head review findings");
      }
      const reviewResult = navigatorCodeReviewResultSchema.parse(reviewOutcome.result);
      const existing = this.db.prepare(
        "SELECT snapshot_json FROM navigator_ticket_repair_snapshots WHERE review_attempt_id = ?",
      ).get(priorReview.id) as { snapshot_json: string } | undefined;
      if (existing) return parseRepairSnapshot(JSON.parse(existing.snapshot_json));
      const now = this.dependencies.clock.now();
      const payload = {
        kind: "navigator_ticket_repair_snapshot" as const,
        jobId: input.jobId,
        sliceId: slice.id,
        ticket: priorReview.workOrder.ticket,
        reviewAttemptId: priorReview.id,
        reviewedHeadSha: reviewOutcome.exactHeadSha,
        reviewResultDigest: reviewOutcome.resultDigest,
        gitObservationDigest: navigatorJsonDigest(reviewOutcome.gitObservation),
        findings: reviewResult.findings,
        evidenceRefs: mergeEvidenceRefs(
          priorReview.workOrder.evidenceRefs,
          boundedRefs(input.evidenceRefs),
          [`navigator-result:${priorReview.id}`],
          [reviewOutcome.gitObservation.evidenceRef],
        ),
        createdAt: now,
      };
      const digest = navigatorJsonDigest(payload);
      const snapshot = navigatorTicketRepairSnapshotSchema.parse({
        ...payload,
        snapshotId: stableId("navrepair", slice.id, priorReview.id, digest),
        digest,
      });
      this.db.prepare(
        `INSERT OR IGNORE INTO navigator_ticket_repair_snapshots (
           id, job_id, slice_id, review_attempt_id, snapshot_json, snapshot_digest, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        snapshot.snapshotId,
        input.jobId,
        slice.id,
        priorReview.id,
        JSON.stringify(snapshot),
        snapshot.digest,
        now,
      );
      const stored = this.db.prepare(
        "SELECT snapshot_json, snapshot_digest FROM navigator_ticket_repair_snapshots WHERE id = ?",
      ).get(snapshot.snapshotId) as { snapshot_json: string; snapshot_digest: string } | undefined;
      if (stored?.snapshot_json !== JSON.stringify(snapshot) || stored.snapshot_digest !== snapshot.digest) {
        throw new Error("navigator repair snapshot changed during replay");
      }
      return snapshot;
    }).immediate();
  }

  public recordRepairProposal(input: Readonly<{ snapshotId: string; rawProposal: unknown }>) {
    return this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT snapshot_json FROM navigator_ticket_repair_snapshots WHERE id = ?",
      ).get(input.snapshotId) as { snapshot_json: string } | undefined;
      if (!row) throw new TypeError("navigator repair snapshot was not found");
      const snapshot = parseRepairSnapshot(JSON.parse(row.snapshot_json));
      const proposal = navigatorTicketRepairProposalSchema.parse(input.rawProposal);
      if (proposal.basedOn.snapshotId !== snapshot.snapshotId || proposal.basedOn.digest !== snapshot.digest) {
        throw new TypeError("navigator repair proposal is based on a stale finding snapshot");
      }
      const slice = this.requireSlice(snapshot.sliceId);
      if (slice.state !== "repair_pending" || this.latestAttempt(slice.id, "review").id !== snapshot.reviewAttemptId) {
        throw new TypeError("navigator repair proposal no longer matches the active findings");
      }
      const proposalDigest = navigatorJsonDigest(proposal);
      const proposalId = stableId("navrepairproposal", snapshot.snapshotId, proposalDigest);
      const now = this.dependencies.clock.now();
      this.db.prepare(
        `INSERT OR IGNORE INTO navigator_ticket_repair_proposals (
           id, snapshot_id, route, proposal_json, proposal_digest, decision, accepted_at
         ) VALUES (?, ?, ?, ?, ?, 'accepted', ?)`,
      ).run(
        proposalId,
        snapshot.snapshotId,
        proposal.kind,
        JSON.stringify(proposal),
        proposalDigest,
        now,
      );
      const stored = this.db.prepare(
        `SELECT route, proposal_json, proposal_digest, decision
           FROM navigator_ticket_repair_proposals WHERE id = ?`,
      ).get(proposalId) as {
        route: string;
        proposal_json: string;
        proposal_digest: string;
        decision: string;
      } | undefined;
      if (
        stored?.route !== proposal.kind || stored.proposal_json !== JSON.stringify(proposal) ||
        stored.proposal_digest !== proposalDigest || stored.decision !== "accepted"
      ) throw new Error("navigator repair proposal changed during replay");
      return { proposalId, decision: "accepted" as const, route: proposal.kind };
    }).immediate();
  }

  public scheduleRepair(input: Readonly<{
    jobId: string;
    ticketArtifactId: string;
    proposalId: string;
  }>): NavigatorTicketWorkerAttempt {
    return this.db.transaction(() => {
      const replay = this.db.prepare(
        "SELECT attempt_id FROM navigator_ticket_repair_dispatches WHERE proposal_id = ?",
      ).get(input.proposalId) as { attempt_id: string } | undefined;
      if (replay) return this.getAttempt(replay.attempt_id)!;
      const integration = this.requireWritableIntegration(input.jobId);
      const slice = this.requireSliceForTicket(input.jobId, input.ticketArtifactId);
      if (slice.state !== "repair_pending" || integration.active_slice_id !== slice.id) {
        throw new TypeError("ticket is not awaiting an agent-owned repair");
      }
      const proposalRow = this.db.prepare(
        `SELECT proposal.proposal_json, proposal.proposal_digest, snapshot.snapshot_json
           FROM navigator_ticket_repair_proposals AS proposal
           JOIN navigator_ticket_repair_snapshots AS snapshot ON snapshot.id = proposal.snapshot_id
          WHERE proposal.id = ? AND proposal.decision = 'accepted'`,
      ).get(input.proposalId) as {
        proposal_json: string;
        proposal_digest: string;
        snapshot_json: string;
      } | undefined;
      if (!proposalRow) throw new TypeError("repair requires a newly accepted navigator proposal");
      const proposal = navigatorTicketRepairProposalSchema.parse(JSON.parse(proposalRow.proposal_json));
      const snapshot = parseRepairSnapshot(JSON.parse(proposalRow.snapshot_json));
      if (
        navigatorJsonDigest(proposal) !== proposalRow.proposal_digest ||
        proposal.kind !== "implementation" || snapshot.jobId !== input.jobId || snapshot.sliceId !== slice.id ||
        snapshot.ticket.artifactId !== input.ticketArtifactId ||
        this.latestAttempt(slice.id, "review").id !== snapshot.reviewAttemptId
      ) throw new TypeError("accepted navigator proposal does not select this exact-head repair");
      const ticket = this.requireTicket(input.jobId, input.ticketArtifactId);
      const ordinal = this.nextAttemptOrdinal(slice.id, "implementation");
      const priorReview = this.latestAttempt(slice.id, "review");
      const evidenceRefs = mergeEvidenceRefs(
        priorReview.workOrder.evidenceRefs,
        proposal.evidenceRefs,
        [`navigator-result:${priorReview.id}`],
        [`navigator-repair-proposal:${input.proposalId}`],
      );
      const now = this.dependencies.clock.now();
      const attempt = this.createAttempt({
        integration,
        sliceId: slice.id,
        ticket,
        kind: "implementation",
        ordinal,
        taskEvidence: proposal.taskEvidence,
        evidenceRefs,
        changedPaths: priorReview.workOrder.changedPaths,
        baseHeadSha: integration.current_head_sha,
        comparisonBaseHeadSha: slice.integration_base_head_sha,
        now,
      });
      this.db.prepare(
        "UPDATE navigator_ticket_slices SET state = 'implementation_pending', updated_at = ? WHERE id = ?",
      ).run(now, slice.id);
      this.db.prepare(
        `INSERT INTO navigator_ticket_repair_dispatches (proposal_id, attempt_id, dispatched_at)
         VALUES (?, ?, ?)`,
      ).run(input.proposalId, attempt.id, now);
      return attempt;
    }).immediate();
  }

  public async processOne(fence: EffectFence, signal: AbortSignal): Promise<boolean> {
    const now = this.dependencies.clock.now();
    const effect = this.leaseEffect(fence, now);
    if (!effect) return false;
    return this.processLeased(effect, fence, signal);
  }

  public async executeAttempt(
    attempt: NavigatorTicketWorkerAttempt,
    signal: AbortSignal,
  ): Promise<NavigatorTicketWorkerExecution> {
    const execution = await this.dependencies.workerRunner.run(attempt, { bindResource: async () => undefined }, signal);
    const gitObservation = await this.observeAttemptGit(attempt, execution.result);
    const parsedObservation = navigatorGitObservationSchema.safeParse(gitObservation);
    const parsedResult = navigatorTicketWorkerResultSchema.safeParse(execution.result);
    const exactHeadSha = parsedObservation.success
      ? parsedObservation.data.headSha
      : parsedResult.success && parsedResult.data.kind === "implementation_result"
        ? parsedResult.data.headSha
        : parsedResult.success && parsedResult.data.kind === "code_review_result"
          ? parsedResult.data.reviewedHeadSha
          : attempt.workOrder.baseHeadSha;
    return {
      resource: execution.resource,
      exactHeadSha,
      result: execution.result,
      gitObservation: parsedObservation.success ? parsedObservation.data : null,
    };
  }

  public settleNavigatorTicketWorkerAttempt(
    input: NavigatorTicketSettlementInput,
  ): NavigatorTicketWorkerOutcome | null {
    const receipt = navigatorEffectReceiptSchema.safeParse(input.receipt);
    if (!receipt.success || receipt.data.kind !== "run_navigator_ticket_worker") return null;
    const fence: EffectFence = {
      ownerId: input.ownerId,
      generation: input.generation,
      signal: new AbortController().signal,
    };
    return this.settleAttempt({
      attemptId: input.attemptId,
      effectKey: input.effectIdempotencyKey,
      rawResult: receipt.data.result,
      rawGitObservation: receipt.data.gitObservation,
      fence,
      now: input.now,
      expectedHeadSha: receipt.data.exactHeadSha,
      receipt: receipt.data,
    });
  }

  public async processLeased(effect: StoredEffect, fence: EffectFence, signal: AbortSignal): Promise<boolean> {
    const now = this.dependencies.clock.now();
    const attemptId = effectPayload(effect, "attemptId");
    const attempt = this.getAttempt(attemptId);
    if (!attempt || attempt.effectIdempotencyKey !== effect.idempotencyKey) {
      this.finishEffect(effect, fence, now, "dead", "navigator ticket attempt identity is unavailable");
      return true;
    }
    if (!(["worktree", "commit", "push", "pull_request"] as const).every((operation) =>
      this.dependencies.store.taskAuthorityOperationIsCurrent(effect, operation))) {
      this.finishEffect(effect, fence, now, "dead", "task authority effect admission is absent, stale, or denied");
      return true;
    }
    const leaseMs = this.dependencies.leaseMs ?? 30_000;
    if (!this.adoptAttemptClaim(attempt, fence, now, leaseMs)) {
      this.settleClaimFenceFailure(attempt, effect, fence, now);
      return true;
    }
    const leaseAbort = new AbortController();
    const timeoutAbort = new AbortController();
    const runSignal = AbortSignal.any([signal, fence.signal, leaseAbort.signal, timeoutAbort.signal]);
    const interruption = new Promise<never>((_resolve, reject) => {
      if (runSignal.aborted) {
        reject(runSignal.reason ?? new Error("navigator ticket worker was aborted"));
        return;
      }
      runSignal.addEventListener("abort", () => {
        reject(runSignal.reason ?? new Error("navigator ticket worker was aborted"));
      }, { once: true });
    });
    const timeout = setTimeout(() => {
      timeoutAbort.abort(new Error("navigator ticket worker timed out"));
    }, attempt.stepContract.timeoutMs);
    const renewal = setInterval(() => {
      try {
        const operationRenewed = this.dependencies.store.renewJobOperationFences({
          jobId: effect.jobId,
          effectIdempotencyKey: effect.idempotencyKey,
          ownerId: fence.ownerId,
          generation: fence.generation,
          now: this.dependencies.clock.now(),
          leaseMs,
        });
        const claimRenewed = this.renewAttemptClaim(attempt, fence, this.dependencies.clock.now(), leaseMs);
        if ((!operationRenewed || !claimRenewed) && !leaseAbort.signal.aborted) {
          leaseAbort.abort(new Error("navigator ticket worker lease was lost"));
        }
      } catch (renewalError) {
        if (!leaseAbort.signal.aborted) leaseAbort.abort(renewalError);
      }
    }, Math.max(1, Math.min(10_000, Math.floor(leaseMs / 3))));
    try {
      const run = await Promise.race([
        this.dependencies.workerRunner.run(attempt, {
          bindResource: async (resource) => {
            if (!this.bindResource(attempt.id, effect.idempotencyKey, resource, fence, this.dependencies.clock.now())) {
              throw new Error("navigator ticket worker resource binding was lost");
            }
          },
        }, runSignal),
        interruption,
      ]);
      if (!this.bindResource(attempt.id, effect.idempotencyKey, run.resource, fence, this.dependencies.clock.now())) {
        throw new Error("navigator ticket worker returned a different resource");
      }
      const gitObservation = await this.observeAttemptGit(attempt, run.result);
      this.settleAttempt({
        attemptId: attempt.id,
        effectKey: effect.idempotencyKey,
        rawResult: run.result,
        rawGitObservation: gitObservation,
        fence,
        now: this.dependencies.clock.now(),
      });
    } catch (error) {
      if (error instanceof NavigatorTicketWorkerUnavailableError) {
        try {
          const observation = await this.reconcileUnavailableResource(attempt, error.reason, runSignal);
          this.replaceUnavailableAttempt(
            attempt,
            effect,
            error.reason,
            observation,
            fence,
            this.dependencies.clock.now(),
          );
        } catch (reconciliationError) {
          this.settleWorkerFailure(attempt, effect, reconciliationError, fence, this.dependencies.clock.now());
        }
        return true;
      }
      this.settleWorkerFailure(attempt, effect, error, fence, this.dependencies.clock.now());
    } finally {
      clearInterval(renewal);
      clearTimeout(timeout);
    }
    return true;
  }

  public markTicketResolved(input: Readonly<{ jobId: string; ticketArtifactId: string }>): NavigatorIntegrationSnapshot {
    return this.db.transaction(() => {
      const integration = this.integrationRow(input.jobId);
      if (!integration || integration.state !== "implementing") throw new TypeError("integration is not accepting ticket resolution");
      const slice = this.requireSliceForTicket(input.jobId, input.ticketArtifactId);
      if (slice.state !== "accepted") throw new TypeError("ticket has no accepted review outcome");
      const review = this.latestAttempt(slice.id, "review");
      const outcome = this.getOutcome(review.id);
      const resolution = this.dependencies.store.getWorkArtifactResolution(input.ticketArtifactId);
      if (
        outcome?.outcome !== "succeeded" ||
        outcome.gitObservation?.headSha !== review.workOrder.baseHeadSha ||
        resolution?.outcome !== "resolved" ||
        resolution.snapshotId !== slice.ticket_snapshot_id ||
        !resolution.evidenceRefs.includes(`navigator-result:${review.id}`)
      ) throw new TypeError("ticket closure is not bound to its accepted review evidence");
      const now = this.dependencies.clock.now();
      this.db.prepare(
        "UPDATE navigator_ticket_slices SET state = 'resolved', updated_at = ? WHERE id = ?",
      ).run(now, slice.id);
      this.db.prepare(
        `UPDATE navigator_integration_tickets
            SET state = 'resolved', resolved_at = ?
          WHERE job_id = ? AND artifact_id = ?`,
      ).run(now, input.jobId, input.ticketArtifactId);
      const pending = this.db.prepare(
        "SELECT 1 FROM navigator_integration_tickets WHERE job_id = ? AND state <> 'resolved' LIMIT 1",
      ).get(input.jobId);
      this.db.prepare(
        `UPDATE navigator_integrations
            SET active_slice_id = NULL, state = ?, updated_at = ?
          WHERE job_id = ?`,
      ).run(pending ? "implementing" : "ready_for_pull_request", now, input.jobId);
      return this.snapshot(input.jobId);
    }).immediate();
  }

  public async publishPullRequest(input: Readonly<{
    jobId: string;
    title: string;
    body: string;
  }>): Promise<NavigatorPullRequestRecord> {
    const request = await this.preparePullRequest(input);
    const existing = this.pullRequestRow(input.jobId);
    if (existing?.status === "published") return this.publishedPullRequest(existing);
    const published = await this.dependencies.pullRequests.createOrRefresh(request);
    if (
      published.operationId !== request.operationId || published.jobId !== request.jobId ||
      published.headSha !== request.headSha ||
      !Number.isSafeInteger(published.number) || published.number < 1 || published.url.trim().length === 0
    ) throw new TypeError("pull request publisher returned an invalid exact-head result");
    return this.db.transaction(() => {
      const current = this.pullRequestRow(input.jobId);
      if (!current || current.request_digest !== navigatorJsonDigest(request)) {
        throw new Error("pull request request changed before settlement");
      }
      if (current.status === "published") return this.publishedPullRequest(current);
      const now = this.dependencies.clock.now();
      this.db.prepare(
        `UPDATE navigator_pull_requests
            SET status = 'published', number = ?, url = ?, settled_at = ?
          WHERE job_id = ? AND status = 'pending'`,
      ).run(published.number, published.url, now, input.jobId);
      this.db.prepare(
        `UPDATE navigator_integrations
            SET state = 'ready_for_release', pull_request_number = ?, pull_request_url = ?, updated_at = ?
          WHERE job_id = ? AND state = 'publishing_pull_request' AND current_head_sha = ?`,
      ).run(published.number, published.url, now, input.jobId, request.headSha);
      return this.publishedPullRequest(this.pullRequestRow(input.jobId)!);
    }).immediate();
  }

  public snapshot(jobId: string): NavigatorIntegrationSnapshot {
    const integration = this.integrationRow(jobId);
    if (!integration) throw new Error(`navigator integration ${jobId} was not found`);
    const tickets = this.ticketRows(jobId);
    const attempts = this.db.prepare(
      "SELECT * FROM navigator_ticket_worker_attempts WHERE job_id = ? ORDER BY created_at, id",
    ).all(jobId) as AttemptRow[];
    const outcomes = this.db.prepare(
      `SELECT outcome.* FROM navigator_ticket_worker_outcomes AS outcome
        JOIN navigator_ticket_worker_attempts AS attempt ON attempt.id = outcome.attempt_id
       WHERE attempt.job_id = ? ORDER BY outcome.recorded_at, outcome.attempt_id`,
    ).all(jobId) as OutcomeRow[];
    const activeSlice = integration.active_slice_id === null ? null : this.requireSlice(integration.active_slice_id);
    return {
      integration: {
        jobId: integration.job_id,
        specification: {
          artifactId: integration.specification_artifact_id,
          snapshotId: integration.specification_snapshot_id,
          snapshotDigest: integration.specification_snapshot_digest,
        },
        baseBranch: integration.base_branch,
        integrationBranch: integration.integration_branch,
        worktreeId: integration.worktree_id,
        baseHeadSha: integration.base_head_sha,
        currentHeadSha: integration.current_head_sha,
        state: integration.state,
        activeSliceId: integration.active_slice_id,
        pullRequestNumber: integration.pull_request_number,
        pullRequestUrl: integration.pull_request_url,
        evidenceRefs: JSON.parse(integration.evidence_refs_json) as readonly string[],
      },
      tickets: tickets.map((ticket) => ({
        artifactId: ticket.artifact_id,
        snapshotId: ticket.snapshot_id,
        snapshotDigest: ticket.snapshot_digest,
        order: ticket.ticket_order,
        state: ticket.state,
        acceptedHeadSha: ticket.accepted_head_sha,
      })),
      activeSlice: activeSlice === null ? null : this.sliceValue(activeSlice),
      attempts: attempts.map(parseAttempt),
      outcomes: outcomes.map(parseOutcome),
      findingLedger: this.currentFindingLedger(jobId),
    };
  }

  private currentFindingRows(jobId: string, sliceId?: string): FindingEventRow[] {
    return this.db.prepare(
      `SELECT event.*
         FROM navigator_review_finding_events AS event
        WHERE event.job_id = ?
          AND (? IS NULL OR event.slice_id = ?)
          AND event.sequence = (
            SELECT MAX(newest.sequence)
              FROM navigator_review_finding_events AS newest
             WHERE newest.slice_id = event.slice_id
               AND newest.root_cause_id = event.root_cause_id
          )
        ORDER BY event.slice_id, event.root_cause_id`,
    ).all(jobId, sliceId ?? null, sliceId ?? null) as FindingEventRow[];
  }

  private currentFindingLedger(jobId: string, sliceId?: string): NavigatorFindingLedgerEntry[] {
    return this.currentFindingRows(jobId, sliceId).map((row) => ({
      rootCauseId: row.root_cause_id,
      sliceId: row.slice_id,
      sourceReviewAttemptId: row.source_review_attempt_id,
      verificationAttemptId: row.verification_attempt_id,
      disposition: row.disposition,
      state: findingState(row.event),
      occurrence: row.occurrence,
      blockingBurden: row.blocking_burden,
      headSha: row.head_sha,
      finding: navigatorReviewFindingSchema.parse(JSON.parse(row.finding_json)),
    }));
  }

  private appendFindingEvent(input: Readonly<{
    attempt: NavigatorTicketWorkerAttempt;
    sourceReviewAttemptId: string;
    finding: NavigatorReviewFinding;
    disposition: "must_fix" | "advisory";
    event: FindingEventRow["event"];
    occurrence: number;
    blockingBurden: number;
    evidenceRefs: readonly string[];
    now: number;
  }>): void {
    const eventId = stableId(
      "navfinding",
      input.attempt.id,
      input.finding.rootCauseId,
      input.event,
    );
    this.db.prepare(
      `INSERT INTO navigator_review_finding_events (
         id, job_id, slice_id, source_review_attempt_id, verification_attempt_id,
         root_cause_id, capability_id, rule_id, disposition, event, head_sha,
         finding_json, evidence_refs_json, occurrence, blocking_burden, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      eventId,
      input.attempt.jobId,
      input.attempt.sliceId,
      input.sourceReviewAttemptId,
      input.attempt.id,
      input.finding.rootCauseId,
      input.finding.capabilityId,
      input.finding.ruleId,
      input.disposition,
      input.event,
      input.attempt.workOrder.baseHeadSha,
      JSON.stringify(input.finding),
      JSON.stringify(boundedRefs(input.evidenceRefs)),
      input.occurrence,
      input.blockingBurden,
      input.now,
    );
  }

  private recordPassingReview(
    attempt: NavigatorTicketWorkerAttempt,
    result: Readonly<{ axes: { requirements: { evidenceRefs: readonly string[] }; standards: { evidenceRefs: readonly string[] } } }>,
    now: number,
  ): string | null {
    const current = this.currentFindingRows(attempt.jobId, attempt.sliceId);
    const convergence = this.db.prepare(
      "SELECT * FROM navigator_review_convergence WHERE slice_id = ?",
    ).get(attempt.sliceId) as ConvergenceRow | undefined;
    const reviewCycles = (convergence?.review_cycles ?? 0) + 1;
    if (reviewCycles > attempt.workOrder.projectPolicy.maxReviewCycles) return "review_cycle_limit";
    for (const row of current) {
      if (findingState(row.event) !== "open") continue;
      const finding = navigatorReviewFindingSchema.parse(JSON.parse(row.finding_json));
      this.appendFindingEvent({
        attempt,
        sourceReviewAttemptId: attempt.id,
        finding,
        disposition: row.disposition,
        event: "resolved",
        occurrence: row.occurrence,
        blockingBurden: 0,
        evidenceRefs: mergeEvidenceRefs(
          result.axes.requirements.evidenceRefs,
          result.axes.standards.evidenceRefs,
          [`navigator-result:${attempt.id}`],
        ),
        now,
      });
    }
    this.db.prepare(
      `INSERT INTO navigator_review_convergence (
         slice_id, last_blocking_burden, plateau_recoveries, review_cycles, updated_at
       ) VALUES (?, 0, ?, ?, ?)
       ON CONFLICT(slice_id) DO UPDATE SET
         last_blocking_burden = 0,
         review_cycles = excluded.review_cycles,
         updated_at = excluded.updated_at`,
    ).run(attempt.sliceId, convergence?.plateau_recoveries ?? 0, reviewCycles, now);
    return null;
  }

  private recordFindingVerification(
    attempt: NavigatorTicketWorkerAttempt,
    result: Readonly<{ findings: readonly NavigatorReviewFinding[] }>,
    now: number,
  ): Readonly<{ blockingBurden: number; policyFailureReason: string | null }> {
    const verification = attempt.workOrder.verificationOf;
    if (verification === undefined) return { blockingBurden: 0, policyFailureReason: "finding_verification_source_missing" };
    const source = new Map(verification.findings.map((finding) => [finding.rootCauseId, finding]));
    const selectedCapabilities = new Set(attempt.profile.assignments.map(({ capabilityId }) => capabilityId));
    const dispositions = new Map<string, "must_fix" | "advisory">();
    for (const finding of verification.findings) {
      const disposition = navigatorFindingDisposition(finding);
      if (disposition === null || !selectedCapabilities.has(finding.capabilityId)) {
        return { blockingBurden: 0, policyFailureReason: "finding_policy_unregistered" };
      }
      dispositions.set(finding.rootCauseId, disposition);
    }
    const confirmed = new Map<string, NavigatorReviewFinding>();
    for (const finding of result.findings) {
      const reported = source.get(finding.rootCauseId);
      if (reported === undefined || confirmed.has(finding.rootCauseId) || !sameRootCause(reported, finding)) {
        return { blockingBurden: 0, policyFailureReason: "finding_verification_mismatch" };
      }
      confirmed.set(finding.rootCauseId, finding);
    }
    const currentRows = this.currentFindingRows(attempt.jobId, attempt.sliceId);
    const current = new Map(currentRows.map((row) => [row.root_cause_id, row]));
    const next = new Map(currentRows.map((row) => [row.root_cause_id, {
      disposition: row.disposition,
      state: findingState(row.event),
      occurrence: row.occurrence,
    }]));
    for (const finding of verification.findings) {
      const prior = current.get(finding.rootCauseId);
      const disposition = dispositions.get(finding.rootCauseId)!;
      const isConfirmed = confirmed.has(finding.rootCauseId);
      next.set(finding.rootCauseId, {
        disposition,
        state: isConfirmed ? "open" as const : "disputed" as const,
        occurrence: isConfirmed ? Math.min(3, (prior?.occurrence ?? 0) + 1) : prior?.occurrence ?? 0,
      });
    }
    for (const row of currentRows) {
      if (findingState(row.event) === "open" && !source.has(row.root_cause_id)) {
        next.set(row.root_cause_id, {
          disposition: row.disposition,
          state: "resolved",
          occurrence: row.occurrence,
        });
      }
    }
    const blockingBurden = [...next.values()].filter((entry) =>
      entry.state === "open" && entry.disposition === "must_fix").length;
    const evidenceRefs = mergeEvidenceRefs(
      result.findings.flatMap((finding) => finding.evidenceRefs),
      [`navigator-result:${attempt.id}`],
      [`navigator-result:${verification.attemptId}`],
    );
    for (const finding of verification.findings) {
      const prior = current.get(finding.rootCauseId);
      const isConfirmed = confirmed.has(finding.rootCauseId);
      this.appendFindingEvent({
        attempt,
        sourceReviewAttemptId: verification.attemptId,
        finding: isConfirmed ? confirmed.get(finding.rootCauseId)! : finding,
        disposition: dispositions.get(finding.rootCauseId)!,
        event: isConfirmed ? (prior && findingState(prior.event) === "open" ? "reobserved" : "opened") : "disputed",
        occurrence: next.get(finding.rootCauseId)!.occurrence,
        blockingBurden,
        evidenceRefs,
        now,
      });
    }
    for (const row of currentRows) {
      if (findingState(row.event) !== "open" || source.has(row.root_cause_id)) continue;
      this.appendFindingEvent({
        attempt,
        sourceReviewAttemptId: verification.attemptId,
        finding: navigatorReviewFindingSchema.parse(JSON.parse(row.finding_json)),
        disposition: row.disposition,
        event: "resolved",
        occurrence: row.occurrence,
        blockingBurden,
        evidenceRefs,
        now,
      });
    }
    const convergence = this.db.prepare(
      "SELECT * FROM navigator_review_convergence WHERE slice_id = ?",
    ).get(attempt.sliceId) as ConvergenceRow | undefined;
    const reviewCycles = (convergence?.review_cycles ?? 0) + 1;
    let plateauRecoveries = convergence?.plateau_recoveries ?? 0;
    let policyFailureReason: string | null = null;
    if ([...next.values()].some((entry) => entry.state === "open" && entry.occurrence >= 3)) {
      policyFailureReason = "finding_recurrence_limit";
    } else if (reviewCycles > attempt.workOrder.projectPolicy.maxReviewCycles) {
      policyFailureReason = "review_cycle_limit";
    } else if (
      convergence !== undefined && convergence.last_blocking_burden > 0 &&
      blockingBurden >= convergence.last_blocking_burden
    ) {
      if (plateauRecoveries === 0) plateauRecoveries = 1;
      else policyFailureReason = "review_burden_plateau";
    }
    this.db.prepare(
      `INSERT INTO navigator_review_convergence (
         slice_id, last_blocking_burden, plateau_recoveries, review_cycles, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(slice_id) DO UPDATE SET
         last_blocking_burden = excluded.last_blocking_burden,
         plateau_recoveries = excluded.plateau_recoveries,
         review_cycles = excluded.review_cycles,
         updated_at = excluded.updated_at`,
    ).run(attempt.sliceId, blockingBurden, plateauRecoveries, reviewCycles, now);
    return { blockingBurden, policyFailureReason };
  }

  private boundCurrentArtifact(
    bindings: readonly NavigatorArtifactBinding[],
    artifactId: string,
    kind: "specification" | "implementation_ticket",
  ): NavigatorArtifactBinding {
    const binding = bindings.find((candidate) => candidate.artifactId === artifactId);
    const artifact = this.dependencies.store.getWorkArtifact(artifactId);
    const snapshot = this.dependencies.store.getCurrentWorkArtifactSnapshot(artifactId);
    if (
      !binding || artifact?.kind !== kind || snapshot?.id !== binding.snapshotId ||
      snapshot.snapshotDigest !== binding.snapshotDigest ||
      !this.dependencies.store.isWorkArtifactSnapshotValid(binding.snapshotId)
    ) throw new TypeError(`navigator integration ${kind} binding is stale or unavailable`);
    return artifactBindingSchema.parse(binding);
  }

  private requireWritableIntegration(jobId: string): IntegrationRow {
    const integration = this.integrationRow(jobId);
    if (!integration || integration.state !== "implementing") {
      throw new TypeError("navigator integration is not writable");
    }
    if (!this.bindingIsCurrent({
      artifactId: integration.specification_artifact_id,
      snapshotId: integration.specification_snapshot_id,
      snapshotDigest: integration.specification_snapshot_digest,
    })) {
      this.invalidateIntegration(integration, "stale_specification", this.dependencies.clock.now());
      throw new TypeError("navigator integration specification snapshot is stale");
    }
    return integration;
  }

  private ticketIsEligible(jobId: string, ticket: TicketRow): boolean {
    const relationships = this.dependencies.store.listWorkArtifactRelationships(ticket.artifact_id);
    const parent = this.integrationRow(jobId)?.specification_artifact_id;
    if (!relationships.some((relationship) =>
      relationship.kind === "parent" && relationship.targetArtifactId === parent)) return false;
    return relationships.filter((relationship) => relationship.kind === "blocks").every((relationship) => {
      const blocker = relationship.sourceArtifactId === null
        ? null
        : this.dependencies.store.getWorkArtifact(relationship.sourceArtifactId);
      return blocker !== null && (blocker.status === "resolved" || blocker.status === "cancelled") &&
        blocker.externalStatus !== "open";
    });
  }

  private nextEligibleTicket(jobId: string): TicketRow | null {
    return this.ticketRows(jobId).find((ticket) =>
      ticket.state === "pending" && this.ticketIsEligible(jobId, ticket)) ?? null;
  }

  private assertClaim(input: Readonly<{
    claim: WorkArtifactClaim | null;
    jobId: string;
    ticket: TicketRow;
    ownerId: string;
    generation: number;
    now: number;
  }>): void {
    if (
      !input.claim || input.claim.state !== "held" || input.claim.jobId !== input.jobId ||
      input.claim.artifactId !== input.ticket.artifact_id || input.claim.snapshotId !== input.ticket.snapshot_id ||
      input.claim.ownerId !== input.ownerId || input.claim.generation !== input.generation ||
      input.claim.leaseExpiresAt <= input.now ||
      !this.bindingIsCurrent({
        artifactId: input.ticket.artifact_id,
        snapshotId: input.ticket.snapshot_id,
        snapshotDigest: input.ticket.snapshot_digest,
      })
    ) throw new TypeError("implementation ticket claim is stale or belongs to another lane");
  }

  private adoptAttemptClaim(
    attempt: NavigatorTicketWorkerAttempt,
    fence: EffectFence,
    now: number,
    leaseMs: number,
  ): boolean {
    const slice = this.requireSlice(attempt.sliceId);
    const claim = this.dependencies.store.getWorkArtifactClaim(slice.claim_id);
    return claim !== null && this.dependencies.store.adoptWorkArtifactClaim({
      artifactId: claim.artifactId,
      workflowStepId: claim.workflowStepId,
      jobId: attempt.jobId,
      externalAssignee: claim.externalAssignee,
      ownerId: fence.ownerId,
      generation: fence.generation,
      expectedOwnerId: claim.ownerId,
      expectedGeneration: claim.generation,
      expectedLeaseExpiresAt: claim.leaseExpiresAt,
      now,
      leaseMs,
    });
  }

  private renewAttemptClaim(
    attempt: NavigatorTicketWorkerAttempt,
    fence: EffectFence,
    now: number,
    leaseMs: number,
  ): boolean {
    return this.dependencies.store.renewWorkArtifactClaim({
      claimId: this.requireSlice(attempt.sliceId).claim_id,
      ownerId: fence.ownerId,
      generation: fence.generation,
      now,
      leaseMs,
    });
  }

  private claimFenceIsCurrent(attempt: NavigatorTicketWorkerAttempt, fence: EffectFence, now: number): boolean {
    const slice = this.requireSlice(attempt.sliceId);
    const ticket = this.requireTicket(attempt.jobId, attempt.workOrder.ticket.artifactId);
    try {
      this.assertClaim({
        claim: this.dependencies.store.getWorkArtifactClaim(slice.claim_id),
        jobId: attempt.jobId,
        ticket,
        ownerId: fence.ownerId,
        generation: fence.generation,
        now,
      });
      return true;
    } catch (error) {
      if (error instanceof TypeError) return false;
      throw error;
    }
  }

  private settleClaimFenceFailure(
    attempt: NavigatorTicketWorkerAttempt,
    effect: StoredEffect,
    fence: EffectFence,
    now: number,
  ): void {
    const settle = () => {
      if (!this.effectLeaseCurrent(effect.idempotencyKey, fence, now) || this.getOutcome(attempt.id)) return;
      const result = { kind: "policy_failure", reasonCode: "claim_fence_lost" } as const;
      this.db.prepare(
        `INSERT INTO navigator_ticket_worker_outcomes (
           attempt_id, slice_id, outcome, reason_code, exact_head_sha,
           result_json, result_digest, recorded_at
         ) VALUES (?, ?, 'policy_failure', 'claim_fence_lost', ?, ?, ?, ?)`,
      ).run(
        attempt.id,
        attempt.sliceId,
        attempt.workOrder.baseHeadSha,
        JSON.stringify(result),
        navigatorJsonDigest(result),
        now,
      );
      this.invalidateIntegration(this.integrationRow(attempt.jobId)!, "claim_fence_lost", now);
      this.finishEffect(effect, fence, now, "done", null);
    };
    if (this.db.inTransaction) settle();
    else this.db.transaction(settle).immediate();
  }

  private createAttempt(input: Readonly<{
    integration: IntegrationRow;
    sliceId: string;
    ticket: TicketRow;
    kind: "implementation" | "review";
    ordinal: number;
    taskEvidence: readonly string[];
    evidenceRefs: readonly string[];
    changedPaths: readonly string[];
    baseHeadSha: string;
    comparisonBaseHeadSha: string;
    now: number;
    effectAttempts?: number;
    nextAttemptAt?: number;
    verificationOf?: Readonly<{
      attemptId: string;
      resultDigest: string;
      findings: readonly NavigatorReviewFinding[];
    }>;
  }>): NavigatorTicketWorkerAttempt {
    const workOrder = navigatorTicketWorkOrderSchema.parse({
      kind: "navigator_ticket_work_order",
      jobId: input.integration.job_id,
      integrationBranch: input.integration.integration_branch,
      baseBranch: input.integration.base_branch,
      worktreeId: input.integration.worktree_id,
      baseHeadSha: input.baseHeadSha,
      comparisonBaseHeadSha: input.comparisonBaseHeadSha,
      projectPolicyVersion: input.integration.project_policy_version,
      projectPolicy: JSON.parse(input.integration.project_policy_json),
      projectPolicyDigest: input.integration.project_policy_digest,
      specification: {
        artifactId: input.integration.specification_artifact_id,
        snapshotId: input.integration.specification_snapshot_id,
        snapshotDigest: input.integration.specification_snapshot_digest,
      },
      ticket: {
        artifactId: input.ticket.artifact_id,
        snapshotId: input.ticket.snapshot_id,
        snapshotDigest: input.ticket.snapshot_digest,
      },
      taskEvidence: input.taskEvidence,
      evidenceRefs: input.evidenceRefs,
      changedPaths: input.changedPaths,
      ...(input.verificationOf === undefined ? {} : { verificationOf: input.verificationOf }),
    });
    const profile = navigatorTicketWorkerProfile({
      kind: input.kind,
      taskEvidence: input.taskEvidence,
      changedPaths: input.changedPaths,
    });
    const stepContract = NAVIGATOR_TICKET_STEP_CONTRACTS[input.kind];
    const route = parseNavigatorTicketModelRoute(this.dependencies.modelRoute(input.kind), input.kind);
    const attemptId = stableId("navworker", input.sliceId, input.kind, String(input.ordinal));
    const effectKey = `${input.integration.job_id}:navigator-ticket:${attemptId}`;
    const capabilityProfile = this.dependencies.store.createCapabilityProfile({
      subjectKind: "worker_attempt",
      subjectId: attemptId,
      threadId: null,
      recipeId: "navigator-v1",
      recipeVersion: 1,
      registryDigest: CAPABILITY_REGISTRY_DIGEST,
      graphDigest: CAPABILITY_GRAPH_DIGEST,
      mode: "active",
      model: route,
      assignments: profile.assignments.map((assignment) => ({
        capabilityId: assignment.capabilityId,
        capabilityKind: "skill" as const,
        descriptorDigest: assignment.descriptorDigest,
        mandatory: assignment.mandatory,
      })),
      reasonCodes: ["navigator_effect_admission"],
      traits: [],
      now: input.now,
    });
    this.db.prepare(
      `INSERT INTO effects (
         idempotency_key, job_id, kind, payload_json, status, attempts,
         next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, 'run_navigator_ticket_worker', ?, 'pending', ?, ?, ?, ?)`,
    ).run(
      effectKey,
      input.integration.job_id,
      JSON.stringify({ attemptId, sliceId: input.sliceId }),
      input.effectAttempts ?? 0,
      input.nextAttemptAt ?? input.now,
      input.now,
      input.now,
    );
    this.db.prepare(
      `INSERT INTO navigator_ticket_worker_attempts (
         id, job_id, slice_id, kind, ordinal, effect_idempotency_key,
         work_order_json, work_order_digest, step_contract_id, step_contract_revision,
         step_contract_digest, step_contract_json, profile_json, profile_digest, model_route_json,
         capability_profile_id, capability_profile_revision, resource_kind, resource_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      attemptId,
      input.integration.job_id,
      input.sliceId,
      input.kind,
      input.ordinal,
      effectKey,
      JSON.stringify(workOrder),
      navigatorJsonDigest(workOrder),
      stepContract.id,
      stepContract.revision,
      stepContract.digest,
      JSON.stringify(stepContract),
      JSON.stringify(profile),
      profile.digest,
      JSON.stringify(route),
      capabilityProfile.id,
      capabilityProfile.revision,
      input.now,
      input.now,
    );
    this.dependencies.store.recordNavigatorCapabilityEvidence({
      effectIdempotencyKey: effectKey,
      jobId: input.integration.job_id,
      projectId: (JSON.parse(input.integration.project_policy_json) as { projectId: string }).projectId,
      operation: "worktree_write",
      profileId: capabilityProfile.id,
      profileRevision: capabilityProfile.revision,
      assignments: profile.assignments.map((assignment) => ({
        capabilityId: assignment.capabilityId,
        capabilityKind: "skill" as const,
        descriptorDigest: assignment.descriptorDigest,
      })),
      now: input.now,
    });
    return this.getAttempt(attemptId)!;
  }

  private leaseEffect(fence: EffectFence, now: number): StoredEffect | null {
    const leaseMs = this.dependencies.leaseMs ?? 30_000;
    return this.db.transaction(() => {
      if (!this.dependencies.store.isExecutorLeaseCurrent(fence.ownerId, fence.generation, now)) return null;
      const row = this.db.prepare(
        `SELECT effect.* FROM effects AS effect
          JOIN navigator_ticket_worker_attempts AS attempt
            ON attempt.effect_idempotency_key = effect.idempotency_key
          JOIN navigator_integrations AS integration ON integration.job_id = attempt.job_id
         WHERE effect.kind = 'run_navigator_ticket_worker'
           AND integration.state = 'implementing'
           AND NOT EXISTS (
             SELECT 1 FROM navigator_ticket_worker_outcomes AS outcome WHERE outcome.attempt_id = attempt.id
           )
           AND ((effect.status IN ('pending', 'failed') AND effect.next_attempt_at <= ?)
             OR (effect.status = 'leased' AND effect.lease_expires_at <= ?))
         ORDER BY effect.created_at, effect.idempotency_key LIMIT 1`,
      ).get(now, now) as Parameters<typeof this.parseEffect>[0] | undefined;
      if (!row) return null;
      const pendingEffect = this.parseEffect(row);
      if (!(["worktree", "commit", "push", "pull_request"] as const).every((operation) =>
        this.dependencies.store.admitTaskAuthorityOperation(
          pendingEffect,
          operation,
          now,
        ))) return null;
      const changed = this.db.prepare(
        `UPDATE effects SET status = 'leased', lease_owner = ?, lease_generation = ?,
             lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
          WHERE idempotency_key = ? AND (
            (status IN ('pending', 'failed') AND next_attempt_at <= ?)
            OR (status = 'leased' AND lease_expires_at <= ?)
          )`,
      ).run(fence.ownerId, fence.generation, now + leaseMs, now, row.idempotency_key, now, now);
      return changed.changes === 1
        ? this.parseEffect(this.db.prepare("SELECT * FROM effects WHERE idempotency_key = ?").get(row.idempotency_key) as Parameters<typeof this.parseEffect>[0])
        : null;
    }).immediate();
  }

  private parseEffect(row: Readonly<{
    idempotency_key: string;
    job_id: string;
    kind: StoredEffect["kind"];
    payload_json: string;
    status: StoredEffect["status"];
    attempts: number;
    lease_owner: string | null;
    lease_generation: number | null;
    lease_expires_at: number | null;
    next_attempt_at: number;
    last_error: string | null;
    created_at: number;
    updated_at: number;
  }>): StoredEffect {
    return {
      idempotencyKey: row.idempotency_key,
      jobId: row.job_id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      status: row.status,
      attempts: row.attempts,
      leaseOwner: row.lease_owner,
      leaseGeneration: row.lease_generation,
      leaseExpiresAt: row.lease_expires_at,
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private bindResource(
    attemptId: string,
    effectKey: string,
    resource: { kind: "bb_thread"; id: string },
    fence: EffectFence,
    now: number,
  ): boolean {
    assertIdentifier(resource.id, "worker resource id");
    return this.db.transaction(() => {
      if (!this.effectLeaseCurrent(effectKey, fence, now)) return false;
      const attempt = this.getAttempt(attemptId);
      if (!attempt || attempt.effectIdempotencyKey !== effectKey) return false;
      if (attempt.resource !== null) return attempt.resource.id === resource.id;
      const bound = this.db.prepare(
        `UPDATE navigator_ticket_worker_attempts
            SET resource_kind = 'bb_thread', resource_id = ?, updated_at = ?
          WHERE id = ? AND resource_id IS NULL`,
      ).run(resource.id, now, attemptId).changes === 1;
      if (!bound) return false;
      this.db.prepare(
        "UPDATE navigator_ticket_slices SET state = ?, updated_at = ? WHERE id = ?",
      ).run(attempt.kind === "implementation" ? "implementation_running" : "review_running", now, attempt.sliceId);
      return true;
    }).immediate();
  }

  private settleAttempt(input: NavigatorTicketSettlementRequest): NavigatorTicketWorkerOutcome | null {
    return this.db.transaction(() => {
      if (!this.effectLeaseCurrent(input.effectKey, input.fence, input.now)) return null;
      const attempt = this.getAttempt(input.attemptId);
      if (!attempt || attempt.effectIdempotencyKey !== input.effectKey) return null;
      if (input.receipt !== undefined && (
        input.receipt.effectIdempotencyKey !== input.effectKey || input.receipt.attemptId !== attempt.id
      )) return null;
      const receiptResource = input.receipt?.resource ?? attempt.resource;
      if (receiptResource === null) return null;
      if (attempt.resource !== null && (
        attempt.resource.kind !== receiptResource.kind || attempt.resource.id !== receiptResource.id
      )) return null;
      if (attempt.resource === null) {
        const bound = this.db.prepare(
          `UPDATE navigator_ticket_worker_attempts
            SET resource_kind = 'bb_thread', resource_id = ?, updated_at = ?
            WHERE id = ? AND effect_idempotency_key = ? AND resource_id IS NULL`,
        ).run(receiptResource.id, input.now, attempt.id, input.effectKey);
        if (bound.changes !== 1) return null;
      }
      const existing = this.getOutcome(input.attemptId);
      if (existing) return existing;
      if (!this.claimFenceIsCurrent(attempt, input.fence, input.now)) {
        const effect = this.parseEffect(this.db.prepare(
          "SELECT * FROM effects WHERE idempotency_key = ?",
        ).get(input.effectKey) as Parameters<typeof this.parseEffect>[0]);
        this.settleClaimFenceFailure(attempt, effect, input.fence, input.now);
        return this.getOutcome(attempt.id);
      }
      const rawResultJson = JSON.stringify(input.rawResult);
      const resultTooLarge = rawResultJson !== undefined &&
        Buffer.byteLength(rawResultJson, "utf8") > attempt.stepContract.maximumResultBytes;
      const parsed = navigatorTicketWorkerResultSchema.safeParse(resultTooLarge ? undefined : input.rawResult);
      const parsedGit = navigatorGitObservationSchema.safeParse(input.rawGitObservation);
      const integration = this.integrationRow(attempt.jobId)!;
      let outcome: NavigatorTicketWorkerOutcome["outcome"] = "succeeded";
      let reasonCode = "accepted";
      let verifiedBlockingBurden: number | null = null;
      let result: unknown = parsed.success ? parsed.data : { kind: "policy_failure", reasonCode: "malformed_result" };
      if (resultTooLarge) {
        outcome = "policy_failure";
        reasonCode = "result_too_large";
        result = { kind: "policy_failure", reasonCode };
      } else if (!parsed.success || parsed.data.kind !== (attempt.kind === "implementation" ? "implementation_result" : "code_review_result")) {
        outcome = "policy_failure";
        reasonCode = "malformed_result";
      } else if (!this.bindingIsCurrent(attempt.workOrder.specification)) {
        outcome = "policy_failure";
        reasonCode = "stale_specification";
      } else if (!this.bindingIsCurrent(attempt.workOrder.ticket)) {
        outcome = "policy_failure";
        reasonCode = "stale_ticket";
      } else if (!resultCapabilitiesAreAccepted(parsed.data, attempt.profile)) {
        outcome = "policy_failure";
        reasonCode = "capability_outcome_missing";
      } else if (!parsedGit.success || !this.gitObservationMatches(attempt, parsed.data, parsedGit.data)) {
        outcome = "policy_failure";
        reasonCode = "git_observation_rejected";
      } else if (parsed.data.kind === "implementation_result") {
        const ticketSnapshot = this.dependencies.store.getWorkArtifactSnapshot(attempt.workOrder.ticket.snapshotId);
        if (
          parsed.data.baseHeadSha !== attempt.workOrder.baseHeadSha ||
          parsed.data.headSha === attempt.workOrder.baseHeadSha ||
          integration.current_head_sha !== attempt.workOrder.baseHeadSha ||
          ticketSnapshot === null ||
          !navigatorAcceptanceCriteriaAreSatisfied(ticketSnapshot, parsed.data.acceptanceCriteria) ||
          parsed.data.focusedVerification.some((receipt) => receipt.outcome !== "passed") ||
          parsed.data.fullVerification.some((receipt) => receipt.outcome !== "passed")
        ) {
          outcome = "policy_failure";
          reasonCode = parsed.data.headSha === attempt.workOrder.baseHeadSha
            ? "implementation_head_not_advanced"
            : integration.current_head_sha !== attempt.workOrder.baseHeadSha
              ? "integration_head_drift"
              : "implementation_evidence_rejected";
        }
      } else if (parsed.data.reviewedHeadSha !== attempt.workOrder.baseHeadSha) {
        outcome = "policy_failure";
        reasonCode = "review_head_mismatch";
      } else if (attempt.workOrder.verificationOf !== undefined) {
        const sourceOutcome = this.getOutcome(attempt.workOrder.verificationOf.attemptId);
        if (
          sourceOutcome?.outcome !== "findings" ||
          sourceOutcome.resultDigest !== attempt.workOrder.verificationOf.resultDigest ||
          sourceOutcome.exactHeadSha !== attempt.workOrder.baseHeadSha
        ) {
          outcome = "policy_failure";
          reasonCode = "finding_verification_source_mismatch";
        } else {
          const verified = this.recordFindingVerification(attempt, parsed.data, input.now);
          verifiedBlockingBurden = verified.blockingBurden;
          if (verified.policyFailureReason !== null) {
            outcome = "policy_failure";
            reasonCode = verified.policyFailureReason;
          } else if (verified.blockingBurden > 0) {
            outcome = "findings";
            reasonCode = "confirmed_review_findings";
          } else {
            outcome = "succeeded";
            reasonCode = parsed.data.findings.length > 0 ? "accepted_advisories" : "findings_disputed";
          }
        }
      } else if (parsed.data.outcome === "findings") {
        outcome = "findings";
        reasonCode = "review_findings_unverified";
      } else {
        const convergenceFailure = this.recordPassingReview(attempt, parsed.data, input.now);
        if (convergenceFailure !== null) {
          outcome = "policy_failure";
          reasonCode = convergenceFailure;
        }
      }
      const resultDigest = navigatorJsonDigest(result);
      const gitObservation = parsedGit.success ? parsedGit.data : null;
      const gitObservationDigest = gitObservation === null ? null : navigatorJsonDigest(gitObservation);
      const exactHeadSha = gitObservation?.headSha ?? (
        parsed.success && parsed.data.kind === "implementation_result"
          ? parsed.data.headSha
          : attempt.workOrder.baseHeadSha
      );
      if (input.expectedHeadSha !== undefined && input.expectedHeadSha !== exactHeadSha) {
        throw new Error("navigator ticket receipt head changed before settlement");
      }
      if (input.receipt !== undefined) this.recordTicketReceipt(input.receipt, attempt.jobId, input.fence, input.now);
      this.db.prepare(
        `INSERT INTO navigator_ticket_worker_outcomes (
           attempt_id, slice_id, outcome, reason_code, exact_head_sha,
           result_json, result_digest, git_observation_json, git_observation_digest, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        attempt.id,
        attempt.sliceId,
        outcome,
        reasonCode,
        exactHeadSha,
        JSON.stringify(result),
        resultDigest,
        gitObservation === null ? null : JSON.stringify(gitObservation),
        gitObservationDigest,
        input.now,
      );
      if (outcome === "policy_failure") {
        this.invalidateIntegration(integration, reasonCode, input.now);
      } else if (attempt.kind === "implementation") {
        const implementationResult = navigatorImplementationResultSchema.parse(result);
        this.acceptImplementation(attempt, implementationResult.headSha, implementationResult.changedPaths, input.now);
      } else if (
        outcome === "findings" && attempt.workOrder.verificationOf === undefined
      ) {
        const reviewResult = navigatorCodeReviewResultSchema.parse(result);
        this.scheduleFindingVerification(attempt, reviewResult, resultDigest, input.now);
      } else if (outcome === "findings" && verifiedBlockingBurden !== null) {
        this.db.prepare(
          "UPDATE navigator_ticket_slices SET state = 'repair_pending', updated_at = ? WHERE id = ?",
        ).run(input.now, attempt.sliceId);
      } else {
        navigatorCodeReviewResultSchema.parse(result);
        this.db.prepare(
          "UPDATE navigator_ticket_slices SET state = 'accepted', accepted_head_sha = ?, updated_at = ? WHERE id = ?",
        ).run(exactHeadSha, input.now, attempt.sliceId);
        this.db.prepare(
          `UPDATE navigator_integration_tickets
              SET state = 'accepted', accepted_head_sha = ?
            WHERE job_id = ? AND artifact_id = ?`,
        ).run(exactHeadSha, attempt.jobId, attempt.workOrder.ticket.artifactId);
      }
      this.finishEffectByKey(input.effectKey, input.fence, input.now, "done", null);
      return this.getOutcome(attempt.id);
    }).immediate();
  }

  private recordTicketReceipt(
    receipt: NavigatorTicketReceipt,
    jobId: string,
    fence: EffectFence,
    now: number,
  ): void {
    const receiptJson = JSON.stringify(receipt);
    this.db.prepare(
      `INSERT INTO navigator_effect_receipts (
         effect_idempotency_key, job_id, kind, receipt_json, receipt_digest,
         owner_id, generation, recorded_at
       ) VALUES (?, ?, 'run_navigator_ticket_worker', ?, ?, ?, ?, ?)`,
    ).run(
      receipt.effectIdempotencyKey,
      jobId,
      receiptJson,
      createHash("sha256").update(receiptJson, "utf8").digest("hex"),
      fence.ownerId,
      fence.generation,
      now,
    );
  }

  private async observeAttemptGit(
    attempt: NavigatorTicketWorkerAttempt,
    rawResult: unknown,
  ): Promise<unknown> {
    const parsed = navigatorTicketWorkerResultSchema.safeParse(rawResult);
    if (!parsed.success) return null;
    const expectedHeadSha = parsed.data.kind === "implementation_result"
      ? parsed.data.headSha
      : parsed.data.reviewedHeadSha;
    const expectedChangedPaths = parsed.data.kind === "implementation_result"
      ? parsed.data.changedPaths
      : attempt.workOrder.changedPaths;
    return this.dependencies.gitObserver.observe({
      purpose: attempt.kind,
      worktreeId: attempt.workOrder.worktreeId,
      integrationBranch: attempt.workOrder.integrationBranch,
      expectedHeadSha,
      baseHeadSha: attempt.workOrder.baseHeadSha,
      comparisonBaseHeadSha: attempt.workOrder.comparisonBaseHeadSha,
      expectedChangedPaths,
    });
  }

  private gitObservationMatches(
    attempt: NavigatorTicketWorkerAttempt,
    result: NavigatorTicketWorkerResult,
    observation: NavigatorGitObservation,
  ): boolean {
    const expectedHeadSha = result.kind === "implementation_result" ? result.headSha : result.reviewedHeadSha;
    const expectedChangedPaths = result.kind === "implementation_result"
      ? result.changedPaths
      : attempt.workOrder.changedPaths;
    return observation.worktreeId === attempt.workOrder.worktreeId &&
      observation.branch === attempt.workOrder.integrationBranch &&
      observation.headSha === expectedHeadSha &&
      observation.baseHeadSha === attempt.workOrder.baseHeadSha &&
      observation.baseHeadIsAncestor &&
      observation.comparisonBaseHeadSha === attempt.workOrder.comparisonBaseHeadSha &&
      observation.comparisonBaseHeadIsAncestor && observation.clean &&
      JSON.stringify(observation.changedPaths) === JSON.stringify(expectedChangedPaths);
  }

  private acceptImplementation(
    attempt: NavigatorTicketWorkerAttempt,
    headSha: string,
    changedPaths: readonly string[],
    now: number,
  ): void {
    const integration = this.integrationRow(attempt.jobId)!;
    this.db.prepare(
      "UPDATE navigator_integrations SET current_head_sha = ?, updated_at = ? WHERE job_id = ?",
    ).run(headSha, now, attempt.jobId);
    this.db.prepare(
      "UPDATE navigator_ticket_slices SET state = 'review_pending', updated_at = ? WHERE id = ?",
    ).run(now, attempt.sliceId);
    const ticket = this.requireTicket(attempt.jobId, attempt.workOrder.ticket.artifactId);
    const nextIntegration = this.integrationRow(attempt.jobId)!;
    this.createAttempt({
      integration: nextIntegration,
      sliceId: attempt.sliceId,
      ticket,
      kind: "review",
      ordinal: this.nextAttemptOrdinal(attempt.sliceId, "review"),
      taskEvidence: attempt.workOrder.taskEvidence,
      evidenceRefs: mergeEvidenceRefs(attempt.workOrder.evidenceRefs, [`navigator-result:${attempt.id}`]),
      changedPaths,
      baseHeadSha: headSha,
      comparisonBaseHeadSha: this.requireSlice(attempt.sliceId).integration_base_head_sha,
      now,
    });
  }

  private scheduleFindingVerification(
    attempt: NavigatorTicketWorkerAttempt,
    result: Readonly<{ findings: readonly NavigatorReviewFinding[] }>,
    resultDigest: string,
    now: number,
  ): void {
    const integration = this.integrationRow(attempt.jobId)!;
    const ticket = this.requireTicket(attempt.jobId, attempt.workOrder.ticket.artifactId);
    this.db.prepare(
      "UPDATE navigator_ticket_slices SET state = 'review_pending', updated_at = ? WHERE id = ?",
    ).run(now, attempt.sliceId);
    this.createAttempt({
      integration,
      sliceId: attempt.sliceId,
      ticket,
      kind: "review",
      ordinal: this.nextAttemptOrdinal(attempt.sliceId, "review"),
      taskEvidence: attempt.workOrder.taskEvidence,
      evidenceRefs: mergeEvidenceRefs(
        attempt.workOrder.evidenceRefs,
        [`navigator-result:${attempt.id}`],
        [`navigator-verify:${attempt.id}`],
      ),
      changedPaths: attempt.workOrder.changedPaths,
      baseHeadSha: attempt.workOrder.baseHeadSha,
      comparisonBaseHeadSha: attempt.workOrder.comparisonBaseHeadSha,
      verificationOf: {
        attemptId: attempt.id,
        resultDigest,
        findings: result.findings,
      },
      now,
    });
  }

  private replaceUnavailableAttempt(
    attempt: NavigatorTicketWorkerAttempt,
    effect: StoredEffect,
    reason: "missing" | "stale",
    resourceObservation: Readonly<{
      resource: { kind: "bb_thread"; id: string } | null;
      state: "terminal" | "missing";
      evidenceRef: string;
      observedAt: number;
    }>,
    fence: EffectFence,
    now: number,
  ): void {
    this.db.transaction(() => {
      if (!this.effectLeaseCurrent(effect.idempotencyKey, fence, now) || this.getOutcome(attempt.id) !== null) return;
      const integration = this.integrationRow(attempt.jobId);
      if (!integration || integration.state !== "implementing") return;
      const staleReason = !this.bindingIsCurrent(attempt.workOrder.specification)
        ? "stale_specification"
        : !this.bindingIsCurrent(attempt.workOrder.ticket)
          ? "stale_ticket"
          : null;
      if (staleReason !== null) {
        const staleResult = { kind: "policy_failure", reasonCode: staleReason } as const;
        this.db.prepare(
          `INSERT INTO navigator_ticket_worker_outcomes (
             attempt_id, slice_id, outcome, reason_code, exact_head_sha,
             result_json, result_digest, recorded_at
           ) VALUES (?, ?, 'policy_failure', ?, ?, ?, ?, ?)`,
        ).run(
          attempt.id,
          attempt.sliceId,
          staleReason,
          attempt.workOrder.baseHeadSha,
          JSON.stringify(staleResult),
          navigatorJsonDigest(staleResult),
          now,
        );
        this.invalidateIntegration(integration, staleReason, now);
        this.finishEffect(effect, fence, now, "done", null);
        return;
      }
      if (effect.attempts >= retryPolicy(attempt.stepContract).maximumAttempts) {
        this.deadLetterAttempt(
          attempt,
          effect,
          "retry_exhausted",
          `Navigator ticket worker remained unavailable (${reason})`,
          fence,
          now,
          { reason, resourceObservation },
        );
        return;
      }
      const result = { kind: "worker_unavailable", reason, resourceObservation } as const;
      this.db.prepare(
        `INSERT INTO navigator_ticket_worker_outcomes (
           attempt_id, slice_id, outcome, reason_code, exact_head_sha,
           result_json, result_digest, recorded_at
         ) VALUES (?, ?, 'worker_unavailable', ?, ?, ?, ?, ?)`,
      ).run(
        attempt.id,
        attempt.sliceId,
        `worker_${reason}`,
        attempt.workOrder.baseHeadSha,
        JSON.stringify(result),
        navigatorJsonDigest(result),
        now,
      );
      this.finishEffect(effect, fence, now, "done", null);
      this.createAttempt({
        integration,
        sliceId: attempt.sliceId,
        ticket: this.requireTicket(attempt.jobId, attempt.workOrder.ticket.artifactId),
        kind: attempt.kind,
        ordinal: this.nextAttemptOrdinal(attempt.sliceId, attempt.kind),
        taskEvidence: attempt.workOrder.taskEvidence,
        evidenceRefs: mergeEvidenceRefs(attempt.workOrder.evidenceRefs, [`navigator-result:${attempt.id}`]),
        changedPaths: attempt.workOrder.changedPaths,
        baseHeadSha: attempt.workOrder.baseHeadSha,
        comparisonBaseHeadSha: attempt.workOrder.comparisonBaseHeadSha,
        now,
        effectAttempts: effect.attempts,
        nextAttemptAt: now + retryDelay(attempt.stepContract, effect.attempts),
      });
      this.db.prepare(
        "UPDATE navigator_ticket_slices SET state = ?, updated_at = ? WHERE id = ?",
      ).run(attempt.kind === "implementation" ? "implementation_pending" : "review_pending", now, attempt.sliceId);
    }).immediate();
  }

  private async reconcileUnavailableResource(
    attempt: NavigatorTicketWorkerAttempt,
    reason: "missing" | "stale",
    signal: AbortSignal,
  ): Promise<Readonly<{
    resource: { kind: "bb_thread"; id: string } | null;
    state: "terminal" | "missing";
    evidenceRef: string;
    observedAt: number;
  }>> {
    if (attempt.resource === null) {
      return {
        resource: null,
        state: "missing",
        evidenceRef: `navigator-resource:${attempt.id}:unbound`,
        observedAt: this.dependencies.clock.now(),
      };
    }
    const observation = await this.dependencies.workerRunner.reconcileUnavailableResource(
      attempt.resource,
      reason,
      signal,
    );
    if (
      observation.resource.kind !== "bb_thread" ||
      observation.resource.id !== attempt.resource.id ||
      (observation.state !== "terminal" && observation.state !== "missing") ||
      observation.evidenceRef.trim().length === 0 || observation.evidenceRef.length > 1_024 ||
      !Number.isSafeInteger(observation.observedAt) || observation.observedAt < 0
    ) throw new TypeError("unavailable worker reconciliation returned invalid terminal evidence");
    return observation;
  }

  private settleWorkerFailure(
    attempt: NavigatorTicketWorkerAttempt,
    effect: StoredEffect,
    error: unknown,
    fence: EffectFence,
    now: number,
  ): void {
    if (!this.effectLeaseCurrent(effect.idempotencyKey, fence, now)) return;
    const rawSummary = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const summary = rawSummary.replace(/\s+/gu, " ").trim().slice(0, 500) || "Navigator ticket worker failed";
    const permanent = error instanceof NavigatorTicketWorkerPermanentError;
    if (permanent || effect.attempts >= retryPolicy(attempt.stepContract).maximumAttempts) {
      this.deadLetterAttempt(
        attempt,
        effect,
        permanent ? "permanent_failure" : "retry_exhausted",
        summary,
        fence,
        now,
      );
      return;
    }
    this.finishEffect(effect, fence, now, "failed", summary, now + retryDelay(attempt.stepContract, effect.attempts));
  }

  private deadLetterAttempt(
    attempt: NavigatorTicketWorkerAttempt,
    effect: StoredEffect,
    reasonCode: "permanent_failure" | "retry_exhausted",
    summary: string,
    fence: EffectFence,
    now: number,
    details: Readonly<Record<string, unknown>> = {},
  ): void {
    const settle = () => {
      if (!this.effectLeaseCurrent(effect.idempotencyKey, fence, now) || this.getOutcome(attempt.id)) return;
      const result = {
        kind: "worker_failure",
        retryClass: retryPolicy(attempt.stepContract).retryClass,
        attempts: effect.attempts,
        summary,
        ...details,
      };
      this.db.prepare(
        `INSERT INTO navigator_ticket_worker_outcomes (
           attempt_id, slice_id, outcome, reason_code, exact_head_sha,
           result_json, result_digest, recorded_at
         ) VALUES (?, ?, 'dead_letter', ?, ?, ?, ?, ?)`,
      ).run(
        attempt.id,
        attempt.sliceId,
        reasonCode,
        attempt.workOrder.baseHeadSha,
        JSON.stringify(result),
        navigatorJsonDigest(result),
        now,
      );
      this.invalidateIntegration(this.integrationRow(attempt.jobId)!, reasonCode, now);
      this.finishEffect(effect, fence, now, "dead", summary);
    };
    if (this.db.inTransaction) settle();
    else this.db.transaction(settle).immediate();
  }

  private async preparePullRequest(
    input: Readonly<{ jobId: string; title: string; body: string }>,
  ): Promise<NavigatorPullRequestRequest> {
    const observedIntegration = this.integrationRow(input.jobId);
    if (!observedIntegration || !["ready_for_pull_request", "publishing_pull_request", "ready_for_release"].includes(observedIntegration.state)) {
      throw new TypeError("navigator integration is not ready for one final pull request");
    }
    const existingRequest = this.pullRequestRow(input.jobId);
    if (existingRequest) return navigatorPullRequestRequestSchema.parse(JSON.parse(existingRequest.request_json));
    const expectedChangedPaths = this.acceptedGitObservations(input.jobId)
      .flatMap((observation) => observation.changedPaths)
      .filter((path, index, paths) => paths.indexOf(path) === index)
      .sort((left, right) => left.localeCompare(right));
    const rawGitObservation = await this.dependencies.gitObserver.observe({
      purpose: "pull_request",
      worktreeId: observedIntegration.worktree_id,
      integrationBranch: observedIntegration.integration_branch,
      expectedHeadSha: observedIntegration.current_head_sha,
      baseHeadSha: observedIntegration.base_head_sha,
      comparisonBaseHeadSha: observedIntegration.base_head_sha,
      expectedChangedPaths,
    });
    const gitObservation = navigatorGitObservationSchema.parse(rawGitObservation);
    if (!this.integrationGitObservationMatches({
      integration: observedIntegration,
      observation: gitObservation,
      expectedChangedPaths,
    })) {
      throw new TypeError("pull request Git observation does not match the owned integration branch");
    }
    return this.db.transaction(() => {
      let integration = this.integrationRow(input.jobId);
      if (!integration || !["ready_for_pull_request", "publishing_pull_request", "ready_for_release"].includes(integration.state)) {
        throw new TypeError("navigator integration is not ready for one final pull request");
      }
      if (!this.bindingIsCurrent({
        artifactId: integration.specification_artifact_id,
        snapshotId: integration.specification_snapshot_id,
        snapshotDigest: integration.specification_snapshot_digest,
      })) {
        this.invalidateIntegration(integration, "stale_specification", this.dependencies.clock.now());
        throw new TypeError("navigator integration specification changed before pull request publication");
      }
      const existing = this.pullRequestRow(input.jobId);
      if (existing) return navigatorPullRequestRequestSchema.parse(JSON.parse(existing.request_json));
      if (integration.current_head_sha !== observedIntegration.current_head_sha) {
        throw new Error("integration head changed during pull request Git observation");
      }
      const outcomeRefs = this.db.prepare(
        `SELECT 'navigator-result:' || outcome.attempt_id AS evidence_ref
           FROM navigator_ticket_worker_outcomes AS outcome
           JOIN navigator_ticket_worker_attempts AS attempt ON attempt.id = outcome.attempt_id
          WHERE attempt.job_id = ? AND outcome.outcome = 'succeeded'
          ORDER BY outcome.recorded_at, outcome.attempt_id`,
      ).all(input.jobId) as Array<{ evidence_ref: string }>;
      const request = navigatorPullRequestRequestSchema.parse({
        operationId: stableId("navigator-pr", input.jobId, integration.current_head_sha),
        jobId: input.jobId,
        baseBranch: integration.base_branch,
        integrationBranch: integration.integration_branch,
        headSha: integration.current_head_sha,
        title: input.title,
        body: input.body,
        gitObservation,
        gitObservationDigest: navigatorJsonDigest(gitObservation),
        evidenceRefs: mergeEvidenceRefs(
          outcomeRefs.map((row) => row.evidence_ref),
          this.acceptedGitObservations(input.jobId).map((observation) => observation.evidenceRef),
          [gitObservation.evidenceRef],
        ),
      });
      const now = this.dependencies.clock.now();
      this.db.prepare(
        `INSERT INTO navigator_pull_requests (
           job_id, operation_id, request_json, request_digest, status,
           number, url, head_sha, created_at, settled_at
         ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL)`,
      ).run(
        input.jobId,
        request.operationId,
        JSON.stringify(request),
        navigatorJsonDigest(request),
        request.headSha,
        now,
      );
      this.db.prepare(
        "UPDATE navigator_integrations SET state = 'publishing_pull_request', updated_at = ? WHERE job_id = ?",
      ).run(now, input.jobId);
      integration = this.integrationRow(input.jobId)!;
      return request;
    }).immediate();
  }

  private acceptedGitObservations(jobId: string): NavigatorGitObservation[] {
    const rows = this.db.prepare(
      `SELECT outcome.git_observation_json
         FROM navigator_ticket_worker_outcomes AS outcome
         JOIN navigator_ticket_worker_attempts AS attempt ON attempt.id = outcome.attempt_id
        WHERE attempt.job_id = ? AND outcome.outcome = 'succeeded'
          AND outcome.git_observation_json IS NOT NULL
        ORDER BY outcome.recorded_at, outcome.attempt_id`,
    ).all(jobId) as Array<{ git_observation_json: string }>;
    return rows.map((row) => navigatorGitObservationSchema.parse(JSON.parse(row.git_observation_json)));
  }

  private integrationGitObservationMatches(input: Readonly<{
    integration: IntegrationRow;
    observation: NavigatorGitObservation;
    expectedChangedPaths: readonly string[];
  }>): boolean {
    const { integration, observation } = input;
    return observation.worktreeId === integration.worktree_id &&
      observation.branch === integration.integration_branch &&
      observation.headSha === integration.current_head_sha &&
      observation.baseHeadSha === integration.base_head_sha && observation.baseHeadIsAncestor &&
      observation.comparisonBaseHeadSha === integration.base_head_sha &&
      observation.comparisonBaseHeadIsAncestor && observation.clean &&
      JSON.stringify(observation.changedPaths) === JSON.stringify(input.expectedChangedPaths);
  }

  private publishedPullRequest(row: Readonly<{
    operation_id: string;
    job_id: string;
    number: number | null;
    url: string | null;
    head_sha: string;
  }>): NavigatorPullRequestRecord {
    if (row.number === null || row.url === null) throw new Error("published pull request is incomplete");
    return {
      operationId: row.operation_id,
      jobId: row.job_id,
      number: row.number,
      url: row.url,
      headSha: row.head_sha,
    };
  }

  private pullRequestRow(jobId: string) {
    return this.db.prepare("SELECT * FROM navigator_pull_requests WHERE job_id = ?").get(jobId) as Readonly<{
      job_id: string;
      operation_id: string;
      request_json: string;
      request_digest: string;
      status: "pending" | "published";
      number: number | null;
      url: string | null;
      head_sha: string;
    }> | undefined;
  }

  private invalidateIntegration(integration: IntegrationRow, reasonCode: string, now: number): void {
    this.db.prepare(
      `UPDATE navigator_integrations SET state = 'invalidated', updated_at = ? WHERE job_id = ?`,
    ).run(now, integration.job_id);
    if (integration.active_slice_id !== null) {
      this.db.prepare(
        "UPDATE navigator_ticket_slices SET state = 'invalidated', updated_at = ? WHERE id = ?",
      ).run(now, integration.active_slice_id);
      this.db.prepare(
        `UPDATE navigator_integration_tickets SET state = 'invalidated'
          WHERE job_id = ? AND artifact_id = (
            SELECT ticket_artifact_id FROM navigator_ticket_slices WHERE id = ?
          )`,
      ).run(integration.job_id, integration.active_slice_id);
    }
    this.db.prepare(
      `UPDATE jobs SET last_error = ?, updated_at = ? WHERE id = ?`,
    ).run(`Navigator implementation invalidated: ${reasonCode}`, now, integration.job_id);
  }

  private bindingIsCurrent(binding: NavigatorArtifactBinding): boolean {
    const snapshot = this.dependencies.store.getCurrentWorkArtifactSnapshot(binding.artifactId);
    return snapshot?.id === binding.snapshotId && snapshot.snapshotDigest === binding.snapshotDigest &&
      this.dependencies.store.isWorkArtifactSnapshotValid(binding.snapshotId);
  }

  private integrationRow(jobId: string): IntegrationRow | null {
    return this.db.prepare("SELECT * FROM navigator_integrations WHERE job_id = ?").get(jobId) as IntegrationRow | undefined ?? null;
  }

  private ticketRows(jobId: string): TicketRow[] {
    return this.db.prepare(
      "SELECT * FROM navigator_integration_tickets WHERE job_id = ? ORDER BY ticket_order",
    ).all(jobId) as TicketRow[];
  }

  private requireTicket(jobId: string, artifactId: string): TicketRow {
    const ticket = this.ticketRows(jobId).find((candidate) => candidate.artifact_id === artifactId);
    if (!ticket) throw new Error(`navigator integration ticket ${artifactId} was not found`);
    return ticket;
  }

  private sliceForTicket(jobId: string, ticketArtifactId: string): SliceRow | null {
    return this.db.prepare(
      "SELECT * FROM navigator_ticket_slices WHERE job_id = ? AND ticket_artifact_id = ?",
    ).get(jobId, ticketArtifactId) as SliceRow | undefined ?? null;
  }

  private requireSliceForTicket(jobId: string, ticketArtifactId: string): SliceRow {
    const slice = this.sliceForTicket(jobId, ticketArtifactId);
    if (!slice) throw new Error(`navigator ticket slice ${ticketArtifactId} was not found`);
    return slice;
  }

  private requireSlice(sliceId: string): SliceRow {
    const slice = this.db.prepare("SELECT * FROM navigator_ticket_slices WHERE id = ?").get(sliceId) as SliceRow | undefined;
    if (!slice) throw new Error(`navigator ticket slice ${sliceId} was not found`);
    return slice;
  }

  private sliceValue(slice: SliceRow) {
    return {
      id: slice.id,
      ticketArtifactId: slice.ticket_artifact_id,
      claimId: slice.claim_id,
      state: slice.state,
      acceptedHeadSha: slice.accepted_head_sha,
    } as const;
  }

  private getAttempt(attemptId: string): NavigatorTicketWorkerAttempt | null {
    const row = this.db.prepare("SELECT * FROM navigator_ticket_worker_attempts WHERE id = ?").get(attemptId) as AttemptRow | undefined;
    return row ? parseAttempt(row) : null;
  }

  private latestAttempt(sliceId: string, kind: "implementation" | "review"): NavigatorTicketWorkerAttempt {
    const row = this.db.prepare(
      `SELECT * FROM navigator_ticket_worker_attempts
        WHERE slice_id = ? AND kind = ? ORDER BY ordinal DESC LIMIT 1`,
    ).get(sliceId, kind) as AttemptRow | undefined;
    if (!row) throw new Error(`navigator ${kind} attempt was not found`);
    return parseAttempt(row);
  }

  private nextAttemptOrdinal(sliceId: string, kind: "implementation" | "review"): number {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM navigator_ticket_worker_attempts WHERE slice_id = ? AND kind = ?",
    ).get(sliceId, kind) as { ordinal: number };
    return row.ordinal + 1;
  }

  private getOutcome(attemptId: string): NavigatorTicketWorkerOutcome | null {
    const row = this.db.prepare(
      "SELECT * FROM navigator_ticket_worker_outcomes WHERE attempt_id = ?",
    ).get(attemptId) as OutcomeRow | undefined;
    return row ? parseOutcome(row) : null;
  }

  private effectLeaseCurrent(effectKey: string, fence: EffectFence, now: number): boolean {
    return this.dependencies.store.isExecutorLeaseCurrent(fence.ownerId, fence.generation, now) &&
      this.db.prepare(
        `SELECT 1 FROM effects WHERE idempotency_key = ? AND status = 'leased'
          AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?`,
      ).get(effectKey, fence.ownerId, fence.generation, now) !== undefined;
  }

  private finishEffect(
    effect: StoredEffect,
    fence: EffectFence,
    now: number,
    status: "done" | "failed" | "dead",
    error: string | null,
    nextAttemptAt = now,
  ): void {
    this.finishEffectByKey(effect.idempotencyKey, fence, now, status, error, nextAttemptAt);
  }

  private finishEffectByKey(
    effectKey: string,
    fence: EffectFence,
    now: number,
    status: "done" | "failed" | "dead",
    error: string | null,
    nextAttemptAt = now,
  ): void {
    const changed = this.db.prepare(
      `UPDATE effects SET status = ?, lease_owner = NULL, lease_generation = NULL,
           lease_expires_at = NULL, next_attempt_at = ?, last_error = ?, updated_at = ?
        WHERE idempotency_key = ? AND status = 'leased' AND lease_owner = ?
          AND lease_generation = ? AND lease_expires_at > ?`,
    ).run(status, nextAttemptAt, error, now, effectKey, fence.ownerId, fence.generation, now);
    if (changed.changes !== 1) throw new Error("navigator ticket effect lease changed before settlement");
  }
}
