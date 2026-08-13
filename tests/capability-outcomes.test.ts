import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_GRAPH_DIGEST,
  CAPABILITY_REGISTRY_DIGEST,
} from "../src/capabilities/catalog";
import {
  recordDocumentationCapabilityOutcomes,
  recordImplementationCapabilityOutcomes,
} from "../src/capabilities/outcomes";
import { selectCapabilityProfile } from "../src/capabilities/profiles";
import { openStore } from "../src/storage/store";

function fixture(recipe: "bounded" | "skill-authoring" = "bounded") {
  const { bb } = createFakePluginHost({ pluginId: `capability-outcomes-${recipe}` });
  const store = openStore(bb.storage);
  const selected = selectCapabilityProfile({
    role: "implementation",
    recipe,
    stage: "implementation",
    traits: recipe === "skill-authoring"
      ? ["behavioral-change", "baseline-proven"]
      : ["behavioral-change"],
  });
  const profile = store.createCapabilityProfile({
    subjectKind: "worker_attempt",
    subjectId: `attempt:${recipe}`,
    threadId: null,
    recipeId: recipe,
    recipeVersion: 1,
    registryDigest: CAPABILITY_REGISTRY_DIGEST,
    graphDigest: CAPABILITY_GRAPH_DIGEST,
    mode: "active",
    model: { pool: "standard", providerId: "codex", modelId: "model", reasoning: "high", serviceTier: "fast" },
    assignments: selected.assignments.map((assignment) => ({
      capabilityId: assignment.capabilityId,
      descriptorDigest: assignment.descriptorDigest,
      capabilityKind: "skill",
      mandatory: assignment.mandatory,
    })),
    reasonCodes: [],
    traits: [],
    now: 1_000,
  });
  return { store, profile };
}

describe("mandatory implementation capability outcomes", () => {
  it("binds passing command and changed-test evidence before reporting success", () => {
    const { store, profile } = fixture();
    const result = recordImplementationCapabilityOutcomes({
      store,
      profileId: profile.id,
      handoffSha256: "a".repeat(64),
      diff: [
        "diff --git a/src/feature.ts b/src/feature.ts",
        "+++ b/src/feature.ts",
        "diff --git a/tests/feature.test.ts b/tests/feature.test.ts",
        "+++ b/tests/feature.test.ts",
      ].join("\n"),
      commands: [{
        commandSha256: "b".repeat(64),
        outcome: "pass",
        terminalId: "terminal_1",
      }],
      validationPolicy: { commandSha256s: ["b".repeat(64)] },
      now: 2_000,
    });

    expect(result).toEqual({ satisfied: true, blockingCapabilities: [] });
    expect(store.listSkillReceiptProjection(profile.id, 10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ capabilityId: "test-driven-development", outcome: "passed" }),
      expect.objectContaining({ capabilityId: "verification-before-completion", outcome: "passed" }),
    ]));
    expect(JSON.stringify(store.listCapabilityReceipts(profile.id, 20))).not.toContain("src/feature.ts");
  });

  it("recognizes C-quoted changed test paths as exact TDD evidence", () => {
    const { store, profile } = fixture();
    const result = recordImplementationCapabilityOutcomes({
      store,
      profileId: profile.id,
      handoffSha256: "a".repeat(64),
      diff: [
        "diff --git a/src/feature.ts b/src/feature.ts",
        "+++ b/src/feature.ts",
        String.raw`diff --git "a/tests/\303\251xample.test.ts" "b/tests/\303\251xample.test.ts"`,
        String.raw`+++ "b/tests/\303\251xample.test.ts"`,
      ].join("\n"),
      commands: [{ commandSha256: "b".repeat(64), outcome: "pass" }],
      validationPolicy: { commandSha256s: ["b".repeat(64)] },
      now: 2_000,
    });
    expect(result).toEqual({ satisfied: true, blockingCapabilities: [] });
  });

  it("records bounded terminal failure instead of accepting missing test evidence", () => {
    const { store, profile } = fixture();
    const input = {
      store,
      profileId: profile.id,
      handoffSha256: "a".repeat(64),
      diff: "diff --git a/src/feature.ts b/src/feature.ts\n+++ b/src/feature.ts",
      commands: [{ commandSha256: "b".repeat(64), outcome: "pass" as const, terminalId: "terminal_1" }],
      validationPolicy: { commandSha256s: ["b".repeat(64)] },
      now: 2_000,
    };

    expect(recordImplementationCapabilityOutcomes(input)).toEqual({
      satisfied: false,
      blockingCapabilities: ["test-driven-development"],
    });
    expect(store.listSkillReceiptProjection(profile.id, 10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ capabilityId: "test-driven-development", outcome: "blocked" }),
      expect.objectContaining({ capabilityId: "verification-before-completion", outcome: "passed" }),
    ]));
    expect(recordImplementationCapabilityOutcomes({ ...input, now: 3_000 })).toEqual({
      satisfied: false,
      blockingCapabilities: ["test-driven-development"],
    });
  });

  it("requires an observed skill artifact and verification for writing-skills", () => {
    const { store, profile } = fixture("skill-authoring");
    const result = recordImplementationCapabilityOutcomes({
      store,
      profileId: profile.id,
      handoffSha256: "a".repeat(64),
      diff: "diff --git a/skills/example/SKILL.md b/skills/example/SKILL.md\n+++ b/skills/example/SKILL.md",
      commands: [{ commandSha256: "b".repeat(64), outcome: "fail", terminalId: "terminal_2" }],
      validationPolicy: { commandSha256s: ["b".repeat(64)] },
      now: 2_000,
    });

    expect(result.satisfied).toBe(false);
    expect(result.blockingCapabilities).toEqual([
      "test-driven-development",
      "verification-before-completion",
      "writing-skills",
    ]);
  });

  it("records deterministic skipped verification for an explicitly empty validation policy", () => {
    const { store, profile } = fixture();
    const result = recordImplementationCapabilityOutcomes({
      store,
      profileId: profile.id,
      handoffSha256: "a".repeat(64),
      diff: [
        "diff --git a/src/feature.ts b/src/feature.ts",
        "+++ b/src/feature.ts",
        "diff --git a/tests/feature.test.ts b/tests/feature.test.ts",
        "+++ b/tests/feature.test.ts",
      ].join("\n"),
      commands: [],
      validationPolicy: { commandSha256s: [] },
      now: 2_000,
    });

    expect(result).toEqual({ satisfied: true, blockingCapabilities: [] });
    expect(store.listCapabilityReceipts(profile.id, 20)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        capabilityId: "verification-before-completion",
        eventType: "outcome",
        outcome: "passed",
        reasonCode: "verification_skipped_by_policy",
        evidenceRefs: expect.arrayContaining(["validation:skipped-by-policy"]),
      }),
    ]));
  });
});

describe("mandatory documentation capability outcomes", () => {
  function docsFixture() {
    const { bb } = createFakePluginHost({ pluginId: "capability-docs-outcomes" });
    const store = openStore(bb.storage);
    const selected = selectCapabilityProfile({
      role: "documentation",
      recipe: "bounded",
      stage: "documentation",
      traits: ["strict-json", "docs-changed"],
    });
    const profile = store.createCapabilityProfile({
      subjectKind: "worker_attempt",
      subjectId: "stage:docs",
      threadId: null,
      recipeId: "bounded",
      recipeVersion: 1,
      registryDigest: CAPABILITY_REGISTRY_DIGEST,
      graphDigest: CAPABILITY_GRAPH_DIGEST,
      mode: "active",
      model: { pool: "standard", providerId: "codex", modelId: "model", reasoning: "high", serviceTier: "fast" },
      assignments: selected.assignments.map((assignment) => ({
        capabilityId: assignment.capabilityId,
        descriptorDigest: assignment.descriptorDigest,
        capabilityKind: "skill",
        mandatory: assignment.mandatory,
      })),
      reasonCodes: [],
      traits: ["docs-changed", "strict-json"],
      now: 1_000,
    });
    return { store, profile };
  }

  it("binds a strict changed report to its exact observed diff without persisting prose", () => {
    const { store, profile } = docsFixture();
    const result = recordDocumentationCapabilityOutcomes({
      store,
      profileId: profile.id,
      reportSha256: "c".repeat(64),
      report: {
        disposition: "changed",
        files: ["docs/usage.md"],
        checks: ["markdown check exited 0"],
      },
      observation: {
        clean: false,
        diff: "diff --git a/docs/usage.md b/docs/usage.md\n+++ b/docs/usage.md",
      },
      now: 2_000,
    });

    expect(result).toEqual({ satisfied: true, blockingCapabilities: [] });
    const receipts = store.listCapabilityReceipts(profile.id, 20);
    expect(receipts.filter((receipt) => receipt.eventType === "outcome"))
      .toHaveLength(2);
    expect(JSON.stringify(receipts)).not.toContain("docs/usage.md");
    expect(JSON.stringify(receipts)).not.toContain("markdown check exited 0");
  });

  it("accepts a verified no-op report only with a complete empty observation", () => {
    const { store, profile } = docsFixture();
    expect(recordDocumentationCapabilityOutcomes({
      store,
      profileId: profile.id,
      reportSha256: "c".repeat(64),
      report: { disposition: "skipped", files: [], checks: [] },
      observation: { clean: true, diff: "" },
      now: 2_000,
    })).toEqual({ satisfied: true, blockingCapabilities: [] });
  });
});
