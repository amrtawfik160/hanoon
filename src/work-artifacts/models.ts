import { createHash } from "node:crypto";

export const WORK_ARTIFACT_KINDS = [
  "map",
  "specification",
  "decision_ticket",
  "implementation_ticket",
] as const;
export type WorkArtifactKind = (typeof WORK_ARTIFACT_KINDS)[number];

export const WORK_ARTIFACT_STATUSES = [
  "open",
  "ready",
  "claimed",
  "resolved",
  "cancelled",
] as const;
export type WorkArtifactStatus = (typeof WORK_ARTIFACT_STATUSES)[number];

export const WORK_TRACKER_KINDS = ["github", "local_markdown"] as const;
export type WorkTrackerKind = (typeof WORK_TRACKER_KINDS)[number];

export const EXTERNAL_ARTIFACT_STATUSES = ["open", "closed", "cancelled"] as const;
export type ExternalArtifactStatus = (typeof EXTERNAL_ARTIFACT_STATUSES)[number];

export const WORK_ARTIFACT_RELATIONSHIP_KINDS = [
  "parent",
  "blocks",
  "derived_from",
  "executed_by",
  "delivered_by",
] as const;
export const WORK_ARTIFACT_RELATIONSHIP_VALIDATOR_FUNCTION =
  "hanoon_work_artifact_relationships_valid";
export type WorkArtifactRelationshipKind = (typeof WORK_ARTIFACT_RELATIONSHIP_KINDS)[number];

export type WorkArtifactRelationship = Readonly<{
  kind: WorkArtifactRelationshipKind;
  sourceArtifactId: string | null;
  sourceRef: string;
  targetArtifactId: string | null;
  targetRef: string;
}>;

export type WorkArtifact = Readonly<{
  id: string;
  projectId: string;
  effortId: string;
  operationId: string;
  kind: WorkArtifactKind;
  status: WorkArtifactStatus;
  trackerKind: WorkTrackerKind;
  trackerNamespace: string;
  externalId: string;
  externalUrl: string | null;
  externalRevision: string;
  externalStatus: ExternalArtifactStatus;
  assignees: readonly string[];
  title: string;
  trackerOrder: number;
  currentRevision: number;
  currentSnapshotId: string;
  remoteClosedAt: number | null;
  createdAt: number;
  updatedAt: number;
}>;

export type WorkArtifactSnapshot = Readonly<{
  id: string;
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
}>;

export type WorkArtifactSnapshotInvalidation = Readonly<{
  snapshotId: string;
  replacementSnapshotId: string;
  reason: "remote_edit" | "relationship_change";
  observedAt: number;
}>;

export type WorkArtifactClaim = Readonly<{
  id: number;
  artifactId: string;
  workflowStepId: string;
  jobId: string;
  snapshotId: string;
  externalAssignee: string;
  state: "held" | "released" | "invalidated";
  ownerId: string;
  generation: number;
  leaseExpiresAt: number;
  acquiredAt: number;
  renewedAt: number;
  releasedAt: number | null;
  releaseReason: string | null;
}>;

export type WorkArtifactResolution = Readonly<{
  artifactId: string;
  intentId: string;
  operationId: string;
  outcome: "resolved" | "cancelled";
  snapshotId: string;
  externalRevision: string;
  evidenceRefs: readonly string[];
  recordedAt: number;
}>;

export type WorkArtifactResolutionIntent = Readonly<{
  id: string;
  artifactId: string;
  operationId: string;
  outcome: WorkArtifactResolution["outcome"];
  snapshotId: string;
  expectedExternalRevision: string;
  evidenceRefs: readonly string[];
  recordedAt: number;
}>;

const KIND_SET: ReadonlySet<string> = new Set(WORK_ARTIFACT_KINDS);
const STATUS_SET: ReadonlySet<string> = new Set(WORK_ARTIFACT_STATUSES);
const TRACKER_SET: ReadonlySet<string> = new Set(WORK_TRACKER_KINDS);
const EXTERNAL_STATUS_SET: ReadonlySet<string> = new Set(EXTERNAL_ARTIFACT_STATUSES);
const RELATIONSHIP_SET: ReadonlySet<string> = new Set(WORK_ARTIFACT_RELATIONSHIP_KINDS);

export function assertBoundedString(value: string, field: string, maximum = 256): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new TypeError(`${field} must be between 1 and ${maximum} characters`);
  }
  return normalized;
}

export function normalizeSingleLine(value: string, field: string, maximum = 256): string {
  return assertBoundedString(value, field, maximum).replace(/\s+/gu, " ");
}

export function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
}

export function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

export function assertWorkArtifactKind(value: string): asserts value is WorkArtifactKind {
  if (!KIND_SET.has(value)) throw new TypeError(`Unknown work artifact kind: ${value}`);
}

export function assertWorkArtifactStatus(value: string): asserts value is WorkArtifactStatus {
  if (!STATUS_SET.has(value)) throw new TypeError(`Unknown work artifact status: ${value}`);
}

export function assertWorkTrackerKind(value: string): asserts value is WorkTrackerKind {
  if (!TRACKER_SET.has(value)) throw new TypeError(`Unknown work tracker kind: ${value}`);
}

export function assertExternalArtifactStatus(value: string): asserts value is ExternalArtifactStatus {
  if (!EXTERNAL_STATUS_SET.has(value)) throw new TypeError(`Unknown external artifact status: ${value}`);
}

export function assertRelationshipKind(value: string): asserts value is WorkArtifactRelationshipKind {
  if (!RELATIONSHIP_SET.has(value)) throw new TypeError(`Unknown work artifact relationship: ${value}`);
}

export function normalizeArtifactContent(content: string): string {
  if (typeof content !== "string") throw new TypeError("artifact content must be a string");
  const normalized = content
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/gu, ""))
    .join("\n")
    .trim();
  if (normalized.length === 0 || normalized.length > 1_048_576) {
    throw new TypeError("artifact content must be between 1 and 1048576 characters");
  }
  return normalized;
}

export function normalizeStringList(
  values: readonly string[],
  field: string,
  maximumItems = 128,
  maximumLength = 1_024,
  sort = false,
): readonly string[] {
  if (!Array.isArray(values) || values.length > maximumItems) {
    throw new TypeError(`${field} must contain at most ${maximumItems} items`);
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const item = assertBoundedString(value, `${field} item`, maximumLength);
    if (seen.has(item)) continue;
    seen.add(item);
    normalized.push(item);
  }
  return sort ? normalized.sort((left, right) => left.localeCompare(right)) : normalized;
}

function relationshipKey(relationship: WorkArtifactRelationship): string {
  return [
    relationship.kind,
    relationship.sourceRef,
    relationship.targetRef,
    relationship.sourceArtifactId ?? "",
    relationship.targetArtifactId ?? "",
  ].join("\u0000");
}

function normalizeRelationshipRef(
  value: string,
  artifactId: string | null,
  field: string,
): string {
  const normalized = assertBoundedString(value, field, 1_024);
  if (
    artifactId !== null
      ? value !== normalized || normalized !== `artifact:${artifactId}`
      : normalized.startsWith("artifact:") || value.startsWith("artifact:")
  ) {
    throw new TypeError(`${field} is an invalid reserved internal ref`);
  }
  return normalized;
}

export function normalizeRelationships(
  artifactId: string,
  relationships: readonly WorkArtifactRelationship[],
): readonly WorkArtifactRelationship[] {
  if (!Array.isArray(relationships) || relationships.length > 256) {
    throw new TypeError("artifact relationships must contain at most 256 items");
  }
  const normalized = relationships.map((relationship): WorkArtifactRelationship => {
    assertRelationshipKind(relationship.kind);
    const sourceArtifactId = relationship.sourceArtifactId === null
      ? null
      : assertBoundedString(relationship.sourceArtifactId, "relationship source artifact id");
    const targetArtifactId = relationship.targetArtifactId === null
      ? null
      : assertBoundedString(relationship.targetArtifactId, "relationship target artifact id");
    const sourceRef = normalizeRelationshipRef(
      relationship.sourceRef,
      sourceArtifactId,
      "relationship source ref",
    );
    const targetRef = normalizeRelationshipRef(
      relationship.targetRef,
      targetArtifactId,
      "relationship target ref",
    );
    const result = {
      kind: relationship.kind,
      sourceArtifactId,
      sourceRef,
      targetArtifactId,
      targetRef,
    } as const;
    if (sourceArtifactId !== artifactId && targetArtifactId !== artifactId) {
      throw new TypeError("a relationship must touch its owning artifact");
    }
    if (
      (sourceArtifactId !== null && targetArtifactId !== null &&
        sourceArtifactId === targetArtifactId) || sourceRef === targetRef
    ) {
      throw new TypeError("an artifact cannot relate to itself");
    }
    if (result.kind === "parent" && (sourceArtifactId !== artifactId || targetArtifactId === null)) {
      throw new TypeError("a parent relationship must point from the artifact to another artifact");
    }
    if (result.kind === "blocks" && (sourceArtifactId === null || targetArtifactId !== artifactId)) {
      throw new TypeError("a blocks relationship must point from a blocker to the artifact");
    }
    if (
      (result.kind === "derived_from" || result.kind === "executed_by" || result.kind === "delivered_by") &&
      sourceArtifactId !== artifactId
    ) {
      throw new TypeError(`${result.kind} must start at the owning artifact`);
    }
    return result;
  }).sort((left, right) => relationshipKey(left).localeCompare(relationshipKey(right)));
  const keys = normalized.map(relationshipKey);
  if (new Set(keys).size !== keys.length) throw new TypeError("artifact relationships contain a duplicate");
  if (normalized.filter((relationship) => relationship.kind === "parent").length > 1) {
    throw new TypeError("an artifact can have at most one parent relationship");
  }
  const blockerArtifactIds = normalized
    .filter((relationship) => relationship.kind === "blocks")
    .map((relationship) => relationship.sourceArtifactId);
  if (new Set(blockerArtifactIds).size !== blockerArtifactIds.length) {
    throw new TypeError("an artifact cannot repeat the same blocker relationship");
  }
  return normalized;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function stableWorkArtifactId(projectId: string, operationId: string): string {
  const project = assertBoundedString(projectId, "projectId");
  const operation = assertBoundedString(operationId, "operationId");
  return `artifact_${createHash("sha256")
    .update(`work-artifact:${project}:${operation}`, "utf8")
    .digest("base64url")
    .slice(0, 24)}`;
}

export function workArtifactSnapshotDigest(input: Readonly<{
  title: string;
  contentDigest: string;
  acceptanceCriteria: readonly string[];
  relationships: readonly WorkArtifactRelationship[];
}>): string {
  return sha256(JSON.stringify({
    title: input.title,
    contentDigest: input.contentDigest,
    acceptanceCriteria: input.acceptanceCriteria,
    relationships: input.relationships,
  }));
}
