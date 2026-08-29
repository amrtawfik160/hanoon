import { createHash } from "node:crypto";
import { z } from "zod";
import { SKILL_ADMISSION_CATALOG } from "../capabilities/catalog";
import { modelRouteSchema, type ModelRoute } from "../capabilities/models";

export const WORKFLOW_ENGINES = ["recipe-v1", "navigator-v1"] as const;
export const WORKFLOW_MODES = ["live", "shadow", "deterministic"] as const;
export type WorkflowEngine = (typeof WORKFLOW_ENGINES)[number];
export type WorkflowMode = (typeof WORKFLOW_MODES)[number];

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T;

export const NAVIGATOR_ENGINE_REVISION = 1;
export const MATT_POCOCK_SKILL_REVISION = "6654f6b60cd9d5be8b54c6fafe44346dabeb3b76";
export const MAX_NAVIGATOR_JSON_BYTES = 64_000;

const identifierSchema = z.string().trim().min(1).max(256);
const boundedTextSchema = z.string().trim().min(1).max(8_000);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const stringListSchema = z.array(z.string().trim().min(1).max(1_024)).max(128);

export const artifactBindingSchema = z.object({
  artifactId: identifierSchema,
  snapshotId: identifierSchema,
  snapshotDigest: sha256Schema,
}).strict();

export type NavigatorArtifactBinding = DeepReadonly<z.infer<typeof artifactBindingSchema>>;

export const snapshotIdentitySchema = z.object({
  jobId: identifierSchema,
  jobVersion: z.number().int().min(1),
  workflowRevision: z.number().int().min(1),
  digest: sha256Schema,
}).strict();

export type SnapshotIdentity = DeepReadonly<z.infer<typeof snapshotIdentitySchema>>;

const proposalBase = {
  basedOn: snapshotIdentitySchema,
  rationale: boundedTextSchema,
  evidenceRefs: stringListSchema,
};

export const navigatorProposalSchema = z.discriminatedUnion("kind", [
  z.object({
    ...proposalBase,
    kind: z.literal("invoke_skill"),
    skillId: identifierSchema,
    subjectArtifactIds: z.array(identifierSchema).max(32),
    objective: boundedTextSchema,
  }).strict(),
  z.object({
    ...proposalBase,
    kind: z.literal("start_release"),
    implementationTicketIds: z.array(identifierSchema).min(1).max(128),
  }).strict(),
  z.object({
    ...proposalBase,
    kind: z.literal("owner_boundary"),
    boundaryCode: z.enum([
      "product_decision_required",
      "scope_expansion_required",
      "credential_or_access_required",
      "spend_authority_required",
      "irreversible_effect_required",
      "policy_change_required",
      "technical_tradeoff_required",
      "production_recovery_required",
    ]),
    question: boundedTextSchema,
    recommendedAction: boundedTextSchema.nullable(),
  }).strict(),
  z.object({
    ...proposalBase,
    kind: z.literal("unresolved_next_step"),
    question: boundedTextSchema,
    candidateSkillIds: z.array(identifierSchema).min(1).max(32),
  }).strict(),
  z.object({
    ...proposalBase,
    kind: z.literal("finish"),
    artifactIds: z.array(identifierSchema).min(1).max(128),
  }).strict(),
]);

export type NavigatorProposal = DeepReadonly<z.infer<typeof navigatorProposalSchema>>;

const skillCatalogEntrySchema = z.object({
  id: identifierSchema,
  sourceDigest: sha256Schema,
  descriptorDigest: sha256Schema,
  invocationClass: z.enum(["model", "user"]),
  admitted: z.boolean(),
  denialReason: z.string().trim().min(1).max(512).nullable(),
}).strict();

const navigatorSnapshotPayloadSchema = z.object({
  engine: z.literal("navigator-v1"),
  engineRevision: z.literal(NAVIGATOR_ENGINE_REVISION),
  mode: z.enum(["shadow", "deterministic"]),
  ownerRequest: boundedTextSchema,
  artifactBindings: z.array(artifactBindingSchema).max(128),
  skillCatalog: z.array(skillCatalogEntrySchema).max(64),
  catalogDigest: sha256Schema,
  externalStateDigest: sha256Schema,
  evidenceRefs: stringListSchema,
  createdAt: z.number().int().min(0),
}).strict();

export const navigatorSnapshotSchema = navigatorSnapshotPayloadSchema.extend({
  snapshotId: identifierSchema,
  identity: snapshotIdentitySchema,
}).strict();

export type NavigatorSnapshot = DeepReadonly<z.infer<typeof navigatorSnapshotSchema>>;

export function freezeNavigatorSnapshot(snapshot: z.infer<typeof navigatorSnapshotSchema>): NavigatorSnapshot {
  return Object.freeze({
    ...snapshot,
    identity: Object.freeze({ ...snapshot.identity }),
    artifactBindings: Object.freeze(snapshot.artifactBindings.map((binding) => Object.freeze({ ...binding }))),
    skillCatalog: Object.freeze(snapshot.skillCatalog.map((entry) => Object.freeze({ ...entry }))),
    evidenceRefs: Object.freeze([...snapshot.evidenceRefs]),
  });
}

export const navigatorInferenceObservationSchema = z.object({
  nativeToolCalls: z.array(identifierSchema).max(32),
  claimedCodeWorktreeId: identifierSchema.nullable(),
  dynamicEffectToolIds: z.array(identifierSchema).max(32),
  externalStateDigest: sha256Schema,
}).strict();

export type NavigatorInferenceObservation = DeepReadonly<z.infer<typeof navigatorInferenceObservationSchema>>;

export const researchArtifactEvidenceSchema = z.object({
  artifactId: identifierSchema,
  snapshotId: identifierSchema,
  snapshotDigest: sha256Schema,
  finding: z.string().trim().min(1).max(8_000),
  evidenceRefs: stringListSchema,
}).strict();

export const navigatorResearchResultSchema = z.object({
  kind: z.literal("research_result"),
  summary: z.string().trim().min(1).max(8_000),
  artifactEvidence: z.array(researchArtifactEvidenceSchema).min(1).max(128),
}).strict();

export type NavigatorResearchResult = DeepReadonly<z.infer<typeof navigatorResearchResultSchema>>;

export const navigatorResearchInputSchema = z.object({
  kind: z.literal("navigator_research_input"),
  objective: boundedTextSchema,
  artifactBindings: z.array(artifactBindingSchema).min(1).max(32),
  evidenceRefs: stringListSchema,
}).strict();

export type NavigatorResearchInput = DeepReadonly<z.infer<typeof navigatorResearchInputSchema>>;

export type NavigatorSkillStepContract = Readonly<{
  id: string;
  revision: number;
  skillId: string;
  invocationClass: "model" | "user";
  allowedArtifactKinds: readonly string[];
  minimumSubjects: number;
  operationClass: "read_only" | "artifact_write";
  resourceClass: "bb_thread_read_only";
  inputSchema: "navigator-research-input-v1" | "navigator-planning-input-v1";
  resultSchema: string;
  mandatoryEvidence: readonly string[];
  modelPools: readonly ("fast" | "standard" | "strong")[];
  timeoutMs: number;
  maximumResultBytes: number;
  retryClass: "resume_bound_resource";
  digest: string;
}>;

function digestJson(digestSubject: unknown): string {
  return createHash("sha256").update(JSON.stringify(digestSubject), "utf8").digest("hex");
}

const unsignedResearchContract = {
  id: "navigator-research-read-only",
  revision: 1,
  skillId: "research",
  invocationClass: "model",
  allowedArtifactKinds: ["map", "specification", "decision_ticket", "implementation_ticket"],
  minimumSubjects: 1,
  operationClass: "read_only",
  resourceClass: "bb_thread_read_only",
  inputSchema: "navigator-research-input-v1",
  resultSchema: "navigator-research-result-v1",
  mandatoryEvidence: ["artifact_snapshot", "structured_result", "bb_resource"],
  modelPools: ["strong"],
  timeoutMs: 600_000,
  maximumResultBytes: 64_000,
  retryClass: "resume_bound_resource",
} as const;

export const NAVIGATOR_RESEARCH_STEP_CONTRACT: NavigatorSkillStepContract = Object.freeze({
  ...unsignedResearchContract,
  digest: digestJson(unsignedResearchContract),
});

export const NAVIGATOR_SKILL_CATALOG = Object.freeze(SKILL_ADMISSION_CATALOG.map((entry) => Object.freeze({
  id: entry.id,
  sourceDigest: entry.sourceDigest,
  descriptorDigest: entry.bundleDescriptorDigest,
  invocationClass: entry.invocationClass,
  admitted: true,
  denialReason: null,
})).sort((left, right) => left.id.localeCompare(right.id)));

export const NAVIGATOR_SKILL_CATALOG_DIGEST = digestJson(NAVIGATOR_SKILL_CATALOG);

export function navigatorSnapshotDigest(input: Readonly<{
  jobId: string;
  jobVersion: number;
  workflowRevision: number;
  payload: DeepReadonly<z.infer<typeof navigatorSnapshotPayloadSchema>>;
}>): string {
  return digestJson({
    jobId: input.jobId,
    jobVersion: input.jobVersion,
    workflowRevision: input.workflowRevision,
    ...navigatorSnapshotPayloadSchema.parse(input.payload),
  });
}

export function proposalDigest(rawProposal: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(rawProposal);
  } catch {
    serialized = "[unserializable proposal]";
  }
  if (serialized === undefined) serialized = "[undefined proposal]";
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

export function assertModelRouteForContract(
  route: ModelRoute,
  contract: NavigatorSkillStepContract,
): ModelRoute {
  const parsed = modelRouteSchema.parse(route);
  if (!contract.modelPools.includes(parsed.pool)) {
    throw new TypeError(`model pool ${parsed.pool} is outside the step contract`);
  }
  return parsed;
}

export type NavigatorProposalDecision = Readonly<{
  snapshotId: string;
  proposalId: string;
  decision: "accepted" | "rejected" | "shadowed";
  reasonCode: string;
  workflowStepId: string | null;
  attemptId: string | null;
  effectIdempotencyKey: string | null;
}>;

export type NavigatorProposalRecord = Readonly<{
  id: string;
  jobId: string;
  snapshotId: string;
  digest: string;
  kind: NavigatorProposal["kind"] | null;
  proposal: NavigatorProposal | null;
  observation: NavigatorInferenceObservation;
  observationDigest: string;
  createdAt: number;
}>;

export type NavigatorWorkflowStep = Readonly<{
  id: string;
  jobId: string;
  proposalId: string;
  snapshotId: string;
  skillId: string;
  jobVersion: number;
  workflowRevision: number;
  acceptedAt: number;
}>;

export type NavigatorSkillAttempt = Readonly<{
  id: string;
  jobId: string;
  workflowStepId: string;
  effectIdempotencyKey: string;
  skillId: string;
  skillRevision: string;
  skillSourceDigest: string;
  descriptorDigest: string;
  stepContractId: string;
  stepContractRevision: number;
  stepContractDigest: string;
  catalogDigest: string;
  stepInput: NavigatorResearchInput | Readonly<{
    kind: "navigator_planning_input";
    skillId: string;
    objective: string;
    artifactBindings: readonly NavigatorArtifactBinding[];
    evidenceRefs: readonly string[];
    routingDecisionDigest: string | null;
  }>;
  stepInputDigest: string;
  modelRoute: ModelRoute;
  artifactBindings: readonly NavigatorArtifactBinding[];
  snapshotDigest: string;
  jobVersion: number;
  workflowRevision: number;
  resource: { kind: "bb_thread"; id: string } | null;
  createdAt: number;
  updatedAt: number;
}>;

export type NavigatorWorkflowStepOutcome = Readonly<{
  workflowStepId: string;
  attemptId: string;
  outcome: "succeeded" | "policy_failure";
  reasonCode: string;
  summary: string;
  artifactEvidence: readonly z.infer<typeof researchArtifactEvidenceSchema>[];
  resultDigest: string;
  recordedAt: number;
}>;

export type NavigatorPlanningResultRecord = Readonly<{
  attemptId: string;
  workflowStepId: string;
  skillId: string;
  result: unknown;
  resultDigest: string;
  observedExternalStateDigest: string;
  recordedAt: number;
}>;

export type NavigatorRoutingDecision = Readonly<{
  decisionDigest: string;
  scopeDigest: string;
  jobId: string;
  question: string;
  candidateSkillIds: readonly string[];
  rationale: string;
  evidenceRefs: readonly string[];
  consultationStepId: string;
  recordedAt: number;
  advice: Readonly<{
    attemptId: string;
    advice: string;
    suggestedSkillIds: readonly string[];
    evidenceRefs: readonly string[];
    resultDigest: string;
    recordedAt: number;
  }> | null;
  blocked: boolean;
}>;
