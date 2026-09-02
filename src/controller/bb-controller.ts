import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { OperationDeadlineError, withAbortDeadline } from "../async";
import {
  MAX_CONTROLLER_IMAGE_BYTES,
  type ControllerImage,
  type ControllerThreadRecord,
  type ControllerTurnRecord,
} from "./models";
import {
  controllerExecutionArguments,
  controllerProviderFor,
  type ControllerExecutionProfile,
} from "./execution-profile";
import {
  type ControllerQuestionAnswers,
} from "./questions";

export type ControllerLocation = {
  threadId: string;
  projectId: string;
  hostId: string;
  /** The exact pending token carried by the tokenized spawn title. */
  spawnToken: string;
};
export type ControllerStatus =
  | "idle"
  | "active"
  /** BB has accepted the thread but has not started its provider session yet. */
  | "pending"
  | "starting"
  | "stopping"
  | "error"
  | "missing"
  /** The live thread runs a different provider than the configured model needs. */
  | "incompatible";
export type ControllerInteractionReference = Readonly<{
  interactionId: string;
  kind: "user_question" | "approval" | "unsupported";
  status: "pending" | "resolved" | "interrupted";
}>;
export type ControllerInteractionSnapshot = Readonly<{
  id: string;
  threadId: string;
  status: string;
  payload: unknown;
  resolution?: unknown;
}>;
export type ControllerProviderFailureCode =
  | "startup_timeout"
  | "process_exit"
  | "oauth_expired"
  | "host_disconnected"
  | "rpc_timeout"
  | "provider_rejected"
  | "unknown";
export type ControllerProviderFailure = Readonly<{
  code: ControllerProviderFailureCode;
  retryable: boolean;
  willRetry: boolean;
  inputAccepted: boolean;
}>;
export type ControllerAssistantDraft = Readonly<{
  itemId: string | null;
  text: string;
}>;
export type ControllerEventObservation = {
  latestSeq: number;
  inputAccepted: boolean;
  assistantOutputObserved: boolean;
  toolActivityObserved: boolean;
  completed: boolean;
  failure: ControllerProviderFailure | null;
  /** Private recovery material. It must never be projected into Telegram. */
  assistantDraft: ControllerAssistantDraft | null;
  /** Bounded lifecycle references; BB interaction payloads are never event authority. */
  interactionReferences?: readonly ControllerInteractionReference[];
  /** Tool-shaped item starts in this window; the caller accumulates them. */
  toolCalls: number;
  /** Non-zero command exits in this window; the caller accumulates them. */
  commandFailures: number;
  /** Highest cumulative thread token total in this window, else 0. */
  totalTokens: number;
};

type LegacyControllerEventObservation = Omit<ControllerEventObservation, "assistantOutputObserved" | "toolActivityObserved" | "interactionReferences" | "failure" | "assistantDraft"> & {
  error: string | null;
  interactionReferences?: readonly ControllerInteractionReference[];
} & Record<string, unknown>;

export type ControllerEventResult = ControllerEventObservation | LegacyControllerEventObservation;
export type ControllerSteerReconciliation = "applied" | "not_applied" | "unknown";

type ControllerAdapterMethods = {
  spawn(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    signal: AbortSignal,
  ): Promise<ControllerLocation>;
  send(
    threadId: string,
    text: string,
    signal: AbortSignal,
    image?: ControllerImage | null,
    modelFallbackIndex?: number,
  ): Promise<void>;
  /** Redirects a thread that is already working, rather than queueing behind it. */
  steer(
    threadId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<void>;
  /** Reconciles a previously reserved steer without replaying it. */
  reconcileSteer?(input: {
    threadId: string;
    text: string;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<ControllerSteerReconciliation>;
  answerQuestion(
    threadId: string,
    interactionId: string,
    answers: ControllerQuestionAnswers,
    signal: AbortSignal,
  ): Promise<void>;
  getInteraction?(
    threadId: string,
    interactionId: string,
    signal: AbortSignal,
  ): Promise<ControllerInteractionSnapshot>;
  resolveInteraction?(
    threadId: string,
    interactionId: string,
    resolution: ControllerInteractionResolution,
    signal: AbortSignal,
  ): Promise<void>;
  status(threadId: string, signal: AbortSignal, modelFallbackIndex?: number): Promise<ControllerStatus>;
  latestSeq(threadId: string, signal: AbortSignal): Promise<number>;
  events(threadId: string, afterSeq: number, signal: AbortSignal): Promise<ControllerEventResult>;
  findSpawnCandidate(controllerKey: string, pendingSpawnToken: string, signal: AbortSignal, modelFallbackIndex?: number): Promise<ControllerLocation | null>;
  configuredProfileCount?(): number;
  /** True while an SDK mutation abandoned at its deadline is still running. */
  hasPendingMutation?(): boolean;
};

export type ControllerAdapter = ControllerAdapterMethods;

export const CONTROLLER_EVENT_PAGE_LIMIT = 100;
export const MAX_CONTROLLER_EVENT_PAGES = 50;
const CONTROLLER_THREAD_PAGE_LIMIT = 100;
const MAX_CONTROLLER_THREAD_PAGES = 50;
const MAX_CONTROLLER_INTERACTION_REFERENCES = 256;
export const MAX_CONTROLLER_PRIVATE_DRAFT_CHARS = 4_000;
/** Bounds one SDK request/response exchange, never the lifetime of a turn. */
export const CONTROLLER_PROVIDER_RPC_TIMEOUT_MS = 30_000;

// Reasoning, plain messages, and plan updates are the model thinking out loud.
// Everything here reaches outside the model, which is what a budget should bound.
const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  "commandExecution",
  "toolCall",
  "webSearch",
  "fileChange",
  "backgroundTask",
]);

type BbSdk = BbPluginApi["sdk"];
type ControllerPromptInput = Parameters<BbSdk["threads"]["send"]>[0]["input"];
type ControllerEventRow = Awaited<ReturnType<BbSdk["threads"]["events"]["list"]>>[number];

type ControllerGrantedPermissions = {
  network: { enabled: boolean | null } | null;
  fileSystem: { read: string[]; write: string[] } | null;
};

export type ControllerInteractionResolution =
  | { decision: "allow_once"; grantedPermissions: ControllerGrantedPermissions | null }
  | { decision: "deny" }
  | { kind: "user_answer"; answers: ControllerQuestionAnswers };

type LifecycleReferenceCandidate = Readonly<{
  key: string;
  interactionId: string;
  kind: ControllerInteractionReference["kind"];
  status: ControllerInteractionReference["status"];
}>;

export class ControllerImagePreparationError extends Error {
  public constructor(public readonly retryable: boolean) {
    super("Controller image could not be prepared");
    this.name = "ControllerImagePreparationError";
  }
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}

function boundedDraftTail(text: string): string {
  return text.length <= MAX_CONTROLLER_PRIVATE_DRAFT_CHARS
    ? text
    : text.slice(text.length - MAX_CONTROLLER_PRIVATE_DRAFT_CHARS);
}

function providerFailure(row: ControllerEventRow, inputAccepted: boolean): ControllerProviderFailure {
  const data: Record<string, unknown> = isRecord(row.data) ? row.data as Record<string, unknown> : {};
  const errorInfo: Record<string, unknown> = isRecord(data.errorInfo)
    ? data.errorInfo as Record<string, unknown>
    : {};
  const raw = [data.code, data.message, data.detail, errorInfo.category, errorInfo.providerCode]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  const httpStatus = typeof errorInfo.httpStatusCode === "number" ? errorInfo.httpStatusCode : null;
  const willRetry = row.type === "provider/error" && data.willRetry === true;
  let code: ControllerProviderFailureCode;
  if (errorInfo.category === "unauthorized" || /oauth[^\n]{0,40}(?:expired|invalid)|token[^\n]{0,40}expired/u.test(raw)) {
    code = "oauth_expired";
  } else if (httpStatus === 400 || errorInfo.category === "bad-request" || /\bbad request\b|\bhard 400\b/u.test(raw)) {
    code = "provider_rejected";
  } else if (/initiali[sz](?:ation|e)[^\n]{0,60}timeout|startup[^\n]{0,40}timeout/u.test(raw)) {
    code = "startup_timeout";
  } else if (/json[- _]?rpc[^\n]{0,60}timeout|\brpc[^\n]{0,40}timeout|steer[^\n]{0,40}timeout/u.test(raw)) {
    code = "rpc_timeout";
  } else if (/host[^\n]{0,40}(?:daemon[^\n]{0,20})?disconnect|daemon[^\n]{0,40}unavailable/u.test(raw)) {
    code = "host_disconnected";
  } else if (/process[^\n]{0,60}(?:exit|code\s*(?:137|143))|sigkill|sigterm/u.test(raw)) {
    code = "process_exit";
  } else {
    code = "unknown";
  }
  const retryable = willRetry || code === "startup_timeout" || code === "process_exit" ||
    code === "host_disconnected" || code === "rpc_timeout" || code === "unknown";
  return { code, retryable, willRetry, inputAccepted };
}

function boundedStringList(rawList: unknown, field: string): string[] {
  if (!Array.isArray(rawList) || rawList.length > 64) {
    throw new TypeError(`${field} is invalid`);
  }
  const strings: string[] = [];
  for (const entry of rawList) {
    if (typeof entry !== "string" || entry.length > 4_000) throw new TypeError(`${field} is invalid`);
    strings.push(entry);
  }
  return strings;
}

function nullableGrantedPermissions(candidate: unknown): ControllerGrantedPermissions | null {
  if (candidate === null) return null;
  if (!isRecord(candidate)) throw new TypeError("grantedPermissions is invalid");
  const networkValue = candidate.network;
  const fileSystemValue = candidate.fileSystem;
  let network: ControllerGrantedPermissions["network"] = null;
  if (networkValue !== null) {
    if (!isRecord(networkValue)) throw new TypeError("grantedPermissions.network is invalid");
    const networkEnabled = networkValue.enabled;
    if (networkEnabled !== null && typeof networkEnabled !== "boolean") {
      throw new TypeError("grantedPermissions.network is invalid");
    }
    network = { enabled: networkEnabled };
  }
  let fileSystem: ControllerGrantedPermissions["fileSystem"] = null;
  if (fileSystemValue !== null) {
    if (!isRecord(fileSystemValue)) throw new TypeError("grantedPermissions.fileSystem is invalid");
    fileSystem = {
      read: boundedStringList(fileSystemValue.read, "grantedPermissions.fileSystem.read"),
      write: boundedStringList(fileSystemValue.write, "grantedPermissions.fileSystem.write"),
    };
  }
  return { network, fileSystem };
}

function parseUserAnswerResolution(rawAnswers: Record<string, unknown>): ControllerQuestionAnswers {
  if (Object.keys(rawAnswers).length > 64) throw new TypeError("controller interaction has too many answers");
  const answers: ControllerQuestionAnswers = {};
  for (const [questionId, rawAnswer] of Object.entries(rawAnswers)) {
    if (questionId.length === 0 || questionId.length > 256 ||
        ["__proto__", "constructor", "prototype"].includes(questionId) || !isRecord(rawAnswer)) {
      throw new TypeError("controller interaction answer is invalid");
    }
    const answer: ControllerQuestionAnswers[string] = {
      selected: boundedStringList(rawAnswer.selected, "controller interaction answer.selected"),
    };
    if (Object.hasOwn(rawAnswer, "freeText")) {
      if (typeof rawAnswer.freeText !== "string" || rawAnswer.freeText.length > 4_000) {
        throw new TypeError("controller interaction answer.freeText is invalid");
      }
      answer.freeText = rawAnswer.freeText;
    }
    answers[questionId] = answer;
  }
  return answers;
}

function lifecycleReferenceCandidate(row: ControllerEventRow): LifecycleReferenceCandidate | null {
  if (row.type !== "system/userQuestion/lifecycle" && row.type !== "system/permissionGrant/lifecycle") return null;
  const lifecyclePayload = row.data as { interactionId?: unknown; status?: unknown };
  if (typeof lifecyclePayload.interactionId !== "string" || lifecyclePayload.interactionId.length === 0 ||
      lifecyclePayload.interactionId.length > 256) return null;
  if (lifecyclePayload.status !== "pending" && lifecyclePayload.status !== "resolved" &&
      lifecyclePayload.status !== "interrupted") return null;
  const kind = row.type === "system/userQuestion/lifecycle" ? "user_question" : "approval";
  return {
    key: `${kind}:${lifecyclePayload.interactionId}`,
    interactionId: lifecyclePayload.interactionId,
    kind,
    status: lifecyclePayload.status,
  };
}

export function parseControllerInteractionResolution(
  candidate: Record<string, unknown>,
): ControllerInteractionResolution {
  if (candidate.decision === "deny") return { decision: "deny" };
  if (candidate.decision === "allow_once") {
    if (!Object.hasOwn(candidate, "grantedPermissions")) throw new TypeError("grantedPermissions is required");
    return { decision: "allow_once", grantedPermissions: nullableGrantedPermissions(candidate.grantedPermissions) };
  }
  if (candidate.kind !== "user_answer" || !isRecord(candidate.answers)) {
    throw new TypeError("controller interaction resolution is invalid");
  }
  return { kind: "user_answer", answers: parseUserAnswerResolution(candidate.answers) };
}

function controllerTitle(controllerKey: string): string {
  return `Telegram Codex controller ${controllerKey}`;
}

const CONTROLLER_SPAWN_TITLE_MARKER = " [pending-spawn:";
const CONTROLLER_SPAWN_TITLE_END = "]";
const CONTROLLER_TITLE_PART = /^[A-Za-z0-9_-]{1,128}$/;
const CONTROLLER_SCOPE_PART = /^[A-Za-z0-9_.:-]{1,256}$/;

export type ControllerSpawnTitleIdentity = Readonly<{
  controllerKey: string;
  pendingSpawnToken: string;
  projectId: string;
  hostId: string;
  providerId: string;
}>;

export function controllerSpawnTitle(
  controllerKey: string,
  pendingSpawnToken: string,
  projectId: string,
  hostId: string,
  providerId: string,
): string {
  return `${controllerTitle(controllerKey)}${CONTROLLER_SPAWN_TITLE_MARKER}${pendingSpawnToken};project:${projectId};host:${hostId};provider:${providerId}${CONTROLLER_SPAWN_TITLE_END}`;
}

export function parseControllerSpawnTitle(title: string | null): ControllerSpawnTitleIdentity | null {
  if (typeof title !== "string") return null;
  const match = /^Telegram Codex controller ([A-Za-z0-9_-]{1,128}) \[pending-spawn:([A-Za-z0-9_-]{1,128});project:([A-Za-z0-9_.:-]{1,256});host:([A-Za-z0-9_.:-]{1,256});provider:([A-Za-z0-9_.:-]{1,256})\]$/.exec(title);
  if (!match || !CONTROLLER_TITLE_PART.test(match[1]!) || !CONTROLLER_TITLE_PART.test(match[2]!) ||
      !CONTROLLER_SCOPE_PART.test(match[3]!) || !CONTROLLER_SCOPE_PART.test(match[4]!) ||
      !CONTROLLER_SCOPE_PART.test(match[5]!)) return null;
  return {
    controllerKey: match[1]!,
    pendingSpawnToken: match[2]!,
    projectId: match[3]!,
    hostId: match[4]!,
    providerId: match[5]!,
  };
}

export function isControllerThreadTitle(
  title: string | null,
  controllerKey: string,
  expected?: Readonly<Pick<ControllerSpawnTitleIdentity, "projectId" | "hostId" | "providerId">>,
): boolean {
  if (title === controllerTitle(controllerKey) || title === `Telegram Luna controller ${controllerKey}`) return true;
  const identity = parseControllerSpawnTitle(title);
  return identity?.controllerKey === controllerKey &&
    (expected === undefined || (
      identity.projectId === expected.projectId &&
      identity.hostId === expected.hostId &&
      identity.providerId === expected.providerId
    ));
}

export class BbControllerAdapter implements ControllerAdapterMethods {
  private pendingMutation: Promise<unknown> | null = null;

  public constructor(private readonly dependencies: {
    sdk: BbSdk;
    pluginId: string;
    executionProfile?: () => ControllerExecutionProfile;
    executionProfiles?: () => readonly ControllerExecutionProfile[];
    now?: () => number;
    reserveSpawn?: (input: {
      controllerKey: string;
      turnId: string;
      projectId: string;
      hostId: string;
      now: number;
    }) => boolean;
    downloadImage?: (
      fileId: string,
      maxBytes: number,
      signal: AbortSignal,
    ) => Promise<Uint8Array>;
  }) {}

  private profiles(): readonly ControllerExecutionProfile[] {
    const profiles = this.dependencies.executionProfiles?.() ??
      (this.dependencies.executionProfile ? [this.dependencies.executionProfile()] : []);
    if (profiles.length < 1 || profiles.length > 3) {
      throw new Error("Controller execution profiles must contain one to three entries");
    }
    return profiles;
  }

  private profileAt(index: number): ControllerExecutionProfile {
    if (!Number.isInteger(index) || index < 0) throw new TypeError("Controller execution profile index is invalid");
    const profile = this.profiles()[index];
    if (!profile) throw new Error("Controller execution profile is unavailable");
    return profile;
  }

  public configuredProfileCount(): number {
    return this.profiles().length;
  }

  public hasPendingMutation(): boolean {
    return this.pendingMutation !== null;
  }

  private providerRead<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return withAbortDeadline(signal, CONTROLLER_PROVIDER_RPC_TIMEOUT_MS, operation);
  }

  private providerMutation<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return withAbortDeadline(signal, CONTROLLER_PROVIDER_RPC_TIMEOUT_MS, (roundTripSignal) => {
      if (this.pendingMutation !== null) {
        throw new Error("A previous controller mutation is still awaiting its provider outcome");
      }
      // The current SDK mutation surface does not accept AbortSignal. Keep the
      // real promise tracked after our await deadline so no second abandoned
      // mutation can accumulate behind it.
      const pending = operation(roundTripSignal);
      this.pendingMutation = pending;
      const clear = (): void => {
        if (this.pendingMutation === pending) this.pendingMutation = null;
      };
      void pending.then(clear, clear);
      return pending;
    });
  }

  public async spawn(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    signal: AbortSignal,
  ): Promise<ControllerLocation> {
    let personal: { projectId: string; hostId: string };
    try {
      personal = await this.resolvePersonalProject(signal);
    } catch (error) {
      if (turn.image) throw new ControllerImagePreparationError(true);
      throw error;
    }
    const execution = this.profileAt(turn.modelFallbackIndex);
    if (controller.pendingSpawnToken === null) {
      throw new Error("Controller spawn token is missing");
    }
    const pendingSpawnToken = controller.pendingSpawnToken;
    const input = await this.promptInput(
      personal.projectId,
      turn.inputText,
      turn.image,
      signal,
    );
    const now = this.dependencies.now?.();
    if (!this.dependencies.reserveSpawn || now === undefined || !this.dependencies.reserveSpawn({
      controllerKey: controller.controllerKey,
      turnId: turn.id,
      projectId: personal.projectId,
      hostId: personal.hostId,
      now,
    })) {
      throw new Error("Controller spawn reservation is unavailable or stale");
    }
    const thread = await this.providerMutation(signal, async () => this.dependencies.sdk.threads.spawn({
      projectId: personal.projectId,
      title: controllerSpawnTitle(
        controller.controllerKey,
        pendingSpawnToken,
        personal.projectId,
        personal.hostId,
        controllerProviderFor(execution.model),
      ),
      visibility: "hidden",
      input,
      environment: {
        type: "host",
        hostId: personal.hostId,
        workspace: { type: "personal" },
      },
      ...controllerExecutionArguments(execution, { includeProvider: true }),
    }));
    return { threadId: thread.id, ...personal, spawnToken: pendingSpawnToken };
  }

  public async send(
    threadId: string,
    text: string,
    signal: AbortSignal,
    image: ControllerImage | null = null,
    modelFallbackIndex = 0,
  ): Promise<void> {
    const execution = this.profileAt(modelFallbackIndex);
    let personal: { projectId: string; hostId: string } | null = null;
    if (image) {
      try {
        personal = await this.resolvePersonalProject(signal);
      } catch {
        throw new ControllerImagePreparationError(true);
      }
    }
    const input = await this.promptInput(personal?.projectId ?? null, text, image, signal);
    await this.providerMutation(signal, async () => this.dependencies.sdk.threads.send({
      threadId,
      mode: "start",
      ...controllerExecutionArguments(execution, { includeProvider: false }),
      input,
    }));
  }

  // Images deliberately do not use this path: preparing one can outlive the
  // active turn and BB may then start a new, untracked turn. The service leaves
  // image turns queued for the ordinary idle-thread dispatch instead.
  public async steer(
    threadId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.providerMutation(signal, async () => this.dependencies.sdk.threads.send({
      threadId,
      mode: "steer-if-active",
      input: [{ type: "text", text, mentions: [] }],
    }));
  }

  public async answerQuestion(
    threadId: string,
    interactionId: string,
    answers: ControllerQuestionAnswers,
    signal: AbortSignal,
  ): Promise<void> {
    await this.resolveInteraction(threadId, interactionId, { kind: "user_answer", answers }, signal);
  }

  public async getInteraction(
    threadId: string,
    interactionId: string,
    signal: AbortSignal,
  ): Promise<ControllerInteractionSnapshot> {
    const interaction = await this.providerRead(signal, (roundTripSignal) =>
      this.dependencies.sdk.threads.interactions.get({ threadId, interactionId, signal: roundTripSignal }));
    return {
      id: interaction.id,
      threadId: interaction.threadId,
      status: interaction.status,
      payload: "payload" in interaction ? interaction.payload : null,
      resolution: "resolution" in interaction ? interaction.resolution : null,
    };
  }

  public async resolveInteraction(
    threadId: string,
    interactionId: string,
    resolution: ControllerInteractionResolution,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
    const validatedResolution = parseControllerInteractionResolution(resolution);
    await this.providerMutation(signal, async () => this.dependencies.sdk.threads.interactions.resolve({
      threadId,
      interactionId,
      resolution: validatedResolution,
    }));
  }

  public async status(threadId: string, signal: AbortSignal, modelFallbackIndex = 0): Promise<ControllerStatus> {
    const thread = await this.providerRead(signal, (roundTripSignal) =>
      this.dependencies.sdk.threads.get({ threadId, signal: roundTripSignal }));
    if (thread.deletedAt !== null || thread.archivedAt !== null) return "missing";
    // Switching the configured model can move the conversation to another
    // provider; the old thread cannot run the new model, so it is retired.
    if (thread.providerId !== controllerProviderFor(this.profileAt(modelFallbackIndex).model)) {
      return "incompatible";
    }
    return thread.status;
  }

  // The high-water sequence, so a new turn's baseline cannot land inside the
  // thread's history and replay older answers into the live reply.
  public async latestSeq(threadId: string, signal: AbortSignal): Promise<number> {
    const timeline = await this.providerRead(signal, (roundTripSignal) =>
      this.dependencies.sdk.threads.timeline({
        threadId,
        summaryOnly: "true",
        signal: roundTripSignal,
      }));
    return timeline.maxSeq;
  }

  public async events(
    threadId: string,
    afterSeq: number,
    signal: AbortSignal,
  ): Promise<ControllerEventObservation> {
    let latestSeq = afterSeq;
    let inputAccepted = false;
    let assistantOutputObserved = false;
    let toolActivityObserved = false;
    let completed = false;
    let failure: ControllerProviderFailure | null = null;
    let assistantDraft: ControllerAssistantDraft | null = null;
    const interactionReferences = new Map<string, { reference: ControllerInteractionReference; seq: number }>();
    let toolCalls = 0;
    let commandFailures = 0;
    let totalTokens = 0;
    let cursorBlocked = false;
    for (let page = 0; page < MAX_CONTROLLER_EVENT_PAGES; page += 1) {
      const rows = await this.providerRead(signal, (roundTripSignal) =>
        this.dependencies.sdk.threads.events.list({
          threadId,
          afterSeq: String(latestSeq),
          limit: String(CONTROLLER_EVENT_PAGE_LIMIT),
          signal: roundTripSignal,
        }));
      for (const row of rows) {
        const lifecycle = lifecycleReferenceCandidate(row);
        if (lifecycle && !interactionReferences.has(lifecycle.key) &&
            interactionReferences.size >= MAX_CONTROLLER_INTERACTION_REFERENCES) {
          cursorBlocked = true;
          break;
        }
        latestSeq = Math.max(latestSeq, row.seq);
        if (row.type === "turn/input/accepted") inputAccepted = true;
        if (row.type === "item/agentMessage/delta") {
          assistantOutputObserved = true;
          const data: Record<string, unknown> = isRecord(row.data) ? row.data as Record<string, unknown> : {};
          const delta = typeof data.delta === "string" ? data.delta : "";
          const itemId = typeof data.itemId === "string" && data.itemId.length <= 256 ? data.itemId : null;
          const currentDraft: ControllerAssistantDraft | null = assistantDraft;
          const prior: string = currentDraft?.itemId === itemId ? currentDraft.text : "";
          assistantDraft = { itemId, text: boundedDraftTail(prior + delta) };
        }
        if (row.type === "turn/completed") completed = true;
        if (row.type === "item/started" && TOOL_ITEM_TYPES.has(row.data.item.type)) {
          toolActivityObserved = true;
          toolCalls += 1;
        }
        if (row.type === "item/completed" && row.data.item.type === "commandExecution") {
          const exitCode = row.data.item.exitCode;
          if (typeof exitCode === "number" && exitCode !== 0) commandFailures += 1;
        }
        if (row.type === "thread/tokenUsage/updated") {
          const total = row.data.tokenUsage.total.totalTokens;
          if (Number.isFinite(total) && total > totalTokens) totalTokens = total;
        }
        if (row.type === "system/error" || row.type === "provider/error") {
          failure = providerFailure(row, inputAccepted);
        }
        if (lifecycle) {
          const previous = interactionReferences.get(lifecycle.key);
          if (previous && previous.seq > row.seq) continue;
          interactionReferences.set(lifecycle.key, {
            reference: {
              interactionId: lifecycle.interactionId,
              kind: lifecycle.kind,
              status: lifecycle.status,
            },
            seq: row.seq,
          });
        }
      }
      if (cursorBlocked) break;
      if (rows.length < CONTROLLER_EVENT_PAGE_LIMIT) break;
    }
    return {
      latestSeq,
      inputAccepted,
      assistantOutputObserved,
      toolActivityObserved,
      completed,
      failure: failure === null ? null : { ...failure, inputAccepted },
      assistantDraft,
      interactionReferences: [...interactionReferences.values()].map(({ reference }) => reference),
      toolCalls,
      commandFailures,
      totalTokens,
    };
  }

  public async findSpawnCandidate(
    controllerKey: string,
    pendingSpawnToken: string,
    signal: AbortSignal,
    modelFallbackIndex = 0,
  ): Promise<ControllerLocation | null> {
    const personal = await this.resolvePersonalProject(signal);
    const providerId = controllerProviderFor(this.profileAt(modelFallbackIndex).model);
    const candidates = new Map<string, ControllerSpawnTitleIdentity>();
    let offset = 0;
    for (let page = 0; page < MAX_CONTROLLER_THREAD_PAGES; page += 1) {
      const threads = await this.providerRead(signal, (roundTripSignal) =>
        this.dependencies.sdk.threads.list({
          projectId: personal.projectId,
          includeHidden: true,
          originPluginId: this.dependencies.pluginId,
          limit: CONTROLLER_THREAD_PAGE_LIMIT,
          offset,
          signal: roundTripSignal,
        }));
      if (threads.length > CONTROLLER_THREAD_PAGE_LIMIT) {
        throw new Error("Controller thread recovery returned an oversized page");
      }
      for (const thread of threads) {
        const identity = parseControllerSpawnTitle(thread.title);
        if (
          !identity || identity.controllerKey !== controllerKey ||
          identity.pendingSpawnToken !== pendingSpawnToken ||
          identity.projectId !== personal.projectId ||
          identity.hostId !== personal.hostId ||
          identity.providerId !== providerId ||
          thread.projectId !== personal.projectId ||
          thread.environmentHostId !== personal.hostId ||
          thread.providerId !== providerId ||
          thread.status === "error" || thread.status === "stopping" ||
          thread.visibility !== "hidden" ||
          thread.originPluginId !== this.dependencies.pluginId ||
          thread.archivedAt !== null ||
          thread.deletedAt !== null
        ) continue;
        candidates.set(thread.id, identity);
      }
      if (threads.length < CONTROLLER_THREAD_PAGE_LIMIT) break;
      offset += threads.length;
      if (page + 1 === MAX_CONTROLLER_THREAD_PAGES) {
        throw new Error("Controller thread recovery page cap exhausted");
      }
    }
    if (candidates.size > 1) throw new Error("Multiple ambiguous BB controller spawn candidates exist");
    const candidate = [...candidates.entries()][0];
    return candidate ? {
      threadId: candidate[0],
      ...personal,
      spawnToken: candidate[1].pendingSpawnToken,
    } : null;
  }

  private async promptInput(
    projectId: string | null,
    text: string,
    image: ControllerImage | null,
    signal: AbortSignal,
  ): Promise<ControllerPromptInput> {
    const input: ControllerPromptInput = [{ type: "text", text, mentions: [] }];
    if (!image) return input;
    if (!projectId || !this.dependencies.downloadImage) {
      throw new ControllerImagePreparationError(false);
    }
    let bytes: Uint8Array;
    try {
      bytes = await this.dependencies.downloadImage(
        image.fileId,
        MAX_CONTROLLER_IMAGE_BYTES,
        signal,
      );
    } catch (error) {
      if (error instanceof ControllerImagePreparationError) throw error;
      throw new ControllerImagePreparationError(true);
    }
    if (bytes.byteLength > MAX_CONTROLLER_IMAGE_BYTES) {
      throw new ControllerImagePreparationError(false);
    }
    try {
      const uploaded = await this.providerMutation(signal, async () =>
        this.dependencies.sdk.projects.attachments.upload({
          projectId,
          clientFile: bytes,
          filename: image.fileName,
          mimeType: image.mimeType,
        }));
      if (uploaded.type !== "localImage") throw new ControllerImagePreparationError(false);
      input.push({ type: "localImage", path: uploaded.path });
      return input;
    } catch (error) {
      if (error instanceof ControllerImagePreparationError) throw error;
      if (error instanceof OperationDeadlineError) throw error;
      throw new ControllerImagePreparationError(true);
    }
  }

  private async resolvePersonalProject(signal: AbortSignal): Promise<{ projectId: string; hostId: string }> {
    const projects = await this.providerRead(signal, (roundTripSignal) =>
      this.dependencies.sdk.projects.list({ includePersonal: true, signal: roundTripSignal }));
    const personal = projects.filter((project) => project.kind === "personal");
    if (personal.length !== 1) throw new Error("Exactly one BB personal project is required for the controller");
    const project = personal[0];
    if (!project) throw new Error("BB personal project is unavailable");
    if (project.sources.length === 0) {
      const hosts = await this.providerRead(signal, (roundTripSignal) =>
        this.dependencies.sdk.hosts.list({ signal: roundTripSignal }));
      const connected = hosts.filter((host) => host.status === "connected");
      if (connected.length !== 1) {
        throw new Error("BB personal project has no source and its connected host is ambiguous");
      }
      const host = connected[0];
      if (!host) throw new Error("BB personal project has no connected host");
      return { projectId: project.id, hostId: host.id };
    }
    const source = project.sources.find((candidate) => candidate.isDefault) ??
      (project.sources.length === 1 ? project.sources[0] : undefined);
    if (!source) throw new Error("BB personal project has no unambiguous source");
    if (source.hostId.trim().length === 0) throw new Error("BB personal project source has no host");
    return { projectId: project.id, hostId: source.hostId };
  }
}
