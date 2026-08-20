import { describe, expect, it } from "vitest";
import {
  decideAutoApproval,
  REMEDIATION_ASK_THRESHOLD,
  resolveMergeGrant,
  type MergeAuthorityGrant,
} from "../src/services/merge-authority";
import type { Job } from "../src/domain/models";

const HEAD = "a".repeat(40);

function grant(overrides: Partial<MergeAuthorityGrant> = {}): MergeAuthorityGrant {
  return {
    projectId: "proj_alpha",
    grantedAt: 1_000,
    grantedByUserId: "10",
    grantedByChatId: "20",
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  };
}

type AuthorityJob = Pick<Job, "projectId" | "prHeadSha" | "reviewCycle" | "cancelRequestedAt" | "policy">;

function job(overrides: Partial<AuthorityJob> = {}): AuthorityJob {
  return {
    projectId: "proj_alpha",
    prHeadSha: HEAD,
    reviewCycle: 0,
    cancelRequestedAt: null,
    policy: { production: { deployCommands: [], canaryCommands: [] } } as unknown as Job["policy"],
    ...overrides,
  };
}

describe("standing merge approval", () => {
  it("merges without asking when the project has a live grant", () => {
    expect(decideAutoApproval({ job: job(), grant: grant() })).toEqual({ outcome: "auto_approve" });
  });

  it("asks when there is no grant at all", () => {
    const decision = decideAutoApproval({ job: job(), grant: null });
    expect(decision.outcome).toBe("ask_owner");
  });

  it("asks once the grant has been revoked", () => {
    const decision = decideAutoApproval({
      job: job(),
      grant: grant({ revokedAt: 2_000, revokedReason: "rollback failed after a bad deploy" }),
    });
    expect(decision.outcome).toBe("ask_owner");
  });

  it("refuses to spend one project's grant on another project", () => {
    const decision = decideAutoApproval({
      job: job({ projectId: "proj_beta" }),
      grant: grant({ projectId: "proj_alpha" }),
    });
    expect(decision.outcome).toBe("ask_owner");
  });

  it("asks when the owner has requested the job stop", () => {
    const decision = decideAutoApproval({ job: job({ cancelRequestedAt: 5 }), grant: grant() });
    expect(decision.outcome).toBe("ask_owner");
  });

  it("asks when the pull-request head is not established", () => {
    const decision = decideAutoApproval({ job: job({ prHeadSha: null }), grant: grant() });
    expect(decision.outcome).toBe("ask_owner");
  });

  it("asks when the project has no production configuration", () => {
    const decision = decideAutoApproval({ job: job({ policy: null }), grant: grant() });
    expect(decision.outcome).toBe("ask_owner");
  });

  it("still merges a change that needed one round of review fixes", () => {
    const decision = decideAutoApproval({ job: job({ reviewCycle: 1 }), grant: grant() });
    expect(decision).toEqual({ outcome: "auto_approve" });
  });

  it("asks about a change that fought its own review twice", () => {
    const decision = decideAutoApproval({
      job: job({ reviewCycle: REMEDIATION_ASK_THRESHOLD }),
      grant: grant(),
    });
    expect(decision.outcome).toBe("ask_owner");
    expect(decision).toMatchObject({ reason: expect.stringContaining("rounds of review fixes") });
  });
});

function policyGrantJob(autonomy: Record<string, unknown>, overrides: Partial<AuthorityJob> = {}) {
  return job({
    policy: {
      production: { deployCommands: [], canaryCommands: [] },
      autonomy,
    } as unknown as Job["policy"],
    ...overrides,
  });
}

describe("a project policy can carry the grant instead", () => {
  it("merges without asking when the job's own policy snapshot says so", () => {
    expect(decideAutoApproval({
      job: policyGrantJob({ unattendedMerge: true }),
      grant: null,
    })).toEqual({ outcome: "auto_approve" });
  });

  it("asks when the policy leaves unattended merging off", () => {
    const decision = decideAutoApproval({
      job: policyGrantJob({ unattendedMerge: false }),
      grant: null,
    });
    expect(decision.outcome).toBe("ask_owner");
  });

  it("goes quiet once the owner withdraws it, even though the policy still says so", () => {
    const decision = decideAutoApproval({
      job: policyGrantJob({ unattendedMerge: true }),
      grant: null,
      revokedAt: 5_000,
      policyStoredAt: 1_000,
    });
    expect(decision.outcome).toBe("ask_owner");
  });

  it("counts again once the owner enables the project after withdrawing it", () => {
    expect(decideAutoApproval({
      job: policyGrantJob({ unattendedMerge: true }),
      grant: null,
      revokedAt: 5_000,
      policyStoredAt: 6_000,
    })).toEqual({ outcome: "auto_approve" });
  });

  it("stays withdrawn when the policy was stored at the very moment of withdrawal", () => {
    const decision = decideAutoApproval({
      job: policyGrantJob({ unattendedMerge: true }),
      grant: null,
      revokedAt: 5_000,
      policyStoredAt: 5_000,
    });
    expect(decision.outcome).toBe("ask_owner");
  });

  it("leaves a re-granted button approval alone, whatever the log remembers", () => {
    expect(decideAutoApproval({
      job: job(),
      grant: grant({ grantedAt: 9_000 }),
      revokedAt: 5_000,
      policyStoredAt: null,
    })).toEqual({ outcome: "auto_approve" });
  });
});

describe("the owner can tell the two grants apart", () => {
  const evidence = { grant: null, revokedAt: null, policyStoredAt: null };

  it("names the button as the source of a granted approval", () => {
    expect(resolveMergeGrant({
      projectId: "proj_alpha",
      policy: null,
      evidence: { ...evidence, grant: grant() },
    })).toEqual({ source: "button" });
  });

  it("names the policy as the source when only the policy asks for it", () => {
    expect(resolveMergeGrant({
      projectId: "proj_alpha",
      policy: { autonomy: { unattendedMerge: true, mergeWithoutProduction: false } },
      evidence,
    })).toEqual({ source: "policy" });
  });

  it("prefers the button when the owner granted one as well", () => {
    expect(resolveMergeGrant({
      projectId: "proj_alpha",
      policy: { autonomy: { unattendedMerge: true, mergeWithoutProduction: false } },
      evidence: { ...evidence, grant: grant() },
    })).toEqual({ source: "button" });
  });

  it("finds no grant at all for a project with neither", () => {
    expect(resolveMergeGrant({ projectId: "proj_alpha", policy: null, evidence })).toBeNull();
  });
});

describe("merging a project that deploys nothing", () => {
  it("asks by default, because nothing would carry the change anywhere", () => {
    const decision = decideAutoApproval({
      job: job({ policy: { autonomy: { unattendedMerge: true } } as unknown as Job["policy"] }),
      grant: null,
    });
    expect(decision).toMatchObject({ reason: "the project has no production configuration" });
  });

  it("stops asking for a project whose policy opted into exactly that", () => {
    expect(decideAutoApproval({
      job: job({
        policy: {
          autonomy: { unattendedMerge: true, mergeWithoutProduction: true },
        } as unknown as Job["policy"],
      }),
      grant: null,
    })).toEqual({ outcome: "auto_approve" });
  });
});

describe("a change that argued with its own review twice", () => {
  const twoRounds = () => job({ reviewCycle: REMEDIATION_ASK_THRESHOLD });
  const consensus = (overrides: Partial<{
    requested: boolean;
    assessment: "pending" | "pass" | "not_pass";
    routeAvailable: boolean;
  }> = {}) => ({
    requested: false,
    assessment: "pending" as const,
    routeAvailable: true,
    ...overrides,
  });

  it("asks for a second opinion instead of asking the owner straight away", () => {
    expect(decideAutoApproval({ job: twoRounds(), grant: grant(), consensus: consensus() }))
      .toEqual({ outcome: "start_consensus" });
  });

  it("asks for at most one second opinion per head", () => {
    expect(decideAutoApproval({
      job: twoRounds(),
      grant: grant(),
      consensus: consensus({ requested: true }),
    })).toEqual({ outcome: "await_consensus" });
  });

  it("merges when the second opinion passed the exact head with nothing to say", () => {
    expect(decideAutoApproval({
      job: twoRounds(),
      grant: grant(),
      consensus: consensus({ requested: true, assessment: "pass" }),
    })).toEqual({ outcome: "auto_approve" });
  });

  it("asks the owner when the second opinion found anything at all", () => {
    const decision = decideAutoApproval({
      job: twoRounds(),
      grant: grant(),
      consensus: consensus({ requested: true, assessment: "not_pass" }),
    });
    expect(decision.outcome).toBe("ask_owner");
    expect(decision).toMatchObject({ reason: expect.stringContaining("did not clear it") });
  });

  it("asks the owner when there is no independent route to review on", () => {
    const decision = decideAutoApproval({
      job: twoRounds(),
      grant: grant(),
      consensus: consensus({ routeAvailable: false }),
    });
    expect(decision.outcome).toBe("ask_owner");
    expect(decision).toMatchObject({ reason: expect.stringContaining("rounds of review fixes") });
  });

  it("asks the owner when no consensus evidence was supplied at all", () => {
    expect(decideAutoApproval({ job: twoRounds(), grant: grant() }).outcome).toBe("ask_owner");
  });

  it("never starts a second opinion for a job with no live grant", () => {
    expect(decideAutoApproval({ job: twoRounds(), grant: null, consensus: consensus() }).outcome)
      .toBe("ask_owner");
  });

  it("never starts a second opinion for a job the owner asked to stop", () => {
    expect(decideAutoApproval({
      job: job({ reviewCycle: REMEDIATION_ASK_THRESHOLD, cancelRequestedAt: 5 }),
      grant: grant(),
      consensus: consensus(),
    }).outcome).toBe("ask_owner");
  });

  it("leaves an ordinary change alone: one round of fixes still merges directly", () => {
    expect(decideAutoApproval({ job: job({ reviewCycle: 1 }), grant: grant(), consensus: consensus() }))
      .toEqual({ outcome: "auto_approve" });
  });
});
