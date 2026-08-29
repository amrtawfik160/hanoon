import { expect, describe, it } from "vitest";
import {
  IllegalTransitionError,
  transition,
} from "../src/domain/state-machine";
import { classifyDeliveryMode, type JobEvent, type JobState } from "../src/domain/models";
import { activeWorkerFixture, jobFixture, policyFixture, sha, stateJob } from "./helpers";

describe("job state machine", () => {
  it("classifies only obvious small fixes from the task text", () => {
    expect(classifyDeliveryMode("fix typo in the refund copy")).toBe("small_fix");
    expect(classifyDeliveryMode("one-line lint fix")).toBe("small_fix");
    expect(classifyDeliveryMode("fix typo", "full")).toBe("full");
    expect(classifyDeliveryMode("rebuild checkout and add a regression")).toBe("full");
  });

  it.each([
    ["awaiting_project", { type: "PROJECT_SELECTED", projectId: "proj_1", policyVersion: 1, policy: policyFixture() }, "awaiting_confirmation", "render_status"],
    ["awaiting_confirmation", { type: "CONFIRMED" }, "planning", "spawn_plan"],
    ["planning", { type: "PLAN_READY", attemptId: "stage_plan_1" }, "critiquing", "spawn_critique"],
    ["critiquing", { type: "CRITIQUE_PASSED", attemptId: "stage_critique_1" }, "creating_implementation", "spawn_implementation"],
    ["creating_implementation", { type: "IMPLEMENTATION_CREATED", threadId: "thr_i", environmentId: "env_1" }, "implementing", "render_status"],
    ["implementing", { type: "IMPLEMENTATION_IDLE" }, "locating_pr", "inspect_implementation"],
    ["locating_pr", { type: "PR_LOCATED", number: 7, url: "https://github.test/pr/7" }, "resolving_pr_head", "resolve_pr_head"],
    ["resolving_pr_head", { type: "PR_HEAD_RESOLVED", headSha: sha() }, "validating", "run_validation"],
    ["validating", { type: "VALIDATION_PASSED", headSha: sha() }, "reviewing", "spawn_review"],
    ["reviewing", { type: "REVIEW_PASSED", headSha: sha() }, "documenting", "spawn_docs"],
    ["documenting", { type: "DOCS_IDLE" }, "resolving_docs_head", "resolve_pr_head"],
    ["resolving_docs_head", { type: "PR_HEAD_RESOLVED", headSha: sha() }, "final_validating", "run_final_validation"],
    ["final_validating", { type: "VALIDATION_PASSED", headSha: sha() }, "final_reviewing", "spawn_final_review"],
    ["final_reviewing", { type: "REVIEW_PASSED", headSha: sha() }, "awaiting_merge_approval", "issue_approval"],
    ["awaiting_merge_approval", { type: "APPROVAL_ACCEPTED", headSha: sha() }, "merging", "merge_pr"],
    ["merging", { type: "MERGE_SUCCEEDED", message: "merged", mergeCommitSha: sha("d"), mergedAt: "2026-08-10T18:00:00.000Z", baseContentVerified: true }, "deploying", "deploy_production"],
    ["deploying", { type: "DEPLOY_SUCCEEDED", summary: "Production deployment passed" }, "verifying_production", "verify_production"],
    ["verifying_production", { type: "CANARY_SUCCEEDED", summary: "Production canary passed" }, "complete", "render_status"],
  ] as const)("moves %s to %s", (from, event, to, effect) => {
    const base = stateJob(from as JobState, {
      projectId: "proj_1",
      policyVersion: 1,
      policy: policyFixture(),
      prHeadSha: ["reviewing", "validating", "documenting", "final_validating", "final_reviewing", "awaiting_merge_approval"].includes(from)
        ? sha()
        : null,
    });
    const result = transition(base, event as JobEvent, 10_000);

    expect(result.job.state).toBe(to);
    expect(result.effects.map((item) => item.kind)).toContain(effect);
  });

  it("completes after final review when production deployment and canary are not configured", () => {
    const policy = policyFixture();
    delete (policy as Partial<typeof policy>).production;
    const result = transition(
      stateJob("final_reviewing", { policy, prHeadSha: sha(), prNumber: 7 }),
      { type: "REVIEW_PASSED", headSha: sha() },
      2_250,
    );

    expect(result.job).toMatchObject({
      state: "complete",
      blockedReason: null,
      lastError: null,
      prNumber: 7,
    });
    expect(result.effects.map((effect) => effect.kind)).toEqual(["render_status"]);
  });

  describe("a project that deploys nothing but asked to merge anyway", () => {
    function policyWithoutProduction(mergeWithoutProduction: boolean) {
      const policy = policyFixture({
        regression: { commands: [{ name: "unit", command: "npm test", timeoutMs: 600_000 }] },
        ...(mergeWithoutProduction
          ? { autonomy: { unattendedMerge: false, mergeWithoutProduction: true } }
          : {}),
      });
      delete (policy as Partial<typeof policy>).production;
      return policy;
    }

    it("routes a passed final review to the approval stage instead of finishing there", () => {
      const result = transition(
        stateJob("final_reviewing", {
          policy: policyWithoutProduction(true),
          prHeadSha: sha(),
          prNumber: 7,
        }),
        { type: "REVIEW_PASSED", headSha: sha() },
        2_250,
      );

      expect(result.job.state).toBe("awaiting_merge_approval");
      expect(result.effects.map((effect) => effect.kind)).toEqual(["issue_approval"]);
    });

    it("finishes at the merge, with no deploy or canary to run", () => {
      const result = transition(
        stateJob("merging", { policy: policyWithoutProduction(true), prHeadSha: sha(), prNumber: 7 }),
        {
          type: "MERGE_SUCCEEDED",
          message: "merged",
          mergeCommitSha: sha("d"),
          mergedAt: "2026-08-10T18:00:00.000Z",
          baseContentVerified: true,
        },
        2_251,
      );

      expect(result.job).toMatchObject({
        state: "merged",
        mergeCommitSha: sha("d"),
        blockedReason: null,
        lastError: null,
      });
      expect(result.effects.map((effect) => effect.kind)).toEqual(["render_status"]);
    });

    it("still reports a production incident for a project that never asked for this", () => {
      const result = transition(
        stateJob("merging", { policy: policyWithoutProduction(false), prHeadSha: sha(), prNumber: 7 }),
        {
          type: "MERGE_SUCCEEDED",
          message: "merged",
          mergeCommitSha: sha("d"),
          mergedAt: "2026-08-10T18:00:00.000Z",
          baseContentVerified: true,
        },
        2_252,
      );

      expect(result.job.state).toBe("production_failed");
    });

    it("keeps every other gate: a drifted head is still invalidated, not merged", () => {
      const result = transition(
        stateJob("final_reviewing", {
          policy: policyWithoutProduction(true),
          prHeadSha: sha(),
          prNumber: 7,
        }),
        { type: "REVIEW_PASSED", headSha: sha("b") },
        2_253,
      );

      expect(result.job.state).toBe("resolving_pr_head");
    });

    it("still refuses to merge content the base branch did not verify", () => {
      const result = transition(
        stateJob("merging", { policy: policyWithoutProduction(true), prHeadSha: sha(), prNumber: 7 }),
        {
          type: "MERGE_SUCCEEDED",
          message: "merged",
          mergeCommitSha: sha("d"),
          mergedAt: "2026-08-10T18:00:00.000Z",
          baseContentVerified: false,
        },
        2_254,
      );

      expect(result.job.state).toBe("production_failed");
    });
  });

  it("skips critique but requires validation and one review on the small-fix path", () => {
    const confirmed = transition(
      stateJob("awaiting_confirmation", { deliveryMode: "small_fix", projectId: "proj_1" }),
      { type: "CONFIRMED" },
      2_240,
    );
    expect(confirmed.job.state).toBe("creating_implementation");
    expect(confirmed.effects.map((effect) => effect.kind)).toEqual(["spawn_implementation"]);

    const published = transition(
      stateJob("locating_pr", { deliveryMode: "small_fix" }),
      { type: "PR_LOCATED", number: 11, url: "https://github.test/pr/11" },
      2_241,
    );
    expect(published.job).toMatchObject({
      state: "resolving_pr_head",
      prNumber: 11,
      prUrl: "https://github.test/pr/11",
    });
    expect(published.effects.map((effect) => effect.kind)).toEqual(["resolve_pr_head"]);

    const reviewed = transition(
      stateJob("reviewing", { deliveryMode: "small_fix", prNumber: 11, prHeadSha: sha() }),
      { type: "REVIEW_PASSED", headSha: sha() },
      2_242,
    );
    expect(reviewed.job.state).toBe("complete");
    expect(reviewed.effects.map((effect) => effect.kind)).toEqual(["render_status"]);
  });

  it("resumes an existing pull request from review instead of replanning", () => {
    const blocked = transition(
      stateJob("blocked", {
        blockedReason: "plan_limit",
        lastError: "Plan needs revision: Still incomplete",
        planCycle: 2,
        prNumber: 19,
        prUrl: "https://github.test/pr/19",
        prHeadSha: sha(),
      }),
      { type: "CONTINUE_REVIEW" },
      2_242,
    );
    expect(blocked.job).toMatchObject({
      state: "reviewing",
      blockedReason: null,
      lastError: null,
      prNumber: 19,
    });
    expect(blocked.effects.map((effect) => effect.kind)).toEqual(["spawn_review"]);

    const failed = transition(
      stateJob("failed", {
        resumeState: "planning",
        lastError: "temporary failure",
        prNumber: 21,
        prHeadSha: sha(),
      }),
      { type: "RETRY" },
      2_243,
    );
    expect(failed.job.state).toBe("reviewing");
    expect(failed.effects.map((effect) => effect.kind)).toEqual(["spawn_review"]);
  });

  // The Areliaa job resumed pinned to the head its review group had settled
  // "blocked" against, so the stale verdict replayed and re-blocked it within
  // a second. A configuration block resumes by re-resolving the pull request
  // head, which gives it a fresh validation and a fresh review group.
  it("re-resolves the head when a configuration-blocked review continues", () => {
    const resumed = transition(
      stateJob("blocked", {
        blockedReason: "configuration",
        prNumber: 42,
        prUrl: "https://github.test/pr/42",
        prHeadSha: sha(),
        implementationThreadId: "thr_impl",
      }),
      { type: "CONTINUE_REVIEW" },
      2_244,
    );
    expect(resumed.job).toMatchObject({
      state: "resolving_pr_head",
      blockedReason: null,
      lastError: null,
      prHeadSha: null,
      prNumber: 42,
    });
    expect(resumed.effects.map((effect) => effect.kind)).toEqual(["revoke_approvals", "resolve_pr_head"]);
  });

  it("retries a permanent effect failure when the next step is already known", () => {
    const retried = transition(
      stateJob("blocked", {
        blockedReason: "permanent_effect_failure",
        resumeState: "locating_pr",
        lastError: "implementation inspection requires BB environment and policy context",
      }),
      { type: "RETRY" },
      2_244,
    );
    expect(retried.job).toMatchObject({
      state: "locating_pr",
      blockedReason: null,
      lastError: null,
      resumeState: null,
    });
    expect(retried.effects.map((effect) => effect.kind)).toEqual(["inspect_implementation"]);
  });

  it("fences a silent worker before replaying its exact stage", () => {
    const requested = transition(
      stateJob("implementing", {
        implementationThreadId: "thr_silent",
        environmentId: "env_1",
      }),
      {
        type: "WORKER_RECOVERY_REQUESTED",
        recoveryId: "recovery_1",
        workerKind: "implementation",
        resourceId: "thr_silent",
        classification: "no_progress",
        signature: "silent:implementation:no_progress",
      },
      2_246,
    );

    expect(requested.job).toMatchObject({
      state: "recovering_worker",
      resumeState: "implementing",
      implementationThreadId: "thr_silent",
    });
    expect(requested.effects.map((effect) => effect.kind)).toEqual(["render_status", "recover_worker"]);

    const replayed = transition(
      requested.job,
      { type: "WORKER_RECOVERY_REQUEUED", recoveryId: "recovery_1" },
      2_247,
    );
    expect(replayed.job).toMatchObject({
      state: "creating_implementation",
      resumeState: null,
      implementationThreadId: null,
      environmentId: "env_1",
    });
    expect(replayed.effects.map((effect) => effect.kind)).toEqual(["spawn_implementation"]);
  });

  it("finishes a reviewed pull request that was blocked only because production is missing", () => {
    const policy = policyFixture();
    delete (policy as Partial<typeof policy>).production;
    const result = transition(
      stateJob("blocked", {
        policy,
        blockedReason: "configuration",
        lastError: "Production deployment and canary are not configured",
        prNumber: 8,
        prHeadSha: sha(),
      }),
      { type: "CONTINUE_REVIEW" },
      2_245,
    );
    expect(result.job).toMatchObject({
      state: "complete",
      blockedReason: null,
      lastError: null,
    });
    expect(result.effects.map((effect) => effect.kind)).toEqual(["render_status"]);
  });

  it.each([
    ["deploying", { type: "DEPLOY_FAILED", reason: "Production deploy failed" }],
    ["verifying_production", { type: "CANARY_FAILED", reason: "Production canary failed" }],
  ] as const)("preserves the merge fact when %s fails", (state, event) => {
    const result = transition(
      stateJob(state, {
        mergeMessage: "Merged pull request #7",
        mergeCommitSha: sha("d"),
        mergedAt: "2026-08-10T18:00:00.000Z",
      }),
      event,
      2_300,
    );

    expect(result.job).toMatchObject({
      state: "production_failed",
      mergeMessage: "Merged pull request #7",
      mergeCommitSha: sha("d"),
      mergedAt: "2026-08-10T18:00:00.000Z",
      lastError: event.reason,
    });
    expect(result.effects.map((effect) => effect.kind)).toEqual(["render_status"]);
  });

  it("reports a production incident when the merge succeeds but base-content verification fails", () => {
    const result = transition(
      stateJob("merging"),
      {
        type: "MERGE_SUCCEEDED",
        message: "Merged pull request #7",
        mergeCommitSha: sha("d"),
        mergedAt: "2026-08-10T18:00:00.000Z",
        baseContentVerified: false,
      },
      2_350,
    );

    expect(result.job).toMatchObject({
      state: "production_failed",
      mergeCommitSha: sha("d"),
      lastError: "Merge succeeded but the base branch did not verify the approved content",
    });
    expect(result.effects.map((effect) => effect.kind)).toEqual(["render_status"]);
  });

  it("preserves the merge fact when a legacy approval has no production configuration", () => {
    const policy = policyFixture();
    delete (policy as Partial<typeof policy>).production;
    const result = transition(
      stateJob("merging", { policy }),
      {
        type: "MERGE_SUCCEEDED",
        message: "Merged pull request #7",
        mergeCommitSha: sha("d"),
        mergedAt: "2026-08-10T18:00:00.000Z",
        baseContentVerified: true,
      },
      2_360,
    );

    expect(result.job).toMatchObject({
      state: "production_failed",
      mergeCommitSha: sha("d"),
      lastError: "Merge succeeded but production deployment and canary are not configured",
    });
    expect(result.effects.map((effect) => effect.kind)).toEqual(["render_status"]);
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
      blockedReason: "plan_limit",
      lastError: "Plan needs revision: Still incomplete",
    });
    expect(second.effects.map((effect) => effect.kind)).toEqual(["render_status"]);
  });

  it("sends a revised plan straight to implementation without a second critique", () => {
    const result = transition(
      stateJob("planning", { planCycle: 1 }),
      { type: "PLAN_READY", attemptId: "stage_plan_2" },
      2_050,
    );

    expect(result.job.state).toBe("creating_implementation");
    expect(result.effects.map((effect) => effect.kind)).toEqual(["spawn_implementation"]);
  });

  it("resumes a plan-limit block by starting a fresh plan, including legacy review_limit planning blocks", () => {
    const current = transition(
      stateJob("blocked", {
        blockedReason: "plan_limit",
        lastError: "Plan needs revision: Still incomplete",
        planCycle: 2,
      }),
      { type: "CONTINUE_REVIEW" },
      3_400,
    );
    expect(current.job).toMatchObject({
      state: "planning",
      blockedReason: null,
      lastError: null,
      planCycle: 0,
    });
    expect(current.effects.map((effect) => effect.kind)).toEqual(["spawn_plan"]);

    const legacy = transition(
      stateJob("blocked", {
        blockedReason: "review_limit",
        lastError: "Plan critique limit reached",
        planCycle: 2,
        reviewCycle: 0,
        implementationThreadId: null,
        prNumber: null,
      }),
      { type: "CONTINUE_REVIEW" },
      3_410,
    );
    expect(legacy.job.state).toBe("planning");
    expect(legacy.effects.map((effect) => effect.kind)).toEqual(["spawn_plan"]);
  });

  it("routes final-review changes through the bounded patch loop", () => {
    const result = transition(
      stateJob("final_reviewing", { prHeadSha: sha(), reviewCycle: 0 }),
      { type: "REVIEW_CHANGES_REQUESTED", headSha: sha(), summary: "Update the migration note" },
      2_200,
    );

    expect(result.job).toMatchObject({ state: "remediating", reviewCycle: 1 });
    expect(result.effects.map((effect) => effect.kind)).toEqual(["send_remediation"]);
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

  it("stops all supplied active review lenses with one cancellation effect", () => {
    const quality = activeWorkerFixture({ resourceId: "thr_quality", workerKind: "review", generation: 401 });
    const risk = activeWorkerFixture({ resourceId: "thr_risk", workerKind: "review", generation: 401 });
    const result = transition(
      stateJob("reviewing", { reviewThreadId: quality.resourceId }),
      { type: "CANCEL_REQUESTED", activeWorker: quality, activeWorkers: [quality, risk] },
      2_000,
    );

    expect(result.effects.map((item) => item.kind)).toEqual([
      "revoke_approvals",
      "stop_thread",
    ]);
    expect(result.effects[1]?.payload).toEqual({
      generation: quality.generation,
      resourceId: quality.resourceId,
      resourceKind: quality.resourceKind,
      workerKind: quality.workerKind,
      workers: [
        {
          generation: quality.generation,
          resourceId: quality.resourceId,
          resourceKind: quality.resourceKind,
          workerKind: quality.workerKind,
        },
        {
          generation: risk.generation,
          resourceId: risk.resourceId,
          resourceKind: risk.resourceKind,
          workerKind: risk.workerKind,
        },
      ],
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

  // The limit is only reached while asking for another patch, so what the job
  // still owes is a fix. Resuming into review asked the same question of the
  // same commit, and a review that already requested changes at this head
  // refuses to answer twice: the job burned every restored cycle being told a
  // new head is required and never produced one.
  it("continues patching only from a review-limit block and advances the next block threshold", () => {
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

    expect(result.job.state).toBe("remediating");
    expect(result.job.blockedReason).toBeNull();
    expect(result.job.reviewBlockAt).toBe(6);
    expect(result.effects.map((item) => item.kind)).toEqual(["send_remediation"]);

    // Every real job at this limit already has a pull request, and the branch
    // that resumes one used to intercept first, so the patch resume never ran
    // where it was needed.
    const withPullRequest = transition(
      stateJob("blocked", {
        reviewCycle: 6,
        reviewBlockAt: 6,
        blockedReason: "review_limit",
        prNumber: 42,
        prUrl: "https://github.test/pr/42",
        prHeadSha: sha(),
        implementationThreadId: "thr_impl",
      }),
      { type: "CONTINUE_REVIEW" },
      3_600,
    );
    expect(withPullRequest.job.state).toBe("remediating");
    expect(withPullRequest.job.reviewBlockAt).toBe(9);
    expect(withPullRequest.effects.map((item) => item.kind)).toEqual(["send_remediation"]);
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
      ["final_reviewing", { type: "REVIEW_PASSED", headSha: sha("b") }],
      ["validating", { type: "VALIDATION_PASSED", headSha: sha("b") }],
      ["final_validating", { type: "VALIDATION_PASSED", headSha: sha("b") }],
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
    expect(resolved.effects.map((item) => item.kind)).toEqual(["run_validation"]);
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
    ["documenting", "spawn_docs"],
    ["resolving_docs_head", "resolve_pr_head"],
    ["final_validating", "run_final_validation"],
    ["final_reviewing", "spawn_final_review"],
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

it("cancels immediately when there is no worker left to stop", () => {
  // CANCEL_CONFIRMED is otherwise applied only by the stop_thread effect, which
  // an idle job never emits — so this job would sit in "cancel requested"
  // forever and could never reach a terminal state.
  const job = stateJob("failed");

  const result = transition(job, { type: "CANCEL_REQUESTED", activeWorker: null }, 5_000);

  expect(result.job.state).toBe("cancelled");
  expect(result.job.cancelRequestedAt).toBe(5_000);
  expect(result.effects.map((effect) => effect.kind)).not.toContain("stop_thread");
});

it("still waits for a live worker to be stopped before cancelling", () => {
  const job = stateJob("implementing");

  const result = transition(job, {
    type: "CANCEL_REQUESTED",
    activeWorker: activeWorkerFixture({ jobId: job.id, state: "active" }),
  }, 5_000);

  expect(result.job.state).toBe("implementing");
  expect(result.effects.map((effect) => effect.kind)).toContain("stop_thread");
});

it("keeps waiting when the caller supplied no worker evidence at all", () => {
  const job = stateJob("implementing");

  const result = transition(job, { type: "CANCEL_REQUESTED" }, 5_000);

  // Unknown is not the same as absent: cancelling here could orphan a live worker.
  expect(result.job.state).toBe("implementing");
  expect(result.job.cancelRequestedAt).toBe(5_000);
});

it("completes a cancellation that was already requested but never confirmed", () => {
  // The state this fix exists to rescue: requested while the worker was still
  // reported active, then the worker went away and nothing ever confirmed it.
  const stuck = stateJob("failed", { cancelRequestedAt: 4_000 });

  const result = transition(stuck, { type: "CANCEL_REQUESTED", activeWorker: null }, 9_000);

  expect(result.job.state).toBe("cancelled");
  expect(result.job.cancelRequestedAt).toBe(4_000);
});

describe("navigator-v1 release transitions", () => {
  const head = sha();
  const navigator = (state: JobState, overrides: Parameters<typeof stateJob>[1] = {}) =>
    stateJob(state, {
      workflowEngine: "navigator-v1",
      workflowMode: "deterministic",
      taskOutcome: "shipped_change",
      ...overrides,
    });

  it("starts exact-head release from implementing without inspecting the implementation", () => {
    const result = transition(
      navigator("implementing"),
      {
        type: "RELEASE_STARTED",
        number: 42,
        url: "https://github.test/pr/42",
        environmentId: "env_job_42",
      },
      10_000,
    );

    expect(result.job).toMatchObject({
      state: "resolving_pr_head",
      prNumber: 42,
      prUrl: "https://github.test/pr/42",
      environmentId: "env_job_42",
    });
    expect(result.effects.map((effect) => effect.kind)).toEqual(["resolve_pr_head"]);
  });

  it("rejects implementation idle and recipe release-started on the opposite engines", () => {
    expect(() => transition(navigator("implementing"), { type: "IMPLEMENTATION_IDLE" }, 10_000))
      .toThrow(IllegalTransitionError);
    expect(() => transition(
      stateJob("implementing"),
      {
        type: "RELEASE_STARTED",
        number: 42,
        url: "https://github.test/pr/42",
        environmentId: "env_job_42",
      },
      10_000,
    )).toThrow(IllegalTransitionError);
  });

  it("returns validation, review, and documentation findings to navigation without remediation or docs work", () => {
    const validation = transition(
      navigator("validating", { prHeadSha: head, prNumber: 42 }),
      { type: "VALIDATION_FAILED", headSha: head, reason: "Validation did not pass" },
      10_000,
    );
    expect(validation.job).toMatchObject({ state: "implementing", prHeadSha: null });
    expect(validation.effects.map((effect) => effect.kind)).toEqual(["revoke_approvals", "render_status"]);

    const review = transition(
      navigator("reviewing", { prHeadSha: head, prNumber: 42 }),
      { type: "REVIEW_CHANGES_REQUESTED", headSha: head, summary: "Review requested changes" },
      10_001,
    );
    expect(review.job).toMatchObject({ state: "implementing", prHeadSha: null });
    expect(review.effects.map((effect) => effect.kind)).toEqual(["revoke_approvals", "render_status"]);

    const docs = transition(
      navigator("reviewing", { prHeadSha: head, prNumber: 42, policy: policyFixture() }),
      {
        type: "REVIEW_PASSED",
        headSha: head,
        documentation: { required: true, reasons: ["docs.stale"], diffDigest: "b".repeat(64) },
      },
      10_002,
    );
    expect(docs.job).toMatchObject({ state: "implementing", prHeadSha: null });
    expect(docs.effects.map((effect) => effect.kind)).toEqual(["revoke_approvals", "render_status"]);
  });

  it("still patches and documents recipe jobs after the same findings", () => {
    const validation = transition(
      stateJob("validating", { prHeadSha: head }),
      { type: "VALIDATION_FAILED", headSha: head, reason: "Validation did not pass" },
      10_000,
    );
    expect(validation.job.state).toBe("remediating");
    expect(validation.effects.map((effect) => effect.kind)).toContain("send_remediation");

    const docs = transition(
      stateJob("reviewing", { prHeadSha: head, policy: policyFixture() }),
      { type: "REVIEW_PASSED", headSha: head },
      10_001,
    );
    expect(docs.job.state).toBe("documenting");
    expect(docs.effects.map((effect) => effect.kind)).toContain("spawn_docs");
  });

  it("skips the recipe docs loop and issues approval for a shipped navigator head", () => {
    const result = transition(
      navigator("reviewing", { prHeadSha: head, policy: policyFixture() }),
      {
        type: "REVIEW_PASSED",
        headSha: head,
        documentation: { required: false, reasons: [], diffDigest: "b".repeat(64) },
      },
      10_000,
    );

    expect(result.job.state).toBe("awaiting_merge_approval");
    expect(result.effects.map((effect) => effect.kind)).toEqual(["issue_approval"]);
  });

  it("returns a recovered production incident to navigation and rejects that event on recipe jobs", () => {
    const recovered = transition(
      navigator("deploying", {
        mergeMessage: "Merged pull request #42",
        mergeCommitSha: sha("d"),
        mergedAt: "2026-08-10T18:00:00.000Z",
        prHeadSha: head,
      }),
      { type: "PRODUCTION_INCIDENT_RECOVERED", phase: "deploy", reason: "Production deploy failed" },
      10_000,
    );
    expect(recovered.job).toMatchObject({
      state: "implementing",
      prHeadSha: null,
      mergeCommitSha: sha("d"),
    });
    expect(recovered.effects.map((effect) => effect.kind)).toEqual(["revoke_approvals", "render_status"]);

    const canary = transition(
      navigator("verifying_production", {
        mergeCommitSha: sha("d"),
        mergedAt: "2026-08-10T18:00:00.000Z",
      }),
      { type: "PRODUCTION_INCIDENT_RECOVERED", phase: "canary", reason: "Production canary failed" },
      10_001,
    );
    expect(canary.job.state).toBe("implementing");

    expect(() => transition(
      stateJob("deploying"),
      { type: "PRODUCTION_INCIDENT_RECOVERED", phase: "deploy", reason: "Production deploy failed" },
      10_002,
    )).toThrow(IllegalTransitionError);
  });

  it("still fails recipe production after a successful rollback event is withheld", () => {
    const result = transition(
      stateJob("deploying", {
        mergeMessage: "Merged pull request #7",
        mergeCommitSha: sha("d"),
        mergedAt: "2026-08-10T18:00:00.000Z",
      }),
      { type: "DEPLOY_FAILED", reason: "Production deploy failed" },
      10_000,
    );
    expect(result.job.state).toBe("production_failed");
  });

  it("keeps merge-once and unverified base-content incidents for navigator jobs", () => {
    const merged = transition(
      navigator("awaiting_merge_approval", { prHeadSha: head, prNumber: 42 }),
      { type: "APPROVAL_ACCEPTED", headSha: head },
      10_000,
    );
    expect(merged.job.state).toBe("merging");
    expect(merged.effects.map((effect) => effect.kind)).toEqual(["merge_pr"]);

    const unverified = transition(
      navigator("merging"),
      {
        type: "MERGE_SUCCEEDED",
        message: "Merged pull request #42",
        mergeCommitSha: sha("d"),
        mergedAt: "2026-08-10T18:00:00.000Z",
        baseContentVerified: false,
      },
      10_001,
    );
    expect(unverified.job.state).toBe("production_failed");
    expect(unverified.job.lastError).toMatch(/did not verify the approved content/u);
  });

  it("deploys before canary and completes only after canary, or merges without production", () => {
    const deployed = transition(
      navigator("merging", { policy: policyFixture() }),
      {
        type: "MERGE_SUCCEEDED",
        message: "Merged pull request #42",
        mergeCommitSha: sha("d"),
        mergedAt: "2026-08-10T18:00:00.000Z",
        baseContentVerified: true,
      },
      10_000,
    );
    expect(deployed.job.state).toBe("deploying");
    expect(deployed.effects.map((effect) => effect.kind)).toEqual(["render_status", "deploy_production"]);

    const canary = transition(
      navigator("deploying", { policy: policyFixture() }),
      { type: "DEPLOY_SUCCEEDED", summary: "Production deployment passed" },
      10_001,
    );
    expect(canary.job.state).toBe("verifying_production");
    expect(canary.effects.map((effect) => effect.kind)).toContain("verify_production");

    const complete = transition(
      navigator("verifying_production"),
      { type: "CANARY_SUCCEEDED", summary: "Production canary passed" },
      10_002,
    );
    expect(complete.job.state).toBe("complete");

    const policy = policyFixture({
      autonomy: { unattendedMerge: false, mergeWithoutProduction: true },
    });
    delete (policy as Partial<typeof policy>).production;
    const merged = transition(
      navigator("merging", { policy, taskOutcome: "shipped_change" }),
      {
        type: "MERGE_SUCCEEDED",
        message: "Merged pull request #42",
        mergeCommitSha: sha("d"),
        mergedAt: "2026-08-10T18:00:00.000Z",
        baseContentVerified: true,
      },
      10_003,
    );
    expect(merged.job.state).toBe("merged");
  });
});

