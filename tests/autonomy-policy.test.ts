import { describe, expect, it } from "vitest";
import { projectPolicySchema, type ProjectPolicy } from "../src/domain/models";
import { alternateStrongRoute } from "../src/domain/stage-execution";
import { policyFixture } from "./helpers";

const ROLLBACK = { name: "rollback", command: "./scripts/rollback.sh", timeoutMs: 600_000 };
const REGRESSION = { commands: [{ name: "unit", command: "npm test", timeoutMs: 600_000 }] };

function parse(overrides: Partial<ProjectPolicy>) {
  return projectPolicySchema.safeParse(policyFixture(overrides));
}

function withProduction(rollback: boolean): ProjectPolicy["production"] {
  const production = policyFixture().production;
  if (!production) throw new Error("fixture lost its production policy");
  return rollback ? { ...production, rollbackCommand: ROLLBACK } : production;
}

describe("the autonomy block is opt-in", () => {
  it("leaves a policy that has never heard of it untouched", () => {
    const parsed = parse({});
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.autonomy).toBeUndefined();
  });

  it("defaults both grants to off when the block is present but empty", () => {
    const parsed = projectPolicySchema.safeParse({ ...policyFixture(), autonomy: {} });
    expect(parsed.success && parsed.data.autonomy).toEqual({
      unattendedMerge: false,
      mergeWithoutProduction: false,
    });
  });

  it("leaves the audit allowance absent, so the audits keep only reporting", () => {
    const parsed = projectPolicySchema.safeParse({ ...policyFixture(), autonomy: {} });
    expect(parsed.success && parsed.data.autonomy?.intake).toBeUndefined();
  });

  it("accepts a day's allowance of one to four jobs", () => {
    for (const maxJobsPerDay of [1, 2, 3, 4]) {
      expect(parse({ autonomy: { unattendedMerge: false, mergeWithoutProduction: false, intake: { maxJobsPerDay } } }).success)
        .toBe(true);
    }
  });

  it("refuses an allowance that is not a small whole number of jobs a day", () => {
    // A project that starts more than four pieces of work a day unasked is
    // being run unattended rather than maintained unattended.
    for (const maxJobsPerDay of [0, 5, 40, 1.5, Number.NaN]) {
      expect(parse({ autonomy: { unattendedMerge: false, mergeWithoutProduction: false, intake: { maxJobsPerDay } } }).success)
        .toBe(false);
    }
  });

  it("refuses an allowance carrying a field it does not know", () => {
    expect(projectPolicySchema.safeParse({
      ...policyFixture(),
      autonomy: { intake: { maxJobsPerDay: 2, alsoMergeThem: true } },
    }).success).toBe(false);
  });

  it("refuses a field it does not know", () => {
    const parsed = projectPolicySchema.safeParse({
      ...policyFixture(),
      autonomy: { unattendedMerge: true, mergeEverything: true },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("unattended merging needs a way back", () => {
  it("refuses a project that deploys but cannot roll back", () => {
    const parsed = parse({ production: withProduction(false), autonomy: { unattendedMerge: true } as never });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.path).toEqual(["autonomy", "unattendedMerge"]);
  });

  it("accepts the same project once a rollback command exists", () => {
    expect(parse({
      production: withProduction(true),
      autonomy: { unattendedMerge: true } as never,
    }).success).toBe(true);
  });

  it("asks nothing of a project that deploys nothing", () => {
    expect(parse({
      production: undefined,
      autonomy: { unattendedMerge: true } as never,
    }).success).toBe(true);
  });
});

describe("merging without production needs something else watching", () => {
  it("refuses a project with no required checks", () => {
    const parsed = parse({
      production: undefined,
      regression: REGRESSION,
      requiredChecks: [],
      autonomy: { mergeWithoutProduction: true } as never,
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a project with no scheduled regression run", () => {
    const parsed = parse({
      production: undefined,
      regression: undefined,
      autonomy: { mergeWithoutProduction: true } as never,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a project that has both", () => {
    expect(parse({
      production: undefined,
      regression: REGRESSION,
      requiredChecks: ["unit"],
      autonomy: { mergeWithoutProduction: true } as never,
    }).success).toBe(true);
  });
});

describe("a pinned consensus route is checked against the model catalog", () => {
  function withConsensus(consensusReview: Record<string, unknown>) {
    return parse({ autonomy: { unattendedMerge: false, consensusReview } as never });
  }

  it("accepts a route the catalog offers", () => {
    expect(withConsensus({ providerId: "claude-code", model: "claude-opus-5[1m]" }).success).toBe(true);
  });

  it("refuses a model no provider offers", () => {
    expect(withConsensus({ providerId: "codex", model: "gpt-9-imaginary" }).success).toBe(false);
  });

  it("refuses a provider that does not own the named model", () => {
    expect(withConsensus({ providerId: "codex", model: "claude-opus-5[1m]" }).success).toBe(false);
  });

  it("refuses a provider named without a model, which would pair with someone else's", () => {
    expect(withConsensus({ providerId: "claude-code" }).success).toBe(false);
  });

  it("refuses a fast service tier the provider cannot honour", () => {
    expect(withConsensus({
      providerId: "claude-code",
      model: "claude-opus-5[1m]",
      serviceTier: "fast",
    }).success).toBe(false);
  });
});

describe("a second opinion comes from somewhere else", () => {
  it("never routes back to the provider that already reviewed the change", () => {
    expect(alternateStrongRoute("codex")?.providerId).toBe("claude-code");
    expect(alternateStrongRoute("claude-code")?.providerId).toBe("codex");
  });
});
