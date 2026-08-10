import type { GateInput, GateEvaluation, MergeReadyReceipt } from "../domain/gates";
import { evaluateMergeGates } from "../domain/gates";
import { IllegalTransitionError } from "../domain/state-machine";
import type { Job, JobEffect, StoredEffect } from "../domain/models";
import { parseLsRemoteHead } from "../bb/validation";
import { ApprovalService } from "./approval-service";
import { VersionConflictError, type ApprovalIdentity, type TelegramAgentStore } from "../storage/store";

const POST_MERGE_HEAD_COMMAND = (number: number): string =>
  `git ls-remote --exit-code origin refs/pull/${String(number)}/head`;
const POST_MERGE_PR_COMMAND = (number: number): string =>
  `gh pr view ${String(number)} --json state,mergedAt,mergeCommit,url,number`;
const FULL_SHA = /^[0-9a-f]{40}$/;
const MAX_RESULT_JSON = 64_000;

type CommandResult =
  | { outcome: "exited"; exitCode: number; output: string }
  | { outcome: "timed_out" | "aborted" };

export type MergeCommandRunner = {
  run(input: {
    scope: { kind: "environment"; environmentId: string };
    title: string;
    command: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<CommandResult>;
};

export type GateCollectionInput = {
  job: Job;
  phase: "approval" | "pre_merge";
  receipt: MergeReadyReceipt | null;
  now: number;
};

export type MergeHandlerOptions = {
  store: TelegramAgentStore;
  approvals?: ApprovalService;
  collectGateInput: (input: GateCollectionInput) => Promise<GateInput>;
  commandRunner: MergeCommandRunner;
  bb: {
    sdk: {
      environments: {
        mergePullRequest(input: {
          environmentId: string;
          method: "merge" | "rebase" | "squash";
        }): Promise<unknown>;
      };
    };
  };
  deliverCompletion?: (payload: Record<string, unknown>) => Promise<void>;
  now?: () => number;
};

export type ApprovalCallbackInput = {
  callbackId: string;
  nonce: string;
  userId: string;
  chatId: string;
  now?: number;
};

export type MergeCallbackResult =
  | { outcome: "accepted" }
  | { outcome: "rejected" };

export type ExecuteMergeEffectInput = {
  effect: StoredEffect;
  now?: number;
  leaseOwner?: string;
  leaseGeneration?: number;
};

export type MergeEffectResult =
  | { outcome: "merged" }
  | { outcome: "stale" }
  | { outcome: "failed" }
  | { outcome: "already_done" };

function assertNow(now: number): void {
  if (!Number.isInteger(now) || now < 0) throw new TypeError("now must be a non-negative integer");
}

function safeFailureReason(value: unknown, fallback: string): string {
  const reason = value instanceof Error ? value.message : String(value ?? "");
  const redacted = reason
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .replace(/\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, "[redacted]");
  return redacted.length > 0 && redacted.length <= 500 ? redacted : fallback;
}

function readyEvaluation(
  input: GateInput,
  now: number,
): GateEvaluation {
  return evaluateMergeGates({ ...input, now });
}

function receiptFromPayload(effect: StoredEffect): MergeReadyReceipt {
  const receipt = effect.payload.receipt;
  if (receipt === null || typeof receipt !== "object") throw new TypeError("merge effect has no ready receipt");
  return receipt as MergeReadyReceipt;
}

function resultPayload(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("merge confirmation must be a JSON object");
  }
  const result = value as Record<string, unknown>;
  const json = JSON.stringify(result);
  if (json === undefined || json.length > MAX_RESULT_JSON) throw new TypeError("merge confirmation is too large");
  return result;
}

function completionPayload(job: Job, prNumber: number): Record<string, unknown> {
  return {
    text: `Merged PR #${String(prNumber)} for ${job.projectId ?? "the selected project"}.`,
    disable_web_page_preview: true,
  };
}

export class MergeHandler {
  private readonly approvals: ApprovalService;
  private readonly clock: () => number;

  public constructor(private readonly options: MergeHandlerOptions) {
    this.approvals = options.approvals ?? new ApprovalService(options.store, { now: options.now });
    this.clock = options.now ?? (() => Date.now());
  }

  public async handleApprovalCallback(input: ApprovalCallbackInput): Promise<MergeCallbackResult> {
    const now = input.now ?? this.clock();
    assertNow(now);
    if (!input.callbackId || !input.nonce) throw new TypeError("approval callback identity is required");

    const previous = this.options.store.getCallback(input.callbackId);
    if (previous) return { outcome: previous.outcome === "accepted" ? "accepted" : "rejected" };

    const owner = this.options.store.getOwner();
    const identity: ApprovalIdentity = { userId: input.userId, chatId: input.chatId };
    if (!owner || owner.userId !== identity.userId || owner.chatId !== identity.chatId) {
      this.options.store.recordCallback(input.callbackId, null, "merge", "rejected", now);
      return { outcome: "rejected" };
    }

    const approval = this.approvals.get(input.nonce, now);
    if (!approval) {
      const consumedApproval = this.approvals.lookup(input.nonce);
      if (
        consumedApproval?.outcome === "accepted" &&
        consumedApproval.consumedAt !== null &&
        consumedApproval.ownerUserId === identity.userId &&
        consumedApproval.ownerChatId === identity.chatId &&
        this.hasAcceptedMergeEffect(consumedApproval.jobId, consumedApproval.headSha)
      ) {
        this.options.store.recordCallback(input.callbackId, consumedApproval.jobId, "merge", "accepted", now);
        return { outcome: "accepted" };
      }
      this.options.store.recordCallback(input.callbackId, null, "merge", "rejected", now);
      return { outcome: "rejected" };
    }
    const job = this.options.store.getJob(approval.jobId);
    if (!job) {
      this.options.store.recordCallback(input.callbackId, approval.jobId, "merge", "rejected", now);
      return { outcome: "rejected" };
    }

    const collected = await this.options.collectGateInput({
      job,
      phase: "approval",
      receipt: null,
      now,
    });
    const evaluation = readyEvaluation(collected, now);
    if (!evaluation.ready || evaluation.receipt.headSha !== approval.headSha || evaluation.receipt.jobId !== approval.jobId) {
      this.approvals.revoke(approval.jobId, "approval_stale", now);
      this.reopenAfterApprovalFailure(job, collected, now);
      this.options.store.recordCallback(input.callbackId, approval.jobId, "merge", "rejected", now);
      return { outcome: "rejected" };
    }

    const effect: JobEffectForMerge = {
      idempotencyKey: `${job.id}:${job.version + 1}:merge_pr`,
      jobId: job.id,
      kind: "merge_pr",
      payload: {
        headSha: approval.headSha,
        receipt: evaluation.receipt,
        ownerUserId: identity.userId,
        ownerChatId: identity.chatId,
      },
    };
    const accepted = this.approvals.accept(
      input.nonce,
      job.version,
      effect,
      now,
      identity,
    );
    if (!accepted.ok) {
      this.approvals.revoke(approval.jobId, "approval_stale", now);
      this.reopenAfterApprovalFailure(job, collected, now);
      this.options.store.recordCallback(input.callbackId, approval.jobId, "merge", "rejected", now);
      return { outcome: "rejected" };
    }
    this.options.store.recordCallback(input.callbackId, approval.jobId, "merge", "accepted", now);
    return { outcome: "accepted" };
  }

  public async handleMergeCallback(input: ApprovalCallbackInput): Promise<MergeCallbackResult> {
    return this.handleApprovalCallback(input);
  }

  public async executeMergeEffect(
    input: ExecuteMergeEffectInput,
    retryOptions?: { now?: number },
  ): Promise<MergeEffectResult> {
    const now = retryOptions?.now ?? input.now ?? this.clock();
    assertNow(now);
    const durableEffect = this.options.store.getEffect(input.effect.jobId, input.effect.idempotencyKey);
    const effect = durableEffect ?? input.effect;
    if (effect.kind !== "merge_pr") throw new TypeError("only merge_pr effects can be executed by MergeHandler");
    if (effect.status === "done") {
      await this.deliverStoredCompletion(effect, now);
      return { outcome: "already_done" };
    }
    if (effect.status === "failed" || effect.status === "dead") return { outcome: "already_done" };
    if (
      input.leaseOwner !== undefined ||
      input.leaseGeneration !== undefined
    ) {
      if (
        effect.status !== "leased" ||
        effect.leaseOwner !== input.leaseOwner ||
        effect.leaseGeneration !== input.leaseGeneration
      ) return { outcome: "failed" };
    }

    const receipt = receiptFromPayload(effect);
    const job = this.options.store.getJob(effect.jobId);
    if (!job || job.state !== "merging") {
      return { outcome: "failed" };
    }
    const collected = await this.options.collectGateInput({
      job,
      phase: "pre_merge",
      receipt,
      now,
    });
    const evaluation = readyEvaluation(collected, now);
    if (!evaluation.ready || evaluation.receipt.headSha !== receipt.headSha || evaluation.receipt.jobId !== receipt.jobId) {
      const staleRecorded = this.options.store.staleMergeEffect({
        jobId: effect.jobId,
        effectIdempotencyKey: effect.idempotencyKey,
        reason: "APPROVAL_STALE: fresh pre-merge evidence no longer matches the accepted head",
        now,
        leaseOwner: input.leaseOwner,
        leaseGeneration: input.leaseGeneration,
      });
      return staleRecorded ? { outcome: "stale" } : { outcome: "failed" };
    }

    try {
      await this.options.bb.sdk.environments.mergePullRequest({
        environmentId: receipt.environmentId,
        method: receipt.mergeMethod,
      });
    } catch (error) {
      this.options.store.failMergeEffect({
        jobId: effect.jobId,
        effectIdempotencyKey: effect.idempotencyKey,
        reason: safeFailureReason(error, "BB merge SDK rejected the pull request"),
        now,
        leaseOwner: input.leaseOwner,
        leaseGeneration: input.leaseGeneration,
      });
      return { outcome: "failed" };
    }

    const confirmation = await this.confirmPostMerge(receipt, now);
    if (!confirmation.ok) {
      this.options.store.failMergeEffect({
        jobId: effect.jobId,
        effectIdempotencyKey: effect.idempotencyKey,
        reason: confirmation.reason,
        now,
        leaseOwner: input.leaseOwner,
        leaseGeneration: input.leaseGeneration,
      });
      return { outcome: "failed" };
    }

    const currentJob = this.options.store.getJob(effect.jobId) ?? job;
    const payload = completionPayload(currentJob, receipt.prNumber);
    const outbox = this.options.store.getOwner()
      ? {
          logicalKey: `${effect.jobId}:merge-completion`,
          chatId: this.options.store.getOwner()!.chatId,
          messageId: currentJob.statusMessageId,
          payload,
        }
      : undefined;
    const persisted = this.options.store.completeMergeSuccess({
      jobId: effect.jobId,
      effectIdempotencyKey: effect.idempotencyKey,
      message: "Merge completed",
      result: confirmation.result,
      outbox,
      now,
      leaseOwner: input.leaseOwner,
      leaseGeneration: input.leaseGeneration,
    });
    if (!persisted) return { outcome: "failed" };
    if (this.options.deliverCompletion) await this.options.deliverCompletion(payload);
    return { outcome: "merged" };
  }

  public async runMergeEffect(
    input: ExecuteMergeEffectInput,
    retryOptions?: { now?: number },
  ): Promise<MergeEffectResult> {
    return this.executeMergeEffect(input, retryOptions);
  }

  private reopenAfterApprovalFailure(job: Job, collected: GateInput, now: number): void {
    const head = collected.environment.checkout.headSha;
    const eventHead = typeof head === "string" && FULL_SHA.test(head) ? head : undefined;
    try {
      this.options.store.applyJobEvent(job.id, job.version, {
        type: "APPROVAL_STALE",
        ...(eventHead ? { headSha: eventHead } : {}),
      }, now);
    } catch (error) {
      if (!(error instanceof VersionConflictError) && !(error instanceof IllegalTransitionError)) throw error;
    }
  }

  private hasAcceptedMergeEffect(jobId: string, headSha: string): boolean {
    return this.options.store.listEffectsForJob(jobId).some((effect) => {
      if (effect.kind !== "merge_pr") return false;
      return effect.payload.headSha === headSha;
    });
  }

  private async confirmPostMerge(
    receipt: MergeReadyReceipt,
    now: number,
  ): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; reason: string }> {
    const headResult = await this.options.commandRunner.run({
      scope: { kind: "environment", environmentId: receipt.environmentId },
      title: "Telegram post-merge Git head confirmation",
      command: POST_MERGE_HEAD_COMMAND(receipt.prNumber),
      timeoutMs: 60_000,
    });
    if (headResult.outcome !== "exited" || headResult.exitCode !== 0) {
      return { ok: false, reason: "post-merge Git-native head confirmation failed" };
    }
    let authoritativeHead: string;
    try {
      authoritativeHead = parseLsRemoteHead(headResult.output, receipt.prNumber);
    } catch {
      return { ok: false, reason: "post-merge Git-native head confirmation was malformed" };
    }
    if (authoritativeHead !== receipt.headSha) {
      return { ok: false, reason: "post-merge Git-native head does not equal the approved head" };
    }

    const prResult = await this.options.commandRunner.run({
      scope: { kind: "environment", environmentId: receipt.environmentId },
      title: "Telegram post-merge GitHub confirmation",
      command: POST_MERGE_PR_COMMAND(receipt.prNumber),
      timeoutMs: 60_000,
    });
    if (prResult.outcome !== "exited" || prResult.exitCode !== 0) {
      return { ok: false, reason: "post-merge GitHub confirmation failed" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(prResult.output);
    } catch {
      return { ok: false, reason: "post-merge GitHub confirmation was not JSON" };
    }
    let pr: Record<string, unknown>;
    try {
      pr = resultPayload(parsed);
    } catch {
      return { ok: false, reason: "post-merge GitHub confirmation was not an object" };
    }
    if (
      pr.number !== receipt.prNumber ||
      pr.state !== "MERGED" ||
      typeof pr.mergedAt !== "string" ||
      pr.mergedAt.length === 0 ||
      pr.mergeCommit === null ||
      pr.mergeCommit === undefined
    ) {
      return { ok: false, reason: "post-merge GitHub state was not strictly merged" };
    }
    return {
      ok: true,
      result: {
        authoritativeHeadSha: authoritativeHead,
        mergedAt: pr.mergedAt,
        mergeCommit: pr.mergeCommit,
        pullRequest: {
          number: pr.number,
          url: typeof pr.url === "string" ? pr.url.slice(0, 500) : null,
          state: pr.state,
        },
        confirmedAt: new Date(now).toISOString(),
      },
    };
  }

  private async deliverStoredCompletion(effect: StoredEffect, _now: number): Promise<void> {
    if (!this.options.deliverCompletion) return;
    const job = this.options.store.getJob(effect.jobId);
    if (!job || job.prNumber === null) return;
    await this.options.deliverCompletion(completionPayload(job, job.prNumber));
  }
}

type JobEffectForMerge = JobEffect;

export async function handleMergeCallback(
  handler: MergeHandler,
  input: ApprovalCallbackInput,
): Promise<MergeCallbackResult> {
  return handler.handleApprovalCallback(input);
}

export async function executeMergeEffect(
  handler: MergeHandler,
  input: ExecuteMergeEffectInput,
  retryOptions?: { now?: number },
): Promise<MergeEffectResult> {
  return handler.executeMergeEffect(input, retryOptions);
}
