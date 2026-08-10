import type { Job, JobEffect, ReviewFinding, StoredEffect, WorkerLiveness } from "../domain/models";
import { ApprovalService } from "./approval-service";
import type { BbAttempt, EnvironmentSnapshot } from "../bb/runner";
import type { TerminalCommandRunner } from "../bb/terminal-command";
import { ValidationError, type ValidationSnapshot } from "../bb/validation";
import { persistableJobStatusPayload, renderJobStatus } from "../telegram/view";
import type {
  AttemptRecord,
  OutboxInput,
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
  spawnImplementation?(job: Job, attempt: BbAttempt): Promise<{ id: string; environmentId?: string | null }>;
  spawnReview?(job: Job, attempt: BbAttempt): Promise<{ id: string; environmentId?: string | null }>;
  sendRemediation?(job: Job, findings: ReviewFinding[]): Promise<void>;
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
    case "spawn_implementation": return ["creating_implementation"];
    case "inspect_implementation": return ["implementing", "locating_pr"];
    case "resolve_pr_head": return ["resolving_pr_head"];
    case "spawn_review": return ["reviewing"];
    case "send_remediation": return ["remediating"];
    case "run_validation": return ["validating"];
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
  "spawn_implementation",
  "inspect_implementation",
  "resolve_pr_head",
  "spawn_review",
  "send_remediation",
  "run_validation",
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
    const expectedTitle = `Telegram ${job.id} ${kind} ${attempt.id}`;
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
    const spawn = kind === "implementation" ? bb.spawnImplementation : bb.spawnReview;
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
    if (!current || current.state !== "resolving_pr_head") return;
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
    if (this.dependencies.bb?.sendRemediation) await this.dependencies.bb.sendRemediation(job, findings);
    else if (this.dependencies.bb?.sendSteering && job.implementationThreadId) {
      await this.dependencies.bb.sendSteering(job.implementationThreadId, textPayload(effect, "summary"));
    } else throw new PermanentEffectError("remediation runner is not configured");
    this.assertFence();
    const current = this.dependencies.store.getJob(job.id);
    if (current?.state === "remediating") this.dependencies.store.applyJobEvent(job.id, current.version, { type: "REMEDIATION_SENT" }, this.now());
  }

  private async runValidation(effect: StoredEffect, job: Job): Promise<void> {
    if (!this.dependencies.runValidation) throw new PermanentEffectError("validation runner is not configured");
    let result: ValidationSnapshot;
    try {
      result = await this.dependencies.runValidation(job, effect, this.dependencies.fence.signal);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      this.assertFence();
      const current = this.dependencies.store.getJob(job.id);
      if (current?.state === "validating") {
        this.dependencies.store.applyJobEvent(job.id, current.version, {
          type: "VALIDATION_FAILED",
          headSha: current.prHeadSha ?? undefined,
          reason: error.message,
        }, this.now());
      }
      return;
    }
    this.assertFence();
    const current = this.dependencies.store.getJob(job.id);
    if (!current || current.state !== "validating") return;
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
