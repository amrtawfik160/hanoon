import { describe, expect, it } from "vitest";
import { assessConsensusReview, assessReviewGroup, requiredReviewLenses } from "../src/domain/review-lenses";

const HEAD = "a".repeat(40);
const DIFF_DIGEST = "b".repeat(64);
const GUARD_DIGEST = "c".repeat(64);

function result(
  outcome: "pass" | "changes_requested" | "blocked",
  options: { reasons?: string[]; findings?: Array<Record<string, unknown>> } = {},
): string {
  const findings = options.findings ?? [];
  const checks = outcome === "blocked"
    ? [{ name: "security", command: null, outcome: "blocked", exitCode: null, summary: "needs credentials" }]
    : [];
  return JSON.stringify({
    outcome,
    reasons: options.reasons ?? (outcome === "pass" ? [] : [`${outcome} reason`]),
    findings,
    reviewedHeadSha: HEAD,
    verdict: {
      verdict: outcome === "pass" ? "pass" : outcome,
      reviewedHeadSha: HEAD,
      summary: `${outcome} summary`,
      findings,
      checks,
    },
  });
}

function attempt(lens: "quality" | "risk", resultJson: string | null) {
  return {
    id: `attempt_${lens}`,
    reviewLens: lens,
    headSha: HEAD,
    resultJson,
  } as const;
}

describe("review lens groups", () => {
  it("recomputes persisted per-guard disposition and carries advisories without opening a retry loop", () => {
    const policy = {
      profileId: "cap_profile:lens-quality",
      profileRevision: 1,
      reviewedHeadSha: HEAD,
      diffDigest: DIFF_DIGEST,
      selectedGuards: [{
        capabilityId: "docs-guard",
        descriptorDigest: GUARD_DIGEST,
        mandatory: true,
        substitutes: [],
      }],
      requirementIds: [],
      mustFixRuleIds: ["docs.rule-1"],
      advisoryRuleIds: ["docs.rule-10"],
    };
    const guardResult = (ruleId: string, outcome: "pass" | "changes_requested") => JSON.stringify({
      outcome,
      reasons: [],
      findings: [],
      reviewedHeadSha: HEAD,
      guardPolicy: policy,
      guardEnvelope: {
        schemaVersion: 1,
        profileId: policy.profileId,
        profileRevision: 1,
        reviewedHeadSha: HEAD,
        diffDigest: DIFF_DIGEST,
        guards: [{
          capabilityId: "docs-guard",
          descriptorDigest: GUARD_DIGEST,
          outcome: "findings",
          findings: [{
            ruleId,
            severity: "low",
            subject: "docs/usage.md",
            line: 3,
            evidence: "Bounded evidence",
            evidenceClass: "documentation",
            requirementId: null,
          }],
        }],
      },
      // Stored projection is non-authoritative; the group gate recomputes it.
      guardAssessment: { outcome: "pass", reasons: [], findings: [], substitutions: [] },
    });

    const advisory = assessReviewGroup([
      attempt("quality", guardResult("docs.rule-10", "pass")),
    ], "small_fix", HEAD);
    expect(advisory.outcome).toBe("pass");
    expect(advisory.findings).toHaveLength(1);
    expect(advisory.summary).toContain("pass_with_advisories");

    expect(assessReviewGroup([
      attempt("quality", guardResult("docs.rule-1", "changes_requested")),
    ], "small_fix", HEAD).outcome).toBe("changes_requested");
    expect(assessReviewGroup([
      attempt("quality", guardResult("docs.rule-1", "pass")),
    ], "small_fix", HEAD).outcome).toBe("blocked");
  });

  it("requires one lens for small fixes and two for full jobs", () => {
    expect(requiredReviewLenses("small_fix")).toEqual(["quality"]);
    expect(requiredReviewLenses("full")).toEqual(["quality", "risk"]);
  });

  it("does not pass a full review until both lenses strictly pass", () => {
    expect(assessReviewGroup([attempt("quality", result("pass"))], "full", HEAD)).toEqual({
      outcome: "pending",
      attemptIds: ["attempt_quality"],
      findings: [],
      reasons: [],
      summary: null,
    });
    expect(assessReviewGroup([
      attempt("quality", result("pass")),
      attempt("risk", null),
    ], "full", HEAD).outcome).toBe("pending");
    expect(assessReviewGroup([
      attempt("risk", result("pass")),
      attempt("quality", result("pass")),
    ], "full", HEAD)).toEqual({
      outcome: "pass",
      attemptIds: ["attempt_quality", "attempt_risk"],
      findings: [],
      reasons: [],
      summary: "quality: pass summary; risk: pass summary",
    });
  });

  it("waits for all lenses, then combines requested changes", () => {
    const finding = {
      severity: "high",
      file: "src/auth.ts",
      line: 9,
      title: "Missing authorization",
      details: "The operation does not verify the owner.",
    };
    expect(assessReviewGroup([
      attempt("quality", result("changes_requested", { findings: [finding] })),
      attempt("risk", null),
    ], "full", HEAD).outcome).toBe("pending");

    const settled = assessReviewGroup([
      attempt("quality", result("changes_requested", { findings: [finding] })),
      attempt("risk", result("pass")),
    ], "full", HEAD);
    expect(settled.outcome).toBe("changes_requested");
    expect(settled.findings).toEqual([finding]);
    expect(settled.reasons).toEqual(["quality: changes_requested reason"]);
  });

  it("never accepts a consensus lens as a member of a required group", () => {
    expect(requiredReviewLenses("full")).not.toContain("consensus");
    expect(assessReviewGroup([
      attempt("quality", result("pass")),
      { ...attempt("quality", result("pass")), id: "attempt_consensus", reviewLens: "consensus" as const },
    ], "small_fix", HEAD).outcome).toBe("blocked");
  });

  it("blocks malformed, mismatched-head, duplicate, or blocked lens evidence", () => {
    expect(assessReviewGroup([
      attempt("quality", result("pass")),
      { ...attempt("risk", result("pass")), headSha: "b".repeat(40) },
    ], "full", HEAD).outcome).toBe("blocked");
    expect(assessReviewGroup([
      attempt("quality", result("pass")),
      attempt("risk", "not json"),
    ], "full", HEAD).outcome).toBe("blocked");
    expect(assessReviewGroup([
      attempt("quality", result("pass")),
      attempt("quality", result("pass")),
      attempt("risk", result("pass")),
    ], "full", HEAD).outcome).toBe("blocked");
    expect(assessReviewGroup([
      attempt("quality", result("pass")),
      attempt("risk", result("blocked")),
    ], "full", HEAD).outcome).toBe("blocked");
  });
});

describe("the consensus pass that stands in for the owner's look", () => {
  function consensus(resultJson: string | null, headSha = HEAD) {
    return { id: "attempt_consensus", reviewLens: "consensus" as const, headSha, resultJson };
  }

  it("is pending until it is spawned and until it settles", () => {
    expect(assessConsensusReview(null, HEAD)).toBe("pending");
    expect(assessConsensusReview(consensus(null), HEAD)).toBe("pending");
  });

  it("clears the merge only on a clean pass of the exact head", () => {
    expect(assessConsensusReview(consensus(result("pass")), HEAD)).toBe("pass");
  });

  it("refuses a pass that still found something", () => {
    const finding = {
      severity: "low",
      file: "src/auth.ts",
      line: 9,
      title: "Nit",
      details: "A small thing a person should see.",
    };
    expect(assessConsensusReview(consensus(result("pass", { findings: [finding] })), HEAD)).toBe("not_pass");
  });

  it("refuses changes requested, a block, and unreadable evidence", () => {
    expect(assessConsensusReview(consensus(result("changes_requested")), HEAD)).toBe("not_pass");
    expect(assessConsensusReview(consensus(result("blocked")), HEAD)).toBe("not_pass");
    expect(assessConsensusReview(consensus("not json"), HEAD)).toBe("not_pass");
  });

  it("refuses evidence about a head that has since moved", () => {
    expect(assessConsensusReview(consensus(result("pass"), "b".repeat(40)), HEAD)).toBe("not_pass");
  });

  it("ignores an attempt that is not a consensus pass at all", () => {
    expect(assessConsensusReview(attempt("quality", result("pass")), HEAD)).toBe("pending");
  });
});
