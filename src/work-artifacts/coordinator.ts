import type { TelegramAgentStore } from "../storage/store";
import { GhCliIssueGateway, type GhCliCommandRunner } from "./gh-cli-issue-gateway";
import { GitHubWorkTracker } from "./github-tracker";
import { LocalMarkdownWorkTracker } from "./local-markdown-tracker";
import {
  normalizeRelationships,
  sha256,
  type WorkArtifact,
  type WorkArtifactRelationship,
  type WorkArtifactStatus,
} from "./models";
import {
  stableWorkArtifactId,
  type WorkArtifactCapture,
  type WorkArtifactClaim,
  type WorkArtifactTrackerMutation,
  type WorkArtifactTrackerMutationKind,
} from "./repository";
import {
  blockersPayloadDigest,
  claimPayloadDigest,
  ownedSectionPayloadDigest,
  parentPayloadDigest,
  TrackerConflictError,
  TrackerIdentityConflictError,
  trackerCreateDigest,
  terminalPayloadDigest,
  type CreateTrackerArtifactInput,
  type TrackerArtifact,
  type WorkTracker,
} from "./tracker";

type WorkArtifactStore = Pick<TelegramAgentStore,
  | "captureWorkArtifact"
  | "prepareWorkArtifactCreateIntent"
  | "getWorkArtifactCreateIntent"
  | "preflightWorkArtifactCapture"
  | "observeWorkArtifact"
  | "runExecutorMutation"
  | "getWorkArtifact"
  | "getWorkArtifactByExternalIdentity"
  | "getCurrentWorkArtifactSnapshot"
  | "preflightWorkArtifactClaimIdentity"
  | "claimWorkArtifact"
  | "adoptWorkArtifactClaim"
  | "renewWorkArtifactClaim"
  | "releaseWorkArtifactClaim"
  | "getHeldWorkArtifactClaim"
  | "getWorkArtifactClaim"
  | "prepareWorkArtifactTrackerMutation"
  | "markWorkArtifactTrackerMutationApplying"
  | "completeWorkArtifactTrackerMutation"
  | "markWorkArtifactTrackerMutationIndeterminate"
  | "getWorkArtifactTrackerMutation"
  | "listWorkArtifactRelationships"
  | "isExecutorLeaseCurrent"
  | "authorizeWorkArtifactResolution"
  | "finalizeWorkArtifactResolution"
>;

export type ConfiguredWorkTracker =
  | Readonly<{
      kind: "github";
      repository: string;
      commands: GhCliCommandRunner;
    }>
  | Readonly<{
      kind: "local_markdown";
      repositoryRoot: string;
      effortSlug: string;
    }>;

export function createConfiguredWorkTracker(configuration: ConfiguredWorkTracker): WorkTracker {
  if (configuration.kind === "github") {
    return new GitHubWorkTracker(new GhCliIssueGateway(
      configuration.repository,
      configuration.commands,
    ));
  }
  return new LocalMarkdownWorkTracker(configuration);
}

export type CreateCoordinatedArtifactInput = CreateTrackerArtifactInput & Readonly<{
  projectId: string;
  effortId: string;
  status: Extract<WorkArtifactStatus, "open" | "ready">;
  relationships: readonly WorkArtifactRelationship[];
  trackerOrder?: number;
  ownerId: string;
  generation: number;
  now: number;
}>;

export type ClaimCoordinatedArtifactInput = Readonly<{
  artifactId: string;
  workflowStepId: string;
  jobId: string;
  assignee: string;
  ownerId: string;
  generation: number;
  operationId: string;
  now: number;
  leaseMs: number;
}>;

export type CoordinatedArtifactClaim = Readonly<{
  capture: WorkArtifactCapture;
  claim: WorkArtifactClaim;
}>;

export type AdoptCoordinatedArtifactClaimInput = Readonly<{
  artifactId: string;
  workflowStepId: string;
  jobId: string;
  assignee: string;
  ownerId: string;
  generation: number;
  operationId: string;
  now: number;
  leaseMs: number;
}>;

export type RenewCoordinatedArtifactClaimInput = Readonly<{
  claimId: number;
  ownerId: string;
  generation: number;
  operationId: string;
  now: number;
  leaseMs: number;
}>;

type TrackerEffectFence = Readonly<{
  ownerId: string;
  generation: number;
}>;

type BlockerSettlement = Readonly<{
  artifactId: string;
  snapshotId: string;
  externalRevision: string;
}>;

export class ExecutorLeaseLostError extends Error {
  public constructor() {
    super("executor lease was lost while applying a tracker effect");
    this.name = "ExecutorLeaseLostError";
  }
}

export class WorkArtifactMutationIndeterminateError extends Error {
  public constructor(public readonly mutation: WorkArtifactTrackerMutation) {
    super(
      `Tracker mutation ${mutation.operationId} for ${mutation.externalId} has an indeterminate outcome`,
    );
    this.name = "WorkArtifactMutationIndeterminateError";
  }
}

function externalStatus(artifact: TrackerArtifact): WorkArtifact["externalStatus"] {
  if (artifact.state === "open") return "open";
  return artifact.state === "cancelled" ? "cancelled" : "closed";
}

function derivedOperationId(operationId: string, purpose: string): string {
  return `tracker:${purpose}:${sha256(operationId).slice(0, 32)}`;
}

function trackerCreateOperationId(input: Readonly<{
  projectId: string;
  effortId: string;
  operationId: string;
}>): string {
  return `tracker:create:${sha256(JSON.stringify(input)).slice(0, 32)}`;
}

export class WorkArtifactCoordinator {
  public constructor(
    private readonly store: WorkArtifactStore,
    private readonly tracker: WorkTracker,
    private readonly clock: () => number = Date.now,
  ) {}

  public async create(input: CreateCoordinatedArtifactInput): Promise<WorkArtifactCapture> {
    const artifactId = stableWorkArtifactId(input.projectId, input.operationId);
    const relationships = normalizeRelationships(artifactId, input.relationships);
    const parent = relationships.find((relationship) => relationship.kind === "parent");
    const parentExternalId = parent?.targetArtifactId
      ? this.requireRelatedArtifact(
        parent.targetArtifactId,
        input.projectId,
        input.effortId,
      ).externalId
      : null;
    const blockerExternalIds = relationships
      .filter((relationship) => relationship.kind === "blocks")
      .map((relationship) => {
        if (!relationship.sourceArtifactId) throw new TypeError("blocker relationship has no artifact");
        return this.requireRelatedArtifact(
          relationship.sourceArtifactId,
          input.projectId,
          input.effortId,
        ).externalId;
      })
      .sort((left, right) => left.localeCompare(right));
    this.store.preflightWorkArtifactCapture({
      artifactId,
      projectId: input.projectId,
      effortId: input.effortId,
      operationId: input.operationId,
      kind: input.kind,
      status: input.status,
      trackerKind: this.tracker.kind,
      trackerNamespace: this.tracker.namespace,
      title: input.title,
      trackerOrder: input.trackerOrder,
      content: input.body,
      acceptanceCriteria: input.acceptanceCriteria,
      relationships,
      capturedAt: input.now,
    });
    const trackerCreateInput = {
      operationId: trackerCreateOperationId({
        projectId: input.projectId,
        effortId: input.effortId,
        operationId: input.operationId,
      }),
      kind: input.kind,
      title: input.title,
      body: input.body,
      acceptanceCriteria: input.acceptanceCriteria,
      identityContext: sha256(JSON.stringify({
        projectId: input.projectId,
        effortId: input.effortId,
        status: input.status,
        trackerOrder: input.trackerOrder ?? 0,
        relationships,
      })),
    } as const;
    const createDigest = trackerCreateDigest(trackerCreateInput);
    let createIntent;
    try {
      createIntent = this.commitExecutorMutation(input, (boundaryNow) =>
        this.store.prepareWorkArtifactCreateIntent({
          artifactId,
          projectId: input.projectId,
          effortId: input.effortId,
          operationId: input.operationId,
          trackerKind: this.tracker.kind,
          trackerNamespace: this.tracker.namespace,
          trackerOperationId: trackerCreateInput.operationId,
          createDigest,
          ownerId: input.ownerId,
          generation: input.generation,
          now: Math.max(input.now, boundaryNow),
        }));
    } catch (error) {
      if (error instanceof TypeError && /create intent identity changed/iu.test(error.message)) {
        throw new TrackerIdentityConflictError(input.operationId);
      }
      throw error;
    }
    const intendedTrackerCreateInput = {
      ...trackerCreateInput,
      operationId: createIntent.trackerOperationId,
    };
    if (trackerCreateDigest(intendedTrackerCreateInput) !== createIntent.createDigest) {
      throw new TypeError("work artifact create intent identity changed during replay");
    }
    let external = await this.runTrackerEffect(input, () =>
      this.tracker.create(intendedTrackerCreateInput));
    this.assertCreateTrackerIdentity(external, intendedTrackerCreateInput);
    const blockerOperationId = derivedOperationId(input.operationId, "blockers");
    const blockerOperationEvidence = await this.tracker.operationStatus({
      externalId: external.externalId,
      operationId: blockerOperationId,
      payloadDigest: blockersPayloadDigest(blockerExternalIds),
    });
    external = blockerOperationEvidence.artifact;
    this.assertCreateTrackerIdentity(external, intendedTrackerCreateInput);
    const externalBlockers = [...external.blockerExternalIds]
      .sort((left, right) => left.localeCompare(right));
    const blockerMismatch = JSON.stringify(externalBlockers) !== JSON.stringify(blockerExternalIds);
    const blockerOperationStatus = blockerOperationEvidence.status;
    let resumableBlockerMutation = true;
    if (blockerMismatch) {
      resumableBlockerMutation = blockerOperationStatus === "pending" ||
        (blockerOperationStatus === "absent" && externalBlockers.length === 0 &&
          blockerExternalIds.length > 0);
    }
    if (
      (external.parentExternalId !== null && external.parentExternalId !== parentExternalId) ||
      (blockerMismatch && !resumableBlockerMutation)
    ) {
      throw new TrackerConflictError(external.externalId);
    }
    if (parentExternalId) {
      const parentOperationId = derivedOperationId(input.operationId, "parent");
      const parentMutation = this.prepareTrackerMutation({
        artifactId,
        kind: "parent",
        operationId: parentOperationId,
        payloadDigest: parentPayloadDigest(parentExternalId),
        requestedParentExternalId: parentExternalId,
        originalParentExternalId: external.parentExternalId,
        originalRevision: external.revision,
        externalId: external.externalId,
        fence: input,
        now: input.now,
      });
      const reconciliation = await this.reconcileOrBeginTrackerMutation(
        parentMutation,
        external,
        input,
        (artifact) => this.assertCreateTrackerIdentity(artifact, intendedTrackerCreateInput),
      );
      if (reconciliation.shouldApply) {
        external = await this.runTrackerEffect(input, () => this.tracker.setParent({
          externalId: external.externalId,
          parentExternalId,
          operationId: parentOperationId,
          expectedRevision: external.revision,
        }));
        this.assertCreateTrackerIdentity(external, intendedTrackerCreateInput);
        if (external.parentExternalId !== parentExternalId) {
          throw new TrackerConflictError(external.externalId);
        }
        this.completeTrackerMutation(parentMutation, external, input);
      } else {
        external = reconciliation.artifact ?? external;
        if (external.parentExternalId !== parentExternalId) {
          throw new TrackerConflictError(external.externalId);
        }
      }
    }
    if (blockerExternalIds.length > 0 || blockerOperationStatus !== "absent") {
      external = await this.runTrackerEffect(input, () => this.tracker.setBlockers({
        externalId: external.externalId,
        blockerExternalIds,
        operationId: blockerOperationId,
        expectedRevision: external.revision,
      }));
      this.assertCreateTrackerIdentity(external, intendedTrackerCreateInput);
      const settledBlockers = [...external.blockerExternalIds]
        .sort((left, right) => left.localeCompare(right));
      if (JSON.stringify(settledBlockers) !== JSON.stringify(blockerExternalIds)) {
        throw new TrackerConflictError(external.externalId);
      }
    }
    return this.commitExecutorMutation(input, (boundaryNow) => this.store.captureWorkArtifact({
      artifactId,
      projectId: input.projectId,
      effortId: input.effortId,
      operationId: input.operationId,
      kind: input.kind,
      status: input.status,
      trackerKind: this.tracker.kind,
      trackerNamespace: this.tracker.namespace,
      externalId: external.externalId,
      externalUrl: external.url,
      externalRevision: external.revision,
      externalStatus: externalStatus(external),
      assignees: external.assignees,
      title: external.title,
      trackerOrder: input.trackerOrder,
      content: external.body,
      acceptanceCriteria: external.acceptanceCriteria,
      relationships,
      capturedAt: Math.max(input.now, boundaryNow),
    }));
  }

  public async observe(input: TrackerEffectFence & Readonly<{
    artifactId: string;
    now: number;
  }>): Promise<WorkArtifactCapture> {
    this.assertExecutorLease(input);
    const artifact = this.requireArtifact(input.artifactId);
    const external = await this.readBoundTrackerArtifact(artifact);
    if (external.revision === artifact.externalRevision) {
      this.assertExecutorLease(input);
      const snapshot = this.store.getCurrentWorkArtifactSnapshot(artifact.id);
      if (!snapshot) throw new Error(`Work artifact ${artifact.id} has no current snapshot`);
      return { artifact, snapshot };
    }
    return this.captureObservationFenced(artifact, external, input);
  }

  public async updateOwnedSection(input: TrackerEffectFence & Readonly<{
    artifactId: string;
    sectionId: string;
    content: string;
    operationId: string;
    now: number;
  }>): Promise<WorkArtifactCapture> {
    const artifact = await this.observeCurrentRevision(input);
    const payloadDigest = ownedSectionPayloadDigest(input);
    const mutation = this.prepareTrackerMutation({
      artifactId: artifact.id,
      kind: "owned_section",
      operationId: input.operationId,
      payloadDigest,
      requestedParentExternalId: null,
      originalParentExternalId: null,
      originalRevision: artifact.externalRevision,
      externalId: artifact.externalId,
      fence: input,
      now: input.now,
    });
    const reconciliation = await this.reconcileOrBeginBoundTrackerMutation(mutation, artifact, input);
    const external = reconciliation.shouldApply
      ? await this.runBoundTrackerEffect(artifact, input, () => this.tracker.updateOwnedSection({
        externalId: artifact.externalId,
        sectionId: input.sectionId,
        content: input.content,
        operationId: input.operationId,
        expectedRevision: artifact.externalRevision,
      }))
      : reconciliation.artifact ?? await this.readBoundTrackerArtifact(artifact);
    if (reconciliation.shouldApply) this.completeTrackerMutation(mutation, external, input);
    return this.captureObservationFenced(artifact, external, input);
  }

  public async claim(input: ClaimCoordinatedArtifactInput): Promise<CoordinatedArtifactClaim | null> {
    if (!this.store.isExecutorLeaseCurrent(input.ownerId, input.generation, input.now)) return null;
    this.store.preflightWorkArtifactClaimIdentity(input);
    const initial = this.requireArtifact(input.artifactId);
    const priorHeld = this.store.getHeldWorkArtifactClaim(initial.id);
    let observed = await this.readBoundTrackerArtifact(initial);
    const capture = observed.revision === initial.externalRevision
      ? this.currentCapture(initial)
      : this.captureObservationFenced(initial, observed, input);
    const artifact = capture.artifact;
    const held = this.store.getHeldWorkArtifactClaim(artifact.id);
    if (
      priorHeld && !held && observed.assignees.includes(input.assignee) &&
      priorHeld.workflowStepId === input.workflowStepId && priorHeld.jobId === input.jobId &&
      priorHeld.externalAssignee === input.assignee && priorHeld.ownerId === input.ownerId &&
      priorHeld.generation === input.generation && priorHeld.leaseExpiresAt > input.now
    ) {
      const released = await this.runBoundTrackerEffect(artifact, input, () => this.tracker.release({
        externalId: artifact.externalId,
        assignee: input.assignee,
        operationId: derivedOperationId(input.operationId, "lost-exclusive-claim"),
        expectedRevision: artifact.externalRevision,
      }));
      if (released.assignees.includes(input.assignee)) {
        throw new TrackerConflictError(released.externalId);
      }
      this.captureObservationFenced(artifact, released, input);
      return null;
    }
    if (held) {
      if (
        held.workflowStepId !== input.workflowStepId || held.jobId !== input.jobId ||
        held.externalAssignee !== input.assignee || held.ownerId !== input.ownerId ||
        held.generation !== input.generation || held.leaseExpiresAt <= input.now ||
        held.snapshotId !== artifact.currentSnapshotId ||
        observed.state !== "open" ||
        observed.assignees.length !== 1 || observed.assignees[0] !== input.assignee
      ) return null;
    } else {
      if ((artifact.status !== "open" && artifact.status !== "ready") || observed.state !== "open") {
        return null;
      }
      if (observed.assignees.length > 0) {
        const operationEvidence = await this.tracker.operationStatus({
          externalId: artifact.externalId,
          operationId: input.operationId,
          payloadDigest: claimPayloadDigest("claim", input.assignee),
        });
        this.assertBoundTrackerIdentity(artifact, operationEvidence.artifact);
        observed = operationEvidence.artifact;
        const operationStatus = operationEvidence.status;
        if (
          observed.assignees.includes(input.assignee) && observed.assignees.length > 1 &&
          operationStatus !== "absent"
        ) {
          const released = await this.runBoundTrackerEffect(artifact, input, () => this.tracker.release({
            externalId: artifact.externalId,
            assignee: input.assignee,
            operationId: derivedOperationId(input.operationId, "unowned-claim-compensation"),
            expectedRevision: artifact.externalRevision,
          }));
          if (released.assignees.includes(input.assignee)) {
            throw new TrackerConflictError(released.externalId);
          }
          this.captureObservationFenced(artifact, released, input);
          return null;
        }
        if (
          operationStatus === "absent" || observed.assignees.length !== 1 ||
          observed.assignees[0] !== input.assignee
        ) return null;
      }
      const blockers = this.store.listWorkArtifactRelationships(artifact.id)
        .filter((relationship) => relationship.kind === "blocks")
        .map((relationship) => relationship.sourceArtifactId)
        .filter((artifactId): artifactId is string => artifactId !== null);
      for (const blockerId of blockers) {
        const blocker = (await this.observe({ ...input, artifactId: blockerId })).artifact;
        if (
          (blocker.status !== "resolved" && blocker.status !== "cancelled") ||
          blocker.externalStatus === "open"
        ) return null;
      }
    }
    const external = await this.runBoundTrackerEffect(artifact, input, () => this.tracker.claim({
      externalId: artifact.externalId,
      assignee: input.assignee,
      operationId: input.operationId,
      expectedRevision: artifact.externalRevision,
    }));
    const settlement = this.commitExecutorMutation(input, (boundaryNow) => {
      const claimNow = Math.max(input.now, boundaryNow);
      const claimedCapture = this.captureObservation(artifact, external, claimNow);
      const claim = this.store.claimWorkArtifact({
        artifactId: artifact.id,
        workflowStepId: input.workflowStepId,
        jobId: input.jobId,
        snapshotId: claimedCapture.snapshot.id,
        externalAssignee: input.assignee,
        ownerId: input.ownerId,
        generation: input.generation,
        now: claimNow,
        leaseMs: input.leaseMs,
      });
      return { claimedCapture, claim };
    });
    if (settlement.claim) return { capture: settlement.claimedCapture, claim: settlement.claim };

    const released = await this.runBoundTrackerEffect(artifact, input, () => this.tracker.release({
      externalId: artifact.externalId,
      assignee: input.assignee,
      operationId: derivedOperationId(input.operationId, "claim-compensation"),
      expectedRevision: external.revision,
    }));
    if (released.assignees.includes(input.assignee)) {
      throw new TrackerConflictError(released.externalId);
    }
    this.captureObservationFenced(settlement.claimedCapture.artifact, released, input);
    return null;
  }

  public async adopt(
    input: AdoptCoordinatedArtifactClaimInput,
  ): Promise<CoordinatedArtifactClaim | null> {
    if (!this.store.isExecutorLeaseCurrent(input.ownerId, input.generation, input.now)) return null;
    this.store.preflightWorkArtifactClaimIdentity(input);
    let artifact = this.requireArtifact(input.artifactId);
    let claim = this.store.getHeldWorkArtifactClaim(artifact.id);
    if (!claim || !this.claimMatchesWork(claim, input)) return null;
    const replay = claim.ownerId === input.ownerId && claim.generation === input.generation;
    if (!replay && this.store.isExecutorLeaseCurrent(claim.ownerId, claim.generation, input.now)) {
      return null;
    }
    const observed = await this.readBoundTrackerArtifact(artifact);
    const initialCapture = observed.revision === artifact.externalRevision
      ? this.currentCapture(artifact)
      : this.captureObservationFenced(artifact, observed, input);
    artifact = initialCapture.artifact;
    claim = this.store.getHeldWorkArtifactClaim(artifact.id);
    if (!claim) {
      if (observed.assignees.includes(input.assignee)) {
        await this.compensateVisibleClaim(artifact, input.assignee, input, "adopt-invalidated");
      }
      return null;
    }
    if (
      !this.claimMatchesWork(claim, input) || observed.state !== "open" ||
      observed.assignees.length !== 1 || observed.assignees[0] !== input.assignee
    ) return null;
    const external = await this.runBoundTrackerEffect(artifact, input, () => this.tracker.renew({
      externalId: artifact.externalId,
      assignee: input.assignee,
      operationId: input.operationId,
      expectedRevision: artifact.externalRevision,
    }));
    const settlement = this.commitExecutorMutation(input, (boundaryNow) => {
      const adoptNow = Math.max(input.now, boundaryNow);
      const adoptedCapture = this.captureObservation(artifact, external, adoptNow);
      const currentClaim = this.store.getHeldWorkArtifactClaim(artifact.id);
      const adopted = currentClaim !== null && this.store.adoptWorkArtifactClaim({
        artifactId: artifact.id,
        workflowStepId: input.workflowStepId,
        jobId: input.jobId,
        externalAssignee: input.assignee,
        ownerId: input.ownerId,
        generation: input.generation,
        expectedOwnerId: currentClaim.ownerId,
        expectedGeneration: currentClaim.generation,
        expectedLeaseExpiresAt: currentClaim.leaseExpiresAt,
        now: adoptNow,
        leaseMs: input.leaseMs,
      });
      const adoptedClaim = this.store.getHeldWorkArtifactClaim(artifact.id);
      return {
        capture: adoptedCapture,
        claim: adopted && adoptedClaim ? adoptedClaim : null,
      };
    });
    if (settlement.claim) return { capture: settlement.capture, claim: settlement.claim };
    await this.compensateVisibleClaim(
      settlement.capture.artifact,
      input.assignee,
      input,
      "adopt-settlement",
    );
    return null;
  }

  public async renew(
    input: RenewCoordinatedArtifactClaimInput,
  ): Promise<CoordinatedArtifactClaim | null> {
    if (!this.store.isExecutorLeaseCurrent(input.ownerId, input.generation, input.now)) return null;
    let claim = this.store.getWorkArtifactClaim(input.claimId);
    if (
      !claim || claim.state !== "held" || claim.ownerId !== input.ownerId ||
      claim.generation !== input.generation || claim.leaseExpiresAt <= input.now
    ) return null;
    let artifact = this.requireArtifact(claim.artifactId);
    const observed = await this.readBoundTrackerArtifact(artifact);
    const initialCapture = observed.revision === artifact.externalRevision
      ? this.currentCapture(artifact)
      : this.captureObservationFenced(artifact, observed, input);
    artifact = initialCapture.artifact;
    claim = this.store.getWorkArtifactClaim(input.claimId);
    if (!claim || claim.state !== "held") {
      const assignee = claim?.externalAssignee;
      if (assignee && observed.assignees.includes(assignee)) {
        await this.compensateVisibleClaim(artifact, assignee, input, "renew-invalidated");
      }
      return null;
    }
    if (
      claim.ownerId !== input.ownerId ||
      claim.generation !== input.generation || claim.leaseExpiresAt <= input.now ||
      claim.snapshotId !== artifact.currentSnapshotId || observed.state !== "open" ||
      observed.assignees.length !== 1 || observed.assignees[0] !== claim.externalAssignee
    ) return null;
    const external = await this.runBoundTrackerEffect(artifact, input, () => this.tracker.renew({
      externalId: artifact.externalId,
      assignee: claim.externalAssignee,
      operationId: input.operationId,
      expectedRevision: artifact.externalRevision,
    }));
    const settlement = this.commitExecutorMutation(input, (boundaryNow) => {
      const renewNow = Math.max(input.now, boundaryNow);
      const renewedCapture = this.captureObservation(artifact, external, renewNow);
      const renewed = this.store.renewWorkArtifactClaim({
        claimId: input.claimId,
        ownerId: input.ownerId,
        generation: input.generation,
        now: renewNow,
        leaseMs: input.leaseMs,
      });
      const renewedClaim = this.store.getWorkArtifactClaim(input.claimId);
      return {
        capture: renewedCapture,
        claim: renewed && renewedClaim ? renewedClaim : null,
      };
    });
    if (settlement.claim) return { capture: settlement.capture, claim: settlement.claim };
    await this.compensateVisibleClaim(
      settlement.capture.artifact,
      claim.externalAssignee,
      input,
      "renew-settlement",
    );
    return null;
  }

  public async release(input: Readonly<{
    claimId: number;
    ownerId: string;
    generation: number;
    operationId: string;
    reason: string;
    now: number;
  }>): Promise<boolean> {
    const claim = this.store.getWorkArtifactClaim(input.claimId);
    if (!claim) return false;
    if (claim.state === "released") {
      if (
        claim.ownerId !== input.ownerId || claim.generation !== input.generation ||
        claim.releaseReason !== input.reason
      ) return false;
      const artifact = this.requireArtifact(claim.artifactId);
      const external = await this.readBoundTrackerArtifact(artifact);
      if (external.assignees.includes(claim.externalAssignee)) {
        throw new TrackerConflictError(external.externalId);
      }
      return true;
    }
    if (claim.state !== "held") return false;
    if (!this.store.isExecutorLeaseCurrent(input.ownerId, input.generation, input.now)) return false;
    if (claim.leaseExpiresAt <= input.now) return false;
    const artifact = this.requireArtifact(claim.artifactId);
    let observed = await this.readBoundTrackerArtifact(artifact);
    const releaseEvidence = await this.tracker.operationStatus({
      externalId: artifact.externalId,
      operationId: input.operationId,
      payloadDigest: claimPayloadDigest("release", claim.externalAssignee),
    });
    this.assertBoundTrackerIdentity(artifact, releaseEvidence.artifact);
    observed = releaseEvidence.artifact;
    const releaseStatus = releaseEvidence.status;
    if (releaseStatus === "completed") {
      if (observed.assignees.includes(claim.externalAssignee)) {
        throw new TrackerConflictError(observed.externalId);
      }
      return this.settleReleasedClaim(claim, artifact, observed, input);
    }
    const external = await this.runBoundTrackerEffect(artifact, input, () => this.tracker.release({
      externalId: artifact.externalId,
      assignee: claim.externalAssignee,
      operationId: input.operationId,
      expectedRevision: observed.revision,
    }));
    if (external.assignees.includes(claim.externalAssignee)) {
      throw new TrackerConflictError(external.externalId);
    }
    return this.settleReleasedClaim(claim, artifact, external, input);
  }

  private settleReleasedClaim(
    claim: WorkArtifactClaim,
    artifact: WorkArtifact,
    external: TrackerArtifact,
    input: TrackerEffectFence & Readonly<{
      claimId: number;
      reason: string;
      now: number;
    }>,
  ): boolean {
    return this.commitExecutorMutation(input, (boundaryNow) => {
      const releaseNow = Math.max(input.now, boundaryNow);
      const released = this.store.releaseWorkArtifactClaim({
        claimId: input.claimId,
        ownerId: input.ownerId,
        generation: input.generation,
        now: releaseNow,
        reason: input.reason,
      });
      if (!released) return false;
      this.captureObservation(this.requireArtifact(artifact.id), external, releaseNow);
      return true;
    });
  }

  public async resolve(input: Readonly<{
    artifactId: string;
    evidenceRefs: readonly string[];
    resolution: string;
    operationId: string;
    ownerId: string;
    generation: number;
    now: number;
  }>): Promise<WorkArtifactCapture> {
    const artifact = await this.observeCurrentRevision(input);
    const initialBlockers = await this.observeResolvedBlockers(artifact, input);
    const intent = this.commitExecutorMutation(input, (boundaryNow) => {
      const resolutionNow = Math.max(input.now, boundaryNow);
      return this.store.authorizeWorkArtifactResolution({
        artifactId: artifact.id,
        operationId: input.operationId,
        outcome: "resolved",
        snapshotId: artifact.currentSnapshotId,
        expectedExternalRevision: artifact.externalRevision,
        evidenceRefs: input.evidenceRefs,
        now: resolutionNow,
      });
    });
    if (!intent) throw new Error(`Work artifact ${artifact.id} could not authorize resolution`);
    const mutation = this.prepareTrackerMutation({
      artifactId: artifact.id,
      kind: "resolve",
      operationId: input.operationId,
      payloadDigest: terminalPayloadDigest("resolved", input.resolution),
      requestedParentExternalId: null,
      originalParentExternalId: null,
      originalRevision: artifact.externalRevision,
      externalId: artifact.externalId,
      fence: input,
      now: input.now,
    });
    const reconciliation = await this.reconcileOrBeginBoundTrackerMutation(
      mutation,
      artifact,
      input,
    );
    let external: TrackerArtifact;
    if (reconciliation.shouldApply) {
      external = await this.runBoundTrackerEffect(artifact, input, () => this.tracker.resolve({
        externalId: artifact.externalId,
        resolution: input.resolution,
        operationId: input.operationId,
        expectedRevision: artifact.externalRevision,
      }));
      this.completeTrackerMutation(mutation, external, input);
    } else {
      external = reconciliation.artifact ?? await this.readBoundTrackerArtifact(artifact);
      if (external.state !== "closed") throw new TrackerConflictError(artifact.externalId);
    }
    const finalBlockers = await this.observeResolvedBlockers(artifact, input);
    if (JSON.stringify(finalBlockers) !== JSON.stringify(initialBlockers)) {
      throw new TrackerConflictError(artifact.externalId);
    }
    const settlement = this.commitExecutorMutation(input, (boundaryNow) => {
      const resolutionNow = Math.max(input.now, boundaryNow);
      const closure = this.captureObservation(artifact, external, resolutionNow);
      this.assertBlockerSettlement(closure.artifact, finalBlockers);
      const resolved = this.store.finalizeWorkArtifactResolution({
        intentId: intent.id,
        externalRevision: closure.artifact.externalRevision,
        now: resolutionNow,
      });
      return { closure, resolved };
    });
    if (!settlement.resolved) {
      throw new Error(`Work artifact ${artifact.id} changed before resolution finalized`);
    }
    return { ...settlement.closure, artifact: settlement.resolved };
  }

  public async cancel(input: Readonly<{
    artifactId: string;
    evidenceRefs: readonly string[];
    reason: string;
    operationId: string;
    ownerId: string;
    generation: number;
    now: number;
  }>): Promise<WorkArtifactCapture> {
    const artifact = await this.observeCurrentRevision(input);
    const intent = this.commitExecutorMutation(input, (boundaryNow) => {
      const cancellationNow = Math.max(input.now, boundaryNow);
      return this.store.authorizeWorkArtifactResolution({
        artifactId: artifact.id,
        operationId: input.operationId,
        outcome: "cancelled",
        snapshotId: artifact.currentSnapshotId,
        expectedExternalRevision: artifact.externalRevision,
        evidenceRefs: input.evidenceRefs,
        now: cancellationNow,
      });
    });
    if (!intent) throw new Error(`Work artifact ${artifact.id} could not authorize cancellation`);
    const mutation = this.prepareTrackerMutation({
      artifactId: artifact.id,
      kind: "cancel",
      operationId: input.operationId,
      payloadDigest: terminalPayloadDigest("cancelled", input.reason),
      requestedParentExternalId: null,
      originalParentExternalId: null,
      originalRevision: artifact.externalRevision,
      externalId: artifact.externalId,
      fence: input,
      now: input.now,
    });
    const reconciliation = await this.reconcileOrBeginBoundTrackerMutation(
      mutation,
      artifact,
      input,
    );
    let external: TrackerArtifact;
    if (reconciliation.shouldApply) {
      external = await this.runBoundTrackerEffect(artifact, input, () => this.tracker.cancel({
        externalId: artifact.externalId,
        reason: input.reason,
        operationId: input.operationId,
        expectedRevision: artifact.externalRevision,
      }));
      this.completeTrackerMutation(mutation, external, input);
    } else {
      external = reconciliation.artifact ?? await this.readBoundTrackerArtifact(artifact);
      if (external.state !== "cancelled") throw new TrackerConflictError(artifact.externalId);
    }
    const settlement = this.commitExecutorMutation(input, (boundaryNow) => {
      const cancellationNow = Math.max(input.now, boundaryNow);
      const closure = this.captureObservation(artifact, external, cancellationNow);
      const cancelled = this.store.finalizeWorkArtifactResolution({
        intentId: intent.id,
        externalRevision: closure.artifact.externalRevision,
        now: cancellationNow,
      });
      return { closure, cancelled };
    });
    if (!settlement.cancelled) {
      throw new Error(`Work artifact ${artifact.id} changed before cancellation finalized`);
    }
    return { ...settlement.closure, artifact: settlement.cancelled };
  }

  private async observeCurrentRevision(input: TrackerEffectFence & Readonly<{
    artifactId: string;
    now: number;
  }>): Promise<WorkArtifact> {
    const artifact = this.requireArtifact(input.artifactId);
    const external = await this.readBoundTrackerArtifact(artifact);
    if (external.revision === artifact.externalRevision) return artifact;
    return this.captureObservationFenced(artifact, external, input).artifact;
  }

  private captureObservation(
    artifact: WorkArtifact,
    external: TrackerArtifact,
    now: number,
  ): WorkArtifactCapture {
    const currentSnapshot = this.store.getCurrentWorkArtifactSnapshot(artifact.id);
    if (!currentSnapshot) throw new Error(`Work artifact ${artifact.id} has no current snapshot`);
    return this.store.observeWorkArtifact({
      artifactId: artifact.id,
      expectedExternalRevision: artifact.externalRevision,
      externalRevision: external.revision,
      externalStatus: externalStatus(external),
      assignees: external.assignees,
      title: external.title,
      content: external.body,
      acceptanceCriteria: external.acceptanceCriteria,
      relationships: this.relationshipsFromTracker(artifact, currentSnapshot.relationships, external),
      observedAt: now,
    });
  }

  private currentCapture(artifact: WorkArtifact): WorkArtifactCapture {
    const snapshot = this.store.getCurrentWorkArtifactSnapshot(artifact.id);
    if (!snapshot) throw new Error(`Work artifact ${artifact.id} has no current snapshot`);
    return { artifact, snapshot };
  }

  private captureObservationFenced(
    artifact: WorkArtifact,
    external: TrackerArtifact,
    input: TrackerEffectFence & Readonly<{ now: number }>,
  ): WorkArtifactCapture {
    return this.commitExecutorMutation(input, (boundaryNow) =>
      this.captureObservation(artifact, external, Math.max(input.now, boundaryNow)));
  }

  private commitExecutorMutation<T>(fence: TrackerEffectFence, mutation: (now: number) => T): T {
    const result = this.store.runExecutorMutation(fence, mutation);
    if (result.outcome === "stale") throw new ExecutorLeaseLostError();
    return result.mutationValue;
  }

  private assertCreateTrackerIdentity(
    external: TrackerArtifact,
    expected: CreateTrackerArtifactInput,
  ): void {
    if (
      external.trackerKind !== this.tracker.kind ||
      external.operationId !== expected.operationId || external.kind !== expected.kind ||
      external.createDigest !== trackerCreateDigest(expected)
    ) {
      throw new TrackerConflictError(external.externalId);
    }
  }

  private assertBoundTrackerIdentity(artifact: WorkArtifact, external: TrackerArtifact): void {
    const derivedOperationId = trackerCreateOperationId({
      projectId: artifact.projectId,
      effortId: artifact.effortId,
      operationId: artifact.operationId,
    });
    const intent = this.store.getWorkArtifactCreateIntent(artifact.id);
    const expectedOperationId = intent?.trackerOperationId ?? derivedOperationId;
    if (
      external.trackerKind !== artifact.trackerKind ||
      external.externalId !== artifact.externalId ||
      external.operationId !== expectedOperationId ||
      external.kind !== artifact.kind ||
      (intent !== null && (
        intent.trackerKind !== artifact.trackerKind ||
        intent.trackerNamespace !== artifact.trackerNamespace ||
        external.createDigest !== intent.createDigest
      ))
    ) {
      throw new TrackerConflictError(artifact.externalId);
    }
  }

  private async readBoundTrackerArtifact(artifact: WorkArtifact): Promise<TrackerArtifact> {
    const external = await this.tracker.read(artifact.externalId);
    this.assertBoundTrackerIdentity(artifact, external);
    return external;
  }

  private async runBoundTrackerEffect(
    artifact: WorkArtifact,
    fence: TrackerEffectFence,
    effect: () => Promise<TrackerArtifact>,
  ): Promise<TrackerArtifact> {
    const external = await this.runTrackerEffect(fence, effect);
    this.assertBoundTrackerIdentity(artifact, external);
    return external;
  }

  private prepareTrackerMutation(input: Readonly<{
    artifactId: string;
    kind: WorkArtifactTrackerMutationKind;
    operationId: string;
    payloadDigest: string;
    requestedParentExternalId: string | null;
    originalParentExternalId: string | null;
    originalRevision: string;
    externalId: string;
    fence: TrackerEffectFence;
    now: number;
  }>): WorkArtifactTrackerMutation {
    const key = {
      trackerNamespace: this.tracker.namespace,
      externalId: input.externalId,
      operationId: input.operationId,
    };
    const existing = this.store.getWorkArtifactTrackerMutation(key);
    return this.commitExecutorMutation(input.fence, (boundaryNow) =>
      this.store.prepareWorkArtifactTrackerMutation({
        ...key,
        artifactId: input.artifactId,
        kind: input.kind,
        payloadDigest: input.payloadDigest,
        requestedParentExternalId: input.requestedParentExternalId,
        originalParentExternalId: existing
          ? existing.originalParentExternalId
          : input.originalParentExternalId,
        originalRevision: existing?.originalRevision ?? input.originalRevision,
        ownerId: input.fence.ownerId,
        generation: input.fence.generation,
        now: Math.max(input.now, boundaryNow),
      }));
  }

  private async reconcileOrBeginTrackerMutation(
    mutation: WorkArtifactTrackerMutation,
    observed: TrackerArtifact | null,
    fence: TrackerEffectFence & Readonly<{ now: number }>,
    validateArtifact: (artifact: TrackerArtifact) => void,
  ): Promise<Readonly<{ shouldApply: boolean; artifact: TrackerArtifact | null }>> {
    if (mutation.phase === "indeterminate") {
      throw new WorkArtifactMutationIndeterminateError(mutation);
    }
    if (mutation.phase === "completed") {
      if (observed) validateArtifact(observed);
      return { shouldApply: false, artifact: observed };
    }
    if (mutation.phase === "applying") {
      const operationEvidence = await this.tracker.operationStatus({
        externalId: mutation.externalId,
        operationId: mutation.operationId,
        payloadDigest: mutation.payloadDigest,
      });
      const evidenceArtifact = operationEvidence.artifact;
      validateArtifact(evidenceArtifact);
      const nativeStateMatches = mutation.kind === "parent"
        ? evidenceArtifact.parentExternalId === mutation.requestedParentExternalId
        : mutation.kind === "resolve"
          ? evidenceArtifact.state === "closed"
          : mutation.kind === "cancel"
            ? evidenceArtifact.state === "cancelled"
            : true;
      if (operationEvidence.status === "completed" && nativeStateMatches) {
        this.completeTrackerMutation(mutation, evidenceArtifact, fence);
        return { shouldApply: false, artifact: evidenceArtifact };
      }
      const indeterminate = this.commitExecutorMutation(fence, (boundaryNow) =>
        this.store.markWorkArtifactTrackerMutationIndeterminate({
          trackerNamespace: mutation.trackerNamespace,
          externalId: mutation.externalId,
          operationId: mutation.operationId,
          lastObservedParentExternalId: evidenceArtifact.parentExternalId,
          lastObservedRevision: evidenceArtifact.revision,
          reason: operationEvidence.status === "completed"
            ? "tracker operation marker conflicts with independently observed native state"
            : "tracker operation completion evidence is absent or ambiguous",
          ownerId: fence.ownerId,
          generation: fence.generation,
          now: Math.max(fence.now, boundaryNow),
        }));
      throw new WorkArtifactMutationIndeterminateError(indeterminate);
    }
    this.commitExecutorMutation(fence, (boundaryNow) =>
      this.store.markWorkArtifactTrackerMutationApplying({
        trackerNamespace: mutation.trackerNamespace,
        externalId: mutation.externalId,
        operationId: mutation.operationId,
        ownerId: fence.ownerId,
        generation: fence.generation,
        now: Math.max(fence.now, boundaryNow),
      }));
    return { shouldApply: true, artifact: null };
  }

  private async reconcileOrBeginBoundTrackerMutation(
    mutation: WorkArtifactTrackerMutation,
    artifact: WorkArtifact,
    fence: TrackerEffectFence & Readonly<{ now: number }>,
  ): Promise<Readonly<{ shouldApply: boolean; artifact: TrackerArtifact | null }>> {
    return this.reconcileOrBeginTrackerMutation(
      mutation,
      null,
      fence,
      (observed) => this.assertBoundTrackerIdentity(artifact, observed),
    );
  }

  private completeTrackerMutation(
    mutation: WorkArtifactTrackerMutation,
    observed: TrackerArtifact,
    fence: TrackerEffectFence & Readonly<{ now: number }>,
  ): WorkArtifactTrackerMutation {
    return this.commitExecutorMutation(fence, (boundaryNow) =>
      this.store.completeWorkArtifactTrackerMutation({
        trackerNamespace: mutation.trackerNamespace,
        externalId: mutation.externalId,
        operationId: mutation.operationId,
        lastObservedParentExternalId: observed.parentExternalId,
        lastObservedRevision: observed.revision,
        ownerId: fence.ownerId,
        generation: fence.generation,
        now: Math.max(fence.now, boundaryNow),
      }));
  }

  private async runTrackerEffect<T>(
    fence: TrackerEffectFence,
    effect: () => Promise<T>,
  ): Promise<T> {
    this.assertExecutorLease(fence);
    const result = await effect();
    this.assertExecutorLease(fence);
    return result;
  }

  private assertExecutorLease(fence: TrackerEffectFence): void {
    if (!this.store.isExecutorLeaseCurrent(fence.ownerId, fence.generation, this.clock())) {
      throw new ExecutorLeaseLostError();
    }
  }

  private relationshipsFromTracker(
    artifact: WorkArtifact,
    current: readonly WorkArtifactRelationship[],
    external: TrackerArtifact,
  ): readonly WorkArtifactRelationship[] {
    const retained = current.filter((relationship) =>
      relationship.kind !== "parent" && relationship.kind !== "blocks");
    const relationships: WorkArtifactRelationship[] = [...retained];
    if (external.parentExternalId) {
      const parent = this.requireExternalArtifact(artifact, external.parentExternalId);
      relationships.push({
        kind: "parent",
        sourceArtifactId: artifact.id,
        sourceRef: `artifact:${artifact.id}`,
        targetArtifactId: parent.id,
        targetRef: `artifact:${parent.id}`,
      });
    }
    for (const externalId of external.blockerExternalIds) {
      const blocker = this.requireExternalArtifact(artifact, externalId);
      relationships.push({
        kind: "blocks",
        sourceArtifactId: blocker.id,
        sourceRef: `artifact:${blocker.id}`,
        targetArtifactId: artifact.id,
        targetRef: `artifact:${artifact.id}`,
      });
    }
    return normalizeRelationships(artifact.id, relationships);
  }

  private requireExternalArtifact(owner: WorkArtifact, externalId: string): WorkArtifact {
    const related = this.store.getWorkArtifactByExternalIdentity(
      owner.projectId,
      this.tracker.namespace,
      externalId,
    );
    if (!related || related.effortId !== owner.effortId) {
      throw new Error(`Tracker relationship ${externalId} is not bound to the owning effort`);
    }
    return related;
  }

  private requireRelatedArtifact(artifactId: string, projectId: string, effortId: string): WorkArtifact {
    const artifact = this.requireArtifact(artifactId);
    if (
      artifact.projectId !== projectId || artifact.effortId !== effortId ||
      artifact.trackerNamespace !== this.tracker.namespace
    ) {
      throw new TypeError("relationship artifacts must belong to the same project, effort, and tracker");
    }
    return artifact;
  }

  private requireArtifact(artifactId: string): WorkArtifact {
    const artifact = this.store.getWorkArtifact(artifactId);
    if (!artifact) throw new Error(`Work artifact ${artifactId} was not found`);
    if (
      artifact.trackerKind !== this.tracker.kind ||
      artifact.trackerNamespace !== this.tracker.namespace
    ) {
      throw new Error(`Work artifact ${artifactId} belongs to another tracker`);
    }
    return artifact;
  }

  private async observeResolvedBlockers(
    artifact: WorkArtifact,
    input: TrackerEffectFence & Readonly<{ now: number }>,
  ): Promise<readonly BlockerSettlement[]> {
    const blockerIds = this.store.listWorkArtifactRelationships(artifact.id)
      .filter((relationship) => relationship.kind === "blocks")
      .map((relationship) => relationship.sourceArtifactId)
      .filter((artifactId): artifactId is string => artifactId !== null)
      .sort((left, right) => left.localeCompare(right));
    const settlements: BlockerSettlement[] = [];
    for (const blockerId of blockerIds) {
      const blocker = await this.observe({ ...input, artifactId: blockerId });
      if (
        (blocker.artifact.status !== "resolved" && blocker.artifact.status !== "cancelled") ||
        blocker.artifact.externalStatus === "open"
      ) throw new TrackerConflictError(blocker.artifact.externalId);
      settlements.push({
        artifactId: blocker.artifact.id,
        snapshotId: blocker.snapshot.id,
        externalRevision: blocker.artifact.externalRevision,
      });
    }
    return settlements;
  }

  private assertBlockerSettlement(
    artifact: WorkArtifact,
    expected: readonly BlockerSettlement[],
  ): void {
    const currentIds = this.store.listWorkArtifactRelationships(artifact.id)
      .filter((relationship) => relationship.kind === "blocks")
      .map((relationship) => relationship.sourceArtifactId)
      .filter((artifactId): artifactId is string => artifactId !== null)
      .sort((left, right) => left.localeCompare(right));
    if (JSON.stringify(currentIds) !== JSON.stringify(expected.map((blocker) => blocker.artifactId))) {
      throw new TrackerConflictError(artifact.externalId);
    }
    for (const binding of expected) {
      const blocker = this.requireArtifact(binding.artifactId);
      if (
        blocker.currentSnapshotId !== binding.snapshotId ||
        blocker.externalRevision !== binding.externalRevision ||
        (blocker.status !== "resolved" && blocker.status !== "cancelled") ||
        blocker.externalStatus === "open"
      ) throw new TrackerConflictError(blocker.externalId);
    }
  }

  private claimMatchesWork(
    claim: WorkArtifactClaim,
    input: Pick<AdoptCoordinatedArtifactClaimInput, "workflowStepId" | "jobId" | "assignee">,
  ): boolean {
    return claim.workflowStepId === input.workflowStepId && claim.jobId === input.jobId &&
      claim.externalAssignee === input.assignee;
  }

  private async compensateVisibleClaim(
    artifact: WorkArtifact,
    assignee: string,
    input: TrackerEffectFence & Readonly<{ operationId: string; now: number }>,
    purpose: string,
  ): Promise<void> {
    const released = await this.runBoundTrackerEffect(artifact, input, () => this.tracker.release({
      externalId: artifact.externalId,
      assignee,
      operationId: derivedOperationId(input.operationId, purpose),
      expectedRevision: artifact.externalRevision,
    }));
    if (released.assignees.includes(assignee)) {
      throw new TrackerConflictError(released.externalId);
    }
    this.captureObservationFenced(artifact, released, input);
  }
}
