import type { BbPluginApi } from "@bb/plugin-sdk";
import type { Job, ProjectPolicy, WorkerLiveness } from "../domain/models";
import { buildWorkerThreadTitle } from "../agent-skills/role-resolver";
import {
  buildReviewPacket,
  buildWorkOrder,
  type CapabilityWorkOrderEnvelope,
  type HandoffArtifact,
} from "./handoffs";
import {
  buildCritiqueArtifact,
  buildCritiquePacket,
  buildDocsPacket,
  buildPlanArtifact,
  parseCritiqueResult,
} from "./pipeline-handoffs";
import {
  buildImplementationInstruction,
  buildAdoptedPrInstruction,
  buildRemediationPrompt,
  buildReviewInstruction,
  type ReviewFinding,
} from "./prompts";
import { TerminalCommandRunner } from "./terminal-command";
import { assertSharedTrunkAncestry } from "./worktree-ancestry";
import type { ModelRoute } from "../capabilities/models";
import { jobStageExecution } from "../domain/stage-routing";
import {
  resolveConsensusExecution,
  stageExecutionSpawnArgs,
  type PipelineStage,
  type StageTokenUsage,
} from "../domain/stage-execution";

type BbSdk = BbPluginApi["sdk"];
type SpawnArgs = Parameters<BbSdk["threads"]["spawn"]>[0];
type ThreadResult = Awaited<ReturnType<BbSdk["threads"]["spawn"]>>;
type EnvironmentStatus = Awaited<ReturnType<BbSdk["environments"]["status"]>>;
type EnvironmentDiff = Awaited<ReturnType<BbSdk["environments"]["diff"]>>;
type PullRequestSnapshot = Awaited<ReturnType<BbSdk["environments"]["pullRequest"]>>;
type UploadedLocalFile = {
  type: "localFile";
  path: string;
  name?: string;
  sizeBytes?: number;
  mimeType?: string;
};

export const PROGRESS_SCRATCHPAD_COMMAND = [
  'exclude_path="$(git rev-parse --git-path info/exclude)"',
  'mkdir -p "$(dirname "$exclude_path")"',
  'grep -qxF "/PROGRESS.md" "$exclude_path" || printf "\\n/PROGRESS.md\\n" >> "$exclude_path"',
  'if [ ! -f PROGRESS.md ]; then printf "# Progress\\n\\n## Current state\\n- Work has not started.\\n\\n## Next step\\n- Read the work order and inspect the repository.\\n" > PROGRESS.md; fi',
  "git check-ignore -q PROGRESS.md",
].join(" && ");

export type BbAttempt = {
  id: string;
  kind?: "implementation" | "review" | "validation";
  ordinal?: number;
  threadId?: string | null;
  handoffPath?: string | null;
  handoffSha256?: string | null;
  reviewLens?: "quality" | "risk" | "consensus" | null;
  capabilityProfile?: CapabilityWorkOrderEnvelope;
};

export type PipelineThreadAttempt = {
  id: string;
  role: "PLAN" | "CRITIQUE" | "DOCS";
  ordinal: number;
  threadId?: string | null;
  environmentId?: string | null;
  outputText?: string | null;
  capabilityProfile?: CapabilityWorkOrderEnvelope;
};

export type EnvironmentSnapshot = {
  status: EnvironmentStatus;
  diff: EnvironmentDiff;
};

function selectedPolicy(job: Job): ProjectPolicy {
  if (job.policy === null) throw new TypeError("Active job has no immutable policy snapshot");
  return job.policy;
}

function projectId(job: Job, policy: ProjectPolicy): string {
  if (job.projectId === null || job.projectId !== policy.projectId) {
    throw new TypeError("Active job project does not match its policy snapshot");
  }
  return job.projectId;
}

/**
 * The stage's execution tuple, resolved from the project's own per-stage table
 * with the declared tiered defaults behind it. Pipeline workers pin their own
 * tuple: retuning the conversational controller must never silently change how
 * plans, critiques, reviews, and docs are produced.
 */
function stageExecutionArgs(
  job: Job,
  policy: ProjectPolicy,
  stage: PipelineStage,
  attemptOrdinal: number | undefined,
  capabilityRoute?: ModelRoute,
): Record<string, unknown> {
  return stageExecutionSpawnArgs(jobStageExecution({ job, policy, stage, attemptOrdinal, capabilityRoute }));
}

/**
 * A consensus pass never escalates, never inherits the review stage's route,
 * and never takes the capability router's model: its whole value is being a
 * different reader of the same code. The executor resolves the same route
 * before it decides a pass is possible, so an unresolvable one here means the
 * two disagreed and the spawn must fail rather than quietly re-review on the
 * model that already approved this change.
 */
function consensusExecutionArgs(policy: ProjectPolicy): Record<string, unknown> {
  const execution = resolveConsensusExecution({
    ...(policy.stageExecution === undefined ? {} : { stageExecution: policy.stageExecution }),
    legacy: { implementation: policy.implementation, review: policy.review },
    ...(policy.autonomy?.consensusReview === undefined
      ? {}
      : { consensusReview: policy.autonomy.consensusReview }),
  });
  if (execution === null) throw new Error("Consensus review has no independent route to run on");
  return stageExecutionSpawnArgs(execution);
}

function workerExecutionArgs(
  job: Job,
  attempt: BbAttempt,
  policy: ProjectPolicy,
  stage: Extract<PipelineStage, "implementation" | "review">,
): Record<string, unknown> {
  if (job.routingMode !== "active") return stageExecutionArgs(job, policy, stage, attempt.ordinal);
  const capability = attempt.capabilityProfile;
  if (!capability?.model) throw new TypeError("Active worker dispatch is missing its persisted model route");
  return stageExecutionArgs(job, policy, stage, attempt.ordinal, capability.model);
}

function pipelineExecutionArgs(
  job: Job,
  attempt: PipelineThreadAttempt,
  policy: ProjectPolicy,
  stage: Extract<PipelineStage, "plan" | "critique" | "docs">,
): Record<string, unknown> {
  if (job.routingMode !== "active") return stageExecutionArgs(job, policy, stage, attempt.ordinal);
  const capability = attempt.capabilityProfile;
  if (!capability?.model) throw new TypeError("Active pipeline dispatch is missing its persisted model route");
  return stageExecutionArgs(job, policy, stage, attempt.ordinal, capability.model);
}

function recordHandoff(attempt: BbAttempt, artifact: HandoffArtifact, uploaded: { path: string }): void {
  attempt.handoffPath = uploaded.path;
  attempt.handoffSha256 = artifact.sha256;
}

function requireEnvironmentId(job: Job): string {
  if (job.environmentId === null) throw new TypeError("Active job has no implementation environment");
  return job.environmentId;
}

function requireImplementationThreadId(job: Job): string {
  if (job.implementationThreadId === null) throw new TypeError("Active job has no implementation thread");
  return job.implementationThreadId;
}

export function environmentDiffText(snapshot: EnvironmentDiff): string | null {
  if (snapshot.outcome !== "available") return null;
  if (snapshot.diff.truncated) return null;
  return snapshot.diff.diff;
}

function spawnRequest(request: Record<string, unknown>): SpawnArgs {
  return request as unknown as SpawnArgs;
}

/**
 * What a stage should be told about the specifications governing its project.
 * Injected rather than read here so the runner keeps its one dependency, and so
 * a project with nothing filed costs nothing.
 */
export type ReferenceBriefingProvider = (projectId: string) => string;

export class BbRunner {
  /** Environments already proven to share history with a given trunk. */
  private readonly ancestryChecked = new Set<string>();

  public constructor(
    public readonly sdk: BbSdk,
    private readonly referenceBriefing: ReferenceBriefingProvider = () => "",
  ) {}

  /** The stage instruction, with the specification briefing when there is one. */
  private withReferenceBriefing(instruction: string, project: string): string {
    const briefing = this.referenceBriefing(project);
    return briefing.length === 0 ? instruction : `${instruction}\n\n${briefing}`;
  }

  /**
   * Refuses to go on when the worktree was cut from a history that can never
   * reach `trunk`. Checked once per environment and trunk; a worktree cannot
   * change its root commit underneath us.
   */
  public async assertWorktreeSharesTrunk(
    environmentId: string,
    trunk: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = `${environmentId} ${trunk}`;
    if (this.ancestryChecked.has(key)) return;
    const verdict = await assertSharedTrunkAncestry({
      runner: new TerminalCommandRunner(this.sdk),
      environmentId,
      trunk,
      signal,
    });
    if (verdict.kind === "shared") this.ancestryChecked.add(key);
  }

  private async resolveProjectHost(projectId: string): Promise<string> {
    const projects = await this.sdk.projects.list();
    const project = projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new Error("Selected BB project is unavailable");
    if (project.kind !== "standard") throw new Error("Implementation requires a standard BB project");

    const defaultSource = project.sources.find((source) => source.isDefault);
    const source = defaultSource ?? (project.sources.length === 1 ? project.sources[0] : undefined);
    if (source === undefined) throw new Error("Selected BB project has no unambiguous workspace source");
    if (source.hostId.trim().length === 0) throw new Error("Selected BB project source has no host");
    return source.hostId;
  }

  private async upload(project: string, artifact: HandoffArtifact): Promise<UploadedLocalFile> {
    const uploaded = await this.sdk.projects.attachments.upload({
      projectId: project,
      clientFile: artifact.bytes,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
    });
    if (uploaded.type !== "localFile") throw new Error("BB attachment upload did not return a local file");
    return { ...uploaded, type: "localFile" };
  }

  public async prepareProgressScratchpad(environmentId: string): Promise<void> {
    if (typeof environmentId !== "string" || environmentId.length === 0) {
      throw new TypeError("Implementation environment id is required");
    }
    const result = await new TerminalCommandRunner(this.sdk).run({
      scope: { kind: "environment", environmentId },
      title: "Prepare implementation progress scratchpad",
      command: PROGRESS_SCRATCHPAD_COMMAND,
      timeoutMs: 60_000,
    });
    if (result.outcome !== "exited" || result.exitCode !== 0) {
      throw new Error("Implementation progress scratchpad could not be prepared safely");
    }
  }

  public async spawnImplementation(
    job: Job,
    attempt: BbAttempt,
    _suppliedPolicy?: ProjectPolicy,
  ): Promise<ThreadResult> {
    const policy = selectedPolicy(job);
    const artifact = buildWorkOrder(job, policy, attempt.capabilityProfile);
    const project = projectId(job, policy);
    const hostId = await this.resolveProjectHost(project);
    const uploaded = await this.upload(project, artifact);
    recordHandoff(attempt, artifact, uploaded);
    const adopted = job.origin === "adopted_pr";
    if (adopted && (!job.adoptedBranch || !job.adoptedHeadSha || job.prHeadSha !== job.adoptedHeadSha)) {
      throw new TypeError("Adopted implementation requires its verified branch and exact immutable head");
    }
    const request = spawnRequest({
      projectId: project,
      title: buildWorkerThreadTitle({ jobId: job.id, attemptId: attempt.id, role: "implementation" }),
      visibility: "hidden",
      input: [
        {
          type: "text",
          text: this.withReferenceBriefing(
            adopted
              ? buildAdoptedPrInstruction(artifact, job.adoptedHeadSha!)
              : buildImplementationInstruction(artifact),
            project,
          ),
          mentions: [],
        },
        uploaded,
      ],
      environment: {
        type: "host",
        hostId,
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "named", name: adopted ? job.adoptedBranch! : policy.baseBranch },
        },
      },
      ...workerExecutionArgs(job, attempt, policy, "implementation"),
    });
    const thread = await this.sdk.threads.spawn(request);
    attempt.threadId = thread.id;
    return thread;
  }

  public async spawnPlanner(
    job: Job,
    attempt: PipelineThreadAttempt,
    previousCritique?: string | null,
  ): Promise<ThreadResult> {
    const policy = selectedPolicy(job);
    const project = projectId(job, policy);
    const workOrder = buildWorkOrder(job, policy, attempt.capabilityProfile);
    const revisionText = previousCritique?.trim();
    const critique = revisionText ? buildCritiqueArtifact(parseCritiqueResult(revisionText)) : null;
    const uploadedWorkOrder = await this.upload(project, workOrder);
    const uploadedCritique = critique ? await this.upload(project, critique) : null;
    const prompt = revisionText
      ? "Read the attached immutable work order and critique artifact. Return only the complete replacement implementation and verification plan as Markdown. Include a ## Verification section containing the exact table or explicit skip line required by the work order. Do not edit files, commit, push, create a pull request, merge, or deploy."
      : "Read the attached immutable work order and produce a concrete, bounded implementation and verification plan as Markdown. Include a ## Verification section containing the exact table or explicit skip line required by the work order. Do not edit files, commit, push, create a pull request, merge, or deploy.";
    const environment = job.environmentId
      ? { type: "reuse", environmentId: job.environmentId }
      : {
          type: "host",
          hostId: await this.resolveProjectHost(project),
          workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: policy.baseBranch } },
        };
    const thread = await this.sdk.threads.spawn(spawnRequest({
      projectId: project,
      title: buildWorkerThreadTitle({ jobId: job.id, attemptId: attempt.id, role: "planner" }),
      visibility: "hidden",
      input: [
        { type: "text", text: this.withReferenceBriefing(prompt, project), mentions: [] },
        uploadedWorkOrder,
        ...(uploadedCritique ? [uploadedCritique] : []),
      ],
      environment,
      ...pipelineExecutionArgs(job, attempt, policy, "plan"),
    }));
    attempt.threadId = thread.id;
    attempt.environmentId = thread.environmentId;
    return thread;
  }

  public async spawnCritic(
    job: Job,
    attempt: PipelineThreadAttempt,
    planAttempt: PipelineThreadAttempt,
  ): Promise<ThreadResult> {
    const policy = selectedPolicy(job);
    const project = projectId(job, policy);
    const environmentId = planAttempt.environmentId ?? job.environmentId;
    if (!environmentId) throw new TypeError("Critique requires the planning environment");
    if (planAttempt.environmentId && job.environmentId && planAttempt.environmentId !== job.environmentId) {
      throw new TypeError("Critique plan environment does not match the active job");
    }
    if (!planAttempt.threadId) throw new TypeError("Critique requires the planner thread identity");
    if (!planAttempt.outputText) throw new TypeError("Critique requires completed planner output");
    const workOrder = buildWorkOrder(job, policy, attempt.capabilityProfile);
    const plan = buildPlanArtifact(planAttempt.outputText);
    const packet = buildCritiquePacket(job, plan);
    const uploadedWorkOrder = await this.upload(project, workOrder);
    const uploadedPlan = await this.upload(project, plan);
    const uploadedPacket = await this.upload(project, packet);
    const thread = await this.sdk.threads.spawn(spawnRequest({
      projectId: project,
      parentThreadId: planAttempt.threadId,
      title: buildWorkerThreadTitle({ jobId: job.id, attemptId: attempt.id, role: "critic" }),
      visibility: "hidden",
      input: [
        {
          type: "text",
          text: this.withReferenceBriefing(
            "Read the attached immutable work order, plan, and critique contract. Assess the plan independently and return strict JSON only. Request revision only for missing outcome, unbounded scope, missing verification, or an unimplementable plan. Do not request revision for polish or for commit, push, or pull-request steps. Do not inspect the planner conversation or edit files.",
            project,
          ),
          mentions: [],
        },
        uploadedWorkOrder,
        uploadedPlan,
        uploadedPacket,
      ],
      environment: { type: "reuse", environmentId },
      ...pipelineExecutionArgs(job, attempt, policy, "critique"),
    }));
    attempt.threadId = thread.id;
    attempt.environmentId = thread.environmentId ?? environmentId;
    return thread;
  }

  public async spawnBuilderFromPlan(
    job: Job,
    attempt: BbAttempt,
    planAttempt: PipelineThreadAttempt,
  ): Promise<ThreadResult> {
    const policy = selectedPolicy(job);
    const project = projectId(job, policy);
    const environmentId = planAttempt.environmentId ?? job.environmentId;
    if (!environmentId) throw new TypeError("Builder requires the planning environment");
    if (planAttempt.environmentId && job.environmentId && planAttempt.environmentId !== job.environmentId) {
      throw new TypeError("Builder plan environment does not match the active job");
    }
    if (!planAttempt.threadId || !planAttempt.outputText) {
      throw new TypeError("Builder requires a completed plan attempt");
    }
    const workOrder = buildWorkOrder(job, policy, attempt.capabilityProfile);
    const plan = buildPlanArtifact(planAttempt.outputText);
    const uploadedWorkOrder = await this.upload(project, workOrder);
    const uploadedPlan = await this.upload(project, plan);
    recordHandoff(attempt, workOrder, uploadedWorkOrder);
    const thread = await this.sdk.threads.spawn(spawnRequest({
      projectId: project,
      parentThreadId: planAttempt.threadId,
      title: buildWorkerThreadTitle({ jobId: job.id, attemptId: attempt.id, role: "implementation" }),
      visibility: "hidden",
      input: [
        {
          type: "text",
          text: this.withReferenceBriefing(
            `Read the attached immutable work order ${workOrder.filename}, plan ${plan.filename}, and the gitignored PROGRESS.md scratchpad. Keep PROGRESS.md current after meaningful milestones so a replacement worker can continue. Follow both attachments, implement the requested change, verify it, and report the required outcome. Do not commit, push, or open a pull request.`,
            project,
          ),
          mentions: [],
        },
        uploadedWorkOrder,
        uploadedPlan,
      ],
      environment: { type: "reuse", environmentId },
      ...workerExecutionArgs(job, attempt, policy, "implementation"),
    }));
    attempt.threadId = thread.id;
    return thread;
  }

  /**
   * The tokens a worker thread actually consumed. BB reports a running total on
   * `thread/tokenUsage/updated`, so the last such event is the thread's total.
   * Returns null when the provider reported no usage at all, which is recorded
   * as "not measured" rather than as zero.
   */
  public async readThreadUsage(threadId: string): Promise<StageTokenUsage | null> {
    if (!threadId) throw new TypeError("threadId must not be empty");
    let afterSeq = 0;
    let usage: StageTokenUsage | null = null;
    for (let page = 0; page < USAGE_EVENT_PAGES; page += 1) {
      const rows = await this.sdk.threads.events.list({
        threadId,
        afterSeq: String(afterSeq),
        limit: String(USAGE_EVENT_PAGE_LIMIT),
      });
      for (const row of rows) {
        afterSeq = Math.max(afterSeq, row.seq);
        if (row.type !== "thread/tokenUsage/updated") continue;
        const total = row.data.tokenUsage.total;
        if (!Number.isFinite(total.totalTokens)) continue;
        if (usage !== null && total.totalTokens < usage.totalTokens) continue;
        usage = {
          inputTokens: nonNegative(total.inputTokens),
          cachedInputTokens: nonNegative(total.cachedInputTokens),
          outputTokens: nonNegative(total.outputTokens),
          reasoningOutputTokens: nonNegative(total.reasoningOutputTokens),
          totalTokens: nonNegative(total.totalTokens),
        };
      }
      if (rows.length < USAGE_EVENT_PAGE_LIMIT) break;
    }
    return usage;
  }

  public async getThreadOutput(threadId: string): Promise<string> {
    if (!threadId) throw new TypeError("threadId must not be empty");
    const result = await this.sdk.threads.output({ threadId });
    return result.output ?? "";
  }

  /**
   * The newest event sequence past `afterSeq`, or `afterSeq` when nothing new
   * arrived. One page suffices: the liveness watchdog only asks whether the
   * provider moved at all since the last poll, not how far.
   */
  public async latestThreadEventSeq(threadId: string, afterSeq: number): Promise<number> {
    if (!threadId) throw new TypeError("threadId must not be empty");
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new TypeError("afterSeq must be a non-negative integer");
    const rows = await this.sdk.threads.events.list({
      threadId,
      afterSeq: String(afterSeq),
      limit: String(USAGE_EVENT_PAGE_LIMIT),
    });
    let latest = afterSeq;
    for (const row of rows) latest = Math.max(latest, row.seq);
    return latest;
  }

  public async spawnDocs(job: Job, attempt: PipelineThreadAttempt): Promise<ThreadResult> {
    const policy = selectedPolicy(job);
    const project = projectId(job, policy);
    const environmentId = requireEnvironmentId(job);
    const parentThreadId = requireImplementationThreadId(job);
    const workOrder = buildWorkOrder(job, policy, attempt.capabilityProfile);
    const packet = buildDocsPacket(job);
    const uploadedWorkOrder = await this.upload(project, workOrder);
    const uploadedPacket = await this.upload(project, packet);
    const thread = await this.sdk.threads.spawn(spawnRequest({
      projectId: project,
      parentThreadId,
      title: buildWorkerThreadTitle({ jobId: job.id, attemptId: attempt.id, role: "documentation" }),
      visibility: "hidden",
      input: [
        {
          type: "text",
          text: this.withReferenceBriefing(
            "Read the attached work order and docs packet. Use the docs-guard and verification-before-completion skills exactly as required, update only necessary documentation, verify it, and return exactly one strict JSON object matching the docs packet output contract. Do not use Markdown fences or commentary. Do not commit, push, merge, or deploy — the executor publishes leftover documentation changes.",
            project,
          ),
          mentions: [],
        },
        uploadedWorkOrder,
        uploadedPacket,
      ],
      environment: { type: "reuse", environmentId },
      ...pipelineExecutionArgs(job, attempt, policy, "docs"),
    }));
    attempt.threadId = thread.id;
    attempt.environmentId = thread.environmentId ?? environmentId;
    return thread;
  }

  public async spawnReview(
    job: Job,
    attempt: BbAttempt,
    _suppliedPolicy?: ProjectPolicy,
  ): Promise<ThreadResult> {
    return this.spawnReviewRole(job, attempt, "review");
  }

  public async spawnFinalReview(job: Job, attempt: BbAttempt): Promise<ThreadResult> {
    return this.spawnReviewRole(job, attempt, "final-review");
  }

  /**
   * The second opinion on an already-passed change. Same worker contract as a
   * final review, on a route the job's own reviewer did not use: running it on
   * the same model would agree with itself and prove nothing.
   */
  public async spawnConsensusReview(job: Job, attempt: BbAttempt): Promise<ThreadResult> {
    return this.spawnReviewRole(job, attempt, "final-review", true);
  }

  private async spawnReviewRole(
    job: Job,
    attempt: BbAttempt,
    role: "review" | "final-review",
    consensus = false,
  ): Promise<ThreadResult> {
    const policy = selectedPolicy(job);
    const environmentId = requireEnvironmentId(job);
    const parentThreadId = requireImplementationThreadId(job);
    const snapshot = await this.getEnvironmentSnapshot(environmentId, policy.baseBranch);
    const pullRequest = await this.getPullRequestSnapshot(environmentId);
    requirePullRequestSnapshot(job, pullRequest);
    if (job.prHeadSha === null) throw new Error("Active job has no authoritative review head SHA");
    const remoteHeadSha = job.prHeadSha;
    const reviewDiff = await this.reviewDiff(environmentId, job, snapshot.diff);
    const artifact = buildReviewPacket(
      job,
      policy,
      remoteHeadSha,
      reviewDiff.diff,
      attempt.reviewLens ?? "quality",
      attempt.capabilityProfile,
      job.taskRecipe === "architectural"
        ? role === "final-review" ? "integrated-review" : "task-review"
        : job.taskRecipe === "direct" ? "diff-guards" : "review",
      reviewDiff.source,
    );
    const project = projectId(job, policy);
    const uploaded = await this.upload(project, artifact);
    recordHandoff(attempt, artifact, uploaded);
    const request = spawnRequest({
      projectId: project,
      parentThreadId,
      title: buildWorkerThreadTitle({ jobId: job.id, attemptId: attempt.id, role }),
      visibility: "hidden",
      input: [
        {
          type: "text",
          text: this.withReferenceBriefing(buildReviewInstruction(artifact), project),
          mentions: [],
        },
        uploaded,
      ],
      environment: { type: "reuse", environmentId },
      ...(consensus ? consensusExecutionArgs(policy) : workerExecutionArgs(job, attempt, policy, "review")),
    });
    const thread = await this.sdk.threads.spawn(request);
    attempt.threadId = thread.id;
    return thread;
  }

  public async sendRemediation(job: Job, findings: ReviewFinding[], reasons: string[] = []): Promise<void> {
    await this.sendSteering(requireImplementationThreadId(job), buildRemediationPrompt(job, findings, reasons));
  }

  public async sendSteering(threadId: string, text: string): Promise<void> {
    await this.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
  }

  public async stopWorker(worker: string | WorkerLiveness): Promise<void> {
    if (
      typeof worker === "string" ||
      worker === null ||
      worker.resourceKind !== "bb_thread" ||
      !STOPPABLE_WORKER_STATES.has(worker.state) ||
      typeof worker.resourceId !== "string" ||
      worker.resourceId.length === 0
    ) {
      throw new TypeError("Stopping requires starting, active, or stopping BB-thread evidence");
    }
    await this.sdk.threads.stop({ threadId: worker.resourceId });
  }

  public async retireWorker(resourceId: string, allowMissing: boolean): Promise<void> {
    if (typeof resourceId !== "string" || resourceId.length === 0) {
      throw new TypeError("Worker resource id is required");
    }
    try {
      await this.sdk.threads.stop({ threadId: resourceId });
      return;
    } catch (stopError) {
      try {
        const thread = await this.sdk.threads.get({ threadId: resourceId });
        const display = thread.runtime.displayStatus;
        if (thread.status === "idle" || thread.status === "error" || display === "idle" || display === "error") return;
      } catch {
        if (allowMissing) return;
      }
      throw stopError;
    }
  }

  public async getThread(threadId: string): Promise<Awaited<ReturnType<BbSdk["threads"]["get"]>>> {
    return this.sdk.threads.get({ threadId });
  }

  public async getEnvironmentSnapshot(environmentId: string, mergeBaseBranch: string): Promise<EnvironmentSnapshot> {
    const status = await this.sdk.environments.status({ environmentId, mergeBaseBranch });
    const diff = await this.sdk.environments.diff({ environmentId, target: "all", mergeBaseBranch });
    return { status, diff };
  }

  public async getPullRequestSnapshot(environmentId: string): Promise<PullRequestSnapshot> {
    return this.sdk.environments.pullRequest({ environmentId });
  }

  /**
   * The diff a reviewer reads, with where it came from.
   *
   * GitHub's own pull-request diff is preferred whenever the job has one: it
   * is computed against the true remote base, which is also exactly what a
   * merge would land. The environment diff reads against the worktree's local
   * base ref, and a stale one once served a reviewer nine thousand lines of
   * main's own history as if this job had written them — every cycle of that
   * review demanded out-of-scope fixes until the job hit its review limit.
   * The local diff remains the answer for a job that has no pull request yet.
   */
  private async reviewDiff(
    environmentId: string,
    job: Job,
    snapshot: EnvironmentDiff,
  ): Promise<{ diff: string; source: string }> {
    if (job.prNumber !== null) {
      const command = `gh pr diff ${String(job.prNumber)}`;
      try {
        const result = await new TerminalCommandRunner(this.sdk).run({
          scope: { kind: "environment", environmentId },
          title: `Telegram review diff ${job.id}`,
          command,
          timeoutMs: 60_000,
        });
        if (result.outcome === "exited" && result.exitCode === 0 && result.output.trim().length > 0) {
          return { diff: result.output, source: command };
        }
      } catch {
        // GitHub being unreachable must not stop review; the environment diff
        // below is the answer it always was, stale-base risk and all.
      }
    }
    const local = environmentDiffText(snapshot);
    if (local !== null) return { diff: local, source: "environment diff against the local base branch" };
    throw new Error("Complete review diff is unavailable from GitHub and the environment");
  }
}

const STOPPABLE_WORKER_STATES = new Set<WorkerLiveness["state"]>(["starting", "active", "stopping"]);

const USAGE_EVENT_PAGES = 40;
const USAGE_EVENT_PAGE_LIMIT = 200;

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function requirePullRequestSnapshot(job: Job, snapshot: PullRequestSnapshot): void {
  if (snapshot.outcome !== "available") {
    throw new Error("Review requires an available pull-request snapshot");
  }
  if (
    job.prNumber === null ||
    job.prUrl === null ||
    job.prUrl.length === 0 ||
    snapshot.pullRequest.number !== job.prNumber ||
    snapshot.pullRequest.url !== job.prUrl
  ) {
    throw new Error("Pull-request snapshot does not match the active job identity");
  }
}

export {
  buildReviewPacket,
  buildWorkOrder,
  type HandoffArtifact,
};
