import { createHash } from "node:crypto";
import type { Job, JobEffect, ReviewFinding, StoredEffect, WorkerLiveness } from "../domain/models";
import { ApprovalService } from "./approval-service";
import { buildWorkOrder } from "../bb/handoffs";
import { buildPlanArtifact } from "../bb/pipeline-handoffs";
import type { BbAttempt, EnvironmentSnapshot, PipelineThreadAttempt } from "../bb/runner";
import type { TerminalCommandRunner } from "../bb/terminal-command";
import { ValidationError, type ValidationSnapshot } from "../bb/validation";
import { persistableJobStatusPayload, renderJobStatus } from "../telegram/view";
import type {
  AttemptRecord,
  OutboxInput,
  PipelineStageAttempt,
  PipelineStageRole,
  TelegramAgentStore,
} from "../storage/store";
import { projectUnknownWorker, projectWorkerLiveness } from "./worker-liveness";

export class PermanentEffectError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PermanentEffectError";
  }
}

export type EffectFence = {
  ownerId: string;
  generation: number;
  signal: AbortSignal;
};

type BbThread = {
  id: string;
  projectId: string;
  environmentId: string | null;
  parentThreadId: string | null;
  title: string | null;
  status: string;
  updatedAt: number;
  runtime: { displayStatus: string; hostReconnectGraceExpiresAt: number | null };
};

type ThreadListResult = BbThread[] | { threads: BbThread[]; total?: number };

type BbEffectAdapter = {
  spawnPlanner?(job: Job, attempt: PipelineThreadAttempt, previousCritique?: string | null): Promise<{ id: string; environmentId?: string | null }>;
  spawnCritic?(job: Job, attempt: PipelineThreadAttempt, plan: PipelineThreadAttempt): Promise<{ id: string; environmentId?: string | null }>;
  spawnBuilderFromPlan?(job: Job, attempt: BbAttempt, plan: PipelineThreadAttempt): Promise<{ id: string; environmentId?: string | null }>;
  spawnDocs?(job: Job, attempt: PipelineThreadAttempt): Promise<{ id: string; environmentId?: string | null }>;
  spawnImplementation?(job: Job, attempt: BbAttempt): Promise<{ id: string; environmentId?: string | null }>;
  spawnReview?(job: Job, attempt: BbAttempt): Promise<{ id: string; environmentId?: string | null }>;
  spawnFinalReview?(job: Job, attempt: BbAttempt): Promise<{ id: string; environmentId?: string | null }>;
  sendRemediation?(job: Job, findings: ReviewFinding[], reasons?: string[]): Promise<void>;
  sendSteering?(threadId: string, text: string): Promise<void>;
  stopWorker?(worker: string | WorkerLiveness): Promise<void>;
  getThread?(threadId: string): Promise<BbThread>;
  getEnvironmentSnapshot?(environmentId: string, baseBranch: string): Promise<EnvironmentSnapshot>;
  getPullRequestSnapshot?(environmentId: string): Promise<unknown>;
  listThreads?(input: {
    projectId: string;
    originPluginId: string;
    includeHidden: true;
    limit: number;
    offset: number;
  }): Promise<ThreadListResult>;
  sdk?: {
    threads?: {
      list(input: {
        projectId: string;
        originPluginId: string;
        includeHidden: true;
        limit: number;
        offset: number;
      }): Promise<ThreadListResult>;
    };
  };
  threads?: {
    list(input: {
      projectId: string;
      originPluginId: string;
      includeHidden: true;
      limit: number;
      offset: number;
    }): Promise<ThreadListResult>;
  };
};

export type EffectRunnerDependencies = {
  store: TelegramAgentStore;
  fence: EffectFence;
  now: () => number;
  bb?: BbEffectAdapter;
  terminal?: TerminalCommandRunner;
  mergeHandler?: {
    executeMergeEffect(input: {
      effect: StoredEffect;
      leaseOwner: string;
      leaseGeneration: number;
    }): Promise<unknown>;
  };
  approvals?: ApprovalService;
  reconcileJob?: (job: Job, signal: AbortSignal, fence: EffectFence) => Promise<void>;
  resolvePrHead?: (job: Job, effect: StoredEffect, signal: AbortSignal) => Promise<{
    event: "PR_HEAD_RESOLVED" | "PR_HEAD_RESOLUTION_FAILED";
    headSha?: string;
    reason?: string;
  }>;
  runValidation?: (job: Job, effect: StoredEffect, signal: AbortSignal) => Promise<ValidationSnapshot>;
};

export function retryDelay(attempts: number, injectedJitter: () => number): number {
  const safeAttempts = Math.max(1, Math.floor(attempts));
  const base = Math.min(30_000, 500 * 2 ** (safeAttempts - 1));
  const jitter = Math.max(0, Math.min(250, Math.floor(injectedJitter())));
  return base + jitter;
}

function recordPayload(effect: StoredEffect): Record<string, unknown> {
  return effect.payload && typeof effect.payload === "object" ? effect.payload : {};
}

function textPayload(effect: StoredEffect, key: string): string {
  const value = recordPayload(effect)[key];
  if (typeof value !== "string" || value.length === 0) throw new PermanentEffectError(`${key} is required`);
  return value;
}

function fullSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function expectedStates(kind: JobEffect["kind"]): readonly string[] {
  switch (kind) {
    case "render_status": return [];
    case "spawn_plan": return ["planning"];
    case "spawn_critique": return ["critiquing"];
    case "spawn_implementation": return ["creating_implementation"];
    case "inspect_implementation": return ["implementing", "locating_pr"];
    case "resolve_pr_head": return ["resolving_pr_head", "resolving_docs_head"];
    case "spawn_review": return ["reviewing"];
    case "send_remediation": return ["remediating"];
    case "run_validation": return ["validating"];
    case "spawn_docs": return ["documenting"];
    case "run_final_validation": return ["final_validating"];
    case "spawn_final_review": return ["final_reviewing"];
    case "issue_approval": return ["awaiting_merge_approval"];
    case "revoke_approvals": return [];
    case "merge_pr": return ["merging"];
    case "stop_thread": return [];
    case "steer_implementation": return ["implementing", "remediating"];
    case "reconcile_job": return [];
    default: {
      const unreachable: never = kind;
      return [unreachable];
    }
  }
}

const KNOWN_EFFECT_KINDS = new Set<string>([
  "render_status",
  "spawn_plan",
  "spawn_critique",
  "spawn_implementation",
  "inspect_implementation",
  "resolve_pr_head",
  "spawn_review",
  "send_remediation",
  "run_validation",
  "spawn_docs",
  "run_final_validation",
  "spawn_final_review",
  "issue_approval",
  "revoke_approvals",
  "merge_pr",
  "stop_thread",
  "steer_implementation",
  "reconcile_job",
]);

function attemptFor(effect: StoredEffect, job: Job, kind: AttemptRecord["kind"]): {
  id: string;
  ordinal: number;
  headSha: string | null;
} {
  const payload = recordPayload(effect);
  const suppliedId = payload.attemptId;
  const id = typeof suppliedId === "string" && suppliedId.length > 0
    ? suppliedId
    : `attempt:${effect.idempotencyKey}`;
  const ordinal = kind === "review" ? Math.max(1, job.reviewCycle + 1) : 1;
  const headSha = fullSha(payload.headSha) ? payload.headSha : job.prHeadSha;
  return { id, ordinal, headSha };
}

function threadResultId(result: { id?: unknown }): string {
  if (typeof result.id !== "string" || result.id.length === 0) {
    throw new PermanentEffectError("BB thread creation did not return a thread id");
  }
  return result.id;
}

function threadResultEnvironment(result: { environmentId?: unknown }): string {
  if (typeof result.environmentId !== "string" || result.environmentId.length === 0) {
    throw new PermanentEffectError("BB thread creation did not return an environment id");
  }
  return result.environmentId;
}

function listThreadsAdapter(bb: BbEffectAdapter): BbEffectAdapter["listThreads"] | undefined {
  if (bb.listThreads) return bb.listThreads.bind(bb);
  if (bb.threads?.list) return bb.threads.list.bind(bb.threads);
  if (bb.sdk?.threads?.list) return bb.sdk.threads.list.bind(bb.sdk.threads);
  return undefined;
}

function stageInputSha(...shaValues: string[]): string {
  const hash = createHash("sha256");
  for (const value of shaValues) hash.update(value, "utf8").update("\0", "utf8");
  return hash.digest("hex");
}

function validationStageEvidence(result: ValidationSnapshot): Record<string, unknown> {
  return {
    validationOutcome: result.validationOutcome,
    headSha: result.headSha,
    originRepository: result.originRepository,
    terminalIds: (result.terminalIds ?? []).slice(0, 100),
    commandReceipts: result.commandReceipts.slice(0, 50).map((receipt) => ({
      command: receipt.command.slice(0, 500),
      outcome: receipt.outcome,
      exitCode: receipt.exitCode,
      output: receipt.output.slice(0, 1_000),
    })),
    requiredChecks: result.requiredChecks.slice(0, 50).map((check) => ({
      name: check.name.slice(0, 200),
      bucket: check.bucket.slice(0, 80),
      state: check.state.slice(0, 80),
      link: check.link?.slice(0, 500) ?? null,
    })),
    completedAt: result.completedAt,
  };
}

function pipelineAttemptForRunner(attempt: PipelineStageAttempt): PipelineThreadAttempt {
  if (attempt.role !== "PLAN" && attempt.role !== "CRITIQUE" && attempt.role !== "DOCS") {
    throw new PermanentEffectError("pipeline thread attempt role is not model-backed");
  }
  return {
    id: attempt.id,
    role: attempt.role,
    ordinal: attempt.ordinal,
    threadId: attempt.threadId,
    environmentId: attempt.environmentId,
    outputText: attempt.outputText,
  };
}

export class EffectRunner {
  public constructor(private readonly dependencies: EffectRunnerDependencies) {}

  private now(): number {
    const now = this.dependencies.now();
    if (!Number.isInteger(now) || now < 0) throw new TypeError("effect clock must be a non-negative integer");
    return now;
  }

  private assertFence(): void {
    const { fence, store } = this.dependencies;
    if (fence.signal.aborted || !store.isExecutorLeaseCurrent(fence.ownerId, fence.generation, this.now())) {
      throw new Error("executor lease was lost");
    }
  }

  private currentEffect(input: StoredEffect): StoredEffect {
    const current = this.dependencies.store.getEffect(input.jobId, input.idempotencyKey);
    if (!current) throw new PermanentEffectError("effect disappeared before execution");
    if (current.jobId !== input.jobId || current.idempotencyKey !== input.idempotencyKey) {
      throw new PermanentEffectError("effect identity changed before execution");
    }
    if (current.status === "done" || current.status === "dead" || current.status === "failed") return current;
    if (current.status === "leased" && (
      current.leaseOwner !== this.dependencies.fence.ownerId ||
      current.leaseGeneration !== this.dependencies.fence.generation
    )) throw new Error("effect lease was lost");
    return current;
  }

  private currentJob(effect: StoredEffect): Job {
    const job = this.dependencies.store.getJob(effect.jobId);
    if (!job) throw new PermanentEffectError("effect job does not exist");
    const states = expectedStates(effect.kind);
    if (states.length > 0 && !states.includes(job.state)) return job;
    return job;
  }

  private async adoptOrSpawn(
    effect: StoredEffect,
    job: Job,
    kind: "implementation" | "review",
    finalReview = false,
  ): Promise<{ threadId: string; environmentId: string }> {
    const bb = this.dependencies.bb;
    if (!bb) throw new PermanentEffectError("BB runner is not configured");
    const attemptInput = attemptFor(effect, job, kind);
    const existingAttempt = this.dependencies.store.getAttempt(attemptInput.id);
    const attempt = this.dependencies.store.createAttempt({
      id: attemptInput.id,
      jobId: job.id,
      kind,
      ordinal: existingAttempt?.ordinal ?? (
        kind === "review"
          ? this.dependencies.store.nextAttemptOrdinal(job.id, kind)
          : attemptInput.ordinal
      ),
      headSha: attemptInput.headSha,
      now: this.now(),
    });
    const titleRole = finalReview ? "final-review" : kind;
    const expectedTitle = `Telegram ${job.id} ${titleRole} ${attempt.id}`;
    const list = listThreadsAdapter(bb);
    if (list && job.projectId) {
      const candidates: BbThread[] = [];
      for (let offset = 0; offset < 1_000; offset += 100) {
        this.assertFence();
        const page = await list({
          projectId: job.projectId,
          originPluginId: "telegram-agent",
          includeHidden: true,
          limit: 100,
          offset,
        });
        const threads = Array.isArray(page) ? page : page.threads;
        candidates.push(...threads.filter((thread) => thread.title === expectedTitle));
        if (threads.length < 100) break;
      }
      if (candidates.length > 1) throw new PermanentEffectError("multiple matching BB threads indicate split-brain execution");
      if (candidates.length === 1) {
        const candidate = candidates[0];
        const expectedParent = kind === "review" ? job.implementationThreadId : null;
        if (
          candidate.projectId !== job.projectId ||
          candidate.environmentId !== job.environmentId && kind === "review" ||
          candidate.parentThreadId !== expectedParent
        ) throw new PermanentEffectError("matching BB thread has a structurally mismatched owner");
        const environmentId = candidate.environmentId ?? job.environmentId;
        if (!environmentId) throw new PermanentEffectError("matching BB thread has no environment id");
        this.dependencies.store.updateAttempt(attempt.id, { threadId: candidate.id });
        return { threadId: candidate.id, environmentId };
      }
    }
    const plan = kind === "implementation"
      ? this.dependencies.store.getLatestPipelineStageAttempt(job.id, "PLAN")
      : null;
    const spawn = kind === "implementation" && plan?.state === "completed" && bb.spawnBuilderFromPlan
      ? (candidateJob: Job, candidateAttempt: BbAttempt) => bb.spawnBuilderFromPlan!(
          candidateJob,
          candidateAttempt,
          pipelineAttemptForRunner(plan),
        )
      : kind === "implementation" ? bb.spawnImplementation : finalReview ? bb.spawnFinalReview : bb.spawnReview;
    if (!spawn) throw new PermanentEffectError(`BB ${kind} runner is not configured`);
    this.assertFence();
    const created = await spawn(job, attempt);
    this.assertFence();
    const threadId = threadResultId(created);
    const environmentId = threadResultEnvironment(created);
    this.dependencies.store.updateAttempt(attempt.id, {
      threadId,
      handoffPath: attempt.handoffPath ?? null,
      handoffSha256: attempt.handoffSha256 ?? null,
    });
    return { threadId, environmentId };
  }

  private async findPipelineStageCandidate(
    bb: BbEffectAdapter,
    job: Job,
    attempt: PipelineStageAttempt,
  ): Promise<{ threadId: string; environmentId: string } | null> {
    const list = listThreadsAdapter(bb);
    if (!list || !job.projectId) return null;
    const roleLabel = attempt.role === "PLAN" ? "plan" : attempt.role === "CRITIQUE" ? "critique" : "docs";
    const expectedTitle = `Telegram ${job.id} ${roleLabel} ${attempt.id}`;
    const candidates: BbThread[] = [];
    for (let offset = 0; offset < 1_000; offset += 100) {
      this.assertFence();
      const page = await list({
        projectId: job.projectId,
        originPluginId: "telegram-agent",
        includeHidden: true,
        limit: 100,
        offset,
      });
      const threads = Array.isArray(page) ? page : page.threads;
      candidates.push(...threads.filter((thread) => thread.title === expectedTitle));
      if (threads.length < 100) break;
    }
    if (candidates.length > 1) throw new PermanentEffectError("multiple matching pipeline threads indicate split-brain execution");
    const candidate = candidates[0];
    if (!candidate) return null;
    if (candidate.projectId !== job.projectId) throw new PermanentEffectError("pipeline thread project ownership is invalid");
    if (attempt.role === "CRITIQUE") {
      const plan = this.dependencies.store.getLatestPipelineStageAttempt(job.id, "PLAN");
      if (!plan?.threadId || candidate.parentThreadId !== plan.threadId) {
        throw new PermanentEffectError("critique thread parent ownership is invalid");
      }
    } else if (attempt.role === "DOCS") {
      if (!job.implementationThreadId || candidate.parentThreadId !== job.implementationThreadId) {
        throw new PermanentEffectError("docs thread parent ownership is invalid");
      }
    } else if (candidate.parentThreadId !== null) {
      throw new PermanentEffectError("planner thread parent ownership is invalid");
    }
    const environmentId = candidate.environmentId ?? job.environmentId;
    if (!environmentId) throw new PermanentEffectError("pipeline thread has no environment id");
    if (job.environmentId && environmentId !== job.environmentId) {
      throw new PermanentEffectError("pipeline thread environment ownership is invalid");
    }
    return { threadId: candidate.id, environmentId };
  }

  private createPipelineAttempt(
    effect: StoredEffect,
    job: Job,
    role: PipelineStageRole,
    inputSha256: string,
  ): PipelineStageAttempt {
    const id = `stage:${effect.idempotencyKey}`;
    const existing = this.dependencies.store.getPipelineStageAttempt(id);
    return this.dependencies.store.createPipelineStageAttempt({
      id,
      jobId: job.id,
      role,
      ordinal: existing?.ordinal ?? this.dependencies.store.nextPipelineStageOrdinal(job.id, role),
      inputSha256,
      ownerId: this.dependencies.fence.ownerId,
      generation: this.dependencies.fence.generation,
      now: this.now(),
    });
  }

  private bindPipelineAttempt(attempt: PipelineStageAttempt, threadId: string, environmentId: string): void {
    const bound = this.dependencies.store.bindPipelineStageThread({
      id: attempt.id,
      threadId,
      environmentId,
      ownerId: this.dependencies.fence.ownerId,
      generation: this.dependencies.fence.generation,
      now: this.now(),
    });
    if (!bound) throw new Error("pipeline stage binding lost its executor fence");
  }

  private async spawnPlan(effect: StoredEffect, job: Job): Promise<void> {
    const bb = this.dependencies.bb;
    if (!bb?.spawnPlanner || !job.policy) throw new PermanentEffectError("BB planner runner is not configured");
    const previousCritique = this.dependencies.store.getLatestPipelineStageAttempt(job.id, "CRITIQUE");
    const workOrder = buildWorkOrder(job, job.policy);
    const inputSha256 = previousCritique?.outputSha256
      ? stageInputSha(workOrder.sha256, previousCritique.outputSha256)
      : stageInputSha(workOrder.sha256);
    const attempt = this.createPipelineAttempt(effect, job, "PLAN", inputSha256);
    let created = attempt.threadId && attempt.environmentId
      ? { threadId: attempt.threadId, environmentId: attempt.environmentId }
      : await this.findPipelineStageCandidate(bb, job, attempt);
    if (!created) {
      this.assertFence();
      const result = await bb.spawnPlanner(job, pipelineAttemptForRunner(attempt), previousCritique?.outputText);
      this.assertFence();
      created = { threadId: threadResultId(result), environmentId: threadResultEnvironment(result) };
    }
    this.bindPipelineAttempt(attempt, created.threadId, created.environmentId);
    this.assertFence();
    const current = this.dependencies.store.getJob(job.id);
    if (current?.state === "planning" && current.environmentId === null) {
      this.dependencies.store.applyJobEvent(job.id, current.version, {
        type: "PLAN_CREATED",
        attemptId: attempt.id,
        threadId: created.threadId,
        environmentId: created.environmentId,
      }, this.now());
    }
  }

  private async spawnCritique(effect: StoredEffect, job: Job): Promise<void> {
    const bb = this.dependencies.bb;
    if (!bb?.spawnCritic || !job.policy) throw new PermanentEffectError("BB critique runner is not configured");
    const planAttemptId = textPayload(effect, "planAttemptId");
    const plan = this.dependencies.store.getPipelineStageAttempt(planAttemptId);
    if (!plan || plan.state !== "completed" || !plan.outputText || !plan.outputSha256 || !plan.threadId || !plan.environmentId) {
      throw new PermanentEffectError("Critique requires a completed durable plan artifact");
    }
    if (plan.jobId !== job.id || plan.role !== "PLAN") {
      throw new PermanentEffectError("Critique plan artifact does not belong to the active job");
    }
    const workOrder = buildWorkOrder(job, job.policy);
    const planArtifact = buildPlanArtifact(plan.outputText);
    if (planArtifact.sha256 !== plan.outputSha256) throw new PermanentEffectError("Durable plan artifact hash does not match its output");
    const attempt = this.createPipelineAttempt(
      effect,
      job,
      "CRITIQUE",
      stageInputSha(workOrder.sha256, plan.outputSha256),
    );
    let created = attempt.threadId && attempt.environmentId
      ? { threadId: attempt.threadId, environmentId: attempt.environmentId }
      : await this.findPipelineStageCandidate(bb, job, attempt);
    if (!created) {
      this.assertFence();
      const result = await bb.spawnCritic(job, pipelineAttemptForRunner(attempt), pipelineAttemptForRunner(plan));
      this.assertFence();
      created = { threadId: threadResultId(result), environmentId: threadResultEnvironment(result) };
    }
    if (created.environmentId !== plan.environmentId) {
      throw new PermanentEffectError("Critique did not reuse the planning environment");
    }
    this.bindPipelineAttempt(attempt, created.threadId, created.environmentId);
  }

  private async spawnDocs(effect: StoredEffect, job: Job): Promise<void> {
    const bb = this.dependencies.bb;
    if (!bb?.spawnDocs || !job.policy || !job.prHeadSha || !job.environmentId) {
      throw new PermanentEffectError("BB docs runner requires reviewed job context");
    }
    const workOrder = buildWorkOrder(job, job.policy);
    const attempt = this.createPipelineAttempt(
      effect,
      job,
      "DOCS",
      stageInputSha(workOrder.sha256, job.prHeadSha),
    );
    let created = attempt.threadId && attempt.environmentId
      ? { threadId: attempt.threadId, environmentId: attempt.environmentId }
      : await this.findPipelineStageCandidate(bb, job, attempt);
    if (!created) {
      this.assertFence();
      const result = await bb.spawnDocs(job, pipelineAttemptForRunner(attempt));
      this.assertFence();
      created = { threadId: threadResultId(result), environmentId: threadResultEnvironment(result) };
    }
    if (created.environmentId !== job.environmentId) {
      throw new PermanentEffectError("Docs did not reuse the implementation environment");
    }
    this.bindPipelineAttempt(attempt, created.threadId, created.environmentId);
    this.assertFence();
    const current = this.dependencies.store.getJob(job.id);
    if (current?.state === "documenting" && current.documentationThreadId === null) {
      this.dependencies.store.applyJobEvent(job.id, current.version, {
        type: "DOCS_CREATED",
        attemptId: attempt.id,
        threadId: created.threadId,
        environmentId: created.environmentId,
      }, this.now());
    }
  }

  private async spawnImplementation(effect: StoredEffect, job: Job): Promise<void> {
    if (job.state !== "creating_implementation") return;
    const created = await this.adoptOrSpawn(effect, job, "implementation");
    this.assertFence();
    const current = this.dependencies.store.getJob(job.id);
    if (!current || current.state !== "creating_implementation") return;
    this.dependencies.store.applyJobEvent(
      job.id,
      current.version,
      { type: "IMPLEMENTATION_CREATED", threadId: created.threadId, environmentId: created.environmentId },
      this.now(),
    );
  }

  private async spawnReview(effect: StoredEffect, job: Job): Promise<void> {
    if (job.state !== "reviewing") return;
    const created = await this.adoptOrSpawn(effect, job, "review");
    this.assertFence();
    const current = this.dependencies.store.getJob(job.id);
    if (!current || current.state !== "reviewing") return;
    const started = this.dependencies.store.applyJobEvent(job.id, current.version, { type: "REVIEW_STARTED" }, this.now());
    this.dependencies.store.registerReviewThread(job.id, started.version, created.threadId, this.now());
  }

  private async spawnFinalReview(effect: StoredEffect, job: Job): Promise<void> {
    if (job.state !== "final_reviewing") return;
    const created = await this.adoptOrSpawn(effect, job, "review", true);
    this.assertFence();
    const current = this.dependencies.store.getJob(job.id);
    if (!current || current.state !== "final_reviewing") return;
    const started = this.dependencies.store.applyJobEvent(job.id, current.version, { type: "REVIEW_STARTED" }, this.now());
    this.dependencies.store.registerReviewThread(job.id, started.version, created.threadId, this.now());
  }

  private enqueueStatus(job: Job, extra: Record<string, unknown> = {}): void {
    const owner = this.dependencies.store.getOwner();
    if (!owner) return;
    const payload = renderJobStatus(job, {
      ...extra,
      workerLiveness: this.dependencies.store.getWorkerLiveness(job.id),
      now: this.now(),
    });
    const outbox: OutboxInput = {
      logicalKey: `job:${job.id}:status`,
      chatId: owner.chatId,
      messageId: job.statusMessageId,
      payload: persistableJobStatusPayload(payload),
    };
    this.dependencies.store.enqueueOutbox(outbox, this.now());
  }

  private async inspectImplementation(job: Job): Promise<void> {
    const bb = this.dependencies.bb;
    if (!bb?.getEnvironmentSnapshot || !bb.getPullRequestSnapshot || !job.environmentId || !job.policy) {
      throw new PermanentEffectError("implementation inspection requires BB environment and policy context");
    }
    const snapshot = await bb.getEnvironmentSnapshot(job.environmentId, job.policy.baseBranch);
    this.assertFence();
    const pullRequest = await bb.getPullRequestSnapshot(job.environmentId) as {
      outcome?: string;
      pullRequest?: { number?: number; url?: string };
    };
    const current = this.dependencies.store.getJob(job.id);
    if (!current || current.state !== job.state) return;
    const pullRequestNumber = pullRequest.pullRequest?.number;
    const pullRequestUrl = pullRequest.pullRequest?.url;
    if (pullRequest.outcome === "available" && Number.isInteger(pullRequestNumber) && typeof pullRequestUrl === "string") {
      this.dependencies.store.applyJobEvent(job.id, current.version, {
        type: "PR_LOCATED",
        number: pullRequestNumber as number,
        url: pullRequestUrl,
      }, this.now());
      return;
    }
    if (snapshot.status && typeof snapshot.status === "object" && "outcome" in snapshot.status && snapshot.status.outcome === "unavailable") {
      this.dependencies.store.applyJobEvent(job.id, current.version, { type: "PR_UNAVAILABLE", reason: "BB environment observation is unavailable" }, this.now());
      return;
    }
    this.dependencies.store.applyJobEvent(job.id, current.version, { type: "PR_MISSING", reason: "No pull request was found for the implementation" }, this.now());
  }

  private async resolvePrHead(effect: StoredEffect, job: Job): Promise<void> {
    if (!this.dependencies.resolvePrHead) throw new PermanentEffectError("PR head resolver is not configured");
    const result = await this.dependencies.resolvePrHead(job, effect, this.dependencies.fence.signal);
    this.assertFence();
    const current = this.dependencies.store.getJob(job.id);
    if (!current || (current.state !== "resolving_pr_head" && current.state !== "resolving_docs_head")) return;
    if (result.event === "PR_HEAD_RESOLVED" && fullSha(result.headSha)) {
      this.dependencies.store.applyJobEvent(job.id, current.version, { type: "PR_HEAD_RESOLVED", headSha: result.headSha }, this.now());
    } else {
      this.dependencies.store.applyJobEvent(job.id, current.version, { type: "PR_UNAVAILABLE", reason: result.reason ?? "PR head could not be resolved" }, this.now());
    }
  }

  private async sendRemediation(effect: StoredEffect, job: Job): Promise<void> {
    const findings = Array.isArray(recordPayload(effect).findings)
      ? recordPayload(effect).findings as ReviewFinding[]
      : [];
    const reasons = Array.isArray(recordPayload(effect).reasons)
      ? (recordPayload(effect).reasons as unknown[]).filter((reason): reason is string => typeof reason === "string").slice(0, 20)
      : [];
    if (this.dependencies.bb?.sendRemediation) await this.dependencies.bb.sendRemediation(job, findings, reasons);
    else if (this.dependencies.bb?.sendSteering && job.implementationThreadId) {
      await this.dependencies.bb.sendSteering(job.implementationThreadId, textPayload(effect, "summary"));
    } else throw new PermanentEffectError("remediation runner is not configured");
    this.assertFence();
    const current = this.dependencies.store.getJob(job.id);
    if (current?.state === "remediating") this.dependencies.store.applyJobEvent(job.id, current.version, { type: "REMEDIATION_SENT" }, this.now());
  }

  private async runValidation(effect: StoredEffect, job: Job, final = false): Promise<void> {
    if (!this.dependencies.runValidation) throw new PermanentEffectError("validation runner is not configured");
    if (!job.policy || !job.prHeadSha || !job.environmentId) {
      throw new PermanentEffectError("validation requires immutable policy, environment, and head context");
    }
    const role = final ? "FINAL_TEST" as const : "TEST" as const;
    const workOrder = buildWorkOrder(job, job.policy);
    const attempt = this.createPipelineAttempt(
      effect,
      job,
      role,
      stageInputSha(
        workOrder.sha256,
        job.prHeadSha,
        JSON.stringify(job.policy.validationCommands),
        JSON.stringify(job.policy.requiredChecks),
      ),
    );
    if (attempt.state === "completed") {
      const outcome = attempt.outcome;
      const headSha = outcome?.headSha;
      const validationOutcome = outcome?.validationOutcome;
      if (!fullSha(headSha) || (validationOutcome !== "pass" && validationOutcome !== "fail")) {
        throw new PermanentEffectError("completed validation stage has invalid durable evidence");
      }
      const current = this.dependencies.store.getJob(job.id);
      if (!current || current.state !== (final ? "final_validating" : "validating")) return;
      this.dependencies.store.applyJobEvent(job.id, current.version, validationOutcome === "pass"
        ? { type: "VALIDATION_PASSED", headSha }
        : { type: "VALIDATION_FAILED", headSha, reason: "Validation did not pass" }, this.now());
      return;
    }
    let result: ValidationSnapshot;
    try {
      result = await this.dependencies.runValidation(job, effect, this.dependencies.fence.signal);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      this.assertFence();
      this.dependencies.store.failPipelineStageAttempt({
        id: attempt.id,
        error: "Validation infrastructure failed",
        ownerId: this.dependencies.fence.ownerId,
        generation: this.dependencies.fence.generation,
        now: this.now(),
      });
      const current = this.dependencies.store.getJob(job.id);
      if (current?.state === (final ? "final_validating" : "validating")) {
        this.dependencies.store.applyJobEvent(job.id, current.version, {
          type: "FAILED",
          error: "Validation infrastructure failed",
        }, this.now());
      }
      return;
    }
    this.assertFence();
    const terminalId = result.terminalIds?.at(-1);
    if (terminalId) {
      const bound = this.dependencies.store.bindPipelineStageResource({
        id: attempt.id,
        resourceKind: "bb_terminal",
        resourceId: terminalId,
        environmentId: job.environmentId,
        ownerId: this.dependencies.fence.ownerId,
        generation: this.dependencies.fence.generation,
        now: this.now(),
      });
      if (!bound) throw new Error("validation stage resource binding lost its executor fence");
    }
    const evidence = validationStageEvidence(result);
    const outputText = JSON.stringify(evidence);
    const outputSha256 = createHash("sha256").update(outputText, "utf8").digest("hex");
    const completed = this.dependencies.store.completePipelineStageAttempt({
      id: attempt.id,
      outputText,
      outputSha256,
      outcome: evidence,
      startSha: job.prHeadSha,
      endSha: fullSha(result.headSha) ? result.headSha : null,
      ownerId: this.dependencies.fence.ownerId,
      generation: this.dependencies.fence.generation,
      now: this.now(),
    });
    if (!completed) throw new Error("validation stage completion lost its executor fence");
    this.assertFence();
    const current = this.dependencies.store.getJob(job.id);
    if (!current || current.state !== (final ? "final_validating" : "validating")) return;
    if (result.validationOutcome === "pass" && fullSha(result.headSha)) {
      this.dependencies.store.applyJobEvent(job.id, current.version, { type: "VALIDATION_PASSED", headSha: result.headSha }, this.now());
    } else {
      this.dependencies.store.applyJobEvent(job.id, current.version, {
        type: "VALIDATION_FAILED",
        headSha: fullSha(result.headSha) ? result.headSha : undefined,
        reason: "Validation did not pass",
      }, this.now());
    }
  }

  private issueApproval(job: Job): void {
    if (!job.prHeadSha) throw new PermanentEffectError("approval requires an authoritative pull-request head");
    const approvals = this.dependencies.approvals ?? new ApprovalService(this.dependencies.store, { now: this.dependencies.now });
    const issued = approvals.issue(job.id, job.prHeadSha, this.now());
    this.enqueueStatus(job, {
      mergeNonce: issued.nonce,
      approvalExpiresAt: issued.expiresAt,
    });
  }

  private async stopThread(effect: StoredEffect, job: Job): Promise<void> {
    const bb = this.dependencies.bb;
    const payload = recordPayload(effect);
    const resourceId = typeof payload.resourceId === "string" ? payload.resourceId : this.dependencies.store.getWorkerLiveness(job.id)?.resourceId;
    if (!bb?.stopWorker || !resourceId) throw new PermanentEffectError("cancellation has no BB worker resource");
    const worker = this.dependencies.store.getWorkerLiveness(job.id);
    if (!worker || worker.resourceId !== resourceId || worker.state === "unknown" || worker.state === "stale") {
      throw new PermanentEffectError("cancellation requires fresh BB worker evidence");
    }
    await bb.stopWorker(worker);
    this.assertFence();
    const maxChecks = 4;
    for (let check = 0; check < maxChecks; check += 1) {
      this.assertFence();
      const current = this.dependencies.store.getJob(job.id);
      if (!current || current.cancelRequestedAt === null) return;
      if (!bb.getThread) break;
      try {
        const thread = await bb.getThread(resourceId);
        this.assertFence();
        const latest = this.dependencies.store.getJob(job.id);
        if (!latest || latest.cancelRequestedAt === null) return;
        const projected = projectWorkerLiveness(
          this.dependencies.store,
          latest,
          thread,
          this.now(),
          worker.workerKind,
          worker.generation,
        );
        if (projected.state === "idle" || projected.state === "failed") {
          this.assertFence();
          const confirmed = this.dependencies.store.getJob(job.id);
          if (confirmed && confirmed.cancelRequestedAt !== null && confirmed.state !== "blocked") {
            this.dependencies.store.applyJobEvent(confirmed.id, confirmed.version, { type: "CANCEL_CONFIRMED" }, this.now());
          }
          return;
        }
      } catch {
        this.assertFence();
      }
      if (check + 1 < maxChecks) {
        await new Promise<void>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout>;
          const cleanup = () => {
            clearTimeout(timer);
            this.dependencies.fence.signal.removeEventListener("abort", onAbort);
          };
          const onAbort = () => {
            cleanup();
            reject(this.dependencies.fence.signal.reason ?? new Error("executor stopped"));
          };
          timer = setTimeout(() => {
            cleanup();
            resolve();
          }, 250);
          this.dependencies.fence.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    }
    this.assertFence();
    const unresolved = this.dependencies.store.getJob(job.id);
    if (unresolved && unresolved.cancelRequestedAt !== null && unresolved.state !== "blocked" && unresolved.state !== "cancelled") {
      this.dependencies.store.applyJobEvent(unresolved.id, unresolved.version, {
        type: "CANCELLATION_UNCONFIRMED",
        reason: "Cancellation could not be confirmed while the BB worker remained active or stopping",
      }, this.now());
    }
  }

  private async reconcile(job: Job): Promise<void> {
    if (this.dependencies.reconcileJob) {
      await this.dependencies.reconcileJob(job, this.dependencies.fence.signal, this.dependencies.fence);
      return;
    }
    const bb = this.dependencies.bb;
    const resources = [job.implementationThreadId, job.reviewThreadId].filter((id): id is string => id !== null);
    if (!bb?.getThread) return;
    for (const resourceId of resources) {
      this.assertFence();
      const current = this.dependencies.store.getJob(job.id) ?? job;
      try {
        const thread = await bb.getThread(resourceId);
        this.assertFence();
        const latest = this.dependencies.store.getJob(job.id) ?? current;
        const worker = this.dependencies.store.getWorkerLiveness(job.id);
        projectWorkerLiveness(
          this.dependencies.store,
          latest,
          thread,
          this.now(),
          worker?.resourceId === resourceId ? worker.workerKind : undefined,
          worker?.resourceId === resourceId ? worker.generation : undefined,
        );
      } catch {
        this.assertFence();
        const latest = this.dependencies.store.getJob(job.id) ?? current;
        const worker = this.dependencies.store.getWorkerLiveness(job.id);
        projectUnknownWorker(
          this.dependencies.store,
          latest,
          resourceId,
          this.now(),
          worker?.resourceId === resourceId ? worker.workerKind : undefined,
          worker?.resourceId === resourceId ? worker.generation : undefined,
        );
      }
    }
  }

  public async run(input: StoredEffect): Promise<void> {
    this.assertFence();
    const effect = this.currentEffect(input);
    if (!KNOWN_EFFECT_KINDS.has(String(effect.kind))) {
      throw new PermanentEffectError(`Unknown effect kind: ${String(effect.kind)}`);
    }
    if (["done", "failed", "dead"].includes(effect.status)) return;
    const job = this.currentJob(effect);
    const expected = expectedStates(effect.kind);
    if (expected.length > 0 && !expected.includes(job.state)) return;
    switch (effect.kind) {
      case "render_status":
        this.enqueueStatus(job);
        return;
      case "spawn_plan":
        await this.spawnPlan(effect, job);
        return;
      case "spawn_critique":
        await this.spawnCritique(effect, job);
        return;
      case "spawn_implementation":
        await this.spawnImplementation(effect, job);
        return;
      case "inspect_implementation":
        await this.inspectImplementation(job);
        return;
      case "resolve_pr_head":
        await this.resolvePrHead(effect, job);
        return;
      case "spawn_review":
        await this.spawnReview(effect, job);
        return;
      case "send_remediation":
        await this.sendRemediation(effect, job);
        return;
      case "run_validation":
        await this.runValidation(effect, job);
        return;
      case "spawn_docs":
        await this.spawnDocs(effect, job);
        return;
      case "run_final_validation":
        await this.runValidation(effect, job, true);
        return;
      case "spawn_final_review":
        await this.spawnFinalReview(effect, job);
        return;
      case "issue_approval":
        this.issueApproval(job);
        return;
      case "revoke_approvals":
        this.dependencies.store.revokeApprovals(job.id, "Approval revoked by job reconciliation", this.now());
        return;
      case "merge_pr":
        if (!this.dependencies.mergeHandler) throw new PermanentEffectError("merge handler is not configured");
        await this.dependencies.mergeHandler.executeMergeEffect({
          effect,
          leaseOwner: this.dependencies.fence.ownerId,
          leaseGeneration: this.dependencies.fence.generation,
        });
        return;
      case "stop_thread":
        await this.stopThread(effect, job);
        return;
      case "steer_implementation": {
        const threadId = textPayload(effect, "threadId");
        const text = textPayload(effect, "text");
        if (!this.dependencies.bb?.sendSteering) throw new PermanentEffectError("steering runner is not configured");
        await this.dependencies.bb.sendSteering(threadId, text);
        return;
      }
      case "reconcile_job":
        await this.reconcile(job);
        return;
      default: {
        const unreachable: never = effect.kind;
        throw new PermanentEffectError(`Unknown effect kind: ${String(unreachable)}`);
      }
    }
  }
}
