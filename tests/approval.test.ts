import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { JobEffect } from "../src/domain/models";
import { hashSecret } from "../src/crypto";
import { ApprovalService } from "../src/services/approval-service";
import { openStore } from "../src/storage/store";
import {
  ephemeralTelegramPayload,
  persistableJobStatusPayload,
  renderJobStatus,
} from "../src/telegram/view";
import { jobFixture, policyFixture, sha } from "./helpers";

const HEAD = sha();
const MOVED = sha("b");
const NOW = 1_000;
const APPROVAL_TTL_MS = 15 * 60_000;

function approvalFixture(options: { now?: number } = {}) {
  const now = options.now ?? NOW;
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
  const db = bb.storage.database();
  let currentNow = now;
  const store = openStore(bb.storage, bb.storage.kv, () => currentNow);
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
    now: () => currentNow,
    randomBytes: () => Buffer.alloc(24, nonceByte++),
  });
  return {
    db,
    store,
    service,
    now,
    job: store.getJob("job_1")!,
    setNow: (value: number) => {
      currentNow = value;
    },
  };
}

function mergeEffect(
  jobVersion: number,
  approvalNonceHash: string,
  payload: Record<string, unknown> = {},
): JobEffect {
  const idempotencyKey = `job_1:${jobVersion + 1}:merge_pr`;
  return {
    idempotencyKey,
    jobId: "job_1",
    kind: "merge_pr",
    payload: {
      headSha: HEAD,
      receipt: {
        jobId: "job_1",
        effectIdempotencyKey: idempotencyKey,
        approvalNonceHash,
        approvalOwnerUserId: "7",
        approvalOwnerChatId: "70",
        jobVersion: jobVersion + 1,
        approvalJobVersion: jobVersion,
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

    fixture.setNow(NOW + APPROVAL_TTL_MS);
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
    const effect = mergeEffect(fixture.job.version, hashSecret(issued.nonce));

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
      effect: mergeEffect(fixture.job.version, hashSecret(issued.nonce), { cyclic }),
      now: NOW + 1,
    })).toThrow();
    expect(fixture.db.prepare("SELECT consumed_at, outcome FROM approvals").get()).toEqual({ consumed_at: null, outcome: null });
    expect(fixture.store.getJob("job_1")?.state).toBe("awaiting_merge_approval");
    expect(fixture.store.listEffectsForJob("job_1").filter((item) => item.kind === "merge_pr")).toHaveLength(0);

    const payloadMismatch = mergeEffect(fixture.job.version, hashSecret(issued.nonce));
    payloadMismatch.payload.headSha = MOVED;
    expect(() => fixture.store.acceptApprovalAndEnqueueMerge({
      nonceHash: hashSecret(issued.nonce),
      expectedJobVersion: fixture.job.version,
      effect: payloadMismatch,
      now: NOW + 1,
    })).toThrow(/payload|head|receipt/i);
    expect(fixture.db.prepare("SELECT consumed_at, outcome FROM approvals").get()).toEqual({ consumed_at: null, outcome: null });
  });

  it("rejects a caller-supplied merge effect whose generated key is not exact", () => {
    const fixture = approvalFixture();
    const issued = fixture.service.issue("job_1", HEAD);
    const effect = mergeEffect(fixture.job.version, hashSecret(issued.nonce));
    effect.idempotencyKey = "job_1:999:merge_pr";

    expect(() => fixture.store.acceptApprovalAndEnqueueMerge({
      nonceHash: hashSecret(issued.nonce),
      expectedJobVersion: fixture.job.version,
      effect,
      now: NOW + 1,
    })).toThrow(/idempotency|generated|effect/i);
    expect(fixture.db.prepare("SELECT consumed_at, outcome FROM approvals").get()).toEqual({ consumed_at: null, outcome: null });
    expect(fixture.store.getJob("job_1")?.state).toBe("awaiting_merge_approval");
    expect(fixture.store.listEffectsForJob("job_1").filter((item) => item.kind === "merge_pr")).toHaveLength(0);
  });

  it("rolls back when the exact generated effect key collides with another payload", () => {
    const fixture = approvalFixture();
    const issued = fixture.service.issue("job_1", HEAD);
    const effect = mergeEffect(fixture.job.version, hashSecret(issued.nonce));
    fixture.db.prepare(
      `INSERT INTO effects (
         idempotency_key, job_id, kind, payload_json, status, attempts,
         next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, 'merge_pr', ?, 'pending', 0, ?, ?, ?)`,
    ).run(effect.idempotencyKey, effect.jobId, JSON.stringify({ receipt: { jobId: "wrong" } }), NOW, NOW, NOW);

    expect(() => fixture.store.acceptApprovalAndEnqueueMerge({
      nonceHash: hashSecret(issued.nonce),
      expectedJobVersion: fixture.job.version,
      effect,
      now: NOW + 1,
    })).toThrow(/collision|idempotency|effect/i);
    expect(fixture.db.prepare("SELECT consumed_at, outcome FROM approvals").get()).toEqual({ consumed_at: null, outcome: null });
    expect(fixture.store.getJob("job_1")?.state).toBe("awaiting_merge_approval");
    expect(fixture.store.getEffect("job_1", effect.idempotencyKey)?.payload).toEqual({ receipt: { jobId: "wrong" } });
  });

  it("never persists a raw merge callback nonce in outbox or callback storage", () => {
    const fixture = approvalFixture();
    const issued = fixture.service.issue("job_1", HEAD);
    const rawCallback = `m:${issued.nonce}`;

    fixture.store.enqueueOutbox({
      logicalKey: "job_1:safe-merge-status",
      chatId: "70",
      payload: persistableJobStatusPayload({
        text: "Ready",
        reply_markup: { inline_keyboard: [[{ text: "Merge", callback_data: rawCallback }]] },
      }),
    }, NOW + 1);

    expect(() => fixture.store.enqueueOutbox({
      logicalKey: "job_1:merge-status",
      chatId: "70",
      payload: {
        text: "Ready",
        reply_markup: { inline_keyboard: [[{ text: "Merge", callback_data: rawCallback }]] },
      },
    }, NOW + 1)).toThrow(/raw|nonce|callback/i);

    const persisted = JSON.stringify({
      approvals: fixture.db.prepare("SELECT * FROM approvals").all(),
      effects: fixture.db.prepare("SELECT * FROM effects").all(),
      outbox: fixture.db.prepare("SELECT * FROM outbox").all(),
      callbacks: fixture.db.prepare("SELECT * FROM callbacks").all(),
    });
    expect(persisted).not.toContain(rawCallback);
  });

  it("rejects callback material embedded in recursive outbox keys and values", () => {
    const fixture = approvalFixture();
    const issued = fixture.service.issue("job_1", HEAD);
    const embedded = `prefixxm:m:${issued.nonce}suffix`;
    const malformedEncoded = `prefix%ZZ/%6D%3A${issued.nonce}`;

    expect(() => fixture.store.enqueueOutbox({
      logicalKey: "job_1:embedded-callback",
      chatId: "70",
      payload: { nested: { [embedded]: { value: embedded } } },
    }, NOW + 1)).toThrow(/raw|nonce|callback/i);
    expect(() => fixture.store.enqueueOutbox({
      logicalKey: "job_1:malformed-encoded-callback",
      chatId: "70",
      payload: { nested: { value: malformedEncoded } },
    }, NOW + 1)).toThrow(/raw|nonce|callback/i);
  });

  it("rejects raw merge callbacks recursively in completed results", () => {
    const fixture = approvalFixture();
    const issued = fixture.service.issue("job_1", HEAD);
    const effect = mergeEffect(fixture.job.version, hashSecret(issued.nonce));
    expect(fixture.store.acceptApprovalAndEnqueueMerge({
      nonceHash: hashSecret(issued.nonce),
      expectedJobVersion: fixture.job.version,
      effect,
      now: NOW + 1,
      identity: { userId: "7", chatId: "70" },
    })).toMatchObject({ ok: true });
    fixture.db.prepare(
      `UPDATE effects SET status = 'leased', lease_owner = ?, lease_generation = ?,
         lease_expires_at = ?, payload_json = ? WHERE job_id = ? AND idempotency_key = ?`,
    ).run(
      "executor-1",
      1,
      NOW + 60_000,
      JSON.stringify({ ...effect.payload, mergeCallStartedAt: NOW + 1, mergeCallOutcome: "unknown" }),
      effect.jobId,
      effect.idempotencyKey,
    );

    const raw = `m:${issued.nonce}`;
    expect(() => fixture.store.completeMergeSuccess({
      jobId: effect.jobId,
      effectIdempotencyKey: effect.idempotencyKey,
      message: "merged",
      result: { nested: { rawCallback: raw } },
      outbox: {
        logicalKey: "job_1:merge:completion",
        chatId: "70",
        payload: { text: "merged" },
      },
      now: NOW + 2,
      leaseOwner: "executor-1",
      leaseGeneration: 1,
    })).toThrow(/raw|nonce|callback/i);

  });

  it("renders only bounded HTTPS external URLs as Telegram links", () => {
    const viewJob = jobFixture({
      id: "abcdefghijklmnopqrstuv",
      state: "awaiting_merge_approval",
      projectId: "proj_1",
      policyVersion: 1,
      policy: policyFixture({ requiredChecks: [] }),
      prNumber: 17,
      prUrl: "http://example.test/pull/17",
      prHeadSha: HEAD,
    });
    const insecure = renderJobStatus(viewJob, { bbAppBaseUrl: "http://bb.example/app" });
    expect(insecure.reply_markup?.inline_keyboard.flat().some((button) => button.url)).toBe(false);

    const oversized = renderJobStatus(viewJob, {
      bbAppBaseUrl: `https://bb.example/${"x".repeat(2_000)}`,
    });
    expect(oversized.reply_markup?.inline_keyboard.flat().some((button) => button.url)).toBe(false);
  });

  it.each([
    "https://github.com/acme/cyndra/pull/17?token=secret",
    "https://github.com/acme/cyndra/pull/17?%74oken=secret",
    "https://github.com/acme/cyndra/pull/17?%2574oken=secret",
    "https://github.com/acme/cyndra/pull/17?next=secret",
    "https://github.com/acme/cyndra/pull/17?next=%73ecret",
    "https://github.com/acme/cyndra/pull/17?next=%2573ecret",
    "https://github.com/acme/cyndra/pull/17?next=%26token%3Dsecret",
    "https://github.com/acme/cyndra/pull/17?next=%2526token%253Dsecret",
    "https://github.com/acme/cyndra/pull/17?%256eext=%2526%2574oken%253Dsecret",
  ])("rejects nested or encoded credential URL material in persistence and Telegram rendering", (url) => {
    const fixture = approvalFixture();
    expect(() => fixture.store.enqueueOutbox({
      logicalKey: `unsafe-url-${url.slice(-12)}`,
      chatId: "70",
      payload: { reply_markup: { inline_keyboard: [[{ text: "PR", url }]] } },
    }, NOW + 1)).toThrow(/credential|HTTPS|URL/i);

    const rendered = renderJobStatus(jobFixture({
      id: "abcdefghijklmnopqrstuv",
      state: "awaiting_merge_approval",
      projectId: "proj_1",
      policyVersion: 1,
      policy: policyFixture({ requiredChecks: [] }),
      prNumber: 17,
      prUrl: url,
      prHeadSha: HEAD,
    }));
    const buttons = rendered.reply_markup?.inline_keyboard.flat() ?? [];
    expect(buttons.find((button) => button.text === "View PR")).toBeUndefined();
    expect(rendered.text).not.toContain(url);
  });

  it("reissues a crashed approval with a fresh ephemeral button and no nonce in SQLite", () => {
    const fixture = approvalFixture();
    const viewJob = jobFixture({
      id: "abcdefghijklmnopqrstuv",
      state: "awaiting_merge_approval",
      projectId: "proj_1",
      policyVersion: 1,
      policy: policyFixture({ requiredChecks: [] }),
      prNumber: 17,
      prUrl: "https://github.com/acme/cyndra/pull/17",
      prHeadSha: HEAD,
    });
    const oldApproval = fixture.service.issue("job_1", HEAD, NOW);
    const oldRendered = renderJobStatus(viewJob, {
      mergeNonce: oldApproval.nonce,
      approvalExpiresAt: oldApproval.expiresAt,
    });
    fixture.store.enqueueOutbox({
      logicalKey: "job_1:ready",
      chatId: "70",
      payload: persistableJobStatusPayload(oldRendered),
    }, NOW + 1);

    const freshApproval = fixture.service.issue("job_1", HEAD, NOW + 2);
    const freshRendered = renderJobStatus(viewJob, {
      mergeNonce: freshApproval.nonce,
      approvalExpiresAt: freshApproval.expiresAt,
    });
    const ephemeral = ephemeralTelegramPayload(freshRendered);
    const freshButton = ephemeral.reply_markup?.inline_keyboard.flat().find((button) => button.text === "Merge + deploy aaaaaaaa");
    expect(freshButton?.callback_data).toBe(`m:${freshApproval.nonce}`);
    expect(fixture.service.lookup(oldApproval.nonce)).toMatchObject({ outcome: "superseded" });
    expect(fixture.service.consume(oldApproval.nonce, NOW + 3)).toEqual({ ok: false, reason: "revoked" });

    fixture.store.enqueueOutbox({
      logicalKey: "job_1:ready",
      chatId: "70",
      payload: persistableJobStatusPayload(freshRendered),
    }, NOW + 3);
    const sqlite = JSON.stringify({
      approvals: fixture.db.prepare("SELECT * FROM approvals").all(),
      effects: fixture.db.prepare("SELECT * FROM effects").all(),
      outbox: fixture.db.prepare("SELECT * FROM outbox").all(),
      callbacks: fixture.db.prepare("SELECT * FROM callbacks").all(),
    });
    expect(sqlite).not.toContain(oldApproval.nonce);
    expect(sqlite).not.toContain(freshApproval.nonce);
    expect(sqlite).not.toContain(`m:${oldApproval.nonce}`);
    expect(sqlite).not.toContain(`m:${freshApproval.nonce}`);
  });

  it("returns the same accepted result when two consumers race the same nonce", () => {
    const fixture = approvalFixture();
    const issued = fixture.service.issue("job_1", HEAD);
    const effect = mergeEffect(fixture.job.version, hashSecret(issued.nonce));

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

  it("rolls back approval revocation when atomic fresh reissue insertion fails", () => {
    const fixture = approvalFixture();
    const issued = fixture.service.issue("job_1", HEAD, NOW);
    fixture.db.exec(`
      CREATE TRIGGER reject_fresh_approval
      BEFORE INSERT ON approvals
      BEGIN
        SELECT RAISE(ABORT, 'forced fresh approval insert failure');
      END
    `);

    expect(() => fixture.service.issue("job_1", HEAD, NOW + 1)).toThrow(/fresh approval insert failure/);
    expect(fixture.service.lookup(issued.nonce)).toMatchObject({ consumedAt: null, outcome: null });
    expect(fixture.service.consume(issued.nonce, NOW + 2)).toMatchObject({ ok: true, headSha: HEAD });
  });

  it("persists merge callback completion identity without the raw callback nonce", () => {
    const fixture = approvalFixture();
    const issued = fixture.service.issue("job_1", HEAD);
    const effect = mergeEffect(fixture.job.version, hashSecret(issued.nonce));

    expect(fixture.store.acceptApprovalAndEnqueueMerge({
      nonceHash: hashSecret(issued.nonce),
      expectedJobVersion: fixture.job.version,
      effect,
      now: NOW + 1,
      identity: { userId: "7", chatId: "70" },
    })).toMatchObject({ ok: true });
    expect(fixture.store.recordCallback(
      "callback_identity",
      "job_1",
      "merge",
      "accepted",
      NOW + 2,
      {
        approvalNonceHash: hashSecret(issued.nonce),
        headSha: HEAD,
        effectIdempotencyKey: effect.idempotencyKey,
      },
    )).toBe(true);
    expect(fixture.db.prepare(
      "SELECT approval_nonce_hash, head_sha, effect_idempotency_key FROM callbacks WHERE callback_query_id = ?",
    ).get("callback_identity")).toEqual({
      approval_nonce_hash: hashSecret(issued.nonce),
      head_sha: HEAD,
      effect_idempotency_key: effect.idempotencyKey,
    });
    expect(JSON.stringify(fixture.db.prepare("SELECT * FROM callbacks").all())).not.toContain(issued.nonce);
  });

  it("rejects every callback-bearing form during stale effect cleanup", () => {
    const fixture = approvalFixture();
    const issued = fixture.service.issue("job_1", HEAD);
    const effect = mergeEffect(fixture.job.version, hashSecret(issued.nonce));
    fixture.store.acceptApprovalAndEnqueueMerge({
      nonceHash: hashSecret(issued.nonce),
      expectedJobVersion: fixture.job.version,
      effect,
      now: NOW + 1,
    });
    fixture.db.prepare(
      `UPDATE effects SET status = 'leased', lease_owner = ?, lease_generation = ?, lease_expires_at = ?
         WHERE job_id = ? AND idempotency_key = ?`,
    ).run("executor-1", 1, NOW + 60_000, effect.jobId, effect.idempotencyKey);

    const forms = [
      `m:${issued.nonce}`,
      `prefixxm:m:${issued.nonce}suffix`,
      `m%3A${issued.nonce}`,
      `%256D%253A${issued.nonce}`,
      `%ZZ%6D%3A${issued.nonce}`,
    ];
    for (const form of forms) {
      expect(() => fixture.store.staleMergeEffect({
        jobId: effect.jobId,
        effectIdempotencyKey: effect.idempotencyKey,
        reason: form,
        now: NOW + 2,
        leaseOwner: "executor-1",
        leaseGeneration: 1,
      })).toThrow(/callback|nonce/i);
    }
  });

  it("uses the fresh store clock for failure-cleanup lease predicates", () => {
    const fixture = approvalFixture();
    const issued = fixture.service.issue("job_1", HEAD);
    const effect = mergeEffect(fixture.job.version, hashSecret(issued.nonce));
    expect(fixture.store.acceptApprovalAndEnqueueMerge({
      nonceHash: hashSecret(issued.nonce),
      expectedJobVersion: fixture.job.version,
      effect,
      now: NOW + 1,
    })).toMatchObject({ ok: true });
    const durable = fixture.store.listEffectsForJob("job_1").find((item) => item.kind === "merge_pr");
    if (!durable) throw new Error("merge effect was not stored");
    fixture.db.prepare(
      `UPDATE effects SET status = 'leased', lease_owner = ?, lease_generation = ?,
         lease_expires_at = ?, updated_at = ? WHERE idempotency_key = ?`,
    ).run("executor-1", 1, NOW + 10, NOW, durable.idempotencyKey);
    fixture.setNow(NOW + 11);

    expect(fixture.store.failLeasedMergeEffect({
      jobId: durable.jobId,
      effectIdempotencyKey: durable.idempotencyKey,
      reason: "late cleanup",
      now: NOW + 1,
      leaseOwner: "executor-1",
      leaseGeneration: 1,
    })).toBe(false);
    expect(fixture.db.prepare(
      "SELECT status, lease_owner, lease_generation, lease_expires_at FROM effects WHERE idempotency_key = ?",
    ).get(durable.idempotencyKey)).toEqual({
      status: "leased",
      lease_owner: "executor-1",
      lease_generation: 1,
      lease_expires_at: NOW + 10,
    });
  });
});
