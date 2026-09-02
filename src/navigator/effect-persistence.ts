import type { Job, JobEffect, StoredEffect } from "../domain/models";
import type { TaskAuthorityOperation } from "../domain/task-authority";
import type { JobResourceClaim } from "../autonomy/models";
import type { WorkArtifactSnapshot } from "../work-artifacts/models";
import type {
  NavigatorCapabilityEvidence,
  NavigatorReleaseReceipt,
  NavigatorSkillReceipt,
  NavigatorTicketAttemptContext,
  NavigatorTicketReceipt,
  NavigatorTicketWorkerResource,
} from "./effect-contracts";
import type {
  NavigatorArtifactBinding,
  NavigatorProposalDecision,
  NavigatorProposalRecord,
  NavigatorPlanningResultRecord,
  NavigatorSkillAttempt,
  NavigatorWorkflowStep,
  NavigatorWorkflowStepOutcome,
} from "./models";
import type { NavigatorReleaseAttempt } from "./release-contracts";
import type { NavigatorTicketWorkerOutcome } from "./ticket-settlement-repository";

/**
 * The complete persistence contract for a Navigator effect tick.
 *
 * This deliberately describes domain transitions rather than exposing the
 * store, a database handle, or a transaction callback. Implementations keep
 * the reads and fenced writes in the same SQLite transaction where required.
 */
export interface NavigatorEffectPersistence {
  leaseNavigatorEffect(input: Readonly<{
    ownerId: string;
    generation: number;
    now: number;
    leaseMs: number;
  }>): StoredEffect | null;
  isExecutorLeaseCurrent(ownerId: string, generation: number, now: number): boolean;
  getEffect(jobId: string, idempotencyKey: string): StoredEffect | null;
  getJob(jobId: string): Job | null;
  getNavigatorWorkflowStep(id: string): NavigatorWorkflowStep | null;
  getNavigatorProposal(id: string): NavigatorProposalRecord | null;
  getNavigatorProposalDecision(id: string): NavigatorProposalDecision | null;
  getNavigatorSkillAttempt(id: string): NavigatorSkillAttempt | null;
  getNavigatorPlanningResult(attemptId: string): NavigatorPlanningResultRecord | null;
  recordNavigatorPlanningResult(input: Readonly<{
    attemptId: string;
    effectIdempotencyKey: string;
    observedExternalStateDigest: string;
    result: unknown;
    ownerId: string;
    generation: number;
    now: number;
  }>): NavigatorPlanningResultRecord | null;
  getNavigatorReleaseAttempt(id: string): NavigatorReleaseAttempt | null;
  getNavigatorCapabilityEvidence(effectIdempotencyKey: string): readonly NavigatorCapabilityEvidence[];
  admitNavigatorCapabilityEvidence(input: Readonly<{
    effectIdempotencyKey: string;
    jobId: string;
    projectId: string;
    ownerId: string;
    generation: number;
    now: number;
  }>): boolean;
  getNavigatorTicketAttemptContext(input: Readonly<{
    attemptId: string;
    effectIdempotencyKey: string;
    ownerId: string;
    generation: number;
    now: number;
  }>): NavigatorTicketAttemptContext | null;
  bindNavigatorTicketWorkerResource(input: Readonly<{
    attemptId: string;
    effectIdempotencyKey: string;
    resource: NavigatorTicketWorkerResource;
    ownerId: string;
    generation: number;
    now: number;
  }>): boolean;
  bindNavigatorSkillResource(input: Readonly<{
    attemptId: string;
    effectIdempotencyKey: string;
    resource: Readonly<{ kind: "bb_thread"; id: string }>;
    ownerId: string;
    generation: number;
    now: number;
  }>): boolean;
  getCurrentWorkArtifactSnapshot(artifactId: string): WorkArtifactSnapshot | null;
  isWorkArtifactSnapshotValid(snapshotId: string): boolean;
  listCurrentHeldResourceClaims(jobId: string, limit: number): JobResourceClaim[];
  taskAuthorityOperationIsCurrent(effect: JobEffect, operation: TaskAuthorityOperation): boolean;
  renewJobOperationFences(input: Readonly<{
    jobId: string;
    effectIdempotencyKey: string;
    ownerId: string;
    generation: number;
    now: number;
    leaseMs: number;
  }>): boolean;
  settleNavigatorSkillAttempt(input: Readonly<{
    attemptId: string;
    effectIdempotencyKey: string;
    observedExternalStateDigest: string;
    result: unknown;
    receipt?: NavigatorSkillReceipt;
    publishedArtifactBindings?: readonly NavigatorArtifactBinding[];
    reconciledArtifactIds?: readonly string[];
    policyFailureReason?: string;
    ownerId: string;
    generation: number;
    now: number;
  }>): NavigatorWorkflowStepOutcome | null;
  settleNavigatorTicketWorkerAttempt(input: Readonly<{
    attemptId: string;
    effectIdempotencyKey: string;
    receipt: NavigatorTicketReceipt;
    ownerId: string;
    generation: number;
    now: number;
  }>): NavigatorTicketWorkerOutcome | null;
  settleNavigatorReleaseEffect(input: Readonly<{
    ownerId: string;
    generation: number;
    now: number;
    effectIdempotencyKey: string;
    number: number;
    url: string;
    environmentId: string;
    receipt?: NavigatorReleaseReceipt;
  }>): boolean;
  failEffect(
    key: string,
    ownerId: string,
    generation: number,
    error: string,
    nextAttemptAt: number,
    now: number,
  ): boolean;
  deadLetterEffect(key: string, ownerId: string, generation: number, error: string, now: number): boolean;
}
