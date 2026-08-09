import type { BbPluginApi } from "@bb/plugin-sdk";
import type { Job, ProjectPolicy, WorkerLiveness } from "../domain/models";
import { buildReviewPacket, buildWorkOrder, type HandoffArtifact } from "./handoffs";
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

export type EnvironmentSnapshot = {
  status: EnvironmentStatus;
  diff: EnvironmentDiff;
};

function selectedPolicy(job: Job, suppliedPolicy?: ProjectPolicy): ProjectPolicy {
  const policy = job.policy ?? suppliedPolicy;
  if (policy === null || policy === undefined) throw new TypeError("Active job has no immutable policy snapshot");
  return policy;
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
    suppliedPolicy?: ProjectPolicy,
  ): Promise<ThreadResult> {
    const policy = selectedPolicy(job, suppliedPolicy);
    const artifact = buildWorkOrder(job, policy);
    const project = projectId(job, policy);
    const uploaded = await this.upload(project, artifact);
    recordHandoff(attempt, artifact, uploaded);
    const request = spawnRequest({
      projectId: project,
      title: `Telegram ${job.id} implementation ${attempt.id}`,
      visibility: "visible",
      input: [
        { type: "text", text: buildImplementationInstruction(artifact), mentions: [] },
        uploaded,
      ],
      environment: {
        type: "host",
        workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: policy.baseBranch } },
      },
      ...executionArgs(policy.implementation),
    });
    const thread = await this.sdk.threads.spawn(request);
    attempt.threadId = thread.id;
    return thread;
  }

  public async spawnReview(
    job: Job,
    attempt: BbAttempt,
    suppliedPolicy?: ProjectPolicy,
  ): Promise<ThreadResult> {
    const policy = selectedPolicy(job, suppliedPolicy);
    const environmentId = requireEnvironmentId(job);
    const parentThreadId = requireImplementationThreadId(job);
    const snapshot = await this.getEnvironmentSnapshot(environmentId, policy.baseBranch);
    const pullRequest = await this.getPullRequestSnapshot(environmentId);
    if (pullRequest.outcome === "unavailable") throw new Error(`Pull-request lookup unavailable: ${pullRequest.message}`);
    const remoteHeadSha = job.prHeadSha ?? checkoutHeadSha(snapshot.status);
    if (remoteHeadSha === null) throw new Error("Active job has no authoritative review head SHA");
    const artifact = buildReviewPacket(job, policy, remoteHeadSha, diffText(snapshot.diff));
    const project = projectId(job, policy);
    const uploaded = await this.upload(project, artifact);
    recordHandoff(attempt, artifact, uploaded);
    const request = spawnRequest({
      projectId: project,
      parentThreadId,
      title: `Telegram ${job.id} review ${attempt.id}`,
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

  public async sendRemediation(job: Job, findings: ReviewFinding[]): Promise<void> {
    await this.sendSteering(requireImplementationThreadId(job), buildRemediationPrompt(job, findings));
  }

  public async sendSteering(threadId: string, text: string): Promise<void> {
    await this.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
  }

  public async stopWorker(worker: string | WorkerLiveness): Promise<void> {
    if (typeof worker !== "string" && worker.resourceKind !== "bb_thread") {
      throw new TypeError("Only BB thread workers can be stopped by BbRunner");
    }
    const threadId = typeof worker === "string" ? worker : worker.resourceId;
    await this.sdk.threads.stop({ threadId });
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

function checkoutHeadSha(status: EnvironmentStatus): string | null {
  if (status.outcome !== "available") return null;
  const checkout = status.workspace.checkout;
  return "headSha" in checkout ? checkout.headSha : null;
}

export {
  buildReviewPacket,
  buildWorkOrder,
  type HandoffArtifact,
};
