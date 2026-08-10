import { expect, describe, it } from "vitest";
import {
  IllegalTransitionError,
  transition,
} from "../src/domain/state-machine";
import type { JobEvent, JobState } from "../src/domain/models";
import { activeWorkerFixture, jobFixture, policyFixture, sha, stateJob } from "./helpers";

describe("job state machine", () => {
  it.each([
    ["awaiting_project", { type: "PROJECT_SELECTED", projectId: "proj_1", policyVersion: 1, policy: policyFixture() }, "awaiting_confirmation", "render_status"],
    ["awaiting_confirmation", { type: "CONFIRMED" }, "planning", "spawn_plan"],
    ["planning", { type: "PLAN_READY", attemptId: "stage_plan_1" }, "critiquing", "spawn_critique"],
    ["critiquing", { type: "CRITIQUE_PASSED", attemptId: "stage_critique_1" }, "creating_implementation", "spawn_implementation"],
    ["creating_implementation", { type: "IMPLEMENTATION_CREATED", threadId: "thr_i", environmentId: "env_1" }, "implementing", "render_status"],
    ["implementing", { type: "IMPLEMENTATION_IDLE" }, "locating_pr", "inspect_implementation"],
    ["locating_pr", { type: "PR_LOCATED", number: 7, url: "https://github.test/pr/7" }, "resolving_pr_head", "resolve_pr_head"],
    ["resolving_pr_head", { type: "PR_HEAD_RESOLVED", headSha: sha() }, "reviewing", "spawn_review"],
    ["reviewing", { type: "REVIEW_PASSED", headSha: sha() }, "validating", "run_validation"],
    ["validating", { type: "VALIDATION_PASSED", headSha: sha() }, "awaiting_merge_approval", "issue_approval"],
    ["awaiting_merge_approval", { type: "APPROVAL_ACCEPTED", headSha: sha() }, "merging", "merge_pr"],
    ["merging", { type: "MERGE_SUCCEEDED", message: "merged" }, "merged", "render_status"],
  ] as const)("moves %s to %s", (from, event, to, effect) => {
    const base = stateJob(from as JobState, {
      projectId: "proj_1",
      policyVersion: 1,
      policy: policyFixture(),
      prHeadSha: ["reviewing", "validating", "awaiting_merge_approval"].includes(from)
        ? sha()
        : null,
    });
    const result = transition(base, event as JobEvent, 10_000);

    expect(result.job.state).toBe(to);
    expect(result.effects.map((item) => item.kind)).toContain(effect);
  });

  it("routes one critique revision back through a fresh plan and blocks the second", () => {
    const first = transition(
      stateJob("critiquing", { planCycle: 0 }),
      { type: "CRITIQUE_NEEDS_REVISION", attemptId: "stage_critique_1", summary: "Add rollback details" },
      2_000,
    );

    expect(first.job).toMatchObject({ state: "planning", planCycle: 1 });
    expect(first.effects.map((effect) => effect.kind)).toEqual(["spawn_plan"]);

    const second = transition(
      stateJob("critiquing", { planCycle: 1 }),
      { type: "CRITIQUE_NEEDS_REVISION", attemptId: "stage_critique_2", summary: "Still incomplete" },
      2_100,
    );

    expect(second.job).toMatchObject({
      state: "blocked",
      planCycle: 2,
      blockedReason: "review_limit",
      lastError: "Plan critique limit reached",
    });
    expect(second.effects.map((effect) => effect.kind)).toEqual(["render_status"]);
  });

  it("does not stop historical worker identifiers during cancellation", () => {
    const job = stateJob("implementing", {
      implementationThreadId: "thr_historical",
      reviewThreadId: "thr_old_review",
    });

    const result = transition(job, { type: "CANCEL_REQUESTED" }, 2_000);

    expect(result.job.cancelRequestedAt).toBe(2_000);
    expect(result.effects.map((item) => item.kind)).toEqual(["revoke_approvals"]);
  });

  it("stops only the supplied active worker resource during cancellation", () => {
    const activeWorker = activeWorkerFixture({ resourceId: "thr_active_review", workerKind: "review" });
    const result = transition(
      stateJob("reviewing", { reviewThreadId: "thr_historical" }),
      { type: "CANCEL_REQUESTED", activeWorker },
      2_000,
    );

    expect(result.effects.map((item) => item.kind)).toEqual([
      "revoke_approvals",
      "stop_thread",
    ]);
    expect(result.effects[1]?.payload).toEqual({
      generation: activeWorker.generation,
      resourceId: activeWorker.resourceId,
      resourceKind: activeWorker.resourceKind,
      workerKind: activeWorker.workerKind,
    });
  });

  it("suppresses non-cancellation effects after cancellation was requested", () => {
    const cancelledRequest = transition(
      stateJob("implementing"),
      { type: "CANCEL_REQUESTED" },
      2_000,
    ).job;

    const result = transition(cancelledRequest, { type: "IMPLEMENTATION_IDLE" }, 2_001);

    expect(result.job.state).toBe("implementing");
    expect(result.effects).toEqual([]);
    expect(result.job.version).toBe(cancelledRequest.version + 1);
  });

  it("confirms cancellation only after a request and renders the terminal state", () => {
    const requested = jobFixture({ cancelRequestedAt: 2_000, state: "implementing" });
    const result = transition(requested, { type: "CANCEL_CONFIRMED" }, 2_100);

    expect(result.job.state).toBe("cancelled");
    expect(result.effects.map((item) => item.kind)).toEqual(["render_status"]);
    expect(() => transition(jobFixture(), { type: "CANCEL_CONFIRMED" }, 2_100)).toThrow(
      IllegalTransitionError,
    );
  });

  it.each([
    [1, "remediating", ["send_remediation"]],
    [2, "remediating", ["send_remediation"]],
    [3, "blocked", ["render_status"]],
  ] as const)("review cycle %s follows the review limit rule", (cycle, state, effects) => {
    const result = transition(
      stateJob("reviewing", { reviewCycle: cycle - 1, prHeadSha: sha() }),
      { type: "REVIEW_CHANGES_REQUESTED", headSha: sha(), summary: "needs changes" },
      3_000,
    );

    expect(result.job.reviewCycle).toBe(cycle);
    expect(result.job.state).toBe(state);
    expect(result.effects.map((item) => item.kind)).toEqual(effects);
    if (state === "blocked") expect(result.job.blockedReason).toBe("review_limit");
  });

  it("continues review only from a review-limit block and advances the next block threshold", () => {
    const result = transition(
      stateJob("blocked", {
        reviewCycle: 3,
        reviewBlockAt: 3,
        blockedReason: "review_limit",
        prHeadSha: sha(),
      }),
      { type: "CONTINUE_REVIEW" },
      3_500,
    );

    expect(result.job.state).toBe("reviewing");
    expect(result.job.blockedReason).toBeNull();
    expect(result.job.reviewBlockAt).toBe(6);
    expect(result.effects.map((item) => item.kind)).toEqual(["spawn_review"]);
    expect(() => transition(stateJob("blocked", { blockedReason: "configuration" }), { type: "CONTINUE_REVIEW" }, 3_500)).toThrow(IllegalTransitionError);
  });

  it("uses the selected policy review limit as the first blocking threshold", () => {
    const result = transition(
      jobFixture(),
      {
        type: "PROJECT_SELECTED",
        projectId: "proj_1",
        policyVersion: 2,
        policy: policyFixture({ maxReviewCycles: 5 }),
      },
      3_600,
    );

    expect(result.job.reviewBlockAt).toBe(5);
  });

  it("invalidates the head and prior receipts whenever implementation completes", () => {
    const result = transition(
      stateJob("implementing", { prHeadSha: sha(), implementationThreadId: "thr_i" }),
      { type: "IMPLEMENTATION_IDLE" },
      4_000,
    );

    expect(result.job.state).toBe("locating_pr");
    expect(result.job.prHeadSha).toBeNull();
    expect(result.effects.map((item) => item.kind)).toEqual([
      "revoke_approvals",
      "inspect_implementation",
    ]);
  });

  it("invalidates drifted review, validation, and approval receipts fail-closed", () => {
    const cases = [
      ["reviewing", { type: "REVIEW_PASSED", headSha: sha("b") }],
      ["validating", { type: "VALIDATION_PASSED", headSha: sha("b") }],
      ["awaiting_merge_approval", { type: "APPROVAL_ACCEPTED", headSha: sha("b") }],
    ] as const;

    for (const [state, event] of cases) {
      const result = transition(
        stateJob(state as JobState, { prHeadSha: sha("a") }),
        event as JobEvent,
        4_100,
      );

      expect(result.job.state).toBe("resolving_pr_head");
      expect(result.job.prHeadSha).toBeNull();
      expect(result.effects.map((item) => item.kind)).toEqual([
        "revoke_approvals",
        "resolve_pr_head",
      ]);
    }
  });

  it("allows only PR_HEAD_RESOLVED to set a new head SHA", () => {
    const located = transition(
      stateJob("locating_pr", { prHeadSha: null }),
      { type: "PR_LOCATED", number: 9, url: "https://github.test/pr/9" },
      4_200,
    ).job;
    const resolved = transition(located, { type: "PR_HEAD_RESOLVED", headSha: sha("c") }, 4_300);

    expect(located.prHeadSha).toBeNull();
    expect(resolved.job.prHeadSha).toBe(sha("c"));
    expect(resolved.effects.map((item) => item.kind)).toEqual(["spawn_review"]);
  });

  it.each([
    ["planning", "spawn_plan"],
    ["critiquing", "spawn_critique"],
    ["creating_implementation", "spawn_implementation"],
    ["implementing", "inspect_implementation"],
    ["locating_pr", "inspect_implementation"],
    ["resolving_pr_head", "resolve_pr_head"],
    ["reviewing", "spawn_review"],
    ["remediating", "send_remediation"],
    ["validating", "run_validation"],
    ["awaiting_merge_approval", "issue_approval"],
    ["merging", "merge_pr"],
  ] as const)("retry restores %s and emits one stage effect", (resumeState, effect) => {
    const failed = stateJob("failed", {
      resumeState,
      lastError: "temporary failure",
      prHeadSha: ["reviewing", "validating", "awaiting_merge_approval", "merging"].includes(resumeState)
        ? sha()
        : null,
    });
    const result = transition(failed, { type: "RETRY" }, 5_000);

    expect(result.job.state).toBe(resumeState);
    expect(result.job.lastError).toBeNull();
    expect(result.effects.map((item) => item.kind)).toEqual([effect]);
  });

  it("records the failed resume state and rejects an event illegal for the current state without mutation", () => {
    const original = stateJob("implementing");
    const failed = transition(original, { type: "FAILED", error: "worker stopped" }, 5_100);

    expect(failed.job.resumeState).toBe("implementing");
    expect(failed.job.state).toBe("failed");
    expect(failed.job.lastError).toBe("worker stopped");

    const untouched = jobFixture();
    expect(() => transition(untouched, { type: "CONFIRMED" }, 5_200)).toThrow(IllegalTransitionError);
    expect(untouched).toEqual(jobFixture());
  });

  it.each([
    ["oversized", "x".repeat(501)],
    ["bearer token", "provider failed: Authorization: Bearer secret-token"],
    ["named secret", "provider failed: api_key=secret-token"],
  ] as const)("rejects %s failure text at the state-machine boundary", (_label, error) => {
    expect(() => transition(stateJob("implementing"), { type: "FAILED", error }, 5_200)).toThrow(
      TypeError,
    );
  });
});
