import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import type { GateInput } from "../src/domain/gates";
import type { StoredEffect } from "../src/domain/models";
import { hashSecret } from "../src/crypto";
import { MergeHandler } from "../src/services/merge-handler";
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
  delivery?: (payload: Record<string, unknown>) => Promise<void>;
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
  const collectGateInput = vi.fn(async () => gateInputs[Math.min(collectGateInput.mock.calls.length - 1, gateInputs.length - 1)]!);
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
    deliverCompletion: options.delivery,
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

describe("fresh Telegram merge execution", () => {
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

    await expect(fixture.handler.executeMergeEffect({ effect: mergeEffect(fixture.store), now: NOW + 2 })).resolves.toMatchObject({ outcome: "stale" });
    expect(fixture.mergePullRequest).not.toHaveBeenCalled();
  });

  it("calls the BB merge SDK at most once and fails closed on SDK rejection", async () => {
    const fixture = mergeFixture({ mergeError: new Error("provider rejected merge") });
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = mergeEffect(fixture.store);

    await expect(fixture.handler.executeMergeEffect({ effect, now: NOW + 2 })).resolves.toMatchObject({ outcome: "failed" });
    await expect(fixture.handler.executeMergeEffect({ effect: { ...effect, status: "done" }, now: NOW + 3 })).resolves.toMatchObject({ outcome: "already_done" });
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(fixture.mergePullRequest).toHaveBeenCalledWith({ environmentId: "env_1", method: "squash" });
  });

  it("confirms Git-native head and strict gh merged state before persisting success", async () => {
    const fixture = mergeFixture();
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const result = await fixture.handler.executeMergeEffect({ effect: mergeEffect(fixture.store), now: NOW + 2 });

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

  it("persists merge success before a Telegram delivery failure and retries delivery only", async () => {
    const delivery = vi.fn<(...args: [Record<string, unknown>]) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Telegram unavailable"))
      .mockResolvedValueOnce(undefined);
    const fixture = mergeFixture({ delivery });
    await expect(acceptApproval(fixture)).resolves.toMatchObject({ outcome: "accepted" });
    const effect = mergeEffect(fixture.store);

    await expect(fixture.handler.executeMergeEffect({ effect, now: NOW + 2 })).rejects.toThrow("Telegram unavailable");
    expect(fixture.store.getJob("job_1")?.state).toBe("merged");
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);

    await expect(fixture.handler.executeMergeEffect({ effect: { ...effect, status: "done" }, now: NOW + 3 })).resolves.toMatchObject({ outcome: "already_done" });
    expect(delivery).toHaveBeenCalledTimes(2);
    expect(fixture.mergePullRequest).toHaveBeenCalledTimes(1);
  });
});
