import type { BbPluginApi } from "@bb/plugin-sdk";
import type { ControllerThreadRecord, ControllerTurnRecord } from "./models";
import { buildInitialControllerPrompt } from "./instructions";

export const CONTROLLER_PROVIDER = "codex";
export const CONTROLLER_MODEL = "gpt-5.6-luna";
export const CONTROLLER_REASONING = "max";
export const CONTROLLER_PERMISSION = "auto";

export type ControllerLocation = { threadId: string; projectId: string; hostId: string };
export type ControllerStatus = "idle" | "active" | "starting" | "stopping" | "error" | "missing";

export type ControllerAdapter = {
  spawn(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    signal: AbortSignal,
  ): Promise<ControllerLocation>;
  send(threadId: string, text: string, signal: AbortSignal): Promise<void>;
  status(threadId: string, signal: AbortSignal): Promise<ControllerStatus>;
  output(threadId: string, signal: AbortSignal): Promise<string>;
  findSpawnCandidate(controllerKey: string, signal: AbortSignal): Promise<ControllerLocation | null>;
};

type BbSdk = BbPluginApi["sdk"];

function controllerTitle(controllerKey: string): string {
  return `Telegram Luna controller ${controllerKey}`;
}

export class BbControllerAdapter implements ControllerAdapter {
  public constructor(private readonly dependencies: { sdk: BbSdk; pluginId: string }) {}

  public async spawn(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    signal: AbortSignal,
  ): Promise<ControllerLocation> {
    const personal = await this.resolvePersonalProject(signal);
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
      providerId: CONTROLLER_PROVIDER,
      model: CONTROLLER_MODEL,
      reasoningLevel: CONTROLLER_REASONING,
      permissionMode: CONTROLLER_PERMISSION,
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        reasoningLevel: "explicit",
        permissionMode: "explicit",
      },
    });
    return { threadId: thread.id, ...personal };
  }

  public async send(threadId: string, text: string, signal: AbortSignal): Promise<void> {
    await this.dependencies.sdk.threads.send({
      threadId,
      mode: "start",
      input: [{ type: "text", text, mentions: [] }],
    });
  }

  public async status(threadId: string, signal: AbortSignal): Promise<ControllerStatus> {
    const thread = await this.dependencies.sdk.threads.get({ threadId, signal });
    if (thread.deletedAt !== null || thread.archivedAt !== null) return "missing";
    return thread.status;
  }

  public async output(threadId: string, signal: AbortSignal): Promise<string> {
    const result = await this.dependencies.sdk.threads.output({ threadId, signal });
    return result.output ?? "";
  }

  public async findSpawnCandidate(controllerKey: string, signal: AbortSignal): Promise<ControllerLocation | null> {
    const personal = await this.resolvePersonalProject(signal);
    const threads = await this.dependencies.sdk.threads.list({
      projectId: personal.projectId,
      includeHidden: true,
      originPluginId: this.dependencies.pluginId,
      signal,
    });
    const title = controllerTitle(controllerKey);
    const candidates = threads.filter((thread) =>
      thread.title === title &&
      thread.projectId === personal.projectId &&
      thread.providerId === CONTROLLER_PROVIDER &&
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
