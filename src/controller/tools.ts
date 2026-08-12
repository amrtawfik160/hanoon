import type { BbPluginApi, PluginAgentConfigurationContext } from "@bb/plugin-sdk";
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
import { MAX_CONTROLLER_OVERLAY, composeControllerInstructions } from "./instructions";
import {
  parseWorkerThreadTitle,
  resolveWorkerSkillProfile,
  type DurableWorkerIdentity,
  type WorkerSkillRole,
  type WorkerTitleIdentity,
} from "../agent-skills/role-resolver";
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
  "telegram_agent_delegate",
  "telegram_agent_scorecard",
  "telegram_agent_set_working_style",
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

const WORKER_ID_PREFIX: Readonly<Record<WorkerSkillRole, "attempt:" | "stage:">> = {
  implementation: "attempt:",
  review: "attempt:",
  "final-review": "attempt:",
  planner: "stage:",
  critic: "stage:",
  documentation: "stage:",
};

const WORKER_EFFECT_KIND = {
  implementation: "spawn_implementation",
  review: "spawn_review",
  "final-review": "spawn_final_review",
  planner: "spawn_plan",
  critic: "spawn_critique",
  documentation: "spawn_docs",
} as const;

function workerEffectIdempotencyKey(title: WorkerTitleIdentity): string | null {
  const prefix = WORKER_ID_PREFIX[title.role];
  if (!title.attemptId.startsWith(prefix)) return null;
  const effectIdempotencyKey = title.attemptId.slice(prefix.length);
  return effectIdempotencyKey || null;
}

function persistedWorkerThreadId(
  store: TelegramAgentStore,
  title: WorkerTitleIdentity,
): string | null | undefined {
  if (WORKER_ID_PREFIX[title.role] === "attempt:") {
    const attempt = store.getAttempt(title.attemptId);
    const expectedKind = title.role === "implementation" ? "implementation" : "review";
    return attempt && attempt.jobId === title.jobId && attempt.kind === expectedKind ? attempt.threadId : undefined;
  }
  const attempt = store.getPipelineStageAttempt(title.attemptId);
  const expectedRole = title.role === "planner" ? "PLAN" : title.role === "critic" ? "CRITIQUE" : "DOCS";
  return attempt && attempt.jobId === title.jobId && attempt.role === expectedRole ? attempt.threadId : undefined;
}

function durableWorkerIdentity(
  store: TelegramAgentStore,
  input: Readonly<{
    title: WorkerTitleIdentity;
    context: PluginAgentConfigurationContext;
    effectIdempotencyKey: string;
    threadId: string | null;
  }>,
): DurableWorkerIdentity | null {
  const effect = store.getEffect(input.title.jobId, input.effectIdempotencyKey);
  if (!effect || effect.kind !== WORKER_EFFECT_KIND[input.title.role]) return null;
  const job = store.getJob(input.title.jobId);
  if (!job || job.projectId !== input.context.project.id) return null;
  return {
    ...input.title,
    projectId: job.projectId,
    environmentId: job.environmentId,
    threadId: input.threadId,
  };
}

function resolveDurableWorkerIdentity(
  store: TelegramAgentStore,
  title: WorkerTitleIdentity,
  context: PluginAgentConfigurationContext,
): DurableWorkerIdentity | null {
  const effectIdempotencyKey = workerEffectIdempotencyKey(title);
  if (!effectIdempotencyKey) return null;
  const threadId = persistedWorkerThreadId(store, title);
  if (threadId === undefined) return null;
  return durableWorkerIdentity(store, { title, context, effectIdempotencyKey, threadId });
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

/**
 * `awaiting_confirmation` names a state machine step, not an owner obligation.
 * A job the agent started is confirmed on creation and merely waits for a free
 * slot, so the projection says outright whether anyone is waiting on the owner
 * — otherwise the agent reads the state name and invents an approval tap that
 * has no button and never comes.
 */
function jobProjection(job: Job, admission?: { state: string } | null) {
  const queue = admission?.state ?? null;
  return {
    job: {
      id: job.id,
      state: job.state,
      queue,
      awaitingOwner: job.state === "awaiting_confirmation" && queue === null,
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
        return json(jobProjection(job, dependencies.store.getAdmission(job.id)));
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
        ? jobProjection(resolution.job, dependencies.store.getAdmission(resolution.job.id))
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
        return json(jobProjection(updated, dependencies.store.getAdmission(updated.id)));
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
        if (job.cancelRequestedAt !== null) return json(jobProjection(job, dependencies.store.getAdmission(job.id)));
        const updated = dependencies.store.applyJobEvent(job.id, job.version, {
          type: "CANCEL_REQUESTED",
          activeWorker: dependencies.store.getWorkerLiveness(job.id),
        }, dependencies.now());
        dependencies.notify();
        return json(jobProjection(updated, dependencies.store.getAdmission(updated.id)));
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

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[18],
    description: "Send several independent pieces of work out at once and get one combined result back. Each task opens its own BB thread; when they have all finished you are woken with their outputs and the instruction you wrote here. Use this instead of working through independent questions one at a time. Guarded code changes still belong to telegram_agent_start_job.",
    experimental_statusLabels: { pending: "Delegating work", completed: "Delegated work" },
    parameters: z.object({
      instruction: z.string().trim().min(1).max(1_000)
        .describe("What to do once every task has finished. You will receive only this text and their results."),
      tasks: z.array(z.object({
        projectId: z.string().min(1).max(256),
        title: z.string().trim().min(1).max(120),
        prompt: z.string().trim().min(1).max(4_000),
      }).strict()).min(1).max(4),
    }).strict(),
    execute: async (params, context) => {
      const controller = authorizedController(dependencies.store, context);
      return once(dependencies, {
        controllerKey: controller.controllerKey,
        toolName: CONTROLLER_TOOL_NAMES[18],
        params,
      }, async () => {
        // The delegation is recorded before anything is spawned, so a failure
        // partway through leaves threads that are still joined and reported
        // rather than orphans nobody is waiting on.
        const delegation = dependencies.store.createDelegation({
          controllerKey: controller.controllerKey,
          instruction: params.instruction,
          now: dependencies.now(),
        });
        const started: { threadId: string; title: string; projectId: string }[] = [];
        for (const task of params.tasks) {
          let threadId: string;
          try {
            const created = await createProjectThread({
              sdk: dependencies.sdk,
              projectId: task.projectId,
              title: task.title,
              prompt: task.prompt,
              signal: context.signal,
            });
            threadId = created.thread.id;
          } catch (error) {
            if (started.length === 0) {
              dependencies.store.cancelDelegation(delegation.id, dependencies.now());
              throw error;
            }
            dependencies.store.sealDelegation({ id: delegation.id, now: dependencies.now() });
            dependencies.notify();
            return json({
              outcome: "partial",
              detail: "Some tasks did not start. The ones that did are still being watched and will report together.",
              delegation: { id: delegation.id, instruction: delegation.instruction, threads: started },
              failed: { title: task.title, reason: redactError(error).slice(0, 200) },
            });
          }
          // A rejected member means the join already fired or the delegation
          // closed; recording it as started would promise a result nobody will
          // ever deliver.
          if (!dependencies.store.addDelegationThread({
            delegationId: delegation.id,
            threadId,
            projectId: task.projectId,
            title: task.title,
            now: dependencies.now(),
          })) break;
          started.push({ threadId, title: task.title, projectId: task.projectId });
        }
        // Sealed only once every member is durably recorded, so the executor
        // cannot join a fan-out that is still being published.
        dependencies.store.sealDelegation({ id: delegation.id, now: dependencies.now() });
        dependencies.notify();
        return json({
          outcome: started.length === params.tasks.length ? "delegated" : "partial",
          delegation: { id: delegation.id, instruction: delegation.instruction, threads: started },
        });
      });
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[19],
    description: "Read the durable autonomy scorecard: work completed and blocked, decisions the owner was asked for, remediation cycles, delivery retries, memory health, and monitors. Every number comes from committed state, so report what it says and never a rate it does not support.",
    experimental_statusLabels: { pending: "Reading the scorecard", completed: "Read the scorecard" },
    parameters: z.object({
      windowDays: z.number().int().min(1).max(90).default(7),
    }).strict(),
    execute: (params, context) => {
      authorizedController(dependencies.store, context);
      return json(dependencies.store.buildAutonomyScorecard({
        now: dependencies.now(),
        windowMs: params.windowDays * 86_400_000,
      }));
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[20],
    description: "Record how the owner wants you to work — terser answers, always show the PR link, a habit they keep asking for. This is standing behaviour, not a fact: it is applied to every later turn. Replace it wholesale each time; send empty text to clear it. Use telegram_agent_remember for things you need to know rather than ways you should act.",
    experimental_statusLabels: { pending: "Adjusting how you work", completed: "Adjusted how you work" },
    parameters: z.object({
      text: z.string().max(MAX_CONTROLLER_OVERLAY),
    }).strict(),
    execute: (params, context) => {
      const controller = authorizedController(dependencies.store, context);
      return once(dependencies, {
        controllerKey: controller.controllerKey,
        toolName: CONTROLLER_TOOL_NAMES[20],
        params,
      }, () => json({
        workingStyle: dependencies.store.setControllerOverlay({
          text: params.text,
          now: dependencies.now(),
        }),
      }));
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
    if (candidate) {
      return {
        tools: [...CONTROLLER_TOOL_NAMES],
        skills: [],
        instructions: composeControllerInstructions(dependencies.store.getControllerOverlay()),
      };
    }
    const title = parseWorkerThreadTitle(context.thread.title);
    const durableIdentity = title === null
      ? null
      : resolveDurableWorkerIdentity(dependencies.store, title, context);
    const profile = resolveWorkerSkillProfile({
      context,
      pluginId: bb.pluginId,
      durableIdentity,
    });
    return profile
      ? { tools: [], skills: [...profile.skills], instructions: profile.instructions }
      : { tools: [], skills: [] };
  });
}
