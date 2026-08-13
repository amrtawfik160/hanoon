import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CAPABILITY_KINDS,
  CAPABILITY_TERMINAL_OUTCOMES,
  type CapabilityKind,
  type CapabilityTerminalOutcome,
} from "../capabilities/contracts";
import type {
  GuardFingerprintPersistenceInput,
  GuardSettlementPersistenceInput,
  GuardSettlementPersistenceResult,
} from "../capabilities/guards";
import type { CapabilityInventoryItem, InventoryHealth } from "../capabilities/inventory";
import {
  modelRouteSchema,
  type ModelRoute,
} from "../capabilities/models";
import type {
  AppendRecipeRolloutDecisionInput,
  RecipeRolloutDecision,
} from "../capabilities/promotion";
import { TASK_RECIPES, type TaskRecipe } from "../domain/recipes";
import { readDurablePromotionEvidenceSnapshot } from "./promotion-evidence-snapshot";

type SqliteDatabase = Database.Database;

const MAX_ASSIGNMENTS = 64;
const MAX_PROJECTION_ITEMS = 64;
const boundedIdSchema = z.string().min(1).max(256);
const capabilityIdSchema = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u);
const boundedKeySchema = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const nonNegativeIntegerSchema = z.number().int().nonnegative().safe();
const positiveIntegerSchema = z.number().int().positive().safe();
const evidenceRefSchema = z.string().min(1).max(512);

const modelSelectionSchema = modelRouteSchema;

const assignmentInputSchema = z.object({
  capabilityId: capabilityIdSchema,
  descriptorDigest: sha256Schema,
  capabilityKind: z.enum(CAPABILITY_KINDS),
  mandatory: z.boolean(),
}).strict();

const createProfileSchema = z.object({
  subjectKind: z.enum(["controller_turn", "worker_attempt"]),
  subjectId: boundedIdSchema,
  threadId: boundedIdSchema.nullable().optional(),
  recipeId: capabilityIdSchema,
  recipeVersion: positiveIntegerSchema,
  registryDigest: sha256Schema,
  graphDigest: sha256Schema,
  mode: z.enum(["active", "shadow"]),
  model: modelSelectionSchema,
  assignments: z.array(assignmentInputSchema).max(MAX_ASSIGNMENTS),
  reasonCodes: z.array(boundedKeySchema).max(MAX_PROJECTION_ITEMS),
  traits: z.array(boundedKeySchema).max(MAX_PROJECTION_ITEMS),
  expectedRevision: positiveIntegerSchema.optional(),
  now: nonNegativeIntegerSchema,
}).strict();

const appendTerminalSchema = z.object({
  profileId: boundedIdSchema,
  capabilityId: capabilityIdSchema,
  descriptorDigest: sha256Schema.optional(),
  outcome: z.enum(CAPABILITY_TERMINAL_OUTCOMES),
  evidenceRefs: z.array(evidenceRefSchema).min(1).max(MAX_PROJECTION_ITEMS),
  reasonCode: boundedKeySchema.optional(),
  now: nonNegativeIntegerSchema,
}).strict();

const appendReceiptSchema = z.object({
  profileId: boundedIdSchema,
  capabilityId: capabilityIdSchema,
  capabilityKind: z.enum(CAPABILITY_KINDS),
  descriptorDigest: sha256Schema,
  eventType: z.enum(["requested", "denied"]),
  reasonCode: boundedKeySchema,
  mandatory: z.boolean(),
  evidenceRefs: z.array(evidenceRefSchema).max(MAX_PROJECTION_ITEMS).default([]),
  now: nonNegativeIntegerSchema,
}).strict();

const guardFingerprintInputSchema = z.object({
  profileId: boundedIdSchema,
  scopeId: boundedIdSchema,
  fingerprint: sha256Schema,
  capabilityId: capabilityIdSchema,
  ruleId: boundedKeySchema,
  subjectIdentity: z.string().min(1).max(512),
  requirementClass: boundedKeySchema,
  now: nonNegativeIntegerSchema,
}).strict();

const guardSettlementInputSchema = z.object({
  profileId: boundedIdSchema,
  profileRevision: positiveIntegerSchema,
  scopeId: boundedIdSchema,
  outcomes: z.array(z.object({
    capabilityId: capabilityIdSchema,
    descriptorDigest: sha256Schema,
    outcome: z.enum(CAPABILITY_TERMINAL_OUTCOMES),
    evidenceRefs: z.array(evidenceRefSchema).min(1).max(MAX_PROJECTION_ITEMS),
  }).strict()).min(1).max(16),
  fingerprints: z.array(guardFingerprintInputSchema).max(100),
  now: nonNegativeIntegerSchema,
}).strict();

const modelRouteSelectionInputSchema = z.object({
  subjectKind: z.enum(["controller_turn", "worker_attempt"]),
  subjectId: boundedIdSchema,
  attempt: positiveIntegerSchema,
  stage: boundedKeySchema,
  operation: boundedKeySchema,
  route: modelRouteSchema,
  now: nonNegativeIntegerSchema,
}).strict();

const settleModelRouteTrialInputSchema = z.object({
  subjectKind: z.enum(["controller_turn", "worker_attempt"]),
  subjectId: boundedIdSchema,
  attempt: positiveIntegerSchema,
  outcome: z.enum(["passed", "failed", "blocked"]),
  failureSignature: sha256Schema.nullable(),
  now: nonNegativeIntegerSchema,
}).strict().superRefine((value, context) => {
  if (value.outcome === "passed" && value.failureSignature !== null) {
    context.addIssue({ code: "custom", message: "A passed model trial cannot contain a failure signature" });
  }
  if (value.outcome !== "passed" && value.failureSignature === null) {
    context.addIssue({ code: "custom", message: "A failed or blocked model trial requires a failure signature" });
  }
});

const inventoryMetadataSchema = z.record(
  z.string().min(1).max(128),
  z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]),
);
const inventoryItemSchema = z.object({
  inventoryKey: z.string().startsWith("inventory:").max(128),
  capabilityId: capabilityIdSchema,
  capabilityKind: z.enum(CAPABILITY_KINDS),
  source: z.string().min(1).max(512),
  version: z.string().min(1).max(128).nullable(),
  digest: sha256Schema.nullable(),
  hostScope: boundedIdSchema,
  status: z.literal("inventory-only"),
  metadata: inventoryMetadataSchema,
  discoveredAt: nonNegativeIntegerSchema,
}).strict();
const replaceInventorySchema = z.object({
  hostScope: boundedIdSchema,
  items: z.array(inventoryItemSchema).max(512),
  now: nonNegativeIntegerSchema,
}).strict();
const inventoryFailureSchema = z.object({
  hostScope: boundedIdSchema,
  errorClass: boundedKeySchema,
  now: nonNegativeIntegerSchema,
}).strict();
const appendRecipeRolloutDecisionSchema = z.object({
  recipe: z.enum(TASK_RECIPES),
  action: z.enum(["promote", "rollback"]),
  reasonCode: boundedKeySchema,
  evidenceDigest: sha256Schema.nullable(),
  now: nonNegativeIntegerSchema,
}).strict().superRefine((value, context) => {
  if (value.action === "promote") {
    if (value.reasonCode !== "promotion_gates_passed") {
      context.addIssue({ code: "custom", message: "Promotion requires the passed-gates reason" });
    }
    if (value.evidenceDigest === null) {
      context.addIssue({ code: "custom", message: "Promotion requires an evidence digest" });
    }
  } else if (value.evidenceDigest !== null) {
    context.addIssue({ code: "custom", message: "Rollback cannot claim promotion evidence" });
  }
});

export type CapabilitySubjectKind = "controller_turn" | "worker_attempt";
export type CapabilityProfileMode = "active" | "shadow";
export type CapabilityModelSelection = z.infer<typeof modelSelectionSchema>;
export type CapabilityAssignmentInput = z.infer<typeof assignmentInputSchema>;
export type CreateCapabilityProfileInput = z.input<typeof createProfileSchema>;
export type AppendCapabilityTerminalInput = z.input<typeof appendTerminalSchema>;
export type AppendCapabilityReceiptInput = z.input<typeof appendReceiptSchema>;
export type RecordModelRouteSelectionInput = z.input<typeof modelRouteSelectionInputSchema>;
export type SettleModelRouteTrialInput = z.input<typeof settleModelRouteTrialInputSchema>;

export type CapabilityAssignment = Readonly<{
  capabilityId: string;
  capabilityKind: CapabilityKind;
  descriptorDigest: string;
  mandatory: boolean;
}>;

export type CapabilityProfile = Readonly<{
  id: string;
  subjectKind: CapabilitySubjectKind;
  subjectId: string;
  threadId: string | null;
  revision: number;
  recipeId: string;
  recipeVersion: number;
  registryDigest: string;
  graphDigest: string;
  mode: CapabilityProfileMode;
  model: CapabilityModelSelection;
  reasonCodes: readonly string[];
  traits: readonly string[];
  assignments: readonly CapabilityAssignment[];
  createdAt: number;
}>;

export type CapabilityReceiptEvent = "requested" | "selected" | "denied" | "outcome";
export type CapabilityReceipt = Readonly<{
  id: string;
  profileId: string;
  profileRevision: number;
  subjectKind: CapabilitySubjectKind;
  subjectId: string;
  capabilityId: string;
  capabilityKind: CapabilityKind;
  descriptorDigest: string;
  eventType: CapabilityReceiptEvent;
  reasonCode: string;
  mandatory: boolean;
  outcome: CapabilityTerminalOutcome | null;
  evidenceRefs: readonly string[];
  createdAt: number;
}>;

export type SkillReceiptProjection = Readonly<{
  profileId: string;
  subjectKind: CapabilitySubjectKind;
  subjectId: string;
  profileRevision: number;
  capabilityId: string;
  descriptorDigest: string;
  mandatory: boolean;
  outcome: CapabilityTerminalOutcome | null;
  evidenceRefs: readonly string[];
  outcomeAt: number | null;
}>;

export type ModelRouteTrial = Readonly<{
  id: string;
  subjectKind: CapabilitySubjectKind;
  subjectId: string;
  attempt: number;
  stage: string;
  operation: string;
  route: ModelRoute;
  failureSignature: string | null;
  outcome: "selected" | "passed" | "failed" | "blocked";
  createdAt: number;
  settledAt: number | null;
}>;

type ProfileRow = {
  id: string;
  subject_kind: CapabilitySubjectKind;
  subject_id: string;
  thread_id: string | null;
  revision: number;
  recipe_id: string;
  recipe_version: number;
  registry_digest: string;
  graph_digest: string;
  mode: CapabilityProfileMode;
  model_pool: CapabilityModelSelection["pool"];
  model_provider_id: string;
  model_id: string;
  model_reasoning: CapabilityModelSelection["reasoning"];
  model_service_tier: CapabilityModelSelection["serviceTier"];
  reason_codes_json: string;
  traits_json: string;
  created_at: number;
};

type AssignmentRow = {
  capability_id: string;
  capability_kind: CapabilityKind;
  descriptor_digest: string;
  mandatory: number;
};

type ReceiptRow = {
  id: string;
  profile_id: string;
  profile_revision: number;
  subject_kind: CapabilitySubjectKind;
  subject_id: string;
  capability_id: string;
  capability_kind: CapabilityKind;
  descriptor_digest: string;
  event_type: CapabilityReceiptEvent;
  reason_code: string;
  mandatory: number;
  outcome: CapabilityTerminalOutcome | null;
  evidence_refs_json: string;
  created_at: number;
};

type SkillReceiptRow = {
  profile_id: string;
  subject_kind: CapabilitySubjectKind;
  subject_id: string;
  profile_revision: number;
  capability_id: string;
  descriptor_digest: string;
  mandatory: number;
  outcome: CapabilityTerminalOutcome | null;
  evidence_refs_json: string | null;
  outcome_at: number | null;
};

type GuardFingerprintRow = {
  profile_id: string;
  scope_id: string;
  capability_id: string;
  rule_id: string;
  subject_identity: string;
  requirement_class: string;
  occurrences: number;
  first_seen_at: number;
  last_seen_at: number;
};

type ModelRouteTrialRow = {
  id: string;
  subject_kind: CapabilitySubjectKind;
  subject_id: string;
  attempt: number;
  pool: ModelRoute["pool"];
  provider_id: string;
  model_id: string;
  reasoning: ModelRoute["reasoning"];
  service_tier: ModelRoute["serviceTier"];
  stage: string;
  operation: string;
  failure_signature: string | null;
  outcome: ModelRouteTrial["outcome"];
  created_at: number;
  settled_at: number | null;
};

type InventoryRow = {
  inventory_key: string;
  capability_id: string;
  capability_kind: CapabilityKind;
  source: string;
  version: string | null;
  digest: string | null;
  host_scope: string;
  status: "inventory-only";
  metadata_json: string;
  discovered_at: number;
};

type InventoryHealthRow = {
  host_scope: string;
  status: InventoryHealth["status"];
  error_class: string | null;
  refreshed_at: number;
};

type RecipeRolloutDecisionRow = {
  id: string;
  subject_id: string;
  from_recipe: TaskRecipe;
  to_recipe: TaskRecipe;
  reason_code: string;
  created_at: number;
};

export class CapabilityRevisionConflictError extends Error {
  public constructor(subjectKind: CapabilitySubjectKind, subjectId: string, expected: number, actual: number) {
    super(`Capability profile revision conflict for ${subjectKind}/${subjectId}: expected ${expected}, next is ${actual}`);
    this.name = "CapabilityRevisionConflictError";
  }
}

export class CapabilityTerminalConflictError extends Error {
  public constructor(profileId: string, capabilityId: string) {
    super(`Capability terminal outcome already exists for ${profileId}/${capabilityId}`);
    this.name = "CapabilityTerminalConflictError";
  }
}

function sortedUnique(values: readonly string[], field: string): string[] {
  const result = [...new Set(values)].sort((left, right) => left.localeCompare(right));
  if (result.length > MAX_PROJECTION_ITEMS) throw new TypeError(`${field} exceeds its bounded limit`);
  return result;
}

function parseStringArray(value: string | null, field: string): string[] {
  if (value === null) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`Persisted ${field} is invalid`);
  }
  return parsed;
}

function boundedLimit(requested: number): number {
  const parsed = positiveIntegerSchema.parse(requested);
  return Math.min(parsed, 256);
}

function parseAssignment(row: AssignmentRow): CapabilityAssignment {
  return {
    capabilityId: row.capability_id,
    capabilityKind: row.capability_kind,
    descriptorDigest: row.descriptor_digest,
    mandatory: row.mandatory === 1,
  };
}

function parseReceipt(row: ReceiptRow): CapabilityReceipt {
  return {
    id: row.id,
    profileId: row.profile_id,
    profileRevision: row.profile_revision,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    capabilityId: row.capability_id,
    capabilityKind: row.capability_kind,
    descriptorDigest: row.descriptor_digest,
    eventType: row.event_type,
    reasonCode: row.reason_code,
    mandatory: row.mandatory === 1,
    outcome: row.outcome,
    evidenceRefs: parseStringArray(row.evidence_refs_json, "receipt evidence"),
    createdAt: row.created_at,
  };
}

function parseRecipeRolloutDecision(row: RecipeRolloutDecisionRow): RecipeRolloutDecision {
  const recipe = z.enum(TASK_RECIPES).parse(row.to_recipe);
  if (row.from_recipe !== recipe) throw new TypeError("Persisted rollout decision changes recipe identity");
  const prefix = `rollout:${recipe}:`;
  if (!row.subject_id.startsWith(prefix)) throw new TypeError("Persisted rollout subject identity is invalid");
  const suffix = row.subject_id.slice(prefix.length);
  if (suffix.startsWith("promote:")) {
    const [evidenceDigestValue, decisionToken, ...extra] = suffix.slice("promote:".length).split(":");
    if (extra.length > 0 || decisionToken === undefined) {
      throw new TypeError("Persisted promotion subject identity is invalid");
    }
    const evidenceDigest = sha256Schema.parse(evidenceDigestValue);
    boundedIdSchema.parse(decisionToken);
    if (row.reason_code !== "promotion_gates_passed") {
      throw new TypeError("Persisted promotion reason is invalid");
    }
    return {
      id: row.id,
      recipe,
      action: "promote",
      reasonCode: row.reason_code,
      evidenceDigest,
      createdAt: row.created_at,
    };
  }
  if (!suffix.startsWith("rollback:")) throw new TypeError("Persisted rollout action is invalid");
  boundedIdSchema.parse(suffix.slice("rollback:".length));
  return {
    id: row.id,
    recipe,
    action: "rollback",
    reasonCode: boundedKeySchema.parse(row.reason_code),
    evidenceDigest: null,
    createdAt: row.created_at,
  };
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/u.test(error.message);
}

export class CapabilityRepository {
  public constructor(private readonly db: SqliteDatabase) {}

  public createProfile(rawInput: CreateCapabilityProfileInput): CapabilityProfile {
    const parsed = createProfileSchema.parse(rawInput);
    const reasonCodes = sortedUnique(parsed.reasonCodes, "reasonCodes");
    const traits = sortedUnique(parsed.traits, "traits");
    const assignments = [...parsed.assignments]
      .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
    if (new Set(assignments.map((assignment) => assignment.capabilityId)).size !== assignments.length) {
      throw new TypeError("Capability profile assignments contain a duplicate capability id");
    }

    const create = this.db.transaction((): string => {
      const current = this.db.prepare(
        `SELECT max(revision) AS revision FROM capability_profiles
          WHERE subject_kind = ? AND subject_id = ?`,
      ).get(parsed.subjectKind, parsed.subjectId) as { revision: number | null };
      const nextRevision = (current.revision ?? 0) + 1;
      if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== nextRevision) {
        throw new CapabilityRevisionConflictError(
          parsed.subjectKind,
          parsed.subjectId,
          parsed.expectedRevision,
          nextRevision,
        );
      }
      const profileId = `cap_profile:${randomUUID()}`;
      this.db.prepare(
        `INSERT INTO capability_profiles (
           id, subject_kind, subject_id, thread_id, revision, recipe_id, recipe_version,
           registry_digest, graph_digest, mode, model_pool, model_provider_id, model_id,
           model_reasoning, model_service_tier, reason_codes_json, traits_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        profileId,
        parsed.subjectKind,
        parsed.subjectId,
        parsed.threadId ?? null,
        nextRevision,
        parsed.recipeId,
        parsed.recipeVersion,
        parsed.registryDigest,
        parsed.graphDigest,
        parsed.mode,
        parsed.model.pool,
        parsed.model.providerId,
        parsed.model.modelId,
        parsed.model.reasoning,
        parsed.model.serviceTier,
        JSON.stringify(reasonCodes),
        JSON.stringify(traits),
        parsed.now,
      );
      const insertAssignment = this.db.prepare(
        `INSERT INTO capability_profile_assignments (
           profile_id, capability_id, capability_kind, descriptor_digest, mandatory
         ) VALUES (?, ?, ?, ?, ?)`,
      );
      const insertReceipt = this.db.prepare(
        `INSERT INTO capability_receipts (
           id, profile_id, profile_revision, subject_kind, subject_id, capability_id,
           capability_kind, descriptor_digest, event_type, reason_code, mandatory,
           outcome, evidence_refs_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'selected', 'profile_selected', ?, NULL, '[]', ?)`,
      );
      for (const assignment of assignments) {
        insertAssignment.run(
          profileId,
          assignment.capabilityId,
          assignment.capabilityKind,
          assignment.descriptorDigest,
          assignment.mandatory ? 1 : 0,
        );
        insertReceipt.run(
          `cap_receipt:${randomUUID()}`,
          profileId,
          nextRevision,
          parsed.subjectKind,
          parsed.subjectId,
          assignment.capabilityId,
          assignment.capabilityKind,
          assignment.descriptorDigest,
          assignment.mandatory ? 1 : 0,
          parsed.now,
        );
      }
      return profileId;
    });

    try {
      const profileId = create.immediate();
      const profile = this.getProfileById(profileId);
      if (!profile) throw new Error(`Capability profile ${profileId} disappeared after creation`);
      return profile;
    } catch (error) {
      if (isUniqueConstraint(error)) {
        const next = this.nextRevision(parsed.subjectKind, parsed.subjectId);
        throw new CapabilityRevisionConflictError(
          parsed.subjectKind,
          parsed.subjectId,
          parsed.expectedRevision ?? next,
          next,
        );
      }
      throw error;
    }
  }

  public appendReceipt(rawInput: AppendCapabilityReceiptInput): CapabilityReceipt {
    const input = appendReceiptSchema.parse(rawInput);
    const profile = this.requireProfileRow(input.profileId);
    const receiptId = `cap_receipt:${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO capability_receipts (
         id, profile_id, profile_revision, subject_kind, subject_id, capability_id,
         capability_kind, descriptor_digest, event_type, reason_code, mandatory,
         outcome, evidence_refs_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      receiptId,
      profile.id,
      profile.revision,
      profile.subject_kind,
      profile.subject_id,
      input.capabilityId,
      input.capabilityKind,
      input.descriptorDigest,
      input.eventType,
      input.reasonCode,
      input.mandatory ? 1 : 0,
      JSON.stringify(sortedUnique(input.evidenceRefs, "evidenceRefs")),
      input.now,
    );
    return this.requireReceipt(receiptId);
  }

  public appendTerminalOutcome(rawInput: AppendCapabilityTerminalInput): boolean {
    const input = appendTerminalSchema.parse(rawInput);
    const profile = this.requireProfileRow(input.profileId);
    const assignment = this.db.prepare(
      `SELECT capability_id, capability_kind, descriptor_digest, mandatory
         FROM capability_profile_assignments
        WHERE profile_id = ? AND capability_id = ?`,
    ).get(input.profileId, input.capabilityId) as AssignmentRow | undefined;
    if (!assignment) {
      throw new TypeError(`Capability ${input.capabilityId} is not selected in profile ${input.profileId}`);
    }
    if (input.descriptorDigest !== undefined && input.descriptorDigest !== assignment.descriptor_digest) {
      throw new TypeError(`Capability ${input.capabilityId} descriptor digest does not match its selected assignment`);
    }
    const prior = this.db.prepare(
      `SELECT 1 FROM capability_receipts
        WHERE profile_id = ? AND capability_id = ? AND event_type = 'outcome'`,
    ).get(input.profileId, input.capabilityId);
    if (prior) throw new CapabilityTerminalConflictError(input.profileId, input.capabilityId);
    try {
      this.db.prepare(
        `INSERT INTO capability_receipts (
           id, profile_id, profile_revision, subject_kind, subject_id, capability_id,
           capability_kind, descriptor_digest, event_type, reason_code, mandatory,
           outcome, evidence_refs_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'outcome', ?, ?, ?, ?, ?)`,
      ).run(
        `cap_receipt:${randomUUID()}`,
        profile.id,
        profile.revision,
        profile.subject_kind,
        profile.subject_id,
        assignment.capability_id,
        assignment.capability_kind,
        assignment.descriptor_digest,
        input.reasonCode ?? "terminal_outcome",
        assignment.mandatory,
        input.outcome,
        JSON.stringify(sortedUnique(input.evidenceRefs, "evidenceRefs")),
        input.now,
      );
      return true;
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new CapabilityTerminalConflictError(input.profileId, input.capabilityId);
      }
      throw error;
    }
  }

  public recordGuardFingerprint(rawInput: GuardFingerprintPersistenceInput): number {
    const input = guardFingerprintInputSchema.parse(rawInput);
    const record = this.db.transaction((): number => {
      this.requireProfileRow(input.profileId);
      const selected = this.db.prepare(
        `SELECT 1 FROM capability_profile_assignments
          WHERE profile_id = ? AND capability_id = ?`,
      ).get(input.profileId, input.capabilityId);
      if (!selected) {
        throw new TypeError(`Guard capability ${input.capabilityId} is not selected in profile ${input.profileId}`);
      }
      return this.recordGuardFingerprintInTransaction(input);
    });
    return record.immediate();
  }

  public settleGuardOutcomes(rawInput: GuardSettlementPersistenceInput): GuardSettlementPersistenceResult {
    const input = guardSettlementInputSchema.parse(rawInput);
    if (new Set(input.outcomes.map((outcome) => outcome.capabilityId)).size !== input.outcomes.length) {
      throw new TypeError("Guard settlement contains a duplicate capability outcome");
    }
    if (new Set(input.fingerprints.map((entry) => entry.fingerprint)).size !== input.fingerprints.length) {
      throw new TypeError("Guard settlement contains a duplicate fingerprint");
    }
    if (input.fingerprints.some((entry) =>
      entry.profileId !== input.profileId || entry.scopeId !== input.scopeId || entry.now !== input.now)) {
      throw new TypeError("Guard settlement fingerprint identity does not match its envelope");
    }
    const settle = this.db.transaction((): GuardSettlementPersistenceResult => {
      const profile = this.requireProfileRow(input.profileId);
      if (profile.revision !== input.profileRevision) {
        throw new TypeError("Guard settlement profile revision changed");
      }
      const assignments = new Map((this.db.prepare(
        `SELECT capability_id, capability_kind, descriptor_digest, mandatory
           FROM capability_profile_assignments WHERE profile_id = ?`,
      ).all(input.profileId) as AssignmentRow[]).map((assignment) => [assignment.capability_id, assignment]));
      for (const outcome of input.outcomes) {
        const assignment = assignments.get(outcome.capabilityId);
        if (!assignment || assignment.descriptor_digest !== outcome.descriptorDigest) {
          throw new TypeError(`Guard settlement capability ${outcome.capabilityId} is not an exact selected assignment`);
        }
      }

      const existing = this.db.prepare(
        `SELECT id, profile_id, profile_revision, subject_kind, subject_id, capability_id,
                capability_kind, descriptor_digest, event_type, reason_code, mandatory,
                outcome, evidence_refs_json, created_at
           FROM capability_receipts
          WHERE profile_id = ? AND event_type = 'outcome'`,
      ).all(input.profileId) as ReceiptRow[];
      const existingByCapability = new Map(existing.map((receipt) => [receipt.capability_id, receipt]));
      const existingForSettlement = input.outcomes.filter((outcome) => existingByCapability.has(outcome.capabilityId));
      if (existingForSettlement.length !== 0 && existingForSettlement.length !== input.outcomes.length) {
        throw new TypeError("Guard settlement is partially persisted");
      }
      const replay = existingForSettlement.length === input.outcomes.length;
      if (replay) {
        for (const outcome of input.outcomes) {
          const receipt = existingByCapability.get(outcome.capabilityId);
          const evidenceRefs = sortedUnique(outcome.evidenceRefs, "guard evidenceRefs");
          if (!receipt || receipt.descriptor_digest !== outcome.descriptorDigest || receipt.outcome !== outcome.outcome ||
            receipt.evidence_refs_json !== JSON.stringify(evidenceRefs)) {
            throw new TypeError(`Guard settlement replay changed for ${outcome.capabilityId}`);
          }
        }
      } else {
        const insert = this.db.prepare(
          `INSERT INTO capability_receipts (
             id, profile_id, profile_revision, subject_kind, subject_id, capability_id,
             capability_kind, descriptor_digest, event_type, reason_code, mandatory,
             outcome, evidence_refs_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'outcome', ?, ?, ?, ?, ?)`,
        );
        for (const outcome of input.outcomes) {
          const assignment = assignments.get(outcome.capabilityId);
          if (!assignment) throw new Error("Guard assignment disappeared during settlement");
          insert.run(
            `cap_receipt:${randomUUID()}`,
            profile.id,
            profile.revision,
            profile.subject_kind,
            profile.subject_id,
            outcome.capabilityId,
            assignment.capability_kind,
            assignment.descriptor_digest,
            `guard_result_${outcome.outcome}`,
            assignment.mandatory,
            outcome.outcome,
            JSON.stringify(sortedUnique(outcome.evidenceRefs, "guard evidenceRefs")),
            input.now,
          );
        }
      }

      const fingerprints = input.fingerprints.map((fingerprint) => ({
        fingerprint: fingerprint.fingerprint,
        occurrence: replay
          ? this.requireGuardFingerprintOccurrence(fingerprint.scopeId, fingerprint.fingerprint)
          : this.recordGuardFingerprintInTransaction(fingerprint),
      }));
      return { fingerprints };
    });
    return settle.immediate();
  }

  public getActiveProfile(subjectKind: CapabilitySubjectKind, subjectId: string): CapabilityProfile | null {
    const parsedKind = z.enum(["controller_turn", "worker_attempt"]).parse(subjectKind);
    const parsedId = boundedIdSchema.parse(subjectId);
    const row = this.db.prepare(
      `SELECT * FROM capability_profiles
        WHERE subject_kind = ? AND subject_id = ? AND mode = 'active'
        ORDER BY revision DESC LIMIT 1`,
    ).get(parsedKind, parsedId) as ProfileRow | undefined;
    return row ? this.parseProfile(row) : null;
  }

  public getLatestProfile(subjectKind: CapabilitySubjectKind, subjectId: string): CapabilityProfile | null {
    const parsedKind = z.enum(["controller_turn", "worker_attempt"]).parse(subjectKind);
    const parsedId = boundedIdSchema.parse(subjectId);
    const row = this.db.prepare(
      `SELECT * FROM capability_profiles
        WHERE subject_kind = ? AND subject_id = ? ORDER BY revision DESC LIMIT 1`,
    ).get(parsedKind, parsedId) as ProfileRow | undefined;
    return row ? this.parseProfile(row) : null;
  }

  public listMissingMandatoryOutcomes(profileId: string): string[] {
    const parsedId = boundedIdSchema.parse(profileId);
    const rows = this.db.prepare(
      `SELECT assignment.capability_id
         FROM capability_profile_assignments AS assignment
         LEFT JOIN capability_receipts AS receipt
           ON receipt.profile_id = assignment.profile_id
          AND receipt.capability_id = assignment.capability_id
          AND receipt.event_type = 'outcome'
        WHERE assignment.profile_id = ? AND assignment.mandatory = 1
          AND receipt.id IS NULL
        ORDER BY assignment.capability_id ASC
        LIMIT 65`,
    ).all(parsedId) as Array<{ capability_id: string }>;
    if (rows.length > 64) throw new Error(`Capability profile ${parsedId} exceeds the mandatory outcome bound`);
    return rows.map((row) => row.capability_id);
  }

  public getProfileForThread(threadId: string): CapabilityProfile | null {
    const parsedId = boundedIdSchema.parse(threadId);
    const row = this.db.prepare(
      `SELECT * FROM capability_profiles
        WHERE thread_id = ? ORDER BY revision DESC LIMIT 1`,
    ).get(parsedId) as ProfileRow | undefined;
    return row ? this.parseProfile(row) : null;
  }

  public getProfileById(profileId: string): CapabilityProfile | null {
    const parsedId = boundedIdSchema.parse(profileId);
    const row = this.db.prepare("SELECT * FROM capability_profiles WHERE id = ?")
      .get(parsedId) as ProfileRow | undefined;
    return row ? this.parseProfile(row) : null;
  }

  public listReceipts(profileId: string, requestedLimit: number): CapabilityReceipt[] {
    const parsedId = boundedIdSchema.parse(profileId);
    const limit = boundedLimit(requestedLimit);
    const rows = this.db.prepare(
      `SELECT id, profile_id, profile_revision, subject_kind, subject_id, capability_id,
              capability_kind, descriptor_digest, event_type, reason_code, mandatory,
              outcome, evidence_refs_json, created_at
         FROM capability_receipts WHERE profile_id = ? ORDER BY sequence ASC LIMIT ?`,
    ).all(parsedId, limit) as ReceiptRow[];
    return rows.map(parseReceipt);
  }

  public listSkillReceiptProjection(profileId: string, requestedLimit: number): SkillReceiptProjection[] {
    const parsedId = boundedIdSchema.parse(profileId);
    const limit = boundedLimit(requestedLimit);
    const rows = this.db.prepare(
      `SELECT profile_id, subject_kind, subject_id, profile_revision, capability_id,
              descriptor_digest, mandatory, outcome, evidence_refs_json, outcome_at
         FROM skill_receipts WHERE profile_id = ? ORDER BY capability_id ASC LIMIT ?`,
    ).all(parsedId, limit) as SkillReceiptRow[];
    return rows.map((row) => ({
      profileId: row.profile_id,
      subjectKind: row.subject_kind,
      subjectId: row.subject_id,
      profileRevision: row.profile_revision,
      capabilityId: row.capability_id,
      descriptorDigest: row.descriptor_digest,
      mandatory: row.mandatory === 1,
      outcome: row.outcome,
      evidenceRefs: parseStringArray(row.evidence_refs_json, "skill receipt evidence"),
      outcomeAt: row.outcome_at,
    }));
  }

  public recordModelRouteSelection(rawInput: RecordModelRouteSelectionInput): ModelRouteTrial {
    const input = modelRouteSelectionInputSchema.parse(rawInput);
    const existing = this.getModelRouteTrial(input.subjectKind, input.subjectId, input.attempt);
    if (existing) {
      const expected = JSON.stringify({
        stage: input.stage,
        operation: input.operation,
        route: input.route,
        createdAt: input.now,
      });
      const actual = JSON.stringify({
        stage: existing.stage,
        operation: existing.operation,
        route: existing.route,
        createdAt: existing.createdAt,
      });
      if (expected !== actual) throw new TypeError("Model route selection has an immutable identity conflict");
      return existing;
    }
    const id = `model_route:${randomUUID()}`;
    try {
      this.db.prepare(
        `INSERT INTO model_route_trials (
           id, subject_kind, subject_id, attempt, pool, provider_id, model_id, reasoning,
           service_tier, stage, operation, failure_signature, outcome, created_at, settled_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'selected', ?, NULL)`,
      ).run(
        id,
        input.subjectKind,
        input.subjectId,
        input.attempt,
        input.route.pool,
        input.route.providerId,
        input.route.modelId,
        input.route.reasoning,
        input.route.serviceTier,
        input.stage,
        input.operation,
        input.now,
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        const raced = this.getModelRouteTrial(input.subjectKind, input.subjectId, input.attempt);
        if (raced) return this.recordModelRouteSelection(input);
      }
      throw error;
    }
    const stored = this.getModelRouteTrial(input.subjectKind, input.subjectId, input.attempt);
    if (!stored) throw new Error("Model route selection disappeared after persistence");
    return stored;
  }

  public settleModelRouteTrial(rawInput: SettleModelRouteTrialInput): ModelRouteTrial {
    const input = settleModelRouteTrialInputSchema.parse(rawInput);
    const existing = this.getModelRouteTrial(input.subjectKind, input.subjectId, input.attempt);
    if (!existing) throw new TypeError("Model route trial does not exist");
    if (input.now < existing.createdAt) throw new TypeError("Model route trial cannot settle before selection");
    if (existing.outcome !== "selected") {
      if (existing.outcome === input.outcome && existing.failureSignature === input.failureSignature) return existing;
      throw new TypeError("Model route trial already has a conflicting terminal outcome");
    }
    const updated = this.db.prepare(
      `UPDATE model_route_trials
          SET outcome = ?, failure_signature = ?, settled_at = ?
        WHERE subject_kind = ? AND subject_id = ? AND attempt = ? AND outcome = 'selected'`,
    ).run(
      input.outcome,
      input.failureSignature,
      input.now,
      input.subjectKind,
      input.subjectId,
      input.attempt,
    );
    if (updated.changes !== 1) return this.settleModelRouteTrial(input);
    const settled = this.getModelRouteTrial(input.subjectKind, input.subjectId, input.attempt);
    if (!settled) throw new Error("Model route trial disappeared after settlement");
    return settled;
  }

  public listModelRouteTrials(
    subjectKind: CapabilitySubjectKind,
    subjectId: string,
    requestedLimit: number,
  ): ModelRouteTrial[] {
    const parsedKind = z.enum(["controller_turn", "worker_attempt"]).parse(subjectKind);
    const parsedId = boundedIdSchema.parse(subjectId);
    const rows = this.db.prepare(
      `SELECT id, subject_kind, subject_id, attempt, pool, provider_id, model_id, reasoning,
              service_tier, stage, operation, failure_signature, outcome, created_at, settled_at
         FROM model_route_trials
        WHERE subject_kind = ? AND subject_id = ? ORDER BY attempt ASC LIMIT ?`,
    ).all(parsedKind, parsedId, boundedLimit(requestedLimit)) as ModelRouteTrialRow[];
    return rows.map((row) => this.parseModelRouteTrial(row));
  }

  public replaceInventorySnapshot(rawInput: {
    hostScope: string;
    items: readonly CapabilityInventoryItem[];
    now: number;
  }): void {
    const input = replaceInventorySchema.parse(rawInput);
    if (input.items.some((entry) => entry.hostScope !== input.hostScope)) {
      throw new TypeError("Inventory snapshot contains a different host scope");
    }
    if (new Set(input.items.map((entry) => entry.inventoryKey)).size !== input.items.length) {
      throw new TypeError("Inventory snapshot contains a duplicate inventory key");
    }
    this.db.transaction(() => {
      this.db.prepare(
        "DELETE FROM capability_inventory WHERE host_scope = ? AND status = 'inventory-only'",
      ).run(input.hostScope);
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO capability_inventory (
           inventory_key, capability_id, capability_kind, source, version, digest,
           host_scope, status, metadata_json, discovered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'inventory-only', ?, ?)`,
      );
      for (const entry of input.items) {
        const metadata = JSON.stringify(entry.metadata);
        if (metadata.length > 2_048) throw new TypeError("Inventory metadata exceeds its persistence bound");
        insert.run(
          entry.inventoryKey,
          entry.capabilityId,
          entry.capabilityKind,
          entry.source,
          entry.version,
          entry.digest,
          entry.hostScope,
          metadata,
          entry.discoveredAt,
        );
      }
      this.upsertInventoryHealth(input.hostScope, "ok", null, input.now);
    }).immediate();
  }

  public recordInventoryDiscoveryFailure(rawInput: {
    hostScope: string;
    errorClass: string;
    now: number;
  }): void {
    const input = inventoryFailureSchema.parse(rawInput);
    this.upsertInventoryHealth(input.hostScope, "degraded", input.errorClass, input.now);
  }

  public listInventory(hostScope: string, requestedLimit: number): CapabilityInventoryItem[] {
    const parsedScope = boundedIdSchema.parse(hostScope);
    const rows = this.db.prepare(
      `SELECT inventory_key, capability_id, capability_kind, source, version, digest,
              host_scope, status, metadata_json, discovered_at
         FROM capability_inventory
        WHERE host_scope = ? AND status = 'inventory-only'
        ORDER BY inventory_key ASC LIMIT ?`,
    ).all(parsedScope, boundedLimit(requestedLimit)) as InventoryRow[];
    return rows.map((row) => {
      const metadata: unknown = JSON.parse(row.metadata_json);
      const parsedMetadata = inventoryMetadataSchema.parse(metadata);
      return {
        inventoryKey: row.inventory_key,
        capabilityId: row.capability_id,
        capabilityKind: row.capability_kind,
        source: row.source,
        version: row.version,
        digest: row.digest,
        hostScope: row.host_scope,
        status: row.status,
        metadata: parsedMetadata,
        discoveredAt: row.discovered_at,
      };
    });
  }

  public getInventoryHealth(hostScope: string): (InventoryHealth & { hostScope: string }) | null {
    const parsedScope = boundedIdSchema.parse(hostScope);
    const row = this.db.prepare(
      `SELECT host_scope, status, error_class, refreshed_at
         FROM capability_inventory_health WHERE host_scope = ?`,
    ).get(parsedScope) as InventoryHealthRow | undefined;
    return row ? {
      hostScope: row.host_scope,
      status: row.status,
      errorClass: row.error_class,
      refreshedAt: row.refreshed_at,
    } : null;
  }

  public readDurableRecipePromotionEvidenceSnapshot(recipe: TaskRecipe): unknown | null {
    const parsedRecipe = z.enum(TASK_RECIPES).parse(recipe);
    return readDurablePromotionEvidenceSnapshot(this.db, parsedRecipe);
  }

  public appendRecipeRolloutDecision(
    rawInput: AppendRecipeRolloutDecisionInput,
  ): RecipeRolloutDecision {
    const input = appendRecipeRolloutDecisionSchema.parse(rawInput);
    const subjectId = input.action === "promote"
      ? `rollout:${input.recipe}:promote:${input.evidenceDigest ?? ""}:${randomUUID()}`
      : `rollout:${input.recipe}:rollback:${randomUUID()}`;
    const id = `recipe_rollout:${randomUUID()}`;
    try {
      this.db.prepare(
        `INSERT INTO recipe_promotions (
           id, subject_kind, subject_id, from_recipe, to_recipe, reason_code, created_at
         ) VALUES (?, 'worker_attempt', ?, ?, ?, ?, ?)`,
      ).run(id, subjectId, input.recipe, input.recipe, input.reasonCode, input.now);
    } catch (error) {
      if (input.action !== "promote" || !isUniqueConstraint(error)) throw error;
    }
    const row = this.db.prepare(
      `SELECT id, subject_id, from_recipe, to_recipe, reason_code, created_at
         FROM recipe_promotions
        WHERE subject_kind = 'worker_attempt' AND subject_id = ?`,
    ).get(subjectId) as RecipeRolloutDecisionRow | undefined;
    if (!row) throw new Error("Recipe rollout decision disappeared after persistence");
    const decision = parseRecipeRolloutDecision(row);
    if (
      decision.recipe !== input.recipe || decision.action !== input.action ||
      decision.reasonCode !== input.reasonCode || decision.evidenceDigest !== input.evidenceDigest
    ) {
      throw new TypeError("Recipe rollout decision conflicts with its durable identity");
    }
    return decision;
  }

  public listRecipeRolloutDecisions(recipe: TaskRecipe, requestedLimit: number): RecipeRolloutDecision[] {
    const parsedRecipe = z.enum(TASK_RECIPES).parse(recipe);
    const rows = this.db.prepare(
      `SELECT id, subject_id, from_recipe, to_recipe, reason_code, created_at
         FROM (
           SELECT rowid AS sequence, id, subject_id, from_recipe, to_recipe, reason_code, created_at
             FROM recipe_promotions
            WHERE subject_kind = 'worker_attempt' AND from_recipe = ? AND to_recipe = ?
              AND subject_id LIKE ?
            ORDER BY created_at DESC, rowid DESC LIMIT ?
         )
        ORDER BY created_at ASC, sequence ASC`,
    ).all(parsedRecipe, parsedRecipe, `rollout:${parsedRecipe}:%`, boundedLimit(requestedLimit)) as RecipeRolloutDecisionRow[];
    return rows.map(parseRecipeRolloutDecision);
  }

  public getLatestRecipeRolloutDecision(recipe: TaskRecipe): RecipeRolloutDecision | null {
    const parsedRecipe = z.enum(TASK_RECIPES).parse(recipe);
    const row = this.db.prepare(
      `SELECT id, subject_id, from_recipe, to_recipe, reason_code, created_at
         FROM recipe_promotions
        WHERE subject_kind = 'worker_attempt' AND from_recipe = ? AND to_recipe = ?
          AND subject_id LIKE ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(parsedRecipe, parsedRecipe, `rollout:${parsedRecipe}:%`) as RecipeRolloutDecisionRow | undefined;
    return row ? parseRecipeRolloutDecision(row) : null;
  }

  private nextRevision(subjectKind: CapabilitySubjectKind, subjectId: string): number {
    const row = this.db.prepare(
      `SELECT max(revision) AS revision FROM capability_profiles
        WHERE subject_kind = ? AND subject_id = ?`,
    ).get(subjectKind, subjectId) as { revision: number | null };
    return (row.revision ?? 0) + 1;
  }

  private requireProfileRow(profileId: string): ProfileRow {
    const parsedId = boundedIdSchema.parse(profileId);
    const row = this.db.prepare("SELECT * FROM capability_profiles WHERE id = ?")
      .get(parsedId) as ProfileRow | undefined;
    if (!row) throw new TypeError(`Unknown capability profile ${parsedId}`);
    return row;
  }

  private requireReceipt(receiptId: string): CapabilityReceipt {
    const row = this.db.prepare(
      `SELECT id, profile_id, profile_revision, subject_kind, subject_id, capability_id,
              capability_kind, descriptor_digest, event_type, reason_code, mandatory,
              outcome, evidence_refs_json, created_at
         FROM capability_receipts WHERE id = ?`,
    ).get(receiptId) as ReceiptRow | undefined;
    if (!row) throw new Error(`Capability receipt ${receiptId} disappeared after creation`);
    return parseReceipt(row);
  }

  private recordGuardFingerprintInTransaction(input: z.infer<typeof guardFingerprintInputSchema>): number {
    const prior = this.db.prepare(
      `SELECT profile_id, scope_id, capability_id, rule_id, subject_identity, requirement_class,
              occurrences, first_seen_at, last_seen_at
         FROM guard_fingerprints
        WHERE scope_id = ? AND fingerprint = ?`,
    ).get(input.scopeId, input.fingerprint) as GuardFingerprintRow | undefined;
    if (!prior) {
      this.db.prepare(
        `INSERT INTO guard_fingerprints (
           profile_id, scope_id, fingerprint, capability_id, rule_id, subject_identity,
           requirement_class, occurrences, first_seen_at, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        input.profileId,
        input.scopeId,
        input.fingerprint,
        input.capabilityId,
        input.ruleId,
        input.subjectIdentity,
        input.requirementClass,
        input.now,
        input.now,
      );
      return 1;
    }
    if (prior.capability_id !== input.capabilityId || prior.rule_id !== input.ruleId ||
      prior.subject_identity !== input.subjectIdentity || prior.requirement_class !== input.requirementClass) {
      throw new TypeError("Persisted guard fingerprint identity does not match the supplied identity");
    }
    if (input.now < prior.last_seen_at) {
      throw new TypeError("Guard fingerprint observation time moved backward");
    }
    if (prior.occurrences >= 3) return 3;
    const occurrence = prior.occurrences + 1;
    const updated = this.db.prepare(
      `UPDATE guard_fingerprints
          SET occurrences = ?, last_seen_at = ?
        WHERE scope_id = ? AND fingerprint = ? AND occurrences = ?`,
    ).run(occurrence, input.now, input.scopeId, input.fingerprint, prior.occurrences);
    if (updated.changes !== 1) throw new Error("Guard fingerprint changed during its serialized update");
    return occurrence;
  }

  private requireGuardFingerprintOccurrence(scopeId: string, fingerprint: string): number {
    const row = this.db.prepare(
      "SELECT occurrences FROM guard_fingerprints WHERE scope_id = ? AND fingerprint = ?",
    ).get(scopeId, fingerprint) as { occurrences: number } | undefined;
    if (!row) throw new TypeError("Guard settlement replay is missing its fingerprint occurrence");
    return row.occurrences;
  }

  private parseProfile(row: ProfileRow): CapabilityProfile {
    const assignments = this.db.prepare(
      `SELECT capability_id, capability_kind, descriptor_digest, mandatory
         FROM capability_profile_assignments WHERE profile_id = ? ORDER BY capability_id ASC`,
    ).all(row.id) as AssignmentRow[];
    return {
      id: row.id,
      subjectKind: row.subject_kind,
      subjectId: row.subject_id,
      threadId: row.thread_id,
      revision: row.revision,
      recipeId: row.recipe_id,
      recipeVersion: row.recipe_version,
      registryDigest: row.registry_digest,
      graphDigest: row.graph_digest,
      mode: row.mode,
      model: {
        pool: row.model_pool,
        providerId: row.model_provider_id,
        modelId: row.model_id,
        reasoning: row.model_reasoning,
        serviceTier: row.model_service_tier,
      },
      reasonCodes: parseStringArray(row.reason_codes_json, "profile reason codes"),
      traits: parseStringArray(row.traits_json, "profile traits"),
      assignments: assignments.map(parseAssignment),
      createdAt: row.created_at,
    };
  }

  private getModelRouteTrial(
    subjectKind: CapabilitySubjectKind,
    subjectId: string,
    attempt: number,
  ): ModelRouteTrial | null {
    const row = this.db.prepare(
      `SELECT id, subject_kind, subject_id, attempt, pool, provider_id, model_id, reasoning,
              service_tier, stage, operation, failure_signature, outcome, created_at, settled_at
         FROM model_route_trials WHERE subject_kind = ? AND subject_id = ? AND attempt = ?`,
    ).get(subjectKind, subjectId, attempt) as ModelRouteTrialRow | undefined;
    return row ? this.parseModelRouteTrial(row) : null;
  }

  private parseModelRouteTrial(row: ModelRouteTrialRow): ModelRouteTrial {
    return {
      id: row.id,
      subjectKind: row.subject_kind,
      subjectId: row.subject_id,
      attempt: row.attempt,
      stage: row.stage,
      operation: row.operation,
      route: modelRouteSchema.parse({
        pool: row.pool,
        providerId: row.provider_id,
        modelId: row.model_id,
        reasoning: row.reasoning,
        serviceTier: row.service_tier,
      }),
      failureSignature: row.failure_signature,
      outcome: row.outcome,
      createdAt: row.created_at,
      settledAt: row.settled_at,
    };
  }

  private upsertInventoryHealth(
    hostScope: string,
    status: InventoryHealth["status"],
    errorClass: string | null,
    refreshedAt: number,
  ): void {
    this.db.prepare(
      `INSERT INTO capability_inventory_health (host_scope, status, error_class, refreshed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(host_scope) DO UPDATE SET
         status = excluded.status,
         error_class = excluded.error_class,
         refreshed_at = excluded.refreshed_at`,
    ).run(hostScope, status, errorClass, refreshedAt);
  }
}
