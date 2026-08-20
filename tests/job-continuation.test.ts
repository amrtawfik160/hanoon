import { expect, it } from "vitest";
import {
  MAX_AUTO_CONTINUES,
  continuationKey,
  planJobContinuation,
  type ContinuationJob,
} from "../src/autonomy/job-continuation";
import { PRODUCTION_NOT_CONFIGURED, type ProjectPolicy } from "../src/domain/models";

const POLICY = {
  version: 1,
  mergeMethod: "squash",
  maxReviewCycles: 3,
} as unknown as ProjectPolicy;

function blockedJob(overrides: Partial<ContinuationJob> = {}): ContinuationJob {
  return {
    projectId: "proj_1",
    state: "blocked",
    blockedReason: null,
    resumeState: null,
    lastError: null,
    prNumber: null,
    reviewCycle: 0,
    implementationThreadId: null,
    cancelRequestedAt: null,
    policy: POLICY,
    deliveryMode: "full",
    ...overrides,
  };
}

/** The 11 jobs killed by a dead-lettered effect: the largest bucket by far. */
it("retries a job killed by a dead-lettered effect", () => {
  expect(planJobContinuation({
    job: blockedJob({ blockedReason: "permanent_effect_failure", resumeState: "implementing" }),
    attempts: 0,
  })).toEqual({ action: "resume", event: "RETRY" });
});

it("continues a job that gave up after its plan critique limit", () => {
  expect(planJobContinuation({
    job: blockedJob({ blockedReason: "plan_limit" }),
    attempts: 0,
  })).toEqual({ action: "resume", event: "CONTINUE_REVIEW" });
});

it("continues a job that gave up after its review limit", () => {
  expect(planJobContinuation({
    job: blockedJob({ blockedReason: "review_limit", prNumber: 866, reviewCycle: 3 }),
    attempts: 0,
  })).toEqual({ action: "resume", event: "CONTINUE_REVIEW" });
});

it("closes out a reviewed PR that only lacks production settings", () => {
  // Finished work, not a stuck job — and it must not be read as a
  // configuration escalation, which would ask the owner for nothing.
  expect(planJobContinuation({
    job: blockedJob({
      blockedReason: "configuration",
      lastError: PRODUCTION_NOT_CONFIGURED,
      prNumber: 868,
      policy: { ...POLICY, production: undefined },
    }),
    attempts: 0,
  })).toEqual({ action: "resume", event: "CONTINUE_REVIEW" });
});

it("escalates once the ladder is spent rather than resuming forever", () => {
  const job = blockedJob({ blockedReason: "permanent_effect_failure", resumeState: "implementing" });
  expect(planJobContinuation({ job, attempts: MAX_AUTO_CONTINUES - 1 }).action).toBe("resume");
  expect(planJobContinuation({ job, attempts: MAX_AUTO_CONTINUES }).action).toBe("escalate");
});

it("escalates a real configuration gap instead of retrying what it cannot change", () => {
  const decision = planJobContinuation({
    job: blockedJob({ blockedReason: "configuration", lastError: "Repository is not connected" }),
    attempts: 0,
  });
  expect(decision.action).toBe("escalate");
});

it("names an unresumable block for what it is, not for an unspent ladder", () => {
  // attempts is 0, so an order that checked the ladder first would resume a
  // job the state machine would then reject as an illegal transition.
  const decision = planJobContinuation({
    job: blockedJob({ blockedReason: "permanent_effect_failure", resumeState: "awaiting_project" }),
    attempts: 0,
  });
  expect(decision).toEqual({
    action: "escalate",
    reason: "This job stopped somewhere I have no way to resume from.",
  });
});

it("holds a job the owner asked to cancel", () => {
  expect(planJobContinuation({
    job: blockedJob({
      blockedReason: "permanent_effect_failure",
      resumeState: "implementing",
      cancelRequestedAt: 1_700_000_000_000,
    }),
    attempts: 0,
  })).toEqual({ action: "hold" });
});

it("holds an unconfirmed cancellation, which exists to reach the owner", () => {
  expect(planJobContinuation({
    job: blockedJob({ blockedReason: "cancellation_unconfirmed" }),
    attempts: 0,
  })).toEqual({ action: "hold" });
});

it.each([
  "awaiting_merge_approval",
  "merging",
  "deploying",
  "verifying_production",
] as const)("never automatically re-drives the owner-gated %s stage", (resumeState) => {
  expect(planJobContinuation({
    job: blockedJob({
      state: "failed",
      blockedReason: "permanent_effect_failure",
      resumeState,
    }),
    attempts: 0,
  })).toEqual({ action: "hold" });
});

it.each([
  "awaiting_merge_approval",
  "merging",
  "deploying",
  "verifying_production",
] as const)("re-drives the %s stage when the project may merge unattended", (resumeState) => {
  // Resuming re-fires that stage's own guarded effect, so the gates and the
  // auto-approval decision run again. The sweep cannot approve anything.
  expect(planJobContinuation({
    job: blockedJob({
      state: "failed",
      blockedReason: "permanent_effect_failure",
      resumeState,
    }),
    attempts: 0,
    hasLiveMergeGrant: true,
  })).toEqual({ action: "resume", event: "RETRY" });
});

it("holds a merge stage the owner asked to stop, grant or no grant", () => {
  expect(planJobContinuation({
    job: blockedJob({
      state: "failed",
      blockedReason: "permanent_effect_failure",
      resumeState: "merging",
      cancelRequestedAt: 1_700_000_000_000,
    }),
    attempts: 0,
    hasLiveMergeGrant: true,
  })).toEqual({ action: "hold" });
});

it("keeps the ladder bounded on a merge stage it is allowed to re-drive", () => {
  expect(planJobContinuation({
    job: blockedJob({
      state: "failed",
      blockedReason: "permanent_effect_failure",
      resumeState: "merging",
    }),
    attempts: MAX_AUTO_CONTINUES,
    hasLiveMergeGrant: true,
  })).toMatchObject({ action: "escalate" });
});

it("holds any job that is not blocked", () => {
  expect(planJobContinuation({
    job: blockedJob({ state: "implementing" }),
    attempts: 0,
  })).toEqual({ action: "hold" });
});

it("rejects a nonsensical attempt count rather than guessing", () => {
  const job = blockedJob({ blockedReason: "plan_limit" });
  expect(() => planJobContinuation({ job, attempts: -1 })).toThrow(TypeError);
  expect(() => planJobContinuation({ job, attempts: 1.5 })).toThrow(TypeError);
});

it("counts attempts per block, so a job blocking somewhere new starts fresh", () => {
  const planning = continuationKey({ state: "blocked", blockedReason: "plan_limit", resumeState: null });
  const reviewing = continuationKey({ state: "blocked", blockedReason: "review_limit", resumeState: "reviewing" });
  expect(planning).not.toBe(reviewing);
  expect(continuationKey({ state: "blocked", blockedReason: "plan_limit", resumeState: null })).toBe(planning);
});

it("retries a job that failed mid-stage, which is what stalled PR 895", () => {
  // "BB environment observation is unavailable" is a transient read, and the
  // stage is still there to re-enter. This sat failed for good because the
  // sweep only looked at blocked jobs.
  expect(planJobContinuation({
    job: blockedJob({ state: "failed", resumeState: "implementing" }),
    attempts: 0,
  })).toEqual({ action: "resume", event: "RETRY" });
});

it("bounds a failing job by the same ladder as a blocked one", () => {
  const job = blockedJob({ state: "failed", resumeState: "implementing" });
  expect(planJobContinuation({ job, attempts: MAX_AUTO_CONTINUES - 1 }).action).toBe("resume");
  expect(planJobContinuation({ job, attempts: MAX_AUTO_CONTINUES }).action).toBe("escalate");
});

it("hands over a failure with nowhere to resume from", () => {
  expect(planJobContinuation({
    job: blockedJob({ state: "failed", resumeState: null }),
    attempts: 0,
  }).action).toBe("escalate");
});

it("holds a failed job the owner is cancelling", () => {
  expect(planJobContinuation({
    job: blockedJob({ state: "failed", resumeState: "implementing", cancelRequestedAt: 1 }),
    attempts: 0,
  })).toEqual({ action: "hold" });
});

it("counts a failure separately from a block at the same stage", () => {
  // Otherwise a job that failed in reviewing, recovered, then blocked in
  // reviewing would arrive with the failure's attempts already spent.
  expect(continuationKey({ state: "failed", blockedReason: null, resumeState: "reviewing" }))
    .not.toBe(continuationKey({ state: "blocked", blockedReason: null, resumeState: "reviewing" }));
});
