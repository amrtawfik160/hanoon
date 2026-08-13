import type { BbPluginApi } from "@bb/plugin-sdk";
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

/** How many distinct interactions one event window may report. */
export const MAX_CONTROLLER_INTERACTION_REFERENCES = 8;

/**
 * Trims an oversized window to the references that matter most. Settlements
 * come first: dropping one leaves a durable row parked on an interaction BB has
 * already closed, and a parked row suppresses every other kind of progress.
 * Among the rest the newest win, because the block BB is actually waiting on is
 * the last thing the stream said.
 */
function boundedReferences(
  all: readonly ControllerInteractionReference[],
): readonly ControllerInteractionReference[] {
  if (all.length <= MAX_CONTROLLER_INTERACTION_REFERENCES) return all;
  const settled = all.filter((reference) => reference.status !== "pending")
    .slice(-MAX_CONTROLLER_INTERACTION_REFERENCES);
  const pendingBudget = MAX_CONTROLLER_INTERACTION_REFERENCES - settled.length;
  const pending = pendingBudget === 0
    ? []
    : all.filter((reference) => reference.status === "pending").slice(-pendingBudget);
  const kept = new Set([...settled, ...pending]);
  return all.filter((reference) => kept.has(reference));
}

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
  /** Highest cumulative thread token total in this window, else 0. */
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
  status(threadId: string, signal: AbortSignal): Promise<ControllerStatus>;
  latestSeq(threadId: string, signal: AbortSignal): Promise<number>;
  events(threadId: string, afterSeq: number, signal: AbortSignal): Promise<ControllerEventObservation>;
  findSpawnCandidate(controllerKey: string, signal: AbortSignal): Promise<ControllerLocation | null>;
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

export class ControllerImagePreparationError extends Error {
  public constructor(public readonly retryable: boolean) {
    super("Controller image could not be prepared");
    this.name = "ControllerImagePreparationError";
  }
}

/**
 * Reads a lifecycle row into the bounded reference the plugin may act on. A
 * status the plugin cannot settle (`resolving`) is deliberately not a reference:
 * the durable row stays exactly as it is until BB reaches a final state.
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
    executionProfile: () => ControllerExecutionProfile;
    downloadImage?: (
      fileId: string,
      maxBytes: number,
      signal: AbortSignal,
    ) => Promise<Uint8Array>;
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
    const execution = this.dependencies.executionProfile();
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
    const execution = this.dependencies.executionProfile();
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

  public async status(threadId: string, signal: AbortSignal): Promise<ControllerStatus> {
    const thread = await this.dependencies.sdk.threads.get({ threadId, signal });
    if (thread.deletedAt !== null || thread.archivedAt !== null) return "missing";
    // Switching the configured model can move the conversation to another
    // provider; the old thread cannot run the new model, so it is retired.
    if (thread.providerId !== controllerProviderFor(this.dependencies.executionProfile().model)) {
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
    for (let page = 0; page < MAX_CONTROLLER_EVENT_PAGES; page += 1) {
      const rows = await this.dependencies.sdk.threads.events.list({
        threadId,
        afterSeq: String(latestSeq),
        limit: String(CONTROLLER_EVENT_PAGE_LIMIT),
        signal,
      });
      for (const row of rows) {
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
          const total = row.data.tokenUsage.total.totalTokens;
          if (Number.isFinite(total) && total > totalTokens) totalTokens = total;
        }
        if (row.type === "system/error" || row.type === "provider/error") {
          error = "Controller provider turn failed";
        }
        // The same interaction reports every step of its life on this stream,
        // so the last word about it wins: a later "resolved" retires it.
        if (row.type === "system/userQuestion/lifecycle" || row.type === "system/permissionGrant/lifecycle") {
          const reference = interactionReference(row.type, row.data);
          if (reference) {
            interactions.delete(reference.interactionId);
            interactions.set(reference.interactionId, reference);
          }
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
      interactions: boundedReferences([...interactions.values()]),
      toolCalls,
      commandFailures,
      totalTokens,
    };
  }

  public async findSpawnCandidate(controllerKey: string, signal: AbortSignal): Promise<ControllerLocation | null> {
    const personal = await this.resolvePersonalProject(signal);
    const threads = await this.dependencies.sdk.threads.list({
      projectId: personal.projectId,
      includeHidden: true,
      originPluginId: this.dependencies.pluginId,
      signal,
    });
    const candidates = threads.filter((thread) =>
      isControllerThreadTitle(thread.title, controllerKey) &&
      thread.projectId === personal.projectId &&
      thread.providerId === controllerProviderFor(this.dependencies.executionProfile().model) &&
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
      const uploaded = await this.dependencies.sdk.projects.attachments.upload({
        projectId,
        clientFile: bytes,
        filename: image.fileName,
        mimeType: image.mimeType,
      });
      if (uploaded.type !== "localImage") throw new ControllerImagePreparationError(false);
      input.push({ type: "localImage", path: uploaded.path });
      return input;
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
