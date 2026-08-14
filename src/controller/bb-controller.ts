import type { BbPluginApi } from "@bb/plugin-sdk";
import {
  MAX_CONTROLLER_IMAGE_BYTES,
  controllerDownloadLimitBytes,
  isMotionMedia,
  normalizeControllerImage,
  type ControllerImage,
  type ControllerThreadRecord,
  type ControllerTurnRecord,
} from "./models";
import { motionContextPrefix, sampleMotionFrames, type FrameSampler } from "./frames";
import {
  controllerExecutionArguments,
  controllerProviderFor,
  type ControllerExecutionProfile,
} from "./execution-profile";
import { isSafeControllerInteractionId } from "./questions";

export type ControllerLocation = { threadId: string; projectId: string; hostId: string };
export type ControllerStatus =
  | "idle"
  | "active"
  | "starting"
  | "stopping"
  | "error"
  | "missing"
  /** The live thread runs a different provider than the configured model needs. */
  | "incompatible";
/**
 * All an event stream may say about an interaction. The inline payload is never
 * authority: the exact interaction is fetched before anything is persisted or
 * shown, so a replayed or forged event cannot invent a question.
 */
export type ControllerInteractionReference = Readonly<{
  interactionId: string;
  kind: "user_question" | "approval" | "unsupported";
  status: "pending" | "resolved" | "interrupted";
}>;

/**
 * How many distinct interactions one event window may report. The cap bounds
 * the work of a single pass; it never discards anything. A window that reaches
 * the cap stops before the event introducing the next interaction and reports a
 * cursor that stops there too, so the remainder is still unread work.
 */
export const MAX_CONTROLLER_INTERACTION_REFERENCES = 8;

export type ControllerEventObservation = {
  latestSeq: number;
  inputAccepted: boolean;
  /** True when the provider emitted a streamed assistant message in this window. */
  assistantOutputObserved: boolean;
  /** True when a tool-shaped item started in this window. */
  toolActivityObserved: boolean;
  completed: boolean;
  error: string | null;
  /** Bounded lifecycle references for anything the thread is blocked on. */
  interactions: readonly ControllerInteractionReference[];
  /** Tool-shaped item starts in this window; the caller accumulates them. */
  toolCalls: number;
  /** Non-zero command exits in this window; the caller accumulates them. */
  commandFailures: number;
  /** Highest cumulative uncached thread token total in this window, else 0. */
  totalTokens: number;
};

export type ControllerAdapter = {
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
  ): Promise<void>;
  /** Redirects a thread that is already working, rather than queueing behind it. */
  steer(
    threadId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<void>;
  /** Stops a live provider turn before its durable controller mapping retires. */
  stop?(threadId: string, signal: AbortSignal): Promise<void>;
  status(
    threadId: string,
    signal: AbortSignal,
    modelFallbackIndex?: number,
  ): Promise<ControllerStatus>;
  latestSeq(threadId: string, signal: AbortSignal): Promise<number>;
  events(threadId: string, afterSeq: number, signal: AbortSignal): Promise<ControllerEventObservation>;
  findSpawnCandidate(
    controllerKey: string,
    signal: AbortSignal,
    modelFallbackIndex?: number,
  ): Promise<ControllerLocation | null>;
  /** Whether another configured model exists for this durable attempt index. */
  hasExecutionProfile(modelFallbackIndex: number): boolean;
};

export const CONTROLLER_EVENT_PAGE_LIMIT = 100;
export const MAX_CONTROLLER_EVENT_PAGES = 50;

// Reasoning, plain messages, and plan updates are the model thinking out loud.
// Everything here reaches outside the model, which is what a budget should bound.
const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  "commandExecution",
  "toolCall",
  "webSearch",
  "webFetch",
  "imageView",
  "fileChange",
  "backgroundTask",
]);

type BbSdk = BbPluginApi["sdk"];
type ControllerPromptInput = Parameters<BbSdk["threads"]["send"]>[0]["input"];

/**
 * A lifecycle event the plugin cannot turn into a bounded reference. It is a
 * boundary failure rather than a parse detail: the thread is blocked on
 * something, and the plugin may not read past it without being able to say what.
 */
export class ControllerEventBoundaryError extends Error {
  public constructor() {
    super("Controller lifecycle event could not be projected into a bounded reference");
    this.name = "ControllerEventBoundaryError";
  }
}

export class ControllerImagePreparationError extends Error {
  public constructor(public readonly retryable: boolean) {
    super("Controller image could not be prepared");
    this.name = "ControllerImagePreparationError";
  }
}

/**
 * Reads a lifecycle row into the bounded reference the plugin may act on, or
 * null when it cannot. Null is never "ignore this row": a status the plugin
 * cannot settle (`resolving`) or an identity it cannot bound still names a live
 * block, so the caller fails the window rather than reading past it.
 */
function interactionReference(
  eventType: "system/userQuestion/lifecycle" | "system/permissionGrant/lifecycle",
  data: unknown,
): ControllerInteractionReference | null {
  if (typeof data !== "object" || data === null) return null;
  const candidate = data as { interactionId?: unknown; status?: unknown; subject?: unknown };
  if (!isSafeControllerInteractionId(candidate.interactionId)) return null;
  const status = candidate.status;
  if (status !== "pending" && status !== "resolved" && status !== "interrupted") return null;
  if (eventType === "system/userQuestion/lifecycle") {
    return { interactionId: candidate.interactionId, kind: "user_question", status };
  }
  const subject = candidate.subject;
  const subjectKind = typeof subject === "object" && subject !== null
    ? (subject as { kind?: unknown }).kind
    : null;
  return {
    interactionId: candidate.interactionId,
    kind: subjectKind === "permission_grant" ? "approval" : "unsupported",
    status,
  };
}

function controllerTitle(controllerKey: string): string {
  return `Telegram Codex controller ${controllerKey}`;
}

export function isControllerThreadTitle(title: string | null, controllerKey: string): boolean {
  return title === controllerTitle(controllerKey) ||
    title === `Telegram Luna controller ${controllerKey}`;
}

export class BbControllerAdapter implements ControllerAdapter {
  public constructor(private readonly dependencies: {
    sdk: BbSdk;
    pluginId: string;
    executionProfiles: () => readonly ControllerExecutionProfile[];
    downloadImage?: (
      fileId: string,
      maxBytes: number,
      signal: AbortSignal,
    ) => Promise<Uint8Array>;
    sampleMotionFrames?: FrameSampler;
  }) {}

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
    const execution = this.executionProfile(turn.modelFallbackIndex);
    // Standing instructions come from `bb.agents.configure` alone, so the first
    // message is exactly what the owner sent.
    const input = await this.promptInput(personal.projectId, turn.inputText, turn.image, signal);
    const thread = await this.dependencies.sdk.threads.spawn({
      projectId: personal.projectId,
      title: controllerTitle(controller.controllerKey),
      visibility: "hidden",
      input,
      environment: {
        type: "host",
        hostId: personal.hostId,
        workspace: { type: "personal" },
      },
      ...controllerExecutionArguments(execution, { includeProvider: true }),
    });
    return { threadId: thread.id, ...personal };
  }

  public async send(
    threadId: string,
    text: string,
    signal: AbortSignal,
    image: ControllerImage | null = null,
  ): Promise<void> {
    const execution = this.executionProfile(0);
    let personal: { projectId: string; hostId: string } | null = null;
    if (image) {
      try {
        personal = await this.resolvePersonalProject(signal);
      } catch {
        throw new ControllerImagePreparationError(true);
      }
    }
    const input = await this.promptInput(personal?.projectId ?? null, text, image, signal);
    await this.dependencies.sdk.threads.send({
      threadId,
      mode: "start",
      ...controllerExecutionArguments(execution, { includeProvider: false }),
      input,
    });
  }

  // Images deliberately do not use this path: preparing one can outlive the
  // active turn and BB may then start a new, untracked turn. The service leaves
  // image turns queued for the ordinary idle-thread dispatch instead.
  public async steer(
    threadId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.dependencies.sdk.threads.send({
      threadId,
      mode: "steer-if-active",
      input: [{ type: "text", text, mentions: [] }],
    });
  }

  public async stop(threadId: string, _signal: AbortSignal): Promise<void> {
    await this.dependencies.sdk.threads.stop({ threadId });
  }

  public async status(
    threadId: string,
    signal: AbortSignal,
    modelFallbackIndex = 0,
  ): Promise<ControllerStatus> {
    const thread = await this.dependencies.sdk.threads.get({ threadId, signal });
    if (thread.deletedAt !== null || thread.archivedAt !== null) return "missing";
    // Switching the configured model can move the conversation to another
    // provider; the old thread cannot run the new model, so it is retired.
    if (thread.providerId !== controllerProviderFor(this.executionProfile(modelFallbackIndex).model)) {
      return "incompatible";
    }
    return thread.status;
  }

  // The high-water sequence, so a new turn's baseline cannot land inside the
  // thread's history and replay older answers into the live reply.
  public async latestSeq(threadId: string, signal: AbortSignal): Promise<number> {
    const timeline = await this.dependencies.sdk.threads.timeline({
      threadId,
      summaryOnly: "true",
      signal,
    });
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
    let error: string | null = null;
    const interactions = new Map<string, ControllerInteractionReference>();
    let toolCalls = 0;
    let commandFailures = 0;
    let totalTokens = 0;
    let windowFull = false;
    for (let page = 0; page < MAX_CONTROLLER_EVENT_PAGES && !windowFull; page += 1) {
      const rows = await this.dependencies.sdk.threads.events.list({
        threadId,
        afterSeq: String(latestSeq),
        limit: String(CONTROLLER_EVENT_PAGE_LIMIT),
        signal,
      });
      for (const row of rows) {
        // Stopping *before* this event, cursor included, is what makes the cap
        // bounded rather than lossy: everything from here on stays unread until
        // a later pass, instead of being silently skipped over.
        if (this.introducesInteractionBeyondWindow(row, interactions)) {
          windowFull = true;
          break;
        }
        // Lifecycle rows are settled before the cursor moves past them. A row
        // whose identity or status cannot be projected still names a boundary
        // the thread is blocked on; consuming it would advance the cursor past
        // the owner's only view of that block and let the turn terminalize as
        // though nothing were waiting. The whole window fails instead, so the
        // row stays unread and the caller retries or retires loudly.
        if (row.type === "system/userQuestion/lifecycle" || row.type === "system/permissionGrant/lifecycle") {
          const reference = interactionReference(row.type, row.data);
          if (!reference) throw new ControllerEventBoundaryError();
          // The same interaction reports every step of its life on this stream,
          // so the last word about it wins: a later "resolved" retires it.
          interactions.delete(reference.interactionId);
          interactions.set(reference.interactionId, reference);
        }
        latestSeq = Math.max(latestSeq, row.seq);
        if (row.type === "turn/input/accepted") inputAccepted = true;
        if (row.type === "item/agentMessage/delta") assistantOutputObserved = true;
        if (row.type === "turn/completed") completed = true;
        if (row.type === "item/started" && TOOL_ITEM_TYPES.has(row.data.item.type)) {
          toolCalls += 1;
          toolActivityObserved = true;
        }
        if (row.type === "item/completed" && row.data.item.type === "commandExecution") {
          const exitCode = row.data.item.exitCode;
          if (typeof exitCode === "number" && exitCode !== 0) commandFailures += 1;
        }
        if (row.type === "thread/tokenUsage/updated") {
          const usage = row.data.tokenUsage.total;
          const total = usage.totalTokens;
          const cached = usage.cachedInputTokens;
          // A long-lived controller resends a large, mostly cached context on
          // every model step. Counting that cache hit as new work made three
          // ordinary tool calls look like a runaway turn. The uncached total
          // still bounds fresh input and every output token.
          const effective = Number.isFinite(cached)
            ? Math.max(0, total - Math.max(0, cached))
            : total;
          if (Number.isFinite(effective) && effective > totalTokens) totalTokens = effective;
        }
        if (row.type === "system/error" || row.type === "provider/error") {
          error = "Controller provider turn failed";
        }
      }
      if (rows.length < CONTROLLER_EVENT_PAGE_LIMIT) break;
    }
    return {
      latestSeq,
      inputAccepted,
      assistantOutputObserved,
      toolActivityObserved,
      completed,
      error,
      interactions: [...interactions.values()],
      toolCalls,
      commandFailures,
      totalTokens,
    };
  }

  /**
   * True when reading this event would push the window past its interaction
   * cap. Only a lifecycle event naming an interaction the window has not seen
   * yet can do that; a further report about one already in the window costs
   * nothing, and neither does any other kind of event.
   */
  private introducesInteractionBeyondWindow(
    row: { type: string; data: unknown },
    interactions: ReadonlyMap<string, ControllerInteractionReference>,
  ): boolean {
    if (interactions.size < MAX_CONTROLLER_INTERACTION_REFERENCES) return false;
    if (row.type !== "system/userQuestion/lifecycle" && row.type !== "system/permissionGrant/lifecycle") {
      return false;
    }
    const reference = interactionReference(row.type, row.data);
    return reference !== null && !interactions.has(reference.interactionId);
  }

  public async findSpawnCandidate(
    controllerKey: string,
    signal: AbortSignal,
    modelFallbackIndex = 0,
  ): Promise<ControllerLocation | null> {
    const personal = await this.resolvePersonalProject(signal);
    const execution = this.executionProfile(modelFallbackIndex);
    const threads = await this.dependencies.sdk.threads.list({
      projectId: personal.projectId,
      includeHidden: true,
      originPluginId: this.dependencies.pluginId,
      signal,
    });
    const candidates = threads.filter((thread) =>
      isControllerThreadTitle(thread.title, controllerKey) &&
      thread.projectId === personal.projectId &&
      thread.providerId === controllerProviderFor(execution.model) &&
      thread.status !== "error" && thread.status !== "stopping" &&
      thread.visibility === "hidden" &&
      thread.originPluginId === this.dependencies.pluginId &&
      thread.archivedAt === null &&
      thread.deletedAt === null
    );
    if (candidates.length > 1) throw new Error("Multiple ambiguous BB controller spawn candidates exist");
    const candidate = candidates[0];
    return candidate ? { threadId: candidate.id, ...personal } : null;
  }

  public hasExecutionProfile(modelFallbackIndex: number): boolean {
    return Number.isInteger(modelFallbackIndex) && modelFallbackIndex >= 0 &&
      this.dependencies.executionProfiles()[modelFallbackIndex] !== undefined;
  }

  private executionProfile(modelFallbackIndex: number): ControllerExecutionProfile {
    if (!Number.isInteger(modelFallbackIndex) || modelFallbackIndex < 0) {
      throw new TypeError("Controller model fallback index must be a non-negative integer");
    }
    const profile = this.dependencies.executionProfiles()[modelFallbackIndex];
    if (!profile) throw new Error(`Controller model fallback ${modelFallbackIndex} is not configured`);
    return profile;
  }

  private async promptInput(
    projectId: string | null,
    text: string,
    image: ControllerImage | null,
    signal: AbortSignal,
  ): Promise<ControllerPromptInput> {
    if (!image) return [{ type: "text", text, mentions: [] }];
    if (!projectId || !this.dependencies.downloadImage) {
      throw new ControllerImagePreparationError(false);
    }
    const media = normalizeControllerImage(image);
    const prepared = isMotionMedia(media)
      ? await this.motionFrames(media, signal)
      : {
        source: "original" as const,
        frames: [{
          fileName: media.fileName,
          mimeType: media.mimeType,
          bytes: await this.downloadMedia(media.fileId, MAX_CONTROLLER_IMAGE_BYTES, signal),
        }],
      };
    const preface = isMotionMedia(media)
      ? `${motionContextPrefix(media.kind, prepared.frames.length, prepared.source)}\n\n`
      : "";
    const frames = prepared.frames;
    const input: ControllerPromptInput = [{ type: "text", text: `${preface}${text}`, mentions: [] }];
    for (const frame of frames) {
      if (frame.bytes.byteLength > MAX_CONTROLLER_IMAGE_BYTES) {
        throw new ControllerImagePreparationError(false);
      }
      try {
        const uploaded = await this.dependencies.sdk.projects.attachments.upload({
          projectId,
          clientFile: frame.bytes,
          filename: frame.fileName,
          mimeType: frame.mimeType,
        });
        if (uploaded.type !== "localImage") throw new ControllerImagePreparationError(false);
        input.push({ type: "localImage", path: uploaded.path });
      } catch (error) {
        if (error instanceof ControllerImagePreparationError) throw error;
        throw new ControllerImagePreparationError(true);
      }
    }
    return input;
  }

  private async motionFrames(
    image: Required<ControllerImage>,
    signal: AbortSignal,
  ): Promise<{
    source: "sampled" | "preview" | "original";
    frames: Array<{ fileName: string; mimeType: string; bytes: Uint8Array }>;
  }> {
    const sampler = this.dependencies.sampleMotionFrames ?? sampleMotionFrames;
    const downloadLimit = controllerDownloadLimitBytes(image);
    let original: Uint8Array | null = null;
    if (image.sizeBytes === null || image.sizeBytes <= downloadLimit) {
      try {
        original = await this.downloadMedia(image.fileId, downloadLimit, signal);
        const frames = [...await sampler({ bytes: original, fileName: image.fileName, signal })];
        if (frames.length > 0) return { source: "sampled", frames };
      } catch (error) {
        if (error instanceof ControllerImagePreparationError && !error.retryable && !image.thumbnail && !original) {
          throw error;
        }
        if (!(error instanceof ControllerImagePreparationError) && !image.thumbnail && !original) {
          throw new ControllerImagePreparationError(true);
        }
      }
    }
    if (image.thumbnail) {
      const bytes = await this.downloadMedia(
        image.thumbnail.fileId,
        MAX_CONTROLLER_IMAGE_BYTES,
        signal,
      );
      return {
        source: "preview",
        frames: [{ fileName: image.thumbnail.fileName, mimeType: "image/jpeg", bytes }],
      };
    }
    // A GIF document is already a still the provider can see if sampling failed.
    if (original && image.mimeType.startsWith("image/")) {
      return {
        source: "original",
        frames: [{ fileName: image.fileName, mimeType: image.mimeType, bytes: original }],
      };
    }
    throw new ControllerImagePreparationError(false);
  }

  private async downloadMedia(fileId: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
    try {
      const bytes = await this.dependencies.downloadImage!(fileId, maxBytes, signal);
      if (bytes.byteLength > maxBytes) throw new ControllerImagePreparationError(false);
      return bytes;
    } catch (error) {
      if (error instanceof ControllerImagePreparationError) throw error;
      throw new ControllerImagePreparationError(true);
    }
  }

  private async resolvePersonalProject(signal: AbortSignal): Promise<{ projectId: string; hostId: string }> {
    const projects = await this.dependencies.sdk.projects.list({ includePersonal: true, signal });
    const personal = projects.filter((project) => project.kind === "personal");
    if (personal.length !== 1) throw new Error("Exactly one BB personal project is required for the controller");
    const project = personal[0];
    if (!project) throw new Error("BB personal project is unavailable");
    if (project.sources.length === 0) {
      const hosts = await this.dependencies.sdk.hosts.list({ signal });
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
