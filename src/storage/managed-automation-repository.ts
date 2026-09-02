import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type {
  ManagedAutomationDefinition,
  ManagedAutomationObservation,
  ManagedAutomationRun,
  ManagedAutomationCreateReceipt,
  StoredManagedAutomationOutcome,
} from "../domain/managed-automation";
import {
  managedAutomationCapabilityEvidenceSchema,
  managedAutomationCreateReceiptSchema,
  managedAutomationDefinitionEnvelopeSchema,
  managedAutomationDefinitionSchema,
  managedAutomationObservationEnvelopeSchema,
  managedAutomationObservationSchema,
  managedAutomationOutcomeReceiptSchema,
  managedAutomationOperationRequestSchema,
  managedAutomationRunSchema,
  managedAutomationStoredOutcomeSchema,
  isCurrentManagedAutomationAuthority,
  parseManagedAutomationAuthority,
  type ManagedAutomationAuthority,
  type ManagedAutomationCapabilityEvidence,
  type ManagedAutomationOperationClass,
  type ManagedAutomationOperationRequest,
  type StoredManagedAutomationAuthority,
} from "../domain/managed-automation";

type SqliteDatabase = Database.Database;

export type ManagedAutomationState = "pending" | "active" | "paused" | "updating" | "retiring" | "retired" | "failed";
export type ManagedAutomationOperationState = "pending" | "leased" | "succeeded" | "failed" | "ambiguous";
export type ManagedAutomationBinding = Readonly<{
  id: string;
  controllerKey: string;
  sourceKey: string;
  projectId: string;
  bbAutomationId: string | null;
  providerOwnershipMarker: string | null;
  name: string;
  mode: "agent" | "script";
  definition: ManagedAutomationDefinition;
  definitionSha256: string;
  authority: StoredManagedAutomationAuthority;
  definitionRevision: number;
  authorityVersion: number;
  capabilityEvidence: ManagedAutomationCapabilityEvidence | null;
  notificationPolicy: "material" | "always" | "silent";
  state: ManagedAutomationState;
  legacyMonitorId: string | null;
  observed: ManagedAutomationObservation | null;
  observedSha256: string | null;
  lastReconciledAt: number | null;
  lastRunId: string | null;
  lastRunStatus: ManagedAutomationRun["status"] | null;
  lastError: string | null;
  lastOperationId: string | null;
  lastOperationOutcome: ManagedAutomationOperationState | null;
  createdAt: number;
  updatedAt: number;
}>;

export type ManagedAutomationExecutorFence = Readonly<{
  ownerId: string;
  generation: number;
}>;

export type ManagedAutomationControllerFence = Readonly<{
  ownerId: string;
  generation: number;
  turnId: string;
}>;

export type ManagedAutomationMutationFence = Readonly<
  | { kind: "controller"; value: ManagedAutomationControllerFence }
  | { kind: "executor"; value: ManagedAutomationExecutorFence }
>;

export type ManagedAutomationOperation = Readonly<{
  id: string;
  bindingId: string;
  operationKey: string;
  operationClass: ManagedAutomationOperationClass;
  version: 1;
  targetProjectId: string;
  definitionRevision: number;
  authority: StoredManagedAutomationAuthority;
  capabilityEvidence: ManagedAutomationCapabilityEvidence | null;
  controllerFence: ManagedAutomationControllerFence | null;
  state: ManagedAutomationOperationState;
  attempts: number;
  leaseOwner: string | null;
  leaseGeneration: number | null;
  leaseExpiresAt: number | null;
  providerAutomationId: string | null;
  providerOwnershipMarker: string | null;
  outcome: StoredManagedAutomationOutcome | null;
  lastError: string | null;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  settledAt: number | null;
}>;

export type ManagedAutomationNotification = Readonly<{
  sequence: number;
  bbRunId: string;
  bindingId: string;
  controllerKey: string;
  updateId: number;
  inputText: string;
  createdAt: number;
}>;

export type ManagedAutomationNotificationHandoff = Readonly<{
  sequence: number;
  controllerKey: string;
  telegramUserId: string;
  telegramChatId: string;
  updateId: number;
  inputText: string;
  ownerId: string;
  generation: number;
  now: number;
}>;

export type ManagedAutomationReserveInput = Readonly<{
  controllerKey: string;
  sourceKey: string;
  projectId: string;
  name: string;
  definition: ManagedAutomationDefinition;
  authority: StoredManagedAutomationAuthority;
  notificationPolicy: "material" | "always" | "silent";
  legacyMonitorId: string | null;
  now: number;
  definitionRevision: number;
  operation?: ManagedAutomationOperationRequest;
  fence: ManagedAutomationMutationFence;
}>;

export interface ManagedAutomationPersistence {
  get(id: string): ManagedAutomationBinding | null;
  list(controllerKey: string, includeRetired?: boolean): ManagedAutomationBinding[];
  listReconciliationCandidates(before: number, limit?: number): ManagedAutomationBinding[];
  getOperation(id: string): ManagedAutomationOperation | null;
  listDueOperations(now: number, limit?: number): ManagedAutomationOperation[];
  claimOperation(input: ManagedAutomationExecutorFence & { operationId: string; now: number; leaseMs: number }): ManagedAutomationOperation | null;
  renewOperationLease(input: ManagedAutomationExecutorFence & { operationId: string; now: number; leaseMs: number }): boolean;
  acknowledgeOperation(input: Readonly<{
    operationId: string;
    ownerId: string;
    generation: number;
    now: number;
    receipt: ManagedAutomationCreateReceipt;
  }>): boolean;
  settleOperation(input: Readonly<{
    operationId: string;
    ownerId: string;
    generation: number;
    now: number;
    outcome: "succeeded" | "failed" | "ambiguous";
    automation?: ManagedAutomationObservation | null;
    run?: ManagedAutomationRun | null;
    providerAutomationId?: string | null;
    errorClass?: string | null;
    outcomeEvidence?: Readonly<Record<string, unknown>> | null;
  }>): ManagedAutomationBinding | null;
  reserve(input: ManagedAutomationReserveInput): ManagedAutomationBinding;
  activate(input: Readonly<{ id: string; automation: ManagedAutomationObservation; now: number; fence: ManagedAutomationMutationFence }>): ManagedAutomationBinding;
  setProviderOwnershipMarker(input: Readonly<{ id: string; ownershipMarker: string; now: number; fence: ManagedAutomationMutationFence }>): ManagedAutomationBinding;
  attachProviderAutomation(input: Readonly<{
    id: string;
    providerAutomationId: string;
    ownershipMarker: string;
    now: number;
    fence: ManagedAutomationMutationFence;
  }>): ManagedAutomationBinding;
  fail(id: string, errorClass: string, now: number, fence: ManagedAutomationMutationFence): ManagedAutomationBinding;
  beginUpdate(input: Readonly<{ id: string; definition: ManagedAutomationDefinition; now: number; fence: ManagedAutomationMutationFence }>): ManagedAutomationBinding;
  beginEnabledChange(input: Readonly<{
    id: string;
    enabled: boolean;
    now: number;
    fence: ManagedAutomationMutationFence;
  }>): ManagedAutomationBinding;
  beginRunNow(input: Readonly<{
    id: string;
    idempotencyKey: string;
    now: number;
    fence: ManagedAutomationMutationFence;
  }>): ManagedAutomationBinding;
  markPolicyBlocked(id: string, now: number, fence: ManagedAutomationMutationFence): ManagedAutomationBinding;
  markExecutionContractBlocked(id: string, now: number, fence: ManagedAutomationMutationFence): ManagedAutomationBinding;
  beginRetirement(id: string, now: number, fence: ManagedAutomationMutationFence): ManagedAutomationBinding;
  retire(id: string, now: number, fence: ManagedAutomationMutationFence): ManagedAutomationBinding;
  recordRun(bindingId: string, run: ManagedAutomationRun, now: number, fence: ManagedAutomationMutationFence): boolean;
  listPendingNotifications(limit?: number): ManagedAutomationNotification[];
  markNotificationEnqueued(sequence: number, now: number): boolean;
}

type ManagedAutomationRow = Readonly<{
  id: string;
  controller_key: string;
  source_key: string;
  project_id: string;
  bb_automation_id: string | null;
  provider_ownership_marker: string | null;
  name: string;
  mode: string;
  definition_json: string;
  definition_sha256: string;
  authority_json: string;
  notification_policy: string;
  state: string;
  legacy_monitor_id: string | null;
  observed_json: string | null;
  observed_sha256: string | null;
  last_reconciled_at: number | null;
  last_run_id: string | null;
  last_run_status: string | null;
  last_error: string | null;
  definition_revision: number;
  authority_version: number;
  capability_profile_id: string | null;
  capability_profile_revision: number | null;
  capability_evidence_json: string | null;
  last_operation_id: string | null;
  last_operation_outcome: string | null;
  created_at: number;
  updated_at: number;
}>;

type ManagedAutomationOperationRow = Readonly<{
  id: string;
  binding_id: string;
  operation_key: string;
  operation_class: string;
  operation_version: number;
  target_project_id: string;
  definition_revision: number;
  authority_json: string;
  capability_evidence_json: string | null;
  controller_owner_id: string | null;
  controller_generation: number | null;
  controller_turn_id: string | null;
  state: string;
  attempts: number;
  lease_owner: string | null;
  lease_generation: number | null;
  lease_expires_at: number | null;
  provider_automation_id: string | null;
  provider_ownership_marker: string | null;
  outcome_json: string | null;
  last_error: string | null;
  next_attempt_at: number;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
}>;

const controllerFenceSchema = z.object({
  ownerId: z.string().min(1).max(256),
  generation: z.number().int().positive().safe(),
  turnId: z.string().min(1).max(256),
}).strict();
const executorFenceSchema = z.object({
  ownerId: z.string().min(1).max(256),
  generation: z.number().int().positive().safe(),
}).strict();
const mutationFenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("controller"), value: controllerFenceSchema }).strict(),
  z.object({ kind: z.literal("executor"), value: executorFenceSchema }).strict(),
]);

const reserveSchema = z.object({
  controllerKey: z.string().min(1).max(256),
  sourceKey: z.string().min(1).max(256),
  projectId: z.string().min(1).max(256),
  name: z.string().min(1).max(200),
  definition: z.custom<ManagedAutomationDefinition>((value) => typeof value === "object" && value !== null),
  authority: z.record(z.string(), z.unknown()),
  notificationPolicy: z.enum(["material", "always", "silent"]),
  legacyMonitorId: z.string().min(1).max(256).nullable().default(null),
  now: z.number().int().nonnegative().safe(),
  definitionRevision: z.number().int().positive().safe().default(1),
  operation: managedAutomationOperationRequestSchema.optional(),
  fence: mutationFenceSchema,
}).strict();

const operationStateSchema = z.enum(["pending", "leased", "succeeded", "failed", "ambiguous"]);
const operationOutcomeSchema = z.enum(["succeeded", "failed", "ambiguous"]);
const boundedErrorClassSchema = z.string().min(1).max(256);
const providerAutomationIdSchema = z.string().min(1).max(256).nullable();
const operationEvidenceSchema = z.record(z.string(), z.unknown()).nullable();
const providerOwnershipMarkerSchema = z.string().min(1).max(256).nullable();
const operationLeaseSchema = z.object({
  operationId: z.string().min(1).max(256),
  ownerId: z.string().min(1).max(256),
  generation: z.number().int().positive().safe(),
  now: z.number().int().nonnegative().safe(),
  leaseMs: z.number().int().positive().safe(),
}).strict();

const legacyObservationTriggerSchema = z.discriminatedUnion("triggerType", [
  z.object({
    triggerType: z.literal("schedule"),
    cron: z.string().min(1),
    timezone: z.string().min(1),
  }).passthrough(),
  z.object({
    triggerType: z.literal("once"),
    runAt: z.number().int().nonnegative(),
  }).passthrough(),
]);

const legacyObservationExecutionSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("agent"),
    targetThreadId: z.string().min(1).optional(),
    environment: z.discriminatedUnion("type", [
      z.object({ type: z.literal("project-default") }).passthrough(),
      z.object({ type: z.literal("reuse"), environmentId: z.string().min(1) }).passthrough(),
      z.object({
        type: z.literal("host"),
        hostId: z.string().min(1),
        workspace: z.object({
          type: z.literal("managed-worktree"),
          baseBranch: z.object({ kind: z.literal("named"), name: z.string().min(1) }).passthrough(),
        }).passthrough(),
      }).passthrough(),
    ]),
  }).passthrough(),
  z.object({ mode: z.literal("script") }).passthrough(),
]);

const legacyObservationSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  trigger: legacyObservationTriggerSchema,
  execution: legacyObservationExecutionSchema,
  nextRunAt: z.number().int().nonnegative().nullable(),
  lastRunAt: z.number().int().nonnegative().nullable(),
  runCount: z.number().int().nonnegative(),
  lastRunStatus: z.enum(["running", "succeeded", "failed", "skipped"]).nullable(),
  lastRunThreadId: z.string().min(1).nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).passthrough();

const legacyRecordSchema = z.record(z.string(), z.unknown());

function authorityEvidence(authority: StoredManagedAutomationAuthority): ManagedAutomationCapabilityEvidence | null {
  return isCurrentManagedAutomationAuthority(authority)
    ? authority.capabilityEvidence
    : null;
}

function authorityVersion(authority: StoredManagedAutomationAuthority): number {
  return isCurrentManagedAutomationAuthority(authority) ? 1 : 0;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("managed automation contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("managed automation contains a non-JSON value");
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

export function managedAutomationDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function hasVersionField(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "version" in value;
}

function decodeDefinition(value: unknown): Readonly<{ value: ManagedAutomationDefinition; current: boolean }> {
  if (hasVersionField(value)) {
    return { value: managedAutomationDefinitionEnvelopeSchema.parse(value).value, current: true };
  }
  // The predecessor stored the definition payload without an envelope. Keep
  // that format readable, but never let it masquerade as a current value.
  return { value: legacyRecordSchema.parse(value) as ManagedAutomationDefinition, current: false };
}

function legacyObservationTarget(
  execution: z.infer<typeof legacyObservationExecutionSchema>,
): ManagedAutomationObservation["target"] {
  if (execution.mode === "script") return null;
  if (execution.targetThreadId) return { kind: "target-thread", threadId: execution.targetThreadId };
  switch (execution.environment.type) {
    case "project-default": return { kind: "project-default" };
    case "reuse": return { kind: "environment", environmentId: execution.environment.environmentId };
    case "host": return {
      kind: "new-worktree",
      baseBranch: execution.environment.workspace.baseBranch.name,
    };
  }
}

function decodeObservation(value: unknown): Readonly<{ value: ManagedAutomationObservation; current: boolean }> {
  if (hasVersionField(value)) {
    return { value: managedAutomationObservationEnvelopeSchema.parse(value).value, current: true };
  }
  const legacy = legacyObservationSchema.parse(value);
  const trigger = legacy.trigger.triggerType === "schedule"
    ? { kind: "cron" as const, cron: legacy.trigger.cron, timezone: legacy.trigger.timezone }
    : { kind: "once" as const, at: new Date(legacy.trigger.runAt).toISOString() };
  return {
    value: {
      providerAutomationId: legacy.id,
      projectId: legacy.projectId,
      name: legacy.name,
      enabled: legacy.enabled,
      trigger,
      mode: legacy.execution.mode,
      target: legacyObservationTarget(legacy.execution),
      nextRunAt: legacy.nextRunAt,
      lastRunAt: legacy.lastRunAt,
      runCount: legacy.runCount,
      lastRunStatus: legacy.lastRunStatus,
      lastRunThreadId: legacy.lastRunThreadId,
      lastError: legacy.lastError,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
    },
    current: false,
  };
}

function decodeOutcome(value: unknown): StoredManagedAutomationOutcome {
  if (hasVersionField(value)) return managedAutomationStoredOutcomeSchema.parse(value);
  return legacyRecordSchema.parse(value);
}

function parseRow(row: ManagedAutomationRow): ManagedAutomationBinding {
  if (!(["agent", "script"] as const).includes(row.mode as "agent" | "script")) {
    throw new Error(`Unknown managed automation mode ${row.mode}`);
  }
  if (!(["pending", "active", "paused", "updating", "retiring", "retired", "failed"] as const).includes(row.state as ManagedAutomationState)) {
    throw new Error(`Unknown managed automation state ${row.state}`);
  }
  if (!(["material", "always", "silent"] as const).includes(row.notification_policy as "material" | "always" | "silent")) {
    throw new Error(`Unknown managed automation notification policy ${row.notification_policy}`);
  }
  if (!Number.isSafeInteger(row.definition_revision) || row.definition_revision < 1) {
    throw new Error("Managed automation definition revision is invalid");
  }
  const authority = parseManagedAutomationAuthority(JSON.parse(row.authority_json));
  const expectedAuthorityVersion = authorityVersion(authority);
  if (row.authority_version !== expectedAuthorityVersion) {
    throw new Error("Managed automation authority version does not match its authority");
  }
  const capabilityEvidence = row.capability_evidence_json === null
    ? authorityEvidence(authority)
    : managedAutomationCapabilityEvidenceSchema.parse(JSON.parse(row.capability_evidence_json));
  if (row.authority_version === 1 && capabilityEvidence === null) {
    throw new Error("Current managed automation authority has no capability evidence");
  }
  if (capabilityEvidence !== null && isCurrentManagedAutomationAuthority(authority) &&
    managedAutomationDigest(capabilityEvidence) !== managedAutomationDigest(authority.capabilityEvidence)) {
    throw new Error("Managed automation capability evidence does not match its authority");
  }
  if ((row.capability_profile_id === null) !== (capabilityEvidence === null) ||
    (capabilityEvidence !== null &&
      (row.capability_profile_id !== capabilityEvidence.profileId ||
        row.capability_profile_revision !== capabilityEvidence.profileRevision))) {
    throw new Error("Managed automation capability profile reference does not match its evidence");
  }
  const decodedDefinition = decodeDefinition(JSON.parse(row.definition_json));
  if (decodedDefinition.current && managedAutomationDigest(decodedDefinition.value) !== row.definition_sha256) {
    throw new Error("Managed automation definition digest does not match its current value");
  }
  if (decodedDefinition.current && (decodedDefinition.value.mode !== row.mode ||
    decodedDefinition.value.projectId !== row.project_id || decodedDefinition.value.name !== row.name)) {
    throw new Error("Managed automation definition identity does not match its row");
  }
  const decodedObservation = row.observed_json === null ? null : decodeObservation(JSON.parse(row.observed_json));
  if (decodedObservation?.current && row.observed_sha256 !== managedAutomationDigest(decodedObservation.value)) {
    throw new Error("Managed automation observation digest does not match its current value");
  }
  if (decodedObservation?.current && row.state !== "updating" &&
    (row.bb_automation_id !== decodedObservation.value.providerAutomationId ||
    row.project_id !== decodedObservation.value.projectId || row.name !== decodedObservation.value.name)) {
    throw new Error("Managed automation observation identity does not match its row");
  }
  const lastOperationOutcome = row.last_operation_outcome === null
    ? null
    : operationStateSchema.parse(row.last_operation_outcome);
  return {
    id: row.id,
    controllerKey: row.controller_key,
    sourceKey: row.source_key,
    projectId: row.project_id,
    bbAutomationId: row.bb_automation_id,
    providerOwnershipMarker: providerOwnershipMarkerSchema.parse(row.provider_ownership_marker),
    name: row.name,
    mode: row.mode as "agent" | "script",
    definition: decodedDefinition.value,
    definitionSha256: row.definition_sha256,
    authority,
    definitionRevision: row.definition_revision,
    authorityVersion: row.authority_version,
    capabilityEvidence,
    notificationPolicy: row.notification_policy as "material" | "always" | "silent",
    state: row.state as ManagedAutomationState,
    legacyMonitorId: row.legacy_monitor_id,
    observed: decodedObservation?.value ?? null,
    observedSha256: row.observed_sha256,
    lastReconciledAt: row.last_reconciled_at,
    lastRunId: row.last_run_id,
    lastRunStatus: row.last_run_status as ManagedAutomationRun["status"] | null,
    lastError: row.last_error,
    lastOperationId: row.last_operation_id,
    lastOperationOutcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseOperation(row: ManagedAutomationOperationRow): ManagedAutomationOperation {
  const operationClass = managedAutomationOperationRequestSchema.shape.operationClass.parse(row.operation_class);
  const version = z.literal(1).parse(row.operation_version);
  const state = operationStateSchema.parse(row.state);
  if (!Number.isSafeInteger(row.definition_revision) || row.definition_revision < 1) {
    throw new Error("Managed automation operation definition revision is invalid");
  }
  const targetProjectId = z.string().min(1).max(256).parse(row.target_project_id);
  const authority = parseManagedAutomationAuthority(JSON.parse(row.authority_json));
  const capabilityEvidence = row.capability_evidence_json === null
    ? authorityEvidence(authority)
    : managedAutomationCapabilityEvidenceSchema.parse(JSON.parse(row.capability_evidence_json));
  if (isCurrentManagedAutomationAuthority(authority) && capabilityEvidence === null) {
    throw new Error("Current managed automation operation has no capability evidence");
  }
  if (capabilityEvidence !== null && isCurrentManagedAutomationAuthority(authority) &&
    managedAutomationDigest(capabilityEvidence) !== managedAutomationDigest(authority.capabilityEvidence)) {
    throw new Error("Managed automation operation capability evidence does not match its authority");
  }
  const controllerFenceValues = [row.controller_owner_id, row.controller_generation, row.controller_turn_id];
  const hasControllerFenceValue = controllerFenceValues.some((value) => value !== null);
  if (hasControllerFenceValue && controllerFenceValues.some((value) => value === null)) {
    throw new Error("Managed automation operation controller fence is incomplete");
  }
  const controllerFence = !hasControllerFenceValue
    ? null
    : {
        ownerId: z.string().min(1).max(256).parse(row.controller_owner_id),
        generation: z.number().int().positive().safe().parse(row.controller_generation),
        turnId: z.string().min(1).max(256).parse(row.controller_turn_id),
      };
  if (isCurrentManagedAutomationAuthority(authority) && authority.origin === "owner" &&
    (!controllerFence || authority.taskAuthority.turnId !== controllerFence.turnId)) {
    throw new Error("Managed automation operation authority does not match its controller fence");
  }
  const rawOutcome = row.outcome_json === null ? null : JSON.parse(row.outcome_json);
  const outcome = rawOutcome === null ? null : decodeOutcome(rawOutcome);
  if (outcome && hasVersionField(outcome) && outcome.operationId !== row.id) {
    throw new Error("Managed automation operation outcome identity does not match its row");
  }
  const providerAutomationId = providerAutomationIdSchema.parse(row.provider_automation_id);
  const providerOwnershipMarker = providerOwnershipMarkerSchema.parse(row.provider_ownership_marker);
  if (outcome && hasVersionField(outcome) && outcome.kind === "provider-acknowledgement" &&
    (outcome.providerAutomationId !== providerAutomationId || outcome.ownershipMarker !== providerOwnershipMarker)) {
    throw new Error("Managed automation acknowledgement does not match its operation");
  }
  if (outcome && hasVersionField(outcome) && outcome.kind === "settled" &&
    (outcome.providerAutomationId !== providerAutomationId || outcome.ownershipMarker !== providerOwnershipMarker)) {
    throw new Error("Managed automation outcome does not match its operation");
  }
  return {
    id: row.id,
    bindingId: row.binding_id,
    operationKey: z.string().min(1).max(256).parse(row.operation_key),
    operationClass,
    version,
    targetProjectId,
    definitionRevision: row.definition_revision,
    authority,
    capabilityEvidence,
    controllerFence,
    state,
    attempts: row.attempts,
    leaseOwner: row.lease_owner,
    leaseGeneration: row.lease_generation,
    leaseExpiresAt: row.lease_expires_at,
    providerAutomationId,
    providerOwnershipMarker,
    outcome,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
  };
}

function operationIdFor(bindingId: string, operation: ManagedAutomationOperationRequest): string {
  // Requests without an explicit idempotency key retain the operation identity
  // used by the preceding schema. This makes the additive operation-key
  // migration restart-safe for in-flight historical operations.
  const identity = operation.idempotencyKey === undefined
    ? {
        bindingId,
        operationClass: operation.operationClass,
        definitionRevision: operation.definitionRevision,
      }
    : {
        bindingId,
        operationClass: operation.operationClass,
        definitionRevision: operation.definitionRevision,
        idempotencyKey: operation.idempotencyKey,
      };
  return "managed-automation-operation-" + managedAutomationDigest({
    ...identity,
  }).slice(0, 48);
}

function operationKeyFor(bindingId: string, operation: ManagedAutomationOperationRequest): string {
  return operation.idempotencyKey === undefined
    ? operationIdFor(bindingId, operation)
    : `idempotency:${operation.idempotencyKey}`;
}

function ownershipMarkerFor(operationId: string): string {
  return `hanoon:${managedAutomationDigest(operationId).slice(0, 40)}`;
}

function assertCurrentOperationInput(
  authority: StoredManagedAutomationAuthority,
  operation: ManagedAutomationOperationRequest,
  fence: ManagedAutomationMutationFence,
  controllerKey: string,
  projectId: string,
  definitionRevision: number,
): asserts authority is ManagedAutomationAuthority {
  managedAutomationOperationRequestSchema.parse(operation);
  if (!isCurrentManagedAutomationAuthority(authority)) {
    throw new TypeError("current managed automation operations require versioned authority");
  }
  if (authority.controllerKey !== controllerKey || authority.projectId !== projectId ||
    operation.targetProjectId !== projectId || operation.definitionRevision !== definitionRevision) {
    throw new TypeError("managed automation operation does not match its binding");
  }
  if (authority.origin === "owner" && (fence.kind !== "controller" ||
    authority.taskAuthority.kind !== "controller-turn" ||
    authority.taskAuthority.turnId !== fence.value.turnId)) {
    throw new TypeError("owner managed automation operation requires its controller fence");
  }
  if (authority.origin !== "owner" && fence.kind !== "executor") {
    throw new TypeError("non-owner managed automation operation requires its executor fence");
  }
}

export class ManagedAutomationRepository implements ManagedAutomationPersistence {
  public constructor(private readonly db: SqliteDatabase) {}

  public get(id: string): ManagedAutomationBinding | null {
    const row = this.db.prepare("SELECT * FROM managed_automations WHERE id = ?").get(id) as ManagedAutomationRow | undefined;
    return row ? parseRow(row) : null;
  }

  public getBySource(controllerKey: string, sourceKey: string): ManagedAutomationBinding | null {
    const row = this.db.prepare(
      "SELECT * FROM managed_automations WHERE controller_key = ? AND source_key = ?",
    ).get(controllerKey, sourceKey) as ManagedAutomationRow | undefined;
    return row ? parseRow(row) : null;
  }

  public list(controllerKey: string, includeRetired = false): ManagedAutomationBinding[] {
    const rows = this.db.prepare(
      `SELECT * FROM managed_automations
        WHERE controller_key = ? ${includeRetired ? "" : "AND state <> 'retired'"}
        ORDER BY created_at DESC LIMIT 100`,
    ).all(controllerKey) as ManagedAutomationRow[];
    return rows.map(parseRow);
  }

  public listReconciliationCandidates(before: number, limit = 20): ManagedAutomationBinding[] {
    if (!Number.isSafeInteger(before) || before < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("managed automation reconciliation window is invalid");
    }
    const rows = this.db.prepare(
      `SELECT * FROM managed_automations
        WHERE state IN ('active', 'paused', 'updating', 'retiring', 'failed') AND bb_automation_id IS NOT NULL
          AND (last_reconciled_at IS NULL OR last_reconciled_at <= ?)
        ORDER BY COALESCE(last_reconciled_at, 0), created_at LIMIT ?`,
    ).all(before, limit) as ManagedAutomationRow[];
    return rows.map(parseRow);
  }

  public getOperation(id: string): ManagedAutomationOperation | null {
    if (!id || id.length > 256) throw new TypeError("managed automation operation id is invalid");
    const row = this.db.prepare(
      "SELECT * FROM managed_automation_operations WHERE id = ?",
    ).get(id) as ManagedAutomationOperationRow | undefined;
    return row ? parseOperation(row) : null;
  }

  public listDueOperations(now: number, limit = 20): ManagedAutomationOperation[] {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("managed automation operation window is invalid");
    }
    const rows = this.db.prepare(
      `SELECT * FROM managed_automation_operations
        WHERE (state IN ('pending', 'failed', 'ambiguous') AND next_attempt_at <= ?)
           OR (state = 'leased' AND lease_expires_at <= ?)
        ORDER BY next_attempt_at, created_at LIMIT ?`,
    ).all(now, now, limit) as ManagedAutomationOperationRow[];
    return rows.map(parseOperation);
  }

  public claimOperation(input: ManagedAutomationExecutorFence & {
    operationId: string;
    now: number;
    leaseMs: number;
  }): ManagedAutomationOperation | null {
    operationLeaseSchema.parse(input);
    if (!input.operationId || input.operationId.length > 256) throw new TypeError("managed automation operation id is invalid");
    return this.db.transaction((): ManagedAutomationOperation | null => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return null;
      const result = this.db.prepare(
        `UPDATE managed_automation_operations
            SET state = 'leased', attempts = attempts + 1, lease_owner = ?,
                lease_generation = ?, lease_expires_at = ?, last_error = NULL,
                updated_at = ?
          WHERE id = ? AND (
            (state IN ('pending', 'failed', 'ambiguous') AND next_attempt_at <= ?)
            OR (state = 'leased' AND lease_expires_at <= ?)
          )`,
      ).run(
        input.ownerId,
        input.generation,
        input.now + input.leaseMs,
        input.now,
        input.operationId,
        input.now,
        input.now,
      );
      if (result.changes !== 1) return null;
      const bindingUpdate = this.db.prepare(
        `UPDATE managed_automations
            SET last_operation_id = ?, last_operation_outcome = 'leased', updated_at = ?
          WHERE id = (SELECT binding_id FROM managed_automation_operations WHERE id = ?)`,
      ).run(input.operationId, input.now, input.operationId);
      if (bindingUpdate.changes !== 1) throw new Error("managed automation claim could not update its binding");
      return this.getOperation(input.operationId);
    }).immediate();
  }

  public renewOperationLease(input: ManagedAutomationExecutorFence & {
    operationId: string;
    now: number;
    leaseMs: number;
  }): boolean {
    operationLeaseSchema.parse(input);
    const result = this.db.prepare(
      `UPDATE managed_automation_operations
          SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND state = 'leased' AND lease_owner = ? AND lease_generation = ?
          AND lease_expires_at > ?
          AND EXISTS (
            SELECT 1 FROM executor_lease
             WHERE singleton = 1 AND owner_id = ? AND generation = ?
               AND lease_expires_at > ?
          )`,
    ).run(
      input.now + input.leaseMs,
      input.now,
      input.operationId,
      input.ownerId,
      input.generation,
      input.now,
      input.ownerId,
      input.generation,
      input.now,
    );
    return result.changes === 1;
  }

  public acknowledgeOperation(input: Readonly<{
    operationId: string;
    ownerId: string;
    generation: number;
    now: number;
    receipt: ManagedAutomationCreateReceipt;
  }>): boolean {
    managedAutomationCreateReceiptSchema.parse(input.receipt);
    if (input.receipt.operationId !== input.operationId) {
      throw new TypeError("managed automation acknowledgement operation does not match its fence");
    }
    return this.db.transaction(() => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return false;
      const operation = this.getOperation(input.operationId);
      if (!operation || operation.state !== "leased" || operation.leaseOwner !== input.ownerId ||
        operation.leaseGeneration !== input.generation || operation.leaseExpiresAt === null ||
        operation.leaseExpiresAt <= input.now) return false;
      if (operation.providerAutomationId !== null &&
        operation.providerAutomationId !== input.receipt.providerAutomationId) {
        throw new TypeError("managed automation acknowledgement changed its provider identity");
      }
      if (operation.providerOwnershipMarker !== null &&
        operation.providerOwnershipMarker !== input.receipt.ownershipMarker) {
        throw new TypeError("managed automation acknowledgement changed its ownership marker");
      }
      const acknowledgement = {
        version: 1 as const,
        kind: "provider-acknowledgement" as const,
        operationId: input.receipt.operationId,
        ownershipMarker: input.receipt.ownershipMarker,
        providerAutomationId: input.receipt.providerAutomationId,
      };
      const outcomeJson = canonical(acknowledgement);
      const operationUpdate = this.db.prepare(
        `UPDATE managed_automation_operations
            SET provider_automation_id = ?, provider_ownership_marker = ?, outcome_json = ?, updated_at = ?
          WHERE id = ? AND state = 'leased' AND lease_owner = ? AND lease_generation = ?`,
      ).run(
        input.receipt.providerAutomationId,
        input.receipt.ownershipMarker,
        outcomeJson,
        input.now,
        input.operationId,
        input.ownerId,
        input.generation,
      );
      if (operationUpdate.changes !== 1) return false;
      const bindingUpdate = this.db.prepare(
        `UPDATE managed_automations
            SET bb_automation_id = ?, provider_ownership_marker = ?, last_operation_id = ?,
                last_operation_outcome = 'leased', updated_at = ?
          WHERE id = ? AND (bb_automation_id IS NULL OR bb_automation_id = ?)`,
      ).run(
        input.receipt.providerAutomationId,
        input.receipt.ownershipMarker,
        input.operationId,
        input.now,
        operation.bindingId,
        input.receipt.providerAutomationId,
      );
      if (bindingUpdate.changes !== 1) throw new Error("managed automation acknowledgement could not update its binding");
      return true;
    }).immediate();
  }

  public settleOperation(input: Readonly<{
    operationId: string;
    ownerId: string;
    generation: number;
    now: number;
    outcome: "succeeded" | "failed" | "ambiguous";
    automation?: ManagedAutomationObservation | null;
    run?: ManagedAutomationRun | null;
    providerAutomationId?: string | null;
    errorClass?: string | null;
    outcomeEvidence?: Readonly<Record<string, unknown>> | null;
  }>): ManagedAutomationBinding | null {
    if (!input.operationId || input.operationId.length > 256 || !input.ownerId || input.ownerId.length > 256) {
      throw new TypeError("managed automation settlement identity is invalid");
    }
    if (!Number.isSafeInteger(input.generation) || input.generation < 1 || !Number.isSafeInteger(input.now) || input.now < 0) {
      throw new TypeError("managed automation settlement fence is invalid");
    }
    const outcome = operationOutcomeSchema.parse(input.outcome);
    const errorClass = input.errorClass === undefined || input.errorClass === null
      ? null
      : boundedErrorClassSchema.parse(input.errorClass);
    const outcomeEvidence = input.outcomeEvidence === undefined || input.outcomeEvidence === null
      ? null
      : operationEvidenceSchema.parse(input.outcomeEvidence);
    const observation = input.automation === undefined || input.automation === null
      ? null
      : managedAutomationObservationSchema.parse(input.automation);
    const run = input.run === undefined || input.run === null
      ? null
      : managedAutomationRunSchema.parse(input.run);
    return this.db.transaction((): ManagedAutomationBinding | null => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return null;
      const operation = this.getOperation(input.operationId);
      if (!operation || operation.state !== "leased" || operation.leaseOwner !== input.ownerId ||
        operation.leaseGeneration !== input.generation || operation.leaseExpiresAt === null ||
        operation.leaseExpiresAt <= input.now) return null;
      const binding = this.get(operation.bindingId);
      if (!binding || binding.definitionRevision !== operation.definitionRevision ||
        binding.projectId !== operation.targetProjectId) return null;
      if (outcome === "succeeded" && operation.operationClass !== "retire" && !observation) {
        throw new TypeError("successful managed automation settlement needs provider state");
      }
      if (run !== null && operation.operationClass !== "run_now") {
        throw new TypeError("managed automation run evidence belongs to a run-now operation");
      }
      if (managedAutomationDigest(operation.authority) !== managedAutomationDigest(binding.authority) ||
        managedAutomationDigest(operation.capabilityEvidence) !== managedAutomationDigest(binding.capabilityEvidence)) {
        return null;
      }
      if (observation && (observation.projectId !== binding.projectId || observation.name !== binding.name)) {
        throw new TypeError("provider automation does not match its managed binding");
      }
      const providerAutomationId = providerAutomationIdSchema.parse(
        input.providerAutomationId ?? observation?.providerAutomationId ?? operation.providerAutomationId,
      );
      if (observation && providerAutomationId !== observation.providerAutomationId) {
        throw new TypeError("provider automation identity does not match its observation");
      }
      if (run !== null && run.automationId !== providerAutomationId) {
        throw new TypeError("managed automation run does not match its provider identity");
      }
      if (operation.operationClass === "run_now" && outcome === "succeeded" && run === null) {
        throw new TypeError("successful managed automation run-now settlement needs run evidence");
      }
      if (operation.providerAutomationId !== null && providerAutomationId !== operation.providerAutomationId) {
        throw new TypeError("provider automation identity does not match its operation");
      }
      if (!isCurrentManagedAutomationAuthority(operation.authority)) {
        throw new TypeError("managed automation outcomes require versioned authority");
      }
      const ownershipMarker = providerOwnershipMarkerSchema.parse(
        operation.providerOwnershipMarker ?? binding.providerOwnershipMarker,
      );
      const settledOutcome = {
        version: 1 as const,
        kind: "settled" as const,
        operationId: operation.id,
        operationClass: operation.operationClass,
        outcome,
        authority: operation.authority,
        capabilityEvidence: operation.capabilityEvidence,
        providerAutomationId,
        ownershipMarker,
        observedSha256: observation ? managedAutomationDigest(observation) : null,
        evidence: outcomeEvidence,
        errorClass,
      };
      managedAutomationOutcomeReceiptSchema.parse(settledOutcome);
      const nextAttemptAt = input.now + 60_000;
      const outcomeJson = canonical(settledOutcome);
      const operationUpdate = this.db.prepare(
        `UPDATE managed_automation_operations
            SET state = ?, lease_owner = NULL, lease_generation = NULL, lease_expires_at = NULL,
                provider_automation_id = ?, outcome_json = ?, last_error = ?,
                next_attempt_at = ?, updated_at = ?, settled_at = ?
          WHERE id = ? AND state = 'leased' AND lease_owner = ? AND lease_generation = ?`,
      ).run(
        outcome,
        providerAutomationId,
        outcomeJson,
        errorClass,
        nextAttemptAt,
        input.now,
        input.now,
        input.operationId,
        input.ownerId,
        input.generation,
      );
      if (operationUpdate.changes !== 1) return null;
      if (outcome === "succeeded" && operation.operationClass === "retire") {
        const bindingUpdate = this.db.prepare(
          `UPDATE managed_automations
              SET state = 'retired', last_error = NULL, last_reconciled_at = ?,
                  last_operation_id = ?, last_operation_outcome = 'succeeded', updated_at = ?
            WHERE id = ? AND state = 'retiring'`,
        ).run(input.now, input.operationId, input.now, binding.id);
        if (bindingUpdate.changes !== 1) throw new Error("managed automation retirement settlement could not update its binding");
      } else if (outcome === "succeeded") {
        const automation = input.automation!;
        if (run !== null) this.recordRunInTransaction(binding, run, input.now);
        const bindingUpdate = this.db.prepare(
          `UPDATE managed_automations
              SET bb_automation_id = ?, provider_ownership_marker = COALESCE(provider_ownership_marker, ?),
                  observed_json = ?, observed_sha256 = ?,
                  state = CASE WHEN ? THEN 'active' ELSE 'paused' END,
                  last_reconciled_at = ?, last_error = NULL, last_operation_id = ?,
                  last_operation_outcome = 'succeeded', updated_at = ?
            WHERE id = ?`,
        ).run(
          automation.providerAutomationId,
          ownershipMarker,
          canonical({ version: 1, value: automation }),
          managedAutomationDigest(automation),
          automation.enabled ? 1 : 0,
          input.now,
          input.operationId,
          input.now,
          binding.id,
        );
        if (bindingUpdate.changes !== 1) throw new Error("managed automation settlement could not update its binding");
      } else {
        const bindingUpdate = this.db.prepare(
          `UPDATE managed_automations
              SET state = CASE WHEN ? = 'failed' AND bb_automation_id IS NULL THEN 'failed' ELSE state END,
                  last_error = ?, last_operation_id = ?, last_operation_outcome = ?, updated_at = ?
            WHERE id = ?`,
        ).run(
          outcome,
          errorClass ?? (outcome === "ambiguous" ? "managed_automation_provider_outcome_ambiguous" : "managed_automation_operation_failed"),
          input.operationId,
          outcome,
          input.now,
          binding.id,
        );
        if (bindingUpdate.changes !== 1) throw new Error("managed automation settlement could not update its binding");
      }
      return this.get(binding.id);
    }).immediate();
  }

  private executorLeaseIsCurrent(ownerId: string, generation: number, now: number): boolean {
    const row = this.db.prepare(
      "SELECT owner_id, generation, lease_expires_at FROM executor_lease WHERE singleton = 1",
    ).get() as { owner_id: string | null; generation: number; lease_expires_at: number | null } | undefined;
    return row?.owner_id === ownerId && row.generation === generation &&
      row.lease_expires_at !== null && row.lease_expires_at > now;
  }

  private controllerFenceIsCurrent(
    fence: ManagedAutomationControllerFence,
    controllerKey: string,
    now: number,
  ): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM controller_turns AS turn
         JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
        WHERE turn.id = ? AND turn.controller_key = ? AND turn.state = 'submitted'
          AND turn.lease_owner = ? AND turn.lease_generation = ?
          AND turn.accepted_finalization_id IS NULL
          AND turn.steer_reservation_turn_id IS NULL
          AND controller.state = 'active'
          AND EXISTS (
            SELECT 1 FROM executor_lease
             WHERE singleton = 1 AND owner_id = ? AND generation = ?
               AND lease_expires_at > ?
          )`,
    ).get(
      fence.turnId,
      controllerKey,
      fence.ownerId,
      fence.generation,
      fence.ownerId,
      fence.generation,
      now,
    );
    return row !== undefined;
  }

  private mutationFenceIsCurrent(
    fence: ManagedAutomationMutationFence,
    bindingId: string,
    now: number,
  ): boolean {
    if (fence.kind === "executor") return this.executorLeaseIsCurrent(fence.value.ownerId, fence.value.generation, now);
    const binding = this.db.prepare(
      "SELECT controller_key FROM managed_automations WHERE id = ?",
    ).get(bindingId) as { controller_key: string } | undefined;
    return binding !== undefined && this.controllerFenceIsCurrent(fence.value, binding.controller_key, now);
  }

  private assertMutationFence(
    fence: ManagedAutomationMutationFence,
    bindingId: string,
    now: number,
  ): void {
    mutationFenceSchema.parse(fence);
    if (!this.mutationFenceIsCurrent(fence, bindingId, now)) {
      throw new Error(`managed automation ${fence.kind} fence was lost`);
    }
  }

  private assertReserveFence(
    fence: ManagedAutomationMutationFence,
    controllerKey: string,
    now: number,
  ): void {
    mutationFenceSchema.parse(fence);
    const current = fence.kind === "executor"
      ? this.executorLeaseIsCurrent(fence.value.ownerId, fence.value.generation, now)
      : this.controllerFenceIsCurrent(fence.value, controllerKey, now);
    if (!current) throw new Error(`managed automation ${fence.kind} fence was lost`);
  }

  public reserve(raw: ManagedAutomationReserveInput): ManagedAutomationBinding {
    const input = reserveSchema.parse(raw);
    const definition = managedAutomationDefinitionSchema.parse(input.definition);
    if (definition.projectId !== input.projectId || definition.name !== input.name) {
      throw new TypeError("managed automation identity must match its definition");
    }
    const authority = parseManagedAutomationAuthority(input.authority);
    const definitionRevision = input.operation?.definitionRevision ?? input.definitionRevision;
    const currentAuthority = input.operation && isCurrentManagedAutomationAuthority(authority) ? authority : null;
    if (input.operation) {
      assertCurrentOperationInput(authority, input.operation, input.fence, input.controllerKey, input.projectId, definitionRevision);
    }
    const definitionJson = canonical({ version: 1, value: definition });
    const authorityJson = canonical(authority);
    const definitionSha256 = managedAutomationDigest(definition);
    return this.db.transaction(() => {
      this.assertReserveFence(input.fence, input.controllerKey, input.now);
      const existing = this.getBySource(input.controllerKey, input.sourceKey);
      if (existing) {
        if (existing.definitionSha256 !== definitionSha256 || existing.state === "retired") {
          throw new Error("managed automation source already has a different durable definition");
        }
        if (input.operation) this.ensureOperation(
          existing,
          input.operation,
          currentAuthority!,
          input.fence.kind === "controller" ? input.fence.value : null,
        );
        return input.operation ? this.get(existing.id)! : existing;
      }
      const id = "automation-binding-" + managedAutomationDigest({
        controllerKey: input.controllerKey,
        sourceKey: input.sourceKey,
      }).slice(0, 48);
      this.db.prepare(
        `INSERT INTO managed_automations (
           id, controller_key, source_key, project_id, bb_automation_id, name, mode,
           provider_ownership_marker, definition_json, definition_sha256, authority_json, notification_policy,
           state, legacy_monitor_id, definition_revision, authority_version,
           capability_profile_id, capability_profile_revision, capability_evidence_json,
           last_operation_id, last_operation_outcome, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.controllerKey,
        input.sourceKey,
        input.projectId,
        input.name,
        definition.mode,
        input.operation ? ownershipMarkerFor(operationIdFor(id, input.operation)) : null,
        definitionJson,
        definitionSha256,
        authorityJson,
        input.notificationPolicy,
        input.legacyMonitorId,
        definitionRevision,
        authorityVersion(authority),
        authorityEvidence(authority)?.profileId ?? null,
        authorityEvidence(authority)?.profileRevision ?? null,
        authorityEvidence(authority) ? canonical(authorityEvidence(authority)) : null,
        input.operation ? operationIdFor(id, input.operation) : null,
        input.operation ? "pending" : null,
        input.now,
        input.now,
      );
      if (input.operation) this.insertOperation(
        id,
        input.operation,
        currentAuthority!,
        input.fence.kind === "controller" ? input.fence.value : null,
        input.now,
      );
      return this.get(id)!;
    }).immediate();
  }

  private ensureOperation(
    binding: ManagedAutomationBinding,
    request: ManagedAutomationOperationRequest,
    authority: ManagedAutomationAuthority,
    controllerFence: ManagedAutomationControllerFence | null,
  ): void {
    if (binding.definitionRevision !== request.definitionRevision) {
      throw new Error("managed automation operation revision does not match its binding");
    }
    const id = operationIdFor(binding.id, request);
    const existing = this.getOperation(id);
    if (existing) {
      if (existing.bindingId !== binding.id || existing.operationClass !== request.operationClass ||
        existing.version !== request.version || existing.targetProjectId !== request.targetProjectId ||
        existing.definitionRevision !== request.definitionRevision ||
        existing.operationKey !== operationKeyFor(binding.id, request)) {
        throw new Error("managed automation operation identity does not match its binding");
      }
      return;
    }
    if (!isCurrentManagedAutomationAuthority(binding.authority) ||
      managedAutomationDigest(binding.authority) !== managedAutomationDigest(authority) ||
      managedAutomationDigest(binding.capabilityEvidence) !== managedAutomationDigest(authority.capabilityEvidence)) {
      throw new Error("managed automation operation authority does not match its binding");
    }
    this.insertOperation(
      binding.id,
      request,
      authority,
      controllerFence,
      binding.updatedAt,
      binding.bbAutomationId,
      binding.providerOwnershipMarker,
    );
    this.db.prepare(
      `UPDATE managed_automations
          SET last_operation_id = ?, last_operation_outcome = 'pending', updated_at = ?
        WHERE id = ?`,
    ).run(id, binding.updatedAt, binding.id);
  }

  private insertOperation(
    bindingId: string,
    request: ManagedAutomationOperationRequest,
    authority: ManagedAutomationAuthority,
    controllerFence: ManagedAutomationControllerFence | null,
    now: number,
    providerAutomationId: string | null = null,
    providerOwnershipMarker: string | null = null,
  ): void {
    const id = operationIdFor(bindingId, request);
    this.db.prepare(
      `INSERT INTO managed_automation_operations (
         id, binding_id, operation_key, operation_class, operation_version, target_project_id, definition_revision,
         authority_json, capability_evidence_json, controller_owner_id,
         controller_generation, controller_turn_id, state, attempts,
         lease_owner, lease_generation, lease_expires_at, provider_automation_id, provider_ownership_marker,
         outcome_json, last_error, next_attempt_at, created_at, updated_at, settled_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?, NULL, NULL, ?, ?, ?, NULL)`,
    ).run(
      id,
      bindingId,
      operationKeyFor(bindingId, request),
      request.operationClass,
      request.version,
      request.targetProjectId,
      request.definitionRevision,
      canonical(authority),
      canonical(authority.capabilityEvidence),
      controllerFence?.ownerId ?? null,
      controllerFence?.generation ?? null,
      controllerFence?.turnId ?? null,
      providerAutomationId,
      providerOwnershipMarker ?? ownershipMarkerFor(id),
      now,
      now,
      now,
    );
  }

  public activate(input: {
    id: string;
    automation: ManagedAutomationObservation;
    now: number;
    fence: ManagedAutomationMutationFence;
  }): ManagedAutomationBinding {
    const observation = managedAutomationObservationSchema.parse(input.automation);
    const observedJson = canonical({ version: 1, value: observation });
    const observedSha256 = managedAutomationDigest(observation);
    return this.db.transaction(() => {
      this.assertMutationFence(input.fence, input.id, input.now);
      const result = this.db.prepare(
        `UPDATE managed_automations
            SET bb_automation_id = ?, observed_json = ?, observed_sha256 = ?,
                state = CASE WHEN ? THEN 'active' ELSE 'paused' END,
                last_reconciled_at = ?, last_error = NULL, updated_at = ?
          WHERE id = ? AND state IN ('pending', 'active', 'paused', 'updating', 'failed')`,
      ).run(observation.providerAutomationId, observedJson, observedSha256, observation.enabled ? 1 : 0, input.now, input.now, input.id);
      if (result.changes !== 1) throw new Error("managed automation activation fence was lost");
      return this.get(input.id)!;
    }).immediate();
  }

  public setProviderOwnershipMarker(input: {
    id: string;
    ownershipMarker: string;
    now: number;
    fence: ManagedAutomationMutationFence;
  }): ManagedAutomationBinding {
    const ownershipMarker = providerOwnershipMarkerSchema.parse(input.ownershipMarker);
    if (ownershipMarker === null) throw new TypeError("managed automation ownership marker is required");
    return this.db.transaction(() => {
      this.assertMutationFence(input.fence, input.id, input.now);
      const result = this.db.prepare(
        `UPDATE managed_automations
            SET provider_ownership_marker = ?, updated_at = ?
          WHERE id = ? AND (provider_ownership_marker IS NULL OR provider_ownership_marker = ?)`,
      ).run(ownershipMarker, input.now, input.id, ownershipMarker);
      if (result.changes !== 1) throw new Error("managed automation ownership marker fence was lost");
      return this.get(input.id)!;
    }).immediate();
  }

  public attachProviderAutomation(input: {
    id: string;
    providerAutomationId: string;
    ownershipMarker: string;
    now: number;
    fence: ManagedAutomationMutationFence;
  }): ManagedAutomationBinding {
    const providerAutomationId = providerAutomationIdSchema.parse(input.providerAutomationId);
    const ownershipMarker = providerOwnershipMarkerSchema.parse(input.ownershipMarker);
    if (providerAutomationId === null || ownershipMarker === null) {
      throw new TypeError("managed automation provider acknowledgement is incomplete");
    }
    return this.db.transaction(() => {
      this.assertMutationFence(input.fence, input.id, input.now);
      const result = this.db.prepare(
        `UPDATE managed_automations
            SET bb_automation_id = ?, provider_ownership_marker = ?, last_operation_outcome = NULL, updated_at = ?
          WHERE id = ? AND (bb_automation_id IS NULL OR bb_automation_id = ?)
            AND (provider_ownership_marker IS NULL OR provider_ownership_marker = ?)`,
      ).run(providerAutomationId, ownershipMarker, input.now, input.id, providerAutomationId, ownershipMarker);
      if (result.changes !== 1) throw new Error("managed automation provider acknowledgement fence was lost");
      return this.get(input.id)!;
    }).immediate();
  }

  public fail(id: string, errorClass: string, now: number, fence: ManagedAutomationMutationFence): ManagedAutomationBinding {
    return this.db.transaction(() => {
      this.assertMutationFence(fence, id, now);
      const result = this.db.prepare(
        `UPDATE managed_automations SET state = 'failed', last_error = ?, updated_at = ?
          WHERE id = ? AND state NOT IN ('updating', 'retiring', 'retired')`,
      ).run(errorClass.slice(0, 256), now, id);
      if (result.changes !== 1) throw new Error("managed automation failure fence was lost");
      return this.get(id)!;
    }).immediate();
  }

  public beginUpdate(input: {
    id: string;
    definition: ManagedAutomationDefinition;
    now: number;
    fence: ManagedAutomationMutationFence;
  }): ManagedAutomationBinding {
    const definition = managedAutomationDefinitionSchema.parse(input.definition);
    const definitionSha256 = managedAutomationDigest(definition);
    return this.db.transaction(() => {
      this.assertMutationFence(input.fence, input.id, input.now);
      const existing = this.get(input.id);
      if (!existing || existing.bbAutomationId === null || existing.projectId !== definition.projectId) {
        throw new Error("managed automation update identity is invalid");
      }
      if (existing.state === "updating") {
        const operation = existing.lastOperationId ? this.getOperation(existing.lastOperationId) : null;
        if (existing.definitionSha256 === definitionSha256 && operation?.operationClass === "update" &&
          operation.definitionRevision === existing.definitionRevision) return existing;
        throw new Error("managed automation update is already pending");
      }
      if (!["active", "paused", "failed"].includes(existing.state)) {
        throw new Error("managed automation update lifecycle is invalid");
      }
      const definitionRevision = existing.definitionRevision + 1;
      const request: ManagedAutomationOperationRequest = {
        version: 1,
        operationClass: "update",
        targetProjectId: existing.projectId,
        definitionRevision,
      };
      const authority = existing.authority;
      assertCurrentOperationInput(
        authority,
        request,
        input.fence,
        existing.controllerKey,
        existing.projectId,
        definitionRevision,
      );
      this.insertOperation(
        existing.id,
        request,
        authority,
        input.fence.kind === "controller" ? input.fence.value : null,
        input.now,
        existing.bbAutomationId,
        existing.providerOwnershipMarker,
      );
      const result = this.db.prepare(
        `UPDATE managed_automations
            SET name = ?, mode = ?, definition_json = ?, definition_sha256 = ?,
                definition_revision = ?, state = 'updating', last_error = NULL,
                last_operation_id = ?, last_operation_outcome = 'pending', updated_at = ?
          WHERE id = ? AND state IN ('active', 'paused', 'failed')`,
      ).run(
        definition.name,
        definition.mode,
        canonical({ version: 1, value: definition }),
        definitionSha256,
        definitionRevision,
        operationIdFor(existing.id, request),
        input.now,
        input.id,
      );
      if (result.changes !== 1) throw new Error("managed automation update intent fence was lost");
      return this.get(input.id)!;
    }).immediate();
  }

  public beginEnabledChange(input: {
    id: string;
    enabled: boolean;
    now: number;
    fence: ManagedAutomationMutationFence;
  }): ManagedAutomationBinding {
    return this.db.transaction(() => {
      this.assertMutationFence(input.fence, input.id, input.now);
      const existing = this.get(input.id);
      if (!existing || existing.bbAutomationId === null ||
        !["active", "paused", "failed", "updating"].includes(existing.state)) {
        throw new Error("managed automation enablement lifecycle is invalid");
      }
      const operationClass = input.enabled ? "enable" : "disable";
      if (existing.state === "updating") {
        const operation = existing.lastOperationId ? this.getOperation(existing.lastOperationId) : null;
        if (operation?.operationClass === operationClass && operation.definitionRevision === existing.definitionRevision) {
          return existing;
        }
        throw new Error("managed automation enablement is already pending");
      }
      const definitionRevision = existing.definitionRevision + 1;
      const request: ManagedAutomationOperationRequest = {
        version: 1,
        operationClass,
        targetProjectId: existing.projectId,
        definitionRevision,
      };
      const authority = existing.authority;
      assertCurrentOperationInput(
        authority,
        request,
        input.fence,
        existing.controllerKey,
        existing.projectId,
        definitionRevision,
      );
      this.insertOperation(
        existing.id,
        request,
        authority,
        input.fence.kind === "controller" ? input.fence.value : null,
        input.now,
        existing.bbAutomationId,
        existing.providerOwnershipMarker,
      );
      const result = this.db.prepare(
        `UPDATE managed_automations
            SET definition_revision = ?, state = 'updating', last_error = NULL,
                last_operation_id = ?, last_operation_outcome = 'pending', updated_at = ?
          WHERE id = ? AND state IN ('active', 'paused', 'failed')`,
      ).run(
        definitionRevision,
        operationIdFor(existing.id, request),
        input.now,
        input.id,
      );
      if (result.changes !== 1) throw new Error("managed automation enablement intent fence was lost");
      return this.get(input.id)!;
    }).immediate();
  }

  public beginRunNow(input: {
    id: string;
    idempotencyKey: string;
    now: number;
    fence: ManagedAutomationMutationFence;
  }): ManagedAutomationBinding {
    const idempotencyKey = z.string().min(1).max(256).parse(input.idempotencyKey);
    return this.db.transaction(() => {
      this.assertMutationFence(input.fence, input.id, input.now);
      const existing = this.get(input.id);
      if (!existing || existing.bbAutomationId === null ||
        !["active", "paused", "failed"].includes(existing.state)) {
        throw new Error("managed automation run-now lifecycle is invalid");
      }
      const request: ManagedAutomationOperationRequest = {
        version: 1,
        operationClass: "run_now",
        targetProjectId: existing.projectId,
        definitionRevision: existing.definitionRevision,
        idempotencyKey,
      };
      const authority = existing.authority;
      assertCurrentOperationInput(
        authority,
        request,
        input.fence,
        existing.controllerKey,
        existing.projectId,
        existing.definitionRevision,
      );
      const id = operationIdFor(existing.id, request);
      const current = this.getOperation(id);
      if (current) {
        if (current.bindingId !== existing.id || current.operationKey !== operationKeyFor(existing.id, request)) {
          throw new Error("managed automation run-now idempotency identity conflict");
        }
        if (current.state === "succeeded") return existing;
        if (current.state === "pending" || current.state === "leased") return existing;
        const requeued = this.db.prepare(
          `UPDATE managed_automation_operations
              SET state = 'pending', lease_owner = NULL, lease_generation = NULL,
                  lease_expires_at = NULL, outcome_json = NULL, last_error = NULL,
                  next_attempt_at = ?, updated_at = ?, settled_at = NULL
            WHERE id = ? AND state IN ('failed', 'ambiguous')`,
        ).run(input.now, input.now, id);
        if (requeued.changes !== 1) throw new Error("managed automation run-now retry fence was lost");
      } else {
        const last = existing.lastOperationId ? this.getOperation(existing.lastOperationId) : null;
        if (last && ["pending", "leased"].includes(last.state)) {
          throw new Error("managed automation operation is already pending");
        }
        this.insertOperation(
          existing.id,
          request,
          authority,
          input.fence.kind === "controller" ? input.fence.value : null,
          input.now,
          existing.bbAutomationId,
          existing.providerOwnershipMarker,
        );
      }
      const bindingUpdate = this.db.prepare(
        `UPDATE managed_automations
            SET last_operation_id = ?, last_operation_outcome = 'pending', updated_at = ?
          WHERE id = ? AND state IN ('active', 'paused', 'failed')`,
      ).run(id, input.now, input.id);
      if (bindingUpdate.changes !== 1) throw new Error("managed automation run-now intent fence was lost");
      return this.get(input.id)!;
    }).immediate();
  }

  public markPolicyBlocked(id: string, now: number, fence: ManagedAutomationMutationFence): ManagedAutomationBinding {
    return this.db.transaction(() => {
      this.assertMutationFence(fence, id, now);
      const result = this.db.prepare(
        `UPDATE managed_automations
            SET state = 'paused', last_error = 'managed_automation_authority_stale',
                last_reconciled_at = ?, updated_at = ?
          WHERE id = ? AND state IN ('active', 'paused', 'updating', 'failed')`,
      ).run(now, now, id);
      if (result.changes !== 1) throw new Error("managed automation policy block fence was lost");
      return this.get(id)!;
    }).immediate();
  }

  public markExecutionContractBlocked(id: string, now: number, fence: ManagedAutomationMutationFence): ManagedAutomationBinding {
    return this.db.transaction(() => {
      this.assertMutationFence(fence, id, now);
      const result = this.db.prepare(
        `UPDATE managed_automations
            SET state = 'paused', last_error = 'bb_agent_execution_contract_unsupported',
                last_reconciled_at = ?, updated_at = ?
          WHERE id = ? AND state IN ('active', 'paused', 'updating', 'failed')`,
      ).run(now, now, id);
      if (result.changes !== 1) throw new Error("managed automation execution contract block fence was lost");
      return this.get(id)!;
    }).immediate();
  }

  public beginRetirement(id: string, now: number, fence: ManagedAutomationMutationFence): ManagedAutomationBinding {
    return this.db.transaction(() => {
      this.assertMutationFence(fence, id, now);
      const existing = this.get(id);
      if (!existing || existing.state === "retired") {
        if (existing?.state === "retired") return existing;
        throw new Error("managed automation retirement identity is invalid");
      }
      if (existing.state === "retiring") {
        const operation = existing.lastOperationId ? this.getOperation(existing.lastOperationId) : null;
        if (operation?.operationClass === "retire" && operation.definitionRevision === existing.definitionRevision) {
          return existing;
        }
        throw new Error("managed automation retirement is already pending");
      }
      if (!["pending", "active", "paused", "failed"].includes(existing.state)) {
        throw new Error("managed automation retirement lifecycle is invalid");
      }
      const definitionRevision = existing.definitionRevision + 1;
      const request: ManagedAutomationOperationRequest = {
        version: 1,
        operationClass: "retire",
        targetProjectId: existing.projectId,
        definitionRevision,
      };
      const authority = existing.authority;
      assertCurrentOperationInput(
        authority,
        request,
        fence,
        existing.controllerKey,
        existing.projectId,
        definitionRevision,
      );
      this.insertOperation(
        existing.id,
        request,
        authority,
        fence.kind === "controller" ? fence.value : null,
        now,
        existing.bbAutomationId,
        existing.providerOwnershipMarker,
      );
      const result = this.db.prepare(
        `UPDATE managed_automations
            SET definition_revision = ?, state = 'retiring', last_error = NULL,
                last_operation_id = ?, last_operation_outcome = 'pending', updated_at = ?
          WHERE id = ? AND state IN ('pending', 'active', 'paused', 'failed')`,
      ).run(definitionRevision, operationIdFor(existing.id, request), now, id);
      if (result.changes !== 1) throw new Error("managed automation retirement intent fence was lost");
      return this.get(id)!;
    }).immediate();
  }

  public retire(id: string, now: number, fence: ManagedAutomationMutationFence): ManagedAutomationBinding {
    return this.db.transaction(() => {
      this.assertMutationFence(fence, id, now);
      const existing = this.get(id);
      if (existing?.state === "retired") return existing;
      const result = this.db.prepare(
        `UPDATE managed_automations SET state = 'retired', updated_at = ?
          WHERE id = ? AND state = 'retiring'`,
      ).run(now, id);
      if (result.changes !== 1) throw new Error("managed automation retirement fence was lost");
      return this.get(id)!;
    }).immediate();
  }

  public recordRun(bindingId: string, run: ManagedAutomationRun, now: number, fence: ManagedAutomationMutationFence): boolean {
    return this.db.transaction(() => {
      this.assertMutationFence(fence, bindingId, now);
      const binding = this.get(bindingId);
      if (!binding) throw new Error("managed automation run binding is missing");
      return this.recordRunInTransaction(binding, run, now);
    }).immediate();
  }

  private recordRunInTransaction(
    binding: ManagedAutomationBinding,
    rawRun: ManagedAutomationRun,
    now: number,
  ): boolean {
    const run = managedAutomationRunSchema.parse(rawRun);
    if (binding.bbAutomationId !== run.automationId || ["retiring", "retired"].includes(binding.state)) {
      throw new Error("managed automation run does not match its active binding");
    }
    const outputSha256 = run.output === null ? null : managedAutomationDigest(run.output);
    const contract = managedAutomationRunContract(binding, run);
    const errorClass = contract.errorClass ?? (run.error === null ? null : "bb_automation_run_failed");
    const evidenceJson = canonical({
      automationId: run.automationId,
      authority: binding.authority,
      capabilityEvidence: binding.capabilityEvidence,
      contractOutcome: contract.outcome,
      definitionRevision: binding.definitionRevision,
      errorClass,
      exitCode: run.exitCode,
      finishedAt: run.finishedAt,
      id: run.id,
      initiatingOperationId: binding.lastOperationId,
      output: outputSha256 === null ? null : { screened: true, sha256: outputSha256 },
      runMode: run.runMode,
      scheduledFor: run.scheduledFor,
      skipReason: run.skipReason,
      startedAt: run.startedAt,
      status: run.status,
      threadId: run.threadId,
      trigger: run.trigger,
    });
    const inserted = this.db.prepare(
      `INSERT OR IGNORE INTO managed_automation_run_evidence (
         binding_id, bb_run_id, bb_automation_id, status, run_mode, trigger_kind,
         thread_id, output_sha256, error_class, scheduled_for, started_at,
         finished_at, observed_at, evidence_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      binding.id,
      run.id,
      run.automationId,
      run.status,
      run.runMode,
      run.trigger,
      run.threadId,
      outputSha256,
      errorClass,
      run.scheduledFor,
      run.startedAt,
      run.finishedAt,
      now,
      evidenceJson,
    );
    if (inserted.changes === 0) return false;
    this.db.prepare(
      `UPDATE managed_automations
          SET last_run_id = ?, last_run_status = ?, updated_at = ?
        WHERE id = ?`,
    ).run(run.id, run.status, now, binding.id);
    if (run.status !== "running" && binding.notificationPolicy !== "silent") {
      const notification = this.db.prepare(
        `INSERT OR IGNORE INTO managed_automation_notifications (
           bb_run_id, binding_id, controller_key, update_id, input_text,
           state, created_at, enqueued_at
         ) VALUES (?, ?, ?, NULL, ?, 'pending', ?, NULL)`,
      ).run(
        run.id,
        binding.id,
        binding.controllerKey,
        managedAutomationNotificationText(binding, run),
        now,
      );
      if (notification.changes === 1) {
        const sequence = Number(notification.lastInsertRowid);
        this.db.prepare(
          "UPDATE managed_automation_notifications SET update_id = ? WHERE sequence = ? AND update_id IS NULL",
        ).run(7_000_000_000_000 + sequence, sequence);
      }
    }
    return true;
  }

  public listPendingNotifications(limit = 20): ManagedAutomationNotification[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("notification limit must be 1-100");
    const rows = this.db.prepare(
      `SELECT sequence, bb_run_id, binding_id, controller_key, update_id, input_text, created_at
         FROM managed_automation_notifications
        WHERE state = 'pending' AND update_id IS NOT NULL
        ORDER BY sequence LIMIT ?`,
    ).all(limit) as Array<{
      sequence: number;
      bb_run_id: string;
      binding_id: string;
      controller_key: string;
      update_id: number;
      input_text: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      sequence: row.sequence,
      bbRunId: row.bb_run_id,
      bindingId: row.binding_id,
      controllerKey: row.controller_key,
      updateId: row.update_id,
      inputText: row.input_text,
      createdAt: row.created_at,
    }));
  }

  public markNotificationEnqueued(sequence: number, now: number): boolean {
    const result = this.db.prepare(
      `UPDATE managed_automation_notifications SET state = 'enqueued', enqueued_at = ?
        WHERE sequence = ? AND state = 'pending'`,
    ).run(now, sequence);
    return result.changes === 1;
  }
}

function clip(value: string | null, limit: number): string {
  if (!value) return "(none)";
  return value.length <= limit ? value : `${value.slice(0, limit).trimEnd()}…`;
}

function managedAutomationNotificationText(
  binding: ManagedAutomationBinding,
  run: ManagedAutomationRun,
): string {
  const instruction = binding.definition.mode === "agent"
    ? binding.definition.prompt
    : `Run the script automation named ${binding.name}.`;
  const contract = managedAutomationRunContract(binding, run);
  return [
    "A BB Automation run finished. Treat this as a scheduled system handoff, not a new owner request.",
    `Schedule: ${binding.name}`,
    `Result: ${run.status}`,
    `Original instruction: ${clip(instruction, 1_000)}`,
    run.output === null
      ? "Worker output: (none)"
      : `Worker output: screened (sha256 ${managedAutomationDigest(run.output)})`,
    `Result contract: ${contract.outcome}`,
    `Error class: ${contract.errorClass ?? (run.error === null ? "(none)" : "bb_automation_run_failed")}`,
    ...(run.threadId ? [`BB worker thread: ${run.threadId}`] : []),
    binding.notificationPolicy === "always"
      ? "Give the owner a short result in simple language."
      : "Continue any safe follow-up that is clearly required. Tell the owner only when the result is material, needs a decision, or needs help. Otherwise stay silent.",
  ].join("\n");
}

function managedAutomationRunContract(
  binding: ManagedAutomationBinding,
  run: ManagedAutomationRun,
): Readonly<{
  outcome: "not_applicable" | "pending" | "satisfied" | "violated";
  errorClass: string | null;
}> {
  if (binding.definition.mode !== "agent") return { outcome: "not_applicable", errorClass: null };
  if (run.status === "running") return { outcome: "pending", errorClass: null };
  if (run.finishedAt !== null && run.finishedAt - run.startedAt > binding.definition.timeoutMs) {
    return { outcome: "violated", errorClass: "bb_automation_timeout_contract_violated" };
  }
  if (run.output !== null &&
    Buffer.byteLength(run.output, "utf8") > binding.definition.resultContract.maximumBytes) {
    return { outcome: "violated", errorClass: "bb_automation_result_contract_violated" };
  }
  return { outcome: "satisfied", errorClass: null };
}
