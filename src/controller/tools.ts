import type { BbPluginApi } from "@bb/plugin-sdk";
import { createHash } from "node:crypto";
import { z } from "zod";
import { redactError } from "../errors";
import type { Job } from "../domain/models";
import {
  OWNER_MEMORY_SCOPE,
  type MemoryRecord,
  type MonitorRecord,
  type TelegramAgentStore,
  type JobControlKind,
} from "../storage/store";
import { nextCronOccurrence } from "../services/monitor-service";
import { CONTROLLER_PROVIDERS } from "./execution-profile";
import { isControllerThreadTitle } from "./bb-controller";
import { CONTROLLER_INSTRUCTIONS } from "./instructions";
import type { ThreadOperationService } from "./operations";
import {
  createProjectThread,
  listVisibleThreads,
  readThreadActivity,
  sendToVisibleThread,
  visibleThreadStatus,
} from "./thread-observer";

export const CONTROLLER_TOOL_NAMES = [
  "telegram_agent_list_projects",
  "telegram_agent_start_job",
  "telegram_agent_job_status",
  "telegram_agent_retry_job",
  "telegram_agent_cancel_job",
  "telegram_agent_list_threads",
  "telegram_agent_thread_status",
  "telegram_agent_read_thread",
  "telegram_agent_create_thread",
  "telegram_agent_send_to_thread",
  "telegram_agent_request_thread_operation",
  "telegram_agent_remember",
  "telegram_agent_recall",
  "telegram_agent_forget",
  "telegram_agent_watch",
  "telegram_agent_list_watches",
  "telegram_agent_cancel_watch",
  "telegram_agent_health",
] as const;

type ToolDependencies = {
  store: TelegramAgentStore;
  sdk: BbPluginApi["sdk"];
  threadOperations: Pick<ThreadOperationService, "request">;
  health(now: number): unknown;
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

function canonicalArguments(params: unknown): string {
  return createHash("sha256").update(stableJson(params), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Runs a mutating tool at most once per turn for identical arguments. A
 * replacement controller re-asked to do the same thing replays the recorded
 * result, and a call interrupted mid-flight is reported as uncertain so the
 * agent checks the world instead of acting twice.
 */
async function once(
  dependencies: ToolDependencies,
  call: { controllerKey: string; toolName: string; params: unknown },
  run: () => Promise<string> | string,
): Promise<string> {
  const { controllerKey, toolName, params } = call;
  const turnId = dependencies.store.getPendingControllerTurn(controllerKey)?.id;
  if (!turnId) return await run();
  const key = { turnId, toolName, argsSha256: canonicalArguments(params) };
  const claim = dependencies.store.claimToolReceipt({ ...key, controllerKey, now: dependencies.now() });
  if (claim.outcome === "completed") return claim.result;
  if (claim.outcome === "interrupted") {
    return json({
      outcome: "uncertain",
      detail: "An identical call was already started and never reported its result. Check the current state before doing this again.",
    });
  }
  try {
    const result = await run();
    dependencies.store.completeToolReceipt({ ...key, result, now: dependencies.now() });
    return result;
  } catch (error) {
    dependencies.store.failToolReceipt({
      ...key,
      error: redactError(error).slice(0, 500),
      now: dependencies.now(),
    });
    throw error;
  }
}

function jobProjection(job: Job) {
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

type JobResolution =
  | { outcome: "job"; job: Job }
  | { outcome: "none" }
  | { outcome: "choose_job"; candidates: ReturnType<typeof candidateProjection>[] };

function candidateProjection(job: Job) {
  return { id: job.id, projectId: job.projectId, state: job.state };
}

function resolveJob(
  store: TelegramAgentStore,
  kind: JobControlKind,
  jobId: string | undefined,
): JobResolution {
  if (jobId !== undefined) {
    const job = store.getJob(jobId);
    return job ? { outcome: "job", job } : { outcome: "none" };
  }
  const candidates = store.listControlJobs(kind, 8);
  if (candidates.length === 0) return { outcome: "none" };
  if (candidates.length === 1) return { outcome: "job", job: candidates[0] };
  return { outcome: "choose_job", candidates: candidates.map(candidateProjection) };
}

function resolutionProjection(resolution: Exclude<JobResolution, { outcome: "job" }>) {
  return resolution.outcome === "none"
    ? { outcome: "none", candidates: [] }
    : resolution;
}

function monitorProjection(monitor: MonitorRecord) {
  return {
    id: monitor.id,
    kind: monitor.kind,
    threadId: monitor.threadId,
    cron: monitor.cron,
    instruction: monitor.instruction,
    state: monitor.state,
    nextDueAt: monitor.dueAt,
    fireCount: monitor.fireCount,
  };
}

function memoryProjection(memory: MemoryRecord) {
  return {
    id: memory.id,
    kind: memory.kind,
    subject: memory.subject,
    body: memory.body,
    scope: memory.scope,
    source: memory.source,
    savedAt: memory.createdAt,
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
      const controller = authorizedController(dependencies.store, context);
      return once(dependencies, { controllerKey: controller.controllerKey, toolName: CONTROLLER_TOOL_NAMES[1], params }, () => {
        const job = dependencies.store.createConfirmedControllerJob({
          controllerThreadId: context.threadId,
          projectId: params.projectId,
          task: params.task,
          now: dependencies.now(),
        });
        dependencies.notify();
        return json(jobProjection(job));
      });
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[2],
    description: "Read one exact durable job status, or return bounded job choices when no id uniquely resolves.",
    parameters: z.object({ jobId: z.string().min(1).max(256).optional() }).strict(),
    execute: (params, context) => {
      authorizedController(dependencies.store, context);
      const resolution = resolveJob(dependencies.store, "status", params.jobId);
      return json(resolution.outcome === "job"
        ? jobProjection(resolution.job)
        : resolutionProjection(resolution));
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[3],
    description: "Retry a recoverable failed Telegram Agent job through its durable state machine.",
    parameters: z.object({ jobId: z.string().min(1).max(256).optional() }).strict(),
    execute: (params, context) => {
      const controller = authorizedController(dependencies.store, context);
      return once(dependencies, { controllerKey: controller.controllerKey, toolName: CONTROLLER_TOOL_NAMES[3], params }, () => {
        const resolution = resolveJob(dependencies.store, "retry", params.jobId);
        if (resolution.outcome !== "job") return json(resolutionProjection(resolution));
        const job = resolution.job;
        if (job.state !== "failed" || job.cancelRequestedAt !== null) {
          throw new Error("The requested job is not retryable");
        }
        const updated = dependencies.store.applyJobEvent(job.id, job.version, { type: "RETRY" }, dependencies.now());
        dependencies.notify();
        return json(jobProjection(updated));
      });
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[4],
    description: "Request cancellation of a nonterminal Telegram Agent job. Completion remains executor-fenced.",
    parameters: z.object({ jobId: z.string().min(1).max(256).optional() }).strict(),
    execute: (params, context) => {
      const controller = authorizedController(dependencies.store, context);
      return once(dependencies, { controllerKey: controller.controllerKey, toolName: CONTROLLER_TOOL_NAMES[4], params }, () => {
        const resolution = resolveJob(dependencies.store, "cancel", params.jobId);
        if (resolution.outcome !== "job") return json(resolutionProjection(resolution));
        const job = resolution.job;
        if (["merged", "cancelled", "blocked", "complete", "production_failed"].includes(job.state)) {
          throw new Error("The requested job cannot be cancelled");
        }
        if (job.cancelRequestedAt !== null) return json(jobProjection(job));
        const updated = dependencies.store.applyJobEvent(job.id, job.version, {
          type: "CANCEL_REQUESTED",
          activeWorker: dependencies.store.getWorkerLiveness(job.id),
        }, dependencies.now());
        dependencies.notify();
        return json(jobProjection(updated));
      });
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
    description: "Read what one visible BB thread is doing right now: its current step, goal, todo list, running commands, and latest message. Use this before judging whether a thread is stuck or slow.",
    experimental_statusLabels: { pending: "Reading thread", completed: "Read thread" },
    parameters: z.object({ threadId: z.string().min(1).max(256) }).strict(),
    execute: async (params, context) => {
      authorizedController(dependencies.store, context);
      return json(await readThreadActivity({
        sdk: dependencies.sdk,
        now: dependencies.now(),
        threadId: params.threadId,
        signal: context.signal,
      }));
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[8],
    description: "Start a new BB thread in one of the owner's projects to do exploratory or read-only work. Guarded code changes that must be reviewed and merged still belong to telegram_agent_start_job.",
    experimental_statusLabels: { pending: "Starting thread", completed: "Started thread" },
    parameters: z.object({
      projectId: z.string().min(1).max(256),
      title: z.string().trim().min(1).max(120),
      prompt: z.string().trim().min(1).max(4_000),
    }).strict(),
    execute: async (params, context) => {
      const controller = authorizedController(dependencies.store, context);
      return once(dependencies, { controllerKey: controller.controllerKey, toolName: CONTROLLER_TOOL_NAMES[8], params }, async () => json(await createProjectThread({
        sdk: dependencies.sdk,
        projectId: params.projectId,
        title: params.title,
        prompt: params.prompt,
        signal: context.signal,
      })));
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[9],
    description: "Send a message to one visible BB thread and let it continue working. Use this to answer a thread's question, add context, or redirect it.",
    experimental_statusLabels: { pending: "Messaging thread", completed: "Messaged thread" },
    parameters: z.object({
      threadId: z.string().min(1).max(256),
      text: z.string().trim().min(1).max(4_000),
    }).strict(),
    execute: async (params, context) => {
      const controller = authorizedController(dependencies.store, context);
      return once(dependencies, { controllerKey: controller.controllerKey, toolName: CONTROLLER_TOOL_NAMES[9], params }, async () => json(await sendToVisibleThread({
        sdk: dependencies.sdk,
        threadId: params.threadId,
        text: params.text,
        signal: context.signal,
      })));
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[10],
    description: "Request a stop or eligible provider retry for one visible BB thread. No action runs until the paired owner accepts an expiring one-use Telegram confirmation.",
    experimental_statusLabels: { pending: "Preparing confirmation", completed: "Confirmation sent" },
    parameters: z.object({
      kind: z.enum(["stop_thread", "retry_thread"]),
      threadId: z.string().min(1).max(256),
    }).strict(),
    execute: async (params, context) => {
      const controller = authorizedController(dependencies.store, context);
      return once(dependencies, { controllerKey: controller.controllerKey, toolName: CONTROLLER_TOOL_NAMES[10], params }, async () =>
        json(await dependencies.threadOperations.request({ ...params, signal: context.signal })));
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[11],
    description: "Remember something durable about the owner: a standing preference, a decision they made, or a correction of yours. It survives restarts and is recalled automatically in later conversations. Do not store passing chatter or anything you can look up.",
    experimental_statusLabels: { pending: "Remembering", completed: "Remembered" },
    parameters: z.object({
      subject: z.string().trim().min(1).max(120),
      body: z.string().trim().min(1).max(1_000),
      kind: z.enum(["preference", "fact", "decision", "correction"]).default("fact"),
      projectId: z.string().min(1).max(256).optional(),
      importance: z.number().min(0).max(1).optional(),
    }).strict(),
    execute: (params, context) => {
      const controller = authorizedController(dependencies.store, context);
      return once(dependencies, { controllerKey: controller.controllerKey, toolName: CONTROLLER_TOOL_NAMES[11], params }, () => {
      const memory = dependencies.store.rememberMemory({
        scope: params.projectId ?? OWNER_MEMORY_SCOPE,
        kind: params.kind,
        subject: params.subject,
        body: params.body,
        importance: params.importance,
        source: "agent",
        now: dependencies.now(),
      });
      return json({ remembered: { id: memory.id, subject: memory.subject, scope: memory.scope } });
      });
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[12],
    description: "Search everything you remember about the owner. Relevant memories are already injected each turn; use this only to dig for something older or more specific.",
    experimental_statusLabels: { pending: "Recalling", completed: "Recalled" },
    parameters: z.object({
      query: z.string().trim().min(1).max(500),
      projectId: z.string().min(1).max(256).optional(),
      limit: z.number().int().min(1).max(20).default(8),
    }).strict(),
    execute: (params, context) => {
      authorizedController(dependencies.store, context);
      return json({
        memories: dependencies.store.recallMemories({
          scope: params.projectId ?? OWNER_MEMORY_SCOPE,
          query: params.query,
          limit: params.limit,
          now: dependencies.now(),
        }).map(memoryProjection),
      });
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[13],
    description: "Forget one memory by id, when the owner says it is wrong or no longer applies.",
    experimental_statusLabels: { pending: "Forgetting", completed: "Forgot" },
    parameters: z.object({ id: z.string().min(1).max(256) }).strict(),
    execute: (params, context) => {
      authorizedController(dependencies.store, context);
      return json({ forgotten: dependencies.store.forgetMemory({ id: params.id, now: dependencies.now() }) });
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[14],
    description: "Set a durable monitor that wakes you later so you can act without the owner asking again. Either watch a thread and run when it finishes or fails, or run on a repeating schedule. Write the instruction to your future self, in full, because you will only receive that text.",
    experimental_statusLabels: { pending: "Setting a monitor", completed: "Monitor set" },
    parameters: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("thread_idle"),
        threadId: z.string().min(1).max(256),
        instruction: z.string().trim().min(1).max(1_000),
      }).strict(),
      z.object({
        kind: z.literal("schedule"),
        cron: z.string().trim().min(1).max(120).describe("5-field cron, server-local time"),
        instruction: z.string().trim().min(1).max(1_000),
      }).strict(),
    ]),
    execute: (params, context) => {
      const controller = authorizedController(dependencies.store, context);
      return once(dependencies, { controllerKey: controller.controllerKey, toolName: CONTROLLER_TOOL_NAMES[14], params }, () => {
        const now = dependencies.now();
        const dueAt = params.kind === "schedule" ? nextCronOccurrence(params.cron, now) : null;
        if (params.kind === "schedule" && dueAt === null) {
          throw new Error("That cron expression is not valid; use 5 fields such as '0 9 * * 1-5'");
        }
        const monitor = dependencies.store.createMonitor({
          controllerKey: controller.controllerKey,
          kind: params.kind,
          threadId: params.kind === "thread_idle" ? params.threadId : undefined,
          cron: params.kind === "schedule" ? params.cron : undefined,
          instruction: params.instruction,
          dueAt,
          now,
        });
        dependencies.notify();
        return json({ watching: monitorProjection(monitor) });
      });
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[15],
    description: "List the monitors currently set, so the owner can be told what you are watching.",
    parameters: z.object({ includeFinished: z.boolean().default(false) }).strict(),
    execute: (params, context) => {
      const controller = authorizedController(dependencies.store, context);
      return json({
        monitors: dependencies.store
          .listMonitors(controller.controllerKey, params.includeFinished)
          .map(monitorProjection),
      });
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[16],
    description: "Cancel one monitor by id.",
    parameters: z.object({ id: z.string().min(1).max(256) }).strict(),
    execute: (params, context) => {
      authorizedController(dependencies.store, context);
      return json({ cancelled: dependencies.store.cancelMonitor(params.id, dependencies.now()) });
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[17],
    description: "Check your own plumbing: executor, queued work, undelivered messages, Telegram intake, monitors, memory search, and database integrity. Use this when the owner says something seems stuck or slow.",
    experimental_statusLabels: { pending: "Checking health", completed: "Checked health" },
    parameters: z.object({}).strict(),
    execute: (_params, context) => {
      authorizedController(dependencies.store, context);
      return json(dependencies.health(dependencies.now()));
    },
  });

  bb.agents.configure((context) => {
    const controller = dependencies.store.getControllerByThreadId(context.thread.id);
    const candidate = controller !== null &&
      controller.projectId === context.project.id &&
      controller.hostId === context.host.id &&
      context.origin.kind === null &&
      context.origin.pluginId === bb.pluginId &&
      (CONTROLLER_PROVIDERS as readonly string[]).includes(context.provider.id) &&
      context.project.kind === "personal" &&
      context.environment.workspaceProvisionType === "personal" &&
      isControllerThreadTitle(context.thread.title, controller.controllerKey);
    return candidate
      ? { tools: [...CONTROLLER_TOOL_NAMES], skills: [], instructions: CONTROLLER_INSTRUCTIONS }
      : { tools: [], skills: [] };
  });
}
