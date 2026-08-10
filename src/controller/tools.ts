import type { BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import type { Job } from "../domain/models";
import type { TelegramAgentStore } from "../storage/store";
import { CONTROLLER_INSTRUCTIONS } from "./instructions";
import type { ThreadOperationService } from "./operations";
import { listVisibleThreads, visibleThreadStatus } from "./thread-observer";

export const CONTROLLER_TOOL_NAMES = [
  "telegram_agent_list_projects",
  "telegram_agent_start_job",
  "telegram_agent_job_status",
  "telegram_agent_retry_job",
  "telegram_agent_cancel_job",
  "telegram_agent_list_threads",
  "telegram_agent_thread_status",
  "telegram_agent_request_thread_operation",
] as const;

type ToolDependencies = {
  store: TelegramAgentStore;
  sdk: BbPluginApi["sdk"];
  threadOperations: Pick<ThreadOperationService, "request">;
  notify(): void;
  now(): number;
};

function authorizedController(
  store: TelegramAgentStore,
  context: { threadId: string; projectId: string },
) {
  const controller = store.getControllerByThreadId(context.threadId);
  if (!controller || controller.projectId !== context.projectId || controller.state !== "active") {
    throw new Error("This tool call is not authorized for the durable Telegram controller");
  }
  return controller;
}

function jobProjection(job: Job | null) {
  if (!job) return { job: null };
  return {
    job: {
      id: job.id,
      state: job.state,
      projectId: job.projectId,
      implementationThreadId: job.implementationThreadId,
      reviewThreadId: job.reviewThreadId,
      documentationThreadId: job.documentationThreadId,
      prNumber: job.prNumber,
      prUrl: job.prUrl,
      prHead: job.prHeadSha?.slice(0, 12) ?? null,
      mergeCommit: job.mergeCommitSha?.slice(0, 12) ?? null,
      mergedAt: job.mergedAt,
      deployment: job.deploymentSummary,
      canary: job.canarySummary,
      reviewCycle: job.reviewCycle,
      cancelRequested: job.cancelRequestedAt !== null,
      blocker: job.blockedReason,
      error: job.lastError,
      updatedAt: job.updatedAt,
    },
  };
}

function json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized.length > 8_000) throw new Error("Telegram Agent tool result exceeded its safe bound");
  return serialized;
}

export function registerControllerTools(bb: BbPluginApi, dependencies: ToolDependencies): void {
  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[0],
    description: "List the software projects enabled for guarded Telegram Agent jobs.",
    parameters: z.object({}).strict(),
    execute: (_params, context) => {
      authorizedController(dependencies.store, context);
      return json({
        projects: dependencies.store.listEnabledProjectPolicies().map(({ policy }) => ({
          id: policy.projectId,
          alias: policy.alias,
          baseBranch: policy.baseBranch,
          implementationModel: policy.implementation.model ?? null,
          reviewModel: policy.review.model ?? null,
          productionConfigured: policy.production !== undefined,
        })),
      });
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[1],
    description: "Create one guarded implementation job for an enabled project. This commits durable intent only.",
    parameters: z.object({
      projectId: z.string().min(1).max(256),
      task: z.string().trim().min(1).max(4_000),
    }).strict(),
    execute: (params, context) => {
      authorizedController(dependencies.store, context);
      const job = dependencies.store.createConfirmedControllerJob({
        controllerThreadId: context.threadId,
        projectId: params.projectId,
        task: params.task,
        now: dependencies.now(),
      });
      dependencies.notify();
      return json(jobProjection(job));
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[2],
    description: "Read a bounded durable status projection for the active, recent, or requested Telegram Agent job.",
    parameters: z.object({ jobId: z.string().min(1).max(256).optional() }).strict(),
    execute: (params, context) => {
      authorizedController(dependencies.store, context);
      const job = params.jobId
        ? dependencies.store.getJob(params.jobId)
        : dependencies.store.getActiveJob() ?? dependencies.store.listJobs(1)[0] ?? null;
      return json(jobProjection(job));
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[3],
    description: "Retry a recoverable failed Telegram Agent job through its durable state machine.",
    parameters: z.object({ jobId: z.string().min(1).max(256) }).strict(),
    execute: (params, context) => {
      authorizedController(dependencies.store, context);
      const job = dependencies.store.getJob(params.jobId);
      if (!job || job.state !== "failed") throw new Error("The requested job is not retryable");
      const updated = dependencies.store.applyJobEvent(job.id, job.version, { type: "RETRY" }, dependencies.now());
      dependencies.notify();
      return json(jobProjection(updated));
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[4],
    description: "Request cancellation of a nonterminal Telegram Agent job. Completion remains executor-fenced.",
    parameters: z.object({ jobId: z.string().min(1).max(256) }).strict(),
    execute: (params, context) => {
      authorizedController(dependencies.store, context);
      const job = dependencies.store.getJob(params.jobId);
      if (!job || ["merged", "cancelled", "blocked", "complete", "production_failed"].includes(job.state)) {
        throw new Error("The requested job cannot be cancelled");
      }
      const updated = dependencies.store.applyJobEvent(job.id, job.version, {
        type: "CANCEL_REQUESTED",
        activeWorker: dependencies.store.getWorkerLiveness(job.id),
      }, dependencies.now());
      dependencies.notify();
      return json(jobProjection(updated));
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[5],
    description: "List current visible BB threads with project, runtime, environment, branch, elapsed time, and last activity. Completion ETA is reported as unavailable rather than guessed.",
    experimental_statusLabels: { pending: "Checking BB threads", completed: "Checked BB threads" },
    parameters: z.object({
      projectId: z.string().min(1).max(256).optional(),
      status: z.enum(["active", "idle", "error", "all"]).default("active"),
      limit: z.number().int().min(1).max(10).default(10),
    }).strict(),
    execute: async (params, context) => {
      authorizedController(dependencies.store, context);
      return json(await listVisibleThreads({
        sdk: dependencies.sdk,
        now: dependencies.now(),
        projectId: params.projectId,
        status: params.status,
        limit: params.limit,
        signal: context.signal,
      }));
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[6],
    description: "Read the current status and truthful progress signals for one visible BB thread. BB does not provide a reliable completion ETA.",
    experimental_statusLabels: { pending: "Checking thread", completed: "Checked thread" },
    parameters: z.object({ threadId: z.string().min(1).max(256) }).strict(),
    execute: async (params, context) => {
      authorizedController(dependencies.store, context);
      return json(await visibleThreadStatus({
        sdk: dependencies.sdk,
        now: dependencies.now(),
        threadId: params.threadId,
        signal: context.signal,
      }));
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[7],
    description: "Request a steer, stop, or eligible provider retry for one visible BB thread. No action runs until the paired owner accepts an expiring one-use Telegram confirmation.",
    experimental_statusLabels: { pending: "Preparing confirmation", completed: "Confirmation sent" },
    parameters: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("steer_thread"),
        threadId: z.string().min(1).max(256),
        text: z.string().trim().min(1).max(4_000),
      }).strict(),
      z.object({
        kind: z.enum(["stop_thread", "retry_thread"]),
        threadId: z.string().min(1).max(256),
      }).strict(),
    ]),
    execute: async (params, context) => {
      authorizedController(dependencies.store, context);
      return json(await dependencies.threadOperations.request({ ...params, signal: context.signal }));
    },
  });

  bb.agents.configure((context) => {
    const controller = dependencies.store.getControllerByThreadId(context.thread.id);
    const candidate = controller !== null &&
      controller.projectId === context.project.id &&
      controller.hostId === context.host.id &&
      context.origin.kind === null &&
      context.origin.pluginId === bb.pluginId &&
      context.provider.id === "codex" &&
      context.project.kind === "personal" &&
      context.environment.workspaceProvisionType === "personal" &&
      context.thread.title === `Telegram Luna controller ${controller.controllerKey}`;
    return candidate
      ? { tools: [...CONTROLLER_TOOL_NAMES], skills: [], instructions: CONTROLLER_INSTRUCTIONS }
      : { tools: [], skills: [] };
  });
}
