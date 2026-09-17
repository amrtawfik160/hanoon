import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { parseGlobalConfig } from "../src/config";
import { hashSecret } from "../src/crypto";
import { ALL_MIGRATIONS, DEAD_DURABLE_SUBSYSTEM_MIGRATIONS } from "../src/storage/migrations";
import { openStore } from "../src/storage/store";
import { policyFixture } from "./helpers";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GONE_TABLES = [
  "tool_receipts",
  "controller_digest",
  "memory_recalls",
  "recipe_promotions",
  "recipe_deterministic_evidence",
  "recipe_classifier_evidence",
  "recipe_live_evidence",
  "recipe_live_evidence_receipts",
  "recipe_model_trial_evidence",
  "recipe_safety_evidence",
  "recipe_promotion_evidence_manifests",
  "workflow_engine_promotions",
  "navigator_deterministic_evidence",
  "navigator_corpus_evidence",
  "navigator_live_evidence",
  "navigator_model_trial_evidence",
  "navigator_safety_evidence",
  "navigator_promotion_evidence_manifests",
  "navigator_review_finding_events",
  "navigator_review_convergence",
] as const;
const KEPT_TABLES = [
  "owners",
  "project_policies",
  "jobs",
  "job_ledger",
  "outbox",
  "approvals",
  "monitors",
  "memories",
  "effects",
] as const;
const GONE_SOURCE = [
  "src/navigator/finding-ledger.ts",
  "src/navigator/finding-ledger-repository.ts",
  "src/capabilities/promotion.ts",
  "src/capabilities/promotion-evidence.ts",
  "src/storage/promotion-evidence-snapshot.ts",
  "src/navigator/promotion.ts",
  "src/navigator/promotion-evidence.ts",
  "src/storage/navigator-promotion-evidence-snapshot.ts",
  "src/services/system-monitors.ts",
] as const;

function fixture(pluginId: string) {
  const { bb } = createFakePluginHost({ pluginId });
  return { bb, db: bb.storage.database(), store: openStore(bb.storage) };
}

function tableNames(db: ReturnType<typeof fixture>["db"]): Set<string> {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

it("appends the drop after every shipped migration", () => {
  expect(ALL_MIGRATIONS.at(-1)).toBe(DEAD_DURABLE_SUBSYSTEM_MIGRATIONS[0]);
  expect(DEAD_DURABLE_SUBSYSTEM_MIGRATIONS[0]).toContain("DROP TABLE");
});

it("leaves a fresh store without the deleted durable subsystems", () => {
  const { db } = fixture("durable-core-schema");
  const names = tableNames(db);
  expect([...GONE_TABLES].filter((name) => names.has(name))).toEqual([]);
  expect([...KEPT_TABLES].filter((name) => !names.has(name))).toEqual([]);
  const memoryColumns = db.prepare("PRAGMA table_info(memories)").all() as { name: string }[];
  expect(memoryColumns.map((column) => column.name)).not.toContain("curated_at");
});

it("does not ship the deleted readers, ledgers, or upkeep schedulers", () => {
  expect(GONE_SOURCE.filter((path) => existsSync(join(ROOT, path)))).toEqual([]);
});

it("does not expose upkeep, decay, receipts, digest, or promotion on a fresh store", () => {
  const { store } = fixture("durable-core-api");
  expect(store).not.toHaveProperty("claimToolReceipt");
  expect(store).not.toHaveProperty("listToolReceipts");
  expect(store).not.toHaveProperty("appendControllerDigest");
  expect(store).not.toHaveProperty("readControllerDigest");
  expect(store).not.toHaveProperty("curateMemories");
  expect(store).not.toHaveProperty("scoreRecalledMemories");
  expect(store).not.toHaveProperty("listRecipeRolloutDecisions");
  expect(store).not.toHaveProperty("appendRecipeRolloutDecision");
  expect(store).not.toHaveProperty("getNavigatorFindingLedgerDecision");
  expect(store).not.toHaveProperty("ensureSystemMonitor");
  expect(store).not.toHaveProperty("listSystemMonitors");
});

it("keeps pairing, policy, jobs, outbox, approvals, monitors, and memories", () => {
  const { store } = fixture("durable-core-kept");
  store.createPairingCode(hashSecret("pair-core"), 1_000, 20_000);
  expect(store.pairOwnerWithCode(hashSecret("pair-core"), "7", "7", 1_001)).toEqual({ ok: true });
  store.upsertProjectPolicy(policyFixture(), 1_002);
  expect(store.getOwner()?.userId).toBe("7");
  expect(store.getProjectPolicy(policyFixture().projectId)?.policy.alias).toBe(policyFixture().alias);
  const remembered = store.rememberMemory({
    scope: "global",
    kind: "preference",
    subject: "ship on mondays",
    body: "Never merge on Friday.",
    source: "owner",
    now: 1_003,
  });
  expect(remembered.subject).toBe("ship on mondays");
  expect(store.getMemory(remembered.id)?.forgottenAt).toBeNull();
});

it("defaults self-maintenance off and ignores the retired upkeep setting", () => {
  const parsed = parseGlobalConfig({
    botToken: "t",
    bbAppBaseUrl: "",
    ...{ systemUpkeep: "enabled" },
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value).not.toHaveProperty("systemUpkeep");
});
