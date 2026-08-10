import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { JobEffect } from "../src/domain/models";
import { hashSecret } from "../src/crypto";
import { ApprovalService } from "../src/services/approval-service";
import { openStore } from "../src/storage/store";
import { policyFixture, sha } from "./helpers";

const HEAD = sha();
const NOW = 1_000;
const APPROVAL_TTL_MS = 15 * 60_000;

function approvalFixture(options: { now?: number } = {}) {
  const now = options.now ?? NOW;
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
  const db = bb.storage.database();
  const store = openStore(bb.storage);
  const policy = policyFixture({ requiredChecks: [] });

  store.createPairingCode(hashSecret("pair"), now, now + 60_000);
  expect(store.pairOwnerWithPrivateChatCode(hashSecret("pair"), "7", "70", now)).toEqual({ ok: true });
  store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "merge this", now });
  db.prepare(
    `UPDATE jobs SET state = 'awaiting_merge_approval', project_id = ?,
       policy_version = ?, policy_json = ?, environment_id = ?, pr_number = ?,
       pr_url = ?, pr_head_sha = ?, version = ?, updated_at = ? WHERE id = ?`,
  ).run(
    policy.projectId,
    1,
    JSON.stringify(policy),
    "env_1",
    17,
    "https://github.com/acme/cyndra/pull/17",
    HEAD,
    7,
    now,
    "job_1",
  );

  let nonceByte = 1;
  const service = new ApprovalService(store, {
    now: () => now,
    randomBytes: () => Buffer.alloc(24, nonceByte++),
  });
  return { db, store, service, now, job: store.getJob("job_1")! };
}

function mergeEffect(jobVersion: number, payload: Record<string, unknown> = {}): JobEffect {
  return {
    idempotencyKey: "job_1:merge_pr:7",
    jobId: "job_1",
    kind: "merge_pr",
    payload: {
      headSha: HEAD,
      receipt: {
        jobId: "job_1",
        jobVersion,
        projectId: "proj_1",
        environmentId: "env_1",
        prNumber: 17,
        baseBranch: "main",
        headSha: HEAD,
        reviewAttemptId: "review_1",
        validationCompletedAt: new Date(NOW).toISOString(),
        requiredCheckNames: [],
        mergeMethod: "squash",
        expiresAt: new Date(NOW + APPROVAL_TTL_MS).toISOString(),
      },
      ...payload,
    },
  };
}

describe("Telegram merge approvals", () => {
  it("stores only a SHA-256 hash and consumes an approval once for its exact head", () => {
    const fixture = approvalFixture();
    const issued = fixture.service.issue("job_1", HEAD);
    const row = fixture.db.prepare("SELECT nonce_hash FROM approvals").get() as { nonce_hash: string };

    expect(row.nonce_hash).toBe(createHash("sha256").update(issued.nonce).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(issued.nonce);
    expect(fixture.service.consume(issued.nonce, NOW + 1)).toMatchObject({ ok: true, headSha: HEAD });
    expect(fixture.service.consume(issued.nonce, NOW + 2)).toEqual({ ok: false, reason: "consumed" });
  });

  it("rejects a callback from the wrong paired owner or chat", () => {
    const fixture = approvalFixture();
    const issued = fixture.service.issue("job_1", HEAD);

    expect(fixture.service.consume(issued.nonce, NOW + 1, { userId: "8", chatId: "70" })).toEqual({
      ok: false,
      reason: "revoked",
    });
    const secondFixture = approvalFixture();
    const secondIssued = secondFixture.service.issue("job_1", HEAD);
    expect(secondFixture.service.consume(secondIssued.nonce, NOW + 1, { userId: "7", chatId: "71" })).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("expires at exactly fifteen minutes and revokes stale approvals", () => {
    const fixture = approvalFixture();
    const issued = fixture.service.issue("job_1", HEAD);

    expect(fixture.service.consume(issued.nonce, NOW + APPROVAL_TTL_MS)).toEqual({ ok: false, reason: "expired" });
    expect(fixture.store.revokeApprovals("job_1", "cancelled", NOW + 1)).toBe(1);
    const replacement = fixture.service.issue("job_1", HEAD, NOW + 2);
    fixture.store.revokeApprovals("job_1", "cancelled", NOW + 3);
    expect(fixture.service.consume(replacement.nonce, NOW + 4)).toEqual({ ok: false, reason: "revoked" });
  });

  it.each([
    ["changed job version", (fixture: ReturnType<typeof approvalFixture>) => fixture.db.prepare("UPDATE jobs SET version = 8 WHERE id = 'job_1'").run()],
    ["cancelled job", (fixture: ReturnType<typeof approvalFixture>) => fixture.db.prepare("UPDATE jobs SET cancel_requested_at = 2_000 WHERE id = 'job_1'").run()],
    ["changed head", (fixture: ReturnType<typeof approvalFixture>) => fixture.db.prepare("UPDATE jobs SET pr_head_sha = ? WHERE id = 'job_1'").run(sha("b"))],
  ] as const)("revokes an approval when the %s", (_label, mutate) => {
    const fixture = approvalFixture();
    const issued = fixture.service.issue("job_1", HEAD);
    mutate(fixture);

    expect(fixture.service.consume(issued.nonce, NOW + 1)).toEqual({ ok: false, reason: "revoked" });
  });

  it("atomically consumes an approval and enqueues exactly one merge effect", () => {
    const fixture = approvalFixture();
    const issued = fixture.service.issue("job_1", HEAD);
    const effect = mergeEffect(fixture.job.version);

    expect(fixture.store.acceptApprovalAndEnqueueMerge({
      nonceHash: hashSecret(issued.nonce),
      expectedJobVersion: fixture.job.version,
      effect,
      now: NOW + 1,
    })).toEqual({ ok: true, jobId: "job_1", headSha: HEAD });
    expect(fixture.store.getJob("job_1")?.state).toBe("merging");
    expect(fixture.db.prepare("SELECT consumed_at, outcome FROM approvals").get()).toMatchObject({ outcome: "accepted" });
    expect(fixture.store.listEffectsForJob("job_1").filter((item) => item.kind === "merge_pr")).toHaveLength(1);

    expect(fixture.store.acceptApprovalAndEnqueueMerge({
      nonceHash: hashSecret(issued.nonce),
      expectedJobVersion: fixture.job.version,
      effect,
      now: NOW + 2,
    })).toEqual({ ok: true, jobId: "job_1", headSha: HEAD });
    expect(fixture.store.listEffectsForJob("job_1").filter((item) => item.kind === "merge_pr")).toHaveLength(1);
  });

  it("rolls back consumption when durable merge work cannot be serialized", () => {
    const fixture = approvalFixture();
    const issued = fixture.service.issue("job_1", HEAD);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => fixture.store.acceptApprovalAndEnqueueMerge({
      nonceHash: hashSecret(issued.nonce),
      expectedJobVersion: fixture.job.version,
      effect: mergeEffect(fixture.job.version, { cyclic }),
      now: NOW + 1,
    })).toThrow();
    expect(fixture.db.prepare("SELECT consumed_at, outcome FROM approvals").get()).toEqual({ consumed_at: null, outcome: null });
    expect(fixture.store.getJob("job_1")?.state).toBe("awaiting_merge_approval");
    expect(fixture.store.listEffectsForJob("job_1").filter((item) => item.kind === "merge_pr")).toHaveLength(0);
  });

  it("returns the same accepted result when two consumers race the same nonce", () => {
    const fixture = approvalFixture();
    const issued = fixture.service.issue("job_1", HEAD);
    const effect = mergeEffect(fixture.job.version);

    const first = fixture.store.acceptApprovalAndEnqueueMerge({
      nonceHash: hashSecret(issued.nonce),
      expectedJobVersion: fixture.job.version,
      effect,
      now: NOW + 1,
    });
    const second = fixture.store.acceptApprovalAndEnqueueMerge({
      nonceHash: hashSecret(issued.nonce),
      expectedJobVersion: fixture.job.version,
      effect,
      now: NOW + 2,
    });

    expect(first).toEqual({ ok: true, jobId: "job_1", headSha: HEAD });
    expect(second).toEqual(first);
    expect(fixture.store.listEffectsForJob("job_1").filter((item) => item.kind === "merge_pr")).toHaveLength(1);
  });
});
