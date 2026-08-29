import {
  assertBoundedString,
  normalizeArtifactContent,
  normalizeSingleLine,
  normalizeStringList,
  sha256,
  type WorkArtifactKind,
  type WorkTrackerKind,
} from "./models";

export type TrackerRelationshipMode = "native" | "body";
export type TrackerOperationStatus = "absent" | "pending" | "completed";

export type TrackerArtifact = Readonly<{
  trackerKind: WorkTrackerKind;
  externalId: string;
  url: string | null;
  revision: string;
  operationId: string;
  createDigest: string;
  kind: WorkArtifactKind;
  title: string;
  body: string;
  acceptanceCriteria: readonly string[];
  state: "open" | "closed" | "cancelled";
  assignees: readonly string[];
  comments: readonly string[];
  parentExternalId: string | null;
  blockerExternalIds: readonly string[];
  childExternalIds: readonly string[];
}>;

export type TrackerOperationEvidence = Readonly<{
  status: TrackerOperationStatus;
  artifact: TrackerArtifact;
}>;

export type CreateTrackerArtifactInput = Readonly<{
  operationId: string;
  kind: WorkArtifactKind;
  title: string;
  body: string;
  acceptanceCriteria: readonly string[];
  identityContext?: string;
}>;

type TrackerMutationIdentity = Readonly<{
  externalId: string;
  operationId: string;
  expectedRevision: string;
}>;

export type UpdateOwnedSectionInput = TrackerMutationIdentity & Readonly<{
  sectionId: string;
  content: string;
}>;

export type CommentTrackerArtifactInput = TrackerMutationIdentity & Readonly<{
  comment: string;
}>;

export type SetTrackerParentInput = TrackerMutationIdentity & Readonly<{
  parentExternalId: string;
}>;

export type SetTrackerBlockersInput = TrackerMutationIdentity & Readonly<{
  blockerExternalIds: readonly string[];
}>;

export type TrackerClaimInput = TrackerMutationIdentity & Readonly<{
  assignee: string;
}>;

export type ResolveTrackerArtifactInput = TrackerMutationIdentity & Readonly<{
  resolution: string;
}>;

export type CancelTrackerArtifactInput = TrackerMutationIdentity & Readonly<{
  reason: string;
}>;

export interface WorkTracker {
  readonly kind: WorkTrackerKind;
  readonly namespace: string;
  readonly relationships: Readonly<{
    parent: TrackerRelationshipMode;
    blockers: TrackerRelationshipMode;
  }>;
  create(input: CreateTrackerArtifactInput): Promise<TrackerArtifact>;
  read(externalId: string): Promise<TrackerArtifact>;
  updateOwnedSection(input: UpdateOwnedSectionInput): Promise<TrackerArtifact>;
  comment(input: CommentTrackerArtifactInput): Promise<TrackerArtifact>;
  setParent(input: SetTrackerParentInput): Promise<TrackerArtifact>;
  setBlockers(input: SetTrackerBlockersInput): Promise<TrackerArtifact>;
  frontier(input: Readonly<{ parentExternalId: string }>): Promise<readonly TrackerArtifact[]>;
  claim(input: TrackerClaimInput): Promise<TrackerArtifact>;
  renew(input: TrackerClaimInput): Promise<TrackerArtifact>;
  release(input: TrackerClaimInput): Promise<TrackerArtifact>;
  resolve(input: ResolveTrackerArtifactInput): Promise<TrackerArtifact>;
  cancel(input: CancelTrackerArtifactInput): Promise<TrackerArtifact>;
  operationStatus(input: Readonly<{
    externalId: string;
    operationId: string;
    payloadDigest: string;
  }>): Promise<TrackerOperationEvidence>;
  reconcile(input: Readonly<{ operationId: string }>): Promise<TrackerArtifact | null>;
}

export class TrackerConflictError extends Error {
  public constructor(externalId: string) {
    super(`Tracker artifact ${externalId} changed after it was observed`);
    this.name = "TrackerConflictError";
  }
}

export class TrackerNotFoundError extends Error {
  public constructor(externalId: string) {
    super(`Tracker artifact ${externalId} was not found`);
    this.name = "TrackerNotFoundError";
  }
}

export class TrackerIdentityConflictError extends Error {
  public constructor(operationId: string) {
    super(`Tracker operation ${operationId} is already bound to different content`);
    this.name = "TrackerIdentityConflictError";
  }
}

export type TrackerArtifactMetadata = Readonly<{
  operationId: string;
  createDigest: string;
  kind: WorkArtifactKind;
  acceptanceCriteria: readonly string[];
}>;

const META_PATTERN = /<!-- hanoon:artifact:([A-Za-z0-9_-]+) -->/u;
const META_MARKER_PATTERN = /<!-- hanoon:artifact:[A-Za-z0-9_-]+ -->/gu;
const OPERATION_PATTERN = /(?:\n\n)?<!-- hanoon:operation:[0-9a-f]{64}:[0-9a-f]{64} -->/gu;
const OWNED_MARKER_PATTERN = /<!-- hanoon:owned:([a-z][a-z0-9-]{0,63}):(start|end) -->/gu;
const RESERVED_MARKER_PATTERN = /<!-- hanoon:[^\r\n]* -->/gu;
const SECTION_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const ACCEPTANCE_SECTION_ID = "acceptance-criteria";

export function assertNoTrackerMarkers(value: string, field: string): void {
  if (value.includes("<!-- hanoon:")) {
    throw new TypeError(`${field} must not contain reserved tracker markers`);
  }
}

export function normalizeOperationId(operationId: string): string {
  return assertBoundedString(operationId, "operationId");
}

function assertPayloadDigest(payloadDigest: string): string {
  if (!/^[0-9a-f]{64}$/u.test(payloadDigest)) {
    throw new TypeError("tracker operation payload digest is invalid");
  }
  return payloadDigest;
}

export function operationMarkerPrefix(operationIdValue: string): string {
  const operationId = normalizeOperationId(operationIdValue);
  return `<!-- hanoon:operation:${sha256(operationId)}:`;
}

export function operationMarker(operationIdValue: string, payloadDigestValue: string): string {
  return `${operationMarkerPrefix(operationIdValue)}${assertPayloadDigest(payloadDigestValue)} -->`;
}

function operationPayloadDigest(kind: string, payload: unknown): string {
  return sha256(JSON.stringify({ kind, payload }));
}

export function ownedSectionPayloadDigest(input: Pick<UpdateOwnedSectionInput, "sectionId" | "content">): string {
  const sectionId = assertBoundedString(input.sectionId, "sectionId", 64);
  ownedSectionMarkers(sectionId);
  const content = normalizeArtifactContent(input.content);
  assertNoTrackerMarkers(content, "owned section content");
  return operationPayloadDigest("update_owned_section", { sectionId, content });
}

export function commentPayloadDigest(commentValue: string): string {
  const comment = normalizeArtifactContent(commentValue);
  assertNoTrackerMarkers(comment, "tracker comment");
  return operationPayloadDigest("comment", { comment });
}

export function parentPayloadDigest(parentExternalIdValue: string): string {
  const parentExternalId = assertBoundedString(parentExternalIdValue, "parentExternalId", 1_024);
  return operationPayloadDigest("set_parent", { parentExternalId });
}

export function blockersPayloadDigest(blockerExternalIds: readonly string[]): string {
  return operationPayloadDigest("set_blockers", {
    blockerExternalIds: normalizeTrackerExternalIds(blockerExternalIds, "blockerExternalIds"),
  });
}

export function claimPayloadDigest(
  action: "claim" | "renew" | "release",
  assigneeValue: string,
): string {
  const assignee = assertBoundedString(assigneeValue, "assignee");
  return operationPayloadDigest(action, { assignee });
}

export function terminalPayloadDigest(
  outcome: "resolved" | "cancelled",
  textValue: string,
): string {
  const field = outcome === "resolved" ? "resolution" : "cancellation reason";
  const text = normalizeArtifactContent(assertBoundedString(textValue, field, 65_536));
  assertNoTrackerMarkers(text, field);
  return operationPayloadDigest(outcome, { text });
}

export function hasOperationMarker(
  values: readonly string[],
  operationId: string,
  payloadDigest: string,
): boolean {
  const prefix = operationMarkerPrefix(operationId);
  const matches = values.flatMap((value) => {
    if (value.includes(prefix) && !value.includes(operationMarker(operationId, payloadDigest))) {
      throw new TrackerIdentityConflictError(operationId);
    }
    return value.match(new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}([0-9a-f]{64}) -->`, "gu")) ?? [];
  });
  if (matches.length === 0) return false;
  if (matches.some((marker) => marker !== operationMarker(operationId, payloadDigest))) {
    throw new TrackerIdentityConflictError(operationId);
  }
  return true;
}

export function normalizeAcceptanceCriteria(values: readonly string[]): readonly string[] {
  const criteria = normalizeStringList(values, "acceptance criteria", 128, 2_048);
  if (criteria.some((criterion) => /[\r\n\u2028\u2029]/u.test(criterion))) {
    throw new TypeError("acceptance criteria must contain one checklist item per value");
  }
  for (const criterion of criteria) assertNoTrackerMarkers(criterion, "acceptance criteria");
  return criteria;
}

export function trackerCreateDigest(input: CreateTrackerArtifactInput): string {
  const body = normalizeArtifactContent(input.body);
  assertNoTrackerMarkers(body, "artifact body");
  return sha256(JSON.stringify({
    kind: input.kind,
    title: normalizeTrackerTitle(input.title),
    body,
    acceptanceCriteria: normalizeAcceptanceCriteria(input.acceptanceCriteria),
    identityContext: input.identityContext === undefined
      ? null
      : assertBoundedString(input.identityContext, "create identity context", 1_024),
  }));
}

export function artifactMetadataMarker(input: CreateTrackerArtifactInput): string {
  const normalized: TrackerArtifactMetadata = {
    operationId: normalizeOperationId(input.operationId),
    createDigest: trackerCreateDigest(input),
    kind: input.kind,
    acceptanceCriteria: normalizeAcceptanceCriteria(input.acceptanceCriteria),
  };
  return `<!-- hanoon:artifact:${Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url")} -->`;
}

export function parseArtifactMetadata(body: string): TrackerArtifactMetadata {
  if ((body.match(META_MARKER_PATTERN) ?? []).length !== 1) {
    throw new TrackerIdentityConflictError("invalid-metadata-count");
  }
  const match = META_PATTERN.exec(body);
  if (!match) throw new TrackerIdentityConflictError("missing-metadata");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  } catch {
    throw new TrackerIdentityConflictError("invalid-metadata");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new TrackerIdentityConflictError("invalid-metadata");
  }
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.operationId !== "string" ||
    typeof value.createDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.createDigest) ||
    typeof value.kind !== "string" ||
    !Array.isArray(value.acceptanceCriteria) ||
    value.acceptanceCriteria.some((criterion) => typeof criterion !== "string")
  ) {
    throw new TrackerIdentityConflictError("invalid-metadata");
  }
  if (
    value.kind !== "map" && value.kind !== "specification" &&
    value.kind !== "decision_ticket" && value.kind !== "implementation_ticket"
  ) {
    throw new TrackerIdentityConflictError("invalid-metadata");
  }
  return {
    operationId: normalizeOperationId(value.operationId),
    createDigest: value.createDigest,
    kind: value.kind,
    acceptanceCriteria: normalizeAcceptanceCriteria(value.acceptanceCriteria as string[]),
  };
}

export function ownedSectionMarkers(sectionIdValue: string): Readonly<{
  start: string;
  end: string;
}> {
  const sectionId = assertBoundedString(sectionIdValue, "sectionId", 64);
  if (!SECTION_ID.test(sectionId)) {
    throw new TypeError("sectionId must be a lowercase kebab-case identifier");
  }
  return {
    start: `<!-- hanoon:owned:${sectionId}:start -->`,
    end: `<!-- hanoon:owned:${sectionId}:end -->`,
  };
}

export function renderTrackedBody(input: CreateTrackerArtifactInput): string {
  const metadata = artifactMetadataMarker(input);
  const marker = operationMarker(input.operationId, trackerCreateDigest(input));
  const body = normalizeArtifactContent(input.body);
  assertNoTrackerMarkers(body, "artifact body");
  const bodyMarkers = ownedSectionMarkers("body");
  const criteria = normalizeAcceptanceCriteria(input.acceptanceCriteria);
  const acceptanceMarkers = ownedSectionMarkers(ACCEPTANCE_SECTION_ID);
  const acceptance = [
    "## Acceptance criteria",
    "",
    acceptanceMarkers.start,
    ...criteria.map((criterion) => `- [ ] ${criterion}`),
    acceptanceMarkers.end,
  ].join("\n");
  return [
    metadata,
    marker,
    bodyMarkers.start,
    body,
    bodyMarkers.end,
    "",
    acceptance,
  ].join("\n");
}

export function projectTrackedBody(bodyValue: string): string {
  return normalizeArtifactContent(bodyValue
    .replace(META_MARKER_PATTERN, "")
    .replace(OPERATION_PATTERN, ""));
}

export function parseAcceptanceCriteria(bodyValue: string): readonly string[] {
  const body = normalizeArtifactContent(bodyValue);
  const markers = ownedSectionMarkers(ACCEPTANCE_SECTION_ID);
  const start = body.indexOf(markers.start);
  const end = body.indexOf(markers.end);
  if (
    start < 0 || end <= start ||
    body.indexOf(markers.start, start + markers.start.length) >= 0 ||
    body.indexOf(markers.end, end + markers.end.length) >= 0
  ) {
    throw new TrackerIdentityConflictError("invalid-acceptance-criteria");
  }
  const content = body.slice(start + markers.start.length, end).trim();
  if (content.length === 0) return [];
  const criteria = content.split("\n").map((line) => {
    const match = /^\s*-\s+\[[ xX]\]\s+(.+?)\s*$/u.exec(line);
    if (!match) throw new TrackerIdentityConflictError("invalid-acceptance-criteria");
    return match[1];
  });
  return normalizeAcceptanceCriteria(criteria);
}

export function assertValidTrackedBody(bodyValue: string): void {
  const body = normalizeArtifactContent(bodyValue);
  const reservedMarkers = body.match(RESERVED_MARKER_PATTERN) ?? [];
  if (body.split("<!-- hanoon:").length - 1 !== reservedMarkers.length) {
    throw new TrackerIdentityConflictError("malformed-reserved-marker");
  }
  const metadata = parseArtifactMetadata(body);
  const owned = new Map<string, { start: number; end: number }>();
  let openSection: string | null = null;
  for (const match of body.matchAll(OWNED_MARKER_PATTERN)) {
    const sectionId = match[1];
    const phase = match[2] as "start" | "end";
    const counts = owned.get(sectionId) ?? { start: 0, end: 0 };
    counts[phase] += 1;
    owned.set(sectionId, counts);
    if (phase === "start") {
      if (openSection !== null) {
        throw new TrackerIdentityConflictError("nested-owned-section");
      }
      openSection = sectionId;
    } else {
      if (openSection !== sectionId) {
        throw new TrackerIdentityConflictError("misordered-owned-section");
      }
      openSection = null;
    }
  }
  if (
    openSection !== null ||
    [...owned.values()].some((counts) => counts.start !== 1 || counts.end !== 1) ||
    !owned.has("body") || !owned.has(ACCEPTANCE_SECTION_ID)
  ) {
    throw new TrackerIdentityConflictError("invalid-owned-sections");
  }
  const operations = (body.match(OPERATION_PATTERN) ?? []).map((marker) => marker.trim());
  const operationIdentities = operations.map((marker) => marker.slice(
    "<!-- hanoon:operation:".length,
    "<!-- hanoon:operation:".length + 64,
  ));
  if (
    new Set(operations).size !== operations.length ||
    new Set(operationIdentities).size !== operationIdentities.length
  ) {
    throw new TrackerIdentityConflictError("duplicate-operation-marker");
  }
  for (const marker of reservedMarkers) {
    if (
      !META_MARKER_PATTERN.test(marker) && !OWNED_MARKER_PATTERN.test(marker) &&
      !/<!-- hanoon:operation:[0-9a-f]{64}:[0-9a-f]{64} -->/u.test(marker)
    ) {
      throw new TrackerIdentityConflictError("unknown-reserved-marker");
    }
    META_MARKER_PATTERN.lastIndex = 0;
    OWNED_MARKER_PATTERN.lastIndex = 0;
  }
  if (!hasOperationMarker([body], metadata.operationId, metadata.createDigest)) {
    throw new TrackerIdentityConflictError(metadata.operationId);
  }
  parseAcceptanceCriteria(body);
}

export function normalizeTrackerTitle(title: string): string {
  const normalized = normalizeSingleLine(title, "artifact title", 512);
  assertNoTrackerMarkers(normalized, "artifact title");
  return normalized;
}

export function updateOwnedSectionBody(
  bodyValue: string,
  sectionId: string,
  contentValue: string,
  operationId: string,
  insertBefore?: string,
): string {
  const body = normalizeArtifactContent(bodyValue);
  const content = normalizeArtifactContent(contentValue);
  assertNoTrackerMarkers(content, "owned section content");
  const markers = ownedSectionMarkers(sectionId);
  const replacement = `${markers.start}\n${content}\n${markers.end}`;
  const start = body.indexOf(markers.start);
  const end = body.indexOf(markers.end);
  let updated: string;
  if (start === -1 && end === -1) {
    const insertion = insertBefore === undefined ? -1 : body.lastIndexOf(insertBefore);
    updated = insertion < 0
      ? `${body}\n\n${replacement}`
      : `${body.slice(0, insertion).trimEnd()}\n\n${replacement}\n\n${body.slice(insertion).trimStart()}`;
  } else if (start >= 0 && end > start) {
    updated = `${body.slice(0, start)}${replacement}${body.slice(end + markers.end.length)}`;
  } else {
    throw new TrackerIdentityConflictError(operationId);
  }
  return appendOperationMarker(updated, operationId, ownedSectionPayloadDigest({ sectionId, content }));
}

export function appendOperationMarker(
  body: string,
  operationId: string,
  payloadDigest: string,
): string {
  const marker = operationMarker(operationId, payloadDigest);
  if (hasOperationMarker([body], operationId, payloadDigest)) return body;
  return `${body.trimEnd()}\n\n${marker}`;
}

export function assertExpectedRevision(
  artifact: Pick<TrackerArtifact, "externalId" | "revision">,
  expectedRevisionValue: string,
): void {
  const expectedRevision = assertBoundedString(expectedRevisionValue, "expectedRevision", 512);
  if (artifact.revision !== expectedRevision) throw new TrackerConflictError(artifact.externalId);
}

export function normalizeTrackerExternalIds(
  values: readonly string[],
  field: string,
): readonly string[] {
  return normalizeStringList(values, field, 100, 1_024, true);
}
