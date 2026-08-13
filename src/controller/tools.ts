import type { BbPluginApi, PluginAgentConfigurationContext } from "@bb/plugin-sdk";
import { createHash } from "node:crypto";
import { z } from "zod";
import { redactError } from "../errors";
import {
  isResumablePermanentFailure,
  isResumablePlanBlock,
  isResumableReviewBlock,
  isReviewedPrCompletionBlock,
  isRetryableJob,
  type Job,
} from "../domain/models";
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
import {
  CAPABILITY_BY_ID,
  CAPABILITY_GRAPH_DIGEST,
  CAPABILITY_REGISTRY_DIGEST,
  CONTROLLER_METADATA_TOOL_IDS,
  type CapabilitySkillId,
} from "../capabilities/catalog";
import { resolvePersistedWorkerProfile } from "../capabilities/profiles";
import {
  CONTROLLER_BUNDLE_IDS,
  CONTROLLER_DEFAULT_SKILLS,
  CONTROLLER_MANUAL_DISCOVERY_SKILLS,
  assessControllerCapabilityDescriptor,
  controllerBundleIdsFromProfile,
  controllerToolsForBundles,
  type ControllerToolBundleId,
} from "../capabilities/controller-bundles";
import type { ThreadOperationService } from "./operations";
import {
  createProjectThread,
  listVisibleThreads,
  readThreadActivity,
  sendToVisibleThread,
  visibleThreadStatus,
  type ThreadImage,
} from "./thread-observer";
import {
  CONTROLLER_STILL_MIME_TYPES,
  MAX_CONTROLLER_IMAGE_BYTES,
  isMotionMedia,
  normalizeControllerImage,
  type ControllerImage,
} from "./models";
import { adoptPullRequest } from "../bb/pr-adoption";
import { TerminalCommandRunner } from "../bb/terminal-command";
import { isLiveWorkPollingSchedule } from "./monitor-policy";

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
  "telegram_agent_steer_job",
  "telegram_agent_adopt_pr",
] as const;

export const CONTROLLER_METADATA_TOOL_NAMES = CONTROLLER_METADATA_TOOL_IDS;
export const ALL_CONTROLLER_TOOL_NAMES = [
  ...CONTROLLER_TOOL_NAMES,
  ...CONTROLLER_METADATA_TOOL_NAMES,
] as const;

type ToolDependencies = {
  store: TelegramAgentStore;
  sdk: BbPluginApi["sdk"];
  threadOperations: Pick<ThreadOperationService, "request">;
  downloadImage?: (fileId: string, maxBytes: number, signal?: AbortSignal) => Promise<Uint8Array>;
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

function authorizedControllerCapabilityContext(
  store: TelegramAgentStore,
  context: { threadId: string; projectId: string },
) {
  const controller = authorizedController(store, context);
  const turn = store.getPendingControllerTurn(controller.controllerKey);
  if (!turn || turn.state !== "submitted" || controller.capabilitySubjectId !== turn.id) {
    throw new Error("No active controller capability subject is authorized for this session");
  }
  if (!turn.capabilityProfileId || turn.capabilityProfileRevision < 1) {
    throw new Error("The controller capability profile is unavailable");
  }
  const liveProfileMatches = controller.capabilityProfileId === turn.capabilityProfileId &&
    controller.capabilityProfileRevision === turn.capabilityConfiguredRevision;
  if (!liveProfileMatches && turn.capabilityContinuationState !== "requested") {
    throw new Error("The live controller session has not resolved this capability profile");
  }
  const profile = store.getCapabilityProfileById(turn.capabilityProfileId);
  if (
    !profile || profile.subjectKind !== "controller_turn" || profile.subjectId !== turn.id ||
    profile.revision !== turn.capabilityProfileRevision || profile.mode !== "active" ||
    profile.registryDigest !== CAPABILITY_REGISTRY_DIGEST ||
    profile.graphDigest !== CAPABILITY_GRAPH_DIGEST
  ) {
    throw new Error("The controller capability profile does not match durable policy");
  }
  return { controller, turn, profile };
}

async function ownerTurnImages(
  dependencies: ToolDependencies,
  controllerKey: string,
  signal: AbortSignal,
): Promise<ThreadImage[]> {
  const turn = dependencies.store.getPendingControllerTurn(controllerKey);
  const image = turn?.image;
  if (!image) {
    throw new Error("The owner did not send an image on this turn");
  }
  if (!dependencies.downloadImage) {
    throw new Error("Image download is not configured");
  }
  const media = normalizeControllerImage(image);
  const source: ControllerImage = isMotionMedia(media) && media.thumbnail
    ? {
      fileId: media.thumbnail.fileId,
      fileName: media.thumbnail.fileName,
      mimeType: "image/jpeg",
      sizeBytes: media.thumbnail.sizeBytes,
      kind: "image",
    }
    : media;
  if (!(CONTROLLER_STILL_MIME_TYPES as readonly string[]).includes(source.mimeType)) {
    throw new Error("That attachment is a clip. Send a still photo to attach it to a BB thread.");
  }
  const bytes = await dependencies.downloadImage(source.fileId, MAX_CONTROLLER_IMAGE_BYTES, signal);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CONTROLLER_IMAGE_BYTES) {
    throw new Error("The owner image could not be read");
  }
  return [{ fileName: source.fileName, mimeType: source.mimeType, bytes }];
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
  let persistedSkillProfile: DurableWorkerIdentity["persistedSkillProfile"];
  if (job.routingMode === "active") {
    const profile = store.getActiveCapabilityProfile("worker_attempt", input.title.attemptId);
    if (!profile || profile.subjectId !== input.title.attemptId || profile.recipeId !== job.taskRecipe ||
      profile.recipeVersion !== job.recipeVersion || profile.registryDigest !== CAPABILITY_REGISTRY_DIGEST ||
      profile.graphDigest !== CAPABILITY_GRAPH_DIGEST ||
      (profile.threadId !== null && profile.threadId !== input.threadId)) return null;
    const assignments = profile.assignments.flatMap((assignment) => {
      const descriptor = CAPABILITY_BY_ID.get(assignment.capabilityId);
      if (!descriptor || descriptor.kind !== "skill" || descriptor.route !== "worker" ||
        !descriptor.routing.roles.includes(input.title.role) ||
        !descriptor.routing.recipes.includes(job.taskRecipe)) return [];
      return [{
        capabilityId: assignment.capabilityId as CapabilitySkillId,
        descriptorDigest: assignment.descriptorDigest,
        route: descriptor.route,
        mandatory: assignment.mandatory,
      }];
    });
    if (assignments.length !== profile.assignments.length) return null;
    const identity = {
      profileId: profile.id,
      revision: profile.revision,
      recipeVersion: profile.recipeVersion,
      role: input.title.role,
      jobId: job.id,
      attemptId: input.title.attemptId,
      projectId: job.projectId,
      environmentId: job.environmentId,
      threadId: profile.threadId,
    } as const;
    const resolved = resolvePersistedWorkerProfile({
      persisted: { ...identity, assignments },
      expected: identity,
    });
    if (!resolved) return null;
    persistedSkillProfile = {
      profileId: profile.id,
      profileRevision: profile.revision,
      skills: resolved.skills,
    };
  }
  return {
    ...input.title,
    projectId: job.projectId,
    environmentId: job.environmentId,
    threadId: input.threadId,
    routingMode: job.routingMode,
    persistedSkillProfile,
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
      planCycle: job.planCycle,
      reviewCycle: job.reviewCycle,
      deliveryMode: job.deliveryMode,
      taskRecipe: job.taskRecipe,
      recipeVersion: job.recipeVersion,
      recipePromotionCount: job.recipePromotionCount,
      routingMode: job.routingMode,
      cancelRequested: job.cancelRequestedAt !== null,
      resumable: isRetryableJob(job),
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
    description: "Create one guarded implementation job for an enabled project. Use path small_fix for a typo, lint, wording, or one-file change: skip critique, publish a pull request, and stop. Full jobs still plan, review, and finish at a reviewed PR when production is not configured. An exact task reuses its open job. A different task in the same project returns the open job so you can steer a follow-up into it; set separateWork only when the owner explicitly said this is independent work.",
    parameters: z.object({
      projectId: z.string().min(1).max(256),
      task: z.string().trim().min(1).max(4_000),
      path: z.enum(["full", "small_fix"]).optional(),
      separateWork: z.boolean().default(false),
    }).strict(),
    execute: (params, context) => {
      const controller = authorizedController(dependencies.store, context);
      const existing = dependencies.store.findOpenJobByProjectAndTask(params.projectId, params.task);
      if (existing) {
        return json({
          ...jobProjection(existing, dependencies.store.getAdmission(existing.id)),
          existing: true,
        });
      }
      const openProjectJob = dependencies.store.findOpenJobByProject(params.projectId);
      if (openProjectJob && !params.separateWork) {
        return json({
          outcome: "open_job_requires_resolution",
          ...jobProjection(openProjectJob, dependencies.store.getAdmission(openProjectJob.id)),
          guidance: openProjectJob.implementationThreadId
            ? "Use telegram_agent_steer_job if this message refines the open implementation."
            : "Inspect or retry the open job before creating separate work.",
        });
      }
      return once(dependencies, { controllerKey: controller.controllerKey, toolName: CONTROLLER_TOOL_NAMES[1], params }, () => {
        const job = dependencies.store.createConfirmedControllerJob({
          controllerThreadId: context.threadId,
          projectId: params.projectId,
          task: params.task,
          path: params.path,
          now: dependencies.now(),
        });
        dependencies.notify();
        return json({
          ...jobProjection(job, dependencies.store.getAdmission(job.id)),
          existing: false,
        });
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
    description: "Resume a recoverable Telegram Agent job: retry a failed or stuck step, continue a blocked plan or review, finish a reviewed PR when production is not configured, or pick up from review when a PR already exists.",
    parameters: z.object({ jobId: z.string().min(1).max(256).optional() }).strict(),
    execute: (params, context) => {
      const controller = authorizedController(dependencies.store, context);
      return once(dependencies, { controllerKey: controller.controllerKey, toolName: CONTROLLER_TOOL_NAMES[3], params }, () => {
        const resolution = resolveJob(dependencies.store, "retry", params.jobId);
        if (resolution.outcome !== "job") return json(resolutionProjection(resolution));
        const job = resolution.job;
        if (job.cancelRequestedAt !== null) throw new Error("The requested job is not retryable");
        if (isResumablePlanBlock(job) || isResumableReviewBlock(job) || isReviewedPrCompletionBlock(job)) {
          const queued = dependencies.store.requeueReviewAdmission(job.id, job.version, dependencies.now());
          if (queued.outcome === "unavailable") throw new Error("The requested job is not retryable");
          const current = dependencies.store.getJob(job.id) ?? job;
          if (queued.outcome !== "still_cleaning_up") dependencies.notify();
          return json({
            ...jobProjection(current, queued.admission ?? dependencies.store.getAdmission(current.id)),
            cleaningUp: queued.outcome === "still_cleaning_up",
          });
        }
        if (job.state !== "failed" && !isResumablePermanentFailure(job)) {
          throw new Error("The requested job is not retryable");
        }
        const retryResult = dependencies.store.retryFailedJob(job.id, job.version, dependencies.now());
        if (retryResult.outcome === "unavailable") throw new Error("The requested job is not retryable");
        dependencies.notify();
        return json(jobProjection(retryResult.job, retryResult.admission));
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
        if (["merged", "cancelled", "complete", "production_failed"].includes(job.state)) {
          throw new Error("The requested job cannot be cancelled");
        }
        if (job.cancelRequestedAt !== null) return json(jobProjection(job, dependencies.store.getAdmission(job.id)));
        const activeWorkers = dependencies.store.getCurrentWorkerLiveness(job.id);
        const updated = dependencies.store.applyJobEvent(job.id, job.version, activeWorkers === null
          ? { type: "CANCEL_REQUESTED" }
          : { type: "CANCEL_REQUESTED", activeWorker: activeWorkers[0] ?? null, activeWorkers }, dependencies.now());
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
    description: "Start a new BB thread in one of the owner's projects for exploratory or read-only work, or for an owner-authorized repository operation that needs that project's checkout or credentials. If the owner just sent a photo, set attachOwnerImage to pass that image into the new thread. Guarded code changes still belong to telegram_agent_start_job; never use this tool to merge, deploy, or bypass a one-use approval.",
    experimental_statusLabels: { pending: "Starting thread", completed: "Started thread" },
    parameters: z.object({
      projectId: z.string().min(1).max(256),
      title: z.string().trim().min(1).max(120),
      prompt: z.string().trim().min(1).max(4_000),
      attachOwnerImage: z.boolean().default(false)
        .describe("Attach the photo the owner just sent on this Telegram turn"),
    }).strict(),
    execute: async (params, context) => {
      const controller = authorizedController(dependencies.store, context);
      return once(dependencies, { controllerKey: controller.controllerKey, toolName: CONTROLLER_TOOL_NAMES[8], params }, async () => {
        const images = params.attachOwnerImage
          ? await ownerTurnImages(dependencies, controller.controllerKey, context.signal)
          : [];
        return json(await createProjectThread({
          sdk: dependencies.sdk,
          projectId: params.projectId,
          title: params.title,
          prompt: params.prompt,
          images,
          signal: context.signal,
        }));
      });
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[9],
    description: "Send a message to one visible BB thread and let it continue working. If the owner just sent a photo, set attachOwnerImage to pass that image with the message.",
    experimental_statusLabels: { pending: "Messaging thread", completed: "Messaged thread" },
    parameters: z.object({
      threadId: z.string().min(1).max(256),
      text: z.string().trim().min(1).max(4_000),
      attachOwnerImage: z.boolean().default(false)
        .describe("Attach the photo the owner just sent on this Telegram turn"),
    }).strict(),
    execute: async (params, context) => {
      const controller = authorizedController(dependencies.store, context);
      return once(dependencies, { controllerKey: controller.controllerKey, toolName: CONTROLLER_TOOL_NAMES[9], params }, async () => {
        const images = params.attachOwnerImage
          ? await ownerTurnImages(dependencies, controller.controllerKey, context.signal)
          : [];
        return json(await sendToVisibleThread({
          sdk: dependencies.sdk,
          threadId: params.threadId,
          text: params.text,
          images,
          signal: context.signal,
        }));
      });
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
    description: "Set a durable monitor that wakes you later so you can act without the owner asking again. Use thread_idle to watch a thread until it finishes or fails — the plugin already hears BB events in real time. Use a schedule only for clock time, never to poll a running thread or job. Write the instruction to your future self, in full, because you will only receive that text.",
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
        if (params.kind === "schedule" && isLiveWorkPollingSchedule(params.instruction)) {
          throw new Error(
            "A repeating schedule cannot poll live work. Watch the worker BB thread with thread_idle; job progress is already event-driven.",
          );
        }
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

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[21],
    description: "Send a clear owner follow-up into the current admitted implementation instead of creating another job. Use this for corrections, constraints, and extra acceptance details that belong to work already underway.",
    experimental_statusLabels: { pending: "Updating implementation", completed: "Implementation updated" },
    parameters: z.object({
      jobId: z.string().min(1).max(256).optional(),
      text: z.string().trim().min(1).max(4_000),
    }).strict(),
    execute: (params, context) => {
      const controller = authorizedController(dependencies.store, context);
      const candidates = dependencies.store.listJobs(100).filter((job) =>
        (job.state === "implementing" || job.state === "remediating") &&
        job.implementationThreadId !== null && job.cancelRequestedAt === null &&
        dependencies.store.getAdmission(job.id)?.state === "admitted"
      );
      const job = params.jobId === undefined
        ? (candidates.length === 1 ? candidates[0] : null)
        : candidates.find((candidate) => candidate.id === params.jobId) ?? null;
      if (!job) {
        return json(candidates.length > 1 && params.jobId === undefined
          ? { outcome: "choose_job", candidates: candidates.slice(0, 8).map(candidateProjection) }
          : { outcome: "no_steerable_job", candidates: [] });
      }
      const turn = dependencies.store.getPendingControllerTurn(controller.controllerKey);
      if (!turn || job.implementationThreadId === null) throw new Error("The controller turn cannot steer this job");
      return once(dependencies, { controllerKey: controller.controllerKey, toolName: CONTROLLER_TOOL_NAMES[21], params }, () => {
        const steered = dependencies.store.enqueueSteeringEffect(
          job.id,
          turn.updateId,
          job.implementationThreadId!,
          params.text,
          dependencies.now(),
        );
        if (!steered) throw new Error("The implementation is no longer steerable");
        dependencies.notify();
        return json({ steered: true, ...jobProjection(job, dependencies.store.getAdmission(job.id)) });
      });
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_TOOL_NAMES[22],
    description: "Adopt an existing open, non-draft pull request as a guarded full job. The plugin verifies the selected repository, base branch, PR identity, exact remote head, and a deterministic local branch before queuing review and finish work. Planning and critique are recorded as skipped.",
    experimental_statusLabels: { pending: "Verifying pull request", completed: "Adopted pull request" },
    parameters: z.object({
      projectId: z.string().min(1).max(256),
      prNumber: z.number().int().positive(),
      task: z.string().trim().min(1).max(4_000).default("Review and finish the existing pull request"),
    }).strict(),
    execute: async (params, context) => {
      const controller = authorizedController(dependencies.store, context);
      return once(dependencies, { controllerKey: controller.controllerKey, toolName: CONTROLLER_TOOL_NAMES[22], params }, async () => {
        const policyRecord = dependencies.store.getProjectPolicy(params.projectId);
        if (!policyRecord?.policy.enabled) throw new Error("Selected project is not enabled");
        const projects = await dependencies.sdk.projects.list();
        const project = projects.find((candidate) => candidate.id === params.projectId);
        if (!project || project.kind !== "standard") throw new Error("Selected project cannot host an adopted pull request");
        const source = project.sources.find((candidate) => candidate.isDefault) ??
          (project.sources.length === 1 ? project.sources[0] : undefined);
        if (!source?.hostId || !source.path) throw new Error("Selected project has no unambiguous local source");
        const adopted = await adoptPullRequest({
          runner: new TerminalCommandRunner(dependencies.sdk),
          scope: { kind: "host_path", hostId: source.hostId, cwd: source.path },
          policy: policyRecord.policy,
          prNumber: params.prNumber,
          signal: context.signal,
        });
        const job = dependencies.store.createAdoptedControllerJob({
          controllerThreadId: context.threadId,
          projectId: params.projectId,
          task: params.task,
          prNumber: adopted.prNumber,
          prUrl: adopted.prUrl,
          headSha: adopted.headSha,
          branchName: adopted.branchName,
          now: dependencies.now(),
        });
        dependencies.notify();
        return json({ ...jobProjection(job, dependencies.store.getAdmission(job.id)), adopted: true });
      });
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_METADATA_TOOL_NAMES[0],
    description: "Show the bounded capability profile for this controller turn: selected bundles, eligible additions, recent denials, and inventory availability. This never changes authority.",
    experimental_statusLabels: { pending: "Reading capabilities", completed: "Read capabilities" },
    parameters: z.object({}).strict(),
    execute: (_params, context) => {
      const { turn, profile } = authorizedControllerCapabilityContext(dependencies.store, context);
      const selected = controllerBundleIdsFromProfile(profile);
      const selectedSet = new Set(selected);
      const eligibleBundles = CONTROLLER_BUNDLE_IDS
        .filter((bundleId) => !selectedSet.has(bundleId))
        .map((bundleId) => {
          const descriptor = CAPABILITY_BY_ID.get(`controller-bundle-${bundleId}`);
          if (!descriptor) return { id: bundleId, eligible: false, reasonCode: "unknown_bundle" };
          const assessment = assessControllerCapabilityDescriptor(descriptor);
          return assessment.allowed
            ? { id: bundleId, eligible: true }
            : { id: bundleId, eligible: false, reasonCode: assessment.reasonCode };
        });
      const denials = dependencies.store.listCapabilityReceipts(profile.id, 64)
        .filter((receipt) => receipt.eventType === "denied")
        .slice(-8)
        .map((receipt) => ({ capabilityId: receipt.capabilityId, reasonCode: receipt.reasonCode }));
      const policy = dependencies.store.listEnabledProjectPolicies()
        .sort((left, right) => left.policy.projectId.localeCompare(right.policy.projectId))[0]?.policy;
      const hostScope = policy ? `project:${policy.projectId}` : "primary";
      const inventoryRows = dependencies.store.listExternalCapabilityInventory(hostScope, 9);
      const inventoryHealth = dependencies.store.getExternalCapabilityInventoryHealth(hostScope);
      return json({
        profile: {
          id: profile.id,
          revision: profile.revision,
          recipe: profile.recipeId,
          bundles: selected,
          continuationCount: turn.capabilityContinuationCount,
          continuationState: turn.capabilityContinuationState,
        },
        eligibleBundles,
        denials,
        inventory: {
          available: inventoryHealth?.status === "ok",
          hostScope,
          health: inventoryHealth ? {
            status: inventoryHealth.status,
            errorClass: inventoryHealth.errorClass,
            refreshedAt: inventoryHealth.refreshedAt,
          } : null,
          items: inventoryRows.slice(0, 8).map((item) => ({
            id: item.capabilityId,
            kind: item.capabilityKind,
            version: item.version,
            digest: item.digest,
            status: item.status,
          })),
          truncated: inventoryRows.length > 8,
        },
      });
    },
  });

  bb.agents.registerTool({
    name: CONTROLLER_METADATA_TOOL_NAMES[1],
    description: "Request one additive batch of controller tool bundles. A compatible grant is persisted but becomes usable only in a fresh provider session; this tool never performs the requested domain operation.",
    experimental_statusLabels: { pending: "Checking capability request", completed: "Checked capability request" },
    parameters: z.object({
      bundleIds: z.array(z.enum(CONTROLLER_BUNDLE_IDS)).min(1).max(CONTROLLER_BUNDLE_IDS.length),
    }).strict(),
    execute: (params, context) => {
      const { controller, turn, profile } = authorizedControllerCapabilityContext(dependencies.store, context);
      return once(dependencies, {
        controllerKey: controller.controllerKey,
        toolName: CONTROLLER_METADATA_TOOL_NAMES[1],
        params,
      }, () => {
        const expansion = dependencies.store.requestControllerCapabilityExpansion({
          controllerKey: controller.controllerKey,
          turnId: turn.id,
          expectedProfileId: profile.id,
          bundleIds: params.bundleIds,
          now: dependencies.now(),
        });
        dependencies.notify();
        return expansion.outcome === "resume_required"
          ? json({
              outcome: expansion.outcome,
              profileRevision: expansion.profile.revision,
              continuationCount: expansion.continuationCount,
              selectedBundleIds: expansion.selectedBundleIds,
            })
          : json({
              ...expansion,
              scope: "controller_tool_expansion",
              accessDenied: false,
              guidance: "This limits additional controller tools for this turn; it does not deny BB, shell, provider, connector, or project access.",
            });
      });
    },
  });

  bb.agents.configure((context) => {
    const mappedController = dependencies.store.getControllerByThreadId(context.thread.id);
    const owner = dependencies.store.getOwner();
    const ownerController = owner
      ? dependencies.store.getControllerForOwner(owner.userId, owner.chatId)
      : null;
    const pending = ownerController
      ? dependencies.store.getPendingControllerTurn(ownerController.controllerKey)
      : null;
    const mappedCandidate = mappedController !== null &&
      mappedController.projectId === context.project.id &&
      mappedController.hostId === context.host.id;
    const spawningCandidate = mappedController === null && ownerController !== null && pending !== null &&
      ownerController.threadId === null && ownerController.pendingSpawnToken === pending.id &&
      pending.state === "dispatching";
    const controller = mappedController ?? (spawningCandidate ? ownerController : null);
    const candidate = controller !== null && (mappedCandidate || spawningCandidate) &&
      context.origin.kind === null &&
      context.origin.pluginId === bb.pluginId &&
      (CONTROLLER_PROVIDERS as readonly string[]).includes(context.provider.id) &&
      context.project.kind === "personal" &&
      context.environment.workspaceProvisionType === "personal" &&
      isControllerThreadTitle(context.thread.title, controller.controllerKey);
    if (candidate) {
      const turn = dependencies.store.getPendingControllerTurn(controller.controllerKey);
      const persisted = turn?.capabilityProfileId
        ? dependencies.store.getCapabilityProfileById(turn.capabilityProfileId)
        : null;
      if (
        turn && persisted && persisted.subjectKind === "controller_turn" &&
        persisted.subjectId === turn.id && persisted.revision === turn.capabilityProfileRevision &&
        persisted.mode === "active" && persisted.registryDigest === CAPABILITY_REGISTRY_DIGEST &&
        persisted.graphDigest === CAPABILITY_GRAPH_DIGEST
      ) {
        const bundles = controllerBundleIdsFromProfile(persisted);
        const skills = persisted.assignments
          .filter((assignment) => assignment.capabilityKind === "skill")
          .map((assignment) => assignment.capabilityId)
          .filter((capabilityId): capabilityId is CapabilitySkillId => {
            const descriptor = CAPABILITY_BY_ID.get(capabilityId);
            return descriptor?.kind === "skill";
          });
        return {
          tools: controllerToolsForBundles(bundles),
          skills,
          instructions: composeControllerInstructions(dependencies.store.getControllerOverlay()),
        };
      }
      // A migrated in-flight turn has no profile. Keep its historical surface
      // until it settles; every newly enqueued turn is profile-backed.
      return {
        tools: [...ALL_CONTROLLER_TOOL_NAMES],
        skills: [...CONTROLLER_DEFAULT_SKILLS, ...CONTROLLER_MANUAL_DISCOVERY_SKILLS],
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
