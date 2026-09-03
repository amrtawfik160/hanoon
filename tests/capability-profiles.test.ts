import { describe, expect, it } from "vitest";
import {
  capabilityProfileDigest,
  resolvePersistedWorkerProfile,
  selectCapabilityProfile,
} from "../src/capabilities/profiles";

describe("least-capability worker profiles", () => {
  it("selects diagnosis before regression testing for a bug implementation", () => {
    const profile = selectCapabilityProfile({
      role: "implementation",
      recipe: "bug",
      stage: "implementation",
      traits: ["unexpected-behavior", "behavioral-change"],
    });

    expect(profile.skills).toEqual([
      "systematic-debugging",
      "test-driven-development",
      "verification-before-completion",
    ]);
    expect(profile.assignments.every((assignment) => assignment.route === "worker")).toBe(true);
  });

  it.each([
    ["direct", "implementation", "implementation", [], ["verification-before-completion"]],
    ["bounded", "implementation", "implementation", ["behavioral-change"], ["test-driven-development", "verification-before-completion"]],
    ["architectural", "planner", "planning", ["approved-spec"], ["writing-plans"]],
    ["architectural", "planner", "discovery", ["needs-discovery"], ["brainstorming"]],
    ["adopted-pr", "review", "review", ["code-changed"], ["clean-code-guard"]],
  ] as const)("selects the %s/%s minimum", (recipe, role, stage, traits, skills) => {
    expect(selectCapabilityProfile({
      role,
      recipe,
      stage,
      traits,
    }).skills).toEqual(skills);
  });

  it("treats a completed grilling session as discovery approval and excludes brainstorming", () => {
    const profile = selectCapabilityProfile({
      role: "planner",
      recipe: "architectural",
      stage: "discovery",
      traits: ["needs-discovery", "grilled", "approved-spec"],
      requestedCapabilities: ["brainstorming"],
    });

    expect(profile.skills).not.toContain("brainstorming");
    expect(profile.denied).toContainEqual({ capabilityId: "brainstorming", reasonCode: "completed_grill" });
  });

  it("requires baseline evidence and TDD before writing-skills", () => {
    const denied = selectCapabilityProfile({
      role: "implementation",
      recipe: "skill-authoring",
      stage: "implementation",
      traits: ["behavioral-change"],
    });
    expect(denied.skills).not.toContain("writing-skills");
    expect(denied.denied).toContainEqual({
      capabilityId: "writing-skills",
      reasonCode: "baseline_evidence_missing",
    });

    const selected = selectCapabilityProfile({
      role: "implementation",
      recipe: "skill-authoring",
      stage: "implementation",
      traits: ["behavioral-change", "baseline-proven"],
    });
    expect(selected.skills).toEqual([
      "test-driven-development",
      "writing-skills",
      "verification-before-completion",
    ]);
  });

  it("activates receiving-code-review only for remediation", () => {
    const implementation = selectCapabilityProfile({
      role: "implementation",
      recipe: "bounded",
      stage: "implementation",
      traits: ["behavioral-change"],
    });
    const remediation = selectCapabilityProfile({
      role: "implementation",
      recipe: "bounded",
      stage: "remediation",
      traits: ["behavioral-change", "review-findings"],
    });
    expect(implementation.skills).not.toContain("receiving-code-review");
    expect(remediation.skills).toContain("receiving-code-review");
  });

  it("selects guards only from the exact changed surface and keeps strict roles communication-free", () => {
    const profile = selectCapabilityProfile({
      role: "final-review",
      recipe: "architectural",
      stage: "integrated-review",
      traits: ["strict-json", "code-changed", "docs-changed"],
    });
    expect(profile.skills).toEqual(["clean-code-guard", "docs-guard"]);
    expect(profile.skills).not.toContain("test-guard");
    expect(profile.skills).not.toContain("unslop");
  });

  it("keeps the independent risk lens free of duplicate diff guards", () => {
    const profile = selectCapabilityProfile({
      role: "review",
      recipe: "bounded",
      stage: "review",
      traits: ["strict-json", "risk-lens", "code-changed", "tests-changed", "docs-changed"],
    });
    expect(profile.skills).toEqual([]);
  });

  it("runs documentation verification only when change-surface triage selected documentation", () => {
    expect(selectCapabilityProfile({
      role: "documentation",
      recipe: "bounded",
      stage: "documentation",
      traits: ["docs-changed"],
    }).skills).toEqual(["docs-guard", "verification-before-completion"]);
  });

  // Delivery metadata is deterministic on recipe-v1: the skill that once wrote
  // it is no longer bundled, and the frozen catalog cannot gain a replacement.
  it("verifies a settled nontrivial diff without selecting a writing skill", () => {
    expect(selectCapabilityProfile({
      role: "implementation",
      recipe: "bounded",
      stage: "delivery",
      traits: ["nontrivial-diff"],
    }).skills).toEqual(["verification-before-completion"]);
  });

  it("never injects raw orchestration or manual-only skills into workers", () => {
    const profile = selectCapabilityProfile({
      role: "implementation",
      recipe: "architectural",
      stage: "implementation",
      traits: ["behavioral-change"],
      requestedCapabilities: [
        "executing-plans",
        "subagent-driven-development",
        "grill-with-docs",
      ],
    });
    expect(profile.skills).not.toEqual(expect.arrayContaining([
      "executing-plans",
      "subagent-driven-development",
      "grill-with-docs",
    ]));
    expect(profile.denied).toEqual(expect.arrayContaining([
      { capabilityId: "executing-plans", reasonCode: "route_not_worker" },
      { capabilityId: "subagent-driven-development", reasonCode: "route_not_worker" },
      { capabilityId: "grill-with-docs", reasonCode: "route_not_worker" },
    ]));
  });

  it("permits a strict worker to have an intentionally empty profile", () => {
    const profile = selectCapabilityProfile({
      role: "critic",
      recipe: "architectural",
      stage: "planning",
      traits: ["strict-json", "approved-spec"],
    });

    expect(profile.skills).toEqual([]);
    expect(profile.assignments).toEqual([]);
    expect(profile.digest).toBe(capabilityProfileDigest([]));
  });

  it("hashes assignment identity canonically rather than by caller order", () => {
    const assignments = selectCapabilityProfile({
      role: "implementation",
      recipe: "bug",
      stage: "implementation",
      traits: ["unexpected-behavior", "behavioral-change"],
    }).assignments;

    expect(capabilityProfileDigest(assignments)).toBe(capabilityProfileDigest([...assignments].reverse()));
  });
});

describe("persisted worker profile resolution", () => {
  const selected = selectCapabilityProfile({
    role: "implementation",
    recipe: "bug",
    stage: "implementation",
    traits: ["unexpected-behavior", "behavioral-change"],
  });
  const persisted = {
    profileId: "cap_profile:1",
    revision: 2,
    recipeVersion: 1,
    role: "implementation" as const,
    jobId: "job_1",
    attemptId: "attempt:job_1:1:spawn_implementation",
    projectId: "project_1",
    environmentId: "environment_1",
    threadId: null,
    assignments: selected.assignments,
  };

  it("returns only an exact persisted profile with current descriptor digests", () => {
    expect(resolvePersistedWorkerProfile({
      persisted,
      expected: {
        profileId: "cap_profile:1",
        revision: 2,
        recipeVersion: 1,
        role: "implementation",
        jobId: "job_1",
        attemptId: "attempt:job_1:1:spawn_implementation",
        projectId: "project_1",
        environmentId: "environment_1",
        threadId: null,
      },
    })?.skills).toEqual(selected.skills);
  });

  it.each([
    ["profileId", "cap_profile:other"],
    ["revision", 3],
    ["recipeVersion", 2],
    ["role", "review"],
    ["attemptId", "attempt:other"],
    ["threadId", "thread_other"],
  ] as const)("fails closed on a mismatched %s", (field, value) => {
    expect(resolvePersistedWorkerProfile({
      persisted,
      expected: { ...persisted, [field]: value },
    })).toBeNull();
  });

  it("fails closed when an assignment digest was changed", () => {
    expect(resolvePersistedWorkerProfile({
      persisted: {
        ...persisted,
        assignments: [{ ...persisted.assignments[0], descriptorDigest: "0".repeat(64) }],
      },
      expected: persisted,
    })).toBeNull();
  });
});
