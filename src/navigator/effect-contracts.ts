import { z } from "zod";
import type { CapabilityKind } from "../capabilities/contracts";
import type { Job, StoredEffect } from "../domain/models";
import type { TaskAuthorityOperation } from "../domain/task-authority";
import type { JobResourceClaim } from "../autonomy/models";
import type { NavigatorArtifactBinding, NavigatorProposalRecord, NavigatorSkillAttempt, NavigatorWorkflowStep } from "./models";
import type { NavigatorReleaseAttempt } from "./release-contracts";
import type { NavigatorTicketWorkerAttempt } from "./implementation-executor";
import type { WorkArtifactClaim, WorkArtifactSnapshot } from "../work-artifacts/models";

export const NAVIGATOR_CAPABILITY_OPERATIONS = [
  "artifact_write",
  "prototype_write",
  "worktree_write",
  "release_entry",
] as const;

export type NavigatorCapabilityOperation = (typeof NAVIGATOR_CAPABILITY_OPERATIONS)[number];

export type NavigatorCapabilityEvidence = Readonly<{
  profileId: string;
  profileRevision: number;
  receiptId: string;
  capabilityId: string;
  capabilityKind: CapabilityKind;
  descriptorDigest: string;
  operation: NavigatorCapabilityOperation;
  projectId: string;
  jobId: string;
  ownerId: string | null;
  generation: number | null;
}>;

export type NavigatorCapabilityAssignment = Readonly<{
  capabilityId: string;
  capabilityKind: CapabilityKind;
  descriptorDigest: string;
}>;

export type NavigatorTicketAttemptContext = Readonly<{
  attempt: NavigatorTicketWorkerAttempt;
  integration: Readonly<{
    jobId: string;
    worktreeId: string;
    integrationBranch: string;
    currentHeadSha: string;
    state: string;
    activeSliceId: string | null;
  }>;
  activeSlice: Readonly<{
    id: string;
    ticketArtifactId: string;
    claimId: number;
    state: string;
    acceptedHeadSha: string | null;
  }>;
  claim: WorkArtifactClaim;
  specificationSnapshot: WorkArtifactSnapshot;
  ticketSnapshot: WorkArtifactSnapshot;
}>;

type NavigatorEffectContextBase = Readonly<{
  effect: Readonly<StoredEffect>;
  job: Readonly<Job>;
  fence: Readonly<{ ownerId: string; generation: number }>;
  signal: AbortSignal;
  artifactBindings: readonly NavigatorArtifactBinding[];
  resourceClaims: readonly JobResourceClaim[];
  authorityOperations: readonly TaskAuthorityOperation[];
  capabilityEvidence: readonly NavigatorCapabilityEvidence[];
}>;

export type NavigatorSkillEffectContext = NavigatorEffectContextBase & Readonly<{
  kind: "run_navigator_skill";
  workflowStep: Readonly<NavigatorWorkflowStep>;
  acceptedProposal: Readonly<NavigatorProposalRecord>;
  attempt: Readonly<NavigatorSkillAttempt>;
}>;

export type NavigatorTicketEffectContext = NavigatorEffectContextBase & Readonly<{
  kind: "run_navigator_ticket_worker";
  workflowStep: null;
  acceptedProposal: null;
  ticket: NavigatorTicketAttemptContext;
}>;

export type NavigatorReleaseEffectContext = NavigatorEffectContextBase & Readonly<{
  kind: "run_navigator_release";
  workflowStep: Readonly<NavigatorWorkflowStep>;
  acceptedProposal: Readonly<NavigatorProposalRecord>;
  attempt: Readonly<NavigatorReleaseAttempt>;
}>;

export type NavigatorEffectContext =
  | NavigatorSkillEffectContext
  | NavigatorTicketEffectContext
  | NavigatorReleaseEffectContext;

const identifierSchema = z.string().trim().min(1).max(256);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

const resourceSchema = z.object({
  kind: z.literal("bb_thread"),
  id: identifierSchema,
}).strict();

const environmentResourceSchema = z.object({
  kind: z.literal("environment"),
  id: identifierSchema,
}).strict();

const receiptBaseSchema = {
  effectIdempotencyKey: identifierSchema,
  attemptId: identifierSchema,
  resource: resourceSchema,
};

export const navigatorSkillReceiptSchema = z.object({
  kind: z.literal("run_navigator_skill"),
  ...receiptBaseSchema,
  observedExternalStateDigest: sha256Schema,
  result: z.unknown(),
}).strict();

export const navigatorTicketReceiptSchema = z.object({
  kind: z.literal("run_navigator_ticket_worker"),
  ...receiptBaseSchema,
  exactHeadSha: z.string().regex(/^[0-9a-f]{40}$/u),
  result: z.unknown(),
  gitObservation: z.unknown().nullable(),
}).strict();

export const navigatorReleaseReceiptSchema = z.object({
  kind: z.literal("run_navigator_release"),
  effectIdempotencyKey: identifierSchema,
  attemptId: identifierSchema,
  jobId: identifierSchema,
  operationId: identifierSchema,
  resource: environmentResourceSchema,
  number: z.number().int().positive(),
  url: z.string().url().max(2_048),
  environmentId: identifierSchema,
}).strict();

export const navigatorEffectReceiptSchema = z.discriminatedUnion("kind", [
  navigatorSkillReceiptSchema,
  navigatorTicketReceiptSchema,
  navigatorReleaseReceiptSchema,
]);

export type NavigatorSkillReceipt = Readonly<z.infer<typeof navigatorSkillReceiptSchema>>;
export type NavigatorTicketReceipt = Readonly<z.infer<typeof navigatorTicketReceiptSchema>>;
export type NavigatorReleaseReceipt = Readonly<z.infer<typeof navigatorReleaseReceiptSchema>>;
export type NavigatorEffectReceipt = Readonly<z.infer<typeof navigatorEffectReceiptSchema>>;

export type NavigatorTicketSettlementInput = Readonly<{
  attemptId: string;
  effectIdempotencyKey: string;
  receipt: NavigatorTicketReceipt;
  ownerId: string;
  generation: number;
  now: number;
}>;
