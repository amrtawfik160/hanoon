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
  managedAutomationStoredOutcomeSchema,
  managedAutomationRunReceiptSchema,
  managedAutomationAuthorityCoversOperation,
  isCurrentManagedAutomationAuthority,
  parseManagedAutomationAuthority,
  type ManagedAutomationAuthority,
  type ManagedAutomationCapabilityEvidence,
  type ManagedAutomationOperationClass,
  type ManagedAutomationOperationRequest,
  type ManagedAutomationRunOutcomeClass,
  type ManagedAutomationRunReceipt,
  type ManagedAutomationOutcomeReceipt,
  type StoredManagedAutomationAuthority,
} from "../domain/managed-automation";
import { ManagedAutomationProvenanceRepository } from "./managed-automation-provenance-repository";

type SqliteDatabase = Database.Database;

export type ManagedAutomationState = "pending" | "active" | "paused" | "updating" | "retiring" | "retired" | "failed";
export type ManagedAutomationDesiredState = "enabled" | "paused" | "retired";
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
  desiredState: ManagedAutomationDesiredState;
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
  lastReconciledOperationId: string | null;
  lastReconciledOperationOutcome: Exclude<ManagedAutomationOperationState, "pending" | "leased"> | null;
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

export type ManagedAutomationLifecycleReservation = Readonly<{
  id: string;
  definition?: ManagedAutomationDefinition;
  desiredState: ManagedAutomationDesiredState;
  authority: ManagedAutomationAuthority;
  operation: ManagedAutomationOperationRequest;
  controllerFence?: ManagedAutomationControllerFence;
  now: number;
}>;

export type ManagedAutomationOperation = Readonly<{
  id: string;
  bindingId: string;
  operationClass: ManagedAutomationOperationClass;
  version: 1;
  targetProjectId: string;
  targetHostId: string | null;
  definitionRevision: number;
  authority: StoredManagedAutomationAuthority;
  capabilityEvidence: ManagedAutomationCapabilityEvidence | null;
  controllerFence: ManagedAutomationControllerFence | null;
  intentKey: string | null;
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
  desired_state: string;
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
  last_reconciled_operation_id: string | null;
  last_reconciled_operation_outcome: string | null;
  created_at: number;
  updated_at: number;
}>;

type ManagedAutomationOperationRow = Readonly<{
  id: string;
  binding_id: string;
  operation_class: string;
  operation_version: number;
  target_project_id: string;
  target_host_id: string | null;
  definition_revision: number;
  intent_key: string | null;
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

type ManagedAutomationRunEvidenceRow = Readonly<{
  binding_id: string;
  bb_run_id: string;
  bb_automation_id: string;
  status: string;
  run_mode: string;
  trigger_kind: string;
  thread_id: string | null;
  output_sha256: string | null;
  error_class: string | null;
  scheduled_for: number;
  started_at: number;
  finished_at: number | null;
  observed_at: number;
  evidence_json: string;
  receipt_version: number | null;
  initiating_operation_id: string | null;
  definition_revision: number | null;
  authority_json: string | null;
  capability_evidence_json: string | null;
  idempotency_key: string | null;
  outcome_class: string | null;
}>;

type RunEvidenceFacts = Readonly<{
  binding: ManagedAutomationBinding;
  run: ManagedAutomationRun;
  outputSha256: string | null;
  errorClass: string | null;
}>;

type OperationRelationshipContext = Readonly<{
  row: ManagedAutomationOperationRow;
  binding: ManagedAutomationBinding;
  authority: StoredManagedAutomationAuthority;
  capabilityEvidence: ManagedAutomationCapabilityEvidence | null;
  db: SqliteDatabase;
}>;

const desiredStateSchema = z.enum(["enabled", "paused", "retired"]);
const controllerFenceSchema = z.object({
  ownerId: z.string().min(1).max(256),
  generation: z.number().int().positive().safe(),
  turnId: z.string().min(1).max(256),
}).strict();
const managedAutomationModeSchema = z.enum(["agent", "script"]);
const managedAutomationStateSchema = z.enum([
  "pending", "active", "paused", "updating", "retiring", "retired", "failed",
]);
const managedAutomationRunStatusSchema = z.enum(["running", "succeeded", "failed", "skipped"]);
const boundedStoredIdSchema = z.string().min(1).max(256);
const nullableBoundedStoredIdSchema = boundedStoredIdSchema.nullable();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const nullableSha256Schema = sha256Schema.nullable();
const nonNegativeStoredIntegerSchema = z.number().int().nonnegative().safe();
const nullableNonNegativeStoredIntegerSchema = nonNegativeStoredIntegerSchema.nullable();

const reserveSchema = z.object({
  controllerKey: z.string().min(1).max(256),
  sourceKey: z.string().min(1).max(256),
  projectId: z.string().min(1).max(256),
  name: z.string().min(1).max(200),
  definition: z.custom<ManagedAutomationDefinition>((value) => typeof value === "object" && value !== null),
  authority: z.record(z.string(), z.unknown()),
  notificationPolicy: z.enum(["material", "always", "silent"]),
  desiredState: desiredStateSchema.default("enabled"),
  legacyMonitorId: z.string().min(1).max(256).nullable().default(null),
  now: z.number().int().nonnegative().safe(),
  definitionRevision: z.number().int().positive().safe().default(1),
  operation: managedAutomationOperationRequestSchema.optional(),
  controllerFence: controllerFenceSchema.optional(),
}).strict();

const operationStateSchema = z.enum(["pending", "leased", "succeeded", "failed", "ambiguous"]);
const operationOutcomeSchema = z.enum(["succeeded", "failed", "ambiguous"]);
const reconciledOperationOutcomeSchema = z.enum(["succeeded", "failed", "ambiguous"]);
const boundedErrorClassSchema = z.string().min(1).max(256);
const providerAutomationIdSchema = z.string().min(1).max(256).nullable();
const operationEvidenceSchema = z.record(z.string(), z.unknown()).nullable();
const providerOwnershipMarkerSchema = z.string().min(1).max(256).nullable();
const operationIntentKeySchema = z.string().min(1).max(256).nullable();
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
  const id = boundedStoredIdSchema.parse(row.id);
  const controllerKey = boundedStoredIdSchema.parse(row.controller_key);
  const sourceKey = boundedStoredIdSchema.parse(row.source_key);
  const projectId = boundedStoredIdSchema.parse(row.project_id);
  const name = z.string().min(1).max(200).parse(row.name);
  const mode = managedAutomationModeSchema.parse(row.mode);
  const state = managedAutomationStateSchema.parse(row.state);
  const notificationPolicy = z.enum(["material", "always", "silent"]).parse(row.notification_policy);
  const definitionRevision = z.number().int().positive().safe().parse(row.definition_revision);
  const authorityVersionValue = z.number().int().nonnegative().safe().parse(row.authority_version);
  const definitionSha256 = sha256Schema.parse(row.definition_sha256);
  const bbAutomationId = nullableBoundedStoredIdSchema.parse(row.bb_automation_id);
  const providerOwnershipMarker = providerOwnershipMarkerSchema.parse(row.provider_ownership_marker);
  const legacyMonitorId = nullableBoundedStoredIdSchema.parse(row.legacy_monitor_id);
  const capabilityProfileId = nullableBoundedStoredIdSchema.parse(row.capability_profile_id);
  const capabilityProfileRevision = row.capability_profile_revision === null
    ? null
    : z.number().int().positive().safe().parse(row.capability_profile_revision);
  const observedSha256 = nullableSha256Schema.parse(row.observed_sha256);
  const lastReconciledAt = nullableNonNegativeStoredIntegerSchema.parse(row.last_reconciled_at);
  const lastRunId = nullableBoundedStoredIdSchema.parse(row.last_run_id);
  const lastRunStatus = row.last_run_status === null
    ? null
    : managedAutomationRunStatusSchema.parse(row.last_run_status);
  const lastError = row.last_error === null ? null : z.string().max(16_384).parse(row.last_error);
  const lastOperationId = nullableBoundedStoredIdSchema.parse(row.last_operation_id);
  const lastReconciledOperationId = nullableBoundedStoredIdSchema.parse(row.last_reconciled_operation_id);
  const createdAt = nonNegativeStoredIntegerSchema.parse(row.created_at);
  const updatedAt = nonNegativeStoredIntegerSchema.parse(row.updated_at);
  if (capabilityProfileId === null && capabilityProfileRevision !== null) {
    throw new Error("Managed automation capability profile revision has no profile");
  }
  if ((row.observed_json === null) !== (observedSha256 === null)) {
    throw new Error("Managed automation observation digest does not match its row");
  }
  const authority = parseManagedAutomationAuthority(JSON.parse(row.authority_json));
  const desiredState = desiredStateSchema.parse(row.desired_state);
  const expectedAuthorityVersion = authorityVersion(authority);
  if (authorityVersionValue !== expectedAuthorityVersion) {
    throw new Error("Managed automation authority version does not match its authority");
  }
  const capabilityEvidence = row.capability_evidence_json === null
    ? authorityEvidence(authority)
    : managedAutomationCapabilityEvidenceSchema.parse(JSON.parse(row.capability_evidence_json));
  if (authorityVersionValue === 1 && capabilityEvidence === null) {
    throw new Error("Current managed automation authority has no capability evidence");
  }
  if (capabilityEvidence !== null && isCurrentManagedAutomationAuthority(authority) &&
    managedAutomationDigest(capabilityEvidence) !== managedAutomationDigest(authority.capabilityEvidence)) {
    throw new Error("Managed automation capability evidence does not match its authority");
  }
  if ((capabilityProfileId === null) !== (capabilityEvidence === null) ||
    (capabilityEvidence !== null &&
      (capabilityProfileId !== capabilityEvidence.profileId ||
        capabilityProfileRevision !== capabilityEvidence.profileRevision))) {
    throw new Error("Managed automation capability profile reference does not match its evidence");
  }
  const decodedDefinition = decodeDefinition(JSON.parse(row.definition_json));
  if (decodedDefinition.current && managedAutomationDigest(decodedDefinition.value) !== definitionSha256) {
    throw new Error("Managed automation definition digest does not match its current value");
  }
  if (decodedDefinition.current && (decodedDefinition.value.mode !== mode ||
    decodedDefinition.value.projectId !== projectId || decodedDefinition.value.name !== name)) {
    throw new Error("Managed automation definition identity does not match its row");
  }
  const decodedObservation = row.observed_json === null ? null : decodeObservation(JSON.parse(row.observed_json));
  if (decodedObservation?.current && observedSha256 !== managedAutomationDigest(decodedObservation.value)) {
    throw new Error("Managed automation observation digest does not match its current value");
  }
  if (decodedObservation?.current && state !== "updating" &&
    (bbAutomationId !== decodedObservation.value.providerAutomationId ||
    projectId !== decodedObservation.value.projectId || name !== decodedObservation.value.name)) {
    throw new Error("Managed automation observation identity does not match its row");
  }
  const lastOperationOutcome = row.last_operation_outcome === null
    ? null
    : operationStateSchema.parse(row.last_operation_outcome);
  return {
    id,
    controllerKey,
    sourceKey,
    projectId,
    bbAutomationId,
    providerOwnershipMarker,
    name,
    mode,
    definition: decodedDefinition.value,
    definitionSha256,
    authority,
    definitionRevision,
    authorityVersion: authorityVersionValue,
    capabilityEvidence,
    notificationPolicy,
    desiredState,
    state,
    legacyMonitorId,
    observed: decodedObservation?.value ?? null,
    observedSha256,
    lastReconciledAt,
    lastRunId,
    lastRunStatus,
    lastError,
    lastOperationId,
    lastOperationOutcome,
    lastReconciledOperationId,
    lastReconciledOperationOutcome: row.last_reconciled_operation_outcome === null
      ? null
      : reconciledOperationOutcomeSchema.parse(row.last_reconciled_operation_outcome),
    createdAt,
    updatedAt,
  };
}

function requireOperationBinding(
  row: ManagedAutomationOperationRow,
  binding: ManagedAutomationBinding | null,
): ManagedAutomationBinding {
  if (!binding || binding.id !== row.binding_id) {
    throw new Error("Managed automation operation binding is unavailable");
  }
  if (binding.projectId !== row.target_project_id || binding.definitionRevision !== row.definition_revision) {
    throw new Error("Managed automation operation does not match its binding");
  }
  return binding;
}

function assertOperationDigest(
  label: string,
  actual: unknown,
  expected: unknown,
): void {
  if (managedAutomationDigest(actual) !== managedAutomationDigest(expected)) {
    throw new Error(`Managed automation ${label} does not match its binding`);
  }
}

function assertRunReceiptIdentity(
  receipt: ManagedAutomationRunReceipt,
  relationshipContext: OperationRelationshipContext,
): void {
  const { row, binding } = relationshipContext;
  if (receipt.automationBindingId !== binding.id || receipt.definitionRevision !== row.definition_revision ||
    receipt.initiatingOperationId !== row.id || receipt.providerAutomationId !== row.provider_automation_id ||
    (binding.bbAutomationId !== null && receipt.providerAutomationId !== binding.bbAutomationId)) {
    throw new Error("Managed automation run receipt does not match its operation binding");
  }
}

function correlatedRunEvidence(
  receipt: ManagedAutomationRunReceipt,
  relationshipContext: OperationRelationshipContext,
): ManagedAutomationRunEvidenceRow | undefined {
  return relationshipContext.db.prepare(
    `SELECT binding_id, bb_run_id, bb_automation_id, status, run_mode, trigger_kind,
            thread_id, output_sha256, error_class, scheduled_for, started_at,
            finished_at, observed_at, evidence_json, receipt_version, initiating_operation_id,
            definition_revision, authority_json, capability_evidence_json,
            idempotency_key, outcome_class
       FROM managed_automation_run_evidence
      WHERE binding_id = ? AND bb_run_id = ? AND initiating_operation_id = ?`,
  ).get(
    relationshipContext.binding.id,
    receipt.providerRunId,
    receipt.initiatingOperationId,
  ) as ManagedAutomationRunEvidenceRow | undefined;
}

function existingRunEvidence(
  db: SqliteDatabase,
  run: ManagedAutomationRun,
): ManagedAutomationRunEvidenceRow | undefined {
  return db.prepare(
    `SELECT binding_id, bb_run_id, bb_automation_id, status, run_mode, trigger_kind,
            thread_id, output_sha256, error_class, scheduled_for, started_at,
            finished_at, observed_at, evidence_json, receipt_version, initiating_operation_id,
            definition_revision, authority_json, capability_evidence_json,
            idempotency_key, outcome_class
       FROM managed_automation_run_evidence
      WHERE bb_run_id = ? AND status = ?`,
  ).get(run.id, run.status) as ManagedAutomationRunEvidenceRow | undefined;
}

function assertRunEvidenceFacts(
  evidence: ManagedAutomationRunEvidenceRow,
  facts: RunEvidenceFacts,
): void {
  const { binding, run, outputSha256, errorClass } = facts;
  if (evidence.binding_id !== binding.id || evidence.bb_run_id !== run.id ||
    evidence.bb_automation_id !== run.automationId || evidence.status !== run.status ||
    evidence.run_mode !== run.runMode || evidence.trigger_kind !== run.trigger ||
    evidence.thread_id !== run.threadId || evidence.output_sha256 !== outputSha256 ||
    evidence.error_class !== errorClass || evidence.scheduled_for !== run.scheduledFor ||
    evidence.started_at !== run.startedAt || evidence.finished_at !== run.finishedAt) {
    throw new TypeError("managed automation run evidence does not match its provider run");
  }
}

function assertExistingRunProvenance(
  evidence: ManagedAutomationRunEvidenceRow,
  receipt: ManagedAutomationRunReceipt | null,
): void {
  if (!receipt) return;
  if (evidence.initiating_operation_id === null) {
    throw new TypeError("managed automation exact run provenance was preempted by an uncorrelated observation");
  }
  if (evidence.initiating_operation_id !== receipt.initiatingOperationId ||
    evidence.receipt_version !== receipt.version || evidence.definition_revision !== receipt.definitionRevision ||
    evidence.authority_json !== canonical(receipt.authority) ||
    evidence.capability_evidence_json !== canonical(receipt.capabilityEvidence) ||
    evidence.idempotency_key !== receipt.initiatingOperationId || evidence.outcome_class !== receipt.outcomeClass) {
    throw new TypeError("managed automation run evidence has conflicting authoritative provenance");
  }
}

function hasRetryableRunNowOperation(
  db: SqliteDatabase,
  bindingId: string,
  idempotencyKey: string | null | undefined,
): boolean {
  if (!idempotencyKey) return false;
  const row = db.prepare(
    `SELECT 1 FROM managed_automation_operations
      WHERE binding_id = ? AND id = ? AND operation_class = 'run_now'
        AND state IN ('pending', 'leased', 'ambiguous') LIMIT 1`,
  ).get(bindingId, idempotencyKey) as { 1: number } | undefined;
  return row !== undefined;
}

function assertRunReceiptEvidence(
  receipt: ManagedAutomationRunReceipt,
  relationshipContext: OperationRelationshipContext,
): void {
  const { row } = relationshipContext;
  const evidence = correlatedRunEvidence(receipt, relationshipContext);
  if (!evidence || evidence.binding_id !== relationshipContext.binding.id ||
    evidence.bb_run_id !== receipt.providerRunId || evidence.bb_automation_id !== receipt.providerAutomationId ||
    evidence.receipt_version !== receipt.version || evidence.initiating_operation_id !== row.id ||
    evidence.definition_revision !== row.definition_revision ||
    evidence.authority_json !== canonical(receipt.authority) ||
    evidence.capability_evidence_json !== canonical(receipt.capabilityEvidence) ||
    evidence.idempotency_key !== row.id || evidence.outcome_class !== receipt.outcomeClass ||
    evidence.scheduled_for !== receipt.scheduledFor || evidence.started_at !== receipt.startedAt ||
    evidence.finished_at !== receipt.finishedAt || evidence.observed_at !== receipt.observedAt) {
    throw new Error("Managed automation run receipt does not match durable run evidence");
  }
}

function assertRunReceiptRelationships(
  receipt: ManagedAutomationRunReceipt,
  relationshipContext: OperationRelationshipContext,
): void {
  assertRunReceiptIdentity(receipt, relationshipContext);
  assertOperationDigest("run receipt authority", receipt.authority, relationshipContext.authority);
  assertOperationDigest(
    "run receipt capability evidence",
    receipt.capabilityEvidence,
    relationshipContext.capabilityEvidence,
  );
  assertRunReceiptEvidence(receipt, relationshipContext);
}

function assertCurrentOutcomeIdentity(
  outcome: ManagedAutomationOutcomeReceipt,
  relationshipContext: OperationRelationshipContext,
): void {
  const { row } = relationshipContext;
  // A retry claim keeps the previous settled receipt while its new lease is active.
  if (outcome.operationClass !== row.operation_class || outcome.operationId !== row.id ||
    (outcome.outcome !== row.state && row.state !== "leased")) {
    throw new Error("Managed automation outcome does not match its operation state or class");
  }
}

function assertCurrentOutcomeProviderIdentity(
  outcome: ManagedAutomationOutcomeReceipt,
  relationshipContext: OperationRelationshipContext,
): void {
  const { row, binding } = relationshipContext;
  if (outcome.providerAutomationId !== row.provider_automation_id ||
    outcome.ownershipMarker !== row.provider_ownership_marker ||
    (binding.bbAutomationId !== null && outcome.providerAutomationId !== binding.bbAutomationId)) {
    throw new Error("Managed automation outcome provider identity does not match its operation binding");
  }
  if (outcome.observedSha256 !== null && outcome.observedSha256 !== binding.observedSha256) {
    throw new Error("Managed automation outcome observation does not match its binding");
  }
}

function assertCurrentOutcomeReceipt(
  outcome: ManagedAutomationOutcomeReceipt,
  relationshipContext: OperationRelationshipContext,
): void {
  const { row } = relationshipContext;
  const receipt = outcome.runReceipt ?? null;
  if (row.operation_class === "run_now" && outcome.outcome === "succeeded" && receipt === null) {
    throw new Error("Successful managed automation run-now outcome has no run receipt");
  }
  if (row.operation_class !== "run_now" && receipt !== null) {
    throw new Error("Managed automation run receipt belongs to an unrelated operation");
  }
  if (receipt !== null) assertRunReceiptRelationships(receipt, relationshipContext);
}

function assertCurrentOutcomeRelationships(
  outcome: ManagedAutomationOutcomeReceipt,
  relationshipContext: OperationRelationshipContext,
): void {
  assertCurrentOutcomeIdentity(outcome, relationshipContext);
  assertOperationDigest("outcome authority", outcome.authority, relationshipContext.authority);
  assertOperationDigest(
    "outcome capability evidence",
    outcome.capabilityEvidence,
    relationshipContext.capabilityEvidence,
  );
  assertCurrentOutcomeProviderIdentity(outcome, relationshipContext);
  assertCurrentOutcomeReceipt(outcome, relationshipContext);
}

function parseOperation(
  row: ManagedAutomationOperationRow,
  binding: ManagedAutomationBinding,
  db: SqliteDatabase,
): ManagedAutomationOperation {
  const id = boundedStoredIdSchema.parse(row.id);
  const bindingId = boundedStoredIdSchema.parse(row.binding_id);
  const operationClass = managedAutomationOperationRequestSchema.shape.operationClass.parse(row.operation_class);
  const version = z.literal(1).parse(row.operation_version);
  const state = operationStateSchema.parse(row.state);
  const definitionRevision = z.number().int().positive().safe().parse(row.definition_revision);
  const targetProjectId = z.string().min(1).max(256).parse(row.target_project_id);
  const targetHostId = row.target_host_id === null
    ? null
    : z.string().min(1).max(256).parse(row.target_host_id);
  const intentKey = operationIntentKeySchema.parse(row.intent_key);
  const attempts = z.number().int().nonnegative().safe().parse(row.attempts);
  const leaseOwner = nullableBoundedStoredIdSchema.parse(row.lease_owner);
  const leaseGeneration = row.lease_generation === null
    ? null
    : z.number().int().positive().safe().parse(row.lease_generation);
  const leaseExpiresAt = nullableNonNegativeStoredIntegerSchema.parse(row.lease_expires_at);
  const lastError = row.last_error === null ? null : boundedErrorClassSchema.parse(row.last_error);
  const nextAttemptAt = nonNegativeStoredIntegerSchema.parse(row.next_attempt_at);
  const createdAt = nonNegativeStoredIntegerSchema.parse(row.created_at);
  const updatedAt = nonNegativeStoredIntegerSchema.parse(row.updated_at);
  const settledAt = nullableNonNegativeStoredIntegerSchema.parse(row.settled_at);
  const providerAutomationId = providerAutomationIdSchema.parse(row.provider_automation_id);
  const providerOwnershipMarker = providerOwnershipMarkerSchema.parse(row.provider_ownership_marker);
  const leaseValues = [leaseOwner, leaseGeneration, leaseExpiresAt];
  const hasLeaseValue = leaseValues.some((value) => value !== null);
  if (hasLeaseValue && leaseValues.some((value) => value === null)) {
    throw new Error("Managed automation operation lease is incomplete");
  }
  if (state === "leased" && !hasLeaseValue) {
    throw new Error("Leased managed automation operation has no lease");
  }
  if (state !== "leased" && hasLeaseValue) {
    throw new Error("Unleased managed automation operation has a lease");
  }
  const authority = parseManagedAutomationAuthority(JSON.parse(row.authority_json));
  const operationBinding = requireOperationBinding(row, binding);
  if (isCurrentManagedAutomationAuthority(authority) && !managedAutomationAuthorityCoversOperation(authority, {
    operationClass,
    targetProjectId,
    targetHostId,
  })) {
    throw new Error("Managed automation operation target is outside its authority");
  }
  const capabilityEvidence = row.capability_evidence_json === null
    ? authorityEvidence(authority)
    : managedAutomationCapabilityEvidenceSchema.parse(JSON.parse(row.capability_evidence_json));
  if (isCurrentManagedAutomationAuthority(authority) && capabilityEvidence === null) {
    throw new Error("Current managed automation operation has no capability evidence");
  }
  if (isCurrentManagedAutomationAuthority(authority)) {
    assertOperationDigest("operation authority", authority, operationBinding.authority);
    assertOperationDigest("operation capability evidence", capabilityEvidence, operationBinding.capabilityEvidence);
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
  if (isCurrentManagedAutomationAuthority(authority) && operationClass !== "reconcile" &&
    authority.origin === "owner" && (!controllerFence || authority.taskAuthority.turnId !== controllerFence.turnId)) {
    throw new Error("Managed automation operation authority does not match its controller fence");
  }
  if (isCurrentManagedAutomationAuthority(authority) && authority.origin !== "owner" && controllerFence !== null) {
    throw new Error("Non-owner managed automation operation cannot carry a controller fence");
  }
  const rawOutcome = row.outcome_json === null ? null : JSON.parse(row.outcome_json);
  const outcome = rawOutcome === null ? null : decodeOutcome(rawOutcome);
  if (providerAutomationId !== null && binding.bbAutomationId !== null && providerAutomationId !== binding.bbAutomationId) {
    throw new Error("Managed automation operation provider identity does not match its binding");
  }
  if (providerOwnershipMarker !== null && binding.providerOwnershipMarker !== null &&
    providerOwnershipMarker !== binding.providerOwnershipMarker) {
    throw new Error("Managed automation operation ownership marker does not match its binding");
  }
  if (outcome && hasVersionField(outcome) && outcome.kind === "provider-acknowledgement" &&
    (outcome.providerAutomationId !== providerAutomationId || outcome.ownershipMarker !== providerOwnershipMarker)) {
    throw new Error("Managed automation acknowledgement does not match its operation");
  }
  if (outcome && hasVersionField(outcome) && outcome.kind === "settled" &&
    (outcome.providerAutomationId !== providerAutomationId || outcome.ownershipMarker !== providerOwnershipMarker)) {
    throw new Error("Managed automation outcome does not match its operation");
  }
  if (outcome && hasVersionField(outcome) && outcome.kind === "provider-acknowledgement" && state !== "leased") {
    throw new Error("Managed automation acknowledgement does not match its operation state");
  }
  if (outcome && hasVersionField(outcome) && outcome.kind === "settled") {
    assertCurrentOutcomeRelationships(outcome as ManagedAutomationOutcomeReceipt, {
      row,
      binding,
      authority,
      capabilityEvidence,
      db,
    });
  }
  return {
    id,
    bindingId,
    operationClass,
    version,
    targetProjectId,
    targetHostId,
    definitionRevision,
    intentKey,
    authority,
    capabilityEvidence,
    controllerFence,
    state,
    attempts,
    leaseOwner,
    leaseGeneration,
    leaseExpiresAt,
    providerAutomationId,
    providerOwnershipMarker,
    outcome,
    lastError,
    nextAttemptAt,
    createdAt,
    updatedAt,
    settledAt,
  };
}

function operationIdFor(bindingId: string, operation: ManagedAutomationOperationRequest): string {
  const identity: Record<string, unknown> = {
    bindingId,
    operationClass: operation.operationClass,
    ...(operation.targetHostId === undefined ? {} : { targetHostId: operation.targetHostId }),
    definitionRevision: operation.definitionRevision,
  };
  if (operation.intentKey !== undefined) identity.intentKey = operation.intentKey;
  return "managed-automation-operation-" + managedAutomationDigest(identity).slice(0, 48);
}

function normalizeSettledObservation(
  binding: ManagedAutomationBinding,
  observation: ManagedAutomationObservation,
  ownershipMarker: string | null,
): ManagedAutomationObservation {
  const providerName = ownershipMarker ? `${binding.name} [${ownershipMarker}]` : binding.name;
  if (observation.projectId !== binding.projectId ||
    (observation.name !== binding.name && observation.name !== providerName) ||
    observation.mode !== binding.mode ||
    managedAutomationDigest(observation.trigger) !== managedAutomationDigest(binding.definition.trigger) ||
    managedAutomationDigest(observation.target) !== managedAutomationDigest(
      binding.definition.mode === "agent" ? binding.definition.target : null,
    ) || observation.enabled !== (binding.desiredState === "enabled")) {
    throw new TypeError("provider automation does not match its managed binding");
  }
  return observation.name === binding.name ? observation : { ...observation, name: binding.name };
}

function ownershipMarkerFor(operationId: string): string {
  return `hanoon:${managedAutomationDigest(operationId).slice(0, 40)}`;
}

function assertCurrentOperationInput(
  authority: StoredManagedAutomationAuthority,
  operation: ManagedAutomationOperationRequest,
  controllerFence: ManagedAutomationControllerFence | undefined,
  controllerKey: string,
  projectId: string,
  definitionRevision: number,
): asserts authority is ManagedAutomationAuthority {
  managedAutomationOperationRequestSchema.parse(operation);
  if (controllerFence) controllerFenceSchema.parse(controllerFence);
  if (!isCurrentManagedAutomationAuthority(authority)) {
    throw new TypeError("current managed automation operations require versioned authority");
  }
  if (authority.controllerKey !== controllerKey || authority.projectId !== projectId ||
    operation.targetProjectId !== projectId || operation.definitionRevision !== definitionRevision) {
    throw new TypeError("managed automation operation does not match its binding");
  }
  if (operation.targetHostId !== undefined && operation.targetHostId !== authority.hostId) {
    throw new TypeError("managed automation operation does not match its authority host");
  }
  if (authority.origin === "automation-triggered" &&
    (!operation.targetHostId || !managedAutomationAuthorityCoversOperation(authority, operation))) {
    throw new TypeError("automation-triggered operation is outside its recursive authority");
  }
  if (!controllerFence && operation.operationClass !== "reconcile" &&
    authority.origin === "owner") {
    throw new TypeError("managed automation operation requires its controller fence");
  }
  if (controllerFence && authority.origin === "owner" && (authority.taskAuthority.kind !== "controller-turn" ||
    authority.taskAuthority.turnId !== controllerFence.turnId)) {
    throw new TypeError("owner managed automation operation requires its controller fence");
  }
  if (controllerFence && authority.origin !== "owner") {
    throw new TypeError("non-owner managed automation operations cannot carry a controller fence");
  }
}

export class ManagedAutomationRepository {
  private readonly provenanceRepository: ManagedAutomationProvenanceRepository;

  public constructor(private readonly db: SqliteDatabase) {
    this.provenanceRepository = new ManagedAutomationProvenanceRepository(db);
  }

  public getProvenanceRepository(): ManagedAutomationProvenanceRepository {
    return this.provenanceRepository;
  }

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
    return row ? parseOperation(row, this.requireBindingForOperation(row), this.db) : null;
  }

  public findOperation(
    bindingId: string,
    operationClass: ManagedAutomationOperationClass,
    intentKey: string,
  ): ManagedAutomationOperation | null {
    managedAutomationOperationRequestSchema.shape.operationClass.parse(operationClass);
    operationIntentKeySchema.parse(intentKey);
    const row = this.db.prepare(
      `SELECT * FROM managed_automation_operations
        WHERE binding_id = ? AND operation_class = ? AND intent_key = ?
        ORDER BY created_at DESC LIMIT 1`,
    ).get(bindingId, operationClass, intentKey) as ManagedAutomationOperationRow | undefined;
    return row ? parseOperation(row, this.requireBindingForOperation(row), this.db) : null;
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
    return rows.map((row) => parseOperation(row, this.requireBindingForOperation(row), this.db));
  }

  private requireBindingForOperation(row: ManagedAutomationOperationRow): ManagedAutomationBinding {
    return requireOperationBinding(row, this.get(row.binding_id));
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
    runs?: readonly ManagedAutomationRun[];
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
    const run = input.run === undefined || input.run === null ? null : input.run;
    const runs = input.runs ?? [];
    return this.db.transaction((): ManagedAutomationBinding | null => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return null;
      const operation = this.getOperation(input.operationId);
      if (!operation || operation.state !== "leased" || operation.leaseOwner !== input.ownerId ||
        operation.leaseGeneration !== input.generation || operation.leaseExpiresAt === null ||
        operation.leaseExpiresAt <= input.now) return null;
      const binding = this.get(operation.bindingId);
      if (!binding || binding.definitionRevision !== operation.definitionRevision ||
        binding.projectId !== operation.targetProjectId) return null;
      if (managedAutomationDigest(operation.authority) !== managedAutomationDigest(binding.authority) ||
        managedAutomationDigest(operation.capabilityEvidence) !== managedAutomationDigest(binding.capabilityEvidence)) {
        return null;
      }
      const ownershipMarker = providerOwnershipMarkerSchema.parse(
        binding.providerOwnershipMarker ?? operation.providerOwnershipMarker,
      );
      if (binding.providerOwnershipMarker !== null && operation.providerOwnershipMarker !== null &&
        binding.providerOwnershipMarker !== operation.providerOwnershipMarker) {
        throw new TypeError("managed automation ownership marker does not match its operation");
      }
      const settledInputObservation = observation === null
        ? null
        : normalizeSettledObservation(binding, observation, ownershipMarker);
      const providerAutomationId = providerAutomationIdSchema.parse(
        input.providerAutomationId !== undefined
          ? input.providerAutomationId
          : observation?.providerAutomationId ?? operation.providerAutomationId ?? binding.bbAutomationId,
      );
      if (observation && providerAutomationId !== observation.providerAutomationId) {
        throw new TypeError("provider automation identity does not match its observation");
      }
      if (operation.providerAutomationId !== null && providerAutomationId !== operation.providerAutomationId) {
        throw new TypeError("provider automation identity does not match its operation");
      }
      if (binding.bbAutomationId !== null && providerAutomationId !== null &&
        providerAutomationId !== binding.bbAutomationId) {
        throw new TypeError("provider automation identity does not match its binding");
      }
      if (!isCurrentManagedAutomationAuthority(operation.authority)) {
        throw new TypeError("managed automation outcomes require versioned authority");
      }
      if (!operation.capabilityEvidence) {
        throw new TypeError("managed automation outcomes require capability evidence");
      }
      const retiresBinding = operation.operationClass === "retire" || binding.state === "retiring";
      const settledObservation = retiresBinding ? null : settledInputObservation;
      if (outcome === "succeeded" && !retiresBinding && !settledObservation) {
        throw new TypeError("successful managed automation settlement needs provider state");
      }
      if (run && (providerAutomationId === null || run.automationId !== providerAutomationId)) {
        throw new TypeError("managed automation run does not match its provider automation");
      }
      const runReceipt = run
        ? managedAutomationRunReceipt(binding, operation.id, operation.authority, operation.capabilityEvidence, run, input.now)
        : null;
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
        observedSha256: settledObservation ? managedAutomationDigest(settledObservation) : null,
        runReceipt,
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
      if (outcome === "succeeded") {
        const successfulObservation = settledObservation;
        const bindingUpdate = retiresBinding
          ? this.db.prepare(
              `UPDATE managed_automations
                  SET desired_state = 'retired', state = 'retired', last_reconciled_at = ?,
                      last_error = NULL, last_operation_id = ?, last_operation_outcome = 'succeeded',
                      last_reconciled_operation_id = ?, last_reconciled_operation_outcome = 'succeeded',
                      updated_at = ?
                WHERE id = ?`,
            ).run(input.now, input.operationId, input.operationId, input.now, binding.id)
          : this.db.prepare(
              `UPDATE managed_automations
                  SET bb_automation_id = ?, provider_ownership_marker = COALESCE(provider_ownership_marker, ?),
                      observed_json = ?, observed_sha256 = ?,
                      state = CASE WHEN ? THEN 'active' ELSE 'paused' END,
                      last_reconciled_at = ?, last_error = NULL, last_operation_id = ?,
                      last_operation_outcome = 'succeeded', last_reconciled_operation_id = ?,
                      last_reconciled_operation_outcome = 'succeeded', updated_at = ?
                WHERE id = ?`,
            ).run(
              successfulObservation!.providerAutomationId,
              ownershipMarker,
              canonical({ version: 1, value: successfulObservation }),
              managedAutomationDigest(successfulObservation),
              successfulObservation!.enabled ? 1 : 0,
              input.now,
              input.operationId,
              input.operationId,
              input.now,
              binding.id,
            );
        if (bindingUpdate.changes !== 1) throw new Error("managed automation settlement could not update its binding");
      } else {
        const bindingUpdate = this.db.prepare(
          `UPDATE managed_automations
              SET state = CASE WHEN ? = 'failed' AND bb_automation_id IS NULL THEN 'failed' ELSE state END,
                  last_error = ?, last_operation_id = ?, last_operation_outcome = ?,
                  last_reconciled_operation_id = ?, last_reconciled_operation_outcome = ?, updated_at = ?
            WHERE id = ?`,
        ).run(
          outcome,
          errorClass ?? (outcome === "ambiguous" ? "managed_automation_provider_outcome_ambiguous" : "managed_automation_operation_failed"),
          input.operationId,
          outcome,
          input.operationId,
          outcome,
          input.now,
          binding.id,
        );
        if (bindingUpdate.changes !== 1) throw new Error("managed automation settlement could not update its binding");
      }
      if (outcome === "succeeded" && !retiresBinding) {
        const current = this.get(binding.id)!;
        for (const candidate of runs) this.recordRunInTransaction(current, candidate, input.now);
        if (run) this.recordRunInTransaction(current, run, input.now, operation.id);
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

  public reserve(raw: z.input<typeof reserveSchema>): ManagedAutomationBinding {
    const input = reserveSchema.parse(raw);
    const definition = managedAutomationDefinitionSchema.parse(input.definition);
    if (definition.projectId !== input.projectId || definition.name !== input.name) {
      throw new TypeError("managed automation identity must match its definition");
    }
    const authority = parseManagedAutomationAuthority(input.authority);
    const definitionRevision = input.operation?.definitionRevision ?? input.definitionRevision;
    const currentAuthority = input.operation && isCurrentManagedAutomationAuthority(authority) ? authority : null;
    if (input.operation) {
      assertCurrentOperationInput(authority, input.operation, input.controllerFence, input.controllerKey, input.projectId, definitionRevision);
    }
    const definitionJson = canonical({ version: 1, value: definition });
    const authorityJson = canonical(authority);
    const definitionSha256 = managedAutomationDigest(definition);
    return this.db.transaction(() => {
      const existing = this.getBySource(input.controllerKey, input.sourceKey);
      if (existing) {
        if (existing.definitionSha256 !== definitionSha256 || existing.state === "retired") {
          throw new Error("managed automation source already has a different durable definition");
        }
        if (input.operation) this.ensureOperation(existing, input.operation, currentAuthority!, input.controllerFence ?? null);
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
           desired_state, state, legacy_monitor_id, definition_revision, authority_version,
           capability_profile_id, capability_profile_revision, capability_evidence_json,
           last_operation_id, last_operation_outcome, last_reconciled_operation_id,
           last_reconciled_operation_outcome, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.desiredState,
        input.legacyMonitorId,
        definitionRevision,
        authorityVersion(authority),
        authorityEvidence(authority)?.profileId ?? null,
        authorityEvidence(authority)?.profileRevision ?? null,
        authorityEvidence(authority) ? canonical(authorityEvidence(authority)) : null,
        input.operation ? operationIdFor(id, input.operation) : null,
        input.operation ? "pending" : null,
        null,
        null,
        input.now,
        input.now,
      );
      if (input.operation) this.insertOperation(id, input.operation, currentAuthority!, input.controllerFence ?? null, input.now);
      return this.get(id)!;
    }).immediate();
  }

  public reserveLifecycle(input: ManagedAutomationLifecycleReservation): ManagedAutomationBinding {
    const operation = managedAutomationOperationRequestSchema.parse(input.operation);
    const authority = parseManagedAutomationAuthority(input.authority);
    if (!isCurrentManagedAutomationAuthority(authority)) {
      throw new TypeError("managed automation lifecycle requires versioned authority");
    }
    if (operation.operationClass === "create") {
      throw new TypeError("managed automation creation uses the creation reservation path");
    }
    const desiredState = desiredStateSchema.parse(input.desiredState);
    if (!Number.isSafeInteger(input.now) || input.now < 0) {
      throw new TypeError("managed automation lifecycle timestamp is invalid");
    }
    const definition = input.definition === undefined
      ? undefined
      : managedAutomationDefinitionSchema.parse(input.definition);
    return this.db.transaction(() => {
      const binding = this.get(input.id);
      if (!binding) throw new Error("managed automation binding is unavailable");
      if (definition && (definition.projectId !== binding.projectId || definition.mode !== binding.mode)) {
        throw new TypeError("managed automation lifecycle definition does not match its binding");
      }
      assertCurrentOperationInput(
        authority,
        operation,
        input.controllerFence,
        binding.controllerKey,
        binding.projectId,
        operation.definitionRevision,
      );
      if (operation.operationClass === "update" && !definition) {
        throw new TypeError("managed automation update requires a definition");
      }
      if (operation.operationClass !== "update" && definition) {
        throw new TypeError("only managed automation updates may change the definition");
      }
      if (operation.operationClass === "run_now" && binding.desiredState !== "enabled") {
        throw new Error("paused managed automation cannot be run manually");
      }
      if (operation.operationClass === "run_now" && desiredState !== "enabled") {
        throw new TypeError("run-now operation must preserve the enabled desired state");
      }
      if (operation.operationClass === "reconcile" && desiredState !== binding.desiredState) {
        throw new TypeError("reconciliation cannot change the desired state");
      }
      if (operation.operationClass === "enable" && desiredState !== "enabled") {
        throw new TypeError("enable operation must request enabled state");
      }
      if (operation.operationClass === "disable" && desiredState !== "paused") {
        throw new TypeError("disable operation must request paused state");
      }
      if (operation.operationClass === "retire" && desiredState !== "retired") {
        throw new TypeError("retire operation must request retired state");
      }
      if (operation.operationClass === "update" && desiredState === "retired") {
        throw new TypeError("retired managed automations cannot receive definition updates");
      }
      const definitionValue = definition ?? binding.definition;
      const definitionJson = canonical({ version: 1, value: definitionValue });
      const definitionSha256 = managedAutomationDigest(definitionValue);
      const operationId = operationIdFor(binding.id, operation);
      const existingOperation = this.getOperation(operationId);
      if (existingOperation) {
        if (existingOperation.bindingId !== binding.id ||
          existingOperation.operationClass !== operation.operationClass ||
          existingOperation.definitionRevision !== operation.definitionRevision ||
          (existingOperation.targetHostId !== null &&
            existingOperation.targetHostId !== (operation.targetHostId ?? authority.hostId)) ||
          existingOperation.intentKey !== (operation.intentKey ?? null)) {
          throw new Error("managed automation lifecycle operation identity does not match its request");
        }
        if (managedAutomationDigest(existingOperation.authority) !== managedAutomationDigest(authority) ||
          managedAutomationDigest(existingOperation.capabilityEvidence) !==
            managedAutomationDigest(authority.capabilityEvidence)) {
          throw new Error("managed automation lifecycle authority does not match its operation");
        }
        if (operation.operationClass === "update" && definitionSha256 !== binding.definitionSha256) {
          throw new Error("managed automation lifecycle retry changed its durable definition");
        }
        if (desiredState !== binding.desiredState) {
          throw new Error("managed automation lifecycle retry changed its desired state");
        }
        return this.get(binding.id)!;
      }
      if (binding.state === "retired") {
        throw new Error("retired managed automations cannot receive lifecycle operations");
      }
      if (binding.state === "retiring" && operation.operationClass !== "reconcile") {
        throw new Error("retiring managed automations cannot receive lifecycle operations");
      }
      const expectedRevision = operation.operationClass === "update"
        ? binding.definitionRevision + 1
        : binding.definitionRevision;
      if (operation.definitionRevision !== expectedRevision) {
        throw new TypeError("managed automation lifecycle revision is not the next durable revision");
      }
      const conflicting = this.db.prepare(
        `SELECT id FROM managed_automation_operations
          WHERE binding_id = ? AND state IN ('pending', 'leased') AND id <> ? LIMIT 1`,
      ).get(binding.id, operationId) as { id: string } | undefined;
      if (conflicting) throw new Error("managed automation already has a pending lifecycle operation");
      const lifecycleState = operation.operationClass === "retire"
        ? "retiring"
        : ["update", "enable", "disable"].includes(operation.operationClass)
          ? "updating"
          : binding.state;
      const updated = this.db.prepare(
        `UPDATE managed_automations
            SET name = ?, mode = ?, definition_json = ?, definition_sha256 = ?,
                definition_revision = ?, authority_json = ?, authority_version = 1,
                capability_profile_id = ?, capability_profile_revision = ?, capability_evidence_json = ?,
                desired_state = ?, state = ?, last_error = NULL,
                last_operation_id = ?, last_operation_outcome = 'pending', updated_at = ?
          WHERE id = ? AND state <> 'retired'`,
      ).run(
        definitionValue.name,
        definitionValue.mode,
        definitionJson,
        definitionSha256,
        operation.definitionRevision,
        canonical(authority),
        authority.capabilityEvidence.profileId,
        authority.capabilityEvidence.profileRevision,
        canonical(authority.capabilityEvidence),
        desiredState,
        lifecycleState,
        operationId,
        input.now,
        binding.id,
      );
      if (updated.changes !== 1) throw new Error("managed automation lifecycle intent fence was lost");
      this.insertOperation(
        binding.id,
        operation,
        authority,
        input.controllerFence ?? null,
        input.now,
        binding.providerOwnershipMarker,
      );
      return this.get(binding.id)!;
    }).immediate();
  }

  public refreshAuthority(input: Readonly<{
    id: string;
    authority: ManagedAutomationAuthority;
    now: number;
  }>): ManagedAutomationBinding {
    const authority = parseManagedAutomationAuthority(input.authority);
    if (!isCurrentManagedAutomationAuthority(authority) ||
      !Number.isSafeInteger(input.now) || input.now < 0) {
      throw new TypeError("managed automation authority refresh is invalid");
    }
    return this.db.transaction(() => {
      const binding = this.get(input.id);
      if (!binding || binding.projectId !== authority.projectId ||
        binding.controllerKey !== authority.controllerKey || binding.state === "retired") {
        throw new Error("managed automation authority refresh does not match its binding");
      }
      this.db.prepare(
        `UPDATE managed_automations
            SET authority_json = ?, authority_version = 1,
                capability_profile_id = ?, capability_profile_revision = ?,
                capability_evidence_json = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        canonical(authority),
        authority.capabilityEvidence.profileId,
        authority.capabilityEvidence.profileRevision,
        canonical(authority.capabilityEvidence),
        input.now,
        input.id,
      );
      const pendingOperations = this.db.prepare(
        `SELECT id FROM managed_automation_operations
          WHERE binding_id = ? AND state IN ('pending', 'failed', 'ambiguous')`,
      ).all(input.id) as Array<{ id: string }>;
      for (const operation of pendingOperations) {
        this.db.prepare(
          `UPDATE managed_automation_operations
              SET authority_json = ?, capability_evidence_json = ?, updated_at = ?
            WHERE id = ?`,
        ).run(canonical(authority), canonical(authority.capabilityEvidence), input.now, operation.id);
      }
      return this.get(input.id)!;
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
        (existing.targetHostId !== null && existing.targetHostId !== (request.targetHostId ?? authority.hostId)) ||
        existing.intentKey !== (request.intentKey ?? null)) {
        throw new Error("managed automation operation identity does not match its binding");
      }
      return;
    }
    if (!isCurrentManagedAutomationAuthority(binding.authority) ||
      managedAutomationDigest(binding.authority) !== managedAutomationDigest(authority) ||
      managedAutomationDigest(binding.capabilityEvidence) !== managedAutomationDigest(authority.capabilityEvidence)) {
      throw new Error("managed automation operation authority does not match its binding");
    }
    this.insertOperation(binding.id, request, authority, controllerFence, binding.updatedAt);
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
    providerOwnershipMarker?: string | null,
  ): void {
    const id = operationIdFor(bindingId, request);
    this.db.prepare(
      `INSERT INTO managed_automation_operations (
         id, binding_id, operation_class, operation_version, target_project_id, target_host_id, definition_revision,
         intent_key, authority_json, capability_evidence_json, controller_owner_id,
         controller_generation, controller_turn_id, state, attempts,
         lease_owner, lease_generation, lease_expires_at, provider_automation_id, provider_ownership_marker,
         outcome_json, last_error, next_attempt_at, created_at, updated_at, settled_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, ?, ?, NULL)`,
    ).run(
      id,
      bindingId,
      request.operationClass,
      request.version,
      request.targetProjectId,
      request.targetHostId ?? authority.hostId,
      request.definitionRevision,
      request.intentKey ?? null,
      canonical(authority),
      canonical(authority.capabilityEvidence),
      controllerFence?.ownerId ?? null,
      controllerFence?.generation ?? null,
      controllerFence?.turnId ?? null,
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
  }): ManagedAutomationBinding {
    const observation = managedAutomationObservationSchema.parse(input.automation);
    const observedJson = canonical({ version: 1, value: observation });
    const observedSha256 = managedAutomationDigest(observation);
    const result = this.db.prepare(
      `UPDATE managed_automations
          SET bb_automation_id = ?, observed_json = ?, observed_sha256 = ?,
              state = CASE WHEN ? THEN 'active' ELSE 'paused' END,
              last_reconciled_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND state IN ('pending', 'active', 'paused', 'updating', 'failed')`,
    ).run(observation.providerAutomationId, observedJson, observedSha256, observation.enabled ? 1 : 0, input.now, input.now, input.id);
    if (result.changes !== 1) throw new Error("managed automation activation fence was lost");
    return this.get(input.id)!;
  }

  public setProviderOwnershipMarker(input: {
    id: string;
    ownershipMarker: string;
    now: number;
  }): ManagedAutomationBinding {
    const ownershipMarker = providerOwnershipMarkerSchema.parse(input.ownershipMarker);
    if (ownershipMarker === null) throw new TypeError("managed automation ownership marker is required");
    const result = this.db.prepare(
      `UPDATE managed_automations
          SET provider_ownership_marker = ?, updated_at = ?
        WHERE id = ? AND (provider_ownership_marker IS NULL OR provider_ownership_marker = ?)`,
    ).run(ownershipMarker, input.now, input.id, ownershipMarker);
    if (result.changes !== 1) throw new Error("managed automation ownership marker fence was lost");
    return this.get(input.id)!;
  }

  public attachProviderAutomation(input: {
    id: string;
    providerAutomationId: string;
    ownershipMarker: string;
    now: number;
  }): ManagedAutomationBinding {
    const providerAutomationId = providerAutomationIdSchema.parse(input.providerAutomationId);
    const ownershipMarker = providerOwnershipMarkerSchema.parse(input.ownershipMarker);
    if (providerAutomationId === null || ownershipMarker === null) {
      throw new TypeError("managed automation provider acknowledgement is incomplete");
    }
    const result = this.db.prepare(
      `UPDATE managed_automations
          SET bb_automation_id = ?, provider_ownership_marker = ?, last_operation_outcome = NULL, updated_at = ?
        WHERE id = ? AND (bb_automation_id IS NULL OR bb_automation_id = ?)
          AND (provider_ownership_marker IS NULL OR provider_ownership_marker = ?)`,
    ).run(providerAutomationId, ownershipMarker, input.now, input.id, providerAutomationId, ownershipMarker);
    if (result.changes !== 1) throw new Error("managed automation provider acknowledgement fence was lost");
    return this.get(input.id)!;
  }

  public fail(id: string, errorClass: string, now: number): ManagedAutomationBinding {
    const result = this.db.prepare(
      `UPDATE managed_automations SET state = 'failed', last_error = ?, updated_at = ?
        WHERE id = ? AND state NOT IN ('updating', 'retiring', 'retired')`,
    ).run(errorClass.slice(0, 256), now, id);
    if (result.changes !== 1) throw new Error("managed automation failure fence was lost");
    return this.get(id)!;
  }

  public beginUpdate(input: {
    id: string;
    definition: ManagedAutomationDefinition;
    now: number;
  }): ManagedAutomationBinding {
    const definition = managedAutomationDefinitionSchema.parse(input.definition);
    const existing = this.get(input.id);
    if (!existing || existing.bbAutomationId === null || existing.projectId !== definition.projectId) {
      throw new Error("managed automation update identity is invalid");
    }
    const result = this.db.prepare(
      `UPDATE managed_automations
          SET name = ?, mode = ?, definition_json = ?, definition_sha256 = ?,
              state = 'updating', last_error = NULL, updated_at = ?
        WHERE id = ? AND state IN ('active', 'paused', 'failed')`,
    ).run(
      definition.name,
      definition.mode,
      canonical({ version: 1, value: definition }),
      managedAutomationDigest(definition),
      input.now,
      input.id,
    );
    if (result.changes !== 1) throw new Error("managed automation update intent fence was lost");
    return this.get(input.id)!;
  }

  public markPolicyBlocked(id: string, now: number): ManagedAutomationBinding {
    const result = this.db.prepare(
      `UPDATE managed_automations
          SET state = 'paused', last_error = 'managed_automation_authority_stale',
              last_reconciled_at = ?, updated_at = ?
        WHERE id = ? AND state IN ('active', 'paused', 'updating', 'failed')`,
    ).run(now, now, id);
    if (result.changes !== 1) throw new Error("managed automation policy block fence was lost");
    return this.get(id)!;
  }

  public markExecutionContractBlocked(id: string, now: number): ManagedAutomationBinding {
    const result = this.db.prepare(
      `UPDATE managed_automations
          SET state = 'paused', last_error = 'bb_agent_execution_contract_unsupported',
              last_reconciled_at = ?, updated_at = ?
        WHERE id = ? AND state IN ('active', 'paused', 'updating', 'failed')`,
    ).run(now, now, id);
    if (result.changes !== 1) throw new Error("managed automation execution contract block fence was lost");
    return this.get(id)!;
  }

  public beginRetirement(id: string, now: number): ManagedAutomationBinding {
    const result = this.db.prepare(
      `UPDATE managed_automations
          SET desired_state = 'retired', state = 'retiring', last_error = NULL, updated_at = ?
        WHERE id = ? AND state IN ('active', 'paused', 'failed')`,
    ).run(now, id);
    if (result.changes !== 1) throw new Error("managed automation retirement intent fence was lost");
    return this.get(id)!;
  }

  public retire(id: string, now: number): ManagedAutomationBinding {
    const existing = this.get(id);
    if (existing?.state === "retired") return existing;
    const result = this.db.prepare(
      `UPDATE managed_automations SET desired_state = 'retired', state = 'retired', updated_at = ?
        WHERE id = ? AND state = 'retiring'`,
    ).run(now, id);
    if (result.changes !== 1) throw new Error("managed automation retirement fence was lost");
    return this.get(id)!;
  }

  public recordRun(bindingId: string, run: ManagedAutomationRun, now: number): boolean {
    return this.db.transaction(() => {
      const binding = this.get(bindingId);
      if (!binding || binding.bbAutomationId !== run.automationId || ["retiring", "retired"].includes(binding.state)) {
        throw new Error("managed automation run does not match its active binding");
      }
      return this.recordRunInTransaction(binding, run, now);
    }).immediate();
  }

  private recordRunInTransaction(
    binding: ManagedAutomationBinding,
    run: ManagedAutomationRun,
    now: number,
    initiatingOperationId?: string,
  ): boolean {
    if (binding.bbAutomationId !== run.automationId || ["retiring", "retired"].includes(binding.state)) {
      throw new Error("managed automation run does not match its active binding");
    }
    if (initiatingOperationId && run.idempotencyKey !== initiatingOperationId) {
      throw new TypeError("managed automation run idempotency does not match its operation");
    }
    const outputSha256 = run.output === null ? null : managedAutomationDigest(run.output);
    const contract = managedAutomationRunContract(binding, run);
    const errorClass = contract.errorClass ?? (run.error === null ? null : "bb_automation_run_failed");
    const receipt = initiatingOperationId && isCurrentManagedAutomationAuthority(binding.authority) && binding.capabilityEvidence
      ? managedAutomationRunReceipt(binding, initiatingOperationId, binding.authority, binding.capabilityEvidence, run, now)
      : null;
    if (!initiatingOperationId && hasRetryableRunNowOperation(this.db, binding.id, run.idempotencyKey)) return false;
    const evidenceJson = canonical({
      automationId: run.automationId,
      contractOutcome: contract.outcome,
      errorClass,
      exitCode: run.exitCode,
      finishedAt: run.finishedAt,
      id: run.id,
      output: outputSha256 === null ? null : { screened: true, sha256: outputSha256 },
      receipt,
      runMode: run.runMode,
      scheduledFor: run.scheduledFor,
      skipReason: run.skipReason,
      startedAt: run.startedAt,
      status: run.status,
      threadId: run.threadId,
      trigger: run.trigger,
      ...(receipt
        ? {
            authority: receipt.authority,
            capabilityEvidence: receipt.capabilityEvidence,
            definitionRevision: receipt.definitionRevision,
            initiatingOperationId: receipt.initiatingOperationId,
          }
        : {}),
    });
    const existing = existingRunEvidence(this.db, run);
    if (existing) {
      assertRunEvidenceFacts(existing, { binding, run, outputSha256, errorClass });
      assertExistingRunProvenance(existing, receipt);
      return false;
    }
    this.db.prepare(
      `INSERT INTO managed_automation_run_evidence (
         binding_id, bb_run_id, bb_automation_id, status, run_mode, trigger_kind,
         thread_id, output_sha256, error_class, scheduled_for, started_at,
         finished_at, observed_at, evidence_json, receipt_version,
         initiating_operation_id, definition_revision, authority_json,
         capability_evidence_json, idempotency_key, outcome_class
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      receipt?.version ?? null,
      receipt?.initiatingOperationId ?? null,
      receipt?.definitionRevision ?? null,
      receipt ? canonical(receipt.authority) : null,
      receipt ? canonical(receipt.capabilityEvidence) : null,
      run.idempotencyKey ?? null,
      receipt?.outcomeClass ?? null,
    );
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

function managedAutomationRunReceipt(
  binding: ManagedAutomationBinding,
  initiatingOperationId: string,
  authority: ManagedAutomationAuthority,
  capabilityEvidence: ManagedAutomationCapabilityEvidence,
  run: ManagedAutomationRun,
  observedAt: number,
): ManagedAutomationRunReceipt {
  const contract = managedAutomationRunContract(binding, run);
  const outcomeClass: ManagedAutomationRunOutcomeClass = contract.outcome === "violated"
    ? "contract_violated"
    : run.status;
  return managedAutomationRunReceiptSchema.parse({
    version: 1,
    kind: "run-receipt",
    providerRunId: run.id,
    automationBindingId: binding.id,
    providerAutomationId: run.automationId,
    definitionRevision: binding.definitionRevision,
    initiatingOperationId,
    authority,
    capabilityEvidence,
    scheduledFor: run.scheduledFor,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    observedAt,
    outcomeClass,
  });
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
