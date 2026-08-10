import type { GateInput, GateEvaluation, MergeReadyReceipt } from "../domain/gates";
import { evaluateMergeGates } from "../domain/gates";
import type { Job, JobEffect, StoredEffect } from "../domain/models";
import {
  parseLsRemoteHead,
  PR_HEAD_COMMAND,
  runValidation as task8RunValidation,
  type ValidationInput,
  type ValidationSnapshot,
} from "../bb/validation";
import { hashSecret } from "../crypto";
import { ApprovalService } from "./approval-service";
import {
  parseDurableMergeReceipt,
  parseMergeEffectPayload,
  parsePersistedMergeEffectPayload,
  type ApprovalIdentity,
  type DurableMergeReceipt,
  type MergeEffectPayload,
  type MergeCallPreparation,
  type TelegramAgentStore,
} from "../storage/store";

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

export type Task9FreshGateContext = {
  environment: GateInput["environment"];
  review: GateInput["review"];
  receipt: MergeReadyReceipt;
};

export type Task9FreshGateCollectorOptions = {
  validation: Omit<ValidationInput, "environmentId" | "job">;
  getContext: (input: {
    job: Job;
    phase: GateCollectionInput["phase"];
    receipt: MergeReadyReceipt | null;
    validation: ValidationSnapshot;
    now: number;
  }) => Promise<Task9FreshGateContext>;
  runValidation?: (input: ValidationInput) => Promise<ValidationSnapshot>;
};

function remoteHeadEvidenceFromTask8(
  snapshot: ValidationSnapshot,
  prNumber: number,
): GateInput["remoteHead"] {
  const command = PR_HEAD_COMMAND(prNumber);
  const receipts = snapshot.commandReceipts.filter((receipt) => receipt.command === command);
  if (receipts.length !== 2) {
    throw new TypeError("Task 8 validation must provide exactly two pull-request head reads");
  }
  const rows = receipts.map((receipt) => {
    if (receipt.outcome !== "pass" || receipt.exitCode !== 0) {
      throw new TypeError("Task 8 validation contains a failed pull-request head read");
    }
    const headSha = parseLsRemoteHead(receipt.output, prNumber);
    return { rows: [`${headSha}\trefs/pull/${String(prNumber)}/head`] };
  });
  if (rows[0].rows[0].split("\t")[0] !== rows[1].rows[0].split("\t")[0]) {
    throw new TypeError("Task 8 validation pull-request head reads disagree");
  }
  return { first: rows[0], second: rows[1] };
}

export function createTask9FreshGateCollector(
  options: Task9FreshGateCollectorOptions,
): (input: GateCollectionInput) => Promise<GateInput> {
  const validate = options.runValidation ?? task8RunValidation;
  return async (input) => {
    const { job } = input;
    if (!job.policy || !job.projectId || !job.environmentId || job.prNumber === null) {
      throw new TypeError("Task 9 fresh validation requires a fully configured job");
    }
    const snapshot = await validate({
      ...options.validation,
      environmentId: job.environmentId,
      job: {
        id: job.id,
        version: job.version,
        policy: job.policy,
        prNumber: job.prNumber,
      },
    });
    if (!snapshot.githubPr) throw new TypeError("Task 8 validation did not return pull-request metadata");
    const context = await options.getContext({
      job,
      phase: input.phase,
      receipt: input.receipt,
      validation: snapshot,
      now: input.now,
    });
    const remoteHead = remoteHeadEvidenceFromTask8(snapshot, job.prNumber);
    const githubPr = snapshot.githubPr;
    return {
      now: input.now,
      projectId: job.projectId,
      environmentId: job.environmentId,
      job: {
        id: job.id,
        version: job.version,
        projectId: job.projectId,
        environmentId: job.environmentId,
        prNumber: job.prNumber,
        policy: job.policy,
      },
      environment: context.environment,
      originRepository: snapshot.originRepository,
      remoteHead,
      pullRequest: {
        available: true,
        number: githubPr.number,
        state: githubPr.state,
        isDraft: githubPr.isDraft,
        baseRefName: githubPr.baseRefName,
        mergeStateStatus: githubPr.mergeStateStatus,
        mergeable: githubPr.mergeable,
      },
      githubPr: { ...githubPr },
      review: context.review,
      validation: {
        outcome: snapshot.validationOutcome,
        headSha: snapshot.headSha,
        completedAt: snapshot.completedAt,
        requiredChecks: snapshot.requiredChecks,
      },
      receipt: context.receipt,
    };
  };
}

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

function effectPayload(effect: StoredEffect): MergeEffectPayload {
  return parseMergeEffectPayload(effect.payload);
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

function gateReceiptMatchesDurable(
  fresh: MergeReadyReceipt,
  durable: DurableMergeReceipt,
): boolean {
  return fresh.jobId === durable.jobId &&
    fresh.jobVersion === durable.jobVersion &&
    fresh.projectId === durable.projectId &&
    fresh.environmentId === durable.environmentId &&
    fresh.prNumber === durable.prNumber &&
    fresh.baseBranch === durable.baseBranch &&
    fresh.headSha === durable.headSha &&
    fresh.reviewAttemptId === durable.reviewAttemptId &&
    fresh.validationCompletedAt === durable.validationCompletedAt &&
    JSON.stringify(fresh.requiredCheckNames) === JSON.stringify(durable.requiredCheckNames) &&
    fresh.mergeMethod === durable.mergeMethod &&
    fresh.expiresAt === durable.expiresAt;
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

    try {
      const collected = await this.options.collectGateInput({
        job,
        phase: "approval",
        receipt: null,
        now,
      });
      const evaluation = readyEvaluation(collected, now);
      if (!evaluation.ready || evaluation.receipt.headSha !== approval.headSha || evaluation.receipt.jobId !== approval.jobId) {
        const rejected = this.options.store.rejectApprovalAndRecordCallback({
          nonceHash: hashSecret(input.nonce),
          callbackId: input.callbackId,
          jobId: approval.jobId,
          headSha: typeof collected.environment.checkout.headSha === "string" && FULL_SHA.test(collected.environment.checkout.headSha)
            ? collected.environment.checkout.headSha
            : undefined,
          now,
        });
        return { outcome: rejected.outcome === "accepted" ? "accepted" : "rejected" };
      }
      if (
        Date.parse(evaluation.receipt.expiresAt) !== approval.expiresAt ||
        approval.jobVersion !== job.version ||
        approval.ownerUserId !== identity.userId ||
        approval.ownerChatId !== identity.chatId
      ) {
        const rejected = this.options.store.rejectApprovalAndRecordCallback({
          nonceHash: hashSecret(input.nonce),
          callbackId: input.callbackId,
          jobId: approval.jobId,
          now,
        });
        return { outcome: rejected.outcome === "accepted" ? "accepted" : "rejected" };
      }

      const idempotencyKey = `${job.id}:${job.version + 1}:merge_pr`;
      const durableReceipt = parseDurableMergeReceipt({
        ...evaluation.receipt,
        effectIdempotencyKey: idempotencyKey,
        approvalNonceHash: hashSecret(input.nonce),
        approvalOwnerUserId: identity.userId,
        approvalOwnerChatId: identity.chatId,
        jobVersion: job.version + 1,
        approvalJobVersion: job.version,
      });
      const effect: JobEffectForMerge = {
        idempotencyKey,
        jobId: job.id,
        kind: "merge_pr",
        payload: {
          headSha: approval.headSha,
          receipt: durableReceipt,
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
        const rejected = this.options.store.rejectApprovalAndRecordCallback({
          nonceHash: hashSecret(input.nonce),
          callbackId: input.callbackId,
          jobId: approval.jobId,
          now,
        });
        return { outcome: rejected.outcome === "accepted" ? "accepted" : "rejected" };
      }
      this.options.store.recordCallback(input.callbackId, approval.jobId, "merge", "accepted", now);
      return { outcome: "accepted" };
    } catch (error) {
      const rejected = this.options.store.rejectApprovalAndRecordCallback({
        nonceHash: hashSecret(input.nonce),
        callbackId: input.callbackId,
        jobId: approval.jobId,
        now,
      });
      return { outcome: rejected.outcome === "accepted" ? "accepted" : "rejected" };
    }
  }

  public async handleMergeCallback(input: ApprovalCallbackInput): Promise<MergeCallbackResult> {
    return this.handleApprovalCallback(input);
  }

  public async executeMergeEffect(
    input: ExecuteMergeEffectInput,
    retryOptions?: { now?: number },
  ): Promise<MergeEffectResult> {
    const explicitNow = retryOptions?.now ?? input.now;
    const freshNow = (): number => {
      const now = explicitNow ?? this.clock();
      assertNow(now);
      return now;
    };
    freshNow();
    let durableEffect: StoredEffect | null;
    try {
      durableEffect = this.options.store.getEffect(input.effect.jobId, input.effect.idempotencyKey);
    } catch {
      if (input.leaseOwner !== undefined && input.leaseGeneration !== undefined) {
        this.options.store.failMergeEffect({
          jobId: input.effect.jobId,
          effectIdempotencyKey: input.effect.idempotencyKey,
          reason: "Invalid durable merge receipt",
          now: freshNow(),
          leaseOwner: input.leaseOwner,
          leaseGeneration: input.leaseGeneration,
        });
      }
      return { outcome: "failed" };
    }
    if (!durableEffect) return { outcome: "failed" };
    if (durableEffect.jobId !== input.effect.jobId || durableEffect.idempotencyKey !== input.effect.idempotencyKey) {
      return { outcome: "failed" };
    }
    const effect = durableEffect;
    if (effect.kind !== "merge_pr") return { outcome: "failed" };
    if (effect.status === "done") {
      return { outcome: "already_done" };
    }
    if (effect.status === "failed" || effect.status === "dead") return { outcome: "already_done" };
    if (input.leaseOwner === undefined || input.leaseGeneration === undefined) return { outcome: "failed" };
    let storedPayload: MergeEffectPayload;
    try {
      storedPayload = effectPayload(effect);
    } catch {
      this.options.store.failMergeEffect({
        jobId: effect.jobId,
        effectIdempotencyKey: effect.idempotencyKey,
        reason: "Invalid durable merge receipt",
        now: freshNow(),
        leaseOwner: input.leaseOwner,
        leaseGeneration: input.leaseGeneration,
      });
      return { outcome: "failed" };
    }
    const job = this.options.store.getJob(effect.jobId);
    if (!job || job.state !== "merging") {
      return { outcome: "failed" };
    }
    if (storedPayload.mergeCallStartedAt !== undefined) {
      const prepared = this.options.store.prepareMergeCall({
        jobId: effect.jobId,
        effectIdempotencyKey: effect.idempotencyKey,
        leaseOwner: input.leaseOwner,
        leaseGeneration: input.leaseGeneration,
        now: freshNow(),
      });
      if (!prepared.ok) {
        this.options.store.failMergeEffect({
          jobId: effect.jobId,
          effectIdempotencyKey: effect.idempotencyKey,
          reason: safeFailureReason(prepared.reason, "Merge effect fence rejected the provider call"),
          now: freshNow(),
          leaseOwner: input.leaseOwner,
          leaseGeneration: input.leaseGeneration,
        });
        return { outcome: "failed" };
      }
      return this.finishProviderAttempt(prepared, input, freshNow);
    }

    let collected: GateInput;
    let evaluation: GateEvaluation;
    const validationNow = freshNow();
    try {
      collected = await this.options.collectGateInput({
        job,
        phase: "pre_merge",
        receipt: storedPayload.receipt as MergeReadyReceipt,
        now: validationNow,
      });
      evaluation = readyEvaluation(collected, freshNow());
    } catch (error) {
      this.options.store.failMergeEffect({
        jobId: effect.jobId,
        effectIdempotencyKey: effect.idempotencyKey,
        reason: safeFailureReason(error, "Fresh merge validation failed"),
        now: freshNow(),
        leaseOwner: input.leaseOwner,
        leaseGeneration: input.leaseGeneration,
      });
      return { outcome: "failed" };
    }
    if (!evaluation.ready || !gateReceiptMatchesDurable(evaluation.receipt, storedPayload.receipt)) {
      const staleRecorded = this.options.store.staleMergeEffect({
        jobId: effect.jobId,
        effectIdempotencyKey: effect.idempotencyKey,
        reason: "APPROVAL_STALE: fresh pre-merge evidence no longer matches the accepted receipt",
        now: freshNow(),
        leaseOwner: input.leaseOwner,
        leaseGeneration: input.leaseGeneration,
      });
      return staleRecorded ? { outcome: "stale" } : { outcome: "failed" };
    }

    const prepared = this.options.store.prepareMergeCall({
      jobId: effect.jobId,
      effectIdempotencyKey: effect.idempotencyKey,
      leaseOwner: input.leaseOwner,
      leaseGeneration: input.leaseGeneration,
      now: freshNow(),
    });
    if (!prepared.ok) {
      this.options.store.failMergeEffect({
        jobId: effect.jobId,
        effectIdempotencyKey: effect.idempotencyKey,
        reason: safeFailureReason(prepared.reason, "Merge effect fence rejected the provider call"),
        now: freshNow(),
        leaseOwner: input.leaseOwner,
        leaseGeneration: input.leaseGeneration,
      });
      return { outcome: "failed" };
    }
    return this.finishProviderAttempt(prepared, input, freshNow);
  }

  public async runMergeEffect(
    input: ExecuteMergeEffectInput,
    retryOptions?: { now?: number },
  ): Promise<MergeEffectResult> {
    return this.executeMergeEffect(input, retryOptions);
  }

  private async finishProviderAttempt(
    prepared: Extract<MergeCallPreparation, { ok: true }>,
    input: ExecuteMergeEffectInput,
    freshNow: () => number,
  ): Promise<MergeEffectResult> {
    const { effect, job, receipt } = prepared;
    const sdkFence = this.options.store.prepareMergeCall({
      jobId: effect.jobId,
      effectIdempotencyKey: effect.idempotencyKey,
      leaseOwner: input.leaseOwner!,
      leaseGeneration: input.leaseGeneration!,
      now: freshNow(),
    });
    if (!sdkFence.ok) {
      this.options.store.failMergeEffect({
        jobId: effect.jobId,
        effectIdempotencyKey: effect.idempotencyKey,
        reason: safeFailureReason(sdkFence.reason, "Merge effect fence rejected the provider call"),
        now: freshNow(),
        leaseOwner: input.leaseOwner!,
        leaseGeneration: input.leaseGeneration!,
      });
      return { outcome: "failed" };
    }
    if (prepared.shouldCallProvider) {
      try {
        await this.options.bb.sdk.environments.mergePullRequest({
          environmentId: receipt.environmentId,
          method: receipt.mergeMethod,
        });
      } catch (error) {
        this.options.store.failMergeEffect({
          jobId: effect.jobId,
          effectIdempotencyKey: effect.idempotencyKey,
          reason: safeFailureReason(error, "merge provider call outcome is unknown; manual reconciliation required"),
          now: freshNow(),
          leaseOwner: input.leaseOwner!,
          leaseGeneration: input.leaseGeneration!,
        });
        return { outcome: "failed" };
      }
    }

    const completionFence = this.options.store.prepareMergeCall({
      jobId: effect.jobId,
      effectIdempotencyKey: effect.idempotencyKey,
      leaseOwner: input.leaseOwner!,
      leaseGeneration: input.leaseGeneration!,
      now: freshNow(),
    });
    if (!completionFence.ok) {
      this.options.store.failMergeEffect({
        jobId: effect.jobId,
        effectIdempotencyKey: effect.idempotencyKey,
        reason: safeFailureReason(completionFence.reason, "Merge completion fence rejected the changed job state"),
        now: freshNow(),
        leaseOwner: input.leaseOwner!,
        leaseGeneration: input.leaseGeneration!,
      });
      return { outcome: "failed" };
    }

    let confirmed: { ok: true; result: Record<string, unknown> } | { ok: false; reason: string };
    try {
      confirmed = await this.confirmPostMerge(
        completionFence.receipt as MergeReadyReceipt,
        freshNow,
        (now) => this.options.store.prepareMergeCall({
          jobId: effect.jobId,
          effectIdempotencyKey: effect.idempotencyKey,
          leaseOwner: input.leaseOwner!,
          leaseGeneration: input.leaseGeneration!,
          now,
        }).ok,
      );
    } catch (error) {
      confirmed = { ok: false, reason: safeFailureReason(error, "post-merge provider truth is unavailable") };
    }
    if (!confirmed.ok) {
      this.options.store.failMergeEffect({
        jobId: effect.jobId,
        effectIdempotencyKey: effect.idempotencyKey,
        reason: confirmed.reason,
        now: freshNow(),
        leaseOwner: input.leaseOwner!,
        leaseGeneration: input.leaseGeneration!,
      });
      return { outcome: "failed" };
    }

    let completed: boolean;
    try {
      completed = this.options.store.completeMergeSuccess({
        jobId: effect.jobId,
        effectIdempotencyKey: effect.idempotencyKey,
        message: `Merged PR #${String(receipt.prNumber)} for ${job.projectId ?? "the selected project"}.`,
        result: confirmed.result,
        outbox: {
          logicalKey: `${effect.jobId}:${effect.idempotencyKey}:completion`,
          chatId: receipt.approvalOwnerChatId,
          payload: completionPayload(job, receipt.prNumber),
        },
        now: freshNow(),
        leaseOwner: input.leaseOwner!,
        leaseGeneration: input.leaseGeneration!,
      });
    } catch (error) {
      this.options.store.failMergeEffect({
        jobId: effect.jobId,
        effectIdempotencyKey: effect.idempotencyKey,
        reason: safeFailureReason(error, "Merge completion could not be persisted"),
        now: freshNow(),
        leaseOwner: input.leaseOwner!,
        leaseGeneration: input.leaseGeneration!,
      });
      return { outcome: "failed" };
    }
    if (completed) return { outcome: "merged" };
    this.options.store.failMergeEffect({
      jobId: effect.jobId,
      effectIdempotencyKey: effect.idempotencyKey,
      reason: "Merge completion fence rejected the changed job state",
      now: freshNow(),
      leaseOwner: input.leaseOwner!,
      leaseGeneration: input.leaseGeneration!,
    });
    return { outcome: "failed" };
  }

  private hasAcceptedMergeEffect(jobId: string, headSha: string): boolean {
    return this.options.store.listEffectsForJob(jobId).some((effect) => {
      if (effect.kind !== "merge_pr") return false;
      if (effect.status === "failed" || effect.status === "dead") return false;
      try {
        const payload = parsePersistedMergeEffectPayload(effect.payload, effect.status);
        return payload.mergeOutcome !== "stale" && payload.headSha === headSha;
      } catch {
        return false;
      }
    });
  }

  private async confirmPostMerge(
    receipt: MergeReadyReceipt,
    freshNow: () => number,
    checkFence: (now: number) => boolean,
  ): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; reason: string }> {
    if (!checkFence(freshNow())) {
      return { ok: false, reason: "post-merge effect fence rejected the Git head confirmation" };
    }
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

    if (!checkFence(freshNow())) {
      return { ok: false, reason: "post-merge effect fence rejected the GitHub confirmation" };
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
    if (prResult.output.length > MAX_RESULT_JSON) {
      return { ok: false, reason: "post-merge GitHub confirmation was too large" };
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
    const allowedKeys = ["number", "state", "mergedAt", "mergeCommit", "url"];
    if (Object.keys(pr).some((key) => !allowedKeys.includes(key)) ||
      !Object.prototype.hasOwnProperty.call(pr, "number") ||
      !Object.prototype.hasOwnProperty.call(pr, "state") ||
      !Object.prototype.hasOwnProperty.call(pr, "mergedAt") ||
      !Object.prototype.hasOwnProperty.call(pr, "mergeCommit") ||
      !Object.prototype.hasOwnProperty.call(pr, "url")) {
      return { ok: false, reason: "post-merge GitHub confirmation schema was invalid" };
    }
    const mergeCommit = pr.mergeCommit;
    const mergeCommitRecord = mergeCommit !== null && typeof mergeCommit === "object" && !Array.isArray(mergeCommit)
      ? mergeCommit as Record<string, unknown>
      : null;
    const mergeCommitOid = mergeCommitRecord?.oid;
    if (
      pr.number !== receipt.prNumber ||
      pr.state !== "MERGED" ||
      typeof pr.mergedAt !== "string" ||
      pr.mergedAt.length === 0 ||
      pr.mergedAt.length > 128 ||
      !Number.isFinite(Date.parse(pr.mergedAt)) ||
      mergeCommitRecord === null ||
      Object.keys(mergeCommitRecord).some((key) => key !== "oid") ||
      typeof mergeCommitOid !== "string" ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(mergeCommitOid) ||
      typeof pr.url !== "string" ||
      pr.url.length === 0 ||
      pr.url.length > 500
    ) {
      return { ok: false, reason: "post-merge GitHub state was not strictly merged" };
    }
    return {
      ok: true,
      result: {
        authoritativeHeadSha: authoritativeHead,
        mergedAt: pr.mergedAt,
        mergeCommit,
        pullRequest: {
          number: pr.number,
          url: typeof pr.url === "string" ? pr.url.slice(0, 500) : null,
          state: pr.state,
        },
        confirmedAt: new Date(freshNow()).toISOString(),
      },
    };
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
