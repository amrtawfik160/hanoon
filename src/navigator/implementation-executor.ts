import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ModelRoute } from "../capabilities/models";
import { CAPABILITY_GRAPH_DIGEST, CAPABILITY_REGISTRY_DIGEST } from "../capabilities/catalog";
import type { TelegramAgentStore } from "../storage/store";
import type { WorkArtifactClaim } from "../work-artifacts/models";
import {
  NAVIGATOR_TICKET_STEP_CONTRACTS,
  navigatorCodeReviewResultSchema,
  navigatorGitObservationSchema,
  navigatorImplementationResultSchema,
  navigatorJsonDigest,
  navigatorPersistedTicketStepContractSchema,
  navigatorPullRequestRequestSchema,
  navigatorReviewFindingSchema,
  navigatorTicketWorkerProfile,
  navigatorTicketWorkerProfileSchema,
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
  type NavigatorTicketWorkOrder,
} from "./implementation-contracts";
import { artifactBindingSchema, type NavigatorArtifactBinding } from "./models";
import type {
  NavigatorFindingLedgerEntry,
  NavigatorTicketWorkerOutcome,
} from "./ticket-settlement-repository";
import type { NavigatorGitObserver } from "./ticket-adapter";

export type {
  NavigatorFindingLedgerEntry,
  NavigatorTicketWorkerOutcome,
} from "./ticket-settlement-repository";
export type {
  NavigatorGitObservationRequest,
  NavigatorGitObserver,
  NavigatorTicketWorkerInput,
  NavigatorTicketWorkerOperation,
  NavigatorTicketWorkerRun,
} from "./ticket-adapter";
export {
  NavigatorTicketWorkerPermanentError,
  NavigatorTicketWorkerRetryableError,
  NavigatorTicketWorkerUnavailableError,
} from "./ticket-adapter";
export { navigatorFindingDisposition } from "./ticket-settlement-repository";

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

function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\0"), "utf8").digest("base64url").slice(0, 24)}`;
}

function findingState(event: FindingEventRow["event"]): NavigatorFindingLedgerEntry["state"] {
  if (event === "opened" || event === "reobserved") return "open";
  return event === "resolved" ? "resolved" : "disputed";
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

export class NavigatorImplementationExecutor {
  private readonly db: Database.Database;

  public constructor(private readonly dependencies: NavigatorImplementationExecutorDependencies) {
    this.db = dependencies.database;
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

}
