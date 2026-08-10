import type { BbPluginApi } from "@bb/plugin-sdk";
import type { ControllerThreadRecord, ControllerTurnRecord } from "./models";
import { buildInitialControllerPrompt } from "./instructions";
import {
  controllerExecutionArguments,
  controllerProviderFor,
  type ControllerExecutionProfile,
} from "./execution-profile";
import {
  parsePendingQuestion,
  type ControllerPendingQuestion,
  type ControllerQuestionAnswers,
} from "./questions";

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
export type ControllerEventObservation = {
  latestSeq: number;
  inputAccepted: boolean;
  assistantDelta: string;
  completed: boolean;
  error: string | null;
  /** Set while the thread is blocked on a question only the owner can answer. */
  pendingQuestion: ControllerPendingQuestion | null;
};

export type ControllerAdapter = {
  spawn(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    signal: AbortSignal,
  ): Promise<ControllerLocation>;
  send(threadId: string, text: string, signal: AbortSignal): Promise<void>;
  /** Redirects a thread that is already working, rather than queueing behind it. */
  steer(threadId: string, text: string, signal: AbortSignal): Promise<void>;
  answerQuestion(
    threadId: string,
    interactionId: string,
    answers: ControllerQuestionAnswers,
    signal: AbortSignal,
  ): Promise<void>;
  status(threadId: string, signal: AbortSignal): Promise<ControllerStatus>;
  output(threadId: string, signal: AbortSignal): Promise<string>;
  latestSeq(threadId: string, signal: AbortSignal): Promise<number>;
  events(threadId: string, afterSeq: number, signal: AbortSignal): Promise<ControllerEventObservation>;
  findSpawnCandidate(controllerKey: string, signal: AbortSignal): Promise<ControllerLocation | null>;
};

const EVENT_PAGE_LIMIT = 100;
const MAX_EVENT_PAGES = 50;

type BbSdk = BbPluginApi["sdk"];

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
  }) {}

  public async spawn(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    signal: AbortSignal,
  ): Promise<ControllerLocation> {
    const personal = await this.resolvePersonalProject(signal);
    const execution = this.dependencies.executionProfile();
    const thread = await this.dependencies.sdk.threads.spawn({
      projectId: personal.projectId,
      title: controllerTitle(controller.controllerKey),
      visibility: "hidden",
      input: [{ type: "text", text: buildInitialControllerPrompt(turn.inputText), mentions: [] }],
      environment: {
        type: "host",
        hostId: personal.hostId,
        workspace: { type: "personal" },
      },
      ...controllerExecutionArguments(execution, { includeProvider: true }),
    });
    return { threadId: thread.id, ...personal };
  }

  public async send(threadId: string, text: string, signal: AbortSignal): Promise<void> {
    const execution = this.dependencies.executionProfile();
    await this.dependencies.sdk.threads.send({
      threadId,
      mode: "start",
      ...controllerExecutionArguments(execution, { includeProvider: false }),
      input: [{ type: "text", text, mentions: [] }],
    });
  }

  // "auto" lets BB fold the message into the running turn instead of starting a
  // second one, so a correction the owner sends mid-answer still lands.
  public async steer(threadId: string, text: string, signal: AbortSignal): Promise<void> {
    await this.dependencies.sdk.threads.send({
      threadId,
      mode: "auto",
      input: [{ type: "text", text, mentions: [] }],
    });
  }

  public async answerQuestion(
    threadId: string,
    interactionId: string,
    answers: ControllerQuestionAnswers,
    signal: AbortSignal,
  ): Promise<void> {
    await this.dependencies.sdk.threads.interactions.resolve({
      threadId,
      interactionId,
      resolution: { kind: "user_answer", answers },
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

  public async output(threadId: string, signal: AbortSignal): Promise<string> {
    const result = await this.dependencies.sdk.threads.output({ threadId, signal });
    return result.output ?? "";
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
    let assistantDelta = "";
    let completed = false;
    let error: string | null = null;
    let pendingQuestion: ControllerPendingQuestion | null = null;
    for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
      const rows = await this.dependencies.sdk.threads.events.list({
        threadId,
        afterSeq: String(latestSeq),
        limit: String(EVENT_PAGE_LIMIT),
        signal,
      });
      for (const row of rows) {
        latestSeq = Math.max(latestSeq, row.seq);
        if (row.type === "turn/input/accepted") inputAccepted = true;
        if (row.type === "item/agentMessage/delta") assistantDelta += row.data.delta;
        if (row.type === "turn/completed") completed = true;
        if (row.type === "system/error" || row.type === "provider/error") {
          error = "Controller provider turn failed";
        }
        // The same interaction reports every step of its life on this stream, so
        // the last word about it wins: a later "resolved" retires the question.
        if (row.type === "system/userQuestion/lifecycle") {
          const data = row.data as { interactionId?: unknown; status?: unknown; payload?: unknown };
          pendingQuestion = data.status === "pending"
            ? parsePendingQuestion(data.interactionId, data.payload)
            : null;
        }
      }
      if (rows.length < EVENT_PAGE_LIMIT) break;
    }
    return { latestSeq, inputAccepted, assistantDelta, completed, error, pendingQuestion };
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
