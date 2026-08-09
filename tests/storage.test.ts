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

  expect(store.pairOwnerWithCode(hashSecret("pair-me"), "7", "70", 2_000)).toEqual({ ok: true });
  expect(store.pairOwnerWithCode(hashSecret("pair-me"), "8", "80", 2_001)).toEqual({ ok: false, reason: "consumed" });
  const row = db.prepare("SELECT code_hash FROM pairing_codes").get();
  expect(row).toEqual({ code_hash: hashSecret("pair-me") });
  expect(JSON.stringify(row)).not.toContain("pair-me");
  expect(store.getOwner()).toEqual({ userId: "7", chatId: "70", pairedAt: 2_000 });
});

it("rejects missing and expired pairing codes and an already paired owner", () => {
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
  const store = openStore(bb.storage);

  expect(store.pairOwnerWithCode(hashSecret("missing"), "7", "70", 2_000)).toEqual({ ok: false, reason: "missing" });

  store.createPairingCode(hashSecret("expired"), 1_000, 2_000);
  expect(store.pairOwnerWithCode(hashSecret("expired"), "7", "70", 2_000)).toEqual({ ok: false, reason: "expired" });

  store.createPairingCode(hashSecret("first"), 1_000, 11_000);
  expect(store.pairOwnerWithCode(hashSecret("first"), "7", "70", 2_000)).toEqual({ ok: true });
  store.createPairingCode(hashSecret("second"), 2_000, 12_000);
  expect(store.pairOwnerWithCode(hashSecret("second"), "8", "80", 2_001)).toEqual({ ok: false, reason: "already_paired" });
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
  expect(store.pairOwnerWithCode(hashSecret("pair-me"), "7", "70", 2_000)).toEqual({ ok: true });
  expect(store.bindTelegramIdentity({ botId: "bot-7", username: "first_bot", now: 2_001, hasActiveJob: false })).toBe("created");

  db.prepare("UPDATE telegram_cursor SET next_offset = 42 WHERE singleton = 1").run();
  expect(store.bindTelegramIdentity({ botId: "bot-7", username: "renamed_bot", now: 2_002, hasActiveJob: false })).toBe("same");
  expect(store.getOwner()).toEqual({ userId: "7", chatId: "70", pairedAt: 2_000 });
  expect(db.prepare("SELECT next_offset FROM telegram_cursor WHERE singleton = 1").get()).toEqual({ next_offset: 42 });
  expect(store.getTelegramIdentity()).toEqual({ botId: "bot-7", username: "renamed_bot", verifiedAt: 2_002 });

  expect(store.bindTelegramIdentity({ botId: "bot-8", username: "other_bot", now: 2_003, hasActiveJob: true })).toBe("active_job_conflict");
  expect(store.getTelegramIdentity()?.botId).toBe("bot-7");
  expect(store.getOwner()?.userId).toBe("7");

  db.prepare(
    "INSERT INTO jobs (id, source_update_id, request_text, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("job-1", 11, "request", "implementing", 2_000, 2_000);
  db.prepare(
    "INSERT INTO approvals (nonce_hash, job_id, head_sha, expires_at) VALUES (?, ?, ?, ?)",
  ).run(hashSecret("approval"), "job-1", "abc123", 10_000);

  expect(store.bindTelegramIdentity({ botId: "bot-8", username: "other_bot", now: 2_004, hasActiveJob: false })).toBe("changed");
  expect(store.getTelegramIdentity()).toEqual({ botId: "bot-8", username: "other_bot", verifiedAt: 2_004 });
  expect(store.getOwner()).toBeNull();
  expect(db.prepare("SELECT next_offset FROM telegram_cursor WHERE singleton = 1").get()).toEqual({ next_offset: 0 });
  expect(db.prepare("SELECT COUNT(*) AS count FROM approvals").get()).toEqual({ count: 0 });
  expect(db.prepare("SELECT revoked_at FROM owners WHERE singleton = 1").get()).toEqual({ revoked_at: 2_004 });
});

it("revokes an owner once and reports no change after revocation", () => {
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
  const store = openStore(bb.storage);
  store.createPairingCode(hashSecret("pair-me"), 1_000, 11_000);
  expect(store.pairOwnerWithCode(hashSecret("pair-me"), "7", "70", 2_000)).toEqual({ ok: true });

  expect(store.revokeOwner(3_000)).toBe(true);
  expect(store.getOwner()).toBeNull();
  expect(store.revokeOwner(4_000)).toBe(false);
});
