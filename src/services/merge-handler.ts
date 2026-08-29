import type { GateInput, GateEvaluation, MergeReadyReceipt } from "../domain/gates";
import { evaluateMergeGates } from "../domain/gates";
import type { Job, JobEffect, StoredEffect } from "../domain/models";
import {
  parseLsRemoteHead,
  PR_HEAD_COMMAND,
  runValidation as defaultRunValidation,
  type ValidationInput,
  type ValidationSnapshot,
} from "../bb/validation";
import { hashSecret } from "../crypto";
import { ApprovalService } from "./approval-service";
import {
  parseDurableMergeReceipt,
  parsePendingMergeEffectPayload,
  mergeEvidenceBindingError,
  parseMergeEffectPayload,
  isReplayableMergeEvidence,
  parsePersistedMergeEvidence,
  parsePersistedMergeEffectPayload,
  parsePersistedMergeSuccessResult,
  isCompletedReviewAttempt,
  type ApprovalIdentity,
  type ControllerMutationFence,
  type DurableMergeReceipt,
  type MergeEffectPayload,
  type PendingMergeEffectPayload,
  type MergeCallPreparation,
  type MergeCallbackIdentity,
  type PersistedMergeSuccessResult,
  type PersistedMergeEvidence,
  type ExecutorFence,
  type TelegramAgentStore,
} from "../storage/store";
import { shellSingleQuote } from "../bb/terminal-command";
import type { TerminalObservation } from "../bb/terminal-command";
import { projectTerminalLiveness, workerRegistrationGeneration } from "./worker-liveness";
import { isMergeInstruction } from "../controller/merge-instruction";

const POST_MERGE_HEAD_COMMAND = (number: number): string =>
  `git ls-remote --exit-code origin refs/pull/${String(number)}/head`;
const POST_MERGE_PR_COMMAND = (number: number): string =>
  `gh pr view ${String(number)} --json state,mergedAt,mergeCommit,url,number`;
const MAX_PROVIDER_RESULT_JSON = 64_000;

function postMergeBaseContentCommand(baseBranch: string, approvedHead: string, mergeCommit: string): string {
  const baseRef = `refs/remotes/origin/${baseBranch}`;
  const refspec = `+refs/heads/${baseBranch}:${baseRef}`;
  const script = [
    "set -euo pipefail",
    `git fetch --no-tags origin ${shellSingleQuote(refspec)}`,
    `approved_head=${shellSingleQuote(approvedHead)}`,
    `base_ref=${shellSingleQuote(baseRef)}`,
    `merge_commit=${shellSingleQuote(mergeCommit)}`,
    'base_head=$(git rev-parse --verify "$base_ref^{commit}")',
    'test "$base_head" = "$merge_commit"',
    'merge_base=$(git merge-base "$approved_head" "$base_ref")',
    'test -n "$merge_base"',
    'while IFS= read -r -d "" path; do',
    '  approved_object=$(git rev-parse --verify "$approved_head:$path" 2>/dev/null || true)',
    '  base_object=$(git rev-parse --verify "$base_ref:$path" 2>/dev/null || true)',
    '  test "$approved_object" = "$base_object" || exit 1',
    'done < <(git diff --name-only -z "$merge_base" "$approved_head")',
    'git switch --detach "$merge_commit"',
    'test "$(git rev-parse --verify HEAD)" = "$merge_commit"',
  ].join("\n");
  return `bash -lc ${shellSingleQuote(script)}`;
}
const POST_MERGE_JOB_STATES = new Set<Job["state"]>([
  "deploying",
  "verifying_production",
  "production_failed",
  "complete",
  "merged",
]);

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
    onObservation?: (observation: TerminalObservation) => void;
  }): Promise<CommandResult>;
};

export type GateCollectionInput = {
  job: Job;
  phase: "approval" | "pre_merge";
  receipt: MergeReadyReceipt | null;
  now: number;
  approvalExpiresAt?: number;
  fence?: ExecutorFence;
};

export type FreshGateContext = {
  environment: GateInput["environment"];
  review: GateInput["review"];
  receipt: MergeReadyReceipt;
};

export type FreshGateCollectorOptions = {
  validation: Omit<ValidationInput, "environmentId" | "job">;
  getContext: (input: {
    job: Job;
    phase: GateCollectionInput["phase"];
    receipt: MergeReadyReceipt | null;
    validation: ValidationSnapshot;
    now: number;
    approvalExpiresAt?: number;
    fence?: ExecutorFence;
  }) => Promise<FreshGateContext>;
  runValidation?: (input: ValidationInput & { fence?: ExecutorFence }) => Promise<ValidationSnapshot>;
};

function remoteHeadEvidenceFromValidation(
  snapshot: ValidationSnapshot,
  prNumber: number,
): GateInput["remoteHead"] {
  const command = PR_HEAD_COMMAND(prNumber);
  const receipts = snapshot.commandReceipts.filter((receipt) => receipt.command === command);
  if (receipts.length !== 2) {
    throw new TypeError("validation must provide exactly two pull-request head reads");
  }
  const rows = receipts.map((receipt) => {
    if (receipt.outcome !== "pass" || receipt.exitCode !== 0) {
      throw new TypeError("validation contains a failed pull-request head read");
    }
    const headSha = parseLsRemoteHead(receipt.output, prNumber);
    return { rows: [`${headSha}\trefs/pull/${String(prNumber)}/head`] };
  });
  if (rows[0].rows[0].split("\t")[0] !== rows[1].rows[0].split("\t")[0]) {
    throw new TypeError("validation pull-request head reads disagree");
  }
  return { first: rows[0], second: rows[1] };
}

export function createFreshGateCollector(
  options: FreshGateCollectorOptions,
): (input: GateCollectionInput) => Promise<GateInput> {
  const validate = options.runValidation ?? defaultRunValidation;
  return async (input) => {
    const { job } = input;
    if (!job.policy || !job.projectId || !job.environmentId || job.prNumber === null) {
      throw new TypeError("fresh validation requires a fully configured job");
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
      fence: input.fence,
    });
    if (!snapshot.githubPr) throw new TypeError("validation did not return pull-request metadata");
    const context = await options.getContext({
      job,
      phase: input.phase,
      receipt: input.receipt,
      validation: snapshot,
      now: input.now,
      approvalExpiresAt: input.approvalExpiresAt,
      fence: input.fence,
    });
    const remoteHead = remoteHeadEvidenceFromValidation(snapshot, job.prNumber);
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
      receipt: {
        ...context.receipt,
        jobVersion: input.receipt?.jobVersion ?? job.version,
        ...(input.approvalExpiresAt === undefined ? {} : { expiresAt: new Date(input.approvalExpiresAt).toISOString() }),
      },
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
  | { outcome: "rejected" }
  /** The approval arrived before the gate and was durably recorded on the job,
   * to be consumed the moment the approval is issued. */
  | { outcome: "recorded"; jobId: string };

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

function instructionNamesJob(text: string, jobId: string): boolean {
  const escaped = jobId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${escaped}(?:$|[^A-Za-z0-9_-])`, "u").test(text);
}

function instructionHasExplicitJobObject(text: string): boolean {
  const match = /\b(?:merge|land)\s+(?:the\s+job\s+)?([A-Za-z0-9][A-Za-z0-9_-]{2,255})[.!]?$/iu.exec(text.trim());
  if (!match) return false;
  return !new Set([
    "it", "this", "that", "them", "pr", "pull", "change", "changes",
    "fix", "job", "work", "branch", "thing",
  ]).has(match[1].toLowerCase());
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
      const legacyIdentity = previous.outcome === "accepted" && previous.action === "merge" && previous.jobId !== null &&
        owner?.userId === input.userId && owner.chatId === input.chatId &&
        previous.approvalNonceHash === null
        ? this.findAcceptedMergeIdentityByNonce(previous.jobId, approvalNonceHash)
        : null;
      return previous.outcome === "accepted" &&
        previous.action === "merge" &&
        previous.jobId !== null &&
        owner?.userId === input.userId &&
        owner.chatId === input.chatId &&
        ((previous.approvalNonceHash === null && legacyIdentity !== null) ||
          (previous.approvalNonceHash === approvalNonceHash &&
            previous.headSha !== null &&
            previous.effectIdempotencyKey !== null &&
            this.hasAcceptedMergeEffect(previous.jobId, previous.headSha, approvalNonceHash, previous.effectIdempotencyKey)))
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
      const idempotencyKey = `${job.id}:${job.version + 1}:merge_pr`;
      const effect: JobEffectForMerge = {
        idempotencyKey,
        jobId: job.id,
        kind: "merge_pr",
        payload: { headSha: approval.headSha },
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
          headSha: approval.headSha,
          effectIdempotencyKey: idempotencyKey,
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

  /**
   * Accepts the merge the owner just asked for in words rather than by tapping.
   *
   * The button and this path end in the same place: the same approval row, the
   * same version fence, the same single `merge_pr` effect, the same audit. What
   * differs is only how the owner said yes. Nothing here weakens a check: this
   * method validates the instruction, paired-owner identity, exact named job or
   * unambiguous sole live approval, version fence, and outstanding approval.
   * An agent calling it with stale, mismatched, or ambiguous text gets a
   * refusal rather than a merge.
   */
  public approveMergeFromOwnerInstruction(input: {
    jobId: string;
    userId: string;
    chatId: string;
    instructionText: string;
    controllerFence: ControllerMutationFence;
  }): MergeCallbackResult {
    const now = this.clock();
    assertNow(now);
    if (!input.jobId) throw new TypeError("jobId is required");
    if (!isMergeInstruction(input.instructionText)) return { outcome: "rejected" };

    const owner = this.options.store.getOwner();
    if (!owner || owner.userId !== input.userId || owner.chatId !== input.chatId) {
      return { outcome: "rejected" };
    }
    const liveApprovals = this.options.store.listLiveMergeApprovals(now);
    const live = liveApprovals.find((candidate) => candidate.record.jobId === input.jobId) ?? null;
    // No approval has been issued yet: the owner is approving in advance.
    // Their word is recorded on the job and consumed when the gate issues, so
    // it cannot die in an approval window the owner never saw. Ambiguity still
    // refuses: with several live jobs, the owner must name one.
    if (!live && liveApprovals.length === 0) {
      return this.options.store.recordMergePreApproval({
        namedJobId: instructionNamesJob(input.instructionText, input.jobId) ? input.jobId : null,
        ownerUserId: input.userId,
        ownerChatId: input.chatId,
        now,
      });
    }
    if (!live) return { outcome: "rejected" };
    const namedJobs = liveApprovals.filter((candidate) =>
      instructionNamesJob(input.instructionText, candidate.record.jobId));
    const requestedNamed = instructionNamesJob(input.instructionText, input.jobId);
    if (requestedNamed) {
      if (namedJobs.some((candidate) => candidate.record.jobId !== input.jobId)) {
        return { outcome: "rejected" };
      }
    } else {
      if (
        namedJobs.length > 0 ||
        instructionHasExplicitJobObject(input.instructionText) ||
        liveApprovals.length !== 1
      ) return { outcome: "rejected" };
    }
    const job = this.options.store.getJob(live.record.jobId);
    if (!job) return { outcome: "rejected" };

    const accepted = this.approvals.acceptByNonceHash(
      live.nonceHash,
      job.version,
      {
        idempotencyKey: `${job.id}:${job.version + 1}:merge_pr`,
        jobId: job.id,
        kind: "merge_pr",
        payload: { headSha: live.record.headSha },
      },
      now,
      { userId: input.userId, chatId: input.chatId },
      input.controllerFence,
    );
    return { outcome: accepted.ok ? "accepted" : "rejected" };
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
    const executorFence = (): ExecutorFence => ({
      ownerId: input.leaseOwner!,
      generation: input.leaseGeneration!,
      now: freshNow(),
    });
    const renewOperation = (): boolean => this.options.store.renewJobOperationFences({
      jobId: effect.jobId,
      effectIdempotencyKey: effect.idempotencyKey,
      leaseMs: 30_000,
      ...executorFence(),
    });
    if (!renewOperation()) return failCurrentLease("merge effect fence was lost before execution");

    let job: Job | null;
    try {
      job = this.options.store.getJob(effect.jobId);
    } catch (error) {
      return failCurrentLease(error);
    }
    if (!job || job.state !== "merging") return failCurrentLease("Merge effect job is not an active merge");

    let storedPayload: MergeEffectPayload;
    try {
      storedPayload = effectPayload(effect);
    } catch (error) {
      let pending: PendingMergeEffectPayload;
      try {
        pending = parsePendingMergeEffectPayload(effect.payload);
      } catch {
        return failCurrentLease(error);
      }
      try {
        const approvalCollected = await this.options.collectGateInput({
          job,
          phase: "approval",
          receipt: null,
          approvalExpiresAt: pending.approvalExpiresAt,
          now: freshNow(),
          fence: executorFence(),
        });
        if (!renewOperation()) return failCurrentLease("merge approval gate fence was lost");
        const approvalEvaluation = readyEvaluation(approvalCollected, freshNow());
        if (!approvalEvaluation.ready || approvalEvaluation.receipt.jobId !== job.id || approvalEvaluation.receipt.headSha !== pending.headSha) {
          return failCurrentLease("approval gate evidence is stale");
        }
        const durableReceipt = parseDurableMergeReceipt({
          ...approvalEvaluation.receipt,
          jobId: job.id,
          effectIdempotencyKey: effect.idempotencyKey,
          approvalNonceHash: pending.approvalNonceHash,
          approvalOwnerUserId: pending.approvalOwnerUserId,
          approvalOwnerChatId: pending.approvalOwnerChatId,
          jobVersion: job.version,
          approvalJobVersion: pending.approvalJobVersion,
          reviewAttemptId: pending.reviewAttemptId,
          expiresAt: new Date(pending.approvalExpiresAt).toISOString(),
        });
        const bound = this.options.store.bindMergeEffectReceipt({
          jobId: effect.jobId,
          effectIdempotencyKey: effect.idempotencyKey,
          receipt: durableReceipt,
          leaseOwner: input.leaseOwner!,
          leaseGeneration: input.leaseGeneration!,
          now: freshNow(),
        });
        if (!bound) return failCurrentLease("merge receipt binding lost its leased effect");
        const rebound = this.options.store.getEffect(effect.jobId, effect.idempotencyKey);
        if (!rebound) return failCurrentLease("merge effect disappeared after receipt binding");
        storedPayload = effectPayload(rebound);
      } catch (bindError) {
        return failCurrentLease(bindError);
      }
    }
    job = this.options.store.getJob(effect.jobId);
    if (!job || job.state !== "merging") return failCurrentLease("Merge effect job is not an active merge");

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
      return this.finishProviderAttempt(prepared, input, freshNow, renewOperation, failCurrentLease, preserveUnknownOutcome);
    }

    let collected: GateInput;
    let evaluation: GateEvaluation;
    try {
      collected = await this.options.collectGateInput({
        job,
        phase: "pre_merge",
        receipt: storedPayload.receipt as MergeReadyReceipt,
        now: freshNow(),
        fence: executorFence(),
      });
      if (!renewOperation()) return failCurrentLease("merge gate fence was lost");
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
    return this.finishProviderAttempt(prepared, input, freshNow, renewOperation, failCurrentLease, preserveUnknownOutcome);
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
    renewOperation: () => boolean,
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
      if (!renewOperation()) return preserveUnknownOutcome(effect.idempotencyKey);
      if (!providerFence.ok) return preserveUnknownOutcome(effect.idempotencyKey);
      try {
        await this.options.bb.sdk.environments.mergePullRequest({
          environmentId: receipt.environmentId,
          method: receipt.mergeMethod,
        });
      } catch (error) {
        return preserveUnknownOutcome(effect.idempotencyKey);
      }
      if (!renewOperation()) return preserveUnknownOutcome(effect.idempotencyKey);
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
        input.leaseOwner!,
        input.leaseGeneration!,
        freshNow,
        (now) => {
          if (!renewOperation()) return false;
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
    if (confirmed.ok && !renewOperation()) {
      return preserveUnknownOutcome(effect.idempotencyKey);
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
        POST_MERGE_JOB_STATES.has(job.state) &&
        (job.state === "merged" || (
          job.mergeMessage !== null &&
          job.mergeCommitSha === result.mergeCommit.oid &&
          job.mergedAt === result.mergedAt
        )) &&
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
    if (!job) return null;
    const currentOwner = this.options.store.getOwner();
    let candidate: MergeCallbackIdentity | null = null;
    for (const effect of effects) {
      if (effect.kind !== "merge_pr") continue;
      if (effect.jobId !== jobId) return null;
      if (!Object.prototype.hasOwnProperty.call(effect.payload, "receipt")) {
        try {
          const pending = parsePendingMergeEffectPayload(effect.payload);
          if (
            pending.headSha !== headSha ||
            pending.approvalNonceHash !== approvalNonceHash ||
            !approval ||
            approval.jobId !== jobId ||
            approval.headSha !== headSha ||
            approval.consumedAt === null ||
            approval.outcome !== "accepted" ||
            approval.jobVersion !== pending.approvalJobVersion ||
            approval.ownerUserId !== pending.approvalOwnerUserId ||
            approval.ownerChatId !== pending.approvalOwnerChatId ||
            approval.expiresAt !== pending.approvalExpiresAt ||
            job.state !== "merging" ||
            job.cancelRequestedAt !== null ||
            job.version !== pending.approvalJobVersion + 1 ||
            currentOwner?.userId !== pending.approvalOwnerUserId ||
            currentOwner?.chatId !== pending.approvalOwnerChatId ||
            !isCompletedReviewAttempt(this.options.store.getAttempt(pending.reviewAttemptId), jobId, headSha)
          ) return null;
          const identity = { approvalNonceHash, headSha, effectIdempotencyKey: effect.idempotencyKey };
          if (candidate !== null) return null;
          candidate = identity;
          continue;
        } catch {
          try {
            const evidence = parsePersistedMergeEvidence({
              idempotencyKey: effect.idempotencyKey,
              jobId: effect.jobId,
              kind: effect.kind,
              status: effect.status,
              payload: effect.payload,
            });
            if (evidence.disposition === "stale") continue;
          } catch {
            // Malformed or otherwise unrecognized terminal evidence poisons replay reconstruction.
          }
          return null;
        }
      }
      let evidence: PersistedMergeEvidence;
      try {
        evidence = parsePersistedMergeEvidence({
          idempotencyKey: effect.idempotencyKey,
          jobId: effect.jobId,
          kind: effect.kind,
          status: effect.status,
          payload: effect.payload,
        });
      } catch {
        return null;
      }
      if (!isReplayableMergeEvidence(evidence)) continue;
      const receipt = evidence.payload.receipt;
      let evidenceApproval: ReturnType<TelegramAgentStore["getApproval"]>;
      let evidenceAttempt: ReturnType<TelegramAgentStore["getAttempt"]>;
      try {
        evidenceApproval = this.options.store.getApproval(receipt.approvalNonceHash);
        evidenceAttempt = this.options.store.getAttempt(receipt.reviewAttemptId);
      } catch {
        return null;
      }
      if (mergeEvidenceBindingError(evidence, job, evidenceApproval, evidenceAttempt) !== null) return null;
      if (receipt.headSha !== headSha || receipt.approvalNonceHash !== approvalNonceHash) continue;
      if (evidence.disposition === "success") {
        if (!this.isValidCompletedEffect(effect)) return null;
      } else if (
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

  private findAcceptedMergeIdentityByNonce(jobId: string, approvalNonceHash: string): MergeCallbackIdentity | null {
    const approval = this.options.store.getApproval(approvalNonceHash);
    return approval ? this.findAcceptedMergeIdentity(jobId, approval.headSha, approvalNonceHash) : null;
  }

  private async confirmPostMerge(
    receipt: DurableMergeReceipt,
    effectIdempotencyKey: string,
    leaseOwner: string,
    leaseGeneration: number,
    freshNow: () => number,
    checkFence: (now: number) => boolean,
  ): Promise<{ ok: true; result: PersistedMergeSuccessResult } | { ok: false; reason: string }> {
    const livenessJob = this.options.store.getJob(receipt.jobId);
    if (!livenessJob) return { ok: false, reason: "post-merge job is unavailable" };
    let lastObservation: TerminalObservation | null = null;
    const terminalGenerations = new Map<string, number>();
    const generationBase = workerRegistrationGeneration(livenessJob, "merge");
    const observe = (observation: TerminalObservation): void => {
      lastObservation = observation;
      const now = freshNow();
      if (!checkFence(now)) return;
      const current = this.options.store.getJob(receipt.jobId);
      const terminalGeneration = terminalGenerations.get(observation.id) ?? generationBase + terminalGenerations.size + 1;
      terminalGenerations.set(observation.id, terminalGeneration);
      if (current) projectTerminalLiveness(this.options.store, current, observation, "merge", now, terminalGeneration, {
        ownerId: leaseOwner,
        generation: leaseGeneration,
        now,
      });
    };
    if (!checkFence(freshNow())) {
      return { ok: false, reason: "post-merge effect fence rejected the Git head confirmation" };
    }
    const headResult = await this.options.commandRunner.run({
      scope: { kind: "environment", environmentId: receipt.environmentId },
      title: "Telegram post-merge Git head confirmation",
      command: POST_MERGE_HEAD_COMMAND(receipt.prNumber),
      timeoutMs: 60_000,
      onObservation: observe,
    });
    if (headResult.outcome === "timed_out" || headResult.outcome === "aborted") {
      const observation = lastObservation as TerminalObservation | null;
      if (observation) {
        observe({
          id: observation.id,
          status: headResult.outcome,
          updatedAt: freshNow(),
          exitCode: observation.exitCode,
        });
      }
    }
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
      onObservation: observe,
    });
    if (prResult.outcome === "timed_out" || prResult.outcome === "aborted") {
      const observation = lastObservation as TerminalObservation | null;
      if (observation) {
        observe({
          id: observation.id,
          status: prResult.outcome,
          updatedAt: freshNow(),
          exitCode: observation.exitCode,
        });
      }
    }
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
      !/^[0-9a-f]{40}$/.test(mergeCommitOid) ||
      typeof pr.url !== "string"
    ) {
      return { ok: false, reason: "post-merge GitHub state was not strictly merged" };
    }
    if (!checkFence(freshNow())) {
      return { ok: false, reason: "post-merge effect fence rejected the base-content confirmation" };
    }
    const baseResult = await this.options.commandRunner.run({
      scope: { kind: "environment", environmentId: receipt.environmentId },
      title: "Telegram post-merge base-content confirmation",
      command: postMergeBaseContentCommand(receipt.baseBranch, authoritativeHead, mergeCommitOid),
      timeoutMs: 120_000,
      onObservation: observe,
    });
    const baseContentVerified = baseResult.outcome === "exited" && baseResult.exitCode === 0;
    let result: PersistedMergeSuccessResult;
    try {
      result = parsePersistedMergeSuccessResult({
        jobId: receipt.jobId,
        effectIdempotencyKey,
        approvalNonceHash: receipt.approvalNonceHash,
        environmentId: receipt.environmentId,
        prNumber: receipt.prNumber,
        authoritativeHeadSha: authoritativeHead,
        baseContentVerified,
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
