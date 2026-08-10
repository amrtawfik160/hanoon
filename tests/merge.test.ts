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
  clock?: () => number;
} = {}) {
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
  const db = bb.storage.database();
  const clock = options.clock ?? (() => NOW);
  const store = openStore(bb.storage, bb.storage.kv, clock);
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
    `INSERT INTO attempts (id, job_id, kind, ordinal, head_sha, created_at)
       VALUES (?, ?, 'review', ?, ?, ?)`,
  ).run("review_1", "job_1", 1, HEAD, NOW);

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
  return { db, store, approvals, issued, handler, collectGateInput, mergePullRequest, commandRunner };
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
) {
  return fixture.handler.executeMergeEffect({
    effect,
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
    })).resolves.toMatchObject({ outcome: "accepted" });
    const effect = leaseMergeEffect(fixture);
    await expect(handler.executeMergeEffect({
      effect,
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

  it("rejects approval when the handler clock crosses the fifteen-minute expiry during validation", async () => {
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
    })).resolves.toEqual({ outcome: "rejected" });
    expect(fixture.store.listEffectsForJob("job_1").filter((item) => item.kind === "merge_pr")).toHaveLength(0);
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

    await expect(executeLeased(fixture, leaseMergeEffect(fixture))).resolves.toMatchObject({ outcome: "stale" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
    expect(fixture.store.getEffect("job_1", mergeEffect(fixture.store).idempotencyKey)?.payload).toEqual({
      mergeOutcome: "stale",
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

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "merged" });
    expect(fixture.store.getJob("job_1")?.state).toBe("merged");
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
    expect(fixture.commandRunner.run).toHaveBeenCalledTimes(2);
  });

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
      payload_json: JSON.stringify({ mergeOutcome: "stale" }),
    });
    const textColumns = fixture.db.prepare(
      "SELECT payload_json, last_error FROM effects UNION ALL SELECT last_error, request_text FROM jobs UNION ALL SELECT payload_json, last_error FROM outbox",
    ).all() as Array<Record<string, string | null>>;
    expect(JSON.stringify(textColumns)).not.toContain(fixture.issued.nonce);
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

    await expect(executeLeased(fixture, effect)).resolves.toMatchObject({ outcome: "failed" });
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
      currentNow = NOW + 20_000;
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
});
