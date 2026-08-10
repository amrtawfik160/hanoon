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
  parsePersistedMergeSuccessResult,
  isCompletedReviewAttempt,
  type ApprovalIdentity,
  type DurableMergeReceipt,
  type MergeEffectPayload,
  type MergeCallPreparation,
  type MergeCallbackIdentity,
  type PersistedMergeSuccessResult,
  type TelegramAgentStore,
} from "../storage/store";

const POST_MERGE_HEAD_COMMAND = (number: number): string =>
  `git ls-remote --exit-code origin refs/pull/${String(number)}/head`;
const POST_MERGE_PR_COMMAND = (number: number): string =>
  `gh pr view ${String(number)} --json state,mergedAt,mergeCommit,url,number`;
const FULL_SHA = /^[0-9a-f]{40}$/;
const MAX_PROVIDER_RESULT_JSON = 64_000;

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
};

export type MergeCallbackResult =
  | { outcome: "accepted" }
  | { outcome: "rejected" };

export type ExecuteMergeEffectInput = {
  effect: StoredEffect;
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

function safeFailureReason(_value: unknown, fallback: string): string {
  return fallback;
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
    const freshNow = (): number => {
      const now = this.clock();
      assertNow(now);
      return now;
    };
    if (!input.callbackId || !input.nonce) throw new TypeError("approval callback identity is required");
    const approvalNonceHash = hashSecret(input.nonce);

    const previous = this.options.store.getCallback(input.callbackId);
    if (previous) {
      const owner = this.options.store.getOwner();
      return previous.outcome === "accepted" &&
        previous.action === "merge" &&
        previous.jobId !== null &&
        owner?.userId === input.userId &&
        owner.chatId === input.chatId &&
        previous.approvalNonceHash === approvalNonceHash &&
        previous.headSha !== null &&
        previous.effectIdempotencyKey !== null &&
        this.hasAcceptedMergeEffect(
          previous.jobId,
          previous.headSha,
          approvalNonceHash,
          previous.effectIdempotencyKey,
        )
        ? { outcome: "accepted" }
        : { outcome: "rejected" };
    }

    const owner = this.options.store.getOwner();
    const identity: ApprovalIdentity = { userId: input.userId, chatId: input.chatId };
    if (!owner || owner.userId !== identity.userId || owner.chatId !== identity.chatId) {
      this.options.store.recordCallback(input.callbackId, null, "merge", "rejected", freshNow());
      return { outcome: "rejected" };
    }

    const approval = this.approvals.get(input.nonce, freshNow());
    if (!approval) {
      const consumedApproval = this.approvals.lookup(input.nonce);
      const acceptedIdentity = consumedApproval
        ? this.findAcceptedMergeIdentity(consumedApproval.jobId, consumedApproval.headSha, approvalNonceHash)
        : null;
      if (
        consumedApproval?.outcome === "accepted" &&
        consumedApproval.consumedAt !== null &&
        consumedApproval.ownerUserId === identity.userId &&
        consumedApproval.ownerChatId === identity.chatId &&
        acceptedIdentity !== null
      ) {
        this.options.store.recordCallback(
          input.callbackId,
          consumedApproval.jobId,
          "merge",
          "accepted",
          freshNow(),
          acceptedIdentity,
        );
        return { outcome: "accepted" };
      }
      this.options.store.recordCallback(input.callbackId, null, "merge", "rejected", freshNow());
      return { outcome: "rejected" };
    }
    const job = this.options.store.getJob(approval.jobId);
    if (!job) {
      this.options.store.recordCallback(input.callbackId, approval.jobId, "merge", "rejected", freshNow());
      return { outcome: "rejected" };
    }

    try {
      const collected = await this.options.collectGateInput({
        job,
        phase: "approval",
        receipt: null,
        now: freshNow(),
      });
      const evaluation = readyEvaluation(collected, freshNow());
      if (!evaluation.ready || evaluation.receipt.headSha !== approval.headSha || evaluation.receipt.jobId !== approval.jobId) {
        const rejected = this.options.store.rejectApprovalAndRecordCallback({
          nonceHash: approvalNonceHash,
          callbackId: input.callbackId,
          jobId: approval.jobId,
          headSha: typeof collected.environment.checkout.headSha === "string" && FULL_SHA.test(collected.environment.checkout.headSha)
            ? collected.environment.checkout.headSha
            : undefined,
          now: freshNow(),
        });
        return { outcome: rejected.outcome === "accepted" ? "accepted" : "rejected" };
      }
      const expiryNow = freshNow();
      if (
        Date.parse(evaluation.receipt.expiresAt) !== approval.expiresAt ||
        approval.jobVersion !== job.version ||
        approval.ownerUserId !== identity.userId ||
        approval.ownerChatId !== identity.chatId ||
        expiryNow >= approval.expiresAt
      ) {
        const rejected = this.options.store.rejectApprovalAndRecordCallback({
          nonceHash: approvalNonceHash,
          callbackId: input.callbackId,
          jobId: approval.jobId,
          now: freshNow(),
        });
        return { outcome: rejected.outcome === "accepted" ? "accepted" : "rejected" };
      }

      const idempotencyKey = `${job.id}:${job.version + 1}:merge_pr`;
      const durableReceipt = parseDurableMergeReceipt({
        ...evaluation.receipt,
        effectIdempotencyKey: idempotencyKey,
        approvalNonceHash,
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
        freshNow(),
        identity,
      );
      if (!accepted.ok) {
        const rejected = this.options.store.rejectApprovalAndRecordCallback({
          nonceHash: approvalNonceHash,
          callbackId: input.callbackId,
          jobId: approval.jobId,
          now: freshNow(),
        });
        return { outcome: rejected.outcome === "accepted" ? "accepted" : "rejected" };
      }
      this.options.store.recordCallback(
        input.callbackId,
        approval.jobId,
        "merge",
        "accepted",
        freshNow(),
        {
          approvalNonceHash,
          headSha: durableReceipt.headSha,
          effectIdempotencyKey: durableReceipt.effectIdempotencyKey,
        },
      );
      return { outcome: "accepted" };
    } catch (error) {
      const rejected = this.options.store.rejectApprovalAndRecordCallback({
        nonceHash: approvalNonceHash,
        callbackId: input.callbackId,
        jobId: approval.jobId,
        now: freshNow(),
      });
      return { outcome: rejected.outcome === "accepted" ? "accepted" : "rejected" };
    }
  }

  public async handleMergeCallback(input: ApprovalCallbackInput): Promise<MergeCallbackResult> {
    return this.handleApprovalCallback(input);
  }

  public async executeMergeEffect(input: ExecuteMergeEffectInput): Promise<MergeEffectResult> {
    const freshNow = (): number => {
      const now = this.clock();
      assertNow(now);
      return now;
    };
    const failCurrentLease = (reason: unknown, effectKey = input.effect.idempotencyKey): MergeEffectResult => {
      if (input.leaseOwner !== undefined && input.leaseGeneration !== undefined) {
        this.options.store.failLeasedMergeEffect({
          jobId: input.effect.jobId,
          effectIdempotencyKey: effectKey,
          reason: safeFailureReason(reason, "Merge effect failed safely"),
          now: freshNow(),
          leaseOwner: input.leaseOwner,
          leaseGeneration: input.leaseGeneration,
        });
      }
      return { outcome: "failed" };
    };
    const preserveUnknownOutcome = (effectKey = input.effect.idempotencyKey): MergeEffectResult => {
      if (input.leaseOwner !== undefined && input.leaseGeneration !== undefined) {
        try {
          this.options.store.preserveUnknownMergeEffect({
            jobId: input.effect.jobId,
            effectIdempotencyKey: effectKey,
            now: freshNow(),
            leaseOwner: input.leaseOwner,
            leaseGeneration: input.leaseGeneration,
          });
        } catch {
          // The unknown fence is already durable; a lost lease must not rewrite it.
        }
      }
      return { outcome: "failed" };
    };

    freshNow();
    let durableEffect: StoredEffect | null;
    try {
      durableEffect = this.options.store.getEffect(input.effect.jobId, input.effect.idempotencyKey);
    } catch (error) {
      return failCurrentLease(error);
    }
    if (!durableEffect) return { outcome: "failed" };
    if (durableEffect.jobId !== input.effect.jobId || durableEffect.idempotencyKey !== input.effect.idempotencyKey) {
      return failCurrentLease("Merge effect identity changed");
    }
    const effect = durableEffect;
    if (effect.kind !== "merge_pr") return { outcome: "failed" };
    if (effect.status === "done") {
      return this.isValidCompletedEffect(effect) ? { outcome: "already_done" } : { outcome: "failed" };
    }
    if (effect.status === "failed" || effect.status === "dead") return { outcome: "already_done" };
    if (input.leaseOwner === undefined || input.leaseGeneration === undefined) return { outcome: "failed" };

    let storedPayload: MergeEffectPayload;
    try {
      storedPayload = effectPayload(effect);
    } catch (error) {
      return failCurrentLease(error);
    }

    let job: Job | null;
    try {
      job = this.options.store.getJob(effect.jobId);
    } catch (error) {
      return storedPayload.mergeCallStartedAt === undefined
        ? failCurrentLease(error)
        : preserveUnknownOutcome();
    }
    if (!job || job.state !== "merging") {
      return storedPayload.mergeCallStartedAt === undefined
        ? failCurrentLease("Merge effect job is not an active merge")
        : preserveUnknownOutcome();
    }

    if (storedPayload.mergeCallStartedAt !== undefined) {
      let prepared: MergeCallPreparation;
      try {
        prepared = this.options.store.prepareMergeCall({
          jobId: effect.jobId,
          effectIdempotencyKey: effect.idempotencyKey,
          leaseOwner: input.leaseOwner,
          leaseGeneration: input.leaseGeneration,
          now: freshNow(),
        });
      } catch (error) {
        return preserveUnknownOutcome();
      }
      if (!prepared.ok) return preserveUnknownOutcome();
      return this.finishProviderAttempt(prepared, input, freshNow, failCurrentLease, preserveUnknownOutcome);
    }

    let collected: GateInput;
    let evaluation: GateEvaluation;
    try {
      collected = await this.options.collectGateInput({
        job,
        phase: "pre_merge",
        receipt: storedPayload.receipt as MergeReadyReceipt,
        now: freshNow(),
      });
      evaluation = readyEvaluation(collected, freshNow());
    } catch (error) {
      return failCurrentLease(error);
    }
    if (!evaluation.ready || !gateReceiptMatchesDurable(evaluation.receipt, storedPayload.receipt)) {
      let staleRecorded = false;
      try {
        staleRecorded = this.options.store.staleMergeEffect({
          jobId: effect.jobId,
          effectIdempotencyKey: effect.idempotencyKey,
          reason: "APPROVAL_STALE: fresh pre-merge evidence no longer matches the accepted receipt",
          now: freshNow(),
          leaseOwner: input.leaseOwner,
          leaseGeneration: input.leaseGeneration,
        });
      } catch (error) {
        return failCurrentLease(error);
      }
      return staleRecorded ? { outcome: "stale" } : failCurrentLease("Merge effect stale fence was rejected");
    }

    let prepared: MergeCallPreparation;
    try {
      prepared = this.options.store.prepareMergeCall({
        jobId: effect.jobId,
        effectIdempotencyKey: effect.idempotencyKey,
        leaseOwner: input.leaseOwner,
        leaseGeneration: input.leaseGeneration,
        now: freshNow(),
      });
    } catch (error) {
      return failCurrentLease(error);
    }
    if (!prepared.ok) return failCurrentLease(prepared.reason);
    return this.finishProviderAttempt(prepared, input, freshNow, failCurrentLease, preserveUnknownOutcome);
  }

  public async runMergeEffect(
    input: ExecuteMergeEffectInput,
  ): Promise<MergeEffectResult> {
    return this.executeMergeEffect(input);
  }

  private async finishProviderAttempt(
    prepared: Extract<MergeCallPreparation, { ok: true }>,
    input: ExecuteMergeEffectInput,
    freshNow: () => number,
    failCurrentLease: (reason: unknown, effectKey?: string) => MergeEffectResult,
    preserveUnknownOutcome: (effectKey?: string) => MergeEffectResult,
  ): Promise<MergeEffectResult> {
    const { effect, job, receipt } = prepared;
    let sdkFence: MergeCallPreparation;
    try {
      sdkFence = this.options.store.prepareMergeCall({
        jobId: effect.jobId,
        effectIdempotencyKey: effect.idempotencyKey,
        leaseOwner: input.leaseOwner!,
        leaseGeneration: input.leaseGeneration!,
        now: freshNow(),
      });
    } catch (error) {
      return preserveUnknownOutcome(effect.idempotencyKey);
    }
    if (!sdkFence.ok) {
      return preserveUnknownOutcome(effect.idempotencyKey);
    }
    if (prepared.shouldCallProvider) {
      let providerFence: MergeCallPreparation;
      try {
        providerFence = this.options.store.prepareMergeCall({
          jobId: effect.jobId,
          effectIdempotencyKey: effect.idempotencyKey,
          leaseOwner: input.leaseOwner!,
          leaseGeneration: input.leaseGeneration!,
          now: freshNow(),
        });
      } catch (error) {
        return preserveUnknownOutcome(effect.idempotencyKey);
      }
      if (!providerFence.ok) return preserveUnknownOutcome(effect.idempotencyKey);
      try {
        await this.options.bb.sdk.environments.mergePullRequest({
          environmentId: receipt.environmentId,
          method: receipt.mergeMethod,
        });
      } catch (error) {
        return preserveUnknownOutcome(effect.idempotencyKey);
      }
    }

    let completionFence: MergeCallPreparation;
    try {
      completionFence = this.options.store.prepareMergeCall({
        jobId: effect.jobId,
        effectIdempotencyKey: effect.idempotencyKey,
        leaseOwner: input.leaseOwner!,
        leaseGeneration: input.leaseGeneration!,
        now: freshNow(),
      });
    } catch (error) {
      return preserveUnknownOutcome(effect.idempotencyKey);
    }
    if (!completionFence.ok) {
      return preserveUnknownOutcome(effect.idempotencyKey);
    }

    let confirmed: { ok: true; result: PersistedMergeSuccessResult } | { ok: false; reason: string };
    try {
      confirmed = await this.confirmPostMerge(
        completionFence.receipt,
        effect.idempotencyKey,
        freshNow,
        (now) => {
          try {
            return this.options.store.prepareMergeCall({
              jobId: effect.jobId,
              effectIdempotencyKey: effect.idempotencyKey,
              leaseOwner: input.leaseOwner!,
              leaseGeneration: input.leaseGeneration!,
              now,
            }).ok;
          } catch {
            return false;
          }
        },
      );
    } catch (error) {
      confirmed = { ok: false, reason: safeFailureReason(error, "post-merge provider truth is unavailable") };
    }
    if (!confirmed.ok) {
      return preserveUnknownOutcome(effect.idempotencyKey);
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
      return preserveUnknownOutcome(effect.idempotencyKey);
    }
    if (completed) return { outcome: "merged" };
    return preserveUnknownOutcome(effect.idempotencyKey);
  }

  private isValidCompletedEffect(effect: StoredEffect): boolean {
    if (effect.kind !== "merge_pr" || effect.status !== "done") return false;
    try {
      const persisted = effect.payload as Record<string, unknown>;
      const payload = parsePersistedMergeEffectPayload(persisted, "done");
      const result = parsePersistedMergeSuccessResult(persisted.mergeResult);
      const job = this.options.store.getJob(effect.jobId);
      if (!job) return false;
      const attempt = this.options.store.getAttempt(payload.receipt.reviewAttemptId);
      if (
        !attempt ||
        attempt.jobId !== effect.jobId ||
        attempt.kind !== "review" ||
        attempt.headSha !== payload.receipt.headSha ||
        attempt.completedAt === null ||
        attempt.resultJson === null
      ) return false;
      const attemptResult = parsePersistedMergeSuccessResult(JSON.parse(attempt.resultJson));
      const approval = this.options.store.getApproval(payload.receipt.approvalNonceHash);
      const receipt = payload.receipt;
      return result.jobId === effect.jobId &&
        result.effectIdempotencyKey === effect.idempotencyKey &&
        receipt.effectIdempotencyKey === effect.idempotencyKey &&
        JSON.stringify(attemptResult) === JSON.stringify(result) &&
        result.approvalNonceHash === receipt.approvalNonceHash &&
        result.environmentId === receipt.environmentId &&
        result.prNumber === receipt.prNumber &&
        result.authoritativeHeadSha === receipt.headSha &&
        result.pullRequest.number === receipt.prNumber &&
        result.pullRequest.state === "MERGED" &&
        job.id === receipt.jobId &&
        job.state === "merged" &&
        job.cancelRequestedAt === null &&
        job.version >= receipt.jobVersion + 1 &&
        job.projectId === receipt.projectId &&
        job.environmentId === receipt.environmentId &&
        job.prNumber === receipt.prNumber &&
        job.prHeadSha === receipt.headSha &&
        job.policy !== null &&
        job.policy.baseBranch === receipt.baseBranch &&
        job.policy.mergeMethod === receipt.mergeMethod &&
        JSON.stringify([...job.policy.requiredChecks].sort()) === JSON.stringify(receipt.requiredCheckNames) &&
        approval !== null &&
        approval.jobId === receipt.jobId &&
        approval.headSha === receipt.headSha &&
        approval.consumedAt !== null &&
        approval.outcome === "accepted" &&
        approval.jobVersion === receipt.approvalJobVersion &&
        approval.ownerUserId === receipt.approvalOwnerUserId &&
        approval.ownerChatId === receipt.approvalOwnerChatId &&
        approval.expiresAt === Date.parse(receipt.expiresAt) &&
        this.options.store.getOwner()?.userId === receipt.approvalOwnerUserId &&
        this.options.store.getOwner()?.chatId === receipt.approvalOwnerChatId;
    } catch {
      return false;
    }
  }

  private findAcceptedMergeIdentity(
    jobId: string,
    headSha: string,
    approvalNonceHash: string,
  ): MergeCallbackIdentity | null {
    let effects: StoredEffect[];
    try {
      effects = this.options.store.listEffectsForJob(jobId);
    } catch {
      return null;
    }
    let job: Job | null;
    let approval: ReturnType<TelegramAgentStore["getApproval"]>;
    try {
      job = this.options.store.getJob(jobId);
      approval = this.options.store.getApproval(approvalNonceHash);
    } catch {
      return null;
    }
    const currentOwner = this.options.store.getOwner();
    let candidate: MergeCallbackIdentity | null = null;
    for (const effect of effects) {
      if (effect.kind !== "merge_pr" || effect.status === "failed" || effect.status === "dead") continue;
      if (effect.jobId !== jobId) continue;
      let payload: MergeEffectPayload;
      try {
        payload = parsePersistedMergeEffectPayload(effect.payload, effect.status);
      } catch {
        return null;
      }
      const receipt = payload.receipt;
      if (payload.mergeOutcome === "stale") continue;
      if (receipt.jobId !== jobId) return null;
      if (receipt.headSha !== headSha || receipt.approvalNonceHash !== approvalNonceHash) continue;
      if (receipt.effectIdempotencyKey !== effect.idempotencyKey) return null;
      if (effect.status === "done") {
        if (!this.isValidCompletedEffect(effect)) return null;
      } else if (
        !job ||
        !approval ||
        job.state !== "merging" ||
        job.cancelRequestedAt !== null ||
        job.version !== receipt.jobVersion ||
        job.prHeadSha !== receipt.headSha ||
        job.projectId !== receipt.projectId ||
        job.environmentId !== receipt.environmentId ||
        job.prNumber !== receipt.prNumber ||
        job.policy === null ||
        job.policy.baseBranch !== receipt.baseBranch ||
        job.policy.mergeMethod !== receipt.mergeMethod ||
        JSON.stringify([...job.policy.requiredChecks].sort()) !== JSON.stringify(receipt.requiredCheckNames) ||
        approval.jobId !== jobId ||
        approval.headSha !== headSha ||
        approval.consumedAt === null ||
        approval.outcome !== "accepted" ||
        approval.jobVersion !== receipt.approvalJobVersion ||
        approval.ownerUserId !== receipt.approvalOwnerUserId ||
        approval.ownerChatId !== receipt.approvalOwnerChatId ||
        approval.expiresAt !== Date.parse(receipt.expiresAt) ||
        currentOwner?.userId !== receipt.approvalOwnerUserId ||
        currentOwner?.chatId !== receipt.approvalOwnerChatId
      ) {
        return null;
      } else if (!isCompletedReviewAttempt(
        this.options.store.getAttempt(receipt.reviewAttemptId),
        jobId,
        receipt.headSha,
      )) {
        return null;
      }
      const identity = { approvalNonceHash, headSha, effectIdempotencyKey: effect.idempotencyKey };
      if (candidate !== null) return null;
      candidate = identity;
    }
    return candidate;
  }

  private hasAcceptedMergeEffect(
    jobId: string,
    headSha: string,
    approvalNonceHash: string,
    effectIdempotencyKey: string,
  ): boolean {
    return this.findAcceptedMergeIdentity(jobId, headSha, approvalNonceHash)?.effectIdempotencyKey === effectIdempotencyKey;
  }

  private async confirmPostMerge(
    receipt: DurableMergeReceipt,
    effectIdempotencyKey: string,
    freshNow: () => number,
    checkFence: (now: number) => boolean,
  ): Promise<{ ok: true; result: PersistedMergeSuccessResult } | { ok: false; reason: string }> {
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
    if (prResult.output.length > MAX_PROVIDER_RESULT_JSON) {
      return { ok: false, reason: "post-merge GitHub confirmation was too large" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(prResult.output);
    } catch {
      return { ok: false, reason: "post-merge GitHub confirmation was not JSON" };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "post-merge GitHub confirmation was not an object" };
    }
    const pr = parsed as Record<string, unknown>;
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
      typeof pr.url !== "string"
    ) {
      return { ok: false, reason: "post-merge GitHub state was not strictly merged" };
    }
    let result: PersistedMergeSuccessResult;
    try {
      result = parsePersistedMergeSuccessResult({
        jobId: receipt.jobId,
        effectIdempotencyKey,
        approvalNonceHash: receipt.approvalNonceHash,
        environmentId: receipt.environmentId,
        prNumber: receipt.prNumber,
        authoritativeHeadSha: authoritativeHead,
        mergedAt: pr.mergedAt,
        mergeCommit: { oid: mergeCommitOid },
        pullRequest: {
          number: pr.number,
          url: pr.url,
          state: "MERGED",
        },
        confirmedAt: new Date(freshNow()).toISOString(),
      });
    } catch {
      return { ok: false, reason: "post-merge GitHub state was not a strict callback-free success result" };
    }
    return {
      ok: true,
      result,
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
): Promise<MergeEffectResult> {
  return handler.executeMergeEffect(input);
}
