import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { GateInput } from "../src/domain/gates";
import type { StoredEffect } from "../src/domain/models";
import { hashSecret } from "../src/crypto";
import { createTask9FreshGateCollector, MergeHandler } from "../src/services/merge-handler";
import type { ValidationSnapshot } from "../src/bb/validation";
import { ApprovalService } from "../src/services/approval-service";
import { openStore } from "../src/storage/store";
import { policyFixture, sha } from "./helpers";

const HEAD = sha();
const MOVED = sha("b");
const NOW = 1_000;

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
} = {}) {
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
  const db = bb.storage.database();
  const store = openStore(bb.storage);
  const policy = policyFixture({ requiredChecks: ["test"] });
  store.createPairingCode(hashSecret("pair"), NOW, NOW + 60_000);
  expect(store.pairOwnerWithPrivateChatCode(hashSecret("pair"), "7", "70", NOW)).toEqual({ ok: true });
  store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "merge this", now: NOW });
  db.prepare(
    `UPDATE jobs SET state = 'awaiting_merge_approval', project_id = ?,
       policy_version = 1, policy_json = ?, environment_id = ?, pr_number = ?,
       pr_url = ?, pr_head_sha = ?, version = 7, updated_at = ? WHERE id = ?`,
  ).run(policy.projectId, JSON.stringify(policy), "env_1", 17, "https://github.com/acme/cyndra/pull/17", HEAD, NOW, "job_1");

  const approvals = new ApprovalService(store, { now: () => NOW, randomBytes: () => Buffer.alloc(24, 2) });
  const issued = approvals.issue("job_1", HEAD);
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
      throw new Error(`unexpected confirmation command ${command}`);
    }),
  };
  const handler = new MergeHandler({
    store,
    approvals,
    collectGateInput,
    commandRunner,
    bb: { sdk: { environments: { mergePullRequest } } },
    now: () => NOW,
  });
  return { db, store, approvals, issued, handler, collectGateInput, mergePullRequest, commandRunner };
}

async function acceptApproval(fixture: ReturnType<typeof mergeFixture>) {
  return fixture.handler.handleApprovalCallback({
    callbackId: "callback_1",
    nonce: fixture.issued.nonce,
    userId: "7",
    chatId: "70",
    now: NOW + 1,
  });
}

function mergeEffect(store: ReturnType<typeof openStore>): StoredEffect {
  const effect = store.listEffectsForJob("job_1").find((item) => item.kind === "merge_pr");
  if (!effect) throw new Error("merge effect was not enqueued");
  return effect;
}

const LEASE_OWNER = "executor-1";
const LEASE_GENERATION = 1;

function leaseMergeEffect(fixture: ReturnType<typeof mergeFixture>, expiresAt = NOW + 60_000): StoredEffect {
  const effect = mergeEffect(fixture.store);
  fixture.db.prepare(
    `UPDATE effects
        SET status = 'leased', lease_owner = ?, lease_generation = ?, lease_expires_at = ?, updated_at = ?
      WHERE job_id = ? AND idempotency_key = ?`,
  ).run(LEASE_OWNER, LEASE_GENERATION, expiresAt, NOW, effect.jobId, effect.idempotencyKey);
  const leased = fixture.store.getEffect(effect.jobId, effect.idempotencyKey);
  if (!leased) throw new Error("merge effect was not leased");
  return leased;
}

function executeLeased(
  fixture: ReturnType<typeof mergeFixture>,
  effect: StoredEffect,
  now: number,
) {
  return fixture.handler.executeMergeEffect({
    effect,
    now,
    leaseOwner: LEASE_OWNER,
    leaseGeneration: LEASE_GENERATION,
  });
}

describe("fresh Telegram merge execution", () => {
  it("uses the concrete Task 8 validation receipt for callback and merge-handler head truth", async () => {
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
    const collector = createTask9FreshGateCollector({
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
      now: NOW + 1,
    })).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);
    await expect(handler.executeMergeEffect({
      effect,
      now: NOW + 2,
      leaseOwner: LEASE_OWNER,
      leaseGeneration: LEASE_GENERATION,
    })).resolves.toMatchObject({ outcome: "merged" });
    expect(runValidation).toHaveBeenCalledTimes(2);
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(fixture.store.getJob("job_1")?.state).toBe("merged");
  });

  it("requires a fresh ready-gate evaluation before accepting approval", async () => {
    const fixture = mergeFixture();

    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    expect(fixture.collectGateInput).toHaveBeenCalledTimes(1);
    expect(fixture.store.getJob("job_1")?.state).toBe("merging");
  });

  it.each([
    ["stale local head", gateInput({ environment: { ...gateInput().environment, checkout: { kind: "branch", branchName: "feature/telegram", headSha: MOVED } } })],
    ["stale gh head metadata", gateInput({ githubPr: { number: 17, headRefOid: HEAD }, remoteHead: { first: { rows: [`${MOVED}\trefs/pull/17/head`] }, second: { rows: [`${MOVED}\trefs/pull/17/head`] } }, environment: { ...gateInput().environment, checkout: { kind: "branch", branchName: "feature/telegram", headSha: MOVED } } })],
    ["malformed git head", gateInput({ remoteHead: { first: { rows: ["not-a-git-head"] }, second: { rows: ["not-a-git-head"] } } })],
    ["pending required check", gateInput({ validation: { ...gateInput().validation, requiredChecks: [{ name: "test", bucket: "pending", state: "PENDING", link: null }] } })],
    ["merge conflict", gateInput({ pullRequest: { ...gateInput().pullRequest, mergeable: "CONFLICTING" } })],
  ] as const)("fails closed for %s", async (_label, input) => {
    const fixture = mergeFixture({ gateInputs: [input] });

    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "rejected" });
    expect(fixture.store.getJob("job_1")?.state).toBe("resolving_pr_head");
    expect(fixture.store.listEffectsForJob("job_1").filter((item) => item.kind === "merge_pr")).toHaveLength(0);
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
  });

  it("makes callback replay idempotent without a second fresh evaluation", async () => {
    const fixture = mergeFixture();
    const first = await acceptApproval(fixture);
    const second = await acceptApproval(fixture);

    expect(first).toEqual(second);
    expect(fixture.collectGateInput).toHaveBeenCalledTimes(1);
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM callbacks").get()).toEqual({ count: 1 });
  });

  it("rejects remote head movement after approval acceptance before the merge effect", async () => {
    const fixture = mergeFixture({ gateInputs: [gateInput(), gateInput({
      environment: { ...gateInput().environment, checkout: { kind: "branch", branchName: "feature/telegram", headSha: MOVED } },
      remoteHead: { first: { rows: [`${MOVED}\trefs/pull/17/head`] }, second: { rows: [`${MOVED}\trefs/pull/17/head`] } },
      githubPr: { number: 17, headRefOid: HEAD },
    })] });
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });

    await expect(executeLeased(fixture, leaseMergeEffect(fixture), NOW + 2)).resolves.toMatchObject({ outcome: "stale" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
  });

  it("calls the BB merge SDK at most once and fails closed on SDK rejection", async () => {
    const fixture = mergeFixture({ mergeError: new Error("provider rejected merge") });
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);

    await expect(executeLeased(fixture, effect, NOW + 2)).resolves.toMatchObject({ outcome: "failed" });
    await expect(fixture.handler.executeMergeEffect({
      effect: { ...effect, status: "done" },
      now: NOW + 3,
      leaseOwner: LEASE_OWNER,
      leaseGeneration: LEASE_GENERATION,
    })).resolves.toMatchObject({ outcome: "already_done" });
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(fixture.mergePullRequest).toHaveBeenCalledWith({ environmentId: "env_1", method: "squash" });
  });

  it("confirms Git-native head and strict gh merged state before persisting success", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const result = await executeLeased(fixture, leaseMergeEffect(fixture), NOW + 2);

    expect(result).toMatchObject({ outcome: "merged" });
    expect(fixture.store.getJob("job_1")?.state).toBe("merged");
    expect(fixture.commandRunner.run.mock.calls.map(([call]) => call.command)).toEqual([
      "git ls-remote --exit-code origin refs/pull/17/head",
      "gh pr view 17 --json state,mergedAt,mergeCommit,url,number",
    ]);
    expect(fixture.db.prepare("SELECT COUNT(*) AS count FROM outbox").get()).toEqual({ count: 1 });
    const payload = fixture.db.prepare("SELECT payload_json FROM effects WHERE kind = 'merge_pr'").get() as { payload_json: string };
    expect(payload.payload_json).toContain(HEAD);
    expect(payload.payload_json).toContain("MERGED");
  });

  it("persists merge success and leaves Telegram delivery to the outbox worker", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);

    await expect(executeLeased(fixture, effect, NOW + 2)).resolves.toMatchObject({ outcome: "merged" });
    expect(fixture.store.getJob("job_1")?.state).toBe("merged");
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);

    await expect(fixture.handler.executeMergeEffect({
      effect: { ...effect, status: "done" },
      now: NOW + 3,
      leaseOwner: LEASE_OWNER,
      leaseGeneration: LEASE_GENERATION,
    })).resolves.toMatchObject({ outcome: "already_done" });
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
  });

  it("rejects a caller-supplied fallback effect without calling the merge SDK", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const durable = mergeEffect(fixture.store);
    const fallback = { ...durable, idempotencyKey: "job_1:999:merge_pr", status: "leased" as const };

    await expect(executeLeased(fixture, fallback, NOW + 2)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
  });

  it("requires a non-expired durable effect lease before calling the merge SDK", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = mergeEffect(fixture.store);

    await expect(fixture.handler.executeMergeEffect({
      effect,
      now: NOW + 2,
    })).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();

    const expired = leaseMergeEffect(fixture, NOW + 1);
    await expect(executeLeased(fixture, expired, NOW + 2)).resolves.toMatchObject({ outcome: "failed" });
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

    await expect(executeLeased(fixture, effect, NOW + 2)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
  });

  it("fails closed and releases the effect when cancellation is requested before the SDK fence", async () => {
    const fixture = mergeFixture({
      beforePreMerge: (db) => {
        db.prepare("UPDATE jobs SET cancel_requested_at = ? WHERE id = 'job_1'").run(NOW + 2);
      },
    });
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);

    await expect(executeLeased(fixture, effect, NOW + 2)).resolves.toMatchObject({ outcome: "failed" });
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

    await expect(executeLeased(fixture, effect, NOW + 3)).resolves.toMatchObject({ outcome: "merged" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
    expect(fixture.store.getJob("job_1")?.state).toBe("merged");
  });

  it("rejects malformed durable receipts before command interpolation or SDK execution", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);
    const payload = structuredClone(effect.payload) as { receipt: Record<string, unknown> };
    payload.receipt.prNumber = "17; touch /tmp/should-not-run";
    fixture.db.prepare("UPDATE effects SET payload_json = ? WHERE job_id = ? AND idempotency_key = ?")
      .run(JSON.stringify(payload), effect.jobId, effect.idempotencyKey);

    await expect(executeLeased(fixture, effect, NOW + 2)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
    expect(fixture.commandRunner.run).not.toHaveBeenCalled();
  });

  it("revokes approval and records a rejected callback when fresh validation throws", async () => {
    const fixture = mergeFixture({ collectError: new Error("malformed validation") });

    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "rejected" });
    expect(fixture.store.getCallback("callback_1")?.outcome).toBe("rejected");
    expect(fixture.store.getJob("job_1")?.state).toBe("resolving_pr_head");
    expect(fixture.store.listEffectsForJob("job_1").filter((item) => item.kind === "merge_pr")).toHaveLength(0);
  });

  it("releases and fails the leased merge effect when fresh validation throws", async () => {
    const fixture = mergeFixture({ preMergeError: new Error("validation parser failed") });
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);

    await expect(executeLeased(fixture, effect, NOW + 2)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
    expect(fixture.store.getJob("job_1")?.state).toBe("failed");
    expect(fixture.store.getEffect("job_1", effect.idempotencyKey)).toMatchObject({
      status: "failed",
      leaseOwner: null,
      leaseGeneration: null,
      leaseExpiresAt: null,
    });
  });

  it.each([
    ["invalid timestamp", { mergedAt: "not-a-timestamp" }],
    ["malformed merge commit", { mergeCommit: { oid: "short" } }],
    ["non-object merge commit", { mergeCommit: null }],
  ] as const)("requires strict post-merge confirmation for %s", async (_label, postMergeResult) => {
    const fixture = mergeFixture({ postMergeResult });
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);

    await expect(executeLeased(fixture, effect, NOW + 2)).resolves.toMatchObject({ outcome: "failed" });
    expect(fixture.store.getJob("job_1")?.state).toBe("failed");
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
    const failedEffect = fixture.store.getEffect("job_1", effect.idempotencyKey);
    if (!failedEffect) throw new Error("failed merge effect was not durable");
    await expect(fixture.handler.executeMergeEffect({
      effect: failedEffect,
      now: NOW + 3,
      leaseOwner: LEASE_OWNER,
      leaseGeneration: LEASE_GENERATION + 1,
    })).resolves.toMatchObject({ outcome: "already_done" });
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
  });
});
