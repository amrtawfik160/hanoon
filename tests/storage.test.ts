import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { createSecret, hashSecret } from "../src/crypto";
import type { ProjectPolicy } from "../src/domain/models";
import { openStore } from "../src/storage/store";

function policy(overrides: Partial<ProjectPolicy> = {}): ProjectPolicy {
  return {
    projectId: "proj_1",
    alias: "cyndra",
    enabled: true,
    githubRepository: "acme/cyndra",
    baseBranch: "main",
    implementation: {},
    review: {},
    validationCommands: [
      { name: "unit", command: "npm test", timeoutMs: 600_000 },
    ],
    requiredChecks: ["test"],
    outputRedactionPatterns: [],
    workerLivenessWatchdogMs: 300_000,
    maxReviewCycles: 3,
    mergeMethod: "squash",
    ...overrides,
  };
}

it("creates secrets from injectable randomness and hashes them", () => {
  expect(createSecret(3, () => Buffer.from([0xfb, 0xef, 0xff]))).toBe("--__");
  expect(hashSecret("pair-me")).toBe(
    "508499891a8ecb2c56515e8b9794481bb087970f282e8054290f8fc468abd767",
  );
});

it("pairs with a code exactly once without storing plaintext", () => {
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
  const db = bb.storage.database();
  const store = openStore(bb.storage);
  store.createPairingCode(hashSecret("pair-me"), 1_000, 11_000);

  expect(store.pairOwnerWithCode(hashSecret("pair-me"), "7", "7", 2_000)).toEqual({ ok: true });
  expect(store.pairOwnerWithCode(hashSecret("pair-me"), "8", "8", 2_001)).toEqual({ ok: false, reason: "consumed" });
  const row = db.prepare("SELECT code_hash FROM pairing_codes").get();
  expect(row).toEqual({ code_hash: hashSecret("pair-me") });
  expect(JSON.stringify(row)).not.toContain("pair-me");
  expect(store.getOwner()).toEqual({ userId: "7", chatId: "7", pairedAt: 2_000 });
});

it("rejects missing and expired pairing codes and an already paired owner", () => {
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
  const store = openStore(bb.storage);

  expect(store.pairOwnerWithCode(hashSecret("missing"), "7", "7", 2_000)).toEqual({ ok: false, reason: "missing" });

  store.createPairingCode(hashSecret("expired"), 1_000, 2_000);
  expect(store.pairOwnerWithCode(hashSecret("expired"), "7", "7", 2_000)).toEqual({ ok: false, reason: "expired" });

  store.createPairingCode(hashSecret("first"), 1_000, 11_000);
  expect(store.pairOwnerWithCode(hashSecret("first"), "7", "7", 2_000)).toEqual({ ok: true });
  store.createPairingCode(hashSecret("second"), 2_000, 12_000);
  expect(store.pairOwnerWithCode(hashSecret("second"), "8", "8", 2_001)).toEqual({ ok: false, reason: "already_paired" });
});

it("rejects invalid pairing identities before consuming a valid code", () => {
  const invalidIdentities = [
    ["7", "-100123"],
    ["07", "07"],
    ["7", "70"],
  ] as const;

  for (const [userId, chatId] of invalidIdentities) {
    const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
    const db = bb.storage.database();
    const store = openStore(bb.storage);
    const codeHash = hashSecret(`${userId}:${chatId}`);
    store.createPairingCode(codeHash, 1_000, 11_000);

    expect(() => store.pairOwnerWithCode(codeHash, userId, chatId, 2_000)).toThrow(TypeError);
    expect(db.prepare("SELECT consumed_at FROM pairing_codes WHERE code_hash = ?").get(codeHash)).toEqual({ consumed_at: null });
    expect(store.getOwner()).toBeNull();
  }
});

it("rejects plaintext pairing codes before insertion or consumption", () => {
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
  const db = bb.storage.database();
  const store = openStore(bb.storage);
  const validHash = hashSecret("pair-me");

  expect(() => store.createPairingCode("pair-me", 1_000, 11_000)).toThrow(TypeError);
  expect(db.prepare("SELECT COUNT(*) AS count FROM pairing_codes").get()).toEqual({ count: 0 });

  store.createPairingCode(validHash, 1_000, 11_000);
  expect(() => store.pairOwnerWithCode("pair-me", "7", "7", 2_000)).toThrow(TypeError);
  expect(db.prepare("SELECT consumed_at FROM pairing_codes WHERE code_hash = ?").get(validHash)).toEqual({ consumed_at: null });
  expect(store.getOwner()).toBeNull();
});

it("round-trips a validated enabled project policy and increments its version", () => {
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
  const store = openStore(bb.storage);

  const first = store.upsertProjectPolicy(policy(), 1_000);
  expect(first).toEqual({ policy: policy(), version: 1 });

  const second = store.upsertProjectPolicy(policy({ baseBranch: "develop" }), 2_000);
  expect(second).toEqual({ policy: policy({ baseBranch: "develop" }), version: 2 });
  expect(store.getProjectPolicy("proj_1")).toEqual(second);
  expect(store.getProjectPolicyByAlias("cyndra")).toEqual(second);

  store.upsertProjectPolicy(
    policy({ projectId: "proj_2", alias: "disabled", enabled: false }),
    3_000,
  );
  expect(store.listEnabledProjectPolicies()).toEqual([second]);
});

it("fails closed when persisted project policy JSON is invalid", () => {
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
  const db = bb.storage.database();
  const store = openStore(bb.storage);
  store.upsertProjectPolicy(policy(), 1_000);

  db.prepare("UPDATE project_policies SET policy_json = ? WHERE project_id = ?").run(
    JSON.stringify({ ...policy(), alias: "INVALID ALIAS" }),
    "proj_1",
  );

  expect(() => store.getProjectPolicy("proj_1")).toThrow();
});

it("preserves owner and cursor for the same bot, blocks active-job changes, and resets state on an idle bot change", () => {
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
  const db = bb.storage.database();
  const store = openStore(bb.storage);
  store.createPairingCode(hashSecret("pair-me"), 1_000, 11_000);
  expect(store.pairOwnerWithCode(hashSecret("pair-me"), "7", "7", 2_000)).toEqual({ ok: true });
  expect(store.bindTelegramIdentity({ botId: "7", username: "first_bot", now: 2_001, hasActiveJob: false })).toBe("created");

  db.prepare("UPDATE telegram_cursor SET next_offset = 42 WHERE singleton = 1").run();
  expect(store.bindTelegramIdentity({ botId: "7", username: "renamed_bot", now: 2_002, hasActiveJob: false })).toBe("same");
  expect(store.getOwner()).toEqual({ userId: "7", chatId: "7", pairedAt: 2_000 });
  expect(db.prepare("SELECT next_offset FROM telegram_cursor WHERE singleton = 1").get()).toEqual({ next_offset: 42 });
  expect(store.getTelegramIdentity()).toEqual({ botId: "7", username: "renamed_bot", verifiedAt: 2_002 });

  expect(store.bindTelegramIdentity({ botId: "8", username: "other_bot", now: 2_003, hasActiveJob: true })).toBe("active_job_conflict");
  expect(store.getTelegramIdentity()?.botId).toBe("7");
  expect(store.getOwner()?.userId).toBe("7");

  db.prepare(
    "INSERT INTO jobs (id, source_update_id, request_text, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("job-1", 11, "request", "implementing", 2_000, 2_000);
  db.prepare(
    "INSERT INTO approvals (nonce_hash, job_id, head_sha, expires_at) VALUES (?, ?, ?, ?)",
  ).run(hashSecret("approval"), "job-1", "abc123", 10_000);
  db.prepare(
    "INSERT INTO outbox (logical_key, chat_id, payload_json, status, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("job-1:status", "7", "{}", "pending", 2_000, 2_000, 2_000);

  expect(store.bindTelegramIdentity({ botId: "8", username: "other_bot", now: 2_004, hasActiveJob: false })).toBe("active_job_conflict");
  expect(store.getTelegramIdentity()?.botId).toBe("7");
  expect(db.prepare("SELECT COUNT(*) AS count FROM outbox").get()).toEqual({ count: 1 });

  db.prepare("UPDATE jobs SET state = ? WHERE id = ?").run("merged", "job-1");
  expect(store.bindTelegramIdentity({ botId: "8", username: "other_bot", now: 2_005, hasActiveJob: false })).toBe("changed");
  expect(store.getTelegramIdentity()).toEqual({ botId: "8", username: "other_bot", verifiedAt: 2_005 });
  expect(store.getOwner()).toBeNull();
  expect(db.prepare("SELECT next_offset FROM telegram_cursor WHERE singleton = 1").get()).toEqual({ next_offset: 0 });
  expect(db.prepare("SELECT COUNT(*) AS count FROM approvals").get()).toEqual({ count: 0 });
  expect(db.prepare("SELECT COUNT(*) AS count FROM outbox").get()).toEqual({ count: 0 });
  expect(db.prepare("SELECT revoked_at FROM owners WHERE singleton = 1").get()).toEqual({ revoked_at: 2_005 });
});

it.each(["0", "07", "-8", "8.0", " 8 "]) (
  "rejects noncanonical bot id %s before creating identity",
  (botId) => {
    const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
    const db = bb.storage.database();
    const store = openStore(bb.storage);

    expect(() => store.bindTelegramIdentity({ botId, username: "bot", now: 2_000, hasActiveJob: false })).toThrow(TypeError);
    expect(db.prepare("SELECT COUNT(*) AS count FROM telegram_identity").get()).toEqual({ count: 0 });
  },
);

it("revokes an owner once and reports no change after revocation", () => {
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
  const store = openStore(bb.storage);
  store.createPairingCode(hashSecret("pair-me"), 1_000, 11_000);
  expect(store.pairOwnerWithCode(hashSecret("pair-me"), "7", "7", 2_000)).toEqual({ ok: true });

  expect(store.revokeOwner(3_000)).toBe(true);
  expect(store.getOwner()).toBeNull();
  expect(store.revokeOwner(4_000)).toBe(false);
});

it.each([
  "http://github.com/acme/cyndra/pull/17",
  "https://user:password@github.com/acme/cyndra/pull/17",
  "https://github.com/acme/cyndra/pull/17?token=secret",
  "https://github.com/acme/cyndra/pull/17?%74oken=secret",
  "https://github.com/acme/cyndra/pull/17?%2574oken=secret",
  "https://github.com/acme/cyndra/pull/17?next=%2526token%253Dsecret",
  `https://github.com/acme/cyndra/pull/17?next=m%3A${"N".repeat(32)}`,
])("rejects an unsafe PR URL before PR_LOCATED persistence: %s", (url) => {
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
  const db = bb.storage.database();
  const store = openStore(bb.storage);
  store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "locate", now: 1_000 });
  db.prepare("UPDATE jobs SET state = 'locating_pr' WHERE id = 'job_1'").run();

  expect(() => store.applyJobEvent(
    "job_1",
    1,
    { type: "PR_LOCATED", number: 17, url },
    1_001,
  )).toThrow(/URL|HTTPS|credential|callback/i);
  expect(db.prepare("SELECT state, pr_url FROM jobs WHERE id = 'job_1'").get()).toEqual({
    state: "locating_pr",
    pr_url: null,
  });
  expect(db.prepare("SELECT COUNT(*) AS count FROM effects").get()).toEqual({ count: 0 });
});
