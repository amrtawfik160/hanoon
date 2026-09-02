import type { Job, StoredEffect } from "../domain/models";
import type { TaskAuthorityOperation } from "../domain/task-authority";
import type { JobResourceClaim } from "../autonomy/models";
import type { EffectFence } from "../services/effect-runner";
import type { TelegramAgentStore } from "../storage/store";
import { navigatorClaimContract } from "./claim-contracts";
import type {
  NavigatorArtifactBinding,
  NavigatorProposalRecord,
  NavigatorSkillAttempt,
  NavigatorWorkflowStep,
} from "./models";
import type { NavigatorReleaseAttempt } from "./release-contracts";
import type {
  NavigatorCapabilityEvidence,
  NavigatorEffectContext,
  NavigatorEffectReceipt,
  NavigatorReleaseReceipt,
  NavigatorReleaseEffectContext,
  NavigatorSkillEffectContext,
  NavigatorTicketReceipt,
  NavigatorTicketEffectContext,
  NavigatorTicketAttemptContext,
} from "./effect-contracts";
import { navigatorEffectReceiptSchema } from "./effect-contracts";

export type {
  NavigatorCapabilityEvidence,
  NavigatorEffectContext,
  NavigatorEffectReceipt,
  NavigatorReleaseEffectContext,
  NavigatorSkillEffectContext,
  NavigatorTicketEffectContext,
} from "./effect-contracts";

export const NAVIGATOR_EFFECT_KINDS = [
  "run_navigator_skill",
  "run_navigator_ticket_worker",
  "run_navigator_release",
] as const;

export type NavigatorEffectKind = (typeof NAVIGATOR_EFFECT_KINDS)[number];
type NavigatorJob = NonNullable<ReturnType<TelegramAgentStore["getJob"]>>;

export type NavigatorEffectOutcome =
  | Readonly<{ outcome: "completed"; receipt: NavigatorEffectReceipt }>
  | Readonly<{ outcome: "transient"; reason: string }>
  | Readonly<{ outcome: "permanent"; reason: string }>
  | Readonly<{ outcome: "lease_cancelled"; reason: string }>
  | Readonly<{ outcome: "ambiguous"; reason: string }>;

export type NavigatorEffectAdapter = Readonly<{
  kind: NavigatorEffectKind;
  execute(context: NavigatorEffectContext): Promise<NavigatorEffectOutcome>;
  reconcile?(context: NavigatorEffectContext): Promise<NavigatorEffectOutcome>;
}>;

type NavigatorEffectStore = Pick<
  TelegramAgentStore,
  | "leaseNavigatorEffect"
  | "isExecutorLeaseCurrent"
  | "getEffect"
  | "getJob"
  | "getNavigatorWorkflowStep"
  | "getNavigatorProposal"
  | "getNavigatorProposalDecision"
  | "getNavigatorSkillAttempt"
  | "getNavigatorReleaseAttempt"
  | "getNavigatorCapabilityEvidence"
  | "admitNavigatorCapabilityEvidence"
  | "settleNavigatorSkillAttempt"
  | "settleNavigatorTicketWorkerAttempt"
  | "settleNavigatorReleaseEffect"
  | "getNavigatorTicketAttemptContext"
  | "getCurrentWorkArtifactSnapshot"
  | "isWorkArtifactSnapshotValid"
  | "listCurrentHeldResourceClaims"
  | "taskAuthorityOperationIsCurrent"
  | "renewJobOperationFences"
  | "completeEffect"
  | "failEffect"
  | "deadLetterEffect"
>;

export type NavigatorEffectProtocolDependencies = Readonly<{
  store: NavigatorEffectStore;
  clock: { now(): number };
  adapters: readonly NavigatorEffectAdapter[];
  leaseMs?: number;
}>;

export class NavigatorEffectTransientError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NavigatorEffectTransientError";
  }
}

export class NavigatorEffectPermanentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NavigatorEffectPermanentError";
  }
}

export class NavigatorEffectAmbiguousError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NavigatorEffectAmbiguousError";
  }
}

export class NavigatorEffectLeaseCancellationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NavigatorEffectLeaseCancellationError";
  }
}

const TERMINAL_JOB_STATES = new Set<Job["state"]>([
  "merged",
  "cancelled",
  "blocked",
  "complete",
  "production_failed",
]);

function isNavigatorEffectKind(kind: StoredEffect["kind"]): kind is NavigatorEffectKind {
  return (NAVIGATOR_EFFECT_KINDS as readonly string[]).includes(kind);
}

function payloadIdentifier(effect: StoredEffect, key: string): string | null {
  const payloadValue = effect.payload[key];
  return typeof payloadValue === "string" && payloadValue.length > 0 && payloadValue.length <= 256
    ? payloadValue
    : null;
}

function safeReason(reasonValue: unknown, fallback: string): string {
  const rawReason = reasonValue instanceof Error ? reasonValue.message : String(reasonValue);
  const normalized = rawReason.replace(/[^\x20-\x7E]/gu, " ").trim().slice(0, 500);
  return normalized || fallback;
}

function cloneAndFreezeNavigatorValue<T>(navigatorValue: T): T {
  if (Array.isArray(navigatorValue)) {
    return Object.freeze(navigatorValue.map((entry) => cloneAndFreezeNavigatorValue(entry))) as T;
  }
  if (typeof navigatorValue !== "object" || navigatorValue === null || Object.getPrototypeOf(navigatorValue) !== Object.prototype) {
    return navigatorValue;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(navigatorValue)) copy[key] = cloneAndFreezeNavigatorValue(entry);
  return Object.freeze(copy) as T;
}

function authorityOperations(
  effect: StoredEffect,
  skillAttempt: NavigatorSkillAttempt | null,
): readonly TaskAuthorityOperation[] {
  if (effect.kind === "run_navigator_skill") return [skillAttempt?.skillId === "prototype" ? "prototype" : "artifact"];
  if (effect.kind === "run_navigator_ticket_worker") return ["worktree", "commit", "push", "pull_request"];
  return ["commit", "push", "pull_request"];
}

function proposalKindMatches(effect: StoredEffect, proposal: NavigatorProposalRecord): boolean {
  if (proposal.proposal === null) return false;
  if (effect.kind === "run_navigator_release") return proposal.proposal.kind === "start_release";
  return proposal.proposal.kind === "invoke_skill" || proposal.proposal.kind === "unresolved_next_step";
}

function effectIsLeasedBy(
  effect: StoredEffect,
  ownerId: string,
  generation: number,
  now: number,
): boolean {
  return effect.status === "leased" && effect.leaseOwner === ownerId &&
    effect.leaseGeneration === generation && effect.leaseExpiresAt !== null && effect.leaseExpiresAt > now;
}

type NavigatorAttemptEvidence = Readonly<{
  skillAttempt: NavigatorSkillAttempt | null;
  releaseAttempt: NavigatorReleaseAttempt | null;
  ticketContext: NavigatorTicketAttemptContext | null;
}>;

type NavigatorAdmissionEvidence = Readonly<{
  job: NavigatorJob;
  resourceClaims: readonly JobResourceClaim[];
  capabilityEvidence: readonly NavigatorCapabilityEvidence[];
}>;

type NavigatorWorkflowContext = Readonly<{
  workflowStep: NavigatorWorkflowStep | null;
  acceptedProposal: NavigatorProposalRecord | null;
}>;

type NavigatorReceiptSettlementRequest<TReceipt> = Readonly<{
  effect: StoredEffect;
  context: NavigatorEffectContext;
  receipt: TReceipt;
  current: StoredEffect;
  now: number;
}>;

function frozenExecutionContext(input: Readonly<{
  effect: StoredEffect;
  job: NavigatorJob;
  fence: Pick<EffectFence, "ownerId" | "generation">;
  signal: AbortSignal;
  workflowStep: NavigatorWorkflowStep | null;
  acceptedProposal: NavigatorProposalRecord | null;
  skillAttempt: NavigatorSkillAttempt | null;
  releaseAttempt: NavigatorReleaseAttempt | null;
  ticketContext: NavigatorTicketAttemptContext | null;
  artifactBindings: readonly NavigatorArtifactBinding[];
  resourceClaims: readonly JobResourceClaim[];
  authorityOperations: readonly TaskAuthorityOperation[];
  capabilityEvidence: readonly import("./effect-contracts").NavigatorCapabilityEvidence[];
}>): NavigatorEffectContext {
  const base = {
    effect: cloneAndFreezeNavigatorValue({ ...input.effect, payload: { ...input.effect.payload } }),
    job: cloneAndFreezeNavigatorValue(input.job),
    fence: Object.freeze({ ...input.fence }),
    signal: input.signal,
    artifactBindings: cloneAndFreezeNavigatorValue(input.artifactBindings),
    resourceClaims: cloneAndFreezeNavigatorValue(input.resourceClaims),
    authorityOperations: Object.freeze([...input.authorityOperations]),
    capabilityEvidence: cloneAndFreezeNavigatorValue(input.capabilityEvidence),
  } as const;
  if (input.effect.kind === "run_navigator_skill" && input.workflowStep && input.acceptedProposal && input.skillAttempt) {
    return Object.freeze({
      ...base,
      kind: "run_navigator_skill" as const,
      workflowStep: cloneAndFreezeNavigatorValue(input.workflowStep),
      acceptedProposal: cloneAndFreezeNavigatorValue(input.acceptedProposal),
      attempt: cloneAndFreezeNavigatorValue(input.skillAttempt),
    });
  }
  if (input.effect.kind === "run_navigator_ticket_worker" && input.ticketContext) {
    return Object.freeze({
      ...base,
      kind: "run_navigator_ticket_worker" as const,
      workflowStep: null,
      acceptedProposal: null,
      ticket: cloneAndFreezeNavigatorValue(input.ticketContext),
    });
  }
  if (input.effect.kind === "run_navigator_release" && input.workflowStep && input.acceptedProposal && input.releaseAttempt) {
    return Object.freeze({
      ...base,
      kind: "run_navigator_release" as const,
      workflowStep: cloneAndFreezeNavigatorValue(input.workflowStep),
      acceptedProposal: cloneAndFreezeNavigatorValue(input.acceptedProposal),
      attempt: cloneAndFreezeNavigatorValue(input.releaseAttempt),
    });
  }
  throw new TypeError("Navigator effect context is missing its operation-specific evidence");
}

export class NavigatorEffectProtocol {
  private readonly adapters: ReadonlyMap<NavigatorEffectKind, NavigatorEffectAdapter>;

  public constructor(private readonly dependencies: NavigatorEffectProtocolDependencies) {
    const adapters = new Map<NavigatorEffectKind, NavigatorEffectAdapter>();
    for (const adapter of dependencies.adapters) {
      if (!isNavigatorEffectKind(adapter.kind) || adapters.has(adapter.kind)) {
        throw new TypeError("Navigator effect protocol requires one adapter per effect kind");
      }
      adapters.set(adapter.kind, adapter);
    }
    if (adapters.size !== NAVIGATOR_EFFECT_KINDS.length) {
      throw new TypeError("Navigator effect protocol requires skill, ticket, and release adapters");
    }
    this.adapters = adapters;
  }

  public async processOne(fence: EffectFence, signal: AbortSignal): Promise<boolean> {
    const executionSignal = AbortSignal.any([fence.signal, signal]);
    const effect = this.dependencies.store.leaseNavigatorEffect({
      ownerId: fence.ownerId,
      generation: fence.generation,
      now: this.dependencies.clock.now(),
      leaseMs: this.dependencies.leaseMs ?? 30_000,
    });
    if (!effect) return false;
    if (!isNavigatorEffectKind(effect.kind)) return this.reject(effect, fence, "Navigator effect kind is not admitted");
    const adapter = this.adapters.get(effect.kind);
    if (!adapter) return this.reject(effect, fence, "Navigator effect kind is not admitted");
    const prepared = this.prepareContext(effect, fence, executionSignal);
    if ("reason" in prepared) return this.reject(effect, fence, prepared.reason);
    return this.executeNavigatorEffect(effect, adapter, prepared.context);
  }

  private prepareContext(
    effect: StoredEffect,
    fence: EffectFence,
    signal: AbortSignal,
  ): { context: NavigatorEffectContext } | { reason: string } {
    const now = this.dependencies.clock.now();
    const admission = this.prepareAdmission(effect, fence, now);
    if ("reason" in admission) return admission;
    const stepValidation = this.prepareWorkflowContext(effect, admission.job);
    if ("reason" in stepValidation) return stepValidation;
    const attempts = this.attemptEvidence(effect, admission.job, stepValidation.workflowStep, fence, now);
    if ("reason" in attempts) return attempts;
    const { skillAttempt, releaseAttempt, ticketContext } = attempts;
    const artifactValidation = this.validateArtifactBindings(admission.job.artifactBindings);
    if (artifactValidation !== null) return { reason: artifactValidation };
    const operations = authorityOperations(effect, skillAttempt);
    return this.authorityIsCurrent(effect, operations)
      ? { context: this.executionContext({
        effect,
        fence,
        signal,
        admission,
        workflow: stepValidation,
        attempts,
        operations,
      }) }
      : { reason: "Navigator task authority evidence is absent, stale, or denied" };
  }

  private executionContext(input: Readonly<{
    effect: StoredEffect;
    fence: EffectFence;
    signal: AbortSignal;
    admission: NavigatorAdmissionEvidence;
    workflow: NavigatorWorkflowContext;
    attempts: NavigatorAttemptEvidence;
    operations: readonly TaskAuthorityOperation[];
  }>): NavigatorEffectContext {
    const { skillAttempt, releaseAttempt, ticketContext } = input.attempts;
    return frozenExecutionContext({
      effect: input.effect,
      job: input.admission.job,
      fence: input.fence,
      signal: input.signal,
      workflowStep: input.workflow.workflowStep,
      acceptedProposal: input.workflow.acceptedProposal,
      artifactBindings: input.admission.job.artifactBindings,
      resourceClaims: input.admission.resourceClaims,
      authorityOperations: input.operations,
      skillAttempt,
      releaseAttempt,
      ticketContext,
      capabilityEvidence: input.admission.capabilityEvidence,
    });
  }

  private prepareAdmission(
    effect: StoredEffect,
    fence: EffectFence,
    now: number,
  ): NavigatorAdmissionEvidence | { reason: string } {
    const leaseReason = this.leaseValidation(effect, fence, now);
    if (leaseReason !== null) return { reason: leaseReason };
    const job = this.dependencies.store.getJob(effect.jobId);
    const jobReason = this.jobValidation(job);
    if (jobReason !== null || job === null) return { reason: jobReason ?? "Navigator effect job is unavailable" };
    const ticketContext = effect.kind === "run_navigator_ticket_worker"
      ? this.ticketContextForAdmission(effect, fence, now)
      : null;
    if (effect.kind === "run_navigator_ticket_worker" && ticketContext === null) {
      return { reason: "Navigator ticket work-artifact claim is stale or unavailable" };
    }
    const resourceClaims = this.dependencies.store.listCurrentHeldResourceClaims(job.id, 128);
    if (!this.claimsAreCurrent(effect, job, resourceClaims, ticketContext, fence, now)) {
      return { reason: "Navigator effect resource claim is absent, unrelated, or stale" };
    }
    if (job.projectId === null || !this.dependencies.store.admitNavigatorCapabilityEvidence({
      effectIdempotencyKey: effect.idempotencyKey,
      jobId: job.id,
      projectId: job.projectId,
      ownerId: fence.ownerId,
      generation: fence.generation,
      now,
    })) return { reason: "Navigator capability evidence is absent, stale, denied, or not exact" };
    const capabilityEvidence = this.dependencies.store.getNavigatorCapabilityEvidence(effect.idempotencyKey);
    return { job, resourceClaims, capabilityEvidence };
  }

  private ticketContextForAdmission(
    effect: StoredEffect,
    fence: EffectFence,
    now: number,
  ): NavigatorTicketAttemptContext | null {
    const attemptId = payloadIdentifier(effect, "attemptId");
    return attemptId === null ? null : this.dependencies.store.getNavigatorTicketAttemptContext({
      attemptId,
      effectIdempotencyKey: effect.idempotencyKey,
      ownerId: fence.ownerId,
      generation: fence.generation,
      now,
    });
  }

  private leaseValidation(effect: StoredEffect, fence: EffectFence, now: number): string | null {
    const current = this.dependencies.store.getEffect(effect.jobId, effect.idempotencyKey);
    return current && this.leaseIsCurrent(current, fence, now)
      ? null
      : "Navigator effect lease is no longer current";
  }

  private leaseIsCurrent(
    effect: StoredEffect,
    fence: Pick<EffectFence, "ownerId" | "generation">,
    now: number,
  ): boolean {
    return effectIsLeasedBy(effect, fence.ownerId, fence.generation, now) &&
      this.dependencies.store.isExecutorLeaseCurrent(fence.ownerId, fence.generation, now);
  }

  private jobValidation(job: NavigatorJob | null): string | null {
    if (job === null || job.workflowEngine !== "navigator-v1" || job.workflowMode !== "deterministic") {
      return "Navigator effect job is not deterministic navigator-v1";
    }
    return TERMINAL_JOB_STATES.has(job.state) || job.cancelRequestedAt !== null
      ? "Navigator effect job is cancelled or terminal"
      : null;
  }

  private claimsAreCurrent(
    effect: StoredEffect,
    job: NavigatorJob,
    claims: readonly JobResourceClaim[],
    ticketContext: NavigatorTicketAttemptContext | null,
    fence: EffectFence,
    now: number,
  ): boolean {
    if (!isNavigatorEffectKind(effect.kind)) return false;
    const contract = navigatorClaimContract(effect.kind, job);
    if (contract === null || claims.length !== contract.resourceClaims.length) return false;
    const resourceClaimsAreCurrent = claims.every((claim) =>
      this.claimIsCurrent(claim, fence, now) && contract.resourceClaims.some((requirement) =>
        requirement.resourceKind === claim.resourceKind && requirement.resourceKey === claim.resourceKey)) &&
      contract.resourceClaims.every((requirement) => claims.some((claim) =>
        requirement.resourceKind === claim.resourceKind && requirement.resourceKey === claim.resourceKey));
    const ticketClaimIsCurrent = !contract.requiresTicketWorkArtifact ||
      (ticketContext !== null && this.claimIsCurrent(ticketContext.claim, fence, now));
    return resourceClaimsAreCurrent && ticketClaimIsCurrent;
  }

  private prepareWorkflowContext(
    effect: StoredEffect,
    job: NavigatorJob,
  ): {
    workflowStep: NavigatorWorkflowStep | null;
    acceptedProposal: NavigatorProposalRecord | null;
  } | { reason: string } {
    if (effect.kind === "run_navigator_ticket_worker") return { workflowStep: null, acceptedProposal: null };
    const workflowStep = this.workflowStep(effect, job);
    if ("reason" in workflowStep) return workflowStep;
    const acceptedProposal = this.acceptedProposal(effect, job, workflowStep);
    return "reason" in acceptedProposal
      ? acceptedProposal
      : { workflowStep, acceptedProposal };
  }

  private workflowStep(
    effect: StoredEffect,
    job: NavigatorJob,
  ): NavigatorWorkflowStep | { reason: string } {
    const workflowStepId = payloadIdentifier(effect, "workflowStepId");
    const snapshotId = payloadIdentifier(effect, "snapshotId");
    const step = workflowStepId === null ? null : this.dependencies.store.getNavigatorWorkflowStep(workflowStepId);
    return step && step.jobId === job.id && step.workflowRevision === job.workflowRevision &&
      step.id === job.currentWorkflowStepId && step.snapshotId === snapshotId
      ? step
      : { reason: "Navigator workflow revision or snapshot binding is stale" };
  }

  private acceptedProposal(
    effect: StoredEffect,
    job: NavigatorJob,
    workflowStep: NavigatorWorkflowStep,
  ): NavigatorProposalRecord | { reason: string } {
    const proposal = this.dependencies.store.getNavigatorProposal(workflowStep.proposalId);
    const decision = this.dependencies.store.getNavigatorProposalDecision(workflowStep.proposalId);
    return proposal && decision?.decision === "accepted" && proposal.jobId === job.id &&
      proposal.snapshotId === workflowStep.snapshotId &&
      proposalKindMatches(effect, proposal)
      ? proposal
      : { reason: "Navigator effect does not have an accepted proposal" };
  }

  private attemptEvidence(
    effect: StoredEffect,
    job: NavigatorJob,
    workflowStep: NavigatorWorkflowStep | null,
    fence: EffectFence,
    now: number,
  ): NavigatorAttemptEvidence | { reason: string } {
    if (effect.kind === "run_navigator_skill") return this.skillAttemptEvidence(effect, job, workflowStep);
    if (effect.kind === "run_navigator_release") return this.releaseAttemptEvidence(effect, job, workflowStep);
    return this.ticketAttemptEvidence(effect, job, fence, now);
  }

  private skillAttemptEvidence(
    effect: StoredEffect,
    job: NavigatorJob,
    workflowStep: NavigatorWorkflowStep | null,
  ): NavigatorAttemptEvidence | { reason: string } {
    const attempt = this.dependencies.store.getNavigatorSkillAttempt(payloadIdentifier(effect, "attemptId") ?? "");
    return attempt && workflowStep && attempt.effectIdempotencyKey === effect.idempotencyKey &&
      attempt.jobId === job.id && attempt.workflowStepId === workflowStep.id
      ? { skillAttempt: attempt, releaseAttempt: null, ticketContext: null }
      : { reason: "Navigator skill attempt identity is unavailable" };
  }

  private releaseAttemptEvidence(
    effect: StoredEffect,
    job: NavigatorJob,
    workflowStep: NavigatorWorkflowStep | null,
  ): NavigatorAttemptEvidence | { reason: string } {
    const attempt = this.dependencies.store.getNavigatorReleaseAttempt(payloadIdentifier(effect, "attemptId") ?? "");
    return attempt && workflowStep && attempt.effectIdempotencyKey === effect.idempotencyKey &&
      attempt.jobId === job.id && attempt.workflowStepId === workflowStep.id
      ? { skillAttempt: null, releaseAttempt: attempt, ticketContext: null }
      : { reason: "Navigator release attempt identity is unavailable" };
  }

  private ticketAttemptEvidence(
    effect: StoredEffect,
    job: NavigatorJob,
    fence: EffectFence,
    now: number,
  ): NavigatorAttemptEvidence | { reason: string } {
    const attemptId = payloadIdentifier(effect, "attemptId");
    const ticketContext = attemptId === null ? null : this.dependencies.store.getNavigatorTicketAttemptContext({
      attemptId,
      effectIdempotencyKey: effect.idempotencyKey,
      ownerId: fence.ownerId,
      generation: fence.generation,
      now,
    });
    return ticketContext?.attempt.jobId === job.id
      ? { skillAttempt: null, releaseAttempt: null, ticketContext }
      : { reason: "Navigator ticket attempt context is stale or unavailable" };
  }

  private authorityIsCurrent(effect: StoredEffect, operations: readonly TaskAuthorityOperation[]): boolean {
    return operations.every((operation) => this.dependencies.store.taskAuthorityOperationIsCurrent(effect, operation));
  }

  private validateArtifactBindings(bindings: readonly NavigatorArtifactBinding[]): string | null {
    for (const binding of bindings) {
      const snapshot = this.dependencies.store.getCurrentWorkArtifactSnapshot(binding.artifactId);
      if (snapshot === null || snapshot.id !== binding.snapshotId || snapshot.snapshotDigest !== binding.snapshotDigest ||
        !this.dependencies.store.isWorkArtifactSnapshotValid(binding.snapshotId)) {
        return "Navigator artifact snapshot is stale or unavailable";
      }
    }
    return null;
  }

  private claimIsCurrent(
    claim: Readonly<{ state: string; ownerId: string; generation: number; leaseExpiresAt: number }>,
    fence: EffectFence,
    now: number,
  ): boolean {
    return claim.state === "held" && claim.ownerId === fence.ownerId && claim.generation === fence.generation &&
      claim.leaseExpiresAt > now;
  }

  private async executeNavigatorEffect(
    effect: StoredEffect,
    adapter: NavigatorEffectAdapter,
    context: NavigatorEffectContext,
  ): Promise<boolean> {
    const leaseAbort = new AbortController();
    const runSignal = AbortSignal.any([context.signal, leaseAbort.signal]);
    const runningContext = Object.freeze({ ...context, signal: runSignal });
    const renewal = setInterval(() => this.renewNavigatorEffect(effect, context, leaseAbort), this.renewalInterval());
    try {
      const outcome = context.signal.aborted
        ? { outcome: "lease_cancelled" as const, reason: "Navigator executor signal was cancelled" }
        : await this.runWithInterruption(adapter.execute(runningContext), runSignal);
      return this.settleNavigatorOutcome(effect, adapter, runningContext, outcome);
    } catch (error) {
      return this.settleNavigatorOutcome(effect, adapter, runningContext, this.classify(error, runSignal));
    } finally {
      clearInterval(renewal);
    }
  }

  private renewalInterval(): number {
    const leaseMs = this.dependencies.leaseMs ?? 30_000;
    return Math.max(1, Math.min(10_000, Math.floor(leaseMs / 3)));
  }

  private renewNavigatorEffect(effect: StoredEffect, context: NavigatorEffectContext, leaseAbort: AbortController): void {
    if (leaseAbort.signal.aborted) return;
    try {
      const now = this.dependencies.clock.now();
      const job = this.dependencies.store.getJob(effect.jobId);
      if (this.jobCancellationRequested(job)) {
        leaseAbort.abort(new NavigatorEffectLeaseCancellationError("Navigator job cancellation requested"));
        return;
      }
      const renewed = this.dependencies.store.renewJobOperationFences(this.renewalInput(effect, context, now));
      if (!renewed) leaseAbort.abort(new NavigatorEffectLeaseCancellationError("Navigator effect lease was lost"));
    } catch (error) {
      leaseAbort.abort(error instanceof Error ? error : new Error("Navigator effect lease renewal failed"));
    }
  }

  private jobCancellationRequested(job: NavigatorJob | null): boolean {
    return job !== null && (job.cancelRequestedAt !== null || job.state === "cancelled");
  }

  private renewalInput(
    effect: StoredEffect,
    context: NavigatorEffectContext,
    now: number,
  ): Parameters<NavigatorEffectStore["renewJobOperationFences"]>[0] {
    return {
      jobId: effect.jobId,
      effectIdempotencyKey: effect.idempotencyKey,
      ownerId: context.fence.ownerId,
      generation: context.fence.generation,
      now,
      leaseMs: this.dependencies.leaseMs ?? 30_000,
    };
  }

  private async runWithInterruption(
    operation: Promise<NavigatorEffectOutcome>,
    signal: AbortSignal,
  ): Promise<NavigatorEffectOutcome> {
    const interruption = new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new NavigatorEffectLeaseCancellationError("Navigator effect was cancelled"));
        return;
      }
      signal.addEventListener("abort", () => {
        reject(signal.reason ?? new NavigatorEffectLeaseCancellationError("Navigator effect was cancelled"));
      }, { once: true });
    });
    return Promise.race([operation, interruption]);
  }

  private classify(error: unknown, signal: AbortSignal): NavigatorEffectOutcome {
    if (error instanceof NavigatorEffectAmbiguousError) return { outcome: "ambiguous", reason: error.message };
    if (error instanceof NavigatorEffectPermanentError) return { outcome: "permanent", reason: error.message };
    if (error instanceof NavigatorEffectLeaseCancellationError || signal.aborted) {
      return { outcome: "lease_cancelled", reason: safeReason(error ?? signal.reason, "Navigator effect was cancelled") };
    }
    if (error instanceof NavigatorEffectTransientError) return { outcome: "transient", reason: error.message };
    return { outcome: "transient", reason: safeReason(error, "Navigator effect failed") };
  }

  private async settleNavigatorOutcome(
    effect: StoredEffect,
    adapter: NavigatorEffectAdapter,
    context: NavigatorEffectContext,
    outcome: NavigatorEffectOutcome,
  ): Promise<boolean> {
    const reconciled = await this.reconcileAmbiguousOutcome(effect, adapter, context, outcome);
    return this.settleCurrent(effect, context, reconciled);
  }

  private async reconcileAmbiguousOutcome(
    effect: StoredEffect,
    adapter: NavigatorEffectAdapter,
    context: NavigatorEffectContext,
    outcome: NavigatorEffectOutcome,
  ): Promise<NavigatorEffectOutcome> {
    if (outcome.outcome !== "ambiguous" || !adapter.reconcile) return outcome;
    const current = this.dependencies.store.getEffect(effect.jobId, effect.idempotencyKey);
    if (!current || !this.leaseIsCurrent(current, context.fence, this.dependencies.clock.now())) return outcome;
    try {
      const reconciled = await this.runWithInterruption(adapter.reconcile(context), context.signal);
      return reconciled.outcome === "ambiguous"
        ? { outcome: "transient", reason: `ambiguous outcome: ${reconciled.reason}` }
        : reconciled;
    } catch (error) {
      return { outcome: "transient", reason: `ambiguous reconciliation failed: ${safeReason(error, "unknown error")}` };
    }
  }

  private settleCurrent(
    effect: StoredEffect,
    context: NavigatorEffectContext,
    outcome: NavigatorEffectOutcome,
  ): boolean {
    const now = this.dependencies.clock.now();
    const current = this.dependencies.store.getEffect(effect.jobId, effect.idempotencyKey);
    if (!current || !this.leaseIsCurrent(current, context.fence, now)) return true;
    if (outcome.outcome === "completed") {
      const receipt = this.completedReceipt(effect, context, outcome.receipt);
      if ("reason" in receipt) return this.deadLetterCurrent(effect, context, receipt.reason, now);
      if (receipt.kind === "run_navigator_skill") {
        if (context.kind !== "run_navigator_skill") {
          return this.deadLetterCurrent(effect, context, "Navigator receipt kind does not match its context", now);
        }
        try {
          const settled = this.dependencies.store.settleNavigatorSkillAttempt({
            attemptId: context.attempt.id,
            effectIdempotencyKey: effect.idempotencyKey,
            observedExternalStateDigest: receipt.observedExternalStateDigest,
            result: receipt.result,
            receipt,
            ownerId: context.fence.ownerId,
            generation: context.fence.generation,
            now,
          });
          return settled !== null
            ? true
            : this.retryCurrent(effect, context, "Navigator skill settlement fence was lost", current.attempts, now);
        } catch (error) {
          return this.retryCurrent(
            effect,
            context,
            `Navigator skill settlement failed: ${safeReason(error, "persistence error")}`,
            current.attempts,
            now,
          );
        }
      }
      if (receipt.kind === "run_navigator_ticket_worker") {
        return this.settleTicketReceipt({ effect, context, receipt, current, now });
      }
      if (receipt.kind === "run_navigator_release") {
        return this.settleReleaseReceipt({ effect, context, receipt, current, now });
      }
      return this.deadLetterCurrent(effect, context, "Navigator completion receipt kind is not admitted", now);
    }
    if (outcome.outcome === "permanent") return this.deadLetterCurrent(effect, context, outcome.reason, now);
    const currentJob = this.dependencies.store.getJob(effect.jobId);
    if (outcome.outcome === "lease_cancelled" && currentJob !== null && (
      currentJob.cancelRequestedAt !== null || currentJob.state === "cancelled"
    )) return this.deadLetterCurrent(effect, context, outcome.reason, now);
    return this.retryCurrent(effect, context, outcome.reason, current.attempts, now);
  }

  private settleTicketReceipt(input: NavigatorReceiptSettlementRequest<NavigatorTicketReceipt>): boolean {
    if (input.context.kind !== "run_navigator_ticket_worker") {
      return this.deadLetterCurrent(input.effect, input.context, "Navigator receipt kind does not match its context", input.now);
    }
    try {
      const settled = this.dependencies.store.settleNavigatorTicketWorkerAttempt({
        attemptId: input.context.ticket.attempt.id,
        effectIdempotencyKey: input.effect.idempotencyKey,
        receipt: input.receipt,
        ownerId: input.context.fence.ownerId,
        generation: input.context.fence.generation,
        now: input.now,
      });
      return settled !== null
        ? true
        : this.retryCurrent(input.effect, input.context, "Navigator ticket settlement fence was lost", input.current.attempts, input.now);
    } catch (error) {
      return this.retryCurrent(
        input.effect,
        input.context,
        `Navigator ticket settlement failed: ${safeReason(error, "persistence error")}`,
        input.current.attempts,
        input.now,
      );
    }
  }

  private settleReleaseReceipt(input: NavigatorReceiptSettlementRequest<NavigatorReleaseReceipt>): boolean {
    if (input.context.kind !== "run_navigator_release") {
      return this.deadLetterCurrent(input.effect, input.context, "Navigator receipt kind does not match its context", input.now);
    }
    try {
      const settled = this.dependencies.store.settleNavigatorReleaseEffect({
        effectIdempotencyKey: input.effect.idempotencyKey,
        number: input.receipt.number,
        url: input.receipt.url,
        environmentId: input.receipt.environmentId,
        receipt: input.receipt,
        ownerId: input.context.fence.ownerId,
        generation: input.context.fence.generation,
        now: input.now,
      });
      return settled
        ? true
        : this.retryCurrent(input.effect, input.context, "Navigator release settlement fence was lost", input.current.attempts, input.now);
    } catch (error) {
      return this.retryCurrent(
        input.effect,
        input.context,
        `Navigator release settlement failed: ${safeReason(error, "persistence error")}`,
        input.current.attempts,
        input.now,
      );
    }
  }

  private completedReceipt(
    effect: StoredEffect,
    context: NavigatorEffectContext,
    rawReceipt: unknown,
  ): NavigatorEffectReceipt | { reason: string } {
    if (rawReceipt === undefined) return { reason: "Navigator completion receipt is required" };
    const parsed = navigatorEffectReceiptSchema.safeParse(rawReceipt);
    if (!parsed.success) return { reason: "Navigator completion receipt is invalid" };
    if (parsed.data.kind !== effect.kind || parsed.data.effectIdempotencyKey !== effect.idempotencyKey) {
      return { reason: "Navigator completion receipt is bound to another effect" };
    }
    const attemptId = context.kind === "run_navigator_ticket_worker"
      ? context.ticket.attempt.id
      : context.attempt.id;
    return parsed.data.attemptId === attemptId
      ? parsed.data
      : { reason: "Navigator completion receipt is bound to another attempt" };
  }

  private deadLetterCurrent(
    effect: StoredEffect,
    context: NavigatorEffectContext,
    reason: string,
    now: number,
  ): boolean {
    this.dependencies.store.deadLetterEffect(
      effect.idempotencyKey,
      context.fence.ownerId,
      context.fence.generation,
      safeReason(reason, "Navigator effect permanently failed"),
      now,
    );
    return true;
  }

  private retryCurrent(
    effect: StoredEffect,
    context: NavigatorEffectContext,
    reason: string,
    attempts: number,
    now: number,
  ): boolean {
    const delay = Math.min(60_000, 500 * (2 ** Math.min(6, Math.max(0, attempts - 1))));
    this.dependencies.store.failEffect(
      effect.idempotencyKey,
      context.fence.ownerId,
      context.fence.generation,
      safeReason(reason, "Navigator effect will be retried"),
      now + delay,
      now,
    );
    return true;
  }

  private reject(effect: StoredEffect, fence: EffectFence, reason: string): boolean {
    this.dependencies.store.deadLetterEffect(
      effect.idempotencyKey,
      fence.ownerId,
      fence.generation,
      safeReason(reason, "Navigator effect admission was rejected"),
      this.dependencies.clock.now(),
    );
    return true;
  }
}
