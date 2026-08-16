import { createHash } from "node:crypto";
import { buildWorkerThreadTitle, type WorkerSkillRole } from "../agent-skills/role-resolver";
import {
  CAPABILITY_BY_ID,
  CAPABILITY_GRAPH_DIGEST,
  CAPABILITY_REGISTRY_DIGEST,
} from "../capabilities/catalog";
import {
  capabilityProfileDigest,
  selectCapabilityProfile,
  type WorkerProfileStage,
} from "../capabilities/profiles";
import { changedPathsFromGitDiff } from "../capabilities/change-surface";
import {
  DEFAULT_MODEL_POOL_REGISTRY,
  recordModelFailure,
  selectModelRoute,
  type ModelPool,
  type ModelRoute,
} from "../capabilities/models";
import {
  nativeAdapterEnvelopeWithOutcome,
  prepareNativeAdapterTransition,
  type NativeAdapterTransition,
  type NativeAdapterTransitionEnvelope,
} from "../capabilities/native-adapters";
import { isSmallFixJob, type Job, type JobEffect, type JobEvent, type ProjectPolicy, type ReviewFinding, type StoredEffect, type WorkerLiveness } from "../domain/models";
import type { PipelineStage } from "../domain/stage-execution";
import { jobStageExecution } from "../domain/stage-routing";
import { ApprovalService } from "./approval-service";
import { decideAutoApproval } from "./merge-authority";
import { buildWorkOrder, type CapabilityWorkOrderEnvelope } from "../bb/handoffs";
import { buildPlanArtifact } from "../bb/pipeline-handoffs";
import { environmentDiffText, type BbAttempt, type EnvironmentSnapshot, type PipelineThreadAttempt } from "../bb/runner";
import { publishImplementationPullRequest } from "../bb/pr-publish";
import type { TerminalCommandRunner, TerminalObservation } from "../bb/terminal-command";
import { environmentWorktreeIsClean, ValidationError, type ValidationSnapshot } from "../bb/validation";
import { persistableJobStatusPayload, renderJobStatus } from "../telegram/view";
import { projectResourceWait } from "../storage/autonomy-repository";
import type {
  AttemptRecord,
  OutboxInput,
  PipelineStageAttempt,
  PipelineStageRole,
  ExecutorFence,
  TelegramAgentStore,
} from "../storage/store";
import type { CapabilityProfile, ModelRouteTrial } from "../storage/capability-repository";
import { isSafeControlEffect } from "../autonomy/models";
import {
  projectTerminalLiveness,
  projectUnknownWorker,
  projectWorkerLiveness,
  workerRegistrationGeneration,
} from "./worker-liveness";
import {
  parseProductionStageSnapshot,
  type ProductionPhase,
  type ProductionStageSnapshot,
} from "./production-runner";

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
  retireWorker?(resourceId: string, allowMissing: boolean): Promise<void>;
  prepareProgressScratchpad?(environmentId: string): Promise<void>;
  /** Refuses a worktree whose history can never reach the job's base branch. */
  assertWorktreeSharesTrunk?(environmentId: string, trunk: string): Promise<void>;
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
  minimumModelPool?: () => ModelPool | undefined;
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
  reconcileJob?: (job: Job, signal: AbortSignal, fence: EffectFence, resourceId?: string) => Promise<void>;
  resolvePrHead?: (job: Job, effect: StoredEffect, signal: AbortSignal) => Promise<
    | { event: "PR_HEAD_RESOLVED"; headSha: string; originRepository: string }
    | { event: "PR_HEAD_RESOLUTION_FAILED"; reason?: string }
  >;
  runValidation?: (job: Job, effect: StoredEffect, signal: AbortSignal) => Promise<ValidationSnapshot>;
  runProductionStage?: (
    job: Job,
    effect: StoredEffect,
    phase: ProductionPhase,
    signal: AbortSignal,
    onTerminalObservation: (observation: TerminalObservation) => void,
  ) => Promise<ProductionStageSnapshot>;
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

function locatedPullRequest(snapshot: unknown): { number: number; url: string } | null {
  const record = snapshot !== null && typeof snapshot === "object"
    ? snapshot as { outcome?: string; pullRequest?: { number?: unknown; url?: unknown } }
    : {};
  const number = record.pullRequest?.number;
  const url = record.pullRequest?.url;
  if (record.outcome === "available" && typeof number === "number" && Number.isInteger(number) && number >= 1
    && typeof url === "string" && url.length > 0) {
    return { number, url };
  }
  return null;
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
    case "deploy_production": return ["deploying"];
    case "verify_production": return ["verifying_production"];
    case "recover_worker": return ["recovering_worker"];
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
  "deploy_production",
  "verify_production",
  "recover_worker",
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

export function threadResultEnvironment(result: { environmentId?: unknown }): string {
  if (typeof result.environmentId !== "string" || result.environmentId.length === 0) {
    // Retryable, deliberately. A managed worktree attaches to its thread a few
    // seconds *after* the spawn call returns, so an absent environment id here
    // is normal timing rather than a broken thread. Treating it as permanent
    // killed every job at its first spawn and blocked the whole pipeline.
    throw new Error("BB thread has no environment id yet");
  }
  return result.environmentId;
}

function validateThreadResult(result: { id?: unknown; environmentId?: unknown }): void {
  threadResultId(result);
  threadResultEnvironment(result);
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

export function validationCommandIdentity(command: string): string {
  return command.slice(0, 500);
}

function validationStageEvidence(result: ValidationSnapshot, policy: ProjectPolicy): Record<string, unknown> {
  const policyCommandReceipts = result.policyCommandReceipts ?? policy.validationCommands.flatMap((configured) => {
    const receipt = result.commandReceipts.find((candidate) => candidate.command === configured.command);
    return receipt ? [{
      name: configured.name,
      commandSha256: createHash("sha256").update(configured.command, "utf8").digest("hex"),
      outcome: receipt.outcome,
      exitCode: receipt.exitCode,
    }] : [];
  });
  return {
    validationOutcome: result.validationOutcome,
    headSha: result.headSha,
    originRepository: result.originRepository,
    terminalIds: (result.terminalIds ?? []).slice(0, 100),
    commandReceipts: result.commandReceipts.slice(0, 50).map((receipt) => ({
      command: validationCommandIdentity(receipt.command),
      outcome: receipt.outcome,
      exitCode: receipt.exitCode,
      output: receipt.output.slice(0, 1_000),
    })),
    policyCommandReceipts: policyCommandReceipts.slice(0, 20),
    requiredChecks: result.requiredChecks.slice(0, 50).map((check) => ({
      name: check.name.slice(0, 200),
      bucket: check.bucket.slice(0, 80),
      state: check.state.slice(0, 80),
      link: check.link?.slice(0, 500) ?? null,
    })),
    githubPr: result.githubPr ? {
      number: result.githubPr.number,
      url: result.githubPr.url.slice(0, 500),
      state: result.githubPr.state.slice(0, 40),
      isDraft: result.githubPr.isDraft,
      baseRefName: result.githubPr.baseRefName.slice(0, 255),
      headRefName: result.githubPr.headRefName.slice(0, 255),
    } : null,
    completedAt: result.completedAt,
  };
}

function pipelineAttemptForRunner(
  attempt: PipelineStageAttempt,
  capabilityProfile?: CapabilityWorkOrderEnvelope,
): PipelineThreadAttempt {
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
    capabilityProfile,
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

const MODEL_POOL_RANK: Readonly<Record<ModelPool, number>> = { fast: 0, standard: 1, strong: 2 };

function nextModelPool(pool: ModelPool): ModelPool | null {
  if (pool === "fast") return "standard";
  if (pool === "standard") return "strong";
  return null;
}

function sameModelRoute(left: ModelRoute, right: ModelRoute): boolean {
  return left.pool === right.pool && left.providerId === right.providerId && left.modelId === right.modelId &&
    left.reasoning === right.reasoning && left.serviceTier === right.serviceTier;
}

function selectedWorkerTraits(
  job: Job,
  role: WorkerSkillRole,
  stage: WorkerProfileStage,
  extraTraits: readonly string[],
): string[] {
  const traits = new Set<string>(job.taskTraits.map((entry) => entry.id));
  for (const trait of extraTraits) traits.add(trait);
  if (["bounded", "bug", "architectural", "skill-authoring"].includes(job.taskRecipe)) {
    traits.add("behavioral-change");
  }
  if (job.taskRecipe === "bug") traits.add("unexpected-behavior");
  if (role === "planner" && stage === "planning") traits.add("approved-spec");
  if (role === "critic" || role === "review" || role === "final-review" || role === "documentation") {
    traits.add("strict-json");
  }
  if (role === "documentation") traits.add("docs-changed");
  return sortedUnique([...traits]);
}

function reviewChangeSurfaceTraits(diff: string): string[] {
  const traits = new Set<string>(["strict-json"]);
  const paths = changedPathsFromGitDiff(diff);
  for (const path of paths) {
    const normalized = path.toLowerCase();
    if (/(^|\/)(?:tests?|__tests__)(\/|$)|\.(?:test|spec)\.[^.]+$/u.test(normalized)) {
      traits.add("tests-changed");
    } else if (/(^|\/)(?:readme|changelog)(?:\.|$)|(^|\/)docs?\/|\.(?:md|mdx|rst)$/u.test(normalized)) {
      traits.add("docs-changed");
    } else {
      traits.add("code-changed");
    }
  }
  if (paths.length > 1 || diff.length > 2_000) traits.add("nontrivial-diff");
  return sortedUnique([...traits]);
}

function productionReceiptCountIsValid(snapshot: ProductionStageSnapshot, configuredCommands: number): boolean {
  return snapshot.outcome === "pass"
    ? snapshot.commandReceipts.length === configuredCommands
    : snapshot.commandReceipts.length <= configuredCommands;
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

  private executorFence(): ExecutorFence {
    return {
      ownerId: this.dependencies.fence.ownerId,
      generation: this.dependencies.fence.generation,
      now: this.now(),
    };
  }

  private applyEvent(
    jobId: string,
    expectedVersion: number,
    event: JobEvent,
    nativeAdapter?: NativeAdapterTransitionEnvelope,
  ): Job {
    this.assertFence();
    const updated = this.dependencies.store.applyExecutorJobEvent({
      jobId,
      expectedVersion,
      event,
      ...(nativeAdapter ? { nativeAdapter } : {}),
      ...this.executorFence(),
    });
    // The store refuses a transition for a lost lease, a stale expected version,
    // or evidence that does not back the event. It does not say which, so this
    // message must not claim one: `assertFence` above already ruled out the
    // lease, and naming it here sends every diagnosis to the wrong place.
    if (!updated) throw new Error(`executor refused the ${event.type} job transition`);
    return updated;
  }

  private prepareNativeAdapter(
    effect: StoredEffect,
    job: Job,
    transition: NativeAdapterTransition,
    reviewLaneCount?: number,
  ): NativeAdapterTransitionEnvelope | undefined {
    return prepareNativeAdapterTransition({
      store: this.dependencies.store,
      job,
      transition,
      effectIdempotencyKey: effect.idempotencyKey,
      ...(reviewLaneCount === undefined ? {} : { reviewLaneCount }),
      minimumModelPool: this.dependencies.minimumModelPool?.(),
      now: this.now(),
    });
  }

  private updateExecutorAttempt(
    jobId: string,
    attemptId: string,
    patch: Parameters<TelegramAgentStore["updateExecutorAttempt"]>[0]["patch"],
  ): AttemptRecord {
    this.assertFence();
    const updated = this.dependencies.store.updateExecutorAttempt({
      jobId,
      attemptId,
      patch,
      ...this.executorFence(),
    });
    if (!updated) throw new Error("executor lease was lost before attempt mutation");
    return updated;
  }

  private renewOperationFence(effect: StoredEffect): void {
    this.assertFence();
    const renewed = (isSafeControlEffect(effect.kind)
      ? this.dependencies.store.renewControlEffectFence
      : this.dependencies.store.renewJobOperationFences).call(this.dependencies.store, {
      jobId: effect.jobId,
      effectIdempotencyKey: effect.idempotencyKey,
      leaseMs: 30_000,
      ...this.executorFence(),
    });
    if (!renewed) throw new Error("executor lease was lost during long operation");
  }

  private currentEffect(input: StoredEffect): StoredEffect {
    const current = this.dependencies.store.getEffect(input.jobId, input.idempotencyKey);
    if (!current) throw new PermanentEffectError("effect disappeared before execution");
    if (current.jobId !== input.jobId || current.idempotencyKey !== input.idempotencyKey) {
      throw new PermanentEffectError("effect identity changed before execution");
    }
    if (current.status === "done" || current.status === "dead" || current.status === "failed") return current;
    if (current.status !== "leased" ||
      current.leaseOwner !== this.dependencies.fence.ownerId ||
      current.leaseGeneration !== this.dependencies.fence.generation ||
      current.leaseExpiresAt === null ||
      current.leaseExpiresAt <= this.now()) {
      throw new Error("effect lease was lost");
    }
    return current;
  }

  private currentJob(effect: StoredEffect): Job {
    const job = this.dependencies.store.getJob(effect.jobId);
    if (!job) throw new PermanentEffectError("effect job does not exist");
    const states = expectedStates(effect.kind);
    if (states.length > 0 && !states.includes(job.state)) return job;
    return job;
  }

  private modelRouteForWorkerProfile(
    job: Job,
    subjectId: string,
    stage: WorkerProfileStage,
    pipelineRole: boolean,
    risk: "low" | "medium" | "high",
    existing: CapabilityProfile | null,
  ): ModelRoute {
    const selection = {
      executionClass: pipelineRole ? "pipeline" as const : "worker" as const,
      recipe: job.taskRecipe,
      stage,
      risk,
      observedComplexity: job.taskTraits.some((trait) => trait.id === "multi-session") ? "high" as const : undefined,
    };
    if (!existing) {
      return selectModelRoute({
        ...selection,
        minimumPool: this.dependencies.minimumModelPool?.(),
      }, DEFAULT_MODEL_POOL_REGISTRY);
    }
    const trials = this.dependencies.store.listModelRouteTrials("worker_attempt", subjectId, 256);
    const latest = trials.at(-1);
    if (latest?.outcome === "blocked") {
      throw new PermanentEffectError("Model provider route is durably blocked after equivalent strong-pool failures");
    }
    if (latest?.outcome === "selected") {
      if (!sameModelRoute(latest.route, existing.model)) {
        throw new PermanentEffectError("Unsettled model trial does not match the immutable worker profile");
      }
      return existing.model;
    }
    const [previous, current] = trials.slice(-2);
    const equivalentFailures = previous?.outcome === "failed" && current?.outcome === "failed" &&
      previous.failureSignature !== null && previous.failureSignature === current.failureSignature &&
      sameModelRoute(previous.route, current.route) && sameModelRoute(current.route, existing.model);
    if (!equivalentFailures) return existing.model;
    const nextPool = nextModelPool(existing.model.pool);
    if (nextPool === null) {
      throw new PermanentEffectError("Model provider route exhausted the strong pool");
    }
    return selectModelRoute({ ...selection, minimumPool: nextPool }, DEFAULT_MODEL_POOL_REGISTRY);
  }

  private settleProfileForModelRouteChange(
    profile: CapabilityProfile,
    trials: readonly ModelRouteTrial[],
    reasonCode: "model_route_escalated" | "model_route_blocked",
  ): void {
    const evidenceRefs = trials.slice(-2).map((trial) => `model-trial:${trial.id}`);
    if (evidenceRefs.length === 0) throw new PermanentEffectError("Model route change is missing durable failure evidence");
    const missing = new Set(this.dependencies.store.listMissingMandatoryCapabilityOutcomes(profile.id));
    for (const assignment of profile.assignments) {
      if (!assignment.mandatory || !missing.has(assignment.capabilityId)) continue;
      this.dependencies.store.appendCapabilityTerminalOutcome({
        profileId: profile.id,
        capabilityId: assignment.capabilityId,
        descriptorDigest: assignment.descriptorDigest,
        outcome: "blocked",
        evidenceRefs,
        reasonCode,
        now: this.now(),
      });
    }
  }

  private beginModelRouteTrial(
    profile: CapabilityWorkOrderEnvelope | undefined,
    subjectId: string,
    stage: WorkerProfileStage,
    operation: string,
  ): ModelRouteTrial | undefined {
    if (profile?.mode !== "active") return undefined;
    const model = profile.model;
    if (!model) throw new PermanentEffectError("Active capability profile is missing its model route");
    const trials = this.dependencies.store.listModelRouteTrials("worker_attempt", subjectId, 256);
    const latest = trials.at(-1);
    if (latest?.outcome === "selected") {
      if (!sameModelRoute(latest.route, model)) {
        throw new PermanentEffectError("Unsettled model trial does not match the provider invocation route");
      }
      return latest;
    }
    return this.dependencies.store.recordModelRouteSelection({
      subjectKind: "worker_attempt",
      subjectId,
      attempt: (latest?.attempt ?? 0) + 1,
      stage,
      operation,
      route: model,
      now: this.now(),
    });
  }

  private settleRecoveredModelRoute(subjectId: string, profile: CapabilityProfile | null): void {
    if (profile?.mode !== "active") return;
    const latest = this.dependencies.store.listModelRouteTrials("worker_attempt", subjectId, 256).at(-1);
    if (latest?.outcome !== "selected") return;
    if (!sameModelRoute(latest.route, profile.model)) {
      throw new PermanentEffectError("Recovered worker route does not match its unsettled model trial");
    }
    this.dependencies.store.settleModelRouteTrial({
      subjectKind: "worker_attempt",
      subjectId,
      attempt: latest.attempt,
      outcome: "passed",
      failureSignature: null,
      now: this.now(),
    });
  }

  private async invokeModelProvider<T>(input: Readonly<{
    effect: StoredEffect;
    profile: CapabilityWorkOrderEnvelope | undefined;
    subjectId: string;
    stage: WorkerProfileStage;
    operation: string;
    invoke: () => Promise<T>;
    validate?: (result: T) => void;
  }>): Promise<T> {
    const trial = this.beginModelRouteTrial(input.profile, input.subjectId, input.stage, input.operation);
    let result: T;
    try {
      result = await input.invoke();
    } catch (error) {
      this.assertFence();
      if (!trial) throw error;
      const priorFailureSignatures = this.dependencies.store
        .listModelRouteTrials("worker_attempt", input.subjectId, 256)
        .filter((candidate) => candidate.attempt !== trial.attempt && candidate.outcome === "failed")
        .flatMap((candidate) => candidate.failureSignature === null ? [] : [candidate.failureSignature]);
      const decision = recordModelFailure({
        route: trial.route,
        stage: input.stage,
        operation: input.operation,
        error,
        priorFailureSignatures,
      });
      this.dependencies.store.settleModelRouteTrial({
        subjectKind: "worker_attempt",
        subjectId: input.subjectId,
        attempt: trial.attempt,
        outcome: decision.action === "block" ? "blocked" : "failed",
        failureSignature: decision.signature,
        now: this.now(),
      });
      if (decision.action === "block") {
        const profile = this.dependencies.store.getCapabilityProfileById(input.profile!.profileId);
        if (!profile) throw new PermanentEffectError("Blocked model route lost its immutable capability profile");
        this.settleProfileForModelRouteChange(
          profile,
          this.dependencies.store.listModelRouteTrials("worker_attempt", input.subjectId, 256),
          "model_route_blocked",
        );
        throw new PermanentEffectError("Model provider route exhausted the strong pool");
      }
      throw error;
    }
    this.renewOperationFence(input.effect);
    input.validate?.(result);
    if (trial) {
      this.dependencies.store.settleModelRouteTrial({
        subjectKind: "worker_attempt",
        subjectId: input.subjectId,
        attempt: trial.attempt,
        outcome: "passed",
        failureSignature: null,
        now: this.now(),
      });
    }
    return result;
  }

  private ensureWorkerCapabilityProfile(
    job: Job,
    subjectId: string,
    role: WorkerSkillRole,
    stage: WorkerProfileStage,
    extraTraits: readonly string[] = [],
  ): CapabilityWorkOrderEnvelope | undefined {
    if (job.routingMode === "legacy") return undefined;
    if (!job.policy || !job.projectId) {
      throw new PermanentEffectError("Capability selection requires immutable project policy context");
    }
    const traits = selectedWorkerTraits(job, role, stage, extraTraits);
    const selected = selectCapabilityProfile({
      role,
      recipe: job.taskRecipe,
      stage,
      traits,
    });
    const pipelineRole = role === "planner" || role === "critic" || role === "documentation";
    const risk = job.taskRecipe === "architectural" || job.taskTraits.some((trait) => trait.id === "high-risk")
      ? "high" as const
      : job.taskRecipe === "direct" ? "low" as const : "medium" as const;
    const assignments = selected.assignments.map((assignment) => ({
      capabilityId: assignment.capabilityId,
      descriptorDigest: assignment.descriptorDigest,
      capabilityKind: "skill" as const,
      mandatory: assignment.mandatory,
    }));
    const mode = job.routingMode === "active" ? "active" as const : "shadow" as const;
    const reasonCodes = sortedUnique([
      ...job.taskReasonCodes,
      `worker_role:${role}`,
      `worker_stage:${stage}`,
    ]);
    const existing = this.dependencies.store.getLatestCapabilityProfile("worker_attempt", subjectId);
    const model = this.modelRouteForWorkerProfile(job, subjectId, stage, pipelineRole, risk, existing);
    let profile = existing;
    if (existing) {
      const actualAssignments = existing.assignments.map((assignment) => ({
        capabilityId: assignment.capabilityId,
        descriptorDigest: assignment.descriptorDigest,
        capabilityKind: assignment.capabilityKind,
        mandatory: assignment.mandatory,
      }));
      const expectedIdentity = JSON.stringify({
        recipeId: job.taskRecipe,
        recipeVersion: job.recipeVersion,
        registryDigest: CAPABILITY_REGISTRY_DIGEST,
        graphDigest: CAPABILITY_GRAPH_DIGEST,
        mode,
        reasonCodes,
        traits,
        assignments: [...assignments].sort((left, right) => left.capabilityId.localeCompare(right.capabilityId)),
      });
      const actualIdentity = JSON.stringify({
        recipeId: existing.recipeId,
        recipeVersion: existing.recipeVersion,
        registryDigest: existing.registryDigest,
        graphDigest: existing.graphDigest,
        mode: existing.mode,
        reasonCodes: existing.reasonCodes,
        traits: existing.traits,
        assignments: actualAssignments,
      });
      if (expectedIdentity !== actualIdentity) {
        throw new PermanentEffectError("Persisted capability profile does not match the immutable worker dispatch");
      }
      if (!sameModelRoute(existing.model, model)) {
        if (MODEL_POOL_RANK[model.pool] <= MODEL_POOL_RANK[existing.model.pool]) {
          throw new PermanentEffectError("Worker model route cannot change without a monotonic pool escalation");
        }
        const trials = this.dependencies.store.listModelRouteTrials("worker_attempt", subjectId, 256);
        this.settleProfileForModelRouteChange(existing, trials, "model_route_escalated");
        profile = this.dependencies.store.createCapabilityProfile({
          subjectKind: "worker_attempt",
          subjectId,
          threadId: null,
          recipeId: job.taskRecipe,
          recipeVersion: job.recipeVersion,
          registryDigest: CAPABILITY_REGISTRY_DIGEST,
          graphDigest: CAPABILITY_GRAPH_DIGEST,
          mode,
          model,
          assignments,
          reasonCodes,
          traits,
          expectedRevision: existing.revision + 1,
          now: this.now(),
        });
      }
    } else {
      profile = this.dependencies.store.createCapabilityProfile({
        subjectKind: "worker_attempt",
        subjectId,
        threadId: null,
        recipeId: job.taskRecipe,
        recipeVersion: job.recipeVersion,
        registryDigest: CAPABILITY_REGISTRY_DIGEST,
        graphDigest: CAPABILITY_GRAPH_DIGEST,
        mode,
        model,
        assignments,
        reasonCodes,
        traits,
        expectedRevision: 1,
        now: this.now(),
      });
    }
    if (!profile) throw new Error("Capability profile disappeared before worker dispatch");
    const receipts = this.dependencies.store.listCapabilityReceipts(profile.id, 256);
    for (const denial of selected.denied) {
      const descriptor = CAPABILITY_BY_ID.get(denial.capabilityId);
      if (!descriptor) continue;
      if (receipts.some((receipt) => receipt.eventType === "denied" &&
        receipt.capabilityId === denial.capabilityId && receipt.reasonCode === denial.reasonCode)) continue;
      this.dependencies.store.appendCapabilityReceipt({
        profileId: profile.id,
        capabilityId: descriptor.id,
        capabilityKind: descriptor.kind,
        descriptorDigest: descriptor.digest,
        eventType: "denied",
        reasonCode: denial.reasonCode,
        mandatory: descriptor.evidence.requirement === "mandatory",
        evidenceRefs: [],
        now: this.now(),
      });
    }
    return {
      profileId: profile.id,
      profileRevision: profile.revision,
      profileDigest: capabilityProfileDigest(profile.assignments),
      recipeId: job.taskRecipe,
      recipeVersion: job.recipeVersion,
      mode: profile.mode,
      model: profile.model,
      assignments: profile.assignments.map((assignment) => ({
        capabilityId: assignment.capabilityId,
        descriptorDigest: assignment.descriptorDigest,
        mandatory: assignment.mandatory,
      })),
    };
  }

  private async reviewCapabilityTraits(effect: StoredEffect, job: Job): Promise<readonly string[]> {
    const bb = this.dependencies.bb;
    if (!bb?.getEnvironmentSnapshot || !job.environmentId || !job.policy) {
      if (job.routingMode === "active") {
        throw new PermanentEffectError("Exact review change surface is unavailable for active capability routing");
      }
      return ["strict-json", "change-surface-unavailable"];
    }
    this.assertFence();
    const snapshot = await bb.getEnvironmentSnapshot(job.environmentId, job.policy.baseBranch);
    this.renewOperationFence(effect);
    const diff = environmentDiffText(snapshot.diff);
    if (diff === null) {
      if (job.routingMode === "active") {
        throw new PermanentEffectError("Exact review change surface is unavailable for active capability routing");
      }
      return ["strict-json", "change-surface-unavailable"];
    }
    return reviewChangeSurfaceTraits(diff);
  }

  private async adoptOrSpawn(
    effect: StoredEffect,
    job: Job,
    kind: "implementation" | "review",
    finalReview = false,
    reviewLens: "quality" | "risk" = "quality",
    reviewAttemptId?: string,
    reviewOrdinal?: number,
    extraTraits: readonly string[] = [],
  ): Promise<{ threadId: string; environmentId: string }> {
    const bb = this.dependencies.bb;
    if (!bb) throw new PermanentEffectError("BB runner is not configured");
    const baseAttemptInput = attemptFor(effect, job, kind);
    const attemptInput = {
      ...baseAttemptInput,
      ...(reviewAttemptId ? { id: reviewAttemptId } : {}),
      ...(reviewOrdinal ? { ordinal: reviewOrdinal } : {}),
    };
    const existingAttempt = this.dependencies.store.getAttempt(attemptInput.id);
    const attempt = this.dependencies.store.createExecutorAttempt({
      id: attemptInput.id,
      jobId: job.id,
      kind,
      ordinal: existingAttempt?.ordinal ?? attemptInput.ordinal,
      headSha: attemptInput.headSha,
      reviewLens: kind === "review" ? reviewLens : null,
      reviewStage: kind === "review" ? (finalReview ? "final_review" : "review") : null,
      ...this.executorFence(),
    });
    if (!attempt) throw new Error("executor lease was lost before attempt creation");
    const titleRole = finalReview ? "final-review" : kind;
    const capabilityStage: WorkerProfileStage = kind === "implementation"
      ? "implementation"
      : finalReview && job.taskRecipe === "architectural"
        ? "integrated-review"
        : job.taskRecipe === "architectural"
          ? "task-review"
          : "review";
    const capabilityProfile = this.ensureWorkerCapabilityProfile(
      job,
      attempt.id,
      titleRole,
      capabilityStage,
      extraTraits,
    );
    const runnerAttempt: BbAttempt = { ...attempt, capabilityProfile };
    if (kind === "review" && attempt.threadId && job.environmentId) {
      this.settleRecoveredModelRoute(
        attempt.id,
        this.dependencies.store.getLatestCapabilityProfile("worker_attempt", attempt.id),
      );
      return { threadId: attempt.threadId, environmentId: job.environmentId };
    }
    const expectedTitle = buildWorkerThreadTitle({ jobId: job.id, attemptId: attempt.id, role: titleRole });
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
        this.renewOperationFence(effect);
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
        this.updateExecutorAttempt(job.id, attempt.id, { threadId: candidate.id });
        this.settleRecoveredModelRoute(
          attempt.id,
          this.dependencies.store.getLatestCapabilityProfile("worker_attempt", attempt.id),
        );
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
    const created = await this.invokeModelProvider({
      effect,
      profile: capabilityProfile,
      subjectId: attempt.id,
      stage: capabilityStage,
      operation: `spawn-${titleRole}`,
      invoke: () => spawn(job, runnerAttempt),
      validate: validateThreadResult,
    });
    const threadId = threadResultId(created);
    const environmentId = threadResultEnvironment(created);
    this.updateExecutorAttempt(job.id, attempt.id, {
      threadId,
      handoffPath: runnerAttempt.handoffPath ?? null,
      handoffSha256: runnerAttempt.handoffSha256 ?? null,
    });
    this.recordStageExecution(job, kind === "implementation" ? "implementation" : "review", attempt, threadId, capabilityProfile);
    return { threadId, environmentId };
  }

  /**
   * Opens this attempt's row in the stage ledger. Tiering can only be tuned
   * from what stages actually ran on, so the tuple is recorded at dispatch
   * rather than inferred later from whatever policy happens to be current.
   */
  private recordStageExecution(
    job: Job,
    stage: PipelineStage,
    attempt: Readonly<{ id: string; ordinal?: number }>,
    threadId: string | null,
    capability: CapabilityWorkOrderEnvelope | undefined,
  ): void {
    if (!job.policy) return;
    const execution = jobStageExecution({
      job,
      policy: job.policy,
      stage,
      attemptOrdinal: attempt.ordinal,
      ...(job.routingMode === "active" && capability?.model ? { capabilityRoute: capability.model } : {}),
    });
    this.dependencies.store.recordStageExecution({
      jobId: job.id,
      attemptId: attempt.id,
      stage,
      attemptOrdinal: Math.max(1, attempt.ordinal ?? 1),
      threadId,
      baseTier: execution.baseTier,
      tier: execution.tier,
      escalationSteps: execution.escalationSteps,
      source: execution.source,
      providerId: execution.providerId,
      modelId: execution.model,
      reasoningLevel: execution.reasoningLevel,
      serviceTier: execution.serviceTier,
      now: this.now(),
    });
  }

  private async findPipelineStageCandidate(
    effect: StoredEffect,
    bb: BbEffectAdapter,
    job: Job,
    attempt: PipelineStageAttempt,
  ): Promise<{ threadId: string; environmentId: string } | null> {
    const list = listThreadsAdapter(bb);
    if (!list || !job.projectId) return null;
    const role = attempt.role === "PLAN" ? "planner" : attempt.role === "CRITIQUE" ? "critic" : "documentation";
    const expectedTitle = buildWorkerThreadTitle({ jobId: job.id, attemptId: attempt.id, role });
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
      this.renewOperationFence(effect);
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
    const nativeAdapter = job.environmentId === null
      ? this.prepareNativeAdapter(effect, job, "plan-worktree-created")
      : undefined;
    const previousCritique = this.dependencies.store.getLatestPipelineStageAttempt(job.id, "CRITIQUE");
    const capabilityProfile = this.ensureWorkerCapabilityProfile(
      job,
      `stage:${effect.idempotencyKey}`,
      "planner",
      "planning",
    );
    const workOrder = buildWorkOrder(job, job.policy, capabilityProfile);
    const inputSha256 = previousCritique?.outputSha256
      ? stageInputSha(workOrder.sha256, previousCritique.outputSha256)
      : stageInputSha(workOrder.sha256);
    const attempt = this.createPipelineAttempt(effect, job, "PLAN", inputSha256);
    const runnerAttempt = pipelineAttemptForRunner(attempt, capabilityProfile);
    let created = attempt.threadId && attempt.environmentId
      ? { threadId: attempt.threadId, environmentId: attempt.environmentId }
      : await this.findPipelineStageCandidate(effect, bb, job, attempt);
    if (!created) {
      this.assertFence();
      const result = await this.invokeModelProvider({
        effect,
        profile: capabilityProfile,
        subjectId: attempt.id,
        stage: "planning",
        operation: "spawn-planner",
        invoke: () => bb.spawnPlanner!(
          job,
          runnerAttempt,
          previousCritique?.outputText,
        ),
        validate: validateThreadResult,
      });
      created = { threadId: threadResultId(result), environmentId: threadResultEnvironment(result) };
      this.recordStageExecution(job, "plan", attempt, created.threadId, capabilityProfile);
    }
    this.settleRecoveredModelRoute(
      attempt.id,
      this.dependencies.store.getLatestCapabilityProfile("worker_attempt", attempt.id),
    );
    this.bindPipelineAttempt(attempt, created.threadId, created.environmentId);
    this.assertFence();
    const current = this.dependencies.store.getJob(job.id);
    if (current?.state === "planning" && current.environmentId === null) {
      this.applyEvent(job.id, current.version, {
        type: "PLAN_CREATED",
        attemptId: attempt.id,
        threadId: created.threadId,
        environmentId: created.environmentId,
      }, nativeAdapter);
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
    const capabilityProfile = this.ensureWorkerCapabilityProfile(
      job,
      `stage:${effect.idempotencyKey}`,
      "critic",
      "planning",
    );
    const workOrder = buildWorkOrder(job, job.policy, capabilityProfile);
    const planArtifact = buildPlanArtifact(plan.outputText);
    if (planArtifact.sha256 !== plan.outputSha256) throw new PermanentEffectError("Durable plan artifact hash does not match its output");
    const attempt = this.createPipelineAttempt(
      effect,
      job,
      "CRITIQUE",
      stageInputSha(workOrder.sha256, plan.outputSha256),
    );
    const runnerAttempt = pipelineAttemptForRunner(attempt, capabilityProfile);
    let created = attempt.threadId && attempt.environmentId
      ? { threadId: attempt.threadId, environmentId: attempt.environmentId }
      : await this.findPipelineStageCandidate(effect, bb, job, attempt);
    if (!created) {
      this.assertFence();
      const result = await this.invokeModelProvider({
        effect,
        profile: capabilityProfile,
        subjectId: attempt.id,
        stage: "planning",
        operation: "spawn-critic",
        invoke: () => bb.spawnCritic!(
          job,
          runnerAttempt,
          pipelineAttemptForRunner(plan),
        ),
        validate: validateThreadResult,
      });
      created = { threadId: threadResultId(result), environmentId: threadResultEnvironment(result) };
      this.recordStageExecution(job, "critique", attempt, created.threadId, capabilityProfile);
    }
    this.settleRecoveredModelRoute(
      attempt.id,
      this.dependencies.store.getLatestCapabilityProfile("worker_attempt", attempt.id),
    );
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
    const capabilityProfile = this.ensureWorkerCapabilityProfile(
      job,
      `stage:${effect.idempotencyKey}`,
      "documentation",
      "documentation",
    );
    const workOrder = buildWorkOrder(job, job.policy, capabilityProfile);
    const attempt = this.createPipelineAttempt(
      effect,
      job,
      "DOCS",
      stageInputSha(workOrder.sha256, job.prHeadSha),
    );
    const runnerAttempt = pipelineAttemptForRunner(attempt, capabilityProfile);
    let created = attempt.threadId && attempt.environmentId
      ? { threadId: attempt.threadId, environmentId: attempt.environmentId }
      : await this.findPipelineStageCandidate(effect, bb, job, attempt);
    if (!created) {
      this.assertFence();
      const result = await this.invokeModelProvider({
        effect,
        profile: capabilityProfile,
        subjectId: attempt.id,
        stage: "documentation",
        operation: "spawn-documentation",
        invoke: () => bb.spawnDocs!(job, runnerAttempt),
        validate: validateThreadResult,
      });
      created = { threadId: threadResultId(result), environmentId: threadResultEnvironment(result) };
      this.recordStageExecution(job, "docs", attempt, created.threadId, capabilityProfile);
    }
    this.settleRecoveredModelRoute(
      attempt.id,
      this.dependencies.store.getLatestCapabilityProfile("worker_attempt", attempt.id),
    );
    if (created.environmentId !== job.environmentId) {
      throw new PermanentEffectError("Docs did not reuse the implementation environment");
    }
    this.bindPipelineAttempt(attempt, created.threadId, created.environmentId);
    this.assertFence();
    const current = this.dependencies.store.getJob(job.id);
    if (current?.state === "documenting" && current.documentationThreadId === null) {
      this.applyEvent(job.id, current.version, {
        type: "DOCS_CREATED",
        attemptId: attempt.id,
        threadId: created.threadId,
        environmentId: created.environmentId,
      });
    }
  }

  private async spawnImplementation(effect: StoredEffect, job: Job): Promise<void> {
    if (job.state !== "creating_implementation") return;
    const nativeAdapter = this.prepareNativeAdapter(effect, job, "implementation-worktree-created");
    const created = await this.adoptOrSpawn(effect, job, "implementation");
    // Checked before any work is handed to the worker: a worktree cut from an
    // unrelated root can never merge into the base branch, and discovering that
    // after a full implementation and review cycle wastes the whole job.
    if (this.dependencies.bb?.assertWorktreeSharesTrunk && job.policy) {
      this.assertFence();
      await this.dependencies.bb.assertWorktreeSharesTrunk(created.environmentId, job.policy.baseBranch);
      this.renewOperationFence(effect);
    }
    if (this.dependencies.bb?.prepareProgressScratchpad) {
      this.assertFence();
      await this.dependencies.bb.prepareProgressScratchpad(created.environmentId);
      this.renewOperationFence(effect);
    }
    this.assertFence();
    const current = this.dependencies.store.getJob(job.id);
    if (!current || current.state !== "creating_implementation") return;
    this.applyEvent(
      job.id,
      current.version,
      { type: "IMPLEMENTATION_CREATED", threadId: created.threadId, environmentId: created.environmentId },
      nativeAdapter,
    );
  }

  private async spawnReview(effect: StoredEffect, job: Job): Promise<void> {
    if (job.state !== "reviewing") return;
    const capabilityTraits = await this.reviewCapabilityTraits(effect, job);
    const lenses = job.routingMode === "active"
      ? job.taskRecipe === "direct" ? ["quality" as const] : ["quality" as const, "risk" as const]
      : isSmallFixJob(job) ? ["quality" as const] : ["quality" as const, "risk" as const];
    const nativeAdapter = this.prepareNativeAdapter(effect, job, "review-created", lenses.length);
    const qualityAttemptId = `attempt:${effect.idempotencyKey}`;
    const ordinal = this.dependencies.store.getAttempt(qualityAttemptId)?.ordinal ??
      this.dependencies.store.nextAttemptOrdinal(job.id, "review");
    const created = [] as Array<{ threadId: string; environmentId: string }>;
    for (const lens of lenses) {
      created.push(await this.adoptOrSpawn(
        effect,
        job,
        "review",
        false,
        lens,
        lens === "quality" ? qualityAttemptId : `attempt:${effect.idempotencyKey}:${lens}`,
        ordinal,
        [...capabilityTraits, `${lens}-lens`],
      ));
    }
    this.assertFence();
    const current = this.dependencies.store.getJob(job.id);
    if (!current || current.state !== "reviewing") return;
    if (nativeAdapter?.settled) {
      if (current.reviewThreadId !== null && current.reviewThreadId !== created[0].threadId) {
        throw new PermanentEffectError("Settled review adapter points at a different quality-review thread");
      }
      if (current.reviewThreadId === null && !this.dependencies.store.registerExecutorReviewThread({
        jobId: job.id,
        expectedVersion: current.version,
        threadId: created[0].threadId,
        ...this.executorFence(),
      })) throw new Error("executor lease was lost before reconstructed review-thread registration");
      return;
    }
    const started = this.applyEvent(job.id, current.version, {
      type: "REVIEW_STARTED",
      laneCount: lenses.length,
    }, nativeAdapter);
    if (!this.dependencies.store.registerExecutorReviewThread({
      jobId: job.id,
      expectedVersion: started.version,
      threadId: created[0].threadId,
      ...this.executorFence(),
    })) throw new Error("executor lease was lost before review-thread registration");
  }

  private async spawnFinalReview(effect: StoredEffect, job: Job): Promise<void> {
    if (job.state !== "final_reviewing") return;
    const capabilityTraits = await this.reviewCapabilityTraits(effect, job);
    const lenses = job.routingMode === "active"
      ? job.taskRecipe === "direct" ? ["quality" as const] : ["quality" as const, "risk" as const]
      : isSmallFixJob(job) ? ["quality" as const] : ["quality" as const, "risk" as const];
    const nativeAdapter = this.prepareNativeAdapter(effect, job, "review-created", lenses.length);
    const qualityAttemptId = `attempt:${effect.idempotencyKey}`;
    const ordinal = this.dependencies.store.getAttempt(qualityAttemptId)?.ordinal ??
      this.dependencies.store.nextAttemptOrdinal(job.id, "review");
    const created = [] as Array<{ threadId: string; environmentId: string }>;
    for (const lens of lenses) {
      created.push(await this.adoptOrSpawn(
        effect,
        job,
        "review",
        true,
        lens,
        lens === "quality" ? qualityAttemptId : `attempt:${effect.idempotencyKey}:${lens}`,
        ordinal,
        [...capabilityTraits, `${lens}-lens`],
      ));
    }
    this.assertFence();
    const current = this.dependencies.store.getJob(job.id);
    if (!current || current.state !== "final_reviewing") return;
    if (nativeAdapter?.settled) {
      if (current.reviewThreadId !== null && current.reviewThreadId !== created[0].threadId) {
        throw new PermanentEffectError("Settled final-review adapter points at a different quality-review thread");
      }
      if (current.reviewThreadId === null && !this.dependencies.store.registerExecutorReviewThread({
        jobId: job.id,
        expectedVersion: current.version,
        threadId: created[0].threadId,
        ...this.executorFence(),
      })) throw new Error("executor lease was lost before reconstructed final-review thread registration");
      return;
    }
    const started = this.applyEvent(job.id, current.version, {
      type: "REVIEW_STARTED",
      laneCount: lenses.length,
    }, nativeAdapter);
    if (!this.dependencies.store.registerExecutorReviewThread({
      jobId: job.id,
      expectedVersion: started.version,
      threadId: created[0].threadId,
      ...this.executorFence(),
    })) throw new Error("executor lease was lost before final review-thread registration");
  }

  private enqueueStatus(job: Job, extra: Record<string, unknown> = {}): void {
    const owner = this.dependencies.store.getOwner();
    if (!owner) return;
    const payload = renderJobStatus(job, {
      ...this.capabilityStatusContext(job),
      ...extra,
      workerLiveness: this.dependencies.store.getWorkerLiveness(job.id),
      resourceWait: job.policy === null ? [] : projectResourceWait({
        jobId: job.id,
        policy: job.policy,
        claims: this.dependencies.store.listCurrentHeldMergeResourceClaims({
          jobId: job.id,
          policy: job.policy,
          limit: 100,
        }),
      }),
      now: this.now(),
    });
    const outbox: OutboxInput = {
      logicalKey: `job:${job.id}:status`,
      chatId: owner.chatId,
      messageId: job.statusMessageId,
      payload: persistableJobStatusPayload(payload),
    };
    if (!this.dependencies.store.enqueueExecutorStatus({ outbox, ...this.executorFence() })) {
      throw new Error("executor lease was lost before status enqueue");
    }
  }

  private capabilityStatusContext(job: Job): Record<string, unknown> {
    const context: Record<string, unknown> = {};
    const threadId = job.reviewThreadId ?? job.implementationThreadId;
    const attempt = threadId ? this.dependencies.store.getAttemptByThreadId(threadId) : null;
    const profile = attempt
      ? this.dependencies.store.getLatestCapabilityProfile("worker_attempt", attempt.id)
      : null;
    if (profile?.model.pool === "strong" && job.taskRecipe !== "architectural") {
      context.materialModelPool = "strong";
    }
    if (profile) {
      const guardIds = new Set(["clean-code-guard", "docs-guard", "test-guard"]);
      const selectedGuards = profile.assignments.filter((assignment) => guardIds.has(assignment.capabilityId));
      if (selectedGuards.length > 0) {
        const outcomes = new Map(
          this.dependencies.store.listCapabilityReceipts(profile.id, 100)
            .filter((receipt) => receipt.eventType === "outcome")
            .map((receipt) => [receipt.capabilityId, receipt.outcome]),
        );
        const values = selectedGuards.map((assignment) => outcomes.get(assignment.capabilityId) ?? null);
        context.mandatoryGuardOutcome = values.some((outcome) => outcome === null)
          ? "missing"
          : values.some((outcome) => outcome === "failed")
            ? "failed"
            : values.some((outcome) => outcome === "blocked")
              ? "blocked"
              : "passed";
      }
    }
    const validation = this.dependencies.store.getLatestPipelineStageAttempt(job.id, "FINAL_TEST") ??
      this.dependencies.store.getLatestPipelineStageAttempt(job.id, "TEST");
    if (validation) {
      const persistedOutcome = validation.outcome?.validationOutcome;
      const outcome = typeof persistedOutcome === "string"
        ? persistedOutcome
        : validation.state === "completed" ? "passed"
          : validation.state === "failed" ? "failed"
            : validation.state;
      context.validation = [{ name: validation.role === "FINAL_TEST" ? "final validation" : "validation", outcome }];
    }
    if (job.state === "awaiting_merge_approval") context.ownerDecision = "Merge approval required";
    return context;
  }

  private async inspectImplementation(effect: StoredEffect, job: Job): Promise<void> {
    const bb = this.dependencies.bb;
    if (!bb?.getEnvironmentSnapshot || !bb.getPullRequestSnapshot || !job.environmentId || !job.policy) {
      throw new PermanentEffectError("implementation inspection requires BB environment and policy context");
    }
    const nativeAdapter = this.prepareNativeAdapter(effect, job, "branch-finished");
    const snapshot = await bb.getEnvironmentSnapshot(job.environmentId, job.policy.baseBranch);
    this.renewOperationFence(effect);
    const existing = locatedPullRequest(await bb.getPullRequestSnapshot(job.environmentId));
    this.renewOperationFence(effect);
    const current = this.dependencies.store.getJob(job.id);
    if (!current || current.state !== job.state) return;
    if (existing) {
      this.applyEvent(
        job.id,
        current.version,
        { type: "PR_LOCATED", number: existing.number, url: existing.url },
        nativeAdapter,
      );
      return;
    }
    if (snapshot.status && typeof snapshot.status === "object" && "outcome" in snapshot.status && snapshot.status.outcome === "unavailable") {
      this.applyEvent(
        job.id,
        current.version,
        { type: "PR_UNAVAILABLE", reason: "BB environment observation is unavailable" },
        nativeAdapter ? nativeAdapterEnvelopeWithOutcome(nativeAdapter, "blocked") : undefined,
      );
      return;
    }
    if (this.dependencies.terminal) {
      const published = await publishImplementationPullRequest({
        runner: this.dependencies.terminal,
        job: current,
        policy: job.policy,
        environmentId: job.environmentId,
        environmentStatus: snapshot.status,
        signal: this.dependencies.fence.signal,
      });
      this.renewOperationFence(effect);
      const afterPublish = this.dependencies.store.getJob(job.id);
      if (!afterPublish || afterPublish.state !== job.state) return;
      if (published.outcome === "published") {
        this.applyEvent(job.id, afterPublish.version, {
          type: "PR_LOCATED",
          number: published.number,
          url: published.url,
        }, nativeAdapter);
        return;
      }
      const refreshed = locatedPullRequest(await bb.getPullRequestSnapshot(job.environmentId));
      this.renewOperationFence(effect);
      const refreshedJob = this.dependencies.store.getJob(job.id);
      if (!refreshedJob || refreshedJob.state !== job.state) return;
      if (refreshed) {
        this.applyEvent(job.id, refreshedJob.version, {
          type: "PR_LOCATED",
          number: refreshed.number,
          url: refreshed.url,
        }, nativeAdapter);
        return;
      }
      this.applyEvent(
        job.id,
        refreshedJob.version,
        { type: "PR_MISSING", reason: published.reason },
        nativeAdapter ? nativeAdapterEnvelopeWithOutcome(nativeAdapter, "failed") : undefined,
      );
      return;
    }
    this.applyEvent(
      job.id,
      current.version,
      { type: "PR_MISSING", reason: "No pull request was found for the implementation" },
      nativeAdapter ? nativeAdapterEnvelopeWithOutcome(nativeAdapter, "failed") : undefined,
    );
  }

  private async resolvePrHead(effect: StoredEffect, job: Job): Promise<void> {
    if (!this.dependencies.resolvePrHead) throw new PermanentEffectError("PR head resolver is not configured");
    if (!job.policy || job.prNumber === null) {
      throw new PermanentEffectError("PR head resolution requires immutable policy and pull-request identity");
    }
    const workOrder = buildWorkOrder(job, job.policy);
    const attempt = this.createPipelineAttempt(
      effect,
      job,
      "BUILD",
      stageInputSha(workOrder.sha256, String(job.prNumber), job.policy.githubRepository),
    );
    if (attempt.state === "completed") {
      const evidence = attempt.outcome;
      const headSha = evidence?.headSha;
      const originRepository = evidence?.originRepository;
      if (!fullSha(headSha) || originRepository !== job.policy.githubRepository.toLowerCase()) {
        throw new PermanentEffectError("completed PR-head stage has invalid durable evidence");
      }
      const current = this.dependencies.store.getJob(job.id);
      if (current && (current.state === "resolving_pr_head" || current.state === "resolving_docs_head")) {
        this.applyEvent(job.id, current.version, { type: "PR_HEAD_RESOLVED", headSha });
      }
      return;
    }
    if (this.dependencies.terminal && this.dependencies.bb?.getEnvironmentSnapshot && job.environmentId && job.policy) {
      const snapshot = await this.dependencies.bb.getEnvironmentSnapshot(job.environmentId, job.policy.baseBranch);
      this.renewOperationFence(effect);
      if (!environmentWorktreeIsClean(snapshot.status)) {
        await publishImplementationPullRequest({
          runner: this.dependencies.terminal,
          job,
          policy: job.policy,
          environmentId: job.environmentId,
          environmentStatus: snapshot.status,
          signal: this.dependencies.fence.signal,
        });
        this.renewOperationFence(effect);
      }
    }
    const result = await this.dependencies.resolvePrHead(job, effect, this.dependencies.fence.signal);
    this.renewOperationFence(effect);
    const current = this.dependencies.store.getJob(job.id);
    if (!current || (current.state !== "resolving_pr_head" && current.state !== "resolving_docs_head")) return;
    if (result.event === "PR_HEAD_RESOLVED" && fullSha(result.headSha)) {
      const originRepository = result.originRepository.toLowerCase();
      if (originRepository !== job.policy.githubRepository.toLowerCase()) {
        throw new PermanentEffectError("PR-head evidence repository does not match immutable policy");
      }
      const evidence = {
        verdict: "success",
        prNumber: job.prNumber,
        headSha: result.headSha,
        originRepository,
      };
      const outputText = JSON.stringify(evidence);
      const completed = this.dependencies.store.completePipelineStageAttempt({
        id: attempt.id,
        outputText,
        outputSha256: createHash("sha256").update(outputText, "utf8").digest("hex"),
        outcome: evidence,
        startSha: result.headSha,
        endSha: result.headSha,
        ownerId: this.dependencies.fence.ownerId,
        generation: this.dependencies.fence.generation,
        now: this.now(),
      });
      if (!completed) throw new Error("PR-head stage completion lost its executor fence");
      this.applyEvent(job.id, current.version, { type: "PR_HEAD_RESOLVED", headSha: result.headSha });
    } else {
      if (!this.dependencies.store.failPipelineStageAttempt({
        id: attempt.id,
        error: "PR head could not be resolved",
        ownerId: this.dependencies.fence.ownerId,
        generation: this.dependencies.fence.generation,
        now: this.now(),
      })) throw new Error("PR-head stage failure lost its executor fence");
      const reason = result.event === "PR_HEAD_RESOLUTION_FAILED"
        ? result.reason ?? "PR head could not be resolved"
        : "PR head resolver returned an invalid head SHA";
      this.applyEvent(job.id, current.version, { type: "PR_UNAVAILABLE", reason });
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
    this.renewOperationFence(effect);
    const current = this.dependencies.store.getJob(job.id);
    if (current?.state === "remediating") this.applyEvent(job.id, current.version, { type: "REMEDIATION_SENT" });
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
      this.applyEvent(job.id, current.version, validationOutcome === "pass"
        ? { type: "VALIDATION_PASSED", headSha }
        : { type: "VALIDATION_FAILED", headSha, reason: "Validation did not pass" });
      return;
    }
    let result: ValidationSnapshot;
    try {
      result = await this.dependencies.runValidation(job, effect, this.dependencies.fence.signal);
      this.renewOperationFence(effect);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      this.assertFence();
      if (!this.dependencies.store.failPipelineStageAttempt({
        id: attempt.id,
        error: "Validation infrastructure failed",
        ownerId: this.dependencies.fence.ownerId,
        generation: this.dependencies.fence.generation,
        now: this.now(),
      })) throw new Error("executor lease was lost before validation failure persistence");
      const current = this.dependencies.store.getJob(job.id);
      if (current?.state === (final ? "final_validating" : "validating")) {
        this.applyEvent(job.id, current.version, {
          type: "FAILED",
          error: "Validation infrastructure failed",
        });
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
    const evidence = validationStageEvidence(result, job.policy);
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
      this.applyEvent(job.id, current.version, { type: "VALIDATION_PASSED", headSha: result.headSha });
    } else {
      this.applyEvent(job.id, current.version, {
        type: "VALIDATION_FAILED",
        headSha: fullSha(result.headSha) ? result.headSha : undefined,
        reason: "Validation did not pass",
      });
    }
  }

  /**
   * The owner is asked for a one-use approval unless they have already granted
   * this project a standing one. Auto-approval is recorded before the merge is
   * set in motion, so an unattended merge always has an audit row explaining
   * who authorised it — never the other way round.
   */
  private issueApproval(job: Job): void {
    if (!job.prHeadSha) throw new PermanentEffectError("approval requires an authoritative pull-request head");
    const grant = job.projectId === null ? null : this.dependencies.store.getMergeAuthority(job.projectId);
    const decision = decideAutoApproval({ job, grant });
    if (decision.outcome === "auto_approve" && job.projectId !== null) {
      // Re-read before transitioning: the job may have drifted since this
      // effect was dispatched, and merging a head the owner has since
      // superseded is exactly what a standing approval must not do.
      const current = this.dependencies.store.getJob(job.id);
      if (!current || current.state !== "awaiting_merge_approval" || current.prHeadSha !== job.prHeadSha) return;
      this.dependencies.store.recordMergeAuthorityUse({
        projectId: job.projectId,
        jobId: job.id,
        now: this.now(),
      });
      const merging = this.applyEvent(current.id, current.version, {
        type: "APPROVAL_ACCEPTED",
        headSha: job.prHeadSha,
      });
      this.enqueueStatus(merging, { autoApproved: true });
      return;
    }
    const approvals = this.dependencies.approvals ?? new ApprovalService(this.dependencies.store, { now: this.dependencies.now });
    const issued = approvals.issue(job.id, job.prHeadSha, this.now(), this.executorFence());
    this.enqueueStatus(job, {
      mergeNonce: issued.nonce,
      approvalExpiresAt: issued.expiresAt,
      mergeAuthorityGranted: grant !== null && grant.revokedAt === null,
      ...(decision.outcome === "ask_owner" ? { approvalReason: decision.reason } : {}),
    });
  }

  private applyProductionResult(job: Job, phase: ProductionPhase, result: ProductionStageSnapshot): void {
    const expectedState = phase === "deploy" ? "deploying" : "verifying_production";
    const current = this.dependencies.store.getJob(job.id);
    if (!current || current.state !== expectedState) return;
    if (result.outcome === "pass") {
      this.applyEvent(job.id, current.version, phase === "deploy"
        ? { type: "DEPLOY_SUCCEEDED", summary: result.summary }
        : { type: "CANARY_SUCCEEDED", summary: result.summary });
      return;
    }
    // A rollback that worked is a recovery: production is back, so unattended
    // merging continues. A rollback that was missing or itself failed means
    // recovery is exhausted, and nothing should merge here unattended again
    // until the owner has looked at it.
    if (job.projectId !== null && result.rollback?.outcome !== "pass") {
      this.dependencies.store.revokeMergeAuthority({
        projectId: job.projectId,
        reason: result.rollback
          ? `rollback failed after a bad ${phase}`
          : `production ${phase} failed with no rollback configured`,
        now: this.now(),
      });
    }
    this.applyEvent(job.id, current.version, phase === "deploy"
      ? { type: "DEPLOY_FAILED", reason: result.summary }
      : { type: "CANARY_FAILED", reason: result.summary });
  }

  private async runProduction(effect: StoredEffect, job: Job, phase: ProductionPhase): Promise<void> {
    if (!this.dependencies.runProductionStage) throw new PermanentEffectError("production runner is not configured");
    const environmentId = job.environmentId;
    if (!job.policy?.production || !environmentId || !job.mergeCommitSha || !job.mergeMessage || !job.mergedAt) {
      throw new PermanentEffectError("production stage requires configured policy, owned environment, and durable merge facts");
    }
    const role = phase === "deploy" ? "DEPLOY" as const : "CANARY" as const;
    const commands = phase === "deploy" ? job.policy.production.deployCommands : job.policy.production.canaryCommands;
    const expectedReceiptCount = commands.length + 1;
    if (!this.dependencies.store.assertProductionStageFence({
      jobId: job.id,
      effectIdempotencyKey: effect.idempotencyKey,
      ...this.executorFence(),
      now: this.now(),
    })) throw new Error("production claim fence was lost before stage attempt");
    const attempt = this.createPipelineAttempt(
      effect,
      job,
      role,
      stageInputSha(job.mergeCommitSha, job.mergedAt, JSON.stringify(commands)),
    );
    if (attempt.state === "completed") {
      let outcome: ProductionStageSnapshot;
      try {
        outcome = parseProductionStageSnapshot(attempt.outcome, phase);
      } catch {
        throw new PermanentEffectError("completed production stage has invalid durable evidence");
      }
      if (!productionReceiptCountIsValid(outcome, expectedReceiptCount)) {
        throw new PermanentEffectError("completed production stage receipt count is invalid");
      }
      this.applyProductionResult(job, phase, outcome);
      return;
    }
    if (effect.attempts > 1) {
      const reason = `Production ${phase} outcome is unknown after executor interruption`;
      if (!this.dependencies.store.failPipelineStageAttempt({
        id: attempt.id,
        error: reason,
        ownerId: this.dependencies.fence.ownerId,
        generation: this.dependencies.fence.generation,
        now: this.now(),
      })) throw new Error("executor lease was lost before production failure persistence");
      const current = this.dependencies.store.getJob(job.id);
      if (current?.state === (phase === "deploy" ? "deploying" : "verifying_production")) {
        this.applyEvent(job.id, current.version, phase === "deploy"
          ? { type: "DEPLOY_FAILED", reason }
          : { type: "CANARY_FAILED", reason });
      }
      return;
    }

    let resourceBound = attempt.resourceId !== null;
    const workerKind = phase === "deploy" ? "deploy" as const : "canary" as const;
    const terminalGenerations = new Map<string, number>();
    const generationBase = workerRegistrationGeneration(job, workerKind);
    const observe = (observation: TerminalObservation): void => {
      this.assertFence();
      this.renewOperationFence(effect);
      if (!resourceBound) {
        const bound = this.dependencies.store.bindPipelineStageResource({
          id: attempt.id,
          resourceKind: "bb_terminal",
          resourceId: observation.id,
          environmentId,
          ownerId: this.dependencies.fence.ownerId,
          generation: this.dependencies.fence.generation,
          now: this.now(),
        });
        if (!bound) throw new Error("production stage resource binding lost its executor fence");
        resourceBound = true;
      }
      const current = this.dependencies.store.getJob(job.id);
      const terminalGeneration = terminalGenerations.get(observation.id) ?? generationBase + terminalGenerations.size + 1;
      terminalGenerations.set(observation.id, terminalGeneration);
      if (current) {
        projectTerminalLiveness(
          this.dependencies.store,
          current,
          observation,
          workerKind,
          this.now(),
          terminalGeneration,
          this.executorFence(),
        );
      }
    };
    this.assertFence();
    if (!this.dependencies.store.assertProductionStageFence({
      jobId: job.id,
      effectIdempotencyKey: effect.idempotencyKey,
      ...this.executorFence(),
      now: this.now(),
    })) throw new Error("production claim fence was lost before provider mutation");
    const rawResult = await this.dependencies.runProductionStage(
      job,
      effect,
      phase,
      this.dependencies.fence.signal,
      observe,
    );
    this.renewOperationFence(effect);
    const result = parseProductionStageSnapshot(rawResult, phase);
    if (!productionReceiptCountIsValid(result, expectedReceiptCount)) {
      throw new PermanentEffectError("production stage receipt count is invalid");
    }
    this.assertFence();
    const outputText = JSON.stringify(result);
    if (Buffer.byteLength(outputText, "utf8") > 60_000) {
      throw new PermanentEffectError("production stage evidence exceeded its durable bound");
    }
    const completed = this.dependencies.store.completePipelineStageAttempt({
      id: attempt.id,
      outputText,
      outputSha256: createHash("sha256").update(outputText, "utf8").digest("hex"),
      outcome: result as unknown as Record<string, unknown>,
      startSha: job.mergeCommitSha,
      endSha: job.mergeCommitSha,
      ownerId: this.dependencies.fence.ownerId,
      generation: this.dependencies.fence.generation,
      now: this.now(),
    });
    if (!completed) throw new Error("production stage completion lost its executor fence");
    this.assertFence();
    this.applyProductionResult(job, phase, result);
  }

  private async stopThread(effect: StoredEffect, job: Job): Promise<void> {
    const bb = this.dependencies.bb;
    const payload = recordPayload(effect);
    const resourceId = typeof payload.resourceId === "string" ? payload.resourceId : this.dependencies.store.getWorkerLiveness(job.id)?.resourceId;
    if (!bb?.stopWorker || !resourceId) throw new PermanentEffectError("cancellation has no BB worker resource");
    const rawWorkers = payload.workers;
    if (rawWorkers !== undefined && (!Array.isArray(rawWorkers) || rawWorkers.length < 2 || rawWorkers.length > 4)) {
      throw new PermanentEffectError("cancellation worker group is invalid");
    }
    const targetRecords = rawWorkers === undefined ? [payload] : rawWorkers;
    const targets = targetRecords.map((candidate) => {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new PermanentEffectError("cancellation worker identity is invalid");
      }
      const target = candidate as Record<string, unknown>;
      if (typeof target.resourceId !== "string" || target.resourceId.length === 0 ||
        target.resourceKind !== "bb_thread" || typeof target.workerKind !== "string" ||
        !Number.isInteger(target.generation) || Number(target.generation) < 1) {
        throw new PermanentEffectError("cancellation worker identity is invalid");
      }
      return {
        resourceId: target.resourceId,
        resourceKind: target.resourceKind,
        workerKind: target.workerKind,
        generation: Number(target.generation),
      };
    });
    if (new Set(targets.map((target) => target.resourceId)).size !== targets.length ||
      targets[0]?.resourceId !== resourceId) {
      throw new PermanentEffectError("cancellation worker group identity is invalid");
    }
    const workers = targets.map((target) => {
      const worker = this.dependencies.store.getWorkerLivenessForResource(job.id, target.resourceId);
      if (!worker || worker.resourceKind !== target.resourceKind || worker.workerKind !== target.workerKind ||
        worker.generation !== target.generation || worker.state === "unknown" || worker.state === "stale") {
        throw new PermanentEffectError("cancellation requires fresh BB worker evidence");
      }
      return worker;
    });
    for (const worker of workers) {
      if (worker.state === "idle" || worker.state === "failed") continue;
      await bb.stopWorker(worker);
      this.renewOperationFence(effect);
    }
    const maxChecks = 4;
    const unsettled = new Set(workers
      .filter((worker) => worker.state !== "idle" && worker.state !== "failed")
      .map((worker) => worker.resourceId));
    for (let check = 0; check < maxChecks; check += 1) {
      this.assertFence();
      const current = this.dependencies.store.getJob(job.id);
      if (!current || current.cancelRequestedAt === null) return;
      if (!bb.getThread) break;
      for (const worker of workers) {
        if (!unsettled.has(worker.resourceId)) continue;
        try {
          const thread = await bb.getThread(worker.resourceId);
          this.renewOperationFence(effect);
          const latest = this.dependencies.store.getJob(job.id);
          if (!latest || latest.cancelRequestedAt === null) return;
          const projected = projectWorkerLiveness(
            this.dependencies.store,
            latest,
            thread,
            this.now(),
            worker.workerKind,
            worker.generation,
            this.executorFence(),
          );
          if (projected.state === "idle" || projected.state === "failed") unsettled.delete(worker.resourceId);
        } catch {
          this.renewOperationFence(effect);
        }
      }
      if (unsettled.size === 0) {
        this.assertFence();
        const confirmed = this.dependencies.store.getJob(job.id);
        if (confirmed && confirmed.cancelRequestedAt !== null &&
          confirmed.state !== "blocked" && confirmed.state !== "cancelled") {
          this.applyEvent(confirmed.id, confirmed.version, { type: "CANCEL_CONFIRMED" });
        }
        return;
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
      this.applyEvent(unresolved.id, unresolved.version, {
        type: "CANCELLATION_UNCONFIRMED",
        reason: "Cancellation could not be confirmed while the BB worker remained active or stopping",
      });
    }
  }

  private async recoverWorker(effect: StoredEffect, job: Job): Promise<void> {
    const payload = recordPayload(effect);
    const recoveryId = textPayload(effect, "recoveryId");
    const resourceId = textPayload(effect, "resourceId");
    const classification = payload.classification;
    if (!this.dependencies.bb?.retireWorker) {
      throw new PermanentEffectError("worker recovery runner is not configured");
    }
    const recovery = this.dependencies.store.getWorkerRecovery(recoveryId);
    if (!recovery || recovery.jobId !== job.id || recovery.resourceId !== resourceId ||
      recovery.action !== "auto_retry" || recovery.state !== "retiring") {
      throw new PermanentEffectError("worker recovery receipt does not match the active job");
    }
    const retryPayload = payload.retryPayload !== null && typeof payload.retryPayload === "object" && !Array.isArray(payload.retryPayload)
      ? payload.retryPayload as Record<string, unknown>
      : {};
    const rawSiblingResources = retryPayload.retireResourceIds;
    if (rawSiblingResources !== undefined && (
      !Array.isArray(rawSiblingResources) || rawSiblingResources.length > 4 ||
      rawSiblingResources.some((candidate) => typeof candidate !== "string" || candidate.length === 0 || candidate === resourceId)
    )) throw new PermanentEffectError("worker recovery sibling resources are invalid");
    const siblingResources = rawSiblingResources === undefined
      ? []
      : [...new Set(rawSiblingResources as string[])];
    this.assertFence();
    await this.dependencies.bb.retireWorker(resourceId, classification === "missing");
    this.renewOperationFence(effect);
    for (const siblingResourceId of siblingResources) {
      this.assertFence();
      await this.dependencies.bb.retireWorker(siblingResourceId, true);
      this.renewOperationFence(effect);
    }
    const current = this.dependencies.store.getJob(job.id);
    if (!current || current.state !== "recovering_worker") return;
    this.applyEvent(job.id, current.version, {
      type: "WORKER_RECOVERY_REQUEUED",
      recoveryId,
      retryPayload,
    });
  }

  private async reconcile(effect: StoredEffect, job: Job): Promise<void> {
    if (this.dependencies.reconcileJob) {
      const payload = recordPayload(effect);
      const resourceId = typeof payload.threadId === "string" ? payload.threadId : undefined;
      await this.dependencies.reconcileJob(job, this.dependencies.fence.signal, this.dependencies.fence, resourceId);
      this.renewOperationFence(effect);
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
        this.renewOperationFence(effect);
        const latest = this.dependencies.store.getJob(job.id) ?? current;
        const worker = this.dependencies.store.getWorkerLivenessForResource(job.id, resourceId);
        projectWorkerLiveness(
          this.dependencies.store,
          latest,
          thread,
          this.now(),
          worker?.resourceId === resourceId ? worker.workerKind : undefined,
          worker?.resourceId === resourceId ? worker.generation : undefined,
          this.executorFence(),
        );
      } catch {
        this.renewOperationFence(effect);
        const latest = this.dependencies.store.getJob(job.id) ?? current;
        const worker = this.dependencies.store.getWorkerLivenessForResource(job.id, resourceId);
        projectUnknownWorker(
          this.dependencies.store,
          latest,
          resourceId,
          this.now(),
          worker?.resourceId === resourceId ? worker.workerKind : undefined,
          worker?.resourceId === resourceId ? worker.generation : undefined,
          this.executorFence(),
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
        await this.inspectImplementation(effect, job);
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
        if (this.dependencies.store.revokeExecutorApprovals({
          jobId: job.id,
          reason: "Approval revoked by job reconciliation",
          ...this.executorFence(),
        }) === null) throw new Error("executor lease was lost before approval revocation");
        return;
      case "merge_pr":
        if (!this.dependencies.mergeHandler) throw new PermanentEffectError("merge handler is not configured");
        await this.dependencies.mergeHandler.executeMergeEffect({
          effect,
          leaseOwner: this.dependencies.fence.ownerId,
          leaseGeneration: this.dependencies.fence.generation,
        });
        return;
      case "deploy_production":
        await this.runProduction(effect, job, "deploy");
        return;
      case "verify_production":
        await this.runProduction(effect, job, "canary");
        return;
      case "recover_worker":
        await this.recoverWorker(effect, job);
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
        await this.reconcile(effect, job);
        return;
      default: {
        const unreachable: never = effect.kind;
        throw new PermanentEffectError(`Unknown effect kind: ${String(unreachable)}`);
      }
    }
  }
}
