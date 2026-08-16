import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { GateInput } from "../src/domain/gates";
import type { StoredEffect } from "../src/domain/models";
import { projectResourceKey } from "../src/autonomy/models";
import { hashSecret } from "../src/crypto";
import { createFreshGateCollector, MergeHandler } from "../src/services/merge-handler";
import type { ValidationSnapshot } from "../src/bb/validation";
import { ApprovalService } from "../src/services/approval-service";
import { openStore, type DurableMergeReceipt } from "../src/storage/store";
import { policyFixture, sha } from "./helpers";

const HEAD = sha();
const MOVED = sha("b");
const NOW = 1_000;
const COMPLETED_REVIEW_RESULT = JSON.stringify({
  outcome: "pass",
  reasons: [],
  findings: [],
  reviewedHeadSha: HEAD,
  verdict: {
    verdict: "pass",
    reviewedHeadSha: HEAD,
    summary: "review passed",
    findings: [],
    checks: [],
  },
});

function gateInput(overrides: Partial<GateInput> = {}): GateInput {
  const receipt = {
    jobId: "job_1",
    jobVersion: 7,
    projectId: "proj_1",
    environmentId: "env_1",
    prNumber: 17,
    baseBranch: "main",
    headSha: HEAD,
    reviewAttemptId: "review_1",
    validationCompletedAt: new Date(NOW).toISOString(),
    requiredCheckNames: ["test"],
    mergeMethod: "squash" as const,
    expiresAt: new Date(NOW + 15 * 60_000).toISOString(),
  };
  return {
    now: NOW + 1,
    projectId: "proj_1",
    environmentId: "env_1",
    job: {
      id: "job_1",
      version: 7,
      projectId: "proj_1",
      environmentId: "env_1",
      prNumber: 17,
      policy: {
        githubRepository: "acme/cyndra",
        baseBranch: "main",
        requiredChecks: ["test"],
        mergeMethod: "squash",
      },
    },
    environment: {
      id: "env_1",
      projectId: "proj_1",
      status: "available",
      worktree: { clean: true, untrackedFiles: [] },
      checkout: { kind: "branch", branchName: "feature/telegram", headSha: HEAD },
    },
    originRepository: "acme/cyndra",
    remoteHead: {
      first: { rows: [`${HEAD}\trefs/pull/17/head`] },
      second: { rows: [`${HEAD}\trefs/pull/17/head`] },
    },
    pullRequest: {
      available: true,
      number: 17,
      state: "OPEN",
      isDraft: false,
      baseRefName: "main",
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
    },
    githubPr: { number: 17, headRefOid: HEAD },
    review: {
      attemptId: "review_1",
      headSha: HEAD,
      verdict: "pass",
      findings: [],
      reviewerMutated: false,
    },
    validation: {
      outcome: "pass",
      headSha: HEAD,
      completedAt: receipt.validationCompletedAt,
      requiredChecks: [{ name: "test", bucket: "pass", state: "SUCCESS", link: null }],
    },
    receipt,
    ...overrides,
  };
}

function mergeFixture(options: {
  gateInputs?: GateInput[];
  mergeResult?: unknown;
  mergeError?: Error;
  postMergeResult?: unknown;
  collectError?: Error;
  preMergeError?: Error;
  beforePreMerge?: (db: Database.Database) => void;
  clock?: () => number;
} = {}) {
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
  const db = bb.storage.database();
  const clock = options.clock ?? (() => NOW);
  const store = openStore(bb.storage, bb.storage.kv, clock);
  expect(store.acquireExecutorLease(LEASE_OWNER, NOW, 60_000)).toEqual({ acquired: true, generation: LEASE_GENERATION });
  const policy = policyFixture({ requiredChecks: ["test"] });
  store.createPairingCode(hashSecret("pair"), NOW, NOW + 60_000);
  expect(store.pairOwnerWithPrivateChatCode(hashSecret("pair"), "7", "70", NOW)).toEqual({ ok: true });
  store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "merge this", now: NOW });
  db.prepare(
    `UPDATE jobs SET state = 'awaiting_merge_approval', project_id = ?,
       policy_version = 1, policy_json = ?, environment_id = ?, pr_number = ?,
       pr_url = ?, pr_head_sha = ?, version = 7, updated_at = ? WHERE id = ?`,
  ).run(policy.projectId, JSON.stringify(policy), "env_1", 17, "https://github.com/acme/cyndra/pull/17", HEAD, NOW, "job_1");
  db.prepare(
    `INSERT INTO attempts (id, job_id, kind, ordinal, head_sha, result_json, created_at, completed_at)
       VALUES (?, ?, 'review', ?, ?, ?, ?, ?)`,
  ).run("review_1", "job_1", 1, HEAD, COMPLETED_REVIEW_RESULT, NOW, NOW + 1);

  let nonceByte = 2;
  const approvals = new ApprovalService(store, { now: clock, randomBytes: () => Buffer.alloc(24, nonceByte++) });
  const issued = approvals.issue("job_1", HEAD, NOW);
  const gateInputs = options.gateInputs ?? [gateInput()];
  const collectGateInput = vi.fn(async () => {
    const callNumber = collectGateInput.mock.calls.length - 1;
    if (options.collectError) throw options.collectError;
    if (callNumber === 1 && options.preMergeError) throw options.preMergeError;
    if (callNumber === 1 && options.beforePreMerge) options.beforePreMerge(db);
    const selected = gateInputs[Math.min(callNumber, gateInputs.length - 1)]!;
    if (callNumber !== 1) return selected;
    return {
      ...selected,
      job: { ...selected.job, version: 8 },
      receipt: { ...selected.receipt, jobVersion: 8 },
    };
  });
  const mergePullRequest = vi.fn(async () => {
    if (options.mergeError) throw options.mergeError;
    return options.mergeResult ?? { ok: true };
  });
  const commandRunner = {
    run: vi.fn(async ({ command }: { command: string }) => {
      if (command.startsWith("git ls-remote")) return { outcome: "exited" as const, exitCode: 0, output: `${HEAD}\trefs/pull/17/head\n` };
      if (command.startsWith("gh pr view")) {
        return {
          outcome: "exited" as const,
          exitCode: 0,
          output: JSON.stringify({
            number: 17,
            url: "https://github.com/acme/cyndra/pull/17",
            state: "MERGED",
            mergedAt: "2026-08-10T00:00:00.000Z",
            mergeCommit: { oid: "c".repeat(40) },
            ...(options.postMergeResult ?? {}),
          }),
        };
      }
      if (command.startsWith("bash -lc")) {
        return { outcome: "exited" as const, exitCode: 0, output: "" };
      }
      throw new Error(`unexpected confirmation command ${command}`);
    }),
  };
  const handler = new MergeHandler({
    store,
    approvals,
    collectGateInput,
    commandRunner,
    bb: { sdk: { environments: { mergePullRequest } } },
    now: options.clock ?? (() => NOW),
  });
  return { db, store, approvals, issued, handler, collectGateInput, mergePullRequest, commandRunner, now: clock };
}

function typedMergeControllerFence(fixture: ReturnType<typeof mergeFixture>) {
  fixture.store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "70",
    updateId: 900,
    inputText: "merge it",
    now: NOW,
  });
  const turn = fixture.store.claimNextControllerTurn({
    ownerId: LEASE_OWNER,
    generation: LEASE_GENERATION,
    now: NOW,
  });
  if (!turn) throw new Error("controller turn unavailable");
  expect(fixture.store.markControllerSpawned({
    turnId: turn.id,
    ownerId: LEASE_OWNER,
    generation: LEASE_GENERATION,
    now: NOW,
    projectId: "proj_controller",
    hostId: "host_controller",
    threadId: "thr_controller",
  })).toBe(true);
  expect(fixture.store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: LEASE_OWNER,
    generation: LEASE_GENERATION,
    now: NOW,
  })).toBe(true);
  return {
    ownerId: LEASE_OWNER,
    generation: LEASE_GENERATION,
    now: NOW,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    expectedThreadId: "thr_controller",
  };
}

function addWaitingApproval(
  fixture: ReturnType<typeof mergeFixture>,
  jobId = "job_2",
  headSha = MOVED,
): void {
  fixture.store.createJob({ id: jobId, sourceUpdateId: 2, requestText: "other merge", now: NOW });
  fixture.db.prepare(
    "UPDATE jobs SET state = 'awaiting_merge_approval', pr_head_sha = ?, version = 3, updated_at = ? WHERE id = ?",
  ).run(headSha, NOW, jobId);
  fixture.approvals.issue(jobId, headSha, NOW);
}

async function acceptApproval(fixture: ReturnType<typeof mergeFixture>) {
  return fixture.handler.handleApprovalCallback({
    callbackId: "callback_1",
    nonce: fixture.issued.nonce,
    userId: "7",
    chatId: "70",
  });
}

function mergeEffect(store: ReturnType<typeof openStore>): StoredEffect {
  const effect = store.listEffectsForJob("job_1").find((item) => item.kind === "merge_pr");
  if (!effect) throw new Error("merge effect was not enqueued");
  if (Object.prototype.hasOwnProperty.call(effect.payload, "receipt")) return effect;
  const pending = effect.payload as {
    headSha: string;
    reviewAttemptId: string;
    approvalNonceHash: string;
    approvalOwnerUserId: string;
    approvalOwnerChatId: string;
    approvalJobVersion: number;
    approvalExpiresAt: number;
  };
  const job = store.getJob("job_1");
  if (!job?.policy || !job.environmentId || job.prNumber === null) throw new Error("merge job is incomplete");
  const attempt = job.reviewThreadId ? store.getAttemptByThreadId(job.reviewThreadId) : null;
  return {
    ...effect,
    payload: {
      headSha: pending.headSha,
      receipt: {
        jobId: job.id,
        effectIdempotencyKey: effect.idempotencyKey,
        approvalNonceHash: pending.approvalNonceHash,
        approvalOwnerUserId: pending.approvalOwnerUserId,
        approvalOwnerChatId: pending.approvalOwnerChatId,
        jobVersion: job.version,
        approvalJobVersion: pending.approvalJobVersion,
        projectId: job.projectId,
        environmentId: job.environmentId,
        prNumber: job.prNumber,
        baseBranch: job.policy.baseBranch,
        headSha: pending.headSha,
        reviewAttemptId: pending.reviewAttemptId ?? attempt?.id ?? "review_1",
        validationCompletedAt: new Date(NOW).toISOString(),
        requiredCheckNames: [...job.policy.requiredChecks].sort(),
        mergeMethod: job.policy.mergeMethod,
        expiresAt: new Date(pending.approvalExpiresAt).toISOString(),
      },
    },
  };
}

const LEASE_OWNER = "executor-1";
const LEASE_GENERATION = 1;

function leaseMergeEffect(fixture: ReturnType<typeof mergeFixture>, expiresAt = NOW + 60_000): StoredEffect {
  const effect = mergeEffect(fixture.store);
  const job = fixture.store.getJob(effect.jobId);
  if (!job?.policy) throw new Error("merge job policy is missing");
  if (!fixture.store.getAdmission(effect.jobId)) {
    fixture.db.prepare(
      `INSERT INTO job_admissions (
         job_id, project_id, queue_seq, state, resume_event, queued_at, admitted_at
       ) VALUES (?, ?, 1, 'admitted', 'CONFIRMED', ?, ?)`,
    ).run(effect.jobId, job.projectId, NOW, NOW + 1);
    fixture.db.prepare(
      `INSERT INTO job_resource_claims (
         job_id, resource_key, resource_kind, state, owner_id, generation,
         lease_expires_at, acquired_at, renewed_at
       ) VALUES (?, ?, 'project', 'held', ?, ?, ?, ?, ?)`,
    ).run(effect.jobId, projectResourceKey(job.projectId!), LEASE_OWNER, LEASE_GENERATION, Math.max(expiresAt, fixture.now() + 1), NOW, NOW);
  }
  const now = fixture.now();
  const leaseMs = Math.max(1, expiresAt - now);
  const leased = fixture.store.leaseNextJobEffect({
    jobId: effect.jobId,
    ownerId: LEASE_OWNER,
    generation: LEASE_GENERATION,
    now,
    leaseMs,
  });
  if (!leased) throw new Error("merge effect was not leased");
  if (expiresAt !== now + leaseMs) {
    fixture.db.prepare(
      "UPDATE effects SET lease_expires_at = ? WHERE job_id = ? AND idempotency_key = ?",
    ).run(expiresAt, effect.jobId, effect.idempotencyKey);
  }
  return { ...leased, payload: effect.payload };
}

function executeLeased(
  fixture: ReturnType<typeof mergeFixture>,
  effect: StoredEffect,
) {
  return fixture.handler.executeMergeEffect({
    effect,
    leaseOwner: LEASE_OWNER,
    leaseGeneration: LEASE_GENERATION,
  });
}

function fenceUnknown(
  fixture: ReturnType<typeof mergeFixture>,
  effect: StoredEffect,
): void {
  fixture.db.prepare("UPDATE effects SET payload_json = ? WHERE job_id = ? AND idempotency_key = ?")
    .run(JSON.stringify({ ...effect.payload, mergeCallStartedAt: NOW + 2, mergeCallOutcome: "unknown" }), effect.jobId, effect.idempotencyKey);
}

function mergeDurableSnapshot(db: Database.Database): Record<string, unknown[]> {
  return {
    jobs: db.prepare("SELECT * FROM jobs ORDER BY id").all(),
    effects: db.prepare("SELECT * FROM effects ORDER BY idempotency_key").all(),
    attempts: db.prepare("SELECT * FROM attempts ORDER BY id").all(),
    approvals: db.prepare("SELECT * FROM approvals ORDER BY nonce_hash").all(),
    outbox: db.prepare("SELECT * FROM outbox ORDER BY logical_key").all(),
    workerLiveness: db.prepare("SELECT * FROM worker_liveness ORDER BY job_id").all(),
  };
}

function insertCompetingMergeEffect(
  fixture: ReturnType<typeof mergeFixture>,
  idempotencyKey: string,
  payloadJson: string,
  status: "pending" | "leased" | "done" | "failed" | "dead" = "pending",
): void {
  fixture.db.prepare(
    `INSERT INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, 'merge_pr', ?, ?, 0, ?, ?, ?)`,
  ).run(idempotencyKey, "job_1", payloadJson, status, NOW, NOW, NOW);
}

const COMPLETED_ATTEMPT_ISSUES = [
  "wrong job",
  "wrong kind",
  "wrong head",
  "null completion",
  "malformed result",
  "mismatched result/effect binding",
] as const;
type CompletedAttemptIssue = (typeof COMPLETED_ATTEMPT_ISSUES)[number];

function insertCompletedAttemptCompetitor(
  fixture: ReturnType<typeof mergeFixture>,
  issue: CompletedAttemptIssue,
): void {
  const completed = mergeEffect(fixture.store);
  if (completed.status !== "done") throw new Error("the valid merge candidate was not completed");
  const completedPayload = completed.payload as {
    headSha: string;
    receipt: Record<string, unknown>;
    mergeResult: Record<string, unknown>;
  };
  const suffix = issue.replaceAll(/[^a-z]+/g, "-");
  const competitorKey = `${completed.idempotencyKey}:attempt-${suffix}`;
  const attemptId = `review_competitor_${suffix}`;
  const approvalNonceHash = hashSecret(`competitor-${suffix}`);
  fixture.db.prepare(
    `INSERT INTO approvals (
       nonce_hash, job_id, head_sha, expires_at, consumed_at, outcome,
       owner_user_id, owner_chat_id, job_version
     ) VALUES (?, 'job_1', ?, ?, ?, 'accepted', '7', '70', 7)`,
  ).run(approvalNonceHash, MOVED, NOW + 15 * 60_000, NOW + 3);

  const payload = structuredClone(completedPayload);
  payload.headSha = MOVED;
  payload.receipt = {
    ...payload.receipt,
    effectIdempotencyKey: competitorKey,
    approvalNonceHash,
    headSha: MOVED,
    reviewAttemptId: attemptId,
  };
  payload.mergeResult = {
    ...payload.mergeResult,
    effectIdempotencyKey: competitorKey,
    approvalNonceHash,
    authoritativeHeadSha: MOVED,
  };

  let attemptJobId = "job_1";
  let attemptKind = "review";
  let attemptHeadSha = MOVED;
  let attemptResultJson = JSON.stringify(payload.mergeResult);
  let completedAt: number | null = NOW + 10;
  if (issue === "wrong job") {
    fixture.db.prepare(
      "INSERT INTO jobs (id, source_update_id, request_text, state, created_at, updated_at) VALUES (?, ?, ?, 'merged', ?, ?)",
    ).run("job_other", 2, "other", NOW, NOW);
    attemptJobId = "job_other";
  } else if (issue === "wrong kind") {
    attemptKind = "validation";
  } else if (issue === "wrong head") {
    attemptHeadSha = HEAD;
  } else if (issue === "null completion") {
    completedAt = null;
  } else if (issue === "malformed result") {
    attemptResultJson = "{}";
  } else if (issue === "mismatched result/effect binding") {
    attemptResultJson = JSON.stringify({
      ...payload.mergeResult,
      effectIdempotencyKey: `${competitorKey}:different`,
    });
  }

  fixture.db.prepare(
    `INSERT INTO attempts (id, job_id, kind, ordinal, head_sha, result_json, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(attemptId, attemptJobId, attemptKind, 20, attemptHeadSha, attemptResultJson, NOW + 9, completedAt);
  insertCompetingMergeEffect(fixture, competitorKey, JSON.stringify(payload), "done");
}

async function staleOldApprovalAndCreateNewEffect() {
  const fixture = mergeFixture();
  await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
  const oldEffect = leaseMergeEffect(fixture);
  expect(fixture.store.staleMergeEffect({
    jobId: oldEffect.jobId,
    effectIdempotencyKey: oldEffect.idempotencyKey,
    reason: "APPROVAL_STALE: test stale head",
    now: NOW + 3,
    leaseOwner: LEASE_OWNER,
    leaseGeneration: LEASE_GENERATION,
  })).toBe(true);

  const movedReviewResult = JSON.parse(COMPLETED_REVIEW_RESULT) as Record<string, unknown> & {
    verdict: Record<string, unknown>;
  };
  movedReviewResult.reviewedHeadSha = MOVED;
  movedReviewResult.verdict = { ...movedReviewResult.verdict, reviewedHeadSha: MOVED };
  fixture.db.prepare(
    `INSERT INTO attempts (id, job_id, kind, ordinal, head_sha, result_json, created_at, completed_at)
       VALUES (?, ?, 'review', ?, ?, ?, ?, ?)`,
  ).run("review_2", "job_1", 2, MOVED, JSON.stringify(movedReviewResult), NOW + 4, NOW + 5);
  fixture.db.prepare(
    "UPDATE jobs SET state = 'awaiting_merge_approval', pr_head_sha = ?, version = ?, updated_at = ? WHERE id = ?",
  ).run(MOVED, 10, NOW + 4, "job_1");

  const newApproval = fixture.approvals.issue("job_1", MOVED, NOW + 4);
  const oldPayload = oldEffect.payload as { receipt: Record<string, unknown> };
  const newEffectKey = "job_1:11:merge_pr";
  const newEffect = {
    idempotencyKey: newEffectKey,
    jobId: "job_1",
    kind: "merge_pr" as const,
    payload: {
      headSha: MOVED,
      receipt: {
        ...oldPayload.receipt,
        effectIdempotencyKey: newEffectKey,
        approvalNonceHash: hashSecret(newApproval.nonce),
        jobVersion: 11,
        approvalJobVersion: 10,
        headSha: MOVED,
        reviewAttemptId: "review_2",
        validationCompletedAt: new Date(NOW + 5).toISOString(),
        expiresAt: new Date(NOW + 4 + 15 * 60_000).toISOString(),
      },
    },
  };
  expect(fixture.store.acceptApprovalAndEnqueueMerge({
    nonceHash: hashSecret(newApproval.nonce),
    expectedJobVersion: 10,
    effect: newEffect,
    now: NOW + 6,
    identity: { userId: "7", chatId: "70" },
  })).toMatchObject({ ok: true });
  expect(fixture.store.recordCallback(
    "callback_2",
    "job_1",
    "merge",
    "accepted",
    NOW + 6,
    { approvalNonceHash: hashSecret(newApproval.nonce), headSha: MOVED, effectIdempotencyKey: newEffectKey },
  )).toBe(true);
  return { fixture, oldEffect, newApproval, newEffectKey };
}

describe("fresh Telegram merge execution", () => {
  it("accepts an unqualified typed approval only when exactly one job is waiting", () => {
    const fixture = mergeFixture();

    expect(fixture.handler.approveMergeFromOwnerInstruction({
      jobId: "job_1",
      userId: "7",
      chatId: "70",
      instructionText: "merge it",
      controllerFence: typedMergeControllerFence(fixture),
    })).toEqual({ outcome: "accepted" });
    expect(fixture.store.getJob("job_1")?.state).toBe("merging");
  });

  it("rejects an ambiguous typed approval when two jobs are waiting", () => {
    const fixture = mergeFixture();
    addWaitingApproval(fixture);

    expect(fixture.handler.approveMergeFromOwnerInstruction({
      jobId: "job_1",
      userId: "7",
      chatId: "70",
      instructionText: "merge it",
      controllerFence: typedMergeControllerFence(fixture),
    })).toEqual({ outcome: "rejected" });
    expect(fixture.store.getJob("job_1")?.state).toBe("awaiting_merge_approval");
    expect(fixture.store.getJob("job_2")?.state).toBe("awaiting_merge_approval");
  });

  it("binds an explicit typed approval to the named waiting job", () => {
    const fixture = mergeFixture();
    addWaitingApproval(fixture);

    expect(fixture.handler.approveMergeFromOwnerInstruction({
      jobId: "job_2",
      userId: "7",
      chatId: "70",
      instructionText: "merge job_2",
      controllerFence: typedMergeControllerFence(fixture),
    })).toEqual({ outcome: "accepted" });
    expect(fixture.store.getJob("job_1")?.state).toBe("awaiting_merge_approval");
    expect(fixture.store.getJob("job_2")?.state).toBe("merging");
  });

  it("rejects a tool-selected job that differs from the one the owner named", () => {
    const fixture = mergeFixture();
    addWaitingApproval(fixture);

    expect(fixture.handler.approveMergeFromOwnerInstruction({
      jobId: "job_1",
      userId: "7",
      chatId: "70",
      instructionText: "merge job_2",
      controllerFence: typedMergeControllerFence(fixture),
    })).toEqual({ outcome: "rejected" });
    expect(fixture.store.getJob("job_1")?.state).toBe("awaiting_merge_approval");
    expect(fixture.store.getJob("job_2")?.state).toBe("awaiting_merge_approval");
  });

  it("uses the concrete validation receipt for callback and merge-handler head truth", async () => {
    const fixture = mergeFixture();
    const gate = gateInput({
      remoteHead: {
        first: { rows: [`${MOVED}\trefs/pull/17/head`] },
        second: { rows: [`${MOVED}\trefs/pull/17/head`] },
      },
    });
    const snapshot: ValidationSnapshot = {
      headSha: HEAD,
      originRepository: gate.originRepository,
      commandReceipts: [
        {
          command: "git ls-remote --exit-code origin refs/pull/17/head",
          outcome: "pass",
          exitCode: 0,
          output: `${HEAD}\trefs/pull/17/head`,
        },
        {
          command: "git ls-remote --exit-code origin refs/pull/17/head",
          outcome: "pass",
          exitCode: 0,
          output: `${HEAD}\trefs/pull/17/head`,
        },
      ],
      githubPr: {
        number: 17,
        url: "https://github.com/acme/cyndra/pull/17",
        state: "OPEN",
        isDraft: false,
        baseRefName: "main",
        headRefName: "feature/telegram",
        mergeStateStatus: "CLEAN",
        mergeable: "MERGEABLE",
        reviewDecision: null,
        changedFiles: 0,
        additions: 0,
        deletions: 0,
        mergeCommit: null,
        mergedAt: null,
      },
      requiredChecks: gate.validation.requiredChecks.map((check) => ({
        name: check.name,
        bucket: check.bucket,
        state: check.state ?? "SUCCESS",
        link: check.link ?? null,
      })),
      validationOutcome: "pass",
      completedAt: gate.validation.completedAt,
      reviewAttemptId: "review_1",
    };
    const contextGate = gate;
    const runValidation = vi.fn(async () => snapshot);
    const collector = createFreshGateCollector({
      validation: { runner: {} as never, environments: {} as never },
      runValidation,
      getContext: async ({ receipt }) => ({
        environment: contextGate.environment,
        review: contextGate.review,
        receipt: receipt ?? contextGate.receipt,
      }),
    });
    const handler = new MergeHandler({
      store: fixture.store,
      approvals: fixture.approvals,
      collectGateInput: collector,
      commandRunner: fixture.commandRunner,
      bb: { sdk: { environments: { mergePullRequest: fixture.mergePullRequest } } },
      now: () => NOW,
    });

    await expect(handler.handleApprovalCallback({
      callbackId: "callback_factory",
      nonce: fixture.issued.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);
    await expect(handler.executeMergeEffect({
      effect,
      leaseOwner: LEASE_OWNER,
      leaseGeneration: LEASE_GENERATION,
    })).resolves.toMatchObject({ outcome: "merged" });
    expect(runValidation).toHaveBeenCalledTimes(2);
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(fixture.store.getJob("job_1")?.state).toBe("deploying");
    expect(fixture.store.listHeldResourceClaims("job_1", 10).filter((claim) => claim.state === "held" && claim.resourceKind !== "project")).toEqual([
      expect.objectContaining({ resourceKind: "production_target", state: "held" }),
    ]);
  });

  it("requires a fresh ready-gate evaluation before accepting approval", async () => {
    const fixture = mergeFixture();

    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    expect(fixture.collectGateInput).not.toHaveBeenCalled();
    expect(mergeEffect(fixture.store).payload).toMatchObject({ headSha: HEAD });
    expect(fixture.store.getJob("job_1")?.state).toBe("merging");
  });

  it("accepts the callback without collecting gates and defers expiry validation to the executor", async () => {
    let currentNow = NOW + 1;
    const fixture = mergeFixture({ clock: () => currentNow });
    fixture.collectGateInput.mockImplementationOnce(async () => {
      currentNow = NOW + 15 * 60_000;
      return gateInput();
    });

    await expect(fixture.handler.handleApprovalCallback({
      callbackId: "callback_crossed_expiry",
      nonce: fixture.issued.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toEqual({ outcome: "accepted" });
    expect(fixture.collectGateInput).not.toHaveBeenCalled();
    expect(fixture.store.listEffectsForJob("job_1").filter((item) => item.kind === "merge_pr")).toHaveLength(1);
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["stale local head", gateInput({ environment: { ...gateInput().environment, checkout: { kind: "branch", branchName: "feature/telegram", headSha: MOVED } } })],
    ["stale gh head metadata", gateInput({ githubPr: { number: 17, headRefOid: HEAD }, remoteHead: { first: { rows: [`${MOVED}\trefs/pull/17/head`] }, second: { rows: [`${MOVED}\trefs/pull/17/head`] } }, environment: { ...gateInput().environment, checkout: { kind: "branch", branchName: "feature/telegram", headSha: MOVED } } })],
    ["malformed git head", gateInput({ remoteHead: { first: { rows: ["not-a-git-head"] }, second: { rows: ["not-a-git-head"] } } })],
    ["pending required check", gateInput({ validation: { ...gateInput().validation, requiredChecks: [{ name: "test", bucket: "pending", state: "PENDING", link: null }] } })],
    ["merge conflict", gateInput({ pullRequest: { ...gateInput().pullRequest, mergeable: "CONFLICTING" } })],
  ] as const)("fails closed for %s", async (_label, input) => {
    const fixture = mergeFixture({ gateInputs: [input] });

    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    await expect(executeLeased(fixture, leaseMergeEffect(fixture))).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
  });

  it("makes callback replay idempotent without a second fresh evaluation", async () => {
    const fixture = mergeFixture();
    const first = await acceptApproval(fixture);
    const second = await acceptApproval(fixture);

    expect(first).toEqual(second);
    expect(fixture.collectGateInput).toHaveBeenCalledTimes(0);
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM callbacks").get()).toEqual({ count: 1 });
  });

  it.each([
    ["same callback id", "callback_1"],
    ["consumed approval replay", "callback_cancelled_replay"],
  ] as const)("rejects %s after cancellation is requested after acceptance", async (_label, callbackId) => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    fixture.db.prepare("UPDATE jobs SET cancel_requested_at = ? WHERE id = 'job_1'").run(NOW + 2);

    await expect(fixture.handler.handleApprovalCallback({
      callbackId,
      nonce: fixture.issued.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toEqual({ outcome: "rejected" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
    expect(fixture.store.getEffect("job_1", mergeEffect(fixture.store).idempotencyKey)).toMatchObject({
      status: "pending",
    });
  });

  it("rejects a same-callback replay after the paired owner is re-paired", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    expect(fixture.store.revokeOwner(NOW + 2)).toBe(true);
    fixture.store.createPairingCode(hashSecret("replacement-pair"), NOW + 2, NOW + 60_000);
    expect(fixture.store.pairOwnerWithPrivateChatCode(
      hashSecret("replacement-pair"),
      "8",
      "80",
      NOW + 3,
    )).toEqual({ ok: true });

    await expect(fixture.handler.handleApprovalCallback({
      callbackId: "callback_1",
      nonce: fixture.issued.nonce,
      userId: "8",
      chatId: "80",
    })).resolves.toEqual({ outcome: "rejected" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["JSON-valid schema-invalid", (effect: StoredEffect) => JSON.stringify({ headSha: HEAD, receipt: {} })],
    ["malformed JSON", () => "{malformed"],
    ["mismatched receipt binding", (effect: StoredEffect) => {
      const payload = structuredClone(effect.payload) as { receipt: Record<string, unknown> };
      payload.receipt.approvalOwnerUserId = "8";
      return JSON.stringify(payload);
    }],
  ] as const)("fails closed in store replay reconstruction when a competing row is %s", async (_label, payloadFor) => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = mergeEffect(fixture.store);
    insertCompetingMergeEffect(fixture, `${effect.idempotencyKey}:corrupt`, payloadFor(effect));

    const storeReplay = fixture.store.rejectApprovalAndRecordCallback({
      nonceHash: hashSecret(fixture.issued.nonce),
      callbackId: `store_replay_${_label.replaceAll(" ", "_")}`,
      jobId: "job_1",
      now: NOW + 3,
    });
    expect(storeReplay.outcome).toBe("rejected");
    expect(fixture.store.getCallback(`store_replay_${_label.replaceAll(" ", "_")}`)?.outcome).toBe("rejected");
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM effects WHERE job_id = 'job_1' AND kind = 'merge_pr'").get())
      .toEqual({ count: 2 });
  });

  it.each([
    ["JSON-valid schema-invalid", (effect: StoredEffect) => JSON.stringify({ headSha: HEAD, receipt: {} })],
    ["mismatched receipt binding", (effect: StoredEffect) => {
      const payload = structuredClone(effect.payload) as { receipt: Record<string, unknown> };
      payload.receipt.approvalOwnerUserId = "8";
      return JSON.stringify(payload);
    }],
  ] as const)("rejects handler replay when a competing row is %s", async (_label, payloadFor) => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = mergeEffect(fixture.store);
    insertCompetingMergeEffect(fixture, `${effect.idempotencyKey}:handler-corrupt`, payloadFor(effect));

    await expect(fixture.handler.handleApprovalCallback({
      callbackId: `handler_replay_${_label.replaceAll(" ", "_")}`,
      nonce: fixture.issued.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toEqual({ outcome: "rejected" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
  });

  it("rejects handler replay when a competing row contains malformed JSON", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = mergeEffect(fixture.store);
    insertCompetingMergeEffect(fixture, `${effect.idempotencyKey}:handler-malformed`, "{malformed");

    await expect(fixture.handler.handleApprovalCallback({
      callbackId: "handler_replay_malformed",
      nonce: fixture.issued.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toEqual({ outcome: "rejected" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
  });

  it("rejects handler replay when a competing completed row has a mismatched result", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);
    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "merged" });
    const completed = fixture.store.getEffect("job_1", effect.idempotencyKey);
    if (!completed) throw new Error("completed merge effect was not durable");
    const payload = structuredClone(completed.payload) as {
      receipt: Record<string, unknown>;
      mergeResult: Record<string, unknown>;
    };
    const competingKey = `${effect.idempotencyKey}:result-corrupt`;
    payload.receipt.effectIdempotencyKey = competingKey;
    payload.mergeResult.effectIdempotencyKey = competingKey;
    payload.mergeResult.authoritativeHeadSha = MOVED;
    insertCompetingMergeEffect(fixture, competingKey, JSON.stringify(payload), "done");

    await expect(fixture.handler.handleApprovalCallback({
      callbackId: "handler_replay_result_mismatch",
      nonce: fixture.issued.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toEqual({ outcome: "rejected" });
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "dead"] as const)(
    "rejects handler replay when a %s competing merge row has a corrupt terminal payload",
    async (status) => {
      const fixture = mergeFixture();
      await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
      const effect = mergeEffect(fixture.store);
      insertCompetingMergeEffect(
        fixture,
        `${effect.idempotencyKey}:corrupt-${status}`,
        JSON.stringify({ mergeCleanup: "failed", unexpected: true }),
        status,
      );

      await expect(fixture.handler.handleApprovalCallback({
        callbackId: `handler_corrupt_${status}`,
        nonce: fixture.issued.nonce,
        userId: "7",
        chatId: "70",
      })).resolves.toEqual({ outcome: "rejected" });
      expect(fixture.mergePullRequest).not.toHaveBeenCalled();
    },
  );

  it.each(["failed", "dead"] as const)(
    "rejects legacy reconstruction when a %s competing merge row has a corrupt terminal payload",
    async (status) => {
      const fixture = mergeFixture();
      await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
      const effect = mergeEffect(fixture.store);
      fixture.db.prepare(
        "UPDATE callbacks SET approval_nonce_hash = NULL, head_sha = NULL, effect_idempotency_key = NULL WHERE callback_query_id = 'callback_1'",
      ).run();
      insertCompetingMergeEffect(
        fixture,
        `${effect.idempotencyKey}:legacy-corrupt-${status}`,
        JSON.stringify({ mergeCleanup: "failed", unexpected: true }),
        status,
      );

      expect(fixture.store.getCallback("callback_1")).toMatchObject({
        outcome: "accepted",
        approvalNonceHash: null,
        headSha: null,
        effectIdempotencyKey: null,
      });
    },
  );

  it.each(["handler", "store", "legacy"] as const)(
    "fails closed when a head-mismatched competitor has a bad internal binding in the %s replay path",
    async (path) => {
      const fixture = mergeFixture();
      await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
      const effect = mergeEffect(fixture.store);
      const payload = structuredClone(effect.payload) as {
        headSha: string;
        receipt: Record<string, unknown>;
      };
      payload.headSha = MOVED;
      payload.receipt.headSha = MOVED;
      payload.receipt.approvalNonceHash = "f".repeat(64);
      payload.receipt.effectIdempotencyKey = "job_1:bad-internal-binding";
      insertCompetingMergeEffect(
        fixture,
        `${effect.idempotencyKey}:head-mismatch-corrupt`,
        JSON.stringify(payload),
      );

      if (path === "legacy") {
        fixture.db.prepare(
          "UPDATE callbacks SET approval_nonce_hash = NULL, head_sha = NULL, effect_idempotency_key = NULL WHERE callback_query_id = 'callback_1'",
        ).run();
        expect(fixture.store.getCallback("callback_1")).toMatchObject({
          outcome: "accepted",
          approvalNonceHash: null,
          headSha: null,
          effectIdempotencyKey: null,
        });
      } else if (path === "store") {
        expect(fixture.store.rejectApprovalAndRecordCallback({
          nonceHash: hashSecret(fixture.issued.nonce),
          callbackId: "store_head_mismatch_corrupt",
          jobId: "job_1",
          headSha: HEAD,
          now: NOW + 3,
        })).toMatchObject({ outcome: "rejected" });
      } else {
        await expect(fixture.handler.handleApprovalCallback({
          callbackId: "handler_head_mismatch_corrupt",
          nonce: fixture.issued.nonce,
          userId: "7",
          chatId: "70",
        })).resolves.toEqual({ outcome: "rejected" });
      }
      expect(fixture.mergePullRequest).not.toHaveBeenCalled();
    },
  );

  it("replays the new approval while ignoring a canonical stale tombstone, but rejects old replay identities", async () => {
    const { fixture, oldEffect, newApproval, newEffectKey } = await staleOldApprovalAndCreateNewEffect();
    expect(fixture.db.prepare("SELECT payload_json FROM effects WHERE idempotency_key = ?").get(oldEffect.idempotencyKey)).toEqual({
      payload_json: JSON.stringify({
        mergeOutcome: "stale",
        jobId: "job_1",
        effectIdempotencyKey: oldEffect.idempotencyKey,
      }),
    });

    await expect(fixture.handler.handleApprovalCallback({
      callbackId: "callback_1",
      nonce: fixture.issued.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toEqual({ outcome: "rejected" });
    await expect(fixture.handler.handleApprovalCallback({
      callbackId: "old_consumed_replay",
      nonce: fixture.issued.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toEqual({ outcome: "rejected" });

    fixture.db.prepare(
      "UPDATE callbacks SET approval_nonce_hash = NULL, head_sha = NULL, effect_idempotency_key = NULL WHERE callback_query_id = 'callback_2'",
    ).run();
    await expect(fixture.handler.handleApprovalCallback({
      callbackId: "callback_2",
      nonce: newApproval.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toEqual({ outcome: "accepted" });
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM effects WHERE job_id = 'job_1' AND kind = 'merge_pr'").get())
      .toEqual({ count: 2 });
    expect(fixture.store.getCallback("callback_2")).toMatchObject({
      approvalNonceHash: hashSecret(newApproval.nonce),
      headSha: MOVED,
      effectIdempotencyKey: newEffectKey,
    });
    expect(fixture.store.getEffect("job_1", newEffectKey)).toMatchObject({ status: "pending" });
  });

  it.each(["handler", "legacy"] as const)(
    "poisons %s replay reconstruction for a malformed stale tombstone beside a valid new effect",
    async (path) => {
      const { fixture, newApproval, newEffectKey } = await staleOldApprovalAndCreateNewEffect();
      insertCompetingMergeEffect(
        fixture,
        `${newEffectKey}:stale-lookalike`,
        JSON.stringify({ mergeOutcome: "stale", jobId: "job_1" }),
        "done",
      );

      if (path === "legacy") {
        fixture.db.prepare(
          "UPDATE callbacks SET approval_nonce_hash = NULL, head_sha = NULL, effect_idempotency_key = NULL WHERE callback_query_id = 'callback_2'",
        ).run();
        expect(fixture.store.getCallback("callback_2")).toMatchObject({
          outcome: "accepted",
          approvalNonceHash: null,
          headSha: null,
          effectIdempotencyKey: null,
        });
      } else {
        await expect(fixture.handler.handleApprovalCallback({
          callbackId: "handler_stale_lookalike",
          nonce: newApproval.nonce,
          userId: "7",
          chatId: "70",
        })).resolves.toEqual({ outcome: "rejected" });
      }
      expect(fixture.mergePullRequest).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["JSON-valid schema-invalid", (effect: StoredEffect) => JSON.stringify({ headSha: HEAD, receipt: {} })],
    ["malformed JSON", () => "{malformed"],
    ["mismatched receipt binding", (effect: StoredEffect) => {
      const payload = structuredClone(effect.payload) as { receipt: Record<string, unknown> };
      payload.receipt.approvalOwnerUserId = "8";
      return JSON.stringify(payload);
    }],
  ] as const)("fails closed in legacy callback reconstruction when a competing row is %s", async (_label, payloadFor) => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = mergeEffect(fixture.store);
    fixture.db.prepare(
      "UPDATE callbacks SET approval_nonce_hash = NULL, head_sha = NULL, effect_idempotency_key = NULL WHERE callback_query_id = 'callback_1'",
    ).run();
    insertCompetingMergeEffect(fixture, `${effect.idempotencyKey}:legacy-corrupt`, payloadFor(effect));

    expect(fixture.store.getCallback("callback_1")).toMatchObject({
      outcome: "accepted",
      approvalNonceHash: null,
      headSha: null,
      effectIdempotencyKey: null,
    });
  });

  it("fails closed in legacy callback reconstruction when a competing completed row has a mismatched result", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);
    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "merged" });
    const completed = fixture.store.getEffect("job_1", effect.idempotencyKey);
    if (!completed) throw new Error("completed merge effect was not durable");
    const payload = structuredClone(completed.payload) as {
      receipt: Record<string, unknown>;
      mergeResult: Record<string, unknown>;
    };
    const competingKey = `${effect.idempotencyKey}:legacy-result-corrupt`;
    payload.receipt.effectIdempotencyKey = competingKey;
    payload.mergeResult.effectIdempotencyKey = competingKey;
    payload.mergeResult.authoritativeHeadSha = MOVED;
    fixture.db.prepare(
      "UPDATE callbacks SET approval_nonce_hash = NULL, head_sha = NULL, effect_idempotency_key = NULL WHERE callback_query_id = 'callback_1'",
    ).run();
    insertCompetingMergeEffect(fixture, competingKey, JSON.stringify(payload), "done");

    expect(fixture.store.getCallback("callback_1")).toMatchObject({
      outcome: "accepted",
      approvalNonceHash: null,
      headSha: null,
      effectIdempotencyKey: null,
    });
  });

  it("rejects a replay of an accepted callback when its supplied nonce differs", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });

    await expect(fixture.handler.handleApprovalCallback({
      callbackId: "callback_1",
      nonce: "Z".repeat(32),
      userId: "7",
      chatId: "70",
    })).resolves.toEqual({ outcome: "rejected" });
  });

  it("rejects an old callback after a new-head approval instead of borrowing its effect", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    fixture.db.prepare(
      "INSERT INTO attempts (id, job_id, kind, ordinal, head_sha, created_at) VALUES (?, ?, 'review', ?, ?, ?)",
    ).run("review_2", "job_1", 2, MOVED, NOW);
    fixture.db.prepare(
      "UPDATE jobs SET state = 'awaiting_merge_approval', pr_head_sha = ?, version = ?, updated_at = ? WHERE id = ?",
    ).run(MOVED, 9, NOW + 1, "job_1");

    const newerApproval = fixture.approvals.issue("job_1", MOVED, NOW + 1);
    const oldEffect = mergeEffect(fixture.store);
    const oldReceipt = (oldEffect.payload as { receipt: Record<string, unknown> }).receipt;
    const newerEffect = {
      idempotencyKey: "job_1:10:merge_pr",
      jobId: "job_1",
      kind: "merge_pr" as const,
      payload: {
        headSha: MOVED,
        receipt: {
          ...oldReceipt,
          effectIdempotencyKey: "job_1:10:merge_pr",
          approvalNonceHash: hashSecret(newerApproval.nonce),
          jobVersion: 10,
          approvalJobVersion: 9,
          headSha: MOVED,
          reviewAttemptId: "review_2",
          expiresAt: new Date(NOW + 1 + 15 * 60_000).toISOString(),
        },
      },
    };
    expect(fixture.store.acceptApprovalAndEnqueueMerge({
      nonceHash: hashSecret(newerApproval.nonce),
      expectedJobVersion: 9,
      effect: newerEffect,
      now: NOW + 2,
      identity: { userId: "7", chatId: "70" },
    })).toMatchObject({ ok: true });

    await expect(fixture.handler.handleApprovalCallback({
      callbackId: "callback_1",
      nonce: fixture.issued.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toEqual({ outcome: "rejected" });
    await expect(fixture.handler.handleApprovalCallback({
      callbackId: "callback_old_after_new_head",
      nonce: fixture.issued.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toEqual({ outcome: "rejected" });
    expect(fixture.store.listEffectsForJob("job_1").filter((item) => item.kind === "merge_pr")).toHaveLength(2);
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
  });

  it("rejects remote head movement after approval acceptance before the merge effect", async () => {
    const fixture = mergeFixture({ gateInputs: [gateInput(), gateInput({
      environment: { ...gateInput().environment, checkout: { kind: "branch", branchName: "feature/telegram", headSha: MOVED } },
      remoteHead: { first: { rows: [`${MOVED}\trefs/pull/17/head`] }, second: { rows: [`${MOVED}\trefs/pull/17/head`] } },
      githubPr: { number: 17, headRefOid: HEAD },
    })] });
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });

    const leasedEffect = leaseMergeEffect(fixture);
    const effectKey = leasedEffect.idempotencyKey;
    await expect(executeLeased(fixture, leasedEffect)).resolves.toMatchObject({ outcome: "stale" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
    expect(fixture.store.getEffect("job_1", effectKey)?.payload).toEqual({
      mergeOutcome: "stale",
      jobId: "job_1",
      effectIdempotencyKey: effectKey,
    });
  });

  it("preserves an unknown provider outcome after SDK failure for reconciliation", async () => {
    const fixture = mergeFixture({ mergeError: new Error("provider rejected merge") });
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const firstEffect = leaseMergeEffect(fixture);

    await expect(executeLeased(fixture, firstEffect)).resolves.toMatchObject({ outcome: "failed" });
    const unknown = fixture.store.getEffect("job_1", firstEffect.idempotencyKey);
    expect(unknown).toMatchObject({ status: "pending", lastError: expect.stringContaining("unknown") });
    expect(unknown?.payload).toMatchObject({
      mergeCallStartedAt: expect.any(Number),
      mergeCallOutcome: "unknown",
    });
    expect(fixture.store.getJob("job_1")?.state).toBe("merging");

    await expect(executeLeased(fixture, leaseMergeEffect(fixture))).resolves.toMatchObject({ outcome: "merged" });
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it("preserves an unknown provider outcome after failed confirmation for reconciliation", async () => {
    const fixture = mergeFixture({ postMergeResult: { state: "OPEN" } });
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const firstEffect = leaseMergeEffect(fixture);

    await expect(executeLeased(fixture, firstEffect)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.store.getEffect("job_1", firstEffect.idempotencyKey)).toMatchObject({
      status: "pending",
      lastError: expect.stringContaining("unknown"),
    });

    fixture.commandRunner.run.mockImplementation(async ({ command }: { command: string }) => {
      if (command.startsWith("git ls-remote")) {
        return { outcome: "exited", exitCode: 0, output: `${HEAD}\trefs/pull/17/head\n` };
      }
      return {
        outcome: "exited",
        exitCode: 0,
        output: JSON.stringify({
          number: 17,
          url: "https://github.com/acme/cyndra/pull/17",
          state: "MERGED",
          mergedAt: "2026-08-10T00:00:00.000Z",
          mergeCommit: { oid: "c".repeat(40) },
        }),
      };
    });

    await expect(executeLeased(fixture, leaseMergeEffect(fixture))).resolves.toMatchObject({ outcome: "merged" });
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it("calls the BB merge SDK at most once and fails closed on SDK rejection", async () => {
    const fixture = mergeFixture({ mergeError: new Error("provider rejected merge") });
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "failed" });
    await expect(fixture.handler.executeMergeEffect({
      effect: { ...effect, status: "done" },
      leaseOwner: LEASE_OWNER,
      leaseGeneration: LEASE_GENERATION,
    })).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(fixture.mergePullRequest).toHaveBeenCalledWith({ environmentId: "env_1", method: "squash" });
  });

  it("confirms Git-native head and strict gh merged state before persisting success", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const result = await executeLeased(fixture, leaseMergeEffect(fixture));

    expect(result).toMatchObject({ outcome: "merged" });
    expect(fixture.store.getJob("job_1")?.state).toBe("deploying");
    expect(fixture.commandRunner.run.mock.calls.map(([call]) => call.command)).toEqual([
      "git ls-remote --exit-code origin refs/pull/17/head",
      "gh pr view 17 --json state,mergedAt,mergeCommit,url,number",
      expect.stringMatching(/git fetch --no-tags origin[\s\S]*while .*; do\n/),
    ]);
    const baseCheckoutCommand = fixture.commandRunner.run.mock.calls[2]?.[0].command;
    expect(baseCheckoutCommand).toContain("merge_commit=");
    expect(baseCheckoutCommand).toContain("c".repeat(40));
    expect(baseCheckoutCommand).toContain('git switch --detach "$merge_commit"');
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM outbox").get()).toEqual({ count: 0 });
    expect(fixture.store.listEffectsForJob("job_1").filter((item) => item.kind === "deploy_production")).toHaveLength(1);
    const payload = fixture.db.prepare("SELECT payload_json FROM effects WHERE kind = 'merge_pr'").get() as { payload_json: string };
    expect(payload.payload_json).toContain(HEAD);
    expect(payload.payload_json).toContain("MERGED");
  });

  it("preserves the merge fact and blocks deployment when base-content verification fails", async () => {
    const fixture = mergeFixture();
    const defaultRun = fixture.commandRunner.run.getMockImplementation();
    if (!defaultRun) throw new Error("default command runner is missing");
    fixture.commandRunner.run.mockImplementation(async (input) => (
      input.command.startsWith("bash -lc")
        ? { outcome: "exited" as const, exitCode: 1, output: "content mismatch" }
        : defaultRun(input)
    ));
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });

    await expect(executeLeased(fixture, leaseMergeEffect(fixture))).resolves.toMatchObject({ outcome: "merged" });

    expect(fixture.store.getJob("job_1")).toMatchObject({
      state: "production_failed",
      mergeCommitSha: "c".repeat(40),
      lastError: "Merge succeeded but the base branch did not verify the approved content",
    });
    expect(fixture.store.listEffectsForJob("job_1").some((effect) => effect.kind === "deploy_production")).toBe(false);
    expect(fixture.store.listHeldResourceClaims("job_1", 100)
      .filter((claim) => claim.resourceKind !== "project")).not.toContainEqual(
      expect.objectContaining({ state: "held" }),
    );
    const mergeEffect = fixture.store.listEffectsForJob("job_1").find((effect) => effect.kind === "merge_pr");
    expect(mergeEffect?.payload).toMatchObject({ mergeResult: { baseContentVerified: false } });
  });

  it("projects a post-merge confirmation timeout as failed terminal liveness", async () => {
    const fixture = mergeFixture();
    fixture.commandRunner.run.mockImplementation((async ({ command, onObservation }: {
      command: string;
      onObservation?: (observation: { id: string; status: string; updatedAt: number; exitCode?: number | null }) => void;
    }) => {
      if (!command.startsWith("git ls-remote")) {
        throw new Error(`unexpected confirmation command ${command}`);
      }
      onObservation?.({ id: "merge-terminal-1", status: "running", updatedAt: NOW + 1 });
      return { outcome: "timed_out" as const };
    }) as never);

    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    await expect(executeLeased(fixture, leaseMergeEffect(fixture))).resolves.toMatchObject({ outcome: "failed" });

    expect(fixture.store.getWorkerLiveness("job_1")).toMatchObject({
      workerKind: "merge",
      resourceKind: "bb_terminal",
      resourceId: "merge-terminal-1",
      state: "failed",
    });
  });

  it("persists merge success and leaves Telegram delivery to the outbox worker", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "merged" });
    expect(fixture.store.getJob("job_1")?.state).toBe("deploying");
    expect(fixture.store.listHeldResourceClaims("job_1", 100)).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceKind: "production_target", state: "held" }),
    ]));
    expect(fixture.store.listHeldResourceClaims("job_1", 100)).not.toContainEqual(
      expect.objectContaining({ resourceKind: "repository_merge", state: "held" }),
    );
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);

    await expect(fixture.handler.executeMergeEffect({
      effect: { ...effect, status: "done" },
      leaseOwner: LEASE_OWNER,
      leaseGeneration: LEASE_GENERATION,
    })).resolves.toMatchObject({ outcome: "already_done" });
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it("replays an accepted callback after completion from the bounded durable merge result", async () => {
    const fixture = mergeFixture();
    const first = await acceptApproval(fixture);
    const effect = leaseMergeEffect(fixture);

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "merged" });
    const completed = fixture.store.getEffect("job_1", effect.idempotencyKey);
    expect(completed?.status).toBe("done");
    expect(completed?.payload).toHaveProperty("mergeResult");

    await expect(fixture.handler.handleApprovalCallback({
      callbackId: "callback_after_completion",
      nonce: fixture.issued.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toEqual(first);
    expect(fixture.collectGateInput).toHaveBeenCalledTimes(2);
    expect(fixture.store.listEffectsForJob("job_1").filter((item) => item.kind === "merge_pr")).toHaveLength(1);
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(fixture.commandRunner.run).toHaveBeenCalledTimes(3);
  });

  it.each(COMPLETED_ATTEMPT_ISSUES)(
    "rejects handler replay when an off-head successful competitor has a %s owning attempt",
    async (issue) => {
      const fixture = mergeFixture();
      await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
      await expect(executeLeased(fixture, leaseMergeEffect(fixture))).resolves.toMatchObject({ outcome: "merged" });
      insertCompletedAttemptCompetitor(fixture, issue);

      await expect(fixture.handler.handleApprovalCallback({
        callbackId: `handler_competitor_${issue.replaceAll(/[^a-z]+/g, "_")}`,
        nonce: fixture.issued.nonce,
        userId: "7",
        chatId: "70",
      })).resolves.toEqual({ outcome: "rejected" });
      expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
    },
  );

  it.each(COMPLETED_ATTEMPT_ISSUES)(
    "rejects store replay when an off-head successful competitor has a %s owning attempt",
    async (issue) => {
      const fixture = mergeFixture();
      await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
      await expect(executeLeased(fixture, leaseMergeEffect(fixture))).resolves.toMatchObject({ outcome: "merged" });
      insertCompletedAttemptCompetitor(fixture, issue);

      const callbackId = `store_competitor_${issue.replaceAll(/[^a-z]+/g, "_")}`;
      expect(fixture.store.rejectApprovalAndRecordCallback({
        nonceHash: hashSecret(fixture.issued.nonce),
        callbackId,
        jobId: "job_1",
        now: NOW + 20,
      })).toMatchObject({ outcome: "rejected" });
      expect(fixture.store.getCallback(callbackId)?.outcome).toBe("rejected");
      expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
    },
  );

  it("replays an accepted callback after a harmless terminal status version increment", async () => {
    const fixture = mergeFixture();
    const first = await acceptApproval(fixture);
    const effect = leaseMergeEffect(fixture);

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "merged" });
    fixture.db.prepare(
      "UPDATE jobs SET status_message_id = ?, version = version + 1, updated_at = ? WHERE id = ?",
    ).run(999, NOW + 4, "job_1");

    await expect(fixture.handler.handleApprovalCallback({
      callbackId: "callback_after_status_update",
      nonce: fixture.issued.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toEqual(first);
  });

  it("rejects a completed callback when the receipt effect key no longer matches the effect", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);
    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "merged" });

    const completed = fixture.store.getEffect("job_1", effect.idempotencyKey);
    if (!completed) throw new Error("completed merge effect was not durable");
    const payload = structuredClone(completed.payload) as { receipt: Record<string, unknown> };
    payload.receipt.effectIdempotencyKey = "job_1:wrong:merge_pr";
    fixture.db.prepare("UPDATE effects SET payload_json = ? WHERE job_id = ? AND idempotency_key = ?")
      .run(JSON.stringify(payload), effect.jobId, effect.idempotencyKey);

    await expect(fixture.handler.handleApprovalCallback({
      callbackId: "callback_wrong_effect_binding",
      nonce: fixture.issued.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toEqual({ outcome: "rejected" });
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it("stores the strict merge result and authoritative commit OID on the owning review attempt", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "merged" });
    const completed = fixture.store.getEffect("job_1", effect.idempotencyKey);
    const attempt = fixture.db.prepare("SELECT job_id, kind, result_json FROM attempts WHERE id = ?")
      .get("review_1") as { job_id: string; kind: string; result_json: string | null };

    expect(attempt.job_id).toBe("job_1");
    expect(attempt.kind).toBe("review");
    expect(attempt.result_json).toBe(JSON.stringify(completed?.payload && (completed.payload as { mergeResult: unknown }).mergeResult));
    expect(JSON.parse(attempt.result_json ?? "{}")).toMatchObject({
      mergeCommit: { oid: "c".repeat(40) },
    });
  });

  it.each([
    ["missing", () => undefined],
    ["mismatched", (db: Database.Database) => {
      db.prepare(
        "INSERT INTO jobs (id, source_update_id, request_text, state, created_at, updated_at) VALUES (?, ?, ?, 'merged', ?, ?)",
      ).run("job_other", 2, "other", NOW, NOW);
      db.prepare("UPDATE attempts SET job_id = ? WHERE id = ?").run("job_other", "review_1");
    }],
  ] as const)("fails closed without updating a %s owning attempt", async (_label, mutate) => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);
    if (_label === "missing") fixture.db.prepare("DELETE FROM attempts WHERE id = ?").run("review_1");
    else mutate(fixture.db);

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.store.getJob("job_1")?.state).toBe("merging");
    expect(fixture.store.getEffect("job_1", effect.idempotencyKey)?.payload).toMatchObject({
      mergeCallOutcome: "unknown",
    });
  });

  it("uses parse-independent stale cleanup for callback-bearing malformed payloads", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);
    const raw = `m:${fixture.issued.nonce}`;
    fixture.db.prepare("UPDATE effects SET payload_json = ? WHERE job_id = ? AND idempotency_key = ?")
      .run(JSON.stringify({ nested: { raw, encoded: `m%3A${fixture.issued.nonce}`, doubleEncoded: `%256D%253A${fixture.issued.nonce}`, malformed: `%ZZ%6D%3A${fixture.issued.nonce}` } }), effect.jobId, effect.idempotencyKey);

    expect(fixture.store.staleMergeEffect({
      jobId: effect.jobId,
      effectIdempotencyKey: effect.idempotencyKey,
      reason: "APPROVAL_STALE: test",
      now: NOW + 3,
      leaseOwner: LEASE_OWNER,
      leaseGeneration: LEASE_GENERATION,
    })).toBe(true);
    expect(fixture.db.prepare("SELECT payload_json FROM effects WHERE idempotency_key = ?").get(effect.idempotencyKey)).toEqual({
      payload_json: JSON.stringify({
        mergeOutcome: "stale",
        jobId: "job_1",
        effectIdempotencyKey: effect.idempotencyKey,
      }),
    });
    const textColumns = fixture.db.prepare(
      "SELECT payload_json, last_error FROM effects UNION ALL SELECT last_error, request_text FROM jobs UNION ALL SELECT payload_json, last_error FROM outbox",
    ).all() as Array<Record<string, string | null>>;
    expect(JSON.stringify(textColumns)).not.toContain(fixture.issued.nonce);
  });

  it("preserves an unknown call fence during stale cleanup and reconciles without another SDK call", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);
    fenceUnknown(fixture, effect);

    expect(fixture.store.staleMergeEffect({
      jobId: effect.jobId,
      effectIdempotencyKey: effect.idempotencyKey,
      reason: "APPROVAL_STALE: fenced call requires reconciliation",
      now: NOW + 3,
      leaseOwner: LEASE_OWNER,
      leaseGeneration: LEASE_GENERATION,
    })).toBe(true);
    expect(fixture.store.getJob("job_1")).toMatchObject({ state: "merging", cancelRequestedAt: null });
    expect(fixture.store.getEffect("job_1", effect.idempotencyKey)).toMatchObject({
      status: "pending",
      payload: {
        headSha: HEAD,
        mergeCallStartedAt: NOW + 2,
        mergeCallOutcome: "unknown",
      },
    });
    expect(fixture.store.listHeldResourceClaims("job_1", 10).filter((claim) => claim.resourceKind !== "project")).toHaveLength(2);

    await expect(executeLeased(fixture, leaseMergeEffect(fixture))).resolves.toMatchObject({ outcome: "merged" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
  });

  it("preserves an unknown call fence during failure cleanup and reconciles without another SDK call", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);
    fenceUnknown(fixture, effect);

    expect(fixture.store.failLeasedMergeEffect({
      jobId: effect.jobId,
      effectIdempotencyKey: effect.idempotencyKey,
      reason: "provider failure after the irreversible call",
      now: NOW + 3,
      leaseOwner: LEASE_OWNER,
      leaseGeneration: LEASE_GENERATION,
    })).toBe(true);
    expect(fixture.store.getJob("job_1")).toMatchObject({ state: "merging", cancelRequestedAt: null });
    expect(fixture.store.getEffect("job_1", effect.idempotencyKey)).toMatchObject({
      status: "pending",
      payload: { mergeCallOutcome: "unknown" },
    });
    expect(fixture.store.listHeldResourceClaims("job_1", 10).filter((claim) => claim.resourceKind !== "project")).toHaveLength(2);

    await expect(executeLeased(fixture, leaseMergeEffect(fixture))).resolves.toMatchObject({ outcome: "merged" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
  });

  it("releases both merge-time claims after a conclusive pre-provider rejection", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);
    fixture.db.prepare(
      `UPDATE job_resource_claims SET state = 'released', lease_expires_at = 0,
       released_at = ?, release_reason = ?
       WHERE job_id = ? AND resource_kind = 'repository_merge'`,
    ).run(NOW + 1, "test_missing_claim", effect.jobId);

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
    expect(fixture.store.listHeldResourceClaims(effect.jobId, 10)
      .filter((claim) => claim.state === "held" && claim.resourceKind !== "project")).toHaveLength(0);
  });

  it("cancels instead of resolving a PR when cancellation races stale cleanup", async () => {
    const staleGate = gateInput({
      environment: {
        ...gateInput().environment,
        checkout: { kind: "branch", branchName: "feature/telegram", headSha: MOVED },
      },
      remoteHead: {
        first: { rows: [`${MOVED}\trefs/pull/17/head`] },
        second: { rows: [`${MOVED}\trefs/pull/17/head`] },
      },
    });
    const fixture = mergeFixture({
      gateInputs: [gateInput(), staleGate],
      beforePreMerge: (db) => {
        db.prepare("UPDATE jobs SET cancel_requested_at = ? WHERE id = 'job_1'").run(NOW + 2);
      },
    });
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });

    await expect(executeLeased(fixture, leaseMergeEffect(fixture))).resolves.toMatchObject({ outcome: "stale" });
    expect(fixture.store.getJob("job_1")).toMatchObject({ state: "cancelled" });
    expect(fixture.store.listEffectsForJob("job_1").filter((item) => item.kind === "resolve_pr_head")).toHaveLength(0);
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
  });

  it("fails closed without persisting a corrupt PR URL during stale recovery", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = mergeEffect(fixture.store);
    fixture.db.prepare(
      "UPDATE effects SET status = 'leased', lease_owner = ?, lease_generation = ?, lease_expires_at = ? WHERE idempotency_key = ?",
    ).run(LEASE_OWNER, LEASE_GENERATION, NOW + 60_000, effect.idempotencyKey);
    const corruptUrl = "https://github.com/acme/cyndra/pull/17?next=%2526token%253Dsecret";
    fixture.db.prepare("UPDATE jobs SET pr_url = ? WHERE id = 'job_1'").run(corruptUrl);
    const leased = fixture.store.getEffect("job_1", effect.idempotencyKey);
    if (!leased) throw new Error("merge effect was not leased");

    expect(fixture.store.staleMergeEffect({
      jobId: leased.jobId,
      effectIdempotencyKey: leased.idempotencyKey,
      reason: "APPROVAL_STALE: corrupt PR URL",
      now: NOW + 3,
      leaseOwner: LEASE_OWNER,
      leaseGeneration: LEASE_GENERATION,
    })).toBe(true);
    expect(fixture.store.getJob("job_1")).toMatchObject({ state: "failed", prUrl: null });
    expect(fixture.store.listEffectsForJob("job_1").filter((item) => item.kind === "resolve_pr_head")).toHaveLength(0);
    const persisted = JSON.stringify({
      jobs: fixture.db.prepare("SELECT pr_url, last_error FROM jobs").all(),
      effects: fixture.db.prepare("SELECT payload_json, last_error FROM effects").all(),
    });
    expect(persisted).not.toContain(corruptUrl);
  });

  it.each([
    ["missing review attempt", (fixture: ReturnType<typeof mergeFixture>) => {
      fixture.db.prepare("DELETE FROM attempts WHERE id = 'review_1'").run();
    }],
    ["wrong review job", (fixture: ReturnType<typeof mergeFixture>) => {
      fixture.db.prepare(
        "INSERT INTO jobs (id, source_update_id, request_text, state, created_at, updated_at) VALUES (?, ?, ?, 'merged', ?, ?)",
      ).run("job_other", 2, "other", NOW, NOW);
      fixture.db.prepare("UPDATE attempts SET job_id = ? WHERE id = 'review_1'").run("job_other");
    }],
    ["wrong review kind", (fixture: ReturnType<typeof mergeFixture>) => {
      fixture.db.prepare("UPDATE attempts SET kind = 'validation' WHERE id = 'review_1'").run();
    }],
    ["wrong review head", (fixture: ReturnType<typeof mergeFixture>) => {
      fixture.db.prepare("UPDATE attempts SET head_sha = ? WHERE id = 'review_1'").run(MOVED);
    }],
    ["incomplete review attempt", (fixture: ReturnType<typeof mergeFixture>) => {
      fixture.db.prepare("UPDATE attempts SET completed_at = NULL WHERE id = 'review_1'").run();
    }],
    ["malformed review result", (fixture: ReturnType<typeof mergeFixture>) => {
      fixture.db.prepare("UPDATE attempts SET result_json = ? WHERE id = 'review_1'").run("{}");
    }],
    ["ambiguous merge effects", (fixture: ReturnType<typeof mergeFixture>) => {
      const effect = mergeEffect(fixture.store);
      const duplicateKey = `${effect.idempotencyKey}:duplicate`;
      const payload = structuredClone(effect.payload) as { receipt: Record<string, unknown> };
      payload.receipt.effectIdempotencyKey = duplicateKey;
      fixture.db.prepare(
        `INSERT INTO effects (
           idempotency_key, job_id, kind, payload_json, status, attempts,
           next_attempt_at, created_at, updated_at
         ) VALUES (?, ?, 'merge_pr', ?, 'pending', 0, ?, ?, ?)`,
      ).run(duplicateKey, effect.jobId, JSON.stringify(payload), NOW, NOW, NOW);
    }],
  ] as const)("rejects nonterminal accepted replay with %s evidence", async (_label, mutate) => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    mutate(fixture);

    await expect(fixture.handler.handleApprovalCallback({
      callbackId: `callback_nonterminal_${_label.replaceAll(" ", "_")}`,
      nonce: fixture.issued.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toEqual({ outcome: "rejected" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["cancel-requested job", (fixture: ReturnType<typeof mergeFixture>) => {
      fixture.db.prepare("UPDATE jobs SET cancel_requested_at = ? WHERE id = 'job_1'").run(NOW + 4);
    }],
    ["incomplete owning attempt", (fixture: ReturnType<typeof mergeFixture>) => {
      fixture.db.prepare("UPDATE attempts SET completed_at = NULL WHERE id = 'review_1'").run();
    }],
  ] as const)("rejects completed replay with %s evidence", async (_label, mutate) => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    await expect(executeLeased(fixture, leaseMergeEffect(fixture))).resolves.toMatchObject({ outcome: "merged" });
    mutate(fixture);

    await expect(fixture.handler.handleApprovalCallback({
      callbackId: `callback_completed_${_label.replaceAll(" ", "_")}`,
      nonce: fixture.issued.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toEqual({ outcome: "rejected" });
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it("reconstructs a unique legacy accepted callback identity without storing nonce material", async () => {
    const fixture = mergeFixture();
    const first = await acceptApproval(fixture);
    expect(first).toEqual({ outcome: "accepted" });
    fixture.db.prepare(
      "UPDATE callbacks SET approval_nonce_hash = NULL, head_sha = NULL, effect_idempotency_key = NULL WHERE callback_query_id = 'callback_1'",
    ).run();

    await expect(fixture.handler.handleApprovalCallback({
      callbackId: "callback_1",
      nonce: fixture.issued.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toEqual(first);
    expect(fixture.db.prepare(
      "SELECT approval_nonce_hash, head_sha, effect_idempotency_key FROM callbacks WHERE callback_query_id = 'callback_1'",
    ).get()).toEqual({ approval_nonce_hash: null, head_sha: null, effect_idempotency_key: null });
    expect(JSON.stringify(fixture.db.prepare("SELECT * FROM callbacks").all())).not.toContain(fixture.issued.nonce);
  });

  it.each([
    ["ambiguous merge effects", (fixture: ReturnType<typeof mergeFixture>) => {
      const effect = mergeEffect(fixture.store);
      const duplicateKey = `${effect.idempotencyKey}:legacy-duplicate`;
      const payload = structuredClone(effect.payload) as { receipt: Record<string, unknown> };
      payload.receipt.effectIdempotencyKey = duplicateKey;
      fixture.db.prepare(
        `INSERT INTO effects (
           idempotency_key, job_id, kind, payload_json, status, attempts,
           next_attempt_at, created_at, updated_at
         ) VALUES (?, ?, 'merge_pr', ?, 'pending', 0, ?, ?, ?)`,
      ).run(duplicateKey, effect.jobId, JSON.stringify(payload), NOW, NOW, NOW);
    }],
    ["mismatched callback job", (fixture: ReturnType<typeof mergeFixture>) => {
      fixture.db.prepare("UPDATE callbacks SET job_id = NULL WHERE callback_query_id = 'callback_1'").run();
    }],
  ] as const)("rejects a legacy accepted callback when evidence is %s", async (_label, mutate) => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    fixture.db.prepare(
      "UPDATE callbacks SET approval_nonce_hash = NULL, head_sha = NULL, effect_idempotency_key = NULL WHERE callback_query_id = 'callback_1'",
    ).run();
    mutate(fixture);

    await expect(fixture.handler.handleApprovalCallback({
      callbackId: "callback_1",
      nonce: fixture.issued.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toEqual({ outcome: "rejected" });
  });

  it("reconstructs a unique legacy accepted callback after terminal merge completion", async () => {
    const fixture = mergeFixture();
    const first = await acceptApproval(fixture);
    await expect(executeLeased(fixture, leaseMergeEffect(fixture))).resolves.toMatchObject({ outcome: "merged" });
    fixture.db.prepare(
      "UPDATE callbacks SET approval_nonce_hash = NULL, head_sha = NULL, effect_idempotency_key = NULL WHERE callback_query_id = 'callback_1'",
    ).run();

    await expect(fixture.handler.handleApprovalCallback({
      callbackId: "callback_1",
      nonce: fixture.issued.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toEqual(first);
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty result", () => ({})],
    ["wrong head binding", (result: Record<string, unknown>) => ({ ...result, authoritativeHeadSha: MOVED })],
    ["malformed URL", (result: Record<string, unknown>) => ({
      ...result,
      pullRequest: { ...(result.pullRequest as Record<string, unknown>), url: "http://example.test/pull/17" },
    })],
    ["unexpected key", (result: Record<string, unknown>) => ({ ...result, unexpected: true })],
  ] as const)("rejects a completed callback when its persisted result has %s", async (_label, mutate) => {
    const fixture = mergeFixture();
    const first = await acceptApproval(fixture);
    const effect = leaseMergeEffect(fixture);

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "merged" });
    const completed = fixture.store.getEffect("job_1", effect.idempotencyKey);
    if (!completed) throw new Error("completed merge effect was not durable");
    const payload = structuredClone(completed.payload) as { mergeResult: Record<string, unknown> };
    payload.mergeResult = mutate(payload.mergeResult);
    fixture.db.prepare("UPDATE effects SET payload_json = ? WHERE job_id = ? AND idempotency_key = ?")
      .run(JSON.stringify(payload), effect.jobId, effect.idempotencyKey);

    await expect(fixture.handler.handleApprovalCallback({
      callbackId: `callback_corrupt_${_label.replaceAll(" ", "_")}`,
      nonce: fixture.issued.nonce,
      userId: "7",
      chatId: "70",
    })).resolves.toEqual({ outcome: "rejected" });
    expect(first).toEqual({ outcome: "accepted" });
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it("rejects a caller-supplied fallback effect without calling the merge SDK", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const durable = mergeEffect(fixture.store);
    const fallback = { ...durable, idempotencyKey: "job_1:999:merge_pr", status: "leased" as const };

    await expect(executeLeased(fixture, fallback)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
  });

  it("requires a non-expired durable effect lease before calling the merge SDK", async () => {
    const fixture = mergeFixture({ clock: () => NOW + 2 });
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = mergeEffect(fixture.store);

    await expect(fixture.handler.executeMergeEffect({
      effect,
    })).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();

    const expired = leaseMergeEffect(fixture, NOW + 1);
    await expect(executeLeased(fixture, expired)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
  });

  it("revalidates the durable lease after asynchronous fresh validation", async () => {
    const fixture = mergeFixture({
      beforePreMerge: (db) => {
        db.prepare("UPDATE effects SET lease_owner = 'another-executor' WHERE kind = 'merge_pr'").run();
      },
    });
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
  });

  it("does not call the SDK or completion after async validation crosses the lease expiry", async () => {
    let currentNow = NOW + 2;
    const fixture = mergeFixture({
      clock: () => currentNow,
      beforePreMerge: () => {
        currentNow = NOW + 60_001;
      },
    });
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture, NOW + 60_000);

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
    expect(fixture.commandRunner.run).not.toHaveBeenCalled();
  });

  it("fails closed and releases the effect when cancellation is requested before the SDK fence", async () => {
    const fixture = mergeFixture({
      beforePreMerge: (db) => {
        db.prepare("UPDATE jobs SET cancel_requested_at = ? WHERE id = 'job_1'").run(NOW + 2);
      },
    });
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
    expect(fixture.store.getJob("job_1")?.state).toBe("cancelled");
    expect(fixture.store.getEffect("job_1", effect.idempotencyKey)).toMatchObject({
      status: "failed",
      leaseOwner: null,
      leaseGeneration: null,
      leaseExpiresAt: null,
    });
  });

  it("reconciles a durable unknown-outcome fence without a second SDK call", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);
    const payload = { ...effect.payload, mergeCallStartedAt: NOW + 2, mergeCallOutcome: "unknown" };
    fixture.db.prepare("UPDATE effects SET payload_json = ? WHERE job_id = ? AND idempotency_key = ?")
      .run(JSON.stringify(payload), effect.jobId, effect.idempotencyKey);

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "merged" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
    expect(fixture.store.getJob("job_1")?.state).toBe("deploying");
  });

  it("rejects malformed durable receipts before command interpolation or SDK execution", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);
    const payload = structuredClone(effect.payload) as { receipt: Record<string, unknown> };
    payload.receipt.prNumber = "17; touch /tmp/should-not-run";
    fixture.db.prepare("UPDATE effects SET payload_json = ? WHERE job_id = ? AND idempotency_key = ?")
      .run(JSON.stringify(payload), effect.jobId, effect.idempotencyKey);

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
    expect(fixture.commandRunner.run).not.toHaveBeenCalled();
  });

  it("accepts approval and fails the leased effect when executor validation throws", async () => {
    const fixture = mergeFixture({ collectError: new Error("malformed validation") });

    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);
    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.store.getCallback("callback_1")?.outcome).toBe("accepted");
    expect(fixture.store.getJob("job_1")?.state).toBe("failed");
  });

  it("releases and fails the leased merge effect when fresh validation throws", async () => {
    const fixture = mergeFixture({ preMergeError: new Error("validation parser failed") });
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
    expect(fixture.store.getJob("job_1")?.state).toBe("failed");
    expect(fixture.store.getEffect("job_1", effect.idempotencyKey)).toMatchObject({
      status: "failed",
      leaseOwner: null,
      leaseGeneration: null,
      leaseExpiresAt: null,
    });
  });

  it("fails and releases a current-owner leased effect with an unparseable payload by key", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);
    fixture.db.prepare(
      "UPDATE effects SET payload_json = ? WHERE job_id = ? AND idempotency_key = ? AND lease_owner = ? AND lease_generation = ?",
    ).run("{malformed", effect.jobId, effect.idempotencyKey, LEASE_OWNER, LEASE_GENERATION);

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
    expect(fixture.commandRunner.run).not.toHaveBeenCalled();
    expect(fixture.db.prepare(
      "SELECT status, lease_owner, lease_generation, lease_expires_at FROM effects WHERE job_id = ? AND idempotency_key = ?",
    ).get(effect.jobId, effect.idempotencyKey)).toEqual({
      status: "failed",
      lease_owner: null,
      lease_generation: null,
      lease_expires_at: null,
    });
  });

  it("preserves an unknown-outcome effect when prepare rejects the current durable binding", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);
    const fencedPayload = { ...effect.payload, mergeCallStartedAt: NOW + 2, mergeCallOutcome: "unknown" };
    fixture.db.prepare("UPDATE effects SET payload_json = ? WHERE job_id = ? AND idempotency_key = ?")
      .run(JSON.stringify(fencedPayload), effect.jobId, effect.idempotencyKey);
    fixture.db.prepare("UPDATE jobs SET cancel_requested_at = ? WHERE id = ?")
      .run(NOW + 2, effect.jobId);

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
    expect(fixture.commandRunner.run).not.toHaveBeenCalled();
    expect(fixture.db.prepare(
      "SELECT status, lease_owner, lease_generation, lease_expires_at FROM effects WHERE job_id = ? AND idempotency_key = ?",
    ).get(effect.jobId, effect.idempotencyKey)).toEqual({
      status: "pending",
      lease_owner: null,
      lease_generation: null,
      lease_expires_at: null,
    });
    expect(fixture.store.getJob(effect.jobId)?.state).toBe("merging");
  });

  it("cleans a leased effect without parsing callback-bearing payload or job JSON", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);
    const rawCallback = `xm:m:${fixture.issued.nonce}suffix`;
    fixture.db.prepare("UPDATE effects SET payload_json = ? WHERE job_id = ? AND idempotency_key = ?")
      .run(JSON.stringify({ nested: { callback: rawCallback } }), effect.jobId, effect.idempotencyKey);
    fixture.db.prepare("UPDATE jobs SET policy_json = ? WHERE id = ?")
      .run("{malformed", effect.jobId);

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
    expect(fixture.db.prepare(
      "SELECT status, lease_owner, lease_generation, lease_expires_at, last_error, payload_json FROM effects WHERE job_id = ? AND idempotency_key = ?",
    ).get(effect.jobId, effect.idempotencyKey)).toEqual(expect.objectContaining({
      status: "failed",
      lease_owner: null,
      lease_generation: null,
      lease_expires_at: null,
    }));
    expect(fixture.db.prepare("SELECT outcome FROM approvals WHERE job_id = ?").get(effect.jobId)).toEqual({ outcome: "revoked" });
    const persisted = JSON.stringify({
      effect: fixture.db.prepare("SELECT payload_json, last_error FROM effects").all(),
      approval: fixture.db.prepare("SELECT outcome FROM approvals").all(),
      job: fixture.db.prepare("SELECT last_error FROM jobs").all(),
    });
    expect(persisted).not.toContain(rawCallback);
    expect(persisted).not.toContain(fixture.issued.nonce);
  });

  it("uses the handler clock again after the awaited provider call before completion", async () => {
    let currentNow = NOW + 2;
    const fixture = mergeFixture({
      clock: () => currentNow,
    });
    fixture.mergePullRequest.mockImplementationOnce(async () => {
      currentNow = NOW + 40_000;
      return { ok: true };
    });
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture, NOW + 10_000);

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(fixture.store.getJob("job_1")).toMatchObject({ state: "merging" });
    expect(fixture.commandRunner.run).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid timestamp", { mergedAt: "not-a-timestamp" }],
    ["malformed merge commit", { mergeCommit: { oid: "short" } }],
    ["non-object merge commit", { mergeCommit: null }],
    ["encoded credential query key", { url: "https://github.com/acme/cyndra/pull/17?%74oken=secret" }],
    ["double-encoded credential query key", { url: "https://github.com/acme/cyndra/pull/17?%2574oken=secret" }],
    ["encoded credential query value", { url: "https://github.com/acme/cyndra/pull/17?next=%73ecret" }],
    ["double-encoded credential query value", { url: "https://github.com/acme/cyndra/pull/17?next=%2573ecret" }],
  ] as const)("requires strict post-merge confirmation for %s", async (_label, postMergeResult) => {
    const fixture = mergeFixture({ postMergeResult });
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.store.getJob("job_1")?.state).toBe("merging");
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
    const failedEffect = fixture.store.getEffect("job_1", effect.idempotencyKey);
    if (!failedEffect) throw new Error("failed merge effect was not durable");
    expect(failedEffect).toMatchObject({ status: "pending", leaseOwner: null, leaseGeneration: null, leaseExpiresAt: null });
    await expect(fixture.handler.executeMergeEffect({
      effect: failedEffect,
      leaseOwner: LEASE_OWNER,
      leaseGeneration: LEASE_GENERATION + 1,
    })).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    "lease",
    "bind",
    "prepare",
    "complete",
    "preserve",
    "fail",
    "stale",
  ] as const)("rejects stale executor ownership before merge %s mutation", async (method) => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });

    let effect = mergeEffect(fixture.store);
    let completedResult: Record<string, unknown> | null = null;
    if (method === "lease") {
      effect = leaseMergeEffect(fixture);
    } else if (method === "complete") {
      await expect(executeLeased(fixture, leaseMergeEffect(fixture))).resolves.toMatchObject({ outcome: "merged" });
      const completed = fixture.store.getEffect("job_1", effect.idempotencyKey);
      if (!completed) throw new Error("merge effect was not completed for stale completion test");
      completedResult = (completed.payload as { mergeResult: Record<string, unknown> }).mergeResult;
      effect = completed;
    } else {
      effect = leaseMergeEffect(fixture);
      if (method === "bind" || method === "prepare") {
        const durable = mergeEffect(fixture.store);
        const receipt = (durable.payload as { receipt: DurableMergeReceipt }).receipt;
        expect(fixture.store.bindMergeEffectReceipt({
          jobId: effect.jobId,
          effectIdempotencyKey: effect.idempotencyKey,
          receipt,
          leaseOwner: LEASE_OWNER,
          leaseGeneration: LEASE_GENERATION,
          now: NOW + 1,
        })).toBe(true);
        effect = fixture.store.getEffect(effect.jobId, effect.idempotencyKey) ?? effect;
      }
      if (method === "preserve") fenceUnknown(fixture, effect);
    }

    const takeoverNow = NOW + 60_001;
    if (method !== "lease" && method !== "complete") {
      fixture.db.prepare(
        "UPDATE effects SET lease_expires_at = ? WHERE job_id = ? AND idempotency_key = ?",
      ).run(NOW + 120_000, effect.jobId, effect.idempotencyKey);
    }
    const before = mergeDurableSnapshot(fixture.db);
    const providerCalls = fixture.mergePullRequest.mock.calls.length;
    const successor = fixture.store.acquireExecutorLease("executor-successor", takeoverNow, 60_000);
    expect(successor).toEqual({ acquired: true, generation: 2 });
    if (!successor.acquired) throw new Error("successor merge executor was not acquired");

    let result: boolean | { ok: boolean };
    switch (method) {
      case "lease":
        result = fixture.store.leaseNextJobEffect({
          jobId: effect.jobId,
          ownerId: LEASE_OWNER,
          generation: LEASE_GENERATION,
          now: takeoverNow,
          leaseMs: 60_000,
        }) !== null;
        break;
      case "bind": {
        const durable = mergeEffect(fixture.store);
        result = fixture.store.bindMergeEffectReceipt({
          jobId: effect.jobId,
          effectIdempotencyKey: effect.idempotencyKey,
          receipt: (durable.payload as { receipt: DurableMergeReceipt }).receipt,
          leaseOwner: LEASE_OWNER,
          leaseGeneration: LEASE_GENERATION,
          now: takeoverNow,
        });
        break;
      }
      case "prepare":
        result = fixture.store.prepareMergeCall({
          jobId: effect.jobId,
          effectIdempotencyKey: effect.idempotencyKey,
          leaseOwner: LEASE_OWNER,
          leaseGeneration: LEASE_GENERATION,
          now: takeoverNow,
        });
        break;
      case "complete":
        if (!completedResult) throw new Error("completed merge result was not prepared");
        result = fixture.store.completeMergeSuccess({
          jobId: effect.jobId,
          effectIdempotencyKey: effect.idempotencyKey,
          message: "stale completion",
          result: completedResult,
          outbox: {
            logicalKey: "stale:merge:outbox",
            chatId: "70",
            payload: { text: "must not persist" },
          },
          now: takeoverNow,
          leaseOwner: LEASE_OWNER,
          leaseGeneration: LEASE_GENERATION,
        });
        break;
      case "preserve":
        result = fixture.store.preserveUnknownMergeEffect({
          jobId: effect.jobId,
          effectIdempotencyKey: effect.idempotencyKey,
          leaseOwner: LEASE_OWNER,
          leaseGeneration: LEASE_GENERATION,
          now: takeoverNow,
        });
        break;
      case "fail":
        result = fixture.store.failLeasedMergeEffect({
          jobId: effect.jobId,
          effectIdempotencyKey: effect.idempotencyKey,
          reason: "stale failure",
          leaseOwner: LEASE_OWNER,
          leaseGeneration: LEASE_GENERATION,
          now: takeoverNow,
        });
        break;
      case "stale":
        result = fixture.store.staleMergeEffect({
          jobId: effect.jobId,
          effectIdempotencyKey: effect.idempotencyKey,
          reason: "APPROVAL_STALE: stale executor",
          leaseOwner: LEASE_OWNER,
          leaseGeneration: LEASE_GENERATION,
          now: takeoverNow,
        });
        break;
    }

    if (method === "prepare") expect(result).toMatchObject({ ok: false });
    else expect(result).toBe(false);
    expect(mergeDurableSnapshot(fixture.db)).toEqual(before);
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(providerCalls);
  });
});
