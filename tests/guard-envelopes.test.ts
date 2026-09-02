import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  assessGuardEnvelope,
  guardFindingFingerprint,
  guardResultEnvelopeSchema,
  persistGuardEnvelopeSettlement,
  recordGuardFingerprint,
  requiredGuardsForChangeSurface,
  type GuardAssessmentPolicy,
  type GuardResultEnvelope,
} from "../src/capabilities/guards";
import { CAPABILITY_BY_ID, CAPABILITY_GRAPH_DIGEST, CAPABILITY_REGISTRY_DIGEST } from "../src/capabilities/catalog";
import { openStore } from "../src/storage/store";

const HEAD = "a".repeat(40);
const DIFF_DIGEST = "b".repeat(64);
const CLEAN_DIGEST = "c".repeat(64);
const DOCS_DIGEST = "d".repeat(64);
const SUBSTITUTE_DIGEST = "e".repeat(64);

const policy: GuardAssessmentPolicy = {
  profileId: "cap_profile:review-1",
  profileRevision: 1,
  reviewedHeadSha: HEAD,
  diffDigest: DIFF_DIGEST,
  selectedGuards: [
    {
      capabilityId: "clean-code-guard",
      descriptorDigest: CLEAN_DIGEST,
      mandatory: true,
      substitutes: [],
    },
    {
      capabilityId: "docs-guard",
      descriptorDigest: DOCS_DIGEST,
      mandatory: true,
      substitutes: [],
    },
  ],
  requirementIds: ["REQ-1"],
  mustFixRuleIds: ["docs.rule-1"],
  advisoryRuleIds: ["docs.rule-10"],
};

function finding(
  severity: "critical" | "high" | "medium" | "low",
  ruleId: string,
  overrides: Partial<{
    subject: string;
    line: number | null;
    evidence: string;
    evidenceClass: string;
    requirementId: string | null;
  }> = {},
) {
  return {
    ruleId,
    severity,
    subject: "docs/usage.md",
    line: 4,
    evidence: "The documented default does not match the public behavior.",
    evidenceClass: "documentation",
    requirementId: null,
    ...overrides,
  };
}

function envelope(
  overrides: Partial<GuardResultEnvelope> = {},
): GuardResultEnvelope {
  return {
    schemaVersion: 1,
    profileId: policy.profileId,
    profileRevision: policy.profileRevision,
    reviewedHeadSha: HEAD,
    diffDigest: DIFF_DIGEST,
    guards: [
      {
        capabilityId: "clean-code-guard",
        descriptorDigest: CLEAN_DIGEST,
        outcome: "passed",
        findings: [],
      },
      {
        capabilityId: "docs-guard",
        descriptorDigest: DOCS_DIGEST,
        outcome: "passed",
        findings: [],
      },
    ],
    ...overrides,
  };
}

describe("guard result envelopes", () => {
  it("accepts exactly one terminal result per selected guard bound to the exact profile, head, and diff", () => {
    expect(guardResultEnvelopeSchema.parse(envelope())).toEqual(envelope());
    expect(assessGuardEnvelope(envelope(), policy)).toMatchObject({
      outcome: "pass",
      reasons: [],
      findings: [],
    });

    for (const changed of [
      { reviewedHeadSha: "f".repeat(40) },
      { diffDigest: "f".repeat(64) },
      { profileRevision: 2 },
    ]) {
      expect(assessGuardEnvelope(envelope(changed), policy).outcome).toBe("blocked");
    }
  });

  it("rejects missing, extra, duplicate, or digest-mismatched guard results", () => {
    const clean = envelope().guards[0];
    const docs = envelope().guards[1];
    expect(assessGuardEnvelope(envelope({ guards: [clean] }), policy).outcome).toBe("blocked");
    expect(assessGuardEnvelope(envelope({
      guards: [
        clean,
        docs,
        {
          capabilityId: "test-guard",
          descriptorDigest: "f".repeat(64),
          outcome: "passed",
          findings: [],
        },
      ],
    }), policy).outcome).toBe("blocked");
    expect(assessGuardEnvelope(envelope({ guards: [clean, clean] }), policy).outcome).toBe("blocked");
    expect(assessGuardEnvelope(envelope({
      guards: [clean, { ...docs, descriptorDigest: "f".repeat(64) }],
    }), policy).outcome).toBe("blocked");
  });

  it("derives advisory and must-fix dispositions without trusting model prose", () => {
    const clean = envelope().guards[0];
    const docs = envelope().guards[1];

    const advisory = assessGuardEnvelope(envelope({
      guards: [clean, {
        ...docs,
        outcome: "findings",
        findings: [finding("medium", "docs.rule-10")],
      }],
    }), policy);
    expect(advisory.outcome).toBe("pass_with_advisories");
    expect(advisory.findings[0]?.disposition).toBe("advisory");

    const configuredMustFix = assessGuardEnvelope(envelope({
      guards: [clean, {
        ...docs,
        outcome: "findings",
        findings: [finding("low", "docs.rule-1")],
      }],
    }), policy);
    expect(configuredMustFix.outcome).toBe("changes_requested");
    expect(configuredMustFix.findings[0]?.disposition).toBe("must_fix");

    for (const severity of ["critical", "high"] as const) {
      expect(assessGuardEnvelope(envelope({
        guards: [clean, {
          ...docs,
          outcome: "findings",
          findings: [finding(severity, "unregistered.rule")],
        }],
      }), policy).outcome).toBe("changes_requested");
    }

    expect(assessGuardEnvelope(envelope({
      guards: [clean, {
        ...docs,
        outcome: "findings",
        findings: [finding("low", "unregistered.rule", { requirementId: "REQ-1" })],
      }],
    }), policy).outcome).toBe("changes_requested");
  });

  it("blocks failed mandatory guards unless an admitted selected substitute passes", () => {
    const failedDocs = {
      capabilityId: "docs-guard",
      descriptorDigest: DOCS_DIGEST,
      outcome: "failed" as const,
      findings: [],
    };
    expect(assessGuardEnvelope(envelope({
      guards: [envelope().guards[0], failedDocs],
    }), policy).outcome).toBe("blocked");

    const substitutePolicy: GuardAssessmentPolicy = {
      ...policy,
      selectedGuards: [
        policy.selectedGuards[0],
        { ...policy.selectedGuards[1], substitutes: ["docs-contract-guard"] },
        {
          capabilityId: "docs-contract-guard",
          descriptorDigest: SUBSTITUTE_DIGEST,
          mandatory: false,
          substitutes: [],
        },
      ],
    };
    const assessed = assessGuardEnvelope(envelope({
      guards: [
        envelope().guards[0],
        failedDocs,
        {
          capabilityId: "docs-contract-guard",
          descriptorDigest: SUBSTITUTE_DIGEST,
          outcome: "passed",
          findings: [],
        },
      ],
    }), substitutePolicy);
    expect(assessed).toMatchObject({
      outcome: "pass_with_advisories",
      substitutions: [{ capabilityId: "docs-guard", substituteCapabilityId: "docs-contract-guard" }],
    });
  });

  it("fingerprints stable evidence identity while excluding mutable prose", () => {
    const first = guardFindingFingerprint({
      descriptorDigest: DOCS_DIGEST,
      finding: finding("medium", "docs.rule-10", {
        subject: "./docs\\usage.md",
        evidence: "first explanation",
      }),
    });
    const second = guardFindingFingerprint({
      descriptorDigest: DOCS_DIGEST,
      finding: finding("low", "docs.rule-10", {
        subject: "docs/usage.md",
        evidence: "rewritten explanation",
      }),
    });
    expect(first).toBe(second);
  });

  it("allows two remediation occurrences and blocks the third", () => {
    let occurrence = 0;
    const repository = {
      recordGuardFingerprint: () => {
        occurrence += 1;
        return occurrence;
      },
    };
    const input = {
      repository,
      profileId: policy.profileId,
      scopeId: "review-lineage:job-1",
      capabilityId: "docs-guard",
      descriptorDigest: DOCS_DIGEST,
      finding: finding("low", "docs.rule-1"),
      now: 1_000,
    };
    expect(recordGuardFingerprint(input)).toMatchObject({ outcome: "remediate", occurrence: 1 });
    expect(recordGuardFingerprint({ ...input, now: 2_000 })).toMatchObject({ outcome: "remediate", occurrence: 2 });
    expect(recordGuardFingerprint({ ...input, now: 3_000 })).toMatchObject({ outcome: "blocked", occurrence: 3 });
  });

  it("persists terminal receipts and blocks the same finding on cycle three across distinct profiles", () => {
    const { bb } = createFakePluginHost({ pluginId: "guard-lineage-integration" });
    const store = openStore(bb.storage);
    const docsGuard = CAPABILITY_BY_ID.get("docs-guard");
    if (!docsGuard) throw new Error("docs guard descriptor missing");
    const assessmentOutcomes: string[] = [];

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const profile = store.createCapabilityProfile({
        subjectKind: "worker_attempt",
        subjectId: `attempt:review-cycle-${cycle}`,
        threadId: null,
        recipeId: "bounded",
        recipeVersion: 1,
        registryDigest: CAPABILITY_REGISTRY_DIGEST,
        graphDigest: CAPABILITY_GRAPH_DIGEST,
        mode: "active",
        model: { pool: "standard", providerId: "codex", modelId: "model", reasoning: "high", serviceTier: "fast" },
        assignments: [{
          capabilityId: docsGuard.id,
          descriptorDigest: docsGuard.digest,
          capabilityKind: "skill",
          mandatory: true,
        }],
        reasonCodes: [],
        traits: ["docs-changed", "quality-lens"],
        now: cycle * 1_000,
      });
      const cyclePolicy: GuardAssessmentPolicy = {
        ...policy,
        profileId: profile.id,
        profileRevision: profile.revision,
        selectedGuards: [{
          capabilityId: docsGuard.id,
          descriptorDigest: docsGuard.digest,
          mandatory: true,
          substitutes: [],
        }],
      };
      const cycleEnvelope = envelope({
        profileId: profile.id,
        profileRevision: profile.revision,
        guards: [{
          capabilityId: docsGuard.id,
          descriptorDigest: docsGuard.digest,
          outcome: "findings",
          findings: [finding("low", "docs.rule-1")],
        }],
      });
      const settled = persistGuardEnvelopeSettlement({
        repository: store,
        scopeId: "review-lineage:job-1:final",
        envelope: cycleEnvelope,
        policy: cyclePolicy,
        now: cycle * 1_000 + 1,
      });
      assessmentOutcomes.push(settled.outcome);
      expect(store.listCapabilityReceipts(profile.id, 10)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          capabilityId: docsGuard.id,
          eventType: "outcome",
          outcome: "findings",
        }),
      ]));
      if (cycle === 3) {
        expect(persistGuardEnvelopeSettlement({
          repository: store,
          scopeId: "review-lineage:job-1:final",
          envelope: cycleEnvelope,
          policy: cyclePolicy,
          now: cycle * 1_000 + 2,
        }).outcome).toBe("blocked");
      }
    }

    expect(assessmentOutcomes).toEqual(["changes_requested", "changes_requested", "blocked"]);
  });

  it("selects only guards required by the exact project-relative change surface", () => {
    const diff = [
      "diff --git a/src/service.ts b/src/service.ts",
      "+++ b/src/service.ts",
      "diff --git a/tests/service.test.ts b/tests/service.test.ts",
      "+++ b/tests/service.test.ts",
      "diff --git a/docs/usage.md b/docs/usage.md",
      "+++ b/docs/usage.md",
    ].join("\n");
    expect(requiredGuardsForChangeSurface(diff)).toEqual([
      "clean-code-guard",
      "docs-guard",
      "test-guard",
    ]);
    expect(requiredGuardsForChangeSurface("")).toEqual([]);
  });

  it("decodes Git C-quoted UTF-8 paths and rejects malformed quoted headers", () => {
    const quotedDocsDiff = [
      String.raw`diff --git "a/docs/\303\251xample.md" "b/docs/\303\251xample.md"`,
      String.raw`+++ "b/docs/\303\251xample.md"`,
    ].join("\n");
    expect(requiredGuardsForChangeSurface(quotedDocsDiff)).toEqual(["docs-guard"]);
    expect(() => requiredGuardsForChangeSurface(
      String.raw`diff --git "a/tests/broken.test.ts" "b/tests/broken.test.ts`,
    )).toThrow(/quoted|diff|path/i);
  });

  it("parses ordinary unquoted spaces and deleted paths without weakening quote rejection", () => {
    const diff = [
      "diff --git a/docs/my file.md b/docs/my file.md",
      "--- a/docs/my file.md",
      "+++ b/docs/my file.md",
      "diff --git a/tests/old behavior.test.ts b/tests/old behavior.test.ts",
      "--- a/tests/old behavior.test.ts",
      "+++ /dev/null",
    ].join("\n");
    expect(requiredGuardsForChangeSurface(diff)).toEqual(["docs-guard", "test-guard"]);
  });
});
