import type { BbPluginApi, PluginAgentConfigurationContext, PluginAgentToolContext } from "@bb/plugin-sdk";
import { z } from "zod";
import { redactError } from "../errors";
import type { Job } from "../domain/models";
import {
  OWNER_MEMORY_SCOPE,
  mergeEvidenceBindingError,
  parsePersistedMergeEvidence,
  type MemoryRecord,
  type MonitorRecord,
  type TelegramAgentStore,
  type JobControlKind,
} from "../storage/store";
import { nextCronOccurrence } from "../services/monitor-service";
import { parseProductionStageSnapshot } from "../services/production-runner";
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
  assertProjectHostScope,
  assertVisibleThreadScope,
  createProjectThread,
  listVisibleThreads,
  readThreadActivity,
  sendToVisibleThread,
  visibleThreadStatus,
} from "./thread-observer";
import {
  registerControllerCapabilityTool,
  sha256ControllerJson,
  type AuthorizedControllerCapability,
  type ControllerCapabilityEvidenceProjection,
  type ControllerCapabilityScopeResolution,
  type ControllerJsonObject,
} from "./capability-executor";
import { CONTROLLER_CAPABILITIES, type ControllerToolName } from "./capability-policy";

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

type TrustedScopeState = {
  authorized?: AuthorizedControllerCapability;
  jobResolution?: JobResolution;
  beforeJob?: Job | null;
  beforeOverlay?: string | null;
  hostIds?: Readonly<Record<string, string>>;
};

function exactScope(entityRefs: readonly string[], matches: boolean, state: TrustedScopeState = {}): ControllerCapabilityScopeResolution {
  return { scope: { kind: "exact_entity", entityRefs, matches }, state };
}

function globalScope(state: TrustedScopeState = {}): ControllerCapabilityScopeResolution {
  return { scope: { kind: "controller_global", entityRefs: [], matches: true }, state };
}

function trustedState(resolution: ControllerCapabilityScopeResolution): TrustedScopeState {
  return (resolution.state ?? {}) as TrustedScopeState;
}

function enabledProject(store: TelegramAgentStore, projectId: string): boolean {
  return store.getProjectPolicy(projectId)?.policy.enabled === true;
}

async function visibleThreadResolution(
  dependencies: ToolDependencies,
  threadId: string,
  context: PluginAgentToolContext,
): Promise<ControllerCapabilityScopeResolution> {
  try {
    const thread = await assertVisibleThreadScope({ sdk: dependencies.sdk, threadId, signal: context.signal });
    return exactScope([`thread:${thread.id}`], thread.id === threadId);
  } catch {
    return exactScope([`thread:${threadId}`], false);
  }
}

async function resolveTrustedScope(
  request: Readonly<{
    dependencies: ToolDependencies;
    name: ControllerToolName;
    params: unknown;
    context: PluginAgentToolContext;
    authorized: AuthorizedControllerCapability;
  }>,
): Promise<ControllerCapabilityScopeResolution> {
  const { dependencies, context, authorized } = request;
  const params = request.params as Record<string, unknown>;
  switch (request.name) {
    case "telegram_agent_list_projects":
    case "telegram_agent_list_watches":
    case "telegram_agent_health":
    case "telegram_agent_scorecard":
      return globalScope();
    case "telegram_agent_set_working_style":
      return globalScope({ beforeOverlay: dependencies.store.getControllerOverlay() });
    case "telegram_agent_start_job": {
      const projectId = String(params.projectId);
      return exactScope([`project:${projectId}`], enabledProject(dependencies.store, projectId), {
        beforeJob: dependencies.store.getJobBySourceUpdateId(authorized.turn.updateId),
      });
    }
    case "telegram_agent_job_status":
    case "telegram_agent_retry_job":
    case "telegram_agent_cancel_job": {
      const kind: JobControlKind = request.name === "telegram_agent_job_status" ? "status"
        : request.name === "telegram_agent_retry_job" ? "retry" : "cancel";
      const resolution = resolveJob(dependencies.store, kind, params.jobId as string | undefined);
      const jobs = resolution.outcome === "job" ? [resolution.job]
        : resolution.outcome === "choose_job" ? resolution.candidates : [];
      const matched = resolution.outcome !== "job" ||
        (request.name === "telegram_agent_retry_job"
          ? resolution.job.state === "failed" && resolution.job.cancelRequestedAt === null
          : request.name === "telegram_agent_cancel_job"
            ? !["merged", "cancelled", "blocked", "complete", "production_failed"].includes(resolution.job.state)
            : true);
      return exactScope(jobs.map((job) => `job:${job.id}`), matched, {
        jobResolution: resolution,
        beforeJob: resolution.outcome === "job" ? resolution.job : null,
      });
    }
    case "telegram_agent_list_threads":
    case "telegram_agent_remember":
    case "telegram_agent_recall": {
      const projectId = params.projectId as string | undefined;
      return projectId === undefined
        ? globalScope()
        : exactScope([`project:${projectId}`], enabledProject(dependencies.store, projectId));
    }
    case "telegram_agent_thread_status":
    case "telegram_agent_read_thread":
    case "telegram_agent_send_to_thread":
    case "telegram_agent_request_thread_operation":
      return visibleThreadResolution(dependencies, String(params.threadId), context);
    case "telegram_agent_create_thread": {
      const projectId = String(params.projectId);
      if (!enabledProject(dependencies.store, projectId)) return exactScope([`project:${projectId}`], false);
      try {
        const hostId = await assertProjectHostScope({ sdk: dependencies.sdk, projectId, signal: context.signal });
        return exactScope([`project:${projectId}`], true, { hostIds: { [projectId]: hostId } });
      } catch {
        return exactScope([`project:${projectId}`], false);
      }
    }
    case "telegram_agent_forget": {
      const id = String(params.id);
      const memory = dependencies.store.getMemory(id);
      const live = memory !== null && memory.forgottenAt === null && memory.supersededBy === null;
      const allowed = live && (memory.scope === OWNER_MEMORY_SCOPE || enabledProject(dependencies.store, memory.scope));
      return exactScope([`memory:${id}`], allowed);
    }
    case "telegram_agent_watch": {
      if (params.kind === "thread_idle") {
        return visibleThreadResolution(dependencies, String(params.threadId), context);
      }
      const cron = String(params.cron);
      const valid = nextCronOccurrence(cron, dependencies.now()) !== null;
      return exactScope([`schedule:${sha256ControllerJson(cron)}`], valid);
    }
    case "telegram_agent_cancel_watch": {
      const id = String(params.id);
      const monitor = dependencies.store.getControllerMonitor(authorized.controller.controllerKey, id);
      return exactScope([`monitor:${id}`], monitor !== null);
    }
    case "telegram_agent_delegate": {
      const tasks = params.tasks as Array<{ projectId: string }>;
      const projectIds = [...new Set(tasks.map((task) => task.projectId))];
      if (!projectIds.every((projectId) => enabledProject(dependencies.store, projectId))) {
        return exactScope(projectIds.map((id) => `project:${id}`), false);
      }
      const hostIds: Record<string, string> = {};
      try {
        for (const projectId of projectIds) {
          hostIds[projectId] = await assertProjectHostScope({ sdk: dependencies.sdk, projectId, signal: context.signal });
        }
      } catch {
        return exactScope(projectIds.map((id) => `project:${id}`), false);
      }
      return exactScope(projectIds.map((id) => `project:${id}`), true, { hostIds });
    }
    case "telegram_agent_turn_evidence":
    case "telegram_agent_respond":
      throw new Error("Task 7 and Task 8 capabilities are not registered by Task 6");
  }
}

const TERMINAL_JOB_STATES = new Set(["merged", "cancelled", "blocked", "complete", "production_failed"]);

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function objectArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(recordValue).filter((item): item is Record<string, unknown> => item !== null) : [];
}

function refIds(value: unknown, prefix: string): string[] {
  return objectArray(value).flatMap((item) => typeof item.id === "string" ? [`${prefix}:${item.id}`] : []).slice(0, 16);
}

function jobRefsFromDomain(domain: ControllerJsonObject): string[] {
  const job = recordValue(domain.job);
  if (typeof job?.id === "string") return [`job:${job.id}`];
  return refIds(domain.candidates, "job");
}

type TerminalPipelineFacts = Readonly<{
  headSha: string;
  mergeSha: string;
  mergedAt: string;
  production: NonNullable<Job["policy"]>["production"];
}>;

function terminalPipelineFacts(job: Job): TerminalPipelineFacts | null {
  const production = job.policy?.production;
  if (
    !job.policy ||
    !((job.state === "merged" && production === undefined) ||
      (job.state === "complete" && production !== undefined) ||
      (job.state === "production_failed" && production !== undefined)) ||
    !job.prHeadSha || !job.mergeCommitSha || !job.mergedAt
  ) return null;
  return { headSha: job.prHeadSha, mergeSha: job.mergeCommitSha, mergedAt: job.mergedAt, production };
}

function finalTestIsVerified(store: TelegramAgentStore, job: Job, facts: TerminalPipelineFacts): boolean {
  const finalTest = store.getLatestPipelineStageAttempt(job.id, "FINAL_TEST");
  const validationReceipts = finalTest?.outcome?.commandReceipts;
  const requiredChecks = finalTest?.outcome?.requiredChecks;
  return !(
    finalTest?.state !== "completed" || finalTest.completedAt === null ||
    finalTest.startSha !== facts.headSha || finalTest.endSha !== facts.headSha ||
    finalTest.outcome?.validationOutcome !== "pass" || finalTest.outcome.headSha !== facts.headSha ||
    !Array.isArray(validationReceipts) || validationReceipts.length !== job.policy!.validationCommands.length ||
    validationReceipts.some((entry) => recordValue(entry)?.outcome !== "pass") ||
    !Array.isArray(requiredChecks) || requiredChecks.length !== job.policy!.requiredChecks.length ||
    requiredChecks.some((entry, index) => {
      const check = recordValue(entry);
      return check?.name !== job.policy!.requiredChecks[index] || check.bucket !== "pass" || check.state !== "SUCCESS";
    })
  );
}

function mergeIsVerified(store: TelegramAgentStore, job: Job, facts: TerminalPipelineFacts): boolean {
  const mergeEffects = store.listEffectsForJob(job.id).filter((effect) => effect.kind === "merge_pr");
  if (mergeEffects.length !== 1) return false;
  let mergeEvidence: ReturnType<typeof parsePersistedMergeEvidence>;
  try {
    const effect = mergeEffects[0];
    mergeEvidence = parsePersistedMergeEvidence({
      idempotencyKey: effect.idempotencyKey,
      jobId: effect.jobId,
      kind: effect.kind,
      status: effect.status,
      payload: effect.payload,
    });
  } catch {
    return false;
  }
  if (mergeEvidence.disposition !== "success") return false;
  const receipt = mergeEvidence.payload.receipt;
  return !(
    receipt.headSha !== facts.headSha ||
    mergeEvidence.result.authoritativeHeadSha !== facts.headSha ||
    mergeEvidence.result.mergeCommit.oid !== facts.mergeSha ||
    mergeEvidence.result.mergedAt !== facts.mergedAt ||
    mergeEvidenceBindingError(
      mergeEvidence,
      job,
      store.getApproval(receipt.approvalNonceHash),
      store.getAttempt(receipt.reviewAttemptId),
    ) !== null
  );
}

function successfulProductionStage(
  store: TelegramAgentStore,
  job: Job,
  input: Readonly<{ role: "DEPLOY" | "CANARY"; phase: "deploy" | "canary"; commandCount: number; mergeSha: string }>,
): boolean {
  const attempt = store.getLatestPipelineStageAttempt(job.id, input.role);
  if (attempt?.state !== "completed" || attempt.completedAt === null ||
      attempt.startSha !== input.mergeSha || attempt.endSha !== input.mergeSha) return false;
  try {
    const snapshot = parseProductionStageSnapshot(attempt.outcome, input.phase);
    return snapshot.outcome === "pass" && snapshot.commandReceipts.length === input.commandCount + 1;
  } catch {
    return false;
  }
}

function failedProductionStage(
  store: TelegramAgentStore,
  job: Job,
  input: Readonly<{ role: "DEPLOY" | "CANARY"; phase: "deploy" | "canary"; mergeSha: string }>,
): boolean {
  const attempt = store.getLatestPipelineStageAttempt(job.id, input.role);
  if (!attempt || attempt.completedAt === null || attempt.startSha !== input.mergeSha) return false;
  if (attempt.state === "failed") return true;
  if (attempt.state !== "completed" || attempt.endSha !== input.mergeSha) return false;
  try {
    return parseProductionStageSnapshot(attempt.outcome, input.phase).outcome === "fail";
  } catch {
    return false;
  }
}

export function verifiedPipelineOutcome(store: TelegramAgentStore, job: Job): boolean {
  const facts = terminalPipelineFacts(job);
  if (!facts || !finalTestIsVerified(store, job, facts) || !mergeIsVerified(store, job, facts)) return false;
  if (facts.production === undefined) return true;
  if (job.state === "complete") {
    return successfulProductionStage(store, job, {
      role: "DEPLOY", phase: "deploy", commandCount: facts.production.deployCommands.length, mergeSha: facts.mergeSha,
    }) && successfulProductionStage(store, job, {
      role: "CANARY", phase: "canary", commandCount: facts.production.canaryCommands.length, mergeSha: facts.mergeSha,
    });
  }
  return failedProductionStage(store, job, { role: "DEPLOY", phase: "deploy", mergeSha: facts.mergeSha }) ||
    failedProductionStage(store, job, { role: "CANARY", phase: "canary", mergeSha: facts.mergeSha });
}

function jobProjectionEvidence(
  dependencies: ToolDependencies,
  domain: ControllerJsonObject,
  resolution: ControllerCapabilityScopeResolution,
  mutation: "read" | "retry" | "cancel",
): ControllerCapabilityEvidenceProjection {
  const refs = jobRefsFromDomain(domain);
  const exactId = refs.length === 1 ? refs[0].slice("job:".length) : null;
  const current = exactId ? dependencies.store.getJob(exactId) : null;
  const before = trustedState(resolution).beforeJob;
  const changed = current !== null && before !== null && before !== undefined && current.version !== before.version;
  const proofKinds: ("job_state" | "pipeline_outcome" | "obligation")[] = refs.length > 0 ? ["job_state"] : [];
  if (mutation === "read" && current !== null && verifiedPipelineOutcome(dependencies.store, current)) {
    proofKinds.push("pipeline_outcome");
  }
  if (current !== null && !TERMINAL_JOB_STATES.has(current.state) && mutation !== "cancel") proofKinds.push("obligation");
  return {
    outcome: mutation !== "read" && changed ? "succeeded" : "observed",
    proofKinds,
    subjectRefs: refs,
  };
}

async function projectTrustedEvidence(
  request: Readonly<{
    dependencies: ToolDependencies;
    name: ControllerToolName;
    context: PluginAgentToolContext;
    domain: ControllerJsonObject;
    resolution: ControllerCapabilityScopeResolution;
    authorized: AuthorizedControllerCapability;
  }>,
): Promise<ControllerCapabilityEvidenceProjection> {
  const { dependencies, context, domain, resolution, authorized } = request;
  switch (request.name) {
    case "telegram_agent_list_projects":
      return { outcome: "observed", proofKinds: ["project_state"], subjectRefs: refIds(domain.projects, "project") };
    case "telegram_agent_start_job": {
      const refs = jobRefsFromDomain(domain);
      const job = refs.length === 1 ? dependencies.store.getJob(refs[0].slice(4)) : null;
      const proofKinds: ("job_state" | "obligation")[] = job ? ["job_state"] : [];
      if (job && !TERMINAL_JOB_STATES.has(job.state)) proofKinds.push("obligation");
      return {
        outcome: job && trustedState(resolution).beforeJob === null ? "succeeded" : "observed",
        proofKinds,
        subjectRefs: refs,
      };
    }
    case "telegram_agent_job_status":
      return jobProjectionEvidence(dependencies, domain, resolution, "read");
    case "telegram_agent_retry_job":
      return jobProjectionEvidence(dependencies, domain, resolution, "retry");
    case "telegram_agent_cancel_job":
      return jobProjectionEvidence(dependencies, domain, resolution, "cancel");
    case "telegram_agent_list_threads":
      return { outcome: "observed", proofKinds: ["thread_state"], subjectRefs: refIds(domain.threads, "thread") };
    case "telegram_agent_thread_status":
    case "telegram_agent_read_thread":
      return { outcome: "observed", proofKinds: ["thread_state"], subjectRefs: resolution.scope.entityRefs };
    case "telegram_agent_create_thread": {
      const thread = recordValue(domain.thread);
      const threadId = typeof thread?.id === "string" ? thread.id : null;
      const projectId = typeof thread?.projectId === "string" ? thread.projectId : null;
      if (!threadId || !projectId) return { outcome: "observed", proofKinds: [], subjectRefs: resolution.scope.entityRefs };
      const visible = await assertVisibleThreadScope({ sdk: dependencies.sdk, threadId, signal: context.signal });
      return {
        outcome: visible.id === threadId ? "succeeded" : "observed",
        proofKinds: visible.id === threadId ? ["thread_state", "external_mutation"] : [],
        subjectRefs: [`thread:${threadId}`, `project:${projectId}`],
      };
    }
    case "telegram_agent_send_to_thread": {
      const threadId = resolution.scope.entityRefs[0]?.slice("thread:".length);
      const visible = threadId
        ? await assertVisibleThreadScope({ sdk: dependencies.sdk, threadId, signal: context.signal })
        : null;
      return {
        outcome: visible?.id === threadId ? "succeeded" : "observed",
        proofKinds: visible?.id === threadId ? ["external_mutation", "thread_state"] : [],
        subjectRefs: resolution.scope.entityRefs,
      };
    }
    case "telegram_agent_request_thread_operation": {
      const operationId = typeof domain.id === "string" ? domain.id : null;
      const operation = operationId ? dependencies.store.getThreadOperation(operationId) : null;
      const succeeded = operation?.state === "awaiting_confirmation" && operation.expiresAt > dependencies.now();
      return { outcome: succeeded ? "succeeded" : "observed", proofKinds: succeeded ? ["obligation"] : [], subjectRefs: resolution.scope.entityRefs };
    }
    case "telegram_agent_remember": {
      const remembered = recordValue(domain.remembered);
      const id = typeof remembered?.id === "string" ? remembered.id : null;
      const memory = id ? dependencies.store.getMemory(id) : null;
      return { outcome: memory ? "succeeded" : "observed", proofKinds: memory ? ["memory_state"] : [], subjectRefs: memory ? [`memory:${memory.id}`] : [] };
    }
    case "telegram_agent_recall":
      return { outcome: "observed", proofKinds: ["memory_state"], subjectRefs: refIds(domain.memories, "memory") };
    case "telegram_agent_forget": {
      const forgotten = domain.forgotten === true;
      return { outcome: forgotten ? "succeeded" : "observed", proofKinds: ["memory_state"], subjectRefs: resolution.scope.entityRefs };
    }
    case "telegram_agent_watch": {
      const watching = recordValue(domain.watching);
      const id = typeof watching?.id === "string" ? watching.id : null;
      const monitor = id ? dependencies.store.getControllerMonitor(authorized.controller.controllerKey, id) : null;
      const armed = monitor?.state === "armed";
      return {
        outcome: armed ? "succeeded" : "observed",
        proofKinds: armed ? ["monitor_state", "obligation"] : [],
        subjectRefs: monitor ? [`monitor:${monitor.id}`, ...(monitor.threadId ? [`thread:${monitor.threadId}`] : [])] : [],
      };
    }
    case "telegram_agent_list_watches": {
      const refs = refIds(domain.monitors, "monitor");
      const armed = refs.some((ref) => dependencies.store.getControllerMonitor(authorized.controller.controllerKey, ref.slice(8))?.state === "armed");
      return { outcome: "observed", proofKinds: armed ? ["monitor_state", "obligation"] : ["monitor_state"], subjectRefs: refs };
    }
    case "telegram_agent_cancel_watch":
      return { outcome: domain.cancelled === true ? "succeeded" : "observed", proofKinds: ["monitor_state"], subjectRefs: resolution.scope.entityRefs };
    case "telegram_agent_health":
    case "telegram_agent_scorecard":
      return { outcome: "observed", proofKinds: ["health_snapshot"], subjectRefs: [`controller:${authorized.controller.controllerKey}`] };
    case "telegram_agent_delegate": {
      const delegationResult = recordValue(domain.delegation);
      const id = typeof delegationResult?.id === "string" ? delegationResult.id : null;
      const delegation = id ? dependencies.store.getDelegation(id) : null;
      const joined = delegation?.threads ?? [];
      const refs = delegation ? [`delegation:${delegation.id}`, ...joined.map((thread) => `thread:${thread.threadId}`)].slice(0, 16) : [];
      const succeeded = joined.length > 0;
      const proofKinds: ("thread_state" | "external_mutation" | "obligation")[] = succeeded
        ? ["thread_state", "external_mutation"] : [];
      if (delegation?.state === "open" && delegation.sealedAt !== null && joined.some((thread) => thread.state === "running")) {
        proofKinds.push("obligation");
      }
      return { outcome: succeeded ? "succeeded" : "observed", proofKinds, subjectRefs: refs };
    }
    case "telegram_agent_set_working_style": {
      const after = dependencies.store.getControllerOverlay();
      return {
        outcome: after !== trustedState(resolution).beforeOverlay ? "succeeded" : "observed",
        proofKinds: ["memory_state"],
        subjectRefs: [`controller:${authorized.controller.controllerKey}`],
      };
    }
    case "telegram_agent_turn_evidence":
    case "telegram_agent_respond":
      throw new Error("Task 7 and Task 8 capabilities are not projected by Task 6");
  }
}

export function registerControllerTools(bb: BbPluginApi, dependencies: ToolDependencies): void {
  const registerTool = <Schema extends z.ZodType>(registration: Readonly<{
    name: ControllerToolName;
    description: string;
    parameters: Schema;
    experimental_statusLabels?: { pending: string; completed: string };
    execute(params: z.output<Schema>, context: PluginAgentToolContext): unknown | Promise<unknown>;
  }>): void => {
    const descriptor = CONTROLLER_CAPABILITIES[registration.name];
    registerControllerCapabilityTool(bb, {
      store: dependencies.store,
      sdk: dependencies.sdk,
      now: dependencies.now,
      credential: descriptor.credential_scope.credential === "bb"
        ? { credential: "bb", audience: "bb-plugin-sdk" }
        : { credential: "none", audience: "none" },
    }, {
      ...registration,
      descriptor,
      resolveScope: async (params, context, authorized) => {
        const resolved = await resolveTrustedScope({
          dependencies,
          name: registration.name,
          params,
          context,
          authorized,
        });
        return { ...resolved, state: { ...trustedState(resolved), authorized } };
      },
      execute: (params, context) => registration.execute(params, context),
      projectEvidence: (_params, context, domain, resolution) => projectTrustedEvidence({
        dependencies,
        name: registration.name,
        context,
        domain,
        resolution,
        authorized: trustedState(resolution).authorized!,
      }),
    });
  };

  registerTool({
    name: CONTROLLER_TOOL_NAMES[0],
    description: "List the software projects enabled for guarded Telegram Agent jobs.",
    parameters: z.object({}).strict(),
    execute: (_params, context) => {
      authorizedController(dependencies.store, context);
      return {
        projects: dependencies.store.listEnabledProjectPolicies().map(({ policy }) => ({
          id: policy.projectId,
          alias: policy.alias,
          baseBranch: policy.baseBranch,
          implementationModel: policy.implementation.model ?? null,
          reviewModel: policy.review.model ?? null,
          productionConfigured: policy.production !== undefined,
        })),
      };
    },
  });

  registerTool({
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
      return jobProjection(job, dependencies.store.getAdmission(job.id));
    },
  });

  registerTool({
    name: CONTROLLER_TOOL_NAMES[2],
    description: "Read one exact durable job status, or return bounded job choices when no id uniquely resolves.",
    parameters: z.object({ jobId: z.string().min(1).max(256).optional() }).strict(),
    execute: (params, context) => {
      authorizedController(dependencies.store, context);
      const resolution = resolveJob(dependencies.store, "status", params.jobId);
      return resolution.outcome === "job"
        ? jobProjection(resolution.job, dependencies.store.getAdmission(resolution.job.id))
        : resolutionProjection(resolution);
    },
  });

  registerTool({
    name: CONTROLLER_TOOL_NAMES[3],
    description: "Retry a recoverable failed Telegram Agent job through its durable state machine.",
    parameters: z.object({ jobId: z.string().min(1).max(256).optional() }).strict(),
    execute: (params, context) => {
      authorizedController(dependencies.store, context);
      const resolution = resolveJob(dependencies.store, "retry", params.jobId);
      if (resolution.outcome !== "job") return resolutionProjection(resolution);
      const job = resolution.job;
      if (job.state !== "failed" || job.cancelRequestedAt !== null) {
        throw new Error("The requested job is not retryable");
      }
      const updated = dependencies.store.applyJobEvent(job.id, job.version, { type: "RETRY" }, dependencies.now());
      dependencies.notify();
      return jobProjection(updated, dependencies.store.getAdmission(updated.id));
    },
  });

  registerTool({
    name: CONTROLLER_TOOL_NAMES[4],
    description: "Request cancellation of a nonterminal Telegram Agent job. Completion remains executor-fenced.",
    parameters: z.object({ jobId: z.string().min(1).max(256).optional() }).strict(),
    execute: (params, context) => {
      authorizedController(dependencies.store, context);
      const resolution = resolveJob(dependencies.store, "cancel", params.jobId);
      if (resolution.outcome !== "job") return resolutionProjection(resolution);
      const job = resolution.job;
      if (["merged", "cancelled", "blocked", "complete", "production_failed"].includes(job.state)) {
        throw new Error("The requested job cannot be cancelled");
      }
      if (job.cancelRequestedAt !== null) return jobProjection(job, dependencies.store.getAdmission(job.id));
      const updated = dependencies.store.applyJobEvent(job.id, job.version, {
        type: "CANCEL_REQUESTED",
        activeWorker: dependencies.store.getWorkerLiveness(job.id),
      }, dependencies.now());
      dependencies.notify();
      return jobProjection(updated, dependencies.store.getAdmission(updated.id));
    },
  });

  registerTool({
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
      return await listVisibleThreads({
        sdk: dependencies.sdk,
        now: dependencies.now(),
        projectId: params.projectId,
        status: params.status,
        limit: params.limit,
        signal: context.signal,
      });
    },
  });

  registerTool({
    name: CONTROLLER_TOOL_NAMES[6],
    description: "Read the current status and truthful progress signals for one visible BB thread. BB does not provide a reliable completion ETA.",
    experimental_statusLabels: { pending: "Checking thread", completed: "Checked thread" },
    parameters: z.object({ threadId: z.string().min(1).max(256) }).strict(),
    execute: async (params, context) => {
      authorizedController(dependencies.store, context);
      return await visibleThreadStatus({
        sdk: dependencies.sdk,
        now: dependencies.now(),
        threadId: params.threadId,
        signal: context.signal,
      });
    },
  });

  registerTool({
    name: CONTROLLER_TOOL_NAMES[7],
    description: "Read what one visible BB thread is doing right now: its current step, goal, todo list, running commands, and latest message. Use this before judging whether a thread is stuck or slow.",
    experimental_statusLabels: { pending: "Reading thread", completed: "Read thread" },
    parameters: z.object({ threadId: z.string().min(1).max(256) }).strict(),
    execute: async (params, context) => {
      authorizedController(dependencies.store, context);
      return await readThreadActivity({
        sdk: dependencies.sdk,
        now: dependencies.now(),
        threadId: params.threadId,
        signal: context.signal,
      });
    },
  });

  registerTool({
    name: CONTROLLER_TOOL_NAMES[8],
    description: "Start a new BB thread in one of the owner's projects to do exploratory or read-only work. Guarded code changes that must be reviewed and merged still belong to telegram_agent_start_job.",
    experimental_statusLabels: { pending: "Starting thread", completed: "Started thread" },
    parameters: z.object({
      projectId: z.string().min(1).max(256),
      title: z.string().trim().min(1).max(120),
      prompt: z.string().trim().min(1).max(4_000),
    }).strict(),
    execute: async (params, context) => {
      authorizedController(dependencies.store, context);
      return await createProjectThread({
        sdk: dependencies.sdk,
        projectId: params.projectId,
        title: params.title,
        prompt: params.prompt,
        signal: context.signal,
      });
    },
  });

  registerTool({
    name: CONTROLLER_TOOL_NAMES[9],
    description: "Send a message to one visible BB thread and let it continue working. Use this to answer a thread's question, add context, or redirect it.",
    experimental_statusLabels: { pending: "Messaging thread", completed: "Messaged thread" },
    parameters: z.object({
      threadId: z.string().min(1).max(256),
      text: z.string().trim().min(1).max(4_000),
    }).strict(),
    execute: async (params, context) => {
      authorizedController(dependencies.store, context);
      return await sendToVisibleThread({
        sdk: dependencies.sdk,
        threadId: params.threadId,
        text: params.text,
        signal: context.signal,
      });
    },
  });

  registerTool({
    name: CONTROLLER_TOOL_NAMES[10],
    description: "Request a stop or eligible provider retry for one visible BB thread. No action runs until the paired owner accepts an expiring one-use Telegram confirmation.",
    experimental_statusLabels: { pending: "Preparing confirmation", completed: "Confirmation sent" },
    parameters: z.object({
      kind: z.enum(["stop_thread", "retry_thread"]),
      threadId: z.string().min(1).max(256),
    }).strict(),
    execute: async (params, context) => {
      authorizedController(dependencies.store, context);
      return await dependencies.threadOperations.request({ ...params, signal: context.signal });
    },
  });

  registerTool({
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
      authorizedController(dependencies.store, context);
      const memory = dependencies.store.rememberMemory({
        scope: params.projectId ?? OWNER_MEMORY_SCOPE,
        kind: params.kind,
        subject: params.subject,
        body: params.body,
        importance: params.importance,
        source: "agent",
        now: dependencies.now(),
      });
      return { remembered: { id: memory.id, subject: memory.subject, scope: memory.scope } };
    },
  });

  registerTool({
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
      return {
        memories: dependencies.store.recallMemories({
          scope: params.projectId ?? OWNER_MEMORY_SCOPE,
          query: params.query,
          limit: params.limit,
          now: dependencies.now(),
        }).map(memoryProjection),
      };
    },
  });

  registerTool({
    name: CONTROLLER_TOOL_NAMES[13],
    description: "Forget one memory by id, when the owner says it is wrong or no longer applies.",
    experimental_statusLabels: { pending: "Forgetting", completed: "Forgot" },
    parameters: z.object({ id: z.string().min(1).max(256) }).strict(),
    execute: (params, context) => {
      authorizedController(dependencies.store, context);
      return { forgotten: dependencies.store.forgetMemory({ id: params.id, now: dependencies.now() }) };
    },
  });

  registerTool({
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
      return { watching: monitorProjection(monitor) };
    },
  });

  registerTool({
    name: CONTROLLER_TOOL_NAMES[15],
    description: "List the monitors currently set, so the owner can be told what you are watching.",
    parameters: z.object({ includeFinished: z.boolean().default(false) }).strict(),
    execute: (params, context) => {
      const controller = authorizedController(dependencies.store, context);
      return {
        monitors: dependencies.store
          .listMonitors(controller.controllerKey, params.includeFinished)
          .map(monitorProjection),
      };
    },
  });

  registerTool({
    name: CONTROLLER_TOOL_NAMES[16],
    description: "Cancel one monitor by id.",
    parameters: z.object({ id: z.string().min(1).max(256) }).strict(),
    execute: (params, context) => {
      const controller = authorizedController(dependencies.store, context);
      return {
        cancelled: dependencies.store.cancelControllerMonitor(
          controller.controllerKey,
          params.id,
          dependencies.now(),
        ),
      };
    },
  });

  registerTool({
    name: CONTROLLER_TOOL_NAMES[17],
    description: "Check your own plumbing: executor, queued work, undelivered messages, Telegram intake, monitors, memory search, and database integrity. Use this when the owner says something seems stuck or slow.",
    experimental_statusLabels: { pending: "Checking health", completed: "Checked health" },
    parameters: z.object({}).strict(),
    execute: (_params, context) => {
      authorizedController(dependencies.store, context);
      return dependencies.health(dependencies.now());
    },
  });

  registerTool({
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
          return {
            outcome: "partial",
            detail: "Some tasks did not start. The ones that did are still being watched and will report together.",
            delegation: { id: delegation.id, instruction: delegation.instruction, threads: started },
            failed: { title: task.title, reason: redactError(error).slice(0, 200) },
          };
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
      return {
        outcome: started.length === params.tasks.length ? "delegated" : "partial",
        delegation: { id: delegation.id, instruction: delegation.instruction, threads: started },
      };
    },
  });

  registerTool({
    name: CONTROLLER_TOOL_NAMES[19],
    description: "Read the durable autonomy scorecard: work completed and blocked, decisions the owner was asked for, remediation cycles, delivery retries, memory health, and monitors. Every number comes from committed state, so report what it says and never a rate it does not support.",
    experimental_statusLabels: { pending: "Reading the scorecard", completed: "Read the scorecard" },
    parameters: z.object({
      windowDays: z.number().int().min(1).max(90).default(7),
    }).strict(),
    execute: (params, context) => {
      authorizedController(dependencies.store, context);
      return dependencies.store.buildAutonomyScorecard({
        now: dependencies.now(),
        windowMs: params.windowDays * 86_400_000,
      });
    },
  });

  registerTool({
    name: CONTROLLER_TOOL_NAMES[20],
    description: "Record how the owner wants you to work — terser answers, always show the PR link, a habit they keep asking for. This is standing behaviour, not a fact: it is applied to every later turn. Replace it wholesale each time; send empty text to clear it. Use telegram_agent_remember for things you need to know rather than ways you should act.",
    experimental_statusLabels: { pending: "Adjusting how you work", completed: "Adjusted how you work" },
    parameters: z.object({
      text: z.string().max(MAX_CONTROLLER_OVERLAY),
    }).strict(),
    execute: (params, context) => {
      authorizedController(dependencies.store, context);
      return {
        workingStyle: dependencies.store.setControllerOverlay({
          text: params.text,
          now: dependencies.now(),
        }),
      };
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
