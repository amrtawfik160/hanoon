import type Database from "better-sqlite3";
import type { SaveReferenceDocumentInput } from "../storage/reference-repository";
import {
  assertBoundedString,
  assertExternalArtifactStatus,
  assertNonNegativeInteger,
  assertPositiveInteger,
  assertWorkArtifactKind,
  assertWorkArtifactStatus,
  assertWorkTrackerKind,
  normalizeArtifactContent,
  normalizeRelationships,
  normalizeSingleLine,
  normalizeStringList,
  sha256,
  stableWorkArtifactId,
  WORK_ARTIFACT_RELATIONSHIP_VALIDATOR_FUNCTION,
  workArtifactSnapshotDigest,
  type ExternalArtifactStatus,
  type WorkArtifact,
  type WorkArtifactClaim,
  type WorkArtifactKind,
  type WorkArtifactRelationship,
  type WorkArtifactResolution,
  type WorkArtifactResolutionIntent,
  type WorkArtifactSnapshot,
  type WorkArtifactSnapshotInvalidation,
  type WorkArtifactStatus,
  type WorkTrackerKind,
} from "./models";

export { stableWorkArtifactId } from "./models";
export type {
  ExternalArtifactStatus,
  WorkArtifact,
  WorkArtifactClaim,
  WorkArtifactKind,
  WorkArtifactRelationship,
  WorkArtifactResolution,
  WorkArtifactResolutionIntent,
  WorkArtifactSnapshot,
  WorkArtifactSnapshotInvalidation,
  WorkArtifactStatus,
  WorkTrackerKind,
} from "./models";

type SqliteDatabase = Database.Database;

export type CaptureWorkArtifactInput = Readonly<{
  artifactId: string;
  projectId: string;
  effortId: string;
  operationId: string;
  kind: WorkArtifactKind;
  status: Extract<WorkArtifactStatus, "open" | "ready">;
  trackerKind: WorkTrackerKind;
  trackerNamespace: string;
  externalId: string;
  externalUrl: string | null;
  externalRevision: string;
  externalStatus: ExternalArtifactStatus;
  assignees: readonly string[];
  title: string;
  trackerOrder?: number;
  content: string;
  acceptanceCriteria: readonly string[];
  relationships: readonly WorkArtifactRelationship[];
  capturedAt: number;
}>;

export type PreflightWorkArtifactCaptureInput = Readonly<{
  artifactId: string;
  projectId: string;
  effortId: string;
  operationId: string;
  kind: WorkArtifactKind;
  status: Extract<WorkArtifactStatus, "open" | "ready">;
  trackerKind: WorkTrackerKind;
  trackerNamespace: string;
  title: string;
  trackerOrder?: number;
  content: string;
  acceptanceCriteria: readonly string[];
  relationships: readonly WorkArtifactRelationship[];
  capturedAt: number;
}>;

export type ObserveWorkArtifactInput = Readonly<{
  artifactId: string;
  expectedExternalRevision: string;
  externalRevision: string;
  externalStatus: ExternalArtifactStatus;
  assignees: readonly string[];
  title: string;
  content: string;
  acceptanceCriteria: readonly string[];
  relationships: readonly WorkArtifactRelationship[];
  observedAt: number;
}>;

export type WorkArtifactCapture = Readonly<{
  artifact: WorkArtifact;
  snapshot: WorkArtifactSnapshot;
}>;

export type WorkArtifactCreateIntent = Readonly<{
  artifactId: string;
  projectId: string;
  effortId: string;
  operationId: string;
  trackerKind: WorkTrackerKind;
  trackerNamespace: string;
  trackerOperationId: string;
  createDigest: string;
  ownerId: string;
  generation: number;
  createdAt: number;
}>;

export type PrepareWorkArtifactCreateIntentInput = Omit<WorkArtifactCreateIntent, "createdAt"> & Readonly<{
  now: number;
}>;

export class WorkArtifactObservationConflictError extends Error {
  public constructor(artifactId: string) {
    super(`Work artifact ${artifactId} changed while its tracker observation was in flight`);
    this.name = "WorkArtifactObservationConflictError";
  }
}

export type ClaimWorkArtifactInput = Readonly<{
  artifactId: string;
  workflowStepId: string;
  jobId: string;
  snapshotId: string;
  externalAssignee: string;
  ownerId: string;
  generation: number;
  now: number;
  leaseMs: number;
}>;

export type WorkArtifactClaimIdentity = Readonly<{
  artifactId: string;
  workflowStepId: string;
  jobId: string;
}>;

export type AdoptWorkArtifactClaimInput = Readonly<{
  artifactId: string;
  workflowStepId: string;
  jobId: string;
  externalAssignee: string;
  ownerId: string;
  generation: number;
  now: number;
  leaseMs: number;
}>;

export type RenewWorkArtifactClaimInput = Readonly<{
  claimId: number;
  ownerId: string;
  generation: number;
  now: number;
  leaseMs: number;
}>;

export type ReleaseWorkArtifactClaimInput = Readonly<{
  claimId: number;
  ownerId: string;
  generation: number;
  now: number;
  reason: string;
}>;

export type AuthorizeWorkArtifactResolutionInput = Readonly<{
  artifactId: string;
  operationId: string;
  outcome: WorkArtifactResolution["outcome"];
  snapshotId: string;
  expectedExternalRevision: string;
  evidenceRefs: readonly string[];
  now: number;
}>;

export type FinalizeWorkArtifactResolutionInput = Readonly<{
  intentId: string;
  externalRevision: string;
  now: number;
}>;

export type WorkArtifactTrackerMutationKind = "parent" | "owned_section" | "resolve" | "cancel";
export type WorkArtifactTrackerMutationPhase =
  | "prepared"
  | "applying"
  | "completed"
  | "indeterminate";

export type WorkArtifactTrackerMutation = Readonly<{
  trackerNamespace: string;
  externalId: string;
  operationId: string;
  artifactId: string;
  kind: WorkArtifactTrackerMutationKind;
  payloadDigest: string;
  requestedParentExternalId: string | null;
  originalParentExternalId: string | null;
  originalRevision: string;
  ownerId: string;
  generation: number;
  phase: WorkArtifactTrackerMutationPhase;
  status: "pending" | "completed" | "indeterminate";
  lastObservedParentExternalId: string | null;
  lastObservedRevision: string | null;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
  settledAt: number | null;
}>;

export type WorkArtifactTrackerMutationKey = Readonly<{
  trackerNamespace: string;
  externalId: string;
  operationId: string;
}>;

export type PrepareWorkArtifactTrackerMutationInput = WorkArtifactTrackerMutationKey & Readonly<{
  artifactId: string;
  kind: WorkArtifactTrackerMutationKind;
  payloadDigest: string;
  requestedParentExternalId: string | null;
  originalParentExternalId: string | null;
  originalRevision: string;
  ownerId: string;
  generation: number;
  now: number;
}>;

export type ApplyWorkArtifactTrackerMutationInput = WorkArtifactTrackerMutationKey & Readonly<{
  ownerId: string;
  generation: number;
  now: number;
}>;

export type SettleWorkArtifactTrackerMutationInput = WorkArtifactTrackerMutationKey & Readonly<{
  lastObservedParentExternalId: string | null;
  lastObservedRevision: string;
  reason?: string;
  now: number;
}>;

type ArtifactRow = Readonly<{
  id: string;
  project_id: string;
  effort_id: string;
  operation_id: string;
  kind: string;
  initial_status: string;
  status: string;
  tracker_kind: string;
  tracker_namespace: string;
  external_id: string;
  external_url: string | null;
  external_revision: string;
  external_status: string;
  assignees_json: string;
  title: string;
  tracker_order: number;
  current_revision: number;
  current_snapshot_id: string | null;
  remote_closed_at: number | null;
  created_at: number;
  updated_at: number;
}>;

type CreateIntentRow = Readonly<{
  artifact_id: string;
  project_id: string;
  effort_id: string;
  operation_id: string;
  tracker_kind: string;
  tracker_namespace: string;
  tracker_operation_id: string;
  create_digest: string;
  owner_id: string;
  generation: number;
  created_at: number;
}>;

type SnapshotRow = Readonly<{
  id: string;
  artifact_id: string;
  revision: number;
  title: string;
  content: string;
  content_digest: string;
  snapshot_digest: string;
  acceptance_criteria_json: string;
  relationships_json: string;
  external_revision: string;
  captured_at: number;
}>;

type RelationshipRow = Readonly<{
  kind: string;
  source_artifact_id: string | null;
  source_ref: string;
  target_artifact_id: string | null;
  target_ref: string;
}>;

type ClaimRow = Readonly<{
  id: number;
  artifact_id: string;
  workflow_step_id: string;
  job_id: string;
  snapshot_id: string;
  external_assignee: string;
  state: string;
  owner_id: string;
  generation: number;
  lease_expires_at: number;
  acquired_at: number;
  renewed_at: number;
  released_at: number | null;
  release_reason: string | null;
}>;

type ResolutionIntentRow = Readonly<{
  id: string;
  artifact_id: string;
  operation_id: string;
  outcome: WorkArtifactResolution["outcome"];
  snapshot_id: string;
  expected_external_revision: string;
  evidence_refs_json: string;
  recorded_at: number;
}>;

type ResolutionRow = Readonly<{
  artifact_id: string;
  intent_id: string;
  operation_id: string;
  outcome: WorkArtifactResolution["outcome"];
  snapshot_id: string;
  external_revision: string;
  evidence_refs_json: string;
  recorded_at: number;
}>;

type TrackerMutationRow = Readonly<{
  tracker_namespace: string;
  external_id: string;
  operation_id: string;
  artifact_id: string;
  kind: WorkArtifactTrackerMutationKind;
  payload_digest: string;
  requested_parent_external_id: string | null;
  original_parent_external_id: string | null;
  original_revision: string;
  owner_id: string;
  generation: number;
  phase: WorkArtifactTrackerMutationPhase;
  status: "pending" | "completed" | "indeterminate";
  last_observed_parent_external_id: string | null;
  last_observed_revision: string | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
}>;

const ARTIFACT_SELECT = `
  SELECT id, project_id, effort_id, operation_id, kind, initial_status, status, tracker_kind,
         tracker_namespace,
         external_id, external_url, external_revision, external_status,
         assignees_json, title, tracker_order, current_revision,
         current_snapshot_id, remote_closed_at, created_at, updated_at
    FROM work_artifacts`;
const CREATE_INTENT_SELECT = `
  SELECT artifact_id, project_id, effort_id, operation_id, tracker_kind,
         tracker_namespace, tracker_operation_id, create_digest, owner_id,
         generation, created_at
    FROM work_artifact_create_intents`;
const SNAPSHOT_SELECT = `
  SELECT id, artifact_id, revision, title, content, content_digest,
         snapshot_digest, acceptance_criteria_json, relationships_json,
         external_revision, captured_at
    FROM work_artifact_snapshots`;
const CLAIM_SELECT = `
  SELECT id, artifact_id, workflow_step_id, job_id, snapshot_id, external_assignee,
         state, owner_id, generation, lease_expires_at, acquired_at, renewed_at,
         released_at, release_reason
    FROM work_artifact_claims`;
const RESOLUTION_INTENT_SELECT = `
  SELECT id, artifact_id, operation_id, outcome, snapshot_id,
         expected_external_revision, evidence_refs_json, recorded_at
    FROM work_artifact_resolution_intents`;
const RESOLUTION_SELECT = `
  SELECT artifact_id, intent_id, operation_id, outcome, snapshot_id,
         external_revision, evidence_refs_json, recorded_at
    FROM work_artifact_resolutions`;
const TRACKER_MUTATION_SELECT = `
  SELECT tracker_namespace, external_id, operation_id, artifact_id, kind, payload_digest,
         requested_parent_external_id, original_parent_external_id, original_revision,
         owner_id, generation, phase, status, last_observed_parent_external_id,
         last_observed_revision, reason, created_at, updated_at, settled_at
    FROM work_artifact_tracker_mutations`;

const CLAIM_ELIGIBLE_JOB_STATES: ReadonlySet<string> = new Set([
  "planning",
  "critiquing",
  "creating_implementation",
  "implementing",
  "reviewing",
  "remediating",
  "validating",
  "documenting",
  "final_validating",
  "final_reviewing",
  "recovering_worker",
]);

function parseStringArray(json: string, field: string): readonly string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`Persisted ${field} is invalid`);
  }
  return parsed;
}

function parseArtifact(row: ArtifactRow): WorkArtifact {
  assertWorkArtifactKind(row.kind);
  assertWorkArtifactStatus(row.status);
  assertWorkTrackerKind(row.tracker_kind);
  assertExternalArtifactStatus(row.external_status);
  if (row.current_snapshot_id === null || row.current_revision < 1) {
    throw new Error(`Work artifact ${row.id} has no current snapshot`);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    effortId: row.effort_id,
    operationId: row.operation_id,
    kind: row.kind,
    status: row.status,
    trackerKind: row.tracker_kind,
    trackerNamespace: row.tracker_namespace,
    externalId: row.external_id,
    externalUrl: row.external_url,
    externalRevision: row.external_revision,
    externalStatus: row.external_status,
    assignees: parseStringArray(row.assignees_json, "artifact assignees"),
    title: row.title,
    trackerOrder: row.tracker_order,
    currentRevision: row.current_revision,
    currentSnapshotId: row.current_snapshot_id,
    remoteClosedAt: row.remote_closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseCreateIntent(row: CreateIntentRow): WorkArtifactCreateIntent {
  assertWorkTrackerKind(row.tracker_kind);
  return {
    artifactId: row.artifact_id,
    projectId: row.project_id,
    effortId: row.effort_id,
    operationId: row.operation_id,
    trackerKind: row.tracker_kind,
    trackerNamespace: row.tracker_namespace,
    trackerOperationId: row.tracker_operation_id,
    createDigest: row.create_digest,
    ownerId: row.owner_id,
    generation: row.generation,
    createdAt: row.created_at,
  };
}

function parseRelationship(value: unknown): WorkArtifactRelationship {
  if (typeof value !== "object" || value === null) {
    throw new Error("Persisted artifact relationship is invalid");
  }
  const row = value as Record<string, unknown>;
  return {
    kind: row.kind as WorkArtifactRelationship["kind"],
    sourceArtifactId: row.sourceArtifactId as string | null,
    sourceRef: row.sourceRef as string,
    targetArtifactId: row.targetArtifactId as string | null,
    targetRef: row.targetRef as string,
  };
}

function parsePersistedRelationships(
  artifactIdValue: unknown,
  relationshipsJson: unknown,
): readonly WorkArtifactRelationship[] {
  if (typeof artifactIdValue !== "string" || typeof relationshipsJson !== "string") {
    throw new Error("Persisted artifact relationships are invalid");
  }
  const artifactId = assertBoundedString(artifactIdValue, "artifactId");
  if (artifactId !== artifactIdValue) throw new Error("Persisted artifact relationships are invalid");
  const relationships: unknown = JSON.parse(relationshipsJson);
  if (!Array.isArray(relationships)) throw new Error("Persisted artifact relationships are invalid");
  return normalizeRelationships(artifactId, relationships.map(parseRelationship));
}

export function registerWorkArtifactRelationshipValidation(db: SqliteDatabase): void {
  db.function(
    WORK_ARTIFACT_RELATIONSHIP_VALIDATOR_FUNCTION,
    { deterministic: true },
    (artifactId: unknown, relationshipsJson: unknown): number => {
      try {
        parsePersistedRelationships(artifactId, relationshipsJson);
        return 1;
      } catch {
        return 0;
      }
    },
  );
}

function parseSnapshot(row: SnapshotRow): WorkArtifactSnapshot {
  const parsedRelationships = parsePersistedRelationships(row.artifact_id, row.relationships_json);
  return {
    id: row.id,
    artifactId: row.artifact_id,
    revision: row.revision,
    title: row.title,
    content: row.content,
    contentDigest: row.content_digest,
    snapshotDigest: row.snapshot_digest,
    acceptanceCriteria: parseStringArray(row.acceptance_criteria_json, "acceptance criteria"),
    relationships: parsedRelationships,
    externalRevision: row.external_revision,
    capturedAt: row.captured_at,
  };
}

function parseClaim(row: ClaimRow): WorkArtifactClaim {
  if (row.state !== "held" && row.state !== "released" && row.state !== "invalidated") {
    throw new Error(`Persisted work artifact claim ${row.id} has an invalid state`);
  }
  return {
    id: row.id,
    artifactId: row.artifact_id,
    workflowStepId: row.workflow_step_id,
    jobId: row.job_id,
    snapshotId: row.snapshot_id,
    externalAssignee: row.external_assignee,
    state: row.state,
    ownerId: row.owner_id,
    generation: row.generation,
    leaseExpiresAt: row.lease_expires_at,
    acquiredAt: row.acquired_at,
    renewedAt: row.renewed_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
  };
}

function parseResolutionIntent(row: ResolutionIntentRow): WorkArtifactResolutionIntent {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    operationId: row.operation_id,
    outcome: row.outcome,
    snapshotId: row.snapshot_id,
    expectedExternalRevision: row.expected_external_revision,
    evidenceRefs: parseStringArray(row.evidence_refs_json, "resolution intent evidence"),
    recordedAt: row.recorded_at,
  };
}

function parseResolution(row: ResolutionRow): WorkArtifactResolution {
  return {
    artifactId: row.artifact_id,
    intentId: row.intent_id,
    operationId: row.operation_id,
    outcome: row.outcome,
    snapshotId: row.snapshot_id,
    externalRevision: row.external_revision,
    evidenceRefs: parseStringArray(row.evidence_refs_json, "resolution evidence"),
    recordedAt: row.recorded_at,
  };
}

function parseTrackerMutation(row: TrackerMutationRow): WorkArtifactTrackerMutation {
  return {
    trackerNamespace: row.tracker_namespace,
    externalId: row.external_id,
    operationId: row.operation_id,
    artifactId: row.artifact_id,
    kind: row.kind,
    payloadDigest: row.payload_digest,
    requestedParentExternalId: row.requested_parent_external_id,
    originalParentExternalId: row.original_parent_external_id,
    originalRevision: row.original_revision,
    ownerId: row.owner_id,
    generation: row.generation,
    phase: row.phase,
    status: row.status,
    lastObservedParentExternalId: row.last_observed_parent_external_id,
    lastObservedRevision: row.last_observed_revision,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
  };
}

function snapshotId(artifactId: string, revision: number, digest: string): string {
  return `snapshot_${sha256(`${artifactId}:${revision}:${digest}`).slice(0, 32)}`;
}

function resolutionIntentId(artifactId: string, operationId: string): string {
  return `resolution_intent_${sha256(`${artifactId}:${operationId}`).slice(0, 32)}`;
}

function currentExecutorLease(
  db: SqliteDatabase,
  ownerId: string,
  generation: number,
  now: number,
): boolean {
  return db.prepare(
    `SELECT 1 FROM executor_lease
      WHERE singleton = 1 AND owner_id = ? AND generation = ? AND lease_expires_at > ?`,
  ).get(ownerId, generation, now) !== undefined;
}

function normalizedSnapshotInput(input: Readonly<{
  artifactId: string;
  title: string;
  content: string;
  acceptanceCriteria: readonly string[];
  relationships: readonly WorkArtifactRelationship[];
}>): Readonly<{
  title: string;
  content: string;
  contentDigest: string;
  snapshotDigest: string;
  acceptanceCriteria: readonly string[];
  relationships: readonly WorkArtifactRelationship[];
}> {
  const title = normalizeSingleLine(input.title, "artifact title", 512);
  const content = normalizeArtifactContent(input.content);
  const contentDigest = sha256(content);
  const acceptanceCriteria = normalizeStringList(
    input.acceptanceCriteria,
    "acceptance criteria",
    128,
    2_048,
  );
  const relationships = normalizeRelationships(input.artifactId, input.relationships);
  return {
    title,
    content,
    contentDigest,
    acceptanceCriteria,
    relationships,
    snapshotDigest: workArtifactSnapshotDigest({
      title,
      contentDigest,
      acceptanceCriteria,
      relationships,
    }),
  };
}

function validateCaptureDraft(input: PreflightWorkArtifactCaptureInput) {
  assertBoundedString(input.artifactId, "artifactId");
  assertBoundedString(input.projectId, "projectId");
  assertBoundedString(input.effortId, "effortId");
  assertBoundedString(input.operationId, "operationId");
  assertWorkArtifactKind(input.kind);
  if (input.status !== "open" && input.status !== "ready") {
    throw new TypeError("new work artifact status must be open or ready");
  }
  assertWorkTrackerKind(input.trackerKind);
  assertBoundedString(input.trackerNamespace, "trackerNamespace", 1_024);
  assertNonNegativeInteger(input.trackerOrder ?? 0, "trackerOrder");
  assertNonNegativeInteger(input.capturedAt, "capturedAt");
  return normalizedSnapshotInput(input);
}

export class WorkArtifactRepository {
  public constructor(private readonly db: SqliteDatabase) {}

  public captureArtifact(input: CaptureWorkArtifactInput): WorkArtifactCapture {
    const normalized = this.validateCapture(input);
    return this.db.transaction((): WorkArtifactCapture => {
      const existingById = this.readArtifactRow(input.artifactId);
      if (existingById) {
        this.assertCaptureReplay(existingById, input);
        if (existingById.external_revision !== input.externalRevision) {
          throw new WorkArtifactObservationConflictError(input.artifactId);
        }
        return this.observeInTransaction({
          artifactId: input.artifactId,
          expectedExternalRevision: existingById.external_revision,
          externalRevision: input.externalRevision,
          externalStatus: input.externalStatus,
          assignees: input.assignees,
          title: normalized.title,
          content: normalized.content,
          acceptanceCriteria: normalized.acceptanceCriteria,
          relationships: normalized.relationships,
          observedAt: input.capturedAt,
        });
      }
      const externalCollision = this.db.prepare(
        `${ARTIFACT_SELECT} WHERE project_id = ? AND tracker_namespace = ? AND external_id = ?`,
      ).get(input.projectId, input.trackerNamespace, input.externalId) as ArtifactRow | undefined;
      if (externalCollision) {
        throw new TypeError("work artifact external identity is already bound to another operation");
      }
      const operationCollision = this.db.prepare(
        `${ARTIFACT_SELECT} WHERE project_id = ? AND operation_id = ?`,
      ).get(input.projectId, input.operationId) as ArtifactRow | undefined;
      if (operationCollision) {
        throw new TypeError("work artifact operation is already bound to another identity");
      }
      this.assertRelationshipArtifactsInEffort(
        input.artifactId,
        input.projectId,
        input.effortId,
        normalized.relationships,
      );
      this.db.prepare(
        `INSERT INTO work_artifacts (
           id, project_id, effort_id, operation_id, kind, initial_status, status, tracker_kind,
           tracker_namespace,
           external_id, external_url, external_revision, external_status,
           assignees_json, title, tracker_order, current_revision,
           current_snapshot_id, remote_closed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
      ).run(
        input.artifactId,
        input.projectId,
        input.effortId,
        input.operationId,
        input.kind,
        input.status,
        input.status,
        input.trackerKind,
        input.trackerNamespace,
        input.externalId,
        input.externalUrl,
        input.externalRevision,
        input.externalStatus,
        JSON.stringify(normalizeStringList(input.assignees, "artifact assignees", 64, 256, true)),
        normalized.title,
        input.trackerOrder ?? 0,
        input.externalStatus === "open" ? null : input.capturedAt,
        input.capturedAt,
        input.capturedAt,
      );
      const snapshot = this.insertSnapshot({
        artifactId: input.artifactId,
        revision: 1,
        externalRevision: input.externalRevision,
        capturedAt: input.capturedAt,
        ...normalized,
      });
      this.replaceRelationships(input.artifactId, normalized.relationships, input.capturedAt);
      this.db.prepare(
        `UPDATE work_artifacts
            SET current_revision = 1, current_snapshot_id = ?
          WHERE id = ? AND current_revision = 0`,
      ).run(snapshot.id, input.artifactId);
      return { artifact: this.requireArtifact(input.artifactId), snapshot };
    }).immediate();
  }

  public prepareCreateIntent(
    input: PrepareWorkArtifactCreateIntentInput,
  ): WorkArtifactCreateIntent {
    assertBoundedString(input.artifactId, "artifactId");
    assertBoundedString(input.projectId, "projectId");
    assertBoundedString(input.effortId, "effortId");
    assertBoundedString(input.operationId, "operationId");
    assertWorkTrackerKind(input.trackerKind);
    assertBoundedString(input.trackerNamespace, "trackerNamespace", 1_024);
    assertBoundedString(input.trackerOperationId, "trackerOperationId");
    if (!/^[0-9a-f]{64}$/u.test(input.createDigest)) {
      throw new TypeError("work artifact create digest is invalid");
    }
    assertBoundedString(input.ownerId, "ownerId");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction(() => {
      const existing = this.getCreateIntent(input.artifactId);
      if (existing) {
        if (
          existing.projectId !== input.projectId || existing.effortId !== input.effortId ||
          existing.operationId !== input.operationId || existing.trackerKind !== input.trackerKind ||
          existing.trackerNamespace !== input.trackerNamespace ||
          existing.trackerOperationId !== input.trackerOperationId ||
          existing.createDigest !== input.createDigest
        ) {
          throw new TypeError("work artifact create intent identity changed during replay");
        }
        return existing;
      }
      const collision = this.db.prepare(
        `${CREATE_INTENT_SELECT} WHERE project_id = ? AND operation_id = ?`,
      ).get(input.projectId, input.operationId) as CreateIntentRow | undefined;
      if (collision) {
        throw new TypeError("work artifact create operation is already bound to another intent");
      }
      this.db.prepare(
        `INSERT INTO work_artifact_create_intents (
           artifact_id, project_id, effort_id, operation_id, tracker_kind,
           tracker_namespace, tracker_operation_id, create_digest, owner_id,
           generation, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.artifactId,
        input.projectId,
        input.effortId,
        input.operationId,
        input.trackerKind,
        input.trackerNamespace,
        input.trackerOperationId,
        input.createDigest,
        input.ownerId,
        input.generation,
        input.now,
      );
      const created = this.getCreateIntent(input.artifactId);
      if (!created) throw new Error("work artifact create intent was not persisted");
      return created;
    }).immediate();
  }

  public getCreateIntent(artifactId: string): WorkArtifactCreateIntent | null {
    assertBoundedString(artifactId, "artifactId");
    const row = this.db.prepare(
      `${CREATE_INTENT_SELECT} WHERE artifact_id = ?`,
    ).get(artifactId) as CreateIntentRow | undefined;
    return row ? parseCreateIntent(row) : null;
  }

  public preflightArtifactCapture(input: PreflightWorkArtifactCaptureInput): void {
    const normalized = validateCaptureDraft(input);
    const existingById = this.readArtifactRow(input.artifactId);
    if (existingById) {
      if (
        existingById.project_id !== input.projectId || existingById.effort_id !== input.effortId ||
        existingById.operation_id !== input.operationId || existingById.kind !== input.kind ||
        existingById.initial_status !== input.status ||
        existingById.tracker_kind !== input.trackerKind ||
        existingById.tracker_namespace !== input.trackerNamespace ||
        existingById.tracker_order !== (input.trackerOrder ?? 0)
      ) {
        throw new TypeError("work artifact identity changed during capture replay");
      }
    }
    const operationCollision = this.db.prepare(
      `${ARTIFACT_SELECT} WHERE project_id = ? AND operation_id = ? AND id <> ?`,
    ).get(input.projectId, input.operationId, input.artifactId) as ArtifactRow | undefined;
    if (operationCollision) {
      throw new TypeError("work artifact operation is already bound to another identity");
    }
    this.assertRelationshipArtifactsInEffort(
      input.artifactId,
      input.projectId,
      input.effortId,
      normalized.relationships,
    );
  }

  public observeArtifact(input: ObserveWorkArtifactInput): WorkArtifactCapture {
    assertBoundedString(input.artifactId, "artifactId");
    assertNonNegativeInteger(input.observedAt, "observedAt");
    return this.db.transaction(() => this.observeInTransaction(input)).immediate();
  }

  public getArtifact(id: string): WorkArtifact | null {
    assertBoundedString(id, "artifactId");
    const row = this.readArtifactRow(id);
    return row ? parseArtifact(row) : null;
  }

  public getArtifactByExternalIdentity(
    projectId: string,
    trackerNamespace: string,
    externalId: string,
  ): WorkArtifact | null {
    assertBoundedString(projectId, "projectId");
    assertBoundedString(trackerNamespace, "trackerNamespace", 1_024);
    assertBoundedString(externalId, "externalId", 1_024);
    const row = this.db.prepare(
      `${ARTIFACT_SELECT} WHERE project_id = ? AND tracker_namespace = ? AND external_id = ?`,
    ).get(projectId, trackerNamespace, externalId) as ArtifactRow | undefined;
    return row ? parseArtifact(row) : null;
  }

  public prepareTrackerMutation(
    input: PrepareWorkArtifactTrackerMutationInput,
  ): WorkArtifactTrackerMutation {
    this.validateTrackerMutationKey(input);
    assertBoundedString(input.artifactId, "artifactId");
    if (
      input.kind !== "parent" && input.kind !== "owned_section" &&
      input.kind !== "resolve" && input.kind !== "cancel"
    ) {
      throw new TypeError("work artifact tracker mutation kind is invalid");
    }
    if (!/^[0-9a-f]{64}$/u.test(input.payloadDigest)) {
      throw new TypeError("work artifact tracker mutation payload digest is invalid");
    }
    if ((input.kind === "parent") !== (input.requestedParentExternalId !== null)) {
      throw new TypeError("parent tracker mutations require a requested parent");
    }
    if (input.requestedParentExternalId !== null) {
      assertBoundedString(input.requestedParentExternalId, "requestedParentExternalId", 1_024);
    }
    if (input.originalParentExternalId !== null) {
      assertBoundedString(input.originalParentExternalId, "originalParentExternalId", 1_024);
    }
    assertBoundedString(input.originalRevision, "originalRevision", 512);
    assertBoundedString(input.ownerId, "ownerId");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction(() => {
      const existing = this.getTrackerMutation(input);
      if (existing) {
        if (
          existing.artifactId !== input.artifactId || existing.kind !== input.kind ||
          existing.payloadDigest !== input.payloadDigest ||
          existing.requestedParentExternalId !== input.requestedParentExternalId ||
          existing.originalParentExternalId !== input.originalParentExternalId ||
          existing.originalRevision !== input.originalRevision
        ) {
          throw new TypeError("work artifact tracker mutation identity changed during replay");
        }
        return existing;
      }
      this.db.prepare(
        `INSERT INTO work_artifact_tracker_mutations (
           tracker_namespace, external_id, operation_id, artifact_id, kind, payload_digest,
           requested_parent_external_id, original_parent_external_id, original_revision,
           owner_id, generation, phase, status, last_observed_parent_external_id,
           last_observed_revision, reason, created_at, updated_at, settled_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 'pending', NULL, NULL, NULL, ?, ?, NULL)`,
      ).run(
        input.trackerNamespace,
        input.externalId,
        input.operationId,
        input.artifactId,
        input.kind,
        input.payloadDigest,
        input.requestedParentExternalId,
        input.originalParentExternalId,
        input.originalRevision,
        input.ownerId,
        input.generation,
        input.now,
        input.now,
      );
      return this.requireTrackerMutation(input);
    }).immediate();
  }

  public markTrackerMutationApplying(
    input: ApplyWorkArtifactTrackerMutationInput,
  ): WorkArtifactTrackerMutation {
    this.validateTrackerMutationKey(input);
    assertBoundedString(input.ownerId, "ownerId");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction(() => {
      const existing = this.requireTrackerMutation(input);
      if (
        !currentExecutorLease(this.db, input.ownerId, input.generation, input.now) ||
        (existing.phase !== "prepared" && existing.phase !== "applying")
      ) {
        throw new TypeError("tracker mutation cannot enter the applying phase");
      }
      if (existing.phase === "prepared") {
        this.db.prepare(
          `UPDATE work_artifact_tracker_mutations
              SET phase = 'applying', updated_at = ?
            WHERE tracker_namespace = ? AND external_id = ? AND operation_id = ?
              AND phase = 'prepared'`,
        ).run(input.now, input.trackerNamespace, input.externalId, input.operationId);
      }
      return this.requireTrackerMutation(input);
    }).immediate();
  }

  public completeTrackerMutation(
    input: SettleWorkArtifactTrackerMutationInput & Readonly<{
      ownerId: string;
      generation: number;
    }>,
  ): WorkArtifactTrackerMutation {
    this.validateTrackerMutationSettlement(input);
    assertBoundedString(input.ownerId, "ownerId");
    assertPositiveInteger(input.generation, "generation");
    return this.db.transaction(() => {
      const existing = this.requireTrackerMutation(input);
      if (existing.phase === "completed") return existing;
      if (
        existing.phase !== "applying" ||
        !currentExecutorLease(this.db, input.ownerId, input.generation, input.now)
      ) {
        throw new TypeError("tracker mutation cannot be completed");
      }
      this.db.prepare(
        `UPDATE work_artifact_tracker_mutations
            SET phase = 'completed', status = 'completed',
                last_observed_parent_external_id = ?, last_observed_revision = ?,
                reason = NULL, updated_at = ?, settled_at = ?
          WHERE tracker_namespace = ? AND external_id = ? AND operation_id = ?
            AND phase = 'applying'`,
      ).run(
        input.lastObservedParentExternalId,
        input.lastObservedRevision,
        input.now,
        input.now,
        input.trackerNamespace,
        input.externalId,
        input.operationId,
      );
      return this.requireTrackerMutation(input);
    }).immediate();
  }

  public markTrackerMutationIndeterminate(
    input: SettleWorkArtifactTrackerMutationInput & Readonly<{
      reason: string;
      ownerId: string;
      generation: number;
    }>,
  ): WorkArtifactTrackerMutation {
    this.validateTrackerMutationSettlement(input);
    const reason = assertBoundedString(input.reason, "tracker mutation indeterminate reason", 2_048);
    assertBoundedString(input.ownerId, "ownerId");
    assertPositiveInteger(input.generation, "generation");
    return this.db.transaction(() => {
      const existing = this.requireTrackerMutation(input);
      if (existing.phase === "indeterminate") return existing;
      if (
        existing.phase !== "applying" ||
        !currentExecutorLease(this.db, input.ownerId, input.generation, input.now)
      ) {
        throw new TypeError("only an applying tracker mutation can become indeterminate");
      }
      this.db.prepare(
        `UPDATE work_artifact_tracker_mutations
            SET phase = 'indeterminate', status = 'indeterminate',
                last_observed_parent_external_id = ?, last_observed_revision = ?,
                reason = ?, updated_at = ?, settled_at = ?
          WHERE tracker_namespace = ? AND external_id = ? AND operation_id = ?
            AND phase = 'applying'`,
      ).run(
        input.lastObservedParentExternalId,
        input.lastObservedRevision,
        reason,
        input.now,
        input.now,
        input.trackerNamespace,
        input.externalId,
        input.operationId,
      );
      return this.requireTrackerMutation(input);
    }).immediate();
  }

  public getTrackerMutation(input: WorkArtifactTrackerMutationKey): WorkArtifactTrackerMutation | null {
    this.validateTrackerMutationKey(input);
    const row = this.db.prepare(
      `${TRACKER_MUTATION_SELECT}
        WHERE tracker_namespace = ? AND external_id = ? AND operation_id = ?`,
    ).get(input.trackerNamespace, input.externalId, input.operationId) as TrackerMutationRow | undefined;
    return row ? parseTrackerMutation(row) : null;
  }

  public getSnapshot(id: string): WorkArtifactSnapshot | null {
    assertBoundedString(id, "snapshotId");
    const row = this.db.prepare(`${SNAPSHOT_SELECT} WHERE id = ?`).get(id) as SnapshotRow | undefined;
    return row ? parseSnapshot(row) : null;
  }

  public getCurrentSnapshot(artifactId: string): WorkArtifactSnapshot | null {
    const artifact = this.getArtifact(artifactId);
    return artifact ? this.getSnapshot(artifact.currentSnapshotId) : null;
  }

  public isSnapshotValid(snapshotIdValue: string): boolean {
    assertBoundedString(snapshotIdValue, "snapshotId");
    const pending = [snapshotIdValue];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const candidateId = pending.pop()!;
      if (visited.has(candidateId)) continue;
      visited.add(candidateId);
      const snapshot = this.getSnapshot(candidateId);
      if (!snapshot || this.getSnapshotInvalidation(candidateId)) return false;
      if (this.requireArtifact(snapshot.artifactId).currentSnapshotId !== candidateId) return false;
      pending.push(...this.snapshotDependencies(candidateId));
    }
    return true;
  }

  public getSnapshotInvalidation(snapshotIdValue: string): WorkArtifactSnapshotInvalidation | null {
    assertBoundedString(snapshotIdValue, "snapshotId");
    const row = this.db.prepare(
      `SELECT snapshot_id, replacement_snapshot_id, reason, observed_at
         FROM work_artifact_snapshot_invalidations WHERE snapshot_id = ?`,
    ).get(snapshotIdValue) as Readonly<{
      snapshot_id: string;
      replacement_snapshot_id: string;
      reason: WorkArtifactSnapshotInvalidation["reason"];
      observed_at: number;
    }> | undefined;
    return row ? {
      snapshotId: row.snapshot_id,
      replacementSnapshotId: row.replacement_snapshot_id,
      reason: row.reason,
      observedAt: row.observed_at,
    } : null;
  }

  public listRelationships(artifactId: string): readonly WorkArtifactRelationship[] {
    assertBoundedString(artifactId, "artifactId");
    const rows = this.db.prepare(
      `SELECT kind, source_artifact_id, source_ref, target_artifact_id, target_ref
         FROM work_artifact_relationships
        WHERE owner_artifact_id = ? ORDER BY ordinal ASC`,
    ).all(artifactId) as RelationshipRow[];
    return parsePersistedRelationships(artifactId, JSON.stringify(rows.map((row) => ({
      kind: row.kind,
      sourceArtifactId: row.source_artifact_id,
      sourceRef: row.source_ref,
      targetArtifactId: row.target_artifact_id,
      targetRef: row.target_ref,
    }))));
  }

  public listFrontier(parentArtifactId: string, requestedLimit: number): readonly WorkArtifact[] {
    assertBoundedString(parentArtifactId, "parentArtifactId");
    assertPositiveInteger(requestedLimit, "limit");
    const parentArtifact = this.requireArtifact(parentArtifactId);
    const rows = this.db.prepare(
      `${ARTIFACT_SELECT} AS artifact
        WHERE artifact.project_id = ? AND artifact.effort_id = ?
          AND artifact.status IN ('open', 'ready')
          AND artifact.external_status = 'open'
          AND json_array_length(artifact.assignees_json) = 0
          AND EXISTS (
            SELECT 1 FROM work_artifact_relationships AS parent
             WHERE parent.owner_artifact_id = artifact.id
               AND parent.kind = 'parent'
               AND parent.source_artifact_id = artifact.id
               AND parent.target_artifact_id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM work_artifact_claims AS claim
             WHERE claim.artifact_id = artifact.id AND claim.state = 'held'
          )
          AND NOT EXISTS (
            SELECT 1
              FROM work_artifact_relationships AS edge
              JOIN work_artifacts AS blocker ON blocker.id = edge.source_artifact_id
             WHERE edge.owner_artifact_id = artifact.id
               AND edge.kind = 'blocks'
               AND edge.target_artifact_id = artifact.id
               AND (
                 blocker.status NOT IN ('resolved', 'cancelled')
                 OR blocker.external_status = 'open'
               )
          )
        ORDER BY artifact.tracker_order ASC, artifact.created_at ASC, artifact.id ASC
        LIMIT ?`,
    ).all(
      parentArtifact.projectId,
      parentArtifact.effortId,
      parentArtifact.id,
      Math.min(requestedLimit, 100),
    ) as ArtifactRow[];
    return rows.map(parseArtifact);
  }

  public claimArtifact(input: ClaimWorkArtifactInput): WorkArtifactClaim | null {
    this.validateClaimFence(input);
    assertBoundedString(input.snapshotId, "snapshotId");
    return this.db.transaction((): WorkArtifactClaim | null => {
      if (!currentExecutorLease(this.db, input.ownerId, input.generation, input.now)) return null;
      const artifact = this.requireArtifact(input.artifactId);
      if (
        artifact.currentSnapshotId !== input.snapshotId ||
        !this.isSnapshotValid(input.snapshotId) ||
        artifact.externalStatus !== "open" ||
        artifact.assignees.length !== 1 || artifact.assignees[0] !== input.externalAssignee
      ) return null;
      const existing = this.getHeldClaim(input.artifactId);
      if (existing) {
        return existing.workflowStepId === input.workflowStepId &&
          existing.jobId === input.jobId &&
          existing.snapshotId === input.snapshotId &&
          existing.externalAssignee === input.externalAssignee &&
          existing.ownerId === input.ownerId &&
          existing.generation === input.generation &&
          existing.leaseExpiresAt > input.now
          ? existing
          : null;
      }
      if (artifact.status !== "open" && artifact.status !== "ready") return null;
      this.db.prepare(
        `INSERT INTO work_artifact_claims (
           artifact_id, workflow_step_id, job_id, snapshot_id, external_assignee,
           state, owner_id, generation, lease_expires_at, acquired_at,
           renewed_at, released_at, release_reason
         ) VALUES (?, ?, ?, ?, ?, 'held', ?, ?, ?, ?, ?, NULL, NULL)`,
      ).run(
        input.artifactId,
        input.workflowStepId,
        input.jobId,
        input.snapshotId,
        input.externalAssignee,
        input.ownerId,
        input.generation,
        input.now + input.leaseMs,
        input.now,
        input.now,
      );
      this.db.prepare(
        "UPDATE work_artifacts SET status = 'claimed', updated_at = ? WHERE id = ?",
      ).run(input.now, input.artifactId);
      return this.getHeldClaim(input.artifactId);
    }).immediate();
  }

  public preflightClaimIdentity(input: WorkArtifactClaimIdentity): void {
    const artifact = this.requireArtifact(assertBoundedString(input.artifactId, "artifactId"));
    assertBoundedString(input.workflowStepId, "workflowStepId");
    assertBoundedString(input.jobId, "jobId");
    const job = this.db.prepare(
      "SELECT project_id, state FROM jobs WHERE id = ?",
    ).get(input.jobId) as { project_id: string | null; state: string } | undefined;
    if (!job) {
      throw new TypeError("work artifact claim job does not exist");
    }
    if (job.project_id !== artifact.projectId) {
      throw new TypeError("work artifact claim job belongs to another project");
    }
    if (!CLAIM_ELIGIBLE_JOB_STATES.has(job.state)) {
      throw new TypeError("work artifact claim job is not in a claim-eligible state");
    }
  }

  public adoptArtifactClaim(input: AdoptWorkArtifactClaimInput): boolean {
    this.validateClaimFence(input);
    return this.db.transaction((): boolean => {
      if (!currentExecutorLease(this.db, input.ownerId, input.generation, input.now)) return false;
      const artifact = this.requireArtifact(input.artifactId);
      const claim = this.getHeldClaim(input.artifactId);
      if (
        !claim || claim.workflowStepId !== input.workflowStepId ||
        claim.jobId !== input.jobId ||
        claim.externalAssignee !== input.externalAssignee ||
        claim.snapshotId !== artifact.currentSnapshotId ||
        artifact.status !== "claimed" || artifact.externalStatus !== "open" ||
        artifact.assignees.length !== 1 || artifact.assignees[0] !== input.externalAssignee ||
        !this.isSnapshotValid(claim.snapshotId)
      ) return false;
      return this.db.prepare(
        `UPDATE work_artifact_claims
            SET owner_id = ?, generation = ?, lease_expires_at = ?, renewed_at = ?
          WHERE id = ? AND state = 'held'`,
      ).run(
        input.ownerId,
        input.generation,
        input.now + input.leaseMs,
        input.now,
        claim.id,
      ).changes === 1;
    }).immediate();
  }

  public renewArtifactClaim(input: RenewWorkArtifactClaimInput): boolean {
    this.validateClaimLeaseInput(input);
    return this.db.transaction((): boolean => {
      if (!currentExecutorLease(this.db, input.ownerId, input.generation, input.now)) return false;
      const claim = this.getClaim(input.claimId);
      if (!claim || claim.state !== "held" || claim.leaseExpiresAt <= input.now) return false;
      const artifact = this.requireArtifact(claim.artifactId);
      if (
        artifact.status !== "claimed" || artifact.externalStatus !== "open" ||
        artifact.assignees.length !== 1 || artifact.assignees[0] !== claim.externalAssignee ||
        !this.isSnapshotValid(claim.snapshotId)
      ) {
        return false;
      }
      return this.db.prepare(
        `UPDATE work_artifact_claims
            SET lease_expires_at = ?, renewed_at = ?
          WHERE id = ? AND state = 'held' AND owner_id = ? AND generation = ?
            AND lease_expires_at > ?`,
      ).run(
        input.now + input.leaseMs,
        input.now,
        input.claimId,
        input.ownerId,
        input.generation,
        input.now,
      ).changes === 1;
    }).immediate();
  }

  public releaseArtifactClaim(input: ReleaseWorkArtifactClaimInput): boolean {
    assertPositiveInteger(input.claimId, "claimId");
    assertBoundedString(input.ownerId, "ownerId");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
    const reason = assertBoundedString(input.reason, "release reason");
    return this.db.transaction((): boolean => {
      const claim = this.getClaim(input.claimId);
      if (!claim) return false;
      if (claim.state === "released") {
        return claim.ownerId === input.ownerId && claim.generation === input.generation &&
          claim.releaseReason === reason;
      }
      if (claim.state !== "held") return false;
      if (!currentExecutorLease(this.db, input.ownerId, input.generation, input.now)) return false;
      const updated = this.db.prepare(
        `UPDATE work_artifact_claims
            SET state = 'released', released_at = ?, release_reason = ?
          WHERE id = ? AND state = 'held' AND owner_id = ? AND generation = ?`,
      ).run(input.now, reason, input.claimId, input.ownerId, input.generation);
      if (updated.changes !== 1) return false;
      this.db.prepare(
        `UPDATE work_artifacts SET status = 'ready', updated_at = ?
          WHERE id = ? AND status = 'claimed'`,
      ).run(input.now, claim.artifactId);
      return true;
    }).immediate();
  }

  public getHeldClaim(artifactId: string): WorkArtifactClaim | null {
    assertBoundedString(artifactId, "artifactId");
    const row = this.db.prepare(
      `${CLAIM_SELECT} WHERE artifact_id = ? AND state = 'held'`,
    ).get(artifactId) as ClaimRow | undefined;
    return row ? parseClaim(row) : null;
  }

  public getClaim(claimId: number): WorkArtifactClaim | null {
    assertPositiveInteger(claimId, "claimId");
    const row = this.db.prepare(`${CLAIM_SELECT} WHERE id = ?`).get(claimId) as ClaimRow | undefined;
    return row ? parseClaim(row) : null;
  }

  public authorizeArtifactResolution(
    input: AuthorizeWorkArtifactResolutionInput,
  ): WorkArtifactResolutionIntent | null {
    const artifactId = assertBoundedString(input.artifactId, "artifactId");
    const operationId = assertBoundedString(input.operationId, "operationId");
    if (input.outcome !== "resolved" && input.outcome !== "cancelled") {
      throw new TypeError("artifact resolution outcome is invalid");
    }
    const snapshotIdValue = assertBoundedString(input.snapshotId, "snapshotId");
    const expectedExternalRevision = assertBoundedString(
      input.expectedExternalRevision,
      "expectedExternalRevision",
      512,
    );
    assertNonNegativeInteger(input.now, "now");
    const evidenceRefs = normalizeStringList(
      input.evidenceRefs,
      "resolution evidence",
      128,
      1_024,
      true,
    );
    if (evidenceRefs.length === 0) throw new TypeError("artifact resolution requires evidence");
    const intentId = resolutionIntentId(artifactId, operationId);
    return this.db.transaction((): WorkArtifactResolutionIntent | null => {
      const artifact = this.getArtifact(artifactId);
      if (!artifact) return null;
      const existing = this.getResolutionIntent(intentId);
      if (existing) {
        const completed = this.getResolution(artifactId);
        const authorizationStillApplies = existing.expectedExternalRevision === expectedExternalRevision ||
          (artifact.currentSnapshotId === existing.snapshotId && this.isSnapshotValid(existing.snapshotId));
        return (!completed || completed.intentId === existing.id) &&
          existing.artifactId === artifactId && existing.operationId === operationId &&
          existing.outcome === input.outcome && existing.snapshotId === snapshotIdValue &&
          authorizationStillApplies &&
          JSON.stringify(existing.evidenceRefs) === JSON.stringify(evidenceRefs)
          ? existing
          : null;
      }
      if (
        this.getResolution(artifactId) || this.getHeldClaim(artifactId) ||
        (artifact.status !== "open" && artifact.status !== "ready") ||
        artifact.currentSnapshotId !== snapshotIdValue ||
        artifact.externalRevision !== expectedExternalRevision ||
        !this.isSnapshotValid(snapshotIdValue)
      ) return null;
      this.assertAuthoritativeResolutionEvidence(artifact, input.outcome, evidenceRefs, input.now);
      this.db.prepare(
        `INSERT INTO work_artifact_resolution_intents (
           id, artifact_id, operation_id, outcome, snapshot_id,
           expected_external_revision, evidence_refs_json, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        intentId,
        artifactId,
        operationId,
        input.outcome,
        snapshotIdValue,
        expectedExternalRevision,
        JSON.stringify(evidenceRefs),
        input.now,
      );
      return this.getResolutionIntent(intentId);
    }).immediate();
  }

  public finalizeArtifactResolution(
    input: FinalizeWorkArtifactResolutionInput,
  ): WorkArtifact | null {
    const intentId = assertBoundedString(input.intentId, "intentId");
    const externalRevision = assertBoundedString(input.externalRevision, "externalRevision", 512);
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): WorkArtifact | null => {
      const intent = this.getResolutionIntent(intentId);
      if (!intent) return null;
      const artifact = this.getArtifact(intent.artifactId);
      if (!artifact) return null;
      const existing = this.getResolution(intent.artifactId);
      if (existing) {
        return existing.intentId === intent.id
          ? artifact
          : null;
      }
      const requiredExternalStatus = intent.outcome === "resolved" ? "closed" : "cancelled";
      if (
        this.getHeldClaim(artifact.id) ||
        (artifact.status !== "open" && artifact.status !== "ready") ||
        artifact.currentSnapshotId !== intent.snapshotId ||
        artifact.externalRevision !== externalRevision ||
        artifact.externalStatus !== requiredExternalStatus ||
        !this.isSnapshotValid(intent.snapshotId)
      ) return null;
      this.db.prepare(
        `INSERT INTO work_artifact_resolutions (
           artifact_id, intent_id, operation_id, outcome, snapshot_id,
           external_revision, evidence_refs_json, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        artifact.id,
        intent.id,
        intent.operationId,
        intent.outcome,
        intent.snapshotId,
        externalRevision,
        JSON.stringify(intent.evidenceRefs),
        input.now,
      );
      this.db.prepare(
        "UPDATE work_artifacts SET status = ?, updated_at = ? WHERE id = ?",
      ).run(intent.outcome, input.now, artifact.id);
      return this.requireArtifact(artifact.id);
    }).immediate();
  }

  public getResolutionIntent(intentId: string): WorkArtifactResolutionIntent | null {
    assertBoundedString(intentId, "intentId");
    const row = this.db.prepare(`${RESOLUTION_INTENT_SELECT} WHERE id = ?`)
      .get(intentId) as ResolutionIntentRow | undefined;
    return row ? parseResolutionIntent(row) : null;
  }

  public getResolution(artifactId: string): WorkArtifactResolution | null {
    assertBoundedString(artifactId, "artifactId");
    const row = this.db.prepare(`${RESOLUTION_SELECT} WHERE artifact_id = ?`)
      .get(artifactId) as ResolutionRow | undefined;
    return row ? parseResolution(row) : null;
  }

  private observeInTransaction(input: ObserveWorkArtifactInput): WorkArtifactCapture {
    const artifact = this.requireArtifact(input.artifactId);
    assertNonNegativeInteger(input.observedAt, "observedAt");
    const expectedExternalRevision = assertBoundedString(
      input.expectedExternalRevision,
      "expectedExternalRevision",
      512,
    );
    if (artifact.externalRevision !== expectedExternalRevision) {
      throw new WorkArtifactObservationConflictError(artifact.id);
    }
    const externalRevision = assertBoundedString(input.externalRevision, "externalRevision", 512);
    assertExternalArtifactStatus(input.externalStatus);
    const assignees = normalizeStringList(input.assignees, "artifact assignees", 64, 256, true);
    const normalized = normalizedSnapshotInput(input);
    this.assertRelationshipArtifactsInEffort(
      artifact.id,
      artifact.projectId,
      artifact.effortId,
      normalized.relationships,
    );
    const current = this.requireSnapshot(artifact.currentSnapshotId);
    const heldClaim = this.getHeldClaim(artifact.id);
    const visibleClaimChanged = heldClaim !== null &&
      (assignees.length !== 1 || assignees[0] !== heldClaim.externalAssignee);
    const terminalClaimChanged = heldClaim !== null && input.externalStatus !== "open";
    if (current.snapshotDigest === normalized.snapshotDigest) {
      if (terminalClaimChanged) {
        this.invalidateHeldClaim(artifact.id, input.observedAt, "external_closed");
      } else if (visibleClaimChanged) {
        this.invalidateHeldClaim(artifact.id, input.observedAt, "visible_claim_changed");
      }
      this.updateExternalObservation(
        artifact.id,
        externalRevision,
        input.externalStatus,
        assignees,
        normalized.title,
        input.observedAt,
      );
      return { artifact: this.requireArtifact(artifact.id), snapshot: current };
    }

    const revision = artifact.currentRevision + 1;
    const snapshot = this.insertSnapshot({
      artifactId: artifact.id,
      revision,
      externalRevision,
      capturedAt: input.observedAt,
      ...normalized,
    });
    const reason = current.contentDigest === snapshot.contentDigest &&
      current.title === snapshot.title &&
      JSON.stringify(current.acceptanceCriteria) === JSON.stringify(snapshot.acceptanceCriteria)
      ? "relationship_change"
      : "remote_edit";
    this.db.prepare(
      `INSERT INTO work_artifact_snapshot_invalidations (
         snapshot_id, replacement_snapshot_id, reason, observed_at
       ) VALUES (?, ?, ?, ?)`,
    ).run(current.id, snapshot.id, reason, input.observedAt);
    if (heldClaim?.snapshotId === current.id) {
      this.invalidateHeldClaim(artifact.id, input.observedAt, reason);
    } else if (visibleClaimChanged) {
      this.invalidateHeldClaim(artifact.id, input.observedAt, "visible_claim_changed");
    }
    this.replaceRelationships(artifact.id, normalized.relationships, input.observedAt);
    this.db.prepare(
      `UPDATE work_artifacts
          SET external_revision = ?, external_status = ?, assignees_json = ?,
              title = ?, current_revision = ?, current_snapshot_id = ?,
              remote_closed_at = CASE
                WHEN ? = 'open' THEN remote_closed_at
                ELSE coalesce(remote_closed_at, ?)
              END,
              status = CASE WHEN status = 'claimed' THEN 'ready' ELSE status END,
              updated_at = ?
        WHERE id = ?`,
    ).run(
      externalRevision,
      input.externalStatus,
      JSON.stringify(assignees),
      normalized.title,
      revision,
      snapshot.id,
      input.externalStatus,
      input.observedAt,
      input.observedAt,
      artifact.id,
    );
    return { artifact: this.requireArtifact(artifact.id), snapshot };
  }

  private snapshotDependencies(snapshotIdValue: string): readonly string[] {
    const rows = this.db.prepare(
      `SELECT upstream_snapshot_id
         FROM work_artifact_snapshot_dependencies
        WHERE snapshot_id = ?`,
    ).all(snapshotIdValue) as readonly Readonly<{ upstream_snapshot_id: string }>[];
    return rows.map((row) => row.upstream_snapshot_id);
  }

  private insertSnapshot(input: Readonly<{
    artifactId: string;
    revision: number;
    title: string;
    content: string;
    contentDigest: string;
    snapshotDigest: string;
    acceptanceCriteria: readonly string[];
    relationships: readonly WorkArtifactRelationship[];
    externalRevision: string;
    capturedAt: number;
  }>): WorkArtifactSnapshot {
    const id = snapshotId(input.artifactId, input.revision, input.snapshotDigest);
    this.db.prepare(
      `INSERT INTO work_artifact_snapshots (
         id, artifact_id, revision, title, content, content_digest,
         snapshot_digest, acceptance_criteria_json, relationships_json,
         external_revision, captured_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.artifactId,
      input.revision,
      input.title,
      input.content,
      input.contentDigest,
      input.snapshotDigest,
      JSON.stringify(input.acceptanceCriteria),
      JSON.stringify(input.relationships),
      input.externalRevision,
      input.capturedAt,
    );
    const dependencyIds = input.relationships
      .filter((relationship) => relationship.kind === "derived_from")
      .map((relationship) => relationship.targetArtifactId)
      .filter((artifactId): artifactId is string => artifactId !== null)
      .map((artifactId) => this.requireArtifact(artifactId).currentSnapshotId);
    const insertDependency = this.db.prepare(
      `INSERT INTO work_artifact_snapshot_dependencies (snapshot_id, upstream_snapshot_id)
       VALUES (?, ?)`,
    );
    for (const upstreamSnapshotId of new Set(dependencyIds)) {
      insertDependency.run(id, upstreamSnapshotId);
    }
    return this.requireSnapshot(id);
  }

  private replaceRelationships(
    artifactId: string,
    relationships: readonly WorkArtifactRelationship[],
    now: number,
  ): void {
    this.db.prepare("DELETE FROM work_artifact_relationships WHERE owner_artifact_id = ?")
      .run(artifactId);
    const insert = this.db.prepare(
      `INSERT INTO work_artifact_relationships (
         owner_artifact_id, ordinal, kind, source_artifact_id, source_ref,
         target_artifact_id, target_ref, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    relationships.forEach((relationship, ordinal) => insert.run(
      artifactId,
      ordinal,
      relationship.kind,
      relationship.sourceArtifactId,
      relationship.sourceRef,
      relationship.targetArtifactId,
      relationship.targetRef,
      now,
    ));
  }

  private assertRelationshipArtifactsInEffort(
    owningArtifactId: string,
    projectId: string,
    effortId: string,
    relationships: readonly WorkArtifactRelationship[],
  ): void {
    for (const relationship of relationships) {
      for (const artifactId of [relationship.sourceArtifactId, relationship.targetArtifactId]) {
        if (artifactId !== null && artifactId !== owningArtifactId) {
          const related = this.readArtifactRow(artifactId);
          if (!related) throw new TypeError(`relationship artifact ${artifactId} does not exist`);
          if (related.project_id !== projectId || related.effort_id !== effortId) {
            throw new TypeError("relationship artifacts must belong to the same project and effort");
          }
        }
      }
    }
  }

  private invalidateHeldClaim(artifactId: string, now: number, reason: string): void {
    this.db.prepare(
      `UPDATE work_artifact_claims
          SET state = 'invalidated', released_at = ?, release_reason = ?
        WHERE artifact_id = ? AND state = 'held'`,
    ).run(now, reason, artifactId);
    this.db.prepare(
      `UPDATE work_artifacts SET status = 'ready', updated_at = ?
        WHERE id = ? AND status = 'claimed'`,
    ).run(now, artifactId);
  }

  private updateExternalObservation(
    artifactId: string,
    externalRevision: string,
    externalStatus: ExternalArtifactStatus,
    assignees: readonly string[],
    title: string,
    now: number,
  ): void {
    this.db.prepare(
      `UPDATE work_artifacts
          SET external_revision = ?, external_status = ?, assignees_json = ?,
              title = ?, remote_closed_at = CASE
                WHEN ? = 'open' THEN remote_closed_at
                ELSE coalesce(remote_closed_at, ?)
              END, updated_at = ?
        WHERE id = ?`,
    ).run(
      externalRevision,
      externalStatus,
      JSON.stringify(assignees),
      title,
      externalStatus,
      now,
      now,
      artifactId,
    );
  }

  private assertAuthoritativeResolutionEvidence(
    artifact: WorkArtifact,
    outcome: WorkArtifactResolution["outcome"],
    evidenceRefs: readonly string[],
    now: number,
  ): void {
    const artifactSubject = `work-artifact:${artifact.id}`;
    const snapshotSubject = `work-artifact-snapshot:${artifact.currentSnapshotId}`;
    for (const evidenceRef of evidenceRefs) {
      const navigatorMatch = /^navigator-result:([A-Za-z0-9_-]{1,256})$/u.exec(evidenceRef);
      if (navigatorMatch) {
        const authorized = outcome === "resolved"
          ? this.navigatorResultAuthorizesResolution(navigatorMatch[1], artifact)
          : this.navigatorResultAuthorizesPublicationSupersession(navigatorMatch[1], artifact);
        if (!authorized) {
          throw new TypeError("artifact resolution requires authoritative evidence for its current snapshot");
        }
        continue;
      }
      const match = /^evidence:([1-9][0-9]*)$/u.exec(evidenceRef);
      if (!match) throw new TypeError("artifact resolution requires authoritative evidence references");
      const evidenceId = Number(match[1]);
      if (!Number.isSafeInteger(evidenceId)) {
        throw new TypeError("artifact resolution requires authoritative evidence references");
      }
      const row = this.db.prepare(
        `SELECT evidence.outcome, evidence.subject_refs_json, evidence.observed_at,
                controller.project_id
           FROM controller_evidence AS evidence
           JOIN controller_threads AS controller
             ON controller.controller_key = evidence.controller_key
          WHERE evidence.id = ?`,
      ).get(evidenceId) as Readonly<{
        outcome: "observed" | "succeeded" | "failed" | "interrupted" | "denied";
        subject_refs_json: string;
        observed_at: number;
        project_id: string | null;
      }> | undefined;
      const allowedOutcome = outcome === "resolved"
        ? row?.outcome === "succeeded"
        : row?.outcome === "observed" || row?.outcome === "succeeded" || row?.outcome === "denied";
      const subjects = row ? parseStringArray(row.subject_refs_json, "controller evidence subjects") : [];
      if (
        !row || !allowedOutcome || row.project_id !== artifact.projectId || row.observed_at > now ||
        !subjects.includes(artifactSubject) || !subjects.includes(snapshotSubject)
      ) {
        throw new TypeError("artifact resolution requires authoritative evidence for its current snapshot");
      }
    }
  }

  private navigatorResultAuthorizesResolution(attemptId: string, artifact: WorkArtifact): boolean {
    return this.db.prepare(
      `SELECT 1
         FROM navigator_planning_results AS result
         JOIN navigator_skill_attempts AS attempt ON attempt.id = result.attempt_id
         JOIN jobs AS job ON job.id = attempt.job_id
         JOIN json_each(attempt.artifact_bindings_json) AS binding
        WHERE result.attempt_id = ? AND result.skill_id IN ('research', 'prototype')
          AND job.project_id = ?
          AND json_extract(binding.value, '$.artifactId') = ?
          AND json_extract(binding.value, '$.snapshotId') = ?`,
    ).get(attemptId, artifact.projectId, artifact.id, artifact.currentSnapshotId) !== undefined;
  }

  private navigatorResultAuthorizesPublicationSupersession(
    attemptId: string,
    artifact: WorkArtifact,
  ): boolean {
    const row = this.db.prepare(
      `SELECT result.skill_id, attempt.workflow_step_id
         FROM navigator_planning_results AS result
         JOIN navigator_skill_attempts AS attempt ON attempt.id = result.attempt_id
         JOIN jobs AS job ON job.id = attempt.job_id
        WHERE result.attempt_id = ? AND job.id = ? AND job.project_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM json_each(job.artifact_bindings_json) AS binding
             WHERE json_extract(binding.value, '$.artifactId') = ?
          )`,
    ).get(attemptId, artifact.effortId, artifact.projectId, artifact.id) as Readonly<{
      skill_id: string;
      workflow_step_id: string;
    }> | undefined;
    if (!row || artifact.id !== stableWorkArtifactId(artifact.projectId, artifact.operationId)) return false;
    const operation = artifact.operationId.slice(`${row.workflow_step_id}:`.length);
    if (!artifact.operationId.startsWith(`${row.workflow_step_id}:`)) return false;
    if (row.skill_id === "wayfinder") return operation === "map" || /^decision:[0-9]+$/u.test(operation);
    if (row.skill_id === "to-spec") return operation === "specification";
    return row.skill_id === "to-tickets" && /^ticket:[0-9]+$/u.test(operation);
  }

  private validateCapture(input: CaptureWorkArtifactInput) {
    const normalized = validateCaptureDraft(input);
    assertBoundedString(input.externalId, "externalId", 1_024);
    if (input.externalUrl !== null) assertBoundedString(input.externalUrl, "externalUrl", 2_048);
    assertBoundedString(input.externalRevision, "externalRevision", 512);
    assertExternalArtifactStatus(input.externalStatus);
    return normalized;
  }

  private assertCaptureReplay(row: ArtifactRow, input: CaptureWorkArtifactInput): void {
    const artifact = parseArtifact(row);
    if (
      artifact.projectId !== input.projectId || artifact.effortId !== input.effortId ||
      artifact.operationId !== input.operationId || artifact.kind !== input.kind ||
      row.initial_status !== input.status || artifact.trackerOrder !== (input.trackerOrder ?? 0) ||
      artifact.trackerKind !== input.trackerKind ||
      artifact.trackerNamespace !== input.trackerNamespace || artifact.externalId !== input.externalId
    ) {
      throw new TypeError("work artifact identity changed during capture replay");
    }
  }

  private validateTrackerMutationKey(input: WorkArtifactTrackerMutationKey): void {
    assertBoundedString(input.trackerNamespace, "trackerNamespace", 1_024);
    assertBoundedString(input.externalId, "externalId", 1_024);
    assertBoundedString(input.operationId, "operationId");
  }

  private validateTrackerMutationSettlement(
    input: SettleWorkArtifactTrackerMutationInput,
  ): void {
    this.validateTrackerMutationKey(input);
    if (input.lastObservedParentExternalId !== null) {
      assertBoundedString(
        input.lastObservedParentExternalId,
        "lastObservedParentExternalId",
        1_024,
      );
    }
    assertBoundedString(input.lastObservedRevision, "lastObservedRevision", 512);
    assertNonNegativeInteger(input.now, "now");
  }

  private requireTrackerMutation(
    input: WorkArtifactTrackerMutationKey,
  ): WorkArtifactTrackerMutation {
    const mutation = this.getTrackerMutation(input);
    if (!mutation) throw new Error("work artifact tracker mutation was not found");
    return mutation;
  }

  private validateClaimFence(input: Readonly<{
    artifactId: string;
    workflowStepId: string;
    jobId: string;
    externalAssignee: string;
    ownerId: string;
    generation: number;
    now: number;
    leaseMs: number;
  }>): void {
    assertBoundedString(input.artifactId, "artifactId");
    this.preflightClaimIdentity(input);
    assertBoundedString(input.externalAssignee, "externalAssignee");
    assertBoundedString(input.ownerId, "ownerId");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
    assertPositiveInteger(input.leaseMs, "leaseMs");
  }

  private validateClaimLeaseInput(input: RenewWorkArtifactClaimInput): void {
    assertPositiveInteger(input.claimId, "claimId");
    assertBoundedString(input.ownerId, "ownerId");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
    assertPositiveInteger(input.leaseMs, "leaseMs");
  }

  private readArtifactRow(id: string): ArtifactRow | undefined {
    return this.db.prepare(`${ARTIFACT_SELECT} WHERE id = ?`).get(id) as ArtifactRow | undefined;
  }

  private requireArtifact(id: string): WorkArtifact {
    const row = this.readArtifactRow(id);
    if (!row) throw new Error(`Work artifact ${id} was not found`);
    return parseArtifact(row);
  }

  private requireSnapshot(id: string): WorkArtifactSnapshot {
    const row = this.db.prepare(`${SNAPSHOT_SELECT} WHERE id = ?`).get(id) as SnapshotRow | undefined;
    if (!row) throw new Error(`Work artifact snapshot ${id} was not found`);
    return parseSnapshot(row);
  }
}

export function workArtifactReferenceDocument(
  artifact: WorkArtifact,
  snapshot: WorkArtifactSnapshot,
  now: number,
): SaveReferenceDocumentInput {
  if (snapshot.artifactId !== artifact.id) {
    throw new TypeError("artifact reference snapshot belongs to another artifact");
  }
  assertNonNegativeInteger(now, "now");
  return {
    scope: "project",
    projectId: artifact.projectId,
    title: `Work artifact ${artifact.id}`,
    source: `work-artifact:${artifact.id}`,
    markdown: snapshot.content,
    now,
  };
}
