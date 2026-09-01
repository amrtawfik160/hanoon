import { z } from "zod";

export type ManagedAutomationScope =
  | Readonly<{ kind: "environment"; environmentId: string }>
  | Readonly<{ kind: "host"; hostId: string; cwd: string | null }>;

export type ManagedAutomationTrigger =
  | Readonly<{ kind: "cron"; cron: string; timezone: string }>
  | Readonly<{ kind: "once"; at: string }>;

export type ManagedAutomationTarget =
  | Readonly<{ kind: "project-default" }>
  | Readonly<{ kind: "target-thread"; threadId: string }>
  | Readonly<{ kind: "environment"; environmentId: string }>
  | Readonly<{ kind: "new-worktree"; baseBranch: string }>;

export type ManagedAutomationAgentDefinition = Readonly<{
  mode: "agent";
  projectId: string;
  name: string;
  trigger: ManagedAutomationTrigger;
  prompt: string;
  providerId: string;
  model: string;
  reasoningLevel?: string;
  serviceTier?: "default" | "fast";
  permissionMode: "accept-edits" | "auto" | "full";
  target: ManagedAutomationTarget;
  timeoutMs: number;
  resultContract: Readonly<{
    kind: "bounded-text";
    maximumBytes: number;
  }>;
}>;

export type ManagedAutomationScriptDefinition = Readonly<{
  mode: "script";
  projectId: string;
  name: string;
  trigger: ManagedAutomationTrigger;
  source: Readonly<
    | { kind: "inline"; script: string }
    | { kind: "file"; path: string; sha256: string; hostId?: string }
  >;
  interpreter: "bash" | "sh" | "node" | "python3";
  timeoutMs: number;
  env?: Readonly<Record<string, string>>;
}>;

export type ManagedAutomationDefinition =
  | ManagedAutomationAgentDefinition
  | ManagedAutomationScriptDefinition;

export type ManagedAutomationObservation = Readonly<{
  providerAutomationId: string;
  projectId: string;
  name: string;
  enabled: boolean;
  trigger: ManagedAutomationTrigger;
  mode: "agent" | "script";
  target: ManagedAutomationTarget | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  runCount: number;
  lastRunStatus: "running" | "succeeded" | "failed" | "skipped" | null;
  lastRunThreadId: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}>;

export type ManagedAutomationProviderIdentity = Readonly<{
  operationId: string;
  ownershipMarker: string;
}>;

export type ManagedAutomationCreateReceipt = Readonly<{
  version: 1;
  operationId: string;
  ownershipMarker: string;
  providerAutomationId: string;
}>;

export type ManagedAutomationRun = Readonly<{
  id: string;
  automationId: string;
  idempotencyKey?: string | null;
  runMode: "agent" | "script";
  threadId: string | null;
  status: "running" | "succeeded" | "failed" | "skipped";
  trigger: "schedule" | "manual";
  skipReason: string | null;
  error: string | null;
  output: string | null;
  exitCode: number | null;
  scheduledFor: number;
  startedAt: number;
  finishedAt: number | null;
}>;

export type ManagedAutomationCapabilities = Readonly<{
  executionTimeout: boolean;
  resultContract: boolean;
  preRunAuthority: boolean;
}>;

const boundedId = z.string().min(1).max(256);
const positiveRevision = z.number().int().positive().safe();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const evidenceReference = z.string().min(1).max(512);
const timestamp = z.string().min(1).max(128).refine((value) => Number.isFinite(Date.parse(value)), {
  message: "must be a parseable timestamp",
});

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  Object.freeze(value);
  return value;
}

export const managedAutomationTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cron"),
    cron: z.string().min(1).max(256),
    timezone: z.string().min(1).max(128),
  }).strict(),
  z.object({
    kind: z.literal("once"),
    at: timestamp,
  }).strict(),
]);

export const managedAutomationTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project-default") }).strict(),
  z.object({ kind: z.literal("target-thread"), threadId: boundedId }).strict(),
  z.object({ kind: z.literal("environment"), environmentId: boundedId }).strict(),
  z.object({ kind: z.literal("new-worktree"), baseBranch: boundedId }).strict(),
]);

const managedAutomationResultContractSchema = z.object({
  kind: z.literal("bounded-text"),
  maximumBytes: z.number().int().positive().safe().max(1_048_576),
}).strict();

const managedAutomationScriptSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inline"), script: z.string().max(1_048_576) }).strict(),
  z.object({
    kind: z.literal("file"),
    path: boundedId,
    sha256,
    hostId: boundedId.optional(),
  }).strict(),
]);

export const managedAutomationDefinitionSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("agent"),
    projectId: boundedId,
    name: z.string().min(1).max(200),
    trigger: managedAutomationTriggerSchema,
    prompt: z.string().max(1_048_576),
    providerId: boundedId,
    model: boundedId,
    reasoningLevel: z.string().max(256).optional(),
    serviceTier: z.enum(["default", "fast"]).optional(),
    permissionMode: z.enum(["accept-edits", "auto", "full"]),
    target: managedAutomationTargetSchema,
    timeoutMs: z.number().int().positive().safe().max(14_400_000),
    resultContract: managedAutomationResultContractSchema,
  }).strict(),
  z.object({
    mode: z.literal("script"),
    projectId: boundedId,
    name: z.string().min(1).max(200),
    trigger: managedAutomationTriggerSchema,
    source: managedAutomationScriptSourceSchema,
    interpreter: z.enum(["bash", "sh", "node", "python3"]),
    timeoutMs: z.number().int().positive().safe().max(14_400_000),
    env: z.record(z.string().max(256), z.string().max(16_384)).optional(),
  }).strict(),
]);

export const managedAutomationDefinitionEnvelopeSchema = z.object({
  version: z.literal(1),
  value: managedAutomationDefinitionSchema,
}).strict();

export const managedAutomationObservationSchema = z.object({
  providerAutomationId: boundedId,
  projectId: boundedId,
  name: z.string().min(1).max(200),
  enabled: z.boolean(),
  trigger: managedAutomationTriggerSchema,
  mode: z.enum(["agent", "script"]),
  target: managedAutomationTargetSchema.nullable(),
  nextRunAt: z.number().int().nonnegative().nullable(),
  lastRunAt: z.number().int().nonnegative().nullable(),
  runCount: z.number().int().nonnegative(),
  lastRunStatus: z.enum(["running", "succeeded", "failed", "skipped"]).nullable(),
  lastRunThreadId: boundedId.nullable(),
  lastError: z.string().max(16_384).nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export const managedAutomationObservationEnvelopeSchema = z.object({
  version: z.literal(1),
  value: managedAutomationObservationSchema,
}).strict();

export const managedAutomationOperationClassSchema = z.enum([
  "create",
  "update",
  "enable",
  "disable",
  "run_now",
  "retire",
  "reconcile",
]);

const managedAutomationRecursionSchema = z.object({
  version: z.literal(1),
  rootAutomationId: boundedId,
  parentAutomationId: boundedId,
  depth: z.number().int().nonnegative().safe().max(8),
  maxDepth: z.number().int().positive().safe().max(8),
  lineage: z.array(boundedId).min(1).max(9),
}).strict().superRefine((recursion, context) => {
  if (recursion.depth > recursion.maxDepth) {
    context.addIssue({ code: "custom", path: ["depth"], message: "recursion depth exceeds its bound" });
  }
  if (recursion.lineage.length !== recursion.depth + 1) {
    context.addIssue({ code: "custom", path: ["lineage"], message: "recursion lineage does not match its depth" });
  }
  if (recursion.lineage[0] !== recursion.rootAutomationId) {
    context.addIssue({ code: "custom", path: ["lineage", 0], message: "recursion lineage has the wrong root" });
  }
  if (recursion.lineage[recursion.lineage.length - 1] !== recursion.parentAutomationId) {
    context.addIssue({ code: "custom", path: ["lineage"], message: "recursion lineage has the wrong parent" });
  }
  if (new Set(recursion.lineage).size !== recursion.lineage.length) {
    context.addIssue({ code: "custom", path: ["lineage"], message: "recursion lineage contains a cycle" });
  }
}).transform((value) => deepFreeze(value));

const managedAutomationOperationScopeSchema = z.object({
  version: z.literal(1),
  operationClass: managedAutomationOperationClassSchema,
  targetProjectId: boundedId,
  targetHostId: boundedId,
}).strict();

export const managedAutomationCreateReceiptSchema = z.object({
  version: z.literal(1),
  operationId: boundedId,
  ownershipMarker: boundedId,
  providerAutomationId: boundedId,
}).strict();

export const managedAutomationCapabilityEvidenceSchema = z.object({
  version: z.literal(1),
  profileId: boundedId,
  profileRevision: positiveRevision,
  capabilityId: boundedId,
  descriptorVersion: boundedId,
  descriptorDigest: sha256,
  evidenceRefs: z.array(evidenceReference).min(1).max(32),
}).strict().transform((value) => deepFreeze(value));

const taskAuthoritySchema = z.discriminatedUnion("kind", [
  z.object({
    version: z.literal(1),
    kind: z.literal("controller-turn"),
    turnId: boundedId,
    revision: positiveRevision,
  }).strict(),
  z.object({
    version: z.literal(1),
    kind: z.literal("automation"),
    automationId: boundedId,
    operationId: boundedId,
    revision: positiveRevision,
  }).strict(),
]);

const standingAuthoritySchema = z.discriminatedUnion("kind", [
  z.object({
    version: z.literal(1),
    kind: z.literal("project-policy"),
    policyId: boundedId,
    revision: positiveRevision,
  }).strict(),
  z.object({
    version: z.literal(1),
    kind: z.literal("system-maintenance"),
    systemKey: boundedId,
    revision: positiveRevision,
  }).strict(),
]);

export const managedAutomationAuthoritySchema = z.discriminatedUnion("origin", [
  z.object({
    version: z.literal(1),
    origin: z.literal("owner"),
    controllerKey: boundedId,
    projectId: boundedId,
    hostId: boundedId,
    taskAuthority: z.object({
      version: z.literal(1),
      kind: z.literal("controller-turn"),
      turnId: boundedId,
      revision: positiveRevision,
    }).strict(),
    standingAuthority: z.null(),
    capabilityEvidence: managedAutomationCapabilityEvidenceSchema,
    mayWidenAutomation: z.literal(false),
  }).strict(),
  z.object({
    version: z.literal(1),
    origin: z.literal("standing-policy"),
    controllerKey: boundedId,
    projectId: boundedId,
    hostId: boundedId,
    taskAuthority: z.null(),
    standingAuthority: z.object({
      version: z.literal(1),
      kind: z.literal("project-policy"),
      policyId: boundedId,
      revision: positiveRevision,
    }).strict(),
    capabilityEvidence: managedAutomationCapabilityEvidenceSchema,
    mayWidenAutomation: z.literal(false),
  }).strict(),
  z.object({
    version: z.literal(1),
    origin: z.literal("system-maintenance"),
    controllerKey: boundedId,
    projectId: boundedId,
    hostId: boundedId,
    taskAuthority: z.null(),
    standingAuthority: z.object({
      version: z.literal(1),
      kind: z.literal("system-maintenance"),
      systemKey: boundedId,
      revision: positiveRevision,
    }).strict(),
    capabilityEvidence: managedAutomationCapabilityEvidenceSchema,
    mayWidenAutomation: z.literal(false),
  }).strict(),
  z.object({
    version: z.literal(1),
    origin: z.literal("automation-triggered"),
    controllerKey: boundedId,
    projectId: boundedId,
    hostId: boundedId,
    taskAuthority: z.object({
      version: z.literal(1),
      kind: z.literal("automation"),
      automationId: boundedId,
      operationId: boundedId,
      revision: positiveRevision,
    }).strict(),
    standingAuthority: z.object({
      version: z.literal(1),
      kind: z.literal("project-policy"),
      policyId: boundedId,
      revision: positiveRevision,
    }).strict(),
    recursion: managedAutomationRecursionSchema,
    operationScope: managedAutomationOperationScopeSchema,
    capabilityEvidence: managedAutomationCapabilityEvidenceSchema,
    mayWidenAutomation: z.literal(false),
  }).strict(),
]).superRefine((authority, context) => {
  if (authority.origin !== "automation-triggered") return;
  if (authority.recursion.parentAutomationId !== authority.taskAuthority.automationId) {
    context.addIssue({ code: "custom", path: ["recursion", "parentAutomationId"], message: "recursive parent does not match task authority" });
  }
  if (authority.operationScope.targetProjectId !== authority.projectId) {
    context.addIssue({ code: "custom", path: ["operationScope", "targetProjectId"], message: "operation target project is outside authority" });
  }
  if (authority.operationScope.targetHostId !== authority.hostId) {
    context.addIssue({ code: "custom", path: ["operationScope", "targetHostId"], message: "operation target host is outside authority" });
  }
}).transform((value) => deepFreeze(value));

export type ManagedAutomationAuthority = z.infer<typeof managedAutomationAuthoritySchema>;
export type ManagedAutomationCapabilityEvidence = z.infer<typeof managedAutomationCapabilityEvidenceSchema>;
export type ManagedAutomationTaskAuthority = z.infer<typeof taskAuthoritySchema>;
export type ManagedAutomationStandingAuthority = z.infer<typeof standingAuthoritySchema>;

const managedAutomationRunOutcomeClassSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "skipped",
  "contract_violated",
]);

export const managedAutomationRunReceiptSchema = z.object({
  version: z.literal(1),
  kind: z.literal("run-receipt"),
  providerRunId: boundedId,
  automationBindingId: boundedId,
  providerAutomationId: boundedId,
  definitionRevision: positiveRevision,
  initiatingOperationId: boundedId,
  authority: managedAutomationAuthoritySchema,
  capabilityEvidence: managedAutomationCapabilityEvidenceSchema,
  scheduledFor: z.number().int().nonnegative().safe(),
  startedAt: z.number().int().nonnegative().safe(),
  finishedAt: z.number().int().nonnegative().nullable(),
  observedAt: z.number().int().nonnegative().safe(),
  outcomeClass: managedAutomationRunOutcomeClassSchema,
}).strict().superRefine((receipt, context) => {
  if (receipt.startedAt < receipt.scheduledFor) {
    context.addIssue({ code: "custom", message: "run started before it was scheduled", path: ["startedAt"] });
  }
  if (receipt.finishedAt !== null && receipt.finishedAt < receipt.startedAt) {
    context.addIssue({ code: "custom", message: "run finished before it started", path: ["finishedAt"] });
  }
  if (receipt.observedAt < receipt.startedAt) {
    context.addIssue({ code: "custom", message: "run was observed before it started", path: ["observedAt"] });
  }
  if (receipt.outcomeClass === "running" && receipt.finishedAt !== null) {
    context.addIssue({ code: "custom", message: "running run receipt cannot have a finish time", path: ["finishedAt"] });
  }
});

export const managedAutomationOperationRequestSchema = z.object({
  version: z.literal(1),
  operationClass: managedAutomationOperationClassSchema,
  targetProjectId: boundedId,
  targetHostId: boundedId.optional(),
  definitionRevision: positiveRevision,
  intentKey: boundedId.optional(),
}).strict();

export type ManagedAutomationOperationClass = z.infer<typeof managedAutomationOperationClassSchema>;
export type ManagedAutomationOperationRequest = z.infer<typeof managedAutomationOperationRequestSchema>;
export type ManagedAutomationRunReceipt = z.infer<typeof managedAutomationRunReceiptSchema>;
export type ManagedAutomationRunOutcomeClass = z.infer<typeof managedAutomationRunOutcomeClassSchema>;

const managedAutomationOutcomeValueSchema = z.enum(["succeeded", "failed", "ambiguous"]);

export const managedAutomationProviderAcknowledgementSchema = z.object({
  version: z.literal(1),
  kind: z.literal("provider-acknowledgement"),
  operationId: boundedId,
  ownershipMarker: boundedId,
  providerAutomationId: boundedId,
}).strict();

export const managedAutomationOutcomeReceiptSchema = z.object({
  version: z.literal(1),
  kind: z.literal("settled"),
  operationId: boundedId,
  operationClass: managedAutomationOperationClassSchema,
  outcome: managedAutomationOutcomeValueSchema,
  authority: managedAutomationAuthoritySchema,
  capabilityEvidence: managedAutomationCapabilityEvidenceSchema.nullable(),
  providerAutomationId: boundedId.nullable(),
  ownershipMarker: boundedId.nullable(),
  observedSha256: sha256.nullable(),
  runReceipt: managedAutomationRunReceiptSchema.nullable().optional(),
  evidence: z.record(z.string().max(256), z.unknown()).nullable(),
  errorClass: boundedId.nullable(),
}).strict();

export const managedAutomationStoredOutcomeSchema = z.discriminatedUnion("kind", [
  managedAutomationProviderAcknowledgementSchema,
  managedAutomationOutcomeReceiptSchema,
]);

export type ManagedAutomationProviderAcknowledgement = z.infer<typeof managedAutomationProviderAcknowledgementSchema>;
export type ManagedAutomationOutcomeReceipt = z.infer<typeof managedAutomationOutcomeReceiptSchema>;
export type ManagedAutomationStoredOutcome = z.infer<typeof managedAutomationStoredOutcomeSchema>;

export type LegacyManagedAutomationAuthority = Readonly<Record<string, unknown>>;
export type StoredManagedAutomationAuthority = ManagedAutomationAuthority | LegacyManagedAutomationAuthority;
export type LegacyManagedAutomationOutcome = Readonly<Record<string, unknown>>;
export type StoredManagedAutomationOutcome = ManagedAutomationStoredOutcome | LegacyManagedAutomationOutcome;

export function parseManagedAutomationAuthority(value: unknown): StoredManagedAutomationAuthority {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("managed automation authority must be an object");
  }
  const record = value as Record<string, unknown>;
  return "version" in record ? managedAutomationAuthoritySchema.parse(value) : record;
}

export function isCurrentManagedAutomationAuthority(value: StoredManagedAutomationAuthority): value is ManagedAutomationAuthority {
  return typeof value === "object" && value !== null && managedAutomationAuthoritySchema.safeParse(value).success;
}

export function currentManagedAutomationAuthority(
  value: unknown,
): ManagedAutomationAuthority | null {
  const parsed = parseManagedAutomationAuthority(value);
  return isCurrentManagedAutomationAuthority(parsed) ? parsed : null;
}

export function managedAutomationAuthorityCoversOperation(
  authority: StoredManagedAutomationAuthority,
  operation: Readonly<{
    operationClass: ManagedAutomationOperationClass;
    targetProjectId: string;
    targetHostId?: string | null;
  }>,
): boolean {
  if (!isCurrentManagedAutomationAuthority(authority)) return false;
  if (authority.projectId !== operation.targetProjectId) return false;
  if (operation.targetHostId !== undefined && operation.targetHostId !== null &&
    authority.hostId !== operation.targetHostId) return false;
  if (authority.origin !== "automation-triggered") return true;
  if (operation.targetHostId === undefined || operation.targetHostId === null) return false;
  return authority.operationScope.operationClass === operation.operationClass &&
    authority.operationScope.targetProjectId === operation.targetProjectId &&
    authority.operationScope.targetHostId === operation.targetHostId;
}
