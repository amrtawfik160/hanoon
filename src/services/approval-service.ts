import { randomBytes as nodeRandomBytes } from "node:crypto";
import { hashSecret } from "../crypto";
import type { JobEffect } from "../domain/models";
import type {
  ApprovalAcceptResult,
  ApprovalConsumeResult,
  ApprovalIdentity,
  ApprovalRecord,
  ApprovalState,
  ExecutorFence,
  TelegramAgentStore,
} from "../storage/store";

export const APPROVAL_TTL_MS = 15 * 60_000;
const NONCE_BYTES = 24;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

export type IssuedApproval = {
  nonce: string;
  jobId: string;
  headSha: string;
  jobVersion: number;
  expiresAt: number;
};

export type ApprovalServiceOptions = {
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
};

function assertNow(now: number): void {
  if (!Number.isInteger(now) || now < 0) throw new TypeError("now must be a non-negative integer");
}

function assertHead(headSha: string): void {
  if (!FULL_SHA.test(headSha)) throw new TypeError("headSha must be a 40-character lowercase SHA");
}

function nonce(randomBytes: (size: number) => Buffer): string {
  const value = randomBytes(NONCE_BYTES).toString("base64url");
  if (!NONCE_PATTERN.test(value)) throw new TypeError("approval nonce generator returned an invalid nonce");
  return value;
}

export class ApprovalService {
  private readonly clock: () => number;
  private readonly randomBytes: (size: number) => Buffer;

  public constructor(
    private readonly store: TelegramAgentStore,
    options: ApprovalServiceOptions = {},
  ) {
    this.clock = options.now ?? (() => Date.now());
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
  }

  public issue(jobId: string, headSha: string, now = this.clock(), fence?: ExecutorFence): IssuedApproval {
    const prepared = this.prepareIssue(jobId, headSha, now);
    const input = {
      nonceHash: hashSecret(prepared.value),
      jobId,
      headSha,
      expiresAt: prepared.expiresAt,
      now,
      ownerUserId: prepared.owner.userId,
      ownerChatId: prepared.owner.chatId,
      jobVersion: prepared.job.version,
    };
    if (fence) {
      const created = this.store.createExecutorApproval({ ...input, ...fence });
      if (!created) throw new Error("executor lease was lost before approval issuance");
    } else {
      this.store.createApproval(input);
    }
    return { nonce: prepared.value, jobId, headSha, jobVersion: prepared.job.version, expiresAt: prepared.expiresAt };
  }

  public issueExecutor(jobId: string, headSha: string, fence: ExecutorFence): IssuedApproval {
    return this.issue(jobId, headSha, fence.now, fence);
  }

  public get(nonceValue: string, now = this.clock()): ApprovalRecord | null {
    assertNow(now);
    return this.store.getUsableApproval(hashSecret(nonceValue), now);
  }

  public lookup(nonceValue: string): ApprovalState | null {
    return this.store.getApproval(hashSecret(nonceValue));
  }

  public consume(
    nonceValue: string,
    now = this.clock(),
    identity?: ApprovalIdentity,
  ): ApprovalConsumeResult {
    assertNow(now);
    return this.store.consumeApproval({ nonceHash: hashSecret(nonceValue), now, identity });
  }

  public accept(
    nonceValue: string,
    expectedJobVersion: number,
    effect: JobEffect,
    now = this.clock(),
    identity?: ApprovalIdentity,
  ): ApprovalAcceptResult {
    assertNow(now);
    return this.store.acceptApprovalAndEnqueueMerge({
      nonceHash: hashSecret(nonceValue),
      expectedJobVersion,
      effect,
      now,
      identity,
    });
  }

  public revoke(jobId: string, reason: string, now = this.clock()): number {
    assertNow(now);
    return this.store.revokeApprovals(jobId, reason, now);
  }

  private prepareIssue(jobId: string, headSha: string, now: number): {
    job: NonNullable<ReturnType<TelegramAgentStore["getJob"]>>;
    owner: NonNullable<ReturnType<TelegramAgentStore["getOwner"]>>;
    value: string;
    expiresAt: number;
  } {
    assertNow(now);
    assertHead(headSha);
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} was not found`);
    if (job.state !== "awaiting_merge_approval" || job.prHeadSha !== headSha || job.cancelRequestedAt !== null) {
      throw new Error("Approval can only be issued for the current uncancelled merge head");
    }
    const owner = this.store.getOwner();
    if (!owner) throw new Error("Telegram approval requires a paired owner");
    const value = nonce(this.randomBytes);
    return { job, owner, value, expiresAt: now + APPROVAL_TTL_MS };
  }
}

export function issueApproval(
  store: TelegramAgentStore,
  jobId: string,
  headSha: string,
  now?: number,
  options?: ApprovalServiceOptions,
): IssuedApproval {
  return new ApprovalService(store, options).issue(jobId, headSha, now);
}

export function consumeApproval(
  store: TelegramAgentStore,
  nonceValue: string,
  now: number,
  identity?: ApprovalIdentity,
): ApprovalConsumeResult {
  return new ApprovalService(store).consume(nonceValue, now, identity);
}
