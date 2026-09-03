import type { ModelRoute } from "../capabilities/models";
import { compatibilityCapabilityFindingDisposition } from "../capabilities/catalog";
import type { TelegramAgentStore } from "../storage/store";
import {
  navigatorGitObservationSchema,
  navigatorJsonDigest,
  type NavigatorGitObservation,
  type NavigatorPersistedTicketStepContract,
  type NavigatorPullRequestRecord,
  type NavigatorPullRequestRequest,
  type NavigatorTicketRepairSnapshot,
  type NavigatorTicketWorkerProfile,
  type NavigatorTicketWorkOrder,
} from "./implementation-contracts";
import { artifactBindingSchema, type NavigatorArtifactBinding } from "./models";
import type {
  NavigatorFindingLedgerDecision,
  NavigatorFindingLedgerEntry,
} from "./finding-ledger";
import type { NavigatorImplementationPersistence } from "./implementation-persistence";
import type { NavigatorTicketWorkerOutcome } from "./ticket-settlement-repository";
import type { NavigatorGitObserver } from "./ticket-adapter";

export type { NavigatorFindingLedgerEntry } from "./finding-ledger";
export type { NavigatorTicketWorkerOutcome } from "./ticket-settlement-repository";
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
export const navigatorFindingDisposition = compatibilityCapabilityFindingDisposition;

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
  findingLedgerDecision: NavigatorFindingLedgerDecision;
  findingLedger: readonly Readonly<{
    rootCauseId: string;
    sliceId: string;
    sourceReviewAttemptId: string;
    verificationAttemptId: string;
    disposition: "must_fix" | "advisory";
    state: "open" | "resolved" | "disputed" | "stale";
    occurrence: number;
    blockingBurden: number;
    headSha: string;
    supersedesRootCauseId: string | null;
    finding: NavigatorFindingLedgerEntry["finding"];
  }>[];
}>;

export interface NavigatorPullRequestPublisher {
  createOrRefresh(request: NavigatorPullRequestRequest): Promise<NavigatorPullRequestRecord>;
}

type NavigatorImplementationExecutorDependencies = Readonly<{
  store: TelegramAgentStore;
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

export class NavigatorImplementationExecutor {
  private readonly persistence: NavigatorImplementationPersistence;

  public constructor(private readonly dependencies: NavigatorImplementationExecutorDependencies) {
    this.persistence = dependencies.store.getNavigatorImplementationPersistence();
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
    const specification = this.boundCurrentArtifact(job.artifactBindings, input.specificationArtifactId, "specification");
    const tickets = input.implementationTicketIds.map((artifactId) =>
      this.boundCurrentArtifact(job.artifactBindings, artifactId, "implementation_ticket"));
    this.persistence.startIntegration({
      jobId: input.jobId,
      specification,
      tickets,
      baseBranch: input.baseBranch,
      integrationBranch: input.integrationBranch,
      worktreeId: input.worktreeId,
      baseHeadSha: input.baseHeadSha,
      projectPolicyVersion: job.policyVersion,
      projectPolicy: job.policy,
      projectPolicyDigest: navigatorJsonDigest(job.policy),
      evidenceRefs,
      now: this.dependencies.clock.now(),
    });
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
    const now = this.dependencies.clock.now();
    return this.persistence.beginClaimedTicket({
      ...input,
      evidenceRefs: boundedRefs(input.evidenceRefs),
      leaseMs: this.dependencies.leaseMs ?? 30_000,
      modelRoute: this.dependencies.modelRoute("implementation"),
      now,
    });
  }

  public prepareRepairNavigation(input: Readonly<{
    jobId: string;
    ticketArtifactId: string;
    evidenceRefs: readonly string[];
  }>): NavigatorTicketRepairSnapshot {
    return this.persistence.prepareRepairNavigation({
      ...input,
      evidenceRefs: boundedRefs(input.evidenceRefs),
      now: this.dependencies.clock.now(),
    });
  }

  public recordRepairProposal(input: Readonly<{ snapshotId: string; rawProposal: unknown }>) {
    return this.persistence.recordRepairProposal({ ...input, now: this.dependencies.clock.now() });
  }

  public scheduleRepair(input: Readonly<{
    jobId: string;
    ticketArtifactId: string;
    proposalId: string;
  }>): NavigatorTicketWorkerAttempt {
    return this.persistence.scheduleRepair({
      ...input,
      modelRoute: this.dependencies.modelRoute("implementation"),
      now: this.dependencies.clock.now(),
    });
  }

  public markTicketResolved(input: Readonly<{ jobId: string; ticketArtifactId: string }>): NavigatorIntegrationSnapshot {
    return this.persistence.markTicketResolved({ ...input, now: this.dependencies.clock.now() });
  }

  public async publishPullRequest(input: Readonly<{
    jobId: string;
    title: string;
    body: string;
  }>): Promise<NavigatorPullRequestRecord> {
    const preparation = this.persistence.pullRequestPreparation(input.jobId);
    if (preparation.published !== null) return preparation.published;
    const request = preparation.request ?? this.persistence.recordPullRequestRequest({
      jobId: input.jobId,
      title: input.title,
      body: input.body,
      expectedHeadSha: preparation.currentHeadSha,
      expectedChangedPaths: preparation.expectedChangedPaths,
      gitObservation: await this.observePullRequest(preparation),
      now: this.dependencies.clock.now(),
    });
    const published = await this.dependencies.pullRequests.createOrRefresh(request);
    if (
      published.operationId !== request.operationId || published.jobId !== request.jobId ||
      published.headSha !== request.headSha || !Number.isSafeInteger(published.number) ||
      published.number < 1 || published.url.trim().length === 0
    ) throw new TypeError("pull request publisher returned an invalid exact-head result");
    return this.persistence.settlePullRequest({
      jobId: input.jobId,
      request,
      published,
      now: this.dependencies.clock.now(),
    });
  }

  public snapshot(jobId: string): NavigatorIntegrationSnapshot {
    return this.persistence.snapshot(jobId);
  }

  private async observePullRequest(input: Readonly<{
    worktreeId: string;
    integrationBranch: string;
    currentHeadSha: string;
    baseHeadSha: string;
    expectedChangedPaths: readonly string[];
  }>): Promise<NavigatorGitObservation> {
    const rawObservation = await this.dependencies.gitObserver.observe({
      purpose: "pull_request",
      worktreeId: input.worktreeId,
      integrationBranch: input.integrationBranch,
      expectedHeadSha: input.currentHeadSha,
      baseHeadSha: input.baseHeadSha,
      comparisonBaseHeadSha: input.baseHeadSha,
      expectedChangedPaths: input.expectedChangedPaths,
    });
    return navigatorGitObservationSchema.parse(rawObservation);
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
}
