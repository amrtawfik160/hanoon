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

type ManagedAutomationObservedTrigger =
  | Readonly<{ triggerType: "schedule"; cron: string; timezone: string }>
  | Readonly<{ triggerType: "once"; runAt: number }>;

type ManagedAutomationObservedEnvironment =
  | Readonly<{ type: "project-default" }>
  | Readonly<{ type: "reuse"; environmentId: string }>
  | Readonly<{
      type: "host";
      hostId: string;
      workspace: Readonly<{
        type: "managed-worktree";
        baseBranch: Readonly<{ kind: "named"; name: string }>;
      }>;
    }>;

type ManagedAutomationObservedExecution =
  | Readonly<{
      mode: "agent";
      prompt: string;
      providerId: string;
      model: string;
      reasoningLevel?: string;
      serviceTier?: string;
      permissionMode: "accept-edits" | "auto" | "full";
      targetThreadId?: string;
      environment: ManagedAutomationObservedEnvironment;
    }>
  | Readonly<{
      mode: "script";
      interpreter?: "bash" | "sh" | "node" | "python3";
      timeoutMs: number;
      scriptFile?: string;
      storedScriptPath?: string;
      script?: string;
      env?: Readonly<Record<string, string>>;
    }>;

export type ManagedAutomationObservation = Readonly<{
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  trigger: ManagedAutomationObservedTrigger;
  execution: ManagedAutomationObservedExecution;
  origin: "human" | "app" | "agent";
  createdByThreadId: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  runCount: number;
  lastRunStatus: "running" | "succeeded" | "failed" | "skipped" | null;
  lastRunThreadId: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}>;

export type ManagedAutomationRun = Readonly<{
  id: string;
  automationId: string;
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

export const managedAutomationCapabilityEvidenceSchema = z.object({
  version: z.literal(1),
  profileId: boundedId,
  profileRevision: positiveRevision,
  capabilityId: boundedId,
  descriptorVersion: boundedId,
  descriptorDigest: sha256,
  evidenceRefs: z.array(evidenceReference).min(1).max(32),
}).strict();

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
    standingAuthority: z.null(),
    capabilityEvidence: managedAutomationCapabilityEvidenceSchema,
    mayWidenAutomation: z.literal(false),
  }).strict(),
]);

export type ManagedAutomationAuthority = z.infer<typeof managedAutomationAuthoritySchema>;
export type ManagedAutomationCapabilityEvidence = z.infer<typeof managedAutomationCapabilityEvidenceSchema>;
export type ManagedAutomationTaskAuthority = z.infer<typeof taskAuthoritySchema>;
export type ManagedAutomationStandingAuthority = z.infer<typeof standingAuthoritySchema>;

export const managedAutomationOperationClassSchema = z.enum([
  "create",
  "update",
  "enable",
  "disable",
  "run_now",
  "retire",
  "reconcile",
]);

export const managedAutomationOperationRequestSchema = z.object({
  version: z.literal(1),
  operationClass: managedAutomationOperationClassSchema,
  targetProjectId: boundedId,
  definitionRevision: positiveRevision,
}).strict();

export type ManagedAutomationOperationClass = z.infer<typeof managedAutomationOperationClassSchema>;
export type ManagedAutomationOperationRequest = z.infer<typeof managedAutomationOperationRequestSchema>;

export type LegacyManagedAutomationAuthority = Readonly<Record<string, unknown>>;
export type StoredManagedAutomationAuthority = ManagedAutomationAuthority | LegacyManagedAutomationAuthority;

export function parseManagedAutomationAuthority(value: unknown): StoredManagedAutomationAuthority {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("managed automation authority must be an object");
  }
  const record = value as Record<string, unknown>;
  return "version" in record
    ? managedAutomationAuthoritySchema.parse(value)
    : record;
}

export function isCurrentManagedAutomationAuthority(value: StoredManagedAutomationAuthority): value is ManagedAutomationAuthority {
  return typeof value === "object" && value !== null && "version" in value && value.version === 1;
}

export function currentManagedAutomationAuthority(
  value: unknown,
): ManagedAutomationAuthority | null {
  const parsed = parseManagedAutomationAuthority(value);
  return isCurrentManagedAutomationAuthority(parsed) ? parsed : null;
}
