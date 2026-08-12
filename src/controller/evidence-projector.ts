import type { BbPluginApi } from "@bb/plugin-sdk";
import { posix, win32 } from "node:path";
import type { TelegramAgentStore } from "../storage/store";
import type {
  ControllerEvidenceOutcome,
  ControllerNativeEvidenceCandidate,
} from "../storage/controller-evidence-repository";
import {
  canonicalControllerJson,
  sha256ControllerJson,
} from "./capability-executor";
import { SLICE_1_CONTROLLER_TOOL_NAMES } from "./capability-policy";
import {
  CONTROLLER_EVENT_PAGE_LIMIT,
  MAX_CONTROLLER_EVENT_PAGES,
} from "./bb-controller";
import type {
  ControllerLeaseFence,
  ControllerThreadRecord,
  ControllerTurnRecord,
} from "./models";

type BbSdk = BbPluginApi["sdk"];
type ThreadEventRow = Awaited<ReturnType<BbSdk["threads"]["events"]["list"]>>[number];
type CompletedEventRow = Extract<ThreadEventRow, { type: "item/completed" }>;
const NATIVE_ITEM_TYPES = [
  "commandExecution",
  "fileChange",
  "webSearch",
  "webFetch",
  "imageView",
  "toolCall",
] as const;
type NativeItemType = (typeof NATIVE_ITEM_TYPES)[number];

export type ControllerCompletedNativeItem = Extract<
  CompletedEventRow["data"]["item"],
  { type: NativeItemType }
>;

export type ControllerProjectionRoots = Readonly<{
  projectRoot: string | null;
}>;

export type ControllerEvidenceReconciliationIncomplete = "page_cap" | "source_gap";

export type ControllerEvidenceReconciliation = Readonly<{
  outcome: "reconciled" | "limit_exceeded" | "stale" | "finalized";
  reconciliationIncomplete: ControllerEvidenceReconciliationIncomplete | null;
  fromSeq: number;
  throughSeq: number;
  targetSeq: number | null;
}>;

export type ControllerEvidenceReconciler = Pick<ControllerEvidenceProjector, "reconcile">;

export type ControllerEvidenceProjectorErrorCode =
  | "source_identity_invalid"
  | "source_event_invalid"
  | "native_identity_conflict"
  | "cursor_conflict";

export class ControllerEvidenceProjectorError extends Error {
  public constructor(public readonly code: ControllerEvidenceProjectorErrorCode) {
    super(`Controller evidence projection failed: ${code}`);
    this.name = "ControllerEvidenceProjectorError";
  }
}

type ProjectorDependencies = Readonly<{
  sdk: BbSdk;
  store: TelegramAgentStore;
  clock: Readonly<{ now(): number }>;
  hanoonToolNames: Iterable<string>;
}>;

type ReadyTurn = Readonly<{
  outcome: "ready";
  turn: ControllerTurnRecord;
}>;

type UnavailableTurn = Readonly<{
  outcome: "limit_exceeded" | "stale" | "finalized";
  turn: ControllerTurnRecord | null;
}>;

type AttemptTurn = ReadyTurn | UnavailableTurn;

type ScannedBatch = Readonly<{
  candidates: readonly ControllerNativeEvidenceCandidate[];
  fromSeq: number;
  throughSeq: number;
  reconciliationIncomplete: ControllerEvidenceReconciliationIncomplete | null;
}>;

type NativeCandidateProjection = Readonly<{
  nativeItem: ControllerCompletedNativeItem;
  outcome: ControllerEvidenceOutcome;
  argsProjection: unknown;
  resultProjection: unknown;
  proofKind: ControllerNativeEvidenceCandidate["proofKinds"][number];
  subjectRefs?: readonly string[];
}>;

type ReconciliationTarget = Readonly<{
  controller: ControllerThreadRecord;
  turnId: string;
  fence: ControllerLeaseFence;
  projectRoot: string;
  targetSeq: number;
  signal: AbortSignal;
}>;

type ScanRequest = Readonly<{
  threadId: string;
  turn: ControllerTurnRecord;
  projectRoot: string;
  targetSeq: number;
  signal: AbortSignal;
}>;

type PageProjectionRequest = Readonly<{
  rows: readonly ThreadEventRow[];
  threadId: string;
  afterSeq: number;
  targetSeq: number;
  projectRoot: string;
  candidates: Map<string, ControllerNativeEvidenceCandidate>;
}>;

type CommitRequest = Readonly<{
  controller: ControllerThreadRecord;
  turn: ControllerTurnRecord;
  fence: ControllerLeaseFence;
  batch: ScannedBatch;
  signal: AbortSignal;
}>;

type AttemptWrite = ReturnType<TelegramAgentStore["recordControllerNativeEvidence"]>;

type ReconciliationAttempt = Readonly<{
  batch: ScannedBatch;
  write: AttemptWrite;
}>;

type ScannedPage = Readonly<{
  cursor: number;
  aboveTarget: boolean;
  rowCount: number;
}>;

const DEFAULT_HANOON_TOOL_NAMES: ReadonlySet<string> = new Set(SLICE_1_CONTROLLER_TOOL_NAMES);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const MAX_NATIVE_ID_BYTES = 256;
const MAX_SUBJECT_BYTES = 256;
const MAX_SUBJECTS = 16;
const NATIVE_ITEM_TYPE_SET: ReadonlySet<string> = new Set(NATIVE_ITEM_TYPES);

function isCompletedNativeItem(nativeItem: unknown): nativeItem is ControllerCompletedNativeItem {
  if (nativeItem === null || typeof nativeItem !== "object") return false;
  const candidate = nativeItem as { type?: unknown; id?: unknown };
  return typeof candidate.type === "string" && NATIVE_ITEM_TYPE_SET.has(candidate.type) &&
    typeof candidate.id === "string";
}

function ownDefinedFields(
  source: object,
  fields: readonly string[],
): Record<string, unknown> {
  const sourceRecord = source as Record<string, unknown>;
  const selected: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.hasOwn(sourceRecord, field) && sourceRecord[field] !== undefined) {
      selected[field] = sourceRecord[field];
    }
  }
  return selected;
}

function validNativeIdentity(id: string): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  if (Buffer.byteLength(id, "utf8") > MAX_NATIVE_ID_BYTES) return false;
  return Buffer.byteLength(`bb-item:${id}`, "utf8") <= MAX_SUBJECT_BYTES;
}

function trustedRoot(root: string | null): root is string {
  if (typeof root !== "string" || root.length === 0 || CONTROL_CHARACTER.test(root)) return false;
  return posix.isAbsolute(root) || win32.isAbsolute(root);
}

function lexicalPathSubject(candidate: string): string | null {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  if (CONTROL_CHARACTER.test(candidate) || candidate.includes("\\")) return null;
  if (candidate.startsWith("/") || /^[A-Za-z]:/u.test(candidate)) return null;
  const segments = candidate.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
  const subject = `path:${candidate}`;
  return Buffer.byteLength(subject, "utf8") <= MAX_SUBJECT_BYTES ? subject : null;
}

function statusOutcome(
  status: "pending" | "completed" | "failed" | "interrupted",
  approvalStatus: "waiting_for_approval" | "denied" | null,
): ControllerEvidenceOutcome {
  if (approvalStatus === "denied") return "denied";
  if (approvalStatus === "waiting_for_approval") return "observed";
  if (status === "pending") return "observed";
  return status === "completed" ? "succeeded" : status;
}

function commandOutcome(
  nativeItem: Extract<ControllerCompletedNativeItem, { type: "commandExecution" }>,
): ControllerEvidenceOutcome {
  const outcome = statusOutcome(nativeItem.status, nativeItem.approvalStatus);
  if (outcome !== "succeeded") return outcome;
  return nativeItem.exitCode === undefined || nativeItem.exitCode === 0 ? "succeeded" : "failed";
}

function nativeEvidenceCandidate(
  projection: NativeCandidateProjection,
): ControllerNativeEvidenceCandidate {
  const { nativeItem } = projection;
  return {
    sourceName: nativeItem.type,
    sourceItemId: nativeItem.id,
    outcome: projection.outcome,
    argsSha256: sha256ControllerJson(projection.argsProjection),
    resultSha256: sha256ControllerJson(projection.resultProjection),
    proofKinds: [projection.proofKind],
    subjectRefs: projection.subjectRefs ?? [`bb-item:${nativeItem.id}`],
  };
}

function commandCandidate(
  nativeItem: Extract<ControllerCompletedNativeItem, { type: "commandExecution" }>,
): ControllerNativeEvidenceCandidate {
  return nativeEvidenceCandidate({
    nativeItem,
    outcome: commandOutcome(nativeItem),
    argsProjection: { type: nativeItem.type, command: nativeItem.command, cwd: nativeItem.cwd },
    resultProjection: {
      status: nativeItem.status,
      approvalStatus: nativeItem.approvalStatus,
      ...ownDefinedFields(nativeItem, ["aggregatedOutput", "exitCode", "durationMs", "truncation"]),
    },
    proofKind: "command_result",
  });
}

function fileSubjects(nativeItem: Extract<ControllerCompletedNativeItem, { type: "fileChange" }>): string[] {
  const subjects = [`bb-item:${nativeItem.id}`];
  const seen = new Set(subjects);
  for (const change of nativeItem.changes) {
    for (const candidate of [change.path, change.movePath]) {
      if (candidate === undefined) continue;
      const subject = lexicalPathSubject(candidate);
      if (subject === null || seen.has(subject)) continue;
      seen.add(subject);
      subjects.push(subject);
      if (subjects.length === MAX_SUBJECTS) return subjects;
    }
  }
  return subjects;
}

function fileCandidate(
  nativeItem: Extract<ControllerCompletedNativeItem, { type: "fileChange" }>,
  roots: ControllerProjectionRoots,
): ControllerNativeEvidenceCandidate {
  return nativeEvidenceCandidate({
    nativeItem,
    outcome: statusOutcome(nativeItem.status, nativeItem.approvalStatus),
    argsProjection: { type: nativeItem.type, changes: nativeItem.changes },
    resultProjection: { status: nativeItem.status, approvalStatus: nativeItem.approvalStatus },
    proofKind: "workspace_change",
    subjectRefs: trustedRoot(roots.projectRoot) ? fileSubjects(nativeItem) : [`bb-item:${nativeItem.id}`],
  });
}

function webSearchCandidate(
  nativeItem: Extract<ControllerCompletedNativeItem, { type: "webSearch" }>,
): ControllerNativeEvidenceCandidate {
  return nativeEvidenceCandidate({
    nativeItem,
    outcome: "succeeded",
    argsProjection: { type: nativeItem.type, queries: nativeItem.queries },
    resultProjection: { resultText: nativeItem.resultText },
    proofKind: "retrieved_content",
  });
}

function webFetchCandidate(
  nativeItem: Extract<ControllerCompletedNativeItem, { type: "webFetch" }>,
): ControllerNativeEvidenceCandidate {
  return nativeEvidenceCandidate({
    nativeItem,
    outcome: "succeeded",
    argsProjection: {
      type: nativeItem.type,
      url: nativeItem.url,
      prompt: nativeItem.prompt,
      pattern: nativeItem.pattern,
    },
    resultProjection: { resultText: nativeItem.resultText },
    proofKind: "retrieved_content",
  });
}

function imageCandidate(
  nativeItem: Extract<ControllerCompletedNativeItem, { type: "imageView" }>,
): ControllerNativeEvidenceCandidate {
  return nativeEvidenceCandidate({
    nativeItem,
    outcome: "succeeded",
    argsProjection: { type: nativeItem.type, path: nativeItem.path },
    resultProjection: { completed: true },
    proofKind: "retrieved_content",
  });
}

function toolCandidate(
  nativeItem: Extract<ControllerCompletedNativeItem, { type: "toolCall" }>,
): ControllerNativeEvidenceCandidate {
  return nativeEvidenceCandidate({
    nativeItem,
    outcome: statusOutcome(nativeItem.status, null),
    argsProjection: {
      type: nativeItem.type,
      ...ownDefinedFields(nativeItem, ["server"]),
      tool: nativeItem.tool,
      ...ownDefinedFields(nativeItem, ["arguments"]),
    },
    resultProjection: {
      status: nativeItem.status,
      ...ownDefinedFields(nativeItem, ["result", "error", "durationMs", "truncation"]),
    },
    proofKind: "tool_result",
  });
}

export function projectCompletedControllerItem(
  nativeItem: ControllerCompletedNativeItem,
  roots: ControllerProjectionRoots,
  hanoonToolNames: ReadonlySet<string> = DEFAULT_HANOON_TOOL_NAMES,
): ControllerNativeEvidenceCandidate | null {
  if (!validNativeIdentity(nativeItem.id)) return null;
  switch (nativeItem.type) {
    case "commandExecution": return commandCandidate(nativeItem);
    case "fileChange": return fileCandidate(nativeItem, roots);
    case "webSearch": return webSearchCandidate(nativeItem);
    case "webFetch": return webFetchCandidate(nativeItem);
    case "imageView": return imageCandidate(nativeItem);
    case "toolCall": return hanoonToolNames.has(nativeItem.tool) ? null : toolCandidate(nativeItem);
  }
}

function sameControllerIdentity(
  expected: ControllerThreadRecord,
  current: ControllerThreadRecord | null,
): boolean {
  return current !== null && current.state === "active" && expected.state === "active" &&
    current.controllerKey === expected.controllerKey &&
    current.telegramUserId === expected.telegramUserId &&
    current.telegramChatId === expected.telegramChatId &&
    current.threadId === expected.threadId &&
    current.projectId === expected.projectId && current.hostId === expected.hostId;
}

function unavailableResult(
  state: UnavailableTurn,
  fallbackCursor: number,
): ControllerEvidenceReconciliation {
  const cursor = state.turn?.evidenceEventSeq ?? fallbackCursor;
  return {
    outcome: state.outcome,
    reconciliationIncomplete: null,
    fromSeq: cursor,
    throughSeq: cursor,
    targetSeq: null,
  };
}

function evidenceIdentity(candidate: ControllerNativeEvidenceCandidate): string {
  return canonicalControllerJson({
    sourceName: candidate.sourceName,
    sourceItemId: candidate.sourceItemId,
    outcome: candidate.outcome,
    argsSha256: candidate.argsSha256,
    resultSha256: candidate.resultSha256,
    proofKinds: candidate.proofKinds,
    subjectRefs: candidate.subjectRefs,
  });
}

function addCandidate(
  candidates: Map<string, ControllerNativeEvidenceCandidate>,
  candidate: ControllerNativeEvidenceCandidate,
): void {
  const existing = candidates.get(candidate.sourceItemId);
  if (existing === undefined) {
    candidates.set(candidate.sourceItemId, candidate);
    return;
  }
  if (evidenceIdentity(existing) !== evidenceIdentity(candidate)) {
    throw new ControllerEvidenceProjectorError("native_identity_conflict");
  }
}

function validSequence(sequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 0;
}

function incompletePageReason(
  page: ScannedPage,
  pageIndex: number,
): ControllerEvidenceReconciliationIncomplete | null {
  if (page.aboveTarget || page.rowCount < CONTROLLER_EVENT_PAGE_LIMIT) return "source_gap";
  return pageIndex + 1 === MAX_CONTROLLER_EVENT_PAGES ? "page_cap" : null;
}

export class ControllerEvidenceProjector {
  private readonly hanoonToolNames: ReadonlySet<string>;

  public constructor(private readonly dependencies: ProjectorDependencies) {
    this.hanoonToolNames = new Set(dependencies.hanoonToolNames);
  }

  public async reconcile(
    controller: ControllerThreadRecord,
    turn: ControllerTurnRecord,
    fence: ControllerLeaseFence,
    signal: AbortSignal,
  ): Promise<ControllerEvidenceReconciliation> {
    const initial = this.currentTurn(controller, turn.id, fence);
    if (!this.matchesSubmittedTurn(turn, controller, fence) || initial.outcome !== "ready") {
      return initial.outcome === "ready"
        ? unavailableResult({ outcome: "stale", turn: initial.turn }, turn.evidenceEventSeq)
        : unavailableResult(initial, turn.evidenceEventSeq);
    }
    signal.throwIfAborted();
    const target = await this.snapshotTarget(controller, signal);
    return await this.reconcileToTarget({
      controller,
      turnId: turn.id,
      fence,
      ...target,
      signal,
    });
  }

  private matchesSubmittedTurn(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    fence: ControllerLeaseFence,
  ): boolean {
    return turn.state === "submitted" && turn.controllerKey === controller.controllerKey &&
      turn.leaseOwner !== null && turn.leaseGeneration !== null &&
      turn.leaseOwner === fence.ownerId && turn.leaseGeneration === fence.generation;
  }

  private currentTurn(
    controller: ControllerThreadRecord,
    turnId: string,
    fence: ControllerLeaseFence,
  ): AttemptTurn {
    if (!controller.threadId || !controller.projectId || !controller.hostId) {
      return { outcome: "stale", turn: null };
    }
    const durableController = this.dependencies.store.getControllerByThreadId(controller.threadId);
    if (!sameControllerIdentity(controller, durableController)) return { outcome: "stale", turn: null };
    const turn = this.dependencies.store.getControllerTurn(turnId);
    if (!turn || turn.controllerKey !== controller.controllerKey) return { outcome: "stale", turn };
    if (turn.acceptedFinalizationId !== null) return { outcome: "finalized", turn };
    if (turn.evidenceLimitExceededAt !== null) return { outcome: "limit_exceeded", turn };
    const pending = this.dependencies.store.getPendingControllerTurn(controller.controllerKey);
    if (pending?.id !== turn.id || !this.matchesSubmittedTurn(turn, controller, fence)) {
      return { outcome: "stale", turn };
    }
    const now = this.currentTime();
    return this.dependencies.store.isExecutorLeaseCurrent(fence.ownerId, fence.generation, now)
      ? { outcome: "ready", turn }
      : { outcome: "stale", turn };
  }

  private currentTime(): number {
    const now = this.dependencies.clock.now();
    if (!validSequence(now)) throw new ControllerEvidenceProjectorError("source_identity_invalid");
    return now;
  }

  private async projectRoot(
    controller: ControllerThreadRecord,
    signal: AbortSignal,
  ): Promise<string> {
    const thread = await this.dependencies.sdk.threads.get({ threadId: controller.threadId!, signal });
    if (!thread || thread.id !== controller.threadId || thread.projectId !== controller.projectId ||
      thread.environmentId === null) {
      throw new ControllerEvidenceProjectorError("source_identity_invalid");
    }
    signal.throwIfAborted();
    const environment = await this.dependencies.sdk.environments.get({
      environmentId: thread.environmentId,
      signal,
    });
    if (!environment || environment.id !== thread.environmentId ||
      environment.projectId !== controller.projectId || environment.hostId !== controller.hostId ||
      environment.status !== "ready" || environment.workspaceProvisionType !== "personal" ||
      !trustedRoot(environment.path)) {
      throw new ControllerEvidenceProjectorError("source_identity_invalid");
    }
    return environment.path;
  }

  private async snapshotTarget(
    controller: ControllerThreadRecord,
    signal: AbortSignal,
  ): Promise<Pick<ReconciliationTarget, "projectRoot" | "targetSeq">> {
    const projectRoot = await this.projectRoot(controller, signal);
    signal.throwIfAborted();
    const timeline = await this.dependencies.sdk.threads.timeline({
      threadId: controller.threadId!,
      summaryOnly: "true",
      signal,
    });
    if (!validSequence(timeline.maxSeq)) {
      throw new ControllerEvidenceProjectorError("source_event_invalid");
    }
    return { projectRoot, targetSeq: timeline.maxSeq };
  }

  private async reconcileToTarget(
    request: ReconciliationTarget,
  ): Promise<ControllerEvidenceReconciliation> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = this.currentTurn(request.controller, request.turnId, request.fence);
      if (state.outcome !== "ready") return unavailableResult(state, 0);
      const completed = await this.reconciliationAttempt(request, state.turn);
      if (completed.write === "cursor_changed") continue;
      return this.attemptResult(request, completed);
    }
    throw new ControllerEvidenceProjectorError("cursor_conflict");
  }

  private async reconciliationAttempt(
    request: ReconciliationTarget,
    turn: ControllerTurnRecord,
  ): Promise<ReconciliationAttempt> {
    const batch = await this.scanBatch({
      threadId: request.controller.threadId!,
      turn,
      projectRoot: request.projectRoot,
      targetSeq: request.targetSeq,
      signal: request.signal,
    });
    const write = this.commitBatch({
      controller: request.controller,
      turn,
      fence: request.fence,
      batch,
      signal: request.signal,
    });
    return { batch, write };
  }

  private attemptResult(
    request: ReconciliationTarget,
    attempt: ReconciliationAttempt,
  ): ControllerEvidenceReconciliation {
    if (attempt.write === "native_identity_conflict") {
      throw new ControllerEvidenceProjectorError("native_identity_conflict");
    }
    if (attempt.write === "limit_exceeded") {
      return this.writeResult("limit_exceeded", attempt.batch, request.targetSeq);
    }
    if (attempt.write !== "stale") {
      return this.writeResult("reconciled", attempt.batch, request.targetSeq);
    }
    const current = this.currentTurn(request.controller, request.turnId, request.fence);
    return current.outcome === "ready"
      ? this.writeResult("stale", attempt.batch, request.targetSeq)
      : unavailableResult(current, attempt.batch.fromSeq);
  }

  private async scanBatch(
    request: ScanRequest,
  ): Promise<ScannedBatch> {
    const candidates = new Map<string, ControllerNativeEvidenceCandidate>();
    let cursor = request.turn.evidenceEventSeq;
    let incomplete: ControllerEvidenceReconciliationIncomplete | null = null;
    for (let page = 0; cursor < request.targetSeq && page < MAX_CONTROLLER_EVENT_PAGES; page += 1) {
      const scannedPage = await this.scanPage(request, cursor, candidates);
      cursor = scannedPage.cursor;
      if (cursor >= request.targetSeq) break;
      incomplete = incompletePageReason(scannedPage, page);
      if (incomplete !== null) break;
    }
    return {
      candidates: [...candidates.values()],
      fromSeq: request.turn.evidenceEventSeq,
      throughSeq: cursor,
      reconciliationIncomplete: incomplete,
    };
  }

  private async scanPage(
    request: ScanRequest,
    cursor: number,
    candidates: Map<string, ControllerNativeEvidenceCandidate>,
  ): Promise<ScannedPage> {
    const rows = await this.eventPage(request, cursor);
    const projected = this.projectPage({
      rows,
      threadId: request.threadId,
      afterSeq: cursor,
      targetSeq: request.targetSeq,
      projectRoot: request.projectRoot,
      candidates,
    });
    return { ...projected, rowCount: rows.length };
  }

  private async eventPage(
    request: ScanRequest,
    cursor: number,
  ): Promise<readonly ThreadEventRow[]> {
    request.signal.throwIfAborted();
    return await this.dependencies.sdk.threads.events.list({
      threadId: request.threadId,
      afterSeq: String(cursor),
      limit: String(CONTROLLER_EVENT_PAGE_LIMIT),
      signal: request.signal,
    });
  }

  private projectPage(
    request: PageProjectionRequest,
  ): { cursor: number; aboveTarget: boolean } {
    if (request.rows.length > CONTROLLER_EVENT_PAGE_LIMIT) {
      throw new ControllerEvidenceProjectorError("source_event_invalid");
    }
    let cursor = request.afterSeq;
    let previousSeq = request.afterSeq;
    let aboveTarget = false;
    for (const row of request.rows) {
      if (row.threadId !== request.threadId || !validSequence(row.seq) || row.seq <= previousSeq) {
        throw new ControllerEvidenceProjectorError("source_event_invalid");
      }
      previousSeq = row.seq;
      if (row.seq > request.targetSeq) {
        aboveTarget = true;
        continue;
      }
      cursor = row.seq;
      this.projectNativeRow(request, row);
    }
    return { cursor, aboveTarget };
  }

  private projectNativeRow(
    request: PageProjectionRequest,
    row: ThreadEventRow,
  ): void {
    if (row.type !== "item/completed" || !isCompletedNativeItem(row.data.item)) return;
    const candidate = projectCompletedControllerItem(
      row.data.item,
      { projectRoot: request.projectRoot },
      this.hanoonToolNames,
    );
    if (candidate !== null) addCandidate(request.candidates, candidate);
  }

  private commitBatch(
    request: CommitRequest,
  ): ReturnType<TelegramAgentStore["recordControllerNativeEvidence"]> {
    request.signal.throwIfAborted();
    return this.dependencies.store.recordControllerNativeEvidence({
      ownerId: request.fence.ownerId,
      generation: request.fence.generation,
      now: this.currentTime(),
      turnId: request.turn.id,
      controllerKey: request.controller.controllerKey,
      fromSeq: request.batch.fromSeq,
      throughSeq: request.batch.throughSeq,
      items: request.batch.candidates,
    });
  }

  private writeResult(
    outcome: ControllerEvidenceReconciliation["outcome"],
    batch: ScannedBatch,
    targetSeq: number,
  ): ControllerEvidenceReconciliation {
    return {
      outcome,
      reconciliationIncomplete: batch.reconciliationIncomplete,
      fromSeq: batch.fromSeq,
      throughSeq: batch.throughSeq,
      targetSeq,
    };
  }
}
