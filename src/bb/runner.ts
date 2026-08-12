import type { BbPluginApi } from "@bb/plugin-sdk";
import type { Job, ProjectPolicy, WorkerLiveness } from "../domain/models";
import { buildWorkerThreadTitle } from "../agent-skills/role-resolver";
import { buildReviewPacket, buildWorkOrder, type HandoffArtifact } from "./handoffs";
import {
  buildCritiqueArtifact,
  buildCritiquePacket,
  buildDocsPacket,
  buildPlanArtifact,
  parseCritiqueResult,
} from "./pipeline-handoffs";
import {
  buildImplementationInstruction,
  buildRemediationPrompt,
  buildReviewInstruction,
  type ReviewFinding,
} from "./prompts";

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

export type BbAttempt = {
  id: string;
  kind?: "implementation" | "review" | "validation";
  ordinal?: number;
  threadId?: string | null;
  handoffPath?: string | null;
  handoffSha256?: string | null;
};

export type PipelineThreadAttempt = {
  id: string;
  role: "PLAN" | "CRITIQUE" | "DOCS";
  ordinal: number;
  threadId?: string | null;
  environmentId?: string | null;
  outputText?: string | null;
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

function executionArgs(policy: ProjectPolicy["implementation"]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const sources: Record<string, "explicit"> = {};
  for (const field of ["providerId", "model", "reasoningLevel", "serviceTier", "permissionMode"] as const) {
    const value = policy[field];
    if (value !== undefined) {
      args[field] = value;
      sources[field] = "explicit";
    }
  }
  if (Object.keys(sources).length > 0) args.executionInputSources = sources;
  return args;
}

// Pipeline workers pin their own execution tuple. Retuning the conversational
// controller must never silently change how plans, critiques, and docs are
// produced; a worker is bound by its work order and reviewed before any merge.
const LUNA_MAX_EXECUTION = {
  providerId: "codex",
  model: "gpt-5.6-luna",
  reasoningLevel: "max",
  serviceTier: "fast",
  permissionMode: "auto",
  executionInputSources: {
    providerId: "explicit",
    model: "explicit",
    reasoningLevel: "explicit",
    serviceTier: "explicit",
    permissionMode: "explicit",
  },
} as const;

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

function diffText(snapshot: EnvironmentDiff): string {
  if (snapshot.outcome !== "available") throw new Error("Complete environment diff is unavailable");
  if (snapshot.diff.truncated) throw new Error("Cannot create a review packet from a truncated environment diff");
  return snapshot.diff.diff;
}

function spawnRequest(request: Record<string, unknown>): SpawnArgs {
  return request as unknown as SpawnArgs;
}

export class BbRunner {
  public constructor(public readonly sdk: BbSdk) {}

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

  public async spawnImplementation(
    job: Job,
    attempt: BbAttempt,
    _suppliedPolicy?: ProjectPolicy,
  ): Promise<ThreadResult> {
    const policy = selectedPolicy(job);
    const artifact = buildWorkOrder(job, policy);
    const project = projectId(job, policy);
    const hostId = await this.resolveProjectHost(project);
    const uploaded = await this.upload(project, artifact);
    recordHandoff(attempt, artifact, uploaded);
    const request = spawnRequest({
      projectId: project,
      title: buildWorkerThreadTitle({ jobId: job.id, attemptId: attempt.id, role: "implementation" }),
      visibility: "visible",
      input: [
        { type: "text", text: buildImplementationInstruction(artifact), mentions: [] },
        uploaded,
      ],
      environment: {
        type: "host",
        hostId,
        workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: policy.baseBranch } },
      },
      ...executionArgs(policy.implementation),
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
    const workOrder = buildWorkOrder(job, policy);
    const revisionText = previousCritique?.trim();
    const critique = revisionText ? buildCritiqueArtifact(parseCritiqueResult(revisionText)) : null;
    const uploadedWorkOrder = await this.upload(project, workOrder);
    const uploadedCritique = critique ? await this.upload(project, critique) : null;
    const prompt = revisionText
      ? "Read the attached immutable work order and critique artifact. Return only the complete replacement plan as Markdown. Do not edit files, commit, push, merge, or deploy."
      : "Read the attached immutable work order and produce a concrete, bounded implementation and verification plan as Markdown. Do not edit files, commit, push, merge, or deploy.";
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
      visibility: "visible",
      input: [
        { type: "text", text: prompt, mentions: [] },
        uploadedWorkOrder,
        ...(uploadedCritique ? [uploadedCritique] : []),
      ],
      environment,
      ...LUNA_MAX_EXECUTION,
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
    const workOrder = buildWorkOrder(job, policy);
    const plan = buildPlanArtifact(planAttempt.outputText);
    const packet = buildCritiquePacket(job, plan);
    const uploadedWorkOrder = await this.upload(project, workOrder);
    const uploadedPlan = await this.upload(project, plan);
    const uploadedPacket = await this.upload(project, packet);
    const thread = await this.sdk.threads.spawn(spawnRequest({
      projectId: project,
      parentThreadId: planAttempt.threadId,
      title: buildWorkerThreadTitle({ jobId: job.id, attemptId: attempt.id, role: "critic" }),
      visibility: "visible",
      input: [
        {
          type: "text",
          text: "Read the attached immutable work order, plan, and critique contract. Assess the plan independently and return strict JSON only. Do not inspect the planner conversation or edit files.",
          mentions: [],
        },
        uploadedWorkOrder,
        uploadedPlan,
        uploadedPacket,
      ],
      environment: { type: "reuse", environmentId },
      ...LUNA_MAX_EXECUTION,
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
    const workOrder = buildWorkOrder(job, policy);
    const plan = buildPlanArtifact(planAttempt.outputText);
    const uploadedWorkOrder = await this.upload(project, workOrder);
    const uploadedPlan = await this.upload(project, plan);
    recordHandoff(attempt, workOrder, uploadedWorkOrder);
    const thread = await this.sdk.threads.spawn(spawnRequest({
      projectId: project,
      parentThreadId: planAttempt.threadId,
      title: buildWorkerThreadTitle({ jobId: job.id, attemptId: attempt.id, role: "implementation" }),
      visibility: "visible",
      input: [
        {
          type: "text",
          text: `Read the attached immutable work order ${workOrder.filename} and plan ${plan.filename}. Follow both files, implement the requested change, verify it, and report the required outcome.`,
          mentions: [],
        },
        uploadedWorkOrder,
        uploadedPlan,
      ],
      environment: { type: "reuse", environmentId },
      ...executionArgs(policy.implementation),
    }));
    attempt.threadId = thread.id;
    return thread;
  }

  public async getThreadOutput(threadId: string): Promise<string> {
    if (!threadId) throw new TypeError("threadId must not be empty");
    const result = await this.sdk.threads.output({ threadId });
    return result.output ?? "";
  }

  public async spawnDocs(job: Job, attempt: PipelineThreadAttempt): Promise<ThreadResult> {
    const policy = selectedPolicy(job);
    const project = projectId(job, policy);
    const environmentId = requireEnvironmentId(job);
    const parentThreadId = requireImplementationThreadId(job);
    const workOrder = buildWorkOrder(job, policy);
    const packet = buildDocsPacket(job);
    const uploadedWorkOrder = await this.upload(project, workOrder);
    const uploadedPacket = await this.upload(project, packet);
    const thread = await this.sdk.threads.spawn(spawnRequest({
      projectId: project,
      parentThreadId,
      title: buildWorkerThreadTitle({ jobId: job.id, attemptId: attempt.id, role: "documentation" }),
      visibility: "visible",
      input: [
        {
          type: "text",
          text: "Read the attached work order and docs packet. Use the docs-guard and verification-before-completion skills exactly as required, update only necessary documentation, verify it, commit and push, then report bounded evidence.",
          mentions: [],
        },
        uploadedWorkOrder,
        uploadedPacket,
      ],
      environment: { type: "reuse", environmentId },
      ...LUNA_MAX_EXECUTION,
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

  private async spawnReviewRole(
    job: Job,
    attempt: BbAttempt,
    role: "review" | "final-review",
  ): Promise<ThreadResult> {
    const policy = selectedPolicy(job);
    const environmentId = requireEnvironmentId(job);
    const parentThreadId = requireImplementationThreadId(job);
    const snapshot = await this.getEnvironmentSnapshot(environmentId, policy.baseBranch);
    const pullRequest = await this.getPullRequestSnapshot(environmentId);
    requirePullRequestSnapshot(job, pullRequest);
    if (job.prHeadSha === null) throw new Error("Active job has no authoritative review head SHA");
    const remoteHeadSha = job.prHeadSha;
    const artifact = buildReviewPacket(job, policy, remoteHeadSha, diffText(snapshot.diff));
    const project = projectId(job, policy);
    const uploaded = await this.upload(project, artifact);
    recordHandoff(attempt, artifact, uploaded);
    const request = spawnRequest({
      projectId: project,
      parentThreadId,
      title: buildWorkerThreadTitle({ jobId: job.id, attemptId: attempt.id, role }),
      visibility: "visible",
      input: [
        { type: "text", text: buildReviewInstruction(artifact), mentions: [] },
        uploaded,
      ],
      environment: { type: "reuse", environmentId },
      ...executionArgs(policy.review),
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
}

const STOPPABLE_WORKER_STATES = new Set<WorkerLiveness["state"]>(["starting", "active", "stopping"]);

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
