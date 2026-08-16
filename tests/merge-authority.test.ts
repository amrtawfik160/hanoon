import { describe, expect, it } from "vitest";
import { decideAutoApproval, REMEDIATION_ASK_THRESHOLD, type MergeAuthorityGrant } from "../src/services/merge-authority";
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
