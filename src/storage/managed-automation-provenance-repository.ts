import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  managedAutomationCapabilityEvidenceSchema,
  type ManagedAutomationCapabilityEvidence,
} from "../domain/managed-automation";
import { projectPolicySchema, type ProjectPolicy } from "../domain/models";

type SqliteDatabase = Database.Database;

const boundedId = z.string().min(1).max(256);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const positiveInteger = z.number().int().positive().safe();
const originSchema = z.enum(["standing-policy", "automation-triggered", "system-maintenance"]);

const profileRowSchema = z.object({
  id: boundedId,
  origin: originSchema,
  subject_key: boundedId,
  project_id: boundedId,
  host_id: boundedId,
  revision: positiveInteger,
  capability_id: boundedId,
  descriptor_version: boundedId,
  descriptor_digest: sha256,
  selected_receipt_id: boundedId,
  policy_id: boundedId.nullable(),
  policy_revision: positiveInteger.nullable(),
  parent_operation_id: boundedId.nullable(),
  parent_run_receipt_digest: sha256.nullable(),
  created_at: z.number().int().nonnegative().safe(),
}).strict();

const receiptRowSchema = z.object({
  id: boundedId,
  profile_id: boundedId,
  profile_revision: positiveInteger,
  capability_id: boundedId,
  descriptor_version: boundedId,
  descriptor_digest: sha256,
  event_type: z.literal("selected"),
  created_at: z.number().int().nonnegative().safe(),
}).strict();

export type ManagedAutomationProvenanceOrigin = z.infer<typeof originSchema>;

export type ManagedAutomationCapabilityProfile = Readonly<{
  id: string;
  origin: ManagedAutomationProvenanceOrigin;
  subjectKey: string;
  projectId: string;
  hostId: string;
  revision: number;
  capabilityId: string;
  descriptorVersion: string;
  descriptorDigest: string;
  selectedReceiptId: string;
  policyId: string | null;
  policyRevision: number | null;
  parentOperationId: string | null;
  parentRunReceiptDigest: string | null;
  createdAt: number;
}>;

export type ManagedAutomationCapabilityReceipt = Readonly<{
  id: string;
  profileId: string;
  profileRevision: number;
  capabilityId: string;
  descriptorVersion: string;
  descriptorDigest: string;
  eventType: "selected";
  createdAt: number;
}>;

export type ManagedAutomationCapabilityAdmission = Readonly<{
  profile: ManagedAutomationCapabilityProfile;
  receipt: ManagedAutomationCapabilityReceipt;
}>;

export type ManagedAutomationProjectPolicyRecord = Readonly<{
  policy: ProjectPolicy;
  version: number;
}>;

export type EnsureManagedAutomationCapabilityProfileInput = Readonly<{
  origin: ManagedAutomationProvenanceOrigin;
  subjectKey: string;
  projectId: string;
  hostId: string;
  revision: number;
  capabilityId: string;
  descriptorVersion: string;
  descriptorDigest: string;
  policyId?: string | null;
  policyRevision?: number | null;
  parentOperationId?: string | null;
  parentRunReceiptDigest?: string | null;
  now: number;
}>;

function stableId(prefix: string, values: readonly string[]): string {
  const digest = createHash("sha256").update(values.join("\u0000"), "utf8").digest("hex");
  return `${prefix}:${digest.slice(0, 48)}`;
}

function parseProfile(row: unknown): ManagedAutomationCapabilityProfile {
  const value = profileRowSchema.parse(row);
  return {
    id: value.id,
    origin: value.origin,
    subjectKey: value.subject_key,
    projectId: value.project_id,
    hostId: value.host_id,
    revision: value.revision,
    capabilityId: value.capability_id,
    descriptorVersion: value.descriptor_version,
    descriptorDigest: value.descriptor_digest,
    selectedReceiptId: value.selected_receipt_id,
    policyId: value.policy_id,
    policyRevision: value.policy_revision,
    parentOperationId: value.parent_operation_id,
    parentRunReceiptDigest: value.parent_run_receipt_digest,
    createdAt: value.created_at,
  };
}

function parseReceipt(row: unknown): ManagedAutomationCapabilityReceipt {
  const value = receiptRowSchema.parse(row);
  return {
    id: value.id,
    profileId: value.profile_id,
    profileRevision: value.profile_revision,
    capabilityId: value.capability_id,
    descriptorVersion: value.descriptor_version,
    descriptorDigest: value.descriptor_digest,
    eventType: value.event_type,
    createdAt: value.created_at,
  };
}

function profileMatches(
  profile: ManagedAutomationCapabilityProfile,
  input: EnsureManagedAutomationCapabilityProfileInput,
): boolean {
  return profile.origin === input.origin && profile.subjectKey === input.subjectKey &&
    profile.projectId === input.projectId && profile.hostId === input.hostId &&
    profile.revision === input.revision && profile.capabilityId === input.capabilityId &&
    profile.descriptorVersion === input.descriptorVersion &&
    profile.descriptorDigest === input.descriptorDigest &&
    profile.policyId === (input.policyId ?? null) &&
    profile.policyRevision === (input.policyRevision ?? null) &&
    profile.parentOperationId === (input.parentOperationId ?? null) &&
    profile.parentRunReceiptDigest === (input.parentRunReceiptDigest ?? null);
}

function receiptMatches(
  receipt: ManagedAutomationCapabilityReceipt,
  profile: ManagedAutomationCapabilityProfile,
): boolean {
  return receipt.id === profile.selectedReceiptId && receipt.profileId === profile.id &&
    receipt.profileRevision === profile.revision && receipt.capabilityId === profile.capabilityId &&
    receipt.descriptorVersion === profile.descriptorVersion &&
    receipt.descriptorDigest === profile.descriptorDigest && receipt.eventType === "selected";
}

export class ManagedAutomationProvenanceRepository {
  public constructor(private readonly db: SqliteDatabase) {}

  public ensureProfile(
    rawInput: EnsureManagedAutomationCapabilityProfileInput,
  ): ManagedAutomationCapabilityAdmission {
    const input = {
      ...rawInput,
      origin: originSchema.parse(rawInput.origin),
      subjectKey: boundedId.parse(rawInput.subjectKey),
      projectId: boundedId.parse(rawInput.projectId),
      hostId: boundedId.parse(rawInput.hostId),
      revision: positiveInteger.parse(rawInput.revision),
      capabilityId: boundedId.parse(rawInput.capabilityId),
      descriptorVersion: boundedId.parse(rawInput.descriptorVersion),
      descriptorDigest: sha256.parse(rawInput.descriptorDigest),
      policyId: rawInput.policyId === undefined || rawInput.policyId === null
        ? null
        : boundedId.parse(rawInput.policyId),
      policyRevision: rawInput.policyRevision === undefined || rawInput.policyRevision === null
        ? null
        : positiveInteger.parse(rawInput.policyRevision),
      parentOperationId: rawInput.parentOperationId === undefined || rawInput.parentOperationId === null
        ? null
        : boundedId.parse(rawInput.parentOperationId),
      parentRunReceiptDigest: rawInput.parentRunReceiptDigest === undefined || rawInput.parentRunReceiptDigest === null
        ? null
        : sha256.parse(rawInput.parentRunReceiptDigest),
      now: z.number().int().nonnegative().safe().parse(rawInput.now),
    } satisfies Omit<EnsureManagedAutomationCapabilityProfileInput, "origin"> & {
      origin: ManagedAutomationProvenanceOrigin;
      policyId: string | null;
      policyRevision: number | null;
      parentOperationId: string | null;
      parentRunReceiptDigest: string | null;
    };
    const profileId = stableId("managed-capability-profile", [
      input.origin,
      input.subjectKey,
      String(input.revision),
    ]);
    const receiptId = stableId("managed-capability-receipt", [profileId, input.capabilityId]);

    return this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO managed_automation_capability_profiles (
           id, origin, subject_key, project_id, host_id, revision,
           capability_id, descriptor_version, descriptor_digest, selected_receipt_id,
           policy_id, policy_revision, parent_operation_id, parent_run_receipt_digest, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).run(
        profileId,
        input.origin,
        input.subjectKey,
        input.projectId,
        input.hostId,
        input.revision,
        input.capabilityId,
        input.descriptorVersion,
        input.descriptorDigest,
        receiptId,
        input.policyId,
        input.policyRevision,
        input.parentOperationId,
        input.parentRunReceiptDigest,
        input.now,
      );
      const profile = this.getProfile(profileId);
      if (!profile || !profileMatches(profile, input)) {
        throw new TypeError("managed automation capability profile identity changed");
      }
      this.db.prepare(
        `INSERT INTO managed_automation_capability_receipts (
           id, profile_id, profile_revision, capability_id, descriptor_version,
           descriptor_digest, event_type, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'selected', ?)
         ON CONFLICT(id) DO NOTHING`,
      ).run(
        receiptId,
        profile.id,
        profile.revision,
        profile.capabilityId,
        profile.descriptorVersion,
        profile.descriptorDigest,
        input.now,
      );
      const admission = this.getAdmission(profile.id);
      if (!admission || !receiptMatches(admission.receipt, admission.profile)) {
        throw new TypeError("managed automation capability selection is incomplete");
      }
      return admission;
    }).immediate();
  }

  public getProfile(profileId: string): ManagedAutomationCapabilityProfile | null {
    const id = boundedId.parse(profileId);
    const row = this.db.prepare(
      `SELECT id, origin, subject_key, project_id, host_id, revision,
              capability_id, descriptor_version, descriptor_digest, selected_receipt_id,
              policy_id, policy_revision, parent_operation_id, parent_run_receipt_digest, created_at
         FROM managed_automation_capability_profiles WHERE id = ?`,
    ).get(id);
    return row === undefined ? null : parseProfile(row);
  }

  public getProjectPolicy(projectId: string): ManagedAutomationProjectPolicyRecord | null {
    const id = boundedId.parse(projectId);
    const row = this.db.prepare(
      "SELECT policy_json, version FROM project_policies WHERE project_id = ?",
    ).get(id) as { policy_json: unknown; version: unknown } | undefined;
    if (!row) return null;
    return {
      policy: projectPolicySchema.parse(JSON.parse(z.string().parse(row.policy_json))),
      version: positiveInteger.parse(row.version),
    };
  }

  public getAdmission(profileId: string): ManagedAutomationCapabilityAdmission | null {
    const profile = this.getProfile(profileId);
    if (!profile) return null;
    const row = this.db.prepare(
      `SELECT id, profile_id, profile_revision, capability_id, descriptor_version,
              descriptor_digest, event_type, created_at
         FROM managed_automation_capability_receipts
        WHERE id = ? AND profile_id = ?`,
    ).get(profile.selectedReceiptId, profile.id);
    if (row === undefined) return null;
    const receipt = parseReceipt(row);
    return receiptMatches(receipt, profile) ? { profile, receipt } : null;
  }

  public resolveEvidence(
    evidence: ManagedAutomationCapabilityEvidence,
  ): ManagedAutomationCapabilityAdmission | null {
    const parsed = managedAutomationCapabilityEvidenceSchema.safeParse(evidence);
    if (!parsed.success) return null;
    const profileRef = `managed-capability-profile:${parsed.data.profileId}:${parsed.data.profileRevision}`;
    const receiptRefs = parsed.data.evidenceRefs.filter((ref) => ref.startsWith("managed-capability-receipt:"));
    if (!parsed.data.evidenceRefs.includes(profileRef) || receiptRefs.length !== 1) return null;
    const admission = this.getAdmission(parsed.data.profileId);
    if (!admission || admission.profile.revision !== parsed.data.profileRevision ||
      admission.profile.capabilityId !== parsed.data.capabilityId ||
      admission.profile.descriptorVersion !== parsed.data.descriptorVersion ||
      admission.profile.descriptorDigest !== parsed.data.descriptorDigest ||
      receiptRefs[0] !== `managed-capability-receipt:${admission.receipt.id}`) return null;
    return admission;
  }
}

export function managedAutomationCapabilityEvidenceFromAdmission(
  admission: ManagedAutomationCapabilityAdmission,
): ManagedAutomationCapabilityEvidence {
  return managedAutomationCapabilityEvidenceSchema.parse({
    version: 1,
    profileId: admission.profile.id,
    profileRevision: admission.profile.revision,
    capabilityId: admission.profile.capabilityId,
    descriptorVersion: admission.profile.descriptorVersion,
    descriptorDigest: admission.profile.descriptorDigest,
    evidenceRefs: [
      `managed-capability-profile:${admission.profile.id}:${admission.profile.revision}`,
      `managed-capability-receipt:${admission.receipt.id}`,
    ],
  });
}
