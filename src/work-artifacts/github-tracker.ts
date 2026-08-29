import {
  assertNoTrackerMarkers,
  assertExpectedRevision,
  assertValidTrackedBody,
  blockersPayloadDigest,
  claimPayloadDigest,
  commentPayloadDigest,
  hasOperationMarker,
  normalizeOperationId,
  normalizeTrackerTitle,
  normalizeTrackerExternalIds,
  operationMarker,
  operationMarkerPrefix,
  ownedSectionPayloadDigest,
  parentPayloadDigest,
  parseAcceptanceCriteria,
  parseArtifactMetadata,
  projectTrackedBody,
  renderTrackedBody,
  trackerCreateDigest,
  terminalPayloadDigest,
  TrackerConflictError,
  TrackerIdentityConflictError,
  updateOwnedSectionBody,
  type CancelTrackerArtifactInput,
  type CommentTrackerArtifactInput,
  type CreateTrackerArtifactInput,
  type ResolveTrackerArtifactInput,
  type SetTrackerBlockersInput,
  type SetTrackerParentInput,
  type TrackerArtifact,
  type TrackerClaimInput,
  type TrackerOperationEvidence,
  type UpdateOwnedSectionInput,
  type WorkTracker,
} from "./tracker";
import { assertBoundedString, normalizeArtifactContent, normalizeStringList, sha256 } from "./models";

export type GitHubIssueRecord = Readonly<{
  externalId: string;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed" | "cancelled";
  stateReason: "completed" | "not_planned" | null;
  assignees: readonly string[];
  comments: readonly string[];
  parentExternalId: string | null;
  blockerExternalIds: readonly string[];
  childExternalIds: readonly string[];
  revision: string;
}>;

export interface GitHubIssueGateway {
  readonly namespace: string;
  createIssue(input: Readonly<{ title: string; body: string }>): Promise<GitHubIssueRecord>;
  readIssue(externalId: string): Promise<GitHubIssueRecord>;
  findIssuesByOperationMarker(marker: string): Promise<readonly GitHubIssueRecord[]>;
  addComment(externalId: string, expectedRevision: string, body: string): Promise<GitHubIssueRecord>;
  addSubIssue(
    parentExternalId: string,
    childExternalId: string,
    expectedChildRevision: string,
  ): Promise<GitHubIssueRecord>;
  addBlockedBy(
    externalId: string,
    expectedRevision: string,
    blockerExternalId: string,
  ): Promise<GitHubIssueRecord>;
  removeBlockedBy(
    externalId: string,
    expectedRevision: string,
    blockerExternalId: string,
  ): Promise<GitHubIssueRecord>;
  addAssignee(
    externalId: string,
    expectedRevision: string,
    assignee: string,
  ): Promise<GitHubIssueRecord>;
  removeAssignee(
    externalId: string,
    expectedRevision: string,
    assignee: string,
  ): Promise<GitHubIssueRecord>;
  closeIssue(
    externalId: string,
    expectedRevision: string,
    reason: "completed" | "not_planned",
  ): Promise<GitHubIssueRecord>;
}

const OPERATION_MARKER_PATTERN = /(?:\n\n)?<!-- hanoon:operation:[0-9a-f]{64}:[0-9a-f]{64} -->/gu;
const OPERATION_INTENT_MARKER_PATTERN = /(?:\n\n)?<!-- hanoon:operation-intent:[0-9a-f]{64}:[a-z-]+:[A-Za-z0-9_-]+ -->/gu;
const OWNED_SECTION_OVERLAY_PATTERN = /<!-- hanoon:overlay:owned-section:([0-9a-f]{64}):([0-9a-f]{64}):([A-Za-z0-9_-]+) -->/gu;
const STATE_OVERLAY_PATTERN = /<!-- hanoon:overlay:(parent|blockers|claim):([0-9a-f]{64}):([0-9a-f]{64}):([A-Za-z0-9_-]+) -->/gu;

type OwnedSectionOverlay = Readonly<{
  operationId: string;
  sectionId: string;
  content: string;
}>;

type StateOverlay = Readonly<{
  operationId: string;
}> & (
  | Readonly<{ kind: "parent"; parentExternalId: string }>
  | Readonly<{
      kind: "blockers";
      blockerExternalIds: readonly string[];
      previousOwnedBlockerExternalIds: readonly string[];
      ownedBlockerExternalIds: readonly string[];
      preservedBlockerExternalIds: readonly string[];
    }>
  | Readonly<{
      kind: "claim";
      action: "claim" | "renew" | "release";
      assignee: string;
      preservedAssignees: readonly string[];
    }>
);

function stateOverlayPayloadDigest(overlay: StateOverlay): string {
  if (overlay.kind === "parent") return parentPayloadDigest(overlay.parentExternalId);
  if (overlay.kind === "blockers") return blockersPayloadDigest(overlay.blockerExternalIds);
  if (overlay.kind === "claim") return claimPayloadDigest(overlay.action, overlay.assignee);
  throw new TypeError("unknown GitHub tracker state intent");
}

function stateIntentComment(overlay: StateOverlay): string {
  const payloadDigest = stateOverlayPayloadDigest(overlay);
  const operationId = normalizeOperationId(overlay.operationId);
  const encoded = Buffer.from(JSON.stringify({ ...overlay, operationId }), "utf8").toString("base64url");
  const marker = `<!-- hanoon:overlay:${overlay.kind}:${sha256(operationId)}:${payloadDigest}:${encoded} -->`;
  return ["Hanoon tracker mutation intent recorded.", "", marker].join("\n");
}

function parseStateOverlay(match: RegExpMatchArray): StateOverlay {
  const markerKind = match[1];
  const operationHash = match[2];
  const payloadDigest = match[3];
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(match[4], "base64url").toString("utf8"));
  } catch {
    throw new TrackerIdentityConflictError(operationHash);
  }
  if (typeof value !== "object" || value === null) {
    throw new TrackerIdentityConflictError(operationHash);
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.operationId !== "string" || candidate.kind !== markerKind) {
    throw new TrackerIdentityConflictError(operationHash);
  }
  let overlay: StateOverlay;
  if (candidate.kind === "parent" && typeof candidate.parentExternalId === "string") {
    overlay = {
      kind: "parent",
      operationId: candidate.operationId,
      parentExternalId: assertBoundedString(candidate.parentExternalId, "parentExternalId", 1_024),
    };
  } else if (
    candidate.kind === "blockers" && Array.isArray(candidate.blockerExternalIds) &&
    candidate.blockerExternalIds.every((id) => typeof id === "string") &&
    Array.isArray(candidate.previousOwnedBlockerExternalIds) &&
    candidate.previousOwnedBlockerExternalIds.every((id) => typeof id === "string") &&
    Array.isArray(candidate.ownedBlockerExternalIds) &&
    candidate.ownedBlockerExternalIds.every((id) => typeof id === "string") &&
    Array.isArray(candidate.preservedBlockerExternalIds) &&
    candidate.preservedBlockerExternalIds.every((id) => typeof id === "string")
  ) {
    overlay = {
      kind: "blockers",
      operationId: candidate.operationId,
      blockerExternalIds: normalizeTrackerExternalIds(
        candidate.blockerExternalIds as string[],
        "blockerExternalIds",
      ),
      previousOwnedBlockerExternalIds: normalizeTrackerExternalIds(
        candidate.previousOwnedBlockerExternalIds as string[],
        "previousOwnedBlockerExternalIds",
      ),
      ownedBlockerExternalIds: normalizeTrackerExternalIds(
        candidate.ownedBlockerExternalIds as string[],
        "ownedBlockerExternalIds",
      ),
      preservedBlockerExternalIds: normalizeTrackerExternalIds(
        candidate.preservedBlockerExternalIds as string[],
        "preservedBlockerExternalIds",
      ),
    };
  } else if (
    candidate.kind === "claim" &&
    (candidate.action === "claim" || candidate.action === "renew" || candidate.action === "release") &&
    typeof candidate.assignee === "string" && Array.isArray(candidate.preservedAssignees) &&
    candidate.preservedAssignees.every((assignee) => typeof assignee === "string")
  ) {
    overlay = {
      kind: "claim",
      operationId: candidate.operationId,
      action: candidate.action,
      assignee: assertBoundedString(candidate.assignee, "assignee"),
      preservedAssignees: normalizedAssignees(
        candidate.preservedAssignees as string[],
        "preservedAssignees",
      ),
    };
  } else {
    throw new TrackerIdentityConflictError(candidate.operationId);
  }
  const operationId = normalizeOperationId(overlay.operationId);
  const expectedDigest = stateOverlayPayloadDigest(overlay);
  if (sha256(operationId) !== operationHash || expectedDigest !== payloadDigest) {
    throw new TrackerIdentityConflictError(operationId);
  }
  if (overlay.kind === "blockers") assertBlockerIntent(overlay);
  if (overlay.kind === "claim") assertClaimIntent(overlay);
  return overlay;
}

function validateStateIntents(record: GitHubIssueRecord): void {
  const seen = new Set<string>();
  for (const comment of record.comments) {
    for (const match of comment.matchAll(STATE_OVERLAY_PATTERN)) {
      const overlay = parseStateOverlay(match);
      const identity = sha256(normalizeOperationId(overlay.operationId));
      if (seen.has(identity)) throw new TrackerIdentityConflictError(overlay.operationId);
      seen.add(identity);
    }
  }
}

function projectRecordState(record: GitHubIssueRecord): Readonly<{
  parentExternalId: string | null;
  blockerExternalIds: readonly string[];
  assignees: readonly string[];
  childExternalIds: readonly string[];
}> {
  validateStateIntents(record);
  return {
    parentExternalId: record.parentExternalId,
    blockerExternalIds: normalizeTrackerExternalIds(record.blockerExternalIds, "GitHub blockers"),
    assignees: normalizedAssignees(record.assignees, "GitHub assignees"),
    childExternalIds: normalizeStringList(record.childExternalIds, "GitHub children", 100, 1_024),
  };
}

function ownedSectionOverlayComment(
  input: UpdateOwnedSectionInput,
  payloadDigest: string,
): string {
  const overlay: OwnedSectionOverlay = {
    operationId: normalizeOperationId(input.operationId),
    sectionId: assertBoundedString(input.sectionId, "sectionId", 64),
    content: normalizeArtifactContent(input.content),
  };
  const encoded = Buffer.from(JSON.stringify(overlay), "utf8").toString("base64url");
  const operationHash = sha256(overlay.operationId);
  const comment = [
    `Hanoon updated owned section \`${overlay.sectionId}\`.`,
    "",
    overlay.content,
    "",
    `<!-- hanoon:overlay:owned-section:${operationHash}:${payloadDigest}:${encoded} -->`,
    operationMarker(overlay.operationId, payloadDigest),
  ].join("\n");
  return assertBoundedString(comment, "GitHub owned section comment", 65_536);
}

function projectRecordBody(record: GitHubIssueRecord): string {
  let body = record.body;
  const seen = new Set<string>();
  for (const comment of record.comments) {
    for (const match of comment.matchAll(OWNED_SECTION_OVERLAY_PATTERN)) {
      const operationHash = match[1];
      const payloadDigest = match[2];
      if (seen.has(operationHash)) throw new TrackerIdentityConflictError(operationHash);
      seen.add(operationHash);
      let overlay: OwnedSectionOverlay;
      try {
        overlay = JSON.parse(Buffer.from(match[3], "base64url").toString("utf8")) as OwnedSectionOverlay;
      } catch {
        throw new TrackerIdentityConflictError(operationHash);
      }
      if (
        typeof overlay.operationId !== "string" || typeof overlay.sectionId !== "string" ||
        typeof overlay.content !== "string" || sha256(normalizeOperationId(overlay.operationId)) !== operationHash ||
        ownedSectionPayloadDigest(overlay) !== payloadDigest ||
        !comment.includes(operationMarker(overlay.operationId, payloadDigest))
      ) {
        throw new TrackerIdentityConflictError(overlay.operationId ?? operationHash);
      }
      body = updateOwnedSectionBody(
        body,
        overlay.sectionId,
        overlay.content,
        overlay.operationId,
      );
      assertValidTrackedBody(body);
    }
  }
  return body;
}

function recordHasOperation(
  record: GitHubIssueRecord,
  operationId: string,
  payloadDigest: string,
): boolean {
  return hasOperationMarker([record.body, ...record.comments], operationId, payloadDigest);
}

function recordHasOperationId(record: GitHubIssueRecord, operationId: string): boolean {
  const prefix = operationMarkerPrefix(operationId);
  return record.body.includes(prefix) || record.comments.some((comment) => comment.includes(prefix));
}

function recordHasOperationIntent(record: GitHubIssueRecord, operationId: string): boolean {
  const prefix = `<!-- hanoon:operation-intent:${sha256(normalizeOperationId(operationId))}:`;
  if (record.body.includes(prefix) || record.comments.some((comment) => comment.includes(prefix))) {
    return true;
  }
  return stateIntents(record).some((intent) => intent.operationId === normalizeOperationId(operationId));
}

function cleanComment(comment: string): string {
  if (OWNED_SECTION_OVERLAY_PATTERN.test(comment)) {
    OWNED_SECTION_OVERLAY_PATTERN.lastIndex = 0;
    return "";
  }
  OWNED_SECTION_OVERLAY_PATTERN.lastIndex = 0;
  if (STATE_OVERLAY_PATTERN.test(comment)) {
    STATE_OVERLAY_PATTERN.lastIndex = 0;
    return "";
  }
  STATE_OVERLAY_PATTERN.lastIndex = 0;
  return comment
    .replace(OPERATION_MARKER_PATTERN, "")
    .replace(OPERATION_INTENT_MARKER_PATTERN, "")
    .trim();
}

type TerminalIntent = Readonly<{
  outcome: "resolved" | "cancelled";
  textDigest: string;
}>;

function normalizedAssignees(values: readonly string[], label: string): readonly string[] {
  return normalizeStringList(values, label, 64, 256, true);
}

function terminalIntentMarker(operationId: string, intent: TerminalIntent): string {
  const payload = Buffer.from(JSON.stringify(intent), "utf8").toString("base64url");
  return `<!-- hanoon:operation-intent:${sha256(normalizeOperationId(operationId))}:terminal:${payload} -->`;
}

function terminalApplyingMarker(operationId: string, intent: TerminalIntent): string {
  const payload = Buffer.from(JSON.stringify(intent), "utf8").toString("base64url");
  return `<!-- hanoon:operation-intent:${sha256(normalizeOperationId(operationId))}:terminal-write:${payload} -->`;
}

function readTerminalIntentMarker(
  record: GitHubIssueRecord,
  operationId: string,
  phase: "terminal" | "terminal-write",
): TerminalIntent | null {
  const prefix = `<!-- hanoon:operation-intent:${sha256(normalizeOperationId(operationId))}:${phase}:`;
  const markers = [record.body, ...record.comments]
    .flatMap((value) => value.match(OPERATION_INTENT_MARKER_PATTERN) ?? [])
    .filter((marker) => marker.includes(prefix));
  if (markers.length === 0) return null;
  const intents = markers.map((marker): TerminalIntent => {
    const payload = marker.trim().slice(prefix.length, -" -->".length);
    try {
      const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
        outcome?: unknown;
        textDigest?: unknown;
      };
      if (
        (value.outcome !== "resolved" && value.outcome !== "cancelled") ||
        typeof value.textDigest !== "string" || !/^[0-9a-f]{64}$/u.test(value.textDigest)
      ) throw new Error("invalid terminal intent");
      return { outcome: value.outcome, textDigest: value.textDigest };
    } catch {
      throw new TrackerIdentityConflictError(operationId);
    }
  });
  const canonical = JSON.stringify(intents[0]);
  if (intents.some((intent) => JSON.stringify(intent) !== canonical)) {
    throw new TrackerIdentityConflictError(operationId);
  }
  return intents[0];
}

function readTerminalIntent(record: GitHubIssueRecord, operationId: string): TerminalIntent | null {
  return readTerminalIntentMarker(record, operationId, "terminal");
}

function readTerminalApplyingIntent(
  record: GitHubIssueRecord,
  operationId: string,
): TerminalIntent | null {
  return readTerminalIntentMarker(record, operationId, "terminal-write");
}

function terminalIntentMatches(
  intent: TerminalIntent,
  outcome: TerminalIntent["outcome"],
  text: string,
): boolean {
  return intent.outcome === outcome && intent.textDigest === sha256(text);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stateIntents(record: GitHubIssueRecord): readonly StateOverlay[] {
  const intents: StateOverlay[] = [];
  for (const comment of record.comments) {
    for (const match of comment.matchAll(STATE_OVERLAY_PATTERN)) {
      intents.push(parseStateOverlay(match));
    }
  }
  return intents;
}

function readStateIntent(
  record: GitHubIssueRecord,
  operationIdValue: string,
  kind: StateOverlay["kind"],
  payloadDigest: string,
): StateOverlay | null {
  const operationId = normalizeOperationId(operationIdValue);
  const matches = stateIntents(record).filter((intent) => intent.operationId === operationId);
  if (matches.length === 0) return null;
  if (
    matches.length !== 1 || matches[0].kind !== kind ||
    stateOverlayPayloadDigest(matches[0]) !== payloadDigest
  ) throw new TrackerIdentityConflictError(operationId);
  return matches[0];
}

function expectedBlockerState(intent: Extract<StateOverlay, { kind: "blockers" }>): readonly string[] {
  return normalizeTrackerExternalIds([
    ...intent.preservedBlockerExternalIds,
    ...intent.ownedBlockerExternalIds,
  ], "expected GitHub blockers");
}

function nativeBlockerState(record: GitHubIssueRecord): readonly string[] {
  return normalizeTrackerExternalIds(record.blockerExternalIds, "GitHub blockers");
}

function expectedAssigneeState(intent: Extract<StateOverlay, { kind: "claim" }>): readonly string[] {
  return normalizedAssignees([
    ...intent.preservedAssignees,
    ...(intent.action === "release" ? [] : [intent.assignee]),
  ], "expected GitHub assignees");
}

function ownedBlockersFromEvidence(record: GitHubIssueRecord): readonly string[] {
  let owned: readonly string[] = [];
  for (const intent of stateIntents(record)) {
    if (
      intent.kind === "blockers" &&
      recordHasOperation(record, intent.operationId, stateOverlayPayloadDigest(intent))
    ) owned = intent.ownedBlockerExternalIds;
  }
  return owned;
}

function assertBlockerIntent(intent: Extract<StateOverlay, { kind: "blockers" }>): void {
  const previous = new Set(intent.previousOwnedBlockerExternalIds);
  const owned = new Set(intent.ownedBlockerExternalIds);
  const preserved = new Set(intent.preservedBlockerExternalIds);
  const desired = new Set(intent.blockerExternalIds);
  if (
    [...previous].some((id) => preserved.has(id)) ||
    [...owned].some((id) => preserved.has(id) || !desired.has(id)) ||
    [...desired].some((id) => !owned.has(id) && !preserved.has(id))
  ) throw new TrackerIdentityConflictError(intent.operationId);
}

function assertClaimIntent(intent: Extract<StateOverlay, { kind: "claim" }>): void {
  if (intent.preservedAssignees.includes(intent.assignee)) {
    throw new TrackerIdentityConflictError(intent.operationId);
  }
}

function toArtifact(record: GitHubIssueRecord): TrackerArtifact {
  assertValidTrackedBody(record.body);
  const metadata = parseArtifactMetadata(record.body);
  const projectedBody = projectRecordBody(record);
  const projectedState = projectRecordState(record);
  return {
    trackerKind: "github",
    externalId: record.externalId,
    url: record.url,
    revision: record.revision,
    operationId: metadata.operationId,
    createDigest: metadata.createDigest,
    kind: metadata.kind,
    title: record.title,
    body: projectTrackedBody(projectedBody),
    acceptanceCriteria: parseAcceptanceCriteria(projectedBody),
    state: record.state,
    assignees: projectedState.assignees,
    comments: record.comments.map(cleanComment).filter((comment) => comment.length > 0),
    parentExternalId: projectedState.parentExternalId,
    blockerExternalIds: projectedState.blockerExternalIds,
    childExternalIds: projectedState.childExternalIds,
  };
}

function assertCreateReplay(
  artifact: TrackerArtifact,
  input: CreateTrackerArtifactInput,
): void {
  if (
    artifact.operationId !== normalizeOperationId(input.operationId) ||
    artifact.createDigest !== trackerCreateDigest(input) ||
    artifact.kind !== input.kind ||
    artifact.title !== normalizeTrackerTitle(input.title)
  ) {
    throw new TrackerIdentityConflictError(input.operationId);
  }
}

async function addOperationComment(
  gateway: GitHubIssueGateway,
  record: GitHubIssueRecord,
  operationId: string,
  payloadDigest: string,
  text = "Hanoon tracker operation recorded.",
): Promise<GitHubIssueRecord> {
  if (recordHasOperation(record, operationId, payloadDigest)) return record;
  return gateway.addComment(
    record.externalId,
    record.revision,
    `${text}\n\n${operationMarker(operationId, payloadDigest)}`,
  );
}

export class GitHubWorkTracker implements WorkTracker {
  public readonly kind = "github" as const;
  public readonly namespace: string;
  public readonly relationships = { parent: "native", blockers: "native" } as const;

  public constructor(private readonly gateway: GitHubIssueGateway) {
    this.namespace = assertBoundedString(gateway.namespace, "GitHub tracker namespace", 1_024);
  }

  public async create(input: CreateTrackerArtifactInput): Promise<TrackerArtifact> {
    const reconciled = await this.reconcile({ operationId: input.operationId });
    if (reconciled) {
      assertCreateReplay(reconciled, input);
      return reconciled;
    }
    const title = normalizeTrackerTitle(input.title);
    const created = await this.gateway.createIssue({ title, body: renderTrackedBody(input) });
    const artifact = toArtifact(created);
    assertCreateReplay(artifact, input);
    return artifact;
  }

  public async read(externalIdValue: string): Promise<TrackerArtifact> {
    const externalId = assertBoundedString(externalIdValue, "externalId", 1_024);
    return toArtifact(await this.gateway.readIssue(externalId));
  }

  public async updateOwnedSection(input: UpdateOwnedSectionInput): Promise<TrackerArtifact> {
    const current = await this.readRecord(input.externalId);
    const projected = toArtifact(current);
    const payloadDigest = ownedSectionPayloadDigest(input);
    if (recordHasOperation(current, input.operationId, payloadDigest)) return projected;
    assertExpectedRevision(projected, input.expectedRevision);
    const body = updateOwnedSectionBody(
      projectRecordBody(current),
      input.sectionId,
      input.content,
      input.operationId,
    );
    assertValidTrackedBody(body);
    return toArtifact(await this.gateway.addComment(
      current.externalId,
      current.revision,
      ownedSectionOverlayComment(input, payloadDigest),
    ));
  }

  public async comment(input: CommentTrackerArtifactInput): Promise<TrackerArtifact> {
    const current = await this.readRecord(input.externalId);
    const payloadDigest = commentPayloadDigest(input.comment);
    if (recordHasOperation(current, input.operationId, payloadDigest)) return toArtifact(current);
    assertExpectedRevision(toArtifact(current), input.expectedRevision);
    const comment = normalizeArtifactContent(assertBoundedString(input.comment, "tracker comment", 65_536));
    assertNoTrackerMarkers(comment, "tracker comment");
    return toArtifact(await this.gateway.addComment(
      current.externalId,
      current.revision,
      `${comment}\n\n${operationMarker(input.operationId, payloadDigest)}`,
    ));
  }

  public async setParent(input: SetTrackerParentInput): Promise<TrackerArtifact> {
    let current = await this.readRecord(input.externalId);
    const parentExternalId = assertBoundedString(
      input.parentExternalId,
      "parentExternalId",
      1_024,
    );
    const payloadDigest = parentPayloadDigest(parentExternalId);
    if (parentExternalId === current.externalId) {
      throw new TrackerConflictError(current.externalId);
    }
    const existingIntent = readStateIntent(current, input.operationId, "parent", payloadDigest);
    if (existingIntent) {
      if (current.parentExternalId !== parentExternalId) throw new TrackerConflictError(current.externalId);
      await this.assertNativeParent(current, parentExternalId);
      if (!recordHasOperation(current, input.operationId, payloadDigest)) {
        current = await addOperationComment(
          this.gateway,
          current,
          input.operationId,
          payloadDigest,
          "Hanoon native parent mutation completed.",
        );
        if (current.parentExternalId !== parentExternalId) throw new TrackerConflictError(current.externalId);
        await this.assertNativeParent(current, parentExternalId);
      }
      return toArtifact(current);
    }
    assertExpectedRevision(toArtifact(current), input.expectedRevision);
    if (current.parentExternalId !== null) {
      throw new TrackerConflictError(current.externalId);
    }
    current = await this.gateway.addComment(
      current.externalId,
      current.revision,
      stateIntentComment({ kind: "parent", operationId: input.operationId, parentExternalId }),
    );
    if (
      !readStateIntent(current, input.operationId, "parent", payloadDigest) ||
      current.parentExternalId !== null
    ) throw new TrackerConflictError(current.externalId);
    current = await this.gateway.addSubIssue(
      parentExternalId,
      current.externalId,
      current.revision,
    );
    if (current.parentExternalId !== parentExternalId) throw new TrackerConflictError(current.externalId);
    await this.assertNativeParent(current, parentExternalId);
    current = await addOperationComment(
      this.gateway,
      current,
      input.operationId,
      payloadDigest,
      "Hanoon native parent mutation completed.",
    );
    if (current.parentExternalId !== parentExternalId) throw new TrackerConflictError(current.externalId);
    await this.assertNativeParent(current, parentExternalId);
    return toArtifact(current);
  }

  public async setBlockers(input: SetTrackerBlockersInput): Promise<TrackerArtifact> {
    let current = await this.readRecord(input.externalId);
    const blockers = normalizeTrackerExternalIds(input.blockerExternalIds, "blockerExternalIds");
    const payloadDigest = blockersPayloadDigest(blockers);
    if (blockers.includes(current.externalId)) throw new TrackerConflictError(current.externalId);
    const existingIntent = readStateIntent(current, input.operationId, "blockers", payloadDigest);
    if (existingIntent) {
      if (existingIntent.kind !== "blockers") throw new TrackerIdentityConflictError(input.operationId);
      const expected = expectedBlockerState(existingIntent);
      if (!sameIds(nativeBlockerState(current), expected)) throw new TrackerConflictError(current.externalId);
      if (!recordHasOperation(current, input.operationId, payloadDigest)) {
        current = await addOperationComment(
          this.gateway,
          current,
          input.operationId,
          payloadDigest,
          "Hanoon native blocker mutation completed.",
        );
        if (!sameIds(nativeBlockerState(current), expected)) throw new TrackerConflictError(current.externalId);
      }
      return toArtifact(current);
    }
    assertExpectedRevision(toArtifact(current), input.expectedRevision);
    const previousOwned = ownedBlockersFromEvidence(current);
    const observedBlockers = nativeBlockerState(current);
    if (previousOwned.some((id) => !observedBlockers.includes(id))) {
      throw new TrackerConflictError(current.externalId);
    }
    const preserved = observedBlockers.filter((id) => !previousOwned.includes(id));
    const owned = blockers.filter((id) => previousOwned.includes(id) || !preserved.includes(id));
    const intent: Extract<StateOverlay, { kind: "blockers" }> = {
      kind: "blockers",
      operationId: input.operationId,
      blockerExternalIds: blockers,
      previousOwnedBlockerExternalIds: previousOwned,
      ownedBlockerExternalIds: owned,
      preservedBlockerExternalIds: preserved,
    };
    assertBlockerIntent(intent);
    current = await this.gateway.addComment(
      current.externalId,
      current.revision,
      stateIntentComment(intent),
    );
    const initialExpected = normalizeTrackerExternalIds([
      ...intent.preservedBlockerExternalIds,
      ...intent.previousOwnedBlockerExternalIds,
    ], "initial GitHub blockers");
    if (
      !readStateIntent(current, input.operationId, "blockers", payloadDigest) ||
      !sameIds(nativeBlockerState(current), initialExpected)
    ) throw new TrackerConflictError(current.externalId);
    for (const blocker of previousOwned.filter((id) => !owned.includes(id))) {
      current = await this.gateway.removeBlockedBy(current.externalId, current.revision, blocker);
    }
    for (const blocker of owned.filter((id) => !previousOwned.includes(id))) {
      current = await this.gateway.addBlockedBy(current.externalId, current.revision, blocker);
    }
    const expected = expectedBlockerState(intent);
    if (!sameIds(nativeBlockerState(current), expected)) throw new TrackerConflictError(current.externalId);
    current = await addOperationComment(
      this.gateway,
      current,
      input.operationId,
      payloadDigest,
      "Hanoon native blocker mutation completed.",
    );
    if (!sameIds(nativeBlockerState(current), expected)) throw new TrackerConflictError(current.externalId);
    return toArtifact(current);
  }

  public async frontier(input: Readonly<{ parentExternalId: string }>): Promise<readonly TrackerArtifact[]> {
    const parent = toArtifact(await this.readRecord(input.parentExternalId));
    const candidates: TrackerArtifact[] = [];
    for (const childId of parent.childExternalIds) {
      const child = toArtifact(await this.readRecord(childId));
      if (child.parentExternalId !== parent.externalId) continue;
      if (child.state !== "open" || child.assignees.length > 0) continue;
      const blockers = await Promise.all(child.blockerExternalIds.map((id) => this.read(id)));
      if (blockers.some((blocker) => blocker.state === "open")) continue;
      candidates.push(child);
    }
    return candidates;
  }

  public claim(input: TrackerClaimInput): Promise<TrackerArtifact> {
    return this.setClaim(input, "claim");
  }

  public renew(input: TrackerClaimInput): Promise<TrackerArtifact> {
    return this.setClaim(input, "renew");
  }

  public release(input: TrackerClaimInput): Promise<TrackerArtifact> {
    return this.setClaim(input, "release");
  }

  public async resolve(input: ResolveTrackerArtifactInput): Promise<TrackerArtifact> {
    let current = await this.readRecord(input.externalId);
    const resolution = normalizeArtifactContent(assertBoundedString(input.resolution, "resolution", 65_536));
    assertNoTrackerMarkers(resolution, "resolution");
    const payloadDigest = terminalPayloadDigest("resolved", resolution);
    let intent = readTerminalIntent(current, input.operationId);
    let applying = readTerminalApplyingIntent(current, input.operationId);
    if (recordHasOperation(current, input.operationId, payloadDigest)) {
      if (!intent || !terminalIntentMatches(intent, "resolved", resolution)) {
        throw new TrackerIdentityConflictError(input.operationId);
      }
      if (current.state !== "closed" || current.stateReason !== "completed") {
        throw new TrackerConflictError(current.externalId);
      }
      return toArtifact(current);
    }
    if (!intent) {
      assertExpectedRevision(toArtifact(current), input.expectedRevision);
      if (
        current.state !== "open" &&
        (current.state !== "closed" || current.stateReason !== "completed")
      ) throw new TrackerConflictError(current.externalId);
      intent = { outcome: "resolved", textDigest: sha256(resolution) };
      current = await this.gateway.addComment(
        current.externalId,
        current.revision,
        `${resolution}\n\n${terminalIntentMarker(input.operationId, intent)}`,
      );
    } else if (!terminalIntentMatches(intent, "resolved", resolution)) {
      throw new TrackerIdentityConflictError(input.operationId);
    }
    if (applying && !terminalIntentMatches(applying, "resolved", resolution)) {
      throw new TrackerIdentityConflictError(input.operationId);
    }
    if (applying) throw new TrackerConflictError(current.externalId);
    if (current.state === "open") {
      current = await this.gateway.addComment(
        current.externalId,
        current.revision,
        terminalApplyingMarker(input.operationId, intent),
      );
      applying = readTerminalApplyingIntent(current, input.operationId);
      if (!applying || !terminalIntentMatches(applying, "resolved", resolution)) {
        throw new TrackerIdentityConflictError(input.operationId);
      }
      current = await this.gateway.closeIssue(current.externalId, current.revision, "completed");
    }
    if (current.state !== "closed" || current.stateReason !== "completed") {
      throw new TrackerConflictError(current.externalId);
    }
    current = await addOperationComment(this.gateway, current, input.operationId, payloadDigest);
    return toArtifact(current);
  }

  public async cancel(input: CancelTrackerArtifactInput): Promise<TrackerArtifact> {
    let current = await this.readRecord(input.externalId);
    const reason = normalizeArtifactContent(assertBoundedString(input.reason, "cancellation reason", 65_536));
    assertNoTrackerMarkers(reason, "cancellation reason");
    const payloadDigest = terminalPayloadDigest("cancelled", reason);
    let intent = readTerminalIntent(current, input.operationId);
    let applying = readTerminalApplyingIntent(current, input.operationId);
    if (recordHasOperation(current, input.operationId, payloadDigest)) {
      if (!intent || !terminalIntentMatches(intent, "cancelled", reason)) {
        throw new TrackerIdentityConflictError(input.operationId);
      }
      if (current.state !== "cancelled" || current.stateReason !== "not_planned") {
        throw new TrackerConflictError(current.externalId);
      }
      return toArtifact(current);
    }
    if (!intent) {
      assertExpectedRevision(toArtifact(current), input.expectedRevision);
      if (
        current.state !== "open" &&
        (current.state !== "cancelled" || current.stateReason !== "not_planned")
      ) throw new TrackerConflictError(current.externalId);
      intent = { outcome: "cancelled", textDigest: sha256(reason) };
      current = await this.gateway.addComment(
        current.externalId,
        current.revision,
        `${reason}\n\n${terminalIntentMarker(input.operationId, intent)}`,
      );
    } else if (!terminalIntentMatches(intent, "cancelled", reason)) {
      throw new TrackerIdentityConflictError(input.operationId);
    }
    if (applying && !terminalIntentMatches(applying, "cancelled", reason)) {
      throw new TrackerIdentityConflictError(input.operationId);
    }
    if (applying) throw new TrackerConflictError(current.externalId);
    if (current.state === "open") {
      current = await this.gateway.addComment(
        current.externalId,
        current.revision,
        terminalApplyingMarker(input.operationId, intent),
      );
      applying = readTerminalApplyingIntent(current, input.operationId);
      if (!applying || !terminalIntentMatches(applying, "cancelled", reason)) {
        throw new TrackerIdentityConflictError(input.operationId);
      }
      current = await this.gateway.closeIssue(current.externalId, current.revision, "not_planned");
    }
    if (current.state !== "cancelled" || current.stateReason !== "not_planned") {
      throw new TrackerConflictError(current.externalId);
    }
    current = await addOperationComment(this.gateway, current, input.operationId, payloadDigest);
    return toArtifact(current);
  }

  public async reconcile(input: Readonly<{ operationId: string }>): Promise<TrackerArtifact | null> {
    const operationId = normalizeOperationId(input.operationId);
    const markerPrefix = operationMarkerPrefix(operationId);
    const matches = (await this.gateway.findIssuesByOperationMarker(markerPrefix))
      .filter((issue) => recordHasOperationId(issue, operationId));
    if (matches.length > 1) throw new TrackerIdentityConflictError(operationId);
    return matches[0] ? toArtifact(matches[0]) : null;
  }

  public async operationStatus(input: Readonly<{
    externalId: string;
    operationId: string;
    payloadDigest: string;
  }>): Promise<TrackerOperationEvidence> {
    const current = await this.readRecord(input.externalId);
    const artifact = toArtifact(current);
    if (recordHasOperation(current, input.operationId, input.payloadDigest)) {
      return { status: "completed", artifact };
    }
    if (recordHasOperationId(current, input.operationId)) {
      throw new TrackerIdentityConflictError(input.operationId);
    }
    return {
      status: recordHasOperationIntent(current, input.operationId) ? "pending" : "absent",
      artifact,
    };
  }

  private async setClaim(
    input: TrackerClaimInput,
    action: "claim" | "renew" | "release",
  ): Promise<TrackerArtifact> {
    let current = await this.readRecord(input.externalId);
    const assignee = assertBoundedString(input.assignee, "assignee");
    const assigned = action !== "release";
    const payloadDigest = claimPayloadDigest(action, assignee);
    if (assigned && current.state !== "open") {
      throw new TrackerConflictError(current.externalId);
    }
    const existingIntent = readStateIntent(current, input.operationId, "claim", payloadDigest);
    if (existingIntent) {
      if (existingIntent.kind !== "claim") throw new TrackerIdentityConflictError(input.operationId);
      const expected = expectedAssigneeState(existingIntent);
      if (!sameIds(normalizedAssignees(current.assignees, "GitHub assignees"), expected)) {
        throw new TrackerConflictError(current.externalId);
      }
      if (!recordHasOperation(current, input.operationId, payloadDigest)) {
        current = await addOperationComment(
          this.gateway,
          current,
          input.operationId,
          payloadDigest,
          "Hanoon native assignee mutation completed.",
        );
        if (!sameIds(normalizedAssignees(current.assignees, "GitHub assignees"), expected)) {
          throw new TrackerConflictError(current.externalId);
        }
      }
      return toArtifact(current);
    }
    assertExpectedRevision(toArtifact(current), input.expectedRevision);
    if (action === "claim" && current.assignees.includes(assignee)) {
      throw new TrackerConflictError(current.externalId);
    }
    if (action === "renew" && !current.assignees.includes(assignee)) {
      throw new TrackerConflictError(current.externalId);
    }
    const intent: Extract<StateOverlay, { kind: "claim" }> = {
      kind: "claim",
      operationId: input.operationId,
      action,
      assignee,
      preservedAssignees: normalizedAssignees(
        current.assignees.filter((login) => login !== assignee),
        "preservedAssignees",
      ),
    };
    assertClaimIntent(intent);
    const initialAssignees = normalizedAssignees(current.assignees, "GitHub assignees");
    current = await this.gateway.addComment(
      current.externalId,
      current.revision,
      stateIntentComment(intent),
    );
    if (
      !readStateIntent(current, input.operationId, "claim", payloadDigest) ||
      !sameIds(normalizedAssignees(current.assignees, "GitHub assignees"), initialAssignees)
    ) {
      throw new TrackerConflictError(current.externalId);
    }
    if (action === "release") {
      if (current.assignees.includes(assignee)) {
        current = await this.gateway.removeAssignee(current.externalId, current.revision, assignee);
      }
    } else {
      current = await this.gateway.addAssignee(current.externalId, current.revision, assignee);
    }
    const expected = expectedAssigneeState(intent);
    if (!sameIds(normalizedAssignees(current.assignees, "GitHub assignees"), expected)) {
      throw new TrackerConflictError(current.externalId);
    }
    current = await addOperationComment(
      this.gateway,
      current,
      input.operationId,
      payloadDigest,
      "Hanoon native assignee mutation completed.",
    );
    if (!sameIds(normalizedAssignees(current.assignees, "GitHub assignees"), expected)) {
      throw new TrackerConflictError(current.externalId);
    }
    return toArtifact(current);
  }

  private async assertNativeParent(
    child: GitHubIssueRecord,
    parentExternalId: string,
  ): Promise<void> {
    const parent = await this.readRecord(parentExternalId);
    if (
      child.parentExternalId !== parentExternalId ||
      !parent.childExternalIds.includes(child.externalId)
    ) throw new TrackerConflictError(child.externalId);
  }

  private async readRecord(externalIdValue: string): Promise<GitHubIssueRecord> {
    const externalId = assertBoundedString(externalIdValue, "externalId", 1_024);
    return this.gateway.readIssue(externalId);
  }
}
