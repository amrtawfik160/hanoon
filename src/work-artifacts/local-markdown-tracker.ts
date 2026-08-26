import { lstat, readdir, realpath } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  appendOperationMarker,
  assertNoTrackerMarkers,
  assertExpectedRevision,
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
  TrackerConflictError,
  TrackerIdentityConflictError,
  TrackerNotFoundError,
  trackerCreateDigest,
  terminalPayloadDigest,
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
import {
  assertBoundedString,
  normalizeArtifactContent,
  normalizeStringList,
  sha256,
  type WorkArtifactKind,
} from "./models";
import {
  atomicCreateLocalFile,
  compareAndSwapLocalFile,
  ensureLocalDirectory,
  LocalFileCasConflictError,
  type LocalFileContainment,
  readBoundedLocalFile,
  recoverLocalFileCas,
} from "./local-file-cas";

export type LocalMarkdownWorkTrackerOptions = Readonly<{
  repositoryRoot: string;
  effortSlug: string;
}>;

type LocalState = Readonly<{
  status: "open" | "ready" | "claimed" | "resolved" | "cancelled";
  assignees: readonly string[];
  parentExternalId: string | null;
  blockerExternalIds: readonly string[];
}>;

type ParsedLocalArtifact = Readonly<{
  artifact: TrackerArtifact;
  state: LocalState;
  raw: string;
  absolutePath: string;
}>;

const EFFORT_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const CONTROL_START = "<!-- hanoon:local-control:start -->";
const CONTROL_END = "<!-- hanoon:local-control:end -->";
const CONTROL_PATTERN = /<!-- hanoon:local-control:start -->\n([\s\S]*?)\n<!-- hanoon:local-control:end -->/u;
const COMMENT_PATTERN = /<!-- hanoon:comment:start -->\n([\s\S]*?)\n<!-- hanoon:comment:end -->/gu;
const OPERATION_MARKER_PATTERN = /(?:\n\n)?<!-- hanoon:operation:[0-9a-f]{64}:[0-9a-f]{64} -->/gu;
const ARTIFACT_MARKER_PATTERN = /<!-- hanoon:artifact:[A-Za-z0-9_-]+ -->/gu;
const OWNED_MARKER_PATTERN = /<!-- hanoon:owned:([a-z][a-z0-9-]{0,63}):(start|end) -->/gu;
const RESERVED_MARKER_PATTERN = /<!-- hanoon:[^\r\n]* -->/gu;
const MAX_LOCAL_ARTIFACT_BYTES = 1_048_576;
const LOCAL_ISSUE_FILE = /^(0[1-9]|[1-9][0-9]+)-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/u;
const ISSUE_SHAPED_FILE = /^([0-9]+)-[\s\S]*\.md$/u;

function slugify(title: string): string {
  const slug = title.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64)
    .replace(/-+$/u, "");
  return slug || "artifact";
}

function compareExternalIds(left: string, right: string): number {
  const leftNumber = /\/issues\/(\d+)-/u.exec(left)?.[1];
  const rightNumber = /\/issues\/(\d+)-/u.exec(right)?.[1];
  if (leftNumber !== undefined && rightNumber !== undefined) {
    const numeric = Number(leftNumber) - Number(rightNumber);
    if (numeric !== 0) return numeric;
  }
  return left.localeCompare(right);
}

function renderControl(state: LocalState, kind: WorkArtifactKind): string {
  const assignees = state.assignees.length === 0 ? "unassigned" : state.assignees.join(", ");
  const parent = state.parentExternalId ?? "none";
  const blockers = state.blockerExternalIds.length === 0
    ? "none"
    : state.blockerExternalIds.join(", ");
  return [
    CONTROL_START,
    `Type: ${kind}`,
    `Status: ${state.status}`,
    `Assignee: ${assignees}`,
    `Parent: ${parent}`,
    `Blocked by: ${blockers}`,
    CONTROL_END,
  ].join("\n");
}

function parseList(value: string): readonly string[] {
  if (value === "none" || value === "unassigned") return [];
  return normalizeTrackerExternalIds(value.split(",").map((item) => item.trim()), "local metadata list");
}

function parseRelationshipList(value: string): readonly string[] {
  if (value === "none") return [];
  return value.split(", ");
}

function controlFieldIdentity(value: string): string {
  return value.startsWith(" ") ? value.slice(1) : value;
}

function parseControl(raw: string, expectedKind: WorkArtifactKind): LocalState {
  const match = CONTROL_PATTERN.exec(raw);
  if (!match) throw new TrackerIdentityConflictError("missing-local-control");
  const fields = new Map<string, string>();
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const status = fields.get("Status")?.trim();
  if (
    status !== "open" && status !== "ready" && status !== "claimed" &&
    status !== "resolved" && status !== "cancelled"
  ) {
    throw new TrackerIdentityConflictError("invalid-local-status");
  }
  const rawParent = fields.get("Parent");
  const rawAssignee = fields.get("Assignee");
  const rawBlockers = fields.get("Blocked by");
  if (
    fields.get("Type")?.trim() !== expectedKind || rawParent === undefined ||
    rawAssignee === undefined || rawBlockers === undefined
  ) {
    throw new TrackerIdentityConflictError("invalid-local-control");
  }
  const parent = controlFieldIdentity(rawParent);
  const blockers = controlFieldIdentity(rawBlockers);
  return {
    status,
    assignees: parseList(rawAssignee.trim()),
    parentExternalId: parent === "none" ? null : parent,
    blockerExternalIds: parseRelationshipList(blockers),
  };
}

function parseComments(raw: string): readonly string[] {
  return [...raw.matchAll(COMMENT_PATTERN)]
    .map((match) => match[1].replace(OPERATION_MARKER_PATTERN, "").trim())
    .filter((comment) => comment.length > 0);
}

function projectLocalBody(raw: string): string {
  return projectTrackedBody(raw
    .replace(CONTROL_PATTERN, "")
    .replace(COMMENT_PATTERN, ""));
}

function renderComment(comment: string, operationId: string, payloadDigest: string): string {
  const normalized = normalizeArtifactContent(assertBoundedString(comment, "tracker comment", 65_536));
  assertNoTrackerMarkers(normalized, "tracker comment");
  return [
    "<!-- hanoon:comment:start -->",
    normalized,
    operationMarker(operationId, payloadDigest),
    "<!-- hanoon:comment:end -->",
  ].join("\n");
}

function assertWritableLocalArtifact(raw: string): void {
  if (Buffer.byteLength(raw, "utf8") > MAX_LOCAL_ARTIFACT_BYTES) {
    throw new TypeError("local tracker artifact exceeds the 1048576 byte limit");
  }
  const artifactMarkers = raw.match(ARTIFACT_MARKER_PATTERN) ?? [];
  const reservedMarkers = raw.match(RESERVED_MARKER_PATTERN) ?? [];
  if (raw.split("<!-- hanoon:").length - 1 !== reservedMarkers.length) {
    throw new TrackerIdentityConflictError("malformed-local-reserved-marker");
  }
  if (artifactMarkers.length !== 1) {
    throw new TrackerIdentityConflictError("invalid-local-artifact-markers");
  }
  if (raw.split(CONTROL_START).length !== 2 || raw.split(CONTROL_END).length !== 2) {
    throw new TrackerIdentityConflictError("invalid-local-control-markers");
  }
  const owned = new Map<string, { start: number; end: number }>();
  for (const match of raw.matchAll(OWNED_MARKER_PATTERN)) {
    const counts = owned.get(match[1]) ?? { start: 0, end: 0 };
    counts[match[2] as "start" | "end"] += 1;
    owned.set(match[1], counts);
  }
  if ([...owned.values()].some((counts) => counts.start !== 1 || counts.end !== 1)) {
    throw new TrackerIdentityConflictError("invalid-local-owned-markers");
  }
  if (!owned.has("body") || !owned.has("acceptance-criteria")) {
    throw new TrackerIdentityConflictError("missing-local-owned-markers");
  }
  let commentOpen = false;
  for (const marker of raw.match(/<!-- hanoon:comment:(?:start|end) -->/gu) ?? []) {
    if (marker.endsWith("start -->")) {
      if (commentOpen) throw new TrackerIdentityConflictError("invalid-local-comment-markers");
      commentOpen = true;
    } else {
      if (!commentOpen) throw new TrackerIdentityConflictError("invalid-local-comment-markers");
      commentOpen = false;
    }
  }
  if (commentOpen) throw new TrackerIdentityConflictError("invalid-local-comment-markers");
  const operations = (raw.match(OPERATION_MARKER_PATTERN) ?? []).map((marker) => marker.trim());
  const operationIdentities = operations.map((marker) => marker.slice(
    "<!-- hanoon:operation:".length,
    "<!-- hanoon:operation:".length + 64,
  ));
  if (
    new Set(operations).size !== operations.length ||
    new Set(operationIdentities).size !== operationIdentities.length
  ) {
    throw new TrackerIdentityConflictError("duplicate-local-operation-marker");
  }
  for (const marker of reservedMarkers) {
    if (
      marker !== CONTROL_START && marker !== CONTROL_END &&
      marker !== "<!-- hanoon:comment:start -->" && marker !== "<!-- hanoon:comment:end -->" &&
      !ARTIFACT_MARKER_PATTERN.test(marker) && !OWNED_MARKER_PATTERN.test(marker) &&
      !/<!-- hanoon:operation:[0-9a-f]{64}:[0-9a-f]{64} -->/u.test(marker)
    ) throw new TrackerIdentityConflictError("unknown-local-reserved-marker");
    ARTIFACT_MARKER_PATTERN.lastIndex = 0;
    OWNED_MARKER_PATTERN.lastIndex = 0;
  }
  const metadata = parseArtifactMetadata(raw);
  parseControl(raw, metadata.kind);
  parseAcceptanceCriteria(raw);
}

function trackerState(status: LocalState["status"]): TrackerArtifact["state"] {
  if (status === "resolved") return "closed";
  if (status === "cancelled") return "cancelled";
  return "open";
}

function hasOperation(raw: string, operationId: string, payloadDigest: string): boolean {
  return hasOperationMarker([raw], operationId, payloadDigest);
}

function hasOperationId(raw: string, operationId: string): boolean {
  return raw.includes(operationMarkerPrefix(operationId));
}

function replaceControl(raw: string, state: LocalState, kind: WorkArtifactKind): string {
  if (!CONTROL_PATTERN.test(raw)) throw new TrackerIdentityConflictError("missing-local-control");
  return raw.replace(CONTROL_PATTERN, renderControl(state, kind));
}

export class LocalMarkdownWorkTracker implements WorkTracker {
  public readonly kind = "local_markdown" as const;
  public readonly namespace: string;
  public readonly relationships = { parent: "body", blockers: "body" } as const;
  private readonly repositoryRoot: string;
  private readonly repositoryRealRoot: string;
  private readonly containment: LocalFileContainment;
  private readonly effortSlug: string;
  private readonly effortRelative: string;
  private readonly effortRoot: string;

  public constructor(options: LocalMarkdownWorkTrackerOptions) {
    if (!isAbsolute(options.repositoryRoot)) {
      throw new TypeError("repositoryRoot must be absolute");
    }
    this.repositoryRoot = resolve(options.repositoryRoot);
    this.repositoryRealRoot = realpathSync(this.repositoryRoot);
    const repositoryStats = lstatSync(this.repositoryRealRoot);
    if (!repositoryStats.isDirectory()) throw new TypeError("repositoryRoot must be a directory");
    this.containment = {
      root: this.repositoryRealRoot,
      dev: repositoryStats.dev,
      ino: repositoryStats.ino,
    };
    this.effortSlug = assertBoundedString(options.effortSlug, "effortSlug", 64);
    if (!EFFORT_SLUG.test(this.effortSlug)) {
      throw new TypeError("effortSlug must be a lowercase kebab-case slug");
    }
    this.effortRelative = `.scratch/${this.effortSlug}`;
    this.effortRoot = resolve(this.repositoryRoot, ".scratch", this.effortSlug);
    this.namespace = `local_markdown:${sha256(`${this.repositoryRealRoot}\u0000${this.effortSlug}`)}`;
  }

  public async create(input: CreateTrackerArtifactInput): Promise<TrackerArtifact> {
    const reconciled = await this.reconcile({ operationId: input.operationId });
    if (reconciled) {
      this.assertCreateReplay(reconciled, input);
      return reconciled;
    }
    const title = normalizeTrackerTitle(input.title);
    await this.ensureDirectories();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const externalId = await this.allocateExternalId(input.kind, title, attempt);
      const absolutePath = this.resolveExternalId(externalId);
      const state: LocalState = {
        status: "open",
        assignees: [],
        parentExternalId: null,
        blockerExternalIds: [],
      };
      const raw = [
        `# ${title}`,
        "",
        renderControl(state, input.kind),
        "",
        renderTrackedBody(input),
        "",
        "## Comments",
      ].join("\n");
      assertWritableLocalArtifact(raw);
      try {
        await this.atomicCreate(absolutePath, raw);
        return await this.read(externalId);
      } catch (error) {
        if (!this.isAlreadyExists(error)) throw error;
        const replay = await this.reconcile({ operationId: input.operationId });
        if (replay) {
          this.assertCreateReplay(replay, input);
          return replay;
        }
        if (input.kind === "map" || input.kind === "specification") {
          throw new TrackerIdentityConflictError(input.operationId);
        }
      }
    }
    throw new TrackerIdentityConflictError(input.operationId);
  }

  public async read(externalId: string): Promise<TrackerArtifact> {
    const parsed = await this.readParsed(externalId);
    const all = await this.scanParsed();
    return {
      ...parsed.artifact,
      childExternalIds: all
        .filter((candidate) => candidate.state.parentExternalId === parsed.artifact.externalId)
        .map((candidate) => candidate.artifact.externalId)
        .sort(compareExternalIds),
    };
  }

  public async updateOwnedSection(input: UpdateOwnedSectionInput): Promise<TrackerArtifact> {
    return this.mutate(input, ownedSectionPayloadDigest(input), (current) => updateOwnedSectionBody(
      current.raw,
      input.sectionId,
      input.content,
      input.operationId,
      "## Comments",
    ));
  }

  public async comment(input: CommentTrackerArtifactInput): Promise<TrackerArtifact> {
    const payloadDigest = commentPayloadDigest(input.comment);
    return this.mutate(input, payloadDigest, (current) => `${current.raw.trimEnd()}\n\n${renderComment(
      input.comment,
      input.operationId,
      payloadDigest,
    )}\n`);
  }

  public async setParent(input: SetTrackerParentInput): Promise<TrackerArtifact> {
    if (this.sameLocalFileIdentity(input.externalId, input.parentExternalId)) {
      throw new TrackerConflictError(input.externalId);
    }
    const externalId = this.validateExternalId(input.externalId);
    const parentExternalId = this.validateExternalId(input.parentExternalId);
    const payloadDigest = parentPayloadDigest(parentExternalId);
    if (this.resolveExternalId(parentExternalId) === this.resolveExternalId(externalId)) {
      throw new TrackerConflictError(externalId);
    }
    await this.readParsed(parentExternalId);
    const updated = await this.mutate(input, payloadDigest, (current) => this.updateState(current, {
      ...current.state,
      parentExternalId,
    }, input.operationId, payloadDigest));
    if (updated.parentExternalId !== parentExternalId) {
      throw new TrackerConflictError(updated.externalId);
    }
    return updated;
  }

  public async setBlockers(input: SetTrackerBlockersInput): Promise<TrackerArtifact> {
    if (input.blockerExternalIds.some((blockerId) =>
      this.sameLocalFileIdentity(input.externalId, blockerId))) {
      throw new TrackerConflictError(input.externalId);
    }
    const externalId = this.validateExternalId(input.externalId);
    const blockers = normalizeTrackerExternalIds(
      input.blockerExternalIds.map((blockerId) => this.validateExternalId(blockerId)),
      "blockerExternalIds",
    );
    const payloadDigest = blockersPayloadDigest(blockers);
    if (blockers.some((blockerId) =>
      this.resolveExternalId(blockerId) === this.resolveExternalId(externalId))) {
      throw new TrackerConflictError(externalId);
    }
    await Promise.all(blockers.map((externalId) => this.readParsed(externalId)));
    const updated = await this.mutate(input, payloadDigest, (current) => this.updateState(current, {
      ...current.state,
      blockerExternalIds: blockers,
    }, input.operationId, payloadDigest));
    if (JSON.stringify(updated.blockerExternalIds) !== JSON.stringify(blockers)) {
      throw new TrackerConflictError(updated.externalId);
    }
    return updated;
  }

  public async frontier(input: Readonly<{ parentExternalId: string }>): Promise<readonly TrackerArtifact[]> {
    const parentExternalId = this.validateExternalId(input.parentExternalId);
    await this.readParsed(parentExternalId);
    const all = await this.scanParsed();
    const byId = new Map(all.map((artifact) => [artifact.artifact.externalId, artifact]));
    return all
      .filter((candidate) => candidate.state.parentExternalId === parentExternalId)
      .filter((candidate) => candidate.artifact.state === "open")
      .filter((candidate) => candidate.artifact.assignees.length === 0)
      .filter((candidate) => candidate.state.blockerExternalIds.every((blockerId) => {
        const blocker = byId.get(blockerId);
        return blocker !== undefined && blocker.artifact.state !== "open";
      }))
      .sort((left, right) => compareExternalIds(left.artifact.externalId, right.artifact.externalId))
      .map((candidate) => candidate.artifact);
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
    const payloadDigest = terminalPayloadDigest("resolved", input.resolution);
    const updated = await this.mutate(input, payloadDigest, (current) => {
      if (current.state.status === "cancelled") {
        throw new TrackerConflictError(current.artifact.externalId);
      }
      const withResolution = `${current.raw.trimEnd()}\n\n${renderComment(
        input.resolution,
        input.operationId,
        payloadDigest,
      )}\n`;
      return this.updateState(
        { ...current, raw: withResolution },
        { ...current.state, status: "resolved", assignees: [] },
        input.operationId,
        payloadDigest,
      );
    });
    if (updated.state !== "closed") throw new TrackerConflictError(updated.externalId);
    return updated;
  }

  public async cancel(input: CancelTrackerArtifactInput): Promise<TrackerArtifact> {
    const payloadDigest = terminalPayloadDigest("cancelled", input.reason);
    const updated = await this.mutate(input, payloadDigest, (current) => {
      if (current.state.status === "resolved") {
        throw new TrackerConflictError(current.artifact.externalId);
      }
      const withReason = `${current.raw.trimEnd()}\n\n${renderComment(
        input.reason,
        input.operationId,
        payloadDigest,
      )}\n`;
      return this.updateState(
        { ...current, raw: withReason },
        { ...current.state, status: "cancelled", assignees: [] },
        input.operationId,
        payloadDigest,
      );
    });
    if (updated.state !== "cancelled") throw new TrackerConflictError(updated.externalId);
    return updated;
  }

  public async reconcile(input: Readonly<{ operationId: string }>): Promise<TrackerArtifact | null> {
    const operationId = normalizeOperationId(input.operationId);
    const matches = (await this.scanParsed()).filter((candidate) =>
      hasOperationId(candidate.raw, operationId));
    if (matches.length > 1) throw new TrackerIdentityConflictError(operationId);
    return matches[0]?.artifact ?? null;
  }

  public async operationStatus(input: Readonly<{
    externalId: string;
    operationId: string;
    payloadDigest: string;
  }>): Promise<TrackerOperationEvidence> {
    const current = await this.readParsed(input.externalId);
    const operationId = normalizeOperationId(input.operationId);
    if (hasOperation(current.raw, operationId, input.payloadDigest)) {
      return { status: "completed", artifact: current.artifact };
    }
    if (hasOperationId(current.raw, operationId)) {
      throw new TrackerIdentityConflictError(operationId);
    }
    return { status: "absent", artifact: current.artifact };
  }

  private async setClaim(
    input: TrackerClaimInput,
    action: "claim" | "renew" | "release",
  ): Promise<TrackerArtifact> {
    const assignee = assertBoundedString(input.assignee, "assignee");
    const assigned = action !== "release";
    const payloadDigest = claimPayloadDigest(action, assignee);
    if (!/^[A-Za-z0-9_.@-]+$/u.test(assignee)) {
      throw new TypeError("local tracker assignee contains an unsupported character");
    }
    const updated = await this.mutate(input, payloadDigest, (current) => {
      const assignees = new Set(current.state.assignees);
      if (assigned) assignees.add(assignee);
      else assignees.delete(assignee);
      const normalized = [...assignees].sort((left, right) => left.localeCompare(right));
      const terminal = current.state.status === "resolved" || current.state.status === "cancelled";
      if (assigned && terminal) throw new TrackerConflictError(current.artifact.externalId);
      return this.updateState(current, {
        ...current.state,
        assignees: normalized,
        status: terminal
          ? current.state.status
          : assigned ? "claimed" : normalized.length === 0 ? "ready" : "claimed",
      }, input.operationId, payloadDigest);
    });
    if (
      assigned
        ? updated.state !== "open" || !updated.assignees.includes(assignee)
        : updated.assignees.includes(assignee)
    ) {
      throw new TrackerConflictError(updated.externalId);
    }
    return updated;
  }

  private async mutate(
    input: Readonly<{ externalId: string; operationId: string; expectedRevision: string }>,
    payloadDigest: string,
    transform: (current: ParsedLocalArtifact) => string,
  ): Promise<TrackerArtifact> {
    const current = await this.readParsed(input.externalId);
    if (hasOperation(current.raw, input.operationId, payloadDigest)) return this.read(input.externalId);
    assertExpectedRevision(current.artifact, input.expectedRevision);
    const next = transform(current);
    assertWritableLocalArtifact(next);
    await this.atomicReplace(current.absolutePath, current.artifact.revision, next);
    return this.read(input.externalId);
  }

  private updateState(
    current: ParsedLocalArtifact,
    state: LocalState,
    operationId: string,
    payloadDigest: string,
  ): string {
    const controlled = replaceControl(current.raw, state, current.artifact.kind);
    return appendOperationMarker(controlled, operationId, payloadDigest);
  }

  private async readParsed(externalIdValue: string): Promise<ParsedLocalArtifact> {
    await this.assertDirectoryChain(false);
    const externalId = this.validateExternalId(externalIdValue);
    const absolutePath = this.resolveExternalId(externalId);
    await this.recoverFile(absolutePath);
    await this.assertRegularFile(absolutePath, externalId);
    let raw: string;
    try {
      raw = await readBoundedLocalFile(absolutePath, this.containment);
    } catch (error) {
      if (this.isNotFound(error)) throw new TrackerNotFoundError(externalId);
      throw error;
    }
    assertWritableLocalArtifact(raw);
    const metadata = parseArtifactMetadata(raw);
    try {
      if (!hasOperation(raw, metadata.operationId, metadata.createDigest)) {
        throw new TrackerConflictError(externalId);
      }
    } catch (error) {
      if (error instanceof TrackerIdentityConflictError) {
        throw new TrackerConflictError(externalId);
      }
      throw error;
    }
    const parsedState = parseControl(raw, metadata.kind);
    const state: LocalState = {
      ...parsedState,
      parentExternalId: parsedState.parentExternalId === null
        ? null
        : this.validateExternalId(parsedState.parentExternalId),
      blockerExternalIds: normalizeTrackerExternalIds(
        parsedState.blockerExternalIds.map((blockerId) => this.validateExternalId(blockerId)),
        "local metadata blocker IDs",
      ),
    };
    if (
      state.parentExternalId !== null && this.sameLocalFileIdentity(externalId, state.parentExternalId) ||
      state.blockerExternalIds.some((blockerId) => this.sameLocalFileIdentity(externalId, blockerId))
    ) throw new TrackerConflictError(externalId);
    const titleMatch = /^#\s+(.+)$/mu.exec(raw);
    if (!titleMatch) throw new TrackerIdentityConflictError(metadata.operationId);
    return {
      raw,
      absolutePath,
      state,
      artifact: {
        trackerKind: "local_markdown",
        externalId,
        url: null,
        revision: sha256(raw),
        operationId: metadata.operationId,
        createDigest: metadata.createDigest,
        kind: metadata.kind,
        title: titleMatch[1].trim(),
        body: projectLocalBody(raw),
        acceptanceCriteria: parseAcceptanceCriteria(raw),
        state: trackerState(state.status),
        assignees: state.assignees,
        comments: parseComments(raw),
        parentExternalId: state.parentExternalId,
        blockerExternalIds: state.blockerExternalIds,
        childExternalIds: [],
      },
    };
  }

  private async scanParsed(): Promise<readonly ParsedLocalArtifact[]> {
    const externalIds = await this.listExternalIds();
    const parsed: ParsedLocalArtifact[] = [];
    for (const externalId of externalIds) parsed.push(await this.readParsed(externalId));
    const childIdsByParent = new Map<string, string[]>();
    for (const item of parsed) {
      if (!item.state.parentExternalId) continue;
      const children = childIdsByParent.get(item.state.parentExternalId) ?? [];
      children.push(item.artifact.externalId);
      childIdsByParent.set(item.state.parentExternalId, children);
    }
    return parsed.map((item) => ({
      ...item,
      artifact: {
        ...item.artifact,
        childExternalIds: (childIdsByParent.get(item.artifact.externalId) ?? [])
          .sort(compareExternalIds),
      },
    }));
  }

  private async listExternalIds(): Promise<readonly string[]> {
    await this.assertDirectoryChain(true);
    const result: string[] = [];
    for (const name of ["map.md", "spec.md"]) {
      const absolute = join(this.effortRoot, name);
      await this.recoverFile(absolute);
      try {
        const stat = await lstat(absolute);
        if (stat.isSymbolicLink()) throw new TypeError(`local tracker artifact ${name} is a symlink`);
        if (stat.isFile()) result.push(`${this.effortRelative}/${name}`);
      } catch (error) {
        if (!this.isNotFound(error)) throw error;
      }
    }
    const issuesRoot = join(this.effortRoot, "issues");
    try {
      let entries = await readdir(issuesRoot, { withFileTypes: true });
      for (const entry of entries) {
        const lock = /^(.+\.md)\.hanoon-cas-lock$/u.exec(entry.name);
        if (entry.isFile() && lock && this.isCanonicalIssueFile(lock[1])) {
          await this.recoverFile(join(issuesRoot, lock[1]));
        }
      }
      entries = await readdir(issuesRoot, { withFileTypes: true });
      const issueNumbers = new Set<number>();
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          throw new TypeError(`local tracker artifact ${entry.name} is a symlink`);
        }
        if (!entry.isFile()) continue;
        const issueShape = ISSUE_SHAPED_FILE.exec(entry.name);
        if (!issueShape) continue;
        if (!this.isCanonicalIssueFile(entry.name)) {
          throw new TypeError("externalId must be a canonical local artifact ID");
        }
        const issueNumber = Number(issueShape[1]);
        if (issueNumbers.has(issueNumber)) {
          throw new TypeError("local tracker contains a duplicate local issue number");
        }
        issueNumbers.add(issueNumber);
        result.push(`${this.effortRelative}/issues/${entry.name}`);
      }
    } catch (error) {
      if (!this.isNotFound(error)) throw error;
    }
    return result.sort(compareExternalIds);
  }

  private async allocateExternalId(
    kind: WorkArtifactKind,
    title: string,
    attempt: number,
  ): Promise<string> {
    if (kind === "map") return `${this.effortRelative}/map.md`;
    if (kind === "specification") return `${this.effortRelative}/spec.md`;
    const existing = await this.listExternalIds();
    const maximum = existing.reduce((current, externalId) => {
      const match = /\/issues\/(\d+)-/u.exec(externalId);
      return match ? Math.max(current, Number(match[1])) : current;
    }, 0);
    const number = maximum + 1 + attempt;
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new TypeError("next local issue number exceeds the maximum safe local issue number");
    }
    return `${this.effortRelative}/issues/${String(number).padStart(2, "0")}-${slugify(title)}.md`;
  }

  private validateExternalId(externalIdValue: string): string {
    if (
      typeof externalIdValue !== "string" || externalIdValue.length === 0 ||
      externalIdValue.length > 1_024 || externalIdValue.normalize("NFKC").trim() !== externalIdValue
    ) throw new TypeError("externalId must be a canonical local artifact ID");
    if (
      externalIdValue === `${this.effortRelative}/map.md` ||
      externalIdValue === `${this.effortRelative}/spec.md`
    ) return externalIdValue;
    const prefix = `${this.effortRelative}/issues/`;
    if (!externalIdValue.startsWith(prefix) || !this.isCanonicalIssueFile(externalIdValue.slice(prefix.length))) {
      throw new TypeError("externalId must be a canonical local artifact ID");
    }
    return externalIdValue;
  }

  private isCanonicalIssueFile(fileName: string): boolean {
    const match = LOCAL_ISSUE_FILE.exec(fileName);
    return match !== null && Number.isSafeInteger(Number(match[1])) && match[2].length <= 64;
  }

  private sameLocalFileIdentity(left: string, right: string): boolean {
    const identity = (value: string): string | null => {
      if (typeof value !== "string" || value.includes("\u0000") || value.includes("\\")) return null;
      const absolute = resolve(this.repositoryRoot, value.normalize("NFKC").trim());
      const rootPrefix = `${this.effortRoot}${sep}`;
      return absolute.startsWith(rootPrefix) ? absolute : null;
    };
    const leftIdentity = identity(left);
    return leftIdentity !== null && leftIdentity === identity(right);
  }

  private resolveExternalId(externalId: string): string {
    const absolute = resolve(this.repositoryRoot, externalId);
    const rootPrefix = `${this.effortRoot}${sep}`;
    if (absolute !== this.effortRoot && !absolute.startsWith(rootPrefix)) {
      throw new TypeError("externalId escaped the configured local tracker effort");
    }
    return absolute;
  }

  private async ensureDirectories(): Promise<void> {
    await this.assertDirectoryChain(true);
    await this.ensureDirectory(join(this.repositoryRoot, ".scratch"));
    await this.ensureDirectory(this.effortRoot);
    await this.ensureDirectory(join(this.effortRoot, "issues"));
    await this.assertDirectoryChain(false);
  }

  private async assertDirectoryChain(allowMissing: boolean): Promise<void> {
    const directories = [
      this.repositoryRoot,
      join(this.repositoryRoot, ".scratch"),
      this.effortRoot,
      join(this.effortRoot, "issues"),
    ];
    for (const directory of directories) {
      try {
        const stat = await lstat(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new TypeError(`local tracker directory ${directory} is not a regular directory`);
        }
        const resolvedDirectory = await realpath(directory);
        const relativeDirectory = relative(this.repositoryRealRoot, resolvedDirectory);
        if (
          relativeDirectory === ".." || relativeDirectory.startsWith(`..${sep}`) ||
          isAbsolute(relativeDirectory)
        ) {
          throw new TypeError("local tracker directory resolves outside the repository root");
        }
        if (directory === this.repositoryRoot && resolvedDirectory !== this.repositoryRealRoot) {
          throw new TypeError("local tracker repository root changed after configuration");
        }
        if (
          directory === this.repositoryRoot &&
          (stat.dev !== this.containment.dev || stat.ino !== this.containment.ino)
        ) {
          throw new TypeError("local tracker repository root identity changed after configuration");
        }
      } catch (error) {
        if (allowMissing && directory !== this.repositoryRoot && this.isNotFound(error)) continue;
        throw error;
      }
    }
  }

  private async ensureDirectory(path: string): Promise<void> {
    await ensureLocalDirectory(path, this.containment);
  }

  private async assertRegularFile(absolutePath: string, externalId: string): Promise<void> {
    try {
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new TypeError(`local tracker artifact ${externalId} is not a regular file`);
      }
    } catch (error) {
      if (this.isNotFound(error)) throw new TrackerNotFoundError(externalId);
      throw error;
    }
  }

  private async recoverFile(absolutePath: string): Promise<void> {
    try {
      await recoverLocalFileCas(absolutePath, this.containment);
    } catch (error) {
      if (error instanceof LocalFileCasConflictError) {
        throw new TrackerConflictError(this.toExternalId(absolutePath));
      }
      throw error;
    }
  }

  private async atomicCreate(absolutePath: string, content: string): Promise<void> {
    try {
      await this.assertDirectoryChain(false);
      await atomicCreateLocalFile(absolutePath, content, this.containment);
    } catch (error) {
      if (error instanceof LocalFileCasConflictError) {
        throw new TrackerConflictError(this.toExternalId(absolutePath));
      }
      throw error;
    }
  }

  private async atomicReplace(
    absolutePath: string,
    expectedDigest: string,
    content: string,
  ): Promise<void> {
    try {
      await this.assertDirectoryChain(false);
      await compareAndSwapLocalFile(absolutePath, expectedDigest, content, this.containment);
    } catch (error) {
      if (error instanceof LocalFileCasConflictError) {
        throw new TrackerConflictError(this.toExternalId(absolutePath));
      }
      throw error;
    }
  }

  private toExternalId(absolutePath: string): string {
    return relative(this.repositoryRoot, absolutePath).split(sep).join("/");
  }

  private assertCreateReplay(artifact: TrackerArtifact, input: CreateTrackerArtifactInput): void {
    if (
      artifact.operationId !== normalizeOperationId(input.operationId) ||
      artifact.createDigest !== trackerCreateDigest(input) ||
      artifact.kind !== input.kind ||
      artifact.title !== normalizeTrackerTitle(input.title)
    ) {
      throw new TrackerIdentityConflictError(input.operationId);
    }
  }

  private isNotFound(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error &&
      (error as { code?: unknown }).code === "ENOENT";
  }

  private isAlreadyExists(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error &&
      (error as { code?: unknown }).code === "EEXIST";
  }
}
