import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { DurableNavigatorPromotionEvidenceReader } from "../src/navigator/promotion-evidence";
import {
  NavigatorPromotionIncompleteError,
  NavigatorPromotionService,
} from "../src/navigator/promotion";
import { openStore } from "../src/storage/store";
import { insertResolvedNavigatorPromotionLedger } from "./support/navigator-promotion-ledger";

describe("navigator promotion evidence ledger", () => {
  it("refuses promotion until a reviewed durable manifest is bound", async () => {
    const { bb } = createFakePluginHost({ pluginId: "navigator-promotion-evidence-empty" });
    const store = openStore(bb.storage);
    const promotions = new NavigatorPromotionService({
      store,
      readEvidence: () => new DurableNavigatorPromotionEvidenceReader(store).read(),
      now: () => 4_000,
    });
    await expect(promotions.promote()).rejects.toBeInstanceOf(NavigatorPromotionIncompleteError);
    expect(store.getLatestWorkflowEngineRolloutDecision()).toBeNull();
  });

  it("promotes only after the durable reader resolves a reviewed complete envelope", async () => {
    const { bb } = createFakePluginHost({ pluginId: "navigator-promotion-evidence-complete" });
    const store = openStore(bb.storage);
    insertResolvedNavigatorPromotionLedger({
      store,
      db: bb.storage.database(),
      reviewed: true,
      prefix: "evidence-complete",
    });
    const promotions = new NavigatorPromotionService({
      store,
      readEvidence: () => new DurableNavigatorPromotionEvidenceReader(store).read(),
      now: () => 4_001,
    });
    const decision = await promotions.promote();
    expect(decision).toMatchObject({
      engine: "navigator-v1",
      action: "promote",
      reasonCode: "promotion_gates_passed",
    });
    expect(decision.evidenceDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("refuses an unreviewed complete ledger and conflicts a changed deterministic record", async () => {
    const { bb } = createFakePluginHost({ pluginId: "navigator-promotion-evidence-unreviewed" });
    const store = openStore(bb.storage);
    insertResolvedNavigatorPromotionLedger({
      store,
      db: bb.storage.database(),
      reviewed: false,
      prefix: "evidence-unreviewed",
    });
    const promotions = new NavigatorPromotionService({
      store,
      readEvidence: () => new DurableNavigatorPromotionEvidenceReader(store).read(),
      now: () => 4_002,
    });
    await expect(promotions.promote()).rejects.toMatchObject({
      assessment: { status: "incomplete", reasonCodes: expect.arrayContaining(["evidence_not_reviewed"]) },
    });

    const { bb: conflictHost } = createFakePluginHost({ pluginId: "navigator-promotion-evidence-conflict" });
    const conflictStore = openStore(conflictHost.storage);
    conflictStore.recordNavigatorDeterministicEvidence({
      category: "restart",
      suiteId: "suite-restart",
      runId: "deterministic-restart-1",
      artifactDigest: "a".repeat(64),
      outcome: "passed",
      now: 5_000,
    });
    expect(() => conflictStore.recordNavigatorDeterministicEvidence({
      category: "restart",
      suiteId: "suite-restart",
      runId: "deterministic-restart-2",
      artifactDigest: "b".repeat(64),
      outcome: "failed",
      now: 5_001,
    })).toThrow(/conflicts with its durable identity/u);
  });
});
