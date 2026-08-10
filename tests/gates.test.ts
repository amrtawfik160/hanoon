import { describe, expect, test } from "vitest";
import { evaluateMergeGates, type GateInput } from "../src/domain/gates";

const headSha = "a".repeat(40);
const otherSha = "b".repeat(40);
const prNumber = 17;
const row = (sha = headSha, ref = "refs/pull/17/head") => `${sha}\t${ref}\n`;

function readyInput(): GateInput {
  return {
    now: "2026-08-10T12:00:00.000Z",
    projectId: "project-1",
    environmentId: "env-1",
    job: {
      id: "job-1",
      version: 7,
      projectId: "project-1",
      environmentId: "env-1",
      prNumber,
      policy: {
        githubRepository: "acme/telegram",
        baseBranch: "main",
        requiredChecks: ["unit", "lint"],
        mergeMethod: "squash",
      },
    },
    environment: {
      id: "env-1",
      projectId: "project-1",
      status: "available",
      worktree: { clean: true, untrackedFiles: [] },
      checkout: { kind: "branch", branch: "feature/telegram", headSha },
    },
    originRepository: "Acme/Telegram",
    remoteHead: {
      first: { rows: [row()] },
      second: { rows: [row()] },
    },
    pullRequest: {
      available: true,
      number: prNumber,
      state: "OPEN",
      isDraft: false,
      baseRefName: "main",
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
    },
    githubPr: {
      number: prNumber,
      state: "OPEN",
      baseRefName: "main",
      headRefName: "feature/telegram",
    },
    review: {
      attemptId: "attempt-1",
      headSha,
      verdict: "pass",
      findings: [],
      reviewerMutated: false,
    },
    validation: {
      outcome: "pass",
      headSha,
      completedAt: "2026-08-10T11:55:00.000Z",
      requiredChecks: [
        { name: "unit", bucket: "pass", state: "SUCCESS", link: null },
        { name: "lint", bucket: "pass", state: "SUCCESS", link: null },
      ],
    },
    receipt: {
      jobId: "job-1",
      jobVersion: 7,
      projectId: "project-1",
      environmentId: "env-1",
      prNumber,
      baseBranch: "main",
      headSha,
      reviewAttemptId: "attempt-1",
      validationCompletedAt: "2026-08-10T11:55:00.000Z",
      requiredCheckNames: ["lint", "unit"],
      mergeMethod: "squash",
      expiresAt: "2026-08-10T12:30:00.000Z",
    },
  };
}

function evaluate(input: GateInput = readyInput()) {
  return evaluateMergeGates(input);
}

function expectBlocked(input: GateInput, reason: string) {
  const result = evaluate(input);
  expect(result.ready).toBe(false);
  if (result.ready) throw new Error("expected blocked gate evaluation");
  expect(result.reasons.map(({ code }: { code: string }) => code)).toContain(reason);
}

describe("evaluateMergeGates", () => {
  test("returns a fully bound ready receipt with sorted required checks", () => {
    const result = evaluate();

    expect(result).toEqual({
      ready: true,
      receipt: {
        jobId: "job-1",
        jobVersion: 7,
        projectId: "project-1",
        environmentId: "env-1",
        prNumber,
        baseBranch: "main",
        headSha,
        reviewAttemptId: "attempt-1",
        validationCompletedAt: "2026-08-10T11:55:00.000Z",
        requiredCheckNames: ["lint", "unit"],
        mergeMethod: "squash",
        expiresAt: "2026-08-10T12:30:00.000Z",
      },
    });
  });

  test.each([
    ["project mismatch", (input: any) => (input.projectId = "project-2"), "project_mismatch"],
    ["environment mismatch", (input: any) => (input.environmentId = "env-2"), "environment_mismatch"],
    ["unavailable environment", (input: any) => (input.environment.status = "unavailable"), "environment_unavailable"],
    ["dirty worktree", (input: any) => (input.environment.worktree.clean = false), "worktree_dirty"],
    ["untracked worktree", (input: any) => (input.environment.worktree.untrackedFiles = ["new.txt"]), "worktree_dirty"],
    ["detached checkout", (input: any) => (input.environment.checkout.kind = "detached"), "checkout_not_branch"],
    ["unknown checkout", (input: any) => (input.environment.checkout.kind = "unknown"), "checkout_not_branch"],
    ["origin mismatch", (input: any) => (input.originRepository = "acme/other"), "origin_repository_mismatch"],
    ["missing local head", (input: any) => (input.environment.checkout.headSha = null), "local_head_missing"],
    ["local head mismatch", (input: any) => (input.environment.checkout.headSha = otherSha), "local_head_mismatch"],
    ["absent PR", (input: any) => (input.pullRequest.available = false), "pr_unavailable"],
    ["draft PR", (input: any) => (input.pullRequest.isDraft = true), "pr_draft"],
    ["closed PR", (input: any) => (input.pullRequest.state = "CLOSED"), "pr_closed"],
    ["wrong PR base", (input: any) => (input.pullRequest.baseRefName = "develop"), "pr_base_mismatch"],
    ["conflicting PR", (input: any) => (input.pullRequest.mergeable = "CONFLICTING"), "merge_conflict"],
    ["blocked PR", (input: any) => (input.pullRequest.mergeStateStatus = "BLOCKED"), "merge_blocked"],
    ["unknown mergeability", (input: any) => (input.pullRequest.mergeable = "UNKNOWN"), "mergeability_unknown"],
    ["reviewer mutation", (input: any) => (input.review.reviewerMutated = true), "reviewer_mutated"],
    ["review wrong SHA", (input: any) => (input.review.headSha = otherSha), "review_sha_mismatch"],
    ["review findings", (input: any) => (input.review.findings = [{ severity: "error" }]), "review_findings"],
    ["validation wrong SHA", (input: any) => (input.validation.headSha = otherSha), "validation_sha_mismatch"],
    ["validation failure", (input: any) => (input.validation.outcome = "fail"), "validation_failed"],
    ["stale job version", (input: any) => (input.receipt.jobVersion = 6), "job_version_stale"],
    ["expired receipt", (input: any) => (input.receipt.expiresAt = "2026-08-10T11:59:59.000Z"), "receipt_expired"],
  ])("blocks on the independent %s gate", (_name, mutate, reason) => {
    const input = readyInput();
    mutate(input);
    expectBlocked(input, reason);
  });

  test.each([
    ["missing remote row", [], "remote_head_missing"],
    ["malformed remote row", ["not-a-row"], "remote_head_malformed"],
    ["multiple remote rows", [row(), row()], "remote_head_multiple"],
    ["wrong remote ref", [row(headSha, "refs/pull/18/head")], "remote_head_wrong_ref"],
  ])("blocks on %s", (_name, rows, reason) => {
    const input = readyInput();
    input.remoteHead.first.rows = rows;
    expectBlocked(input, reason);
  });

  test("blocks when the remote head moves during evidence collection", () => {
    const input = readyInput();
    input.remoteHead.second.rows = [row(otherSha)];
    expectBlocked(input, "remote_head_moved");
  });

  test.each([
    ["missing", [], "required_check_missing"],
    ["unknown", [{ name: "lint", bucket: "unknown" }], "required_check_unknown"],
    ["pending", [{ name: "lint", bucket: "pending" }], "required_check_pending"],
    ["failing", [{ name: "lint", bucket: "fail" }], "required_check_failed"],
    ["cancelled", [{ name: "lint", bucket: "cancel" }], "required_check_cancelled"],
  ])("blocks when a required check is %s", (_name, checks, reason) => {
    const input = readyInput();
    input.job.policy.requiredChecks = ["lint"];
    input.validation.requiredChecks = checks;
    expectBlocked(input, reason);
  });

  test("allows an aggregate no_checks result only when no checks are configured", () => {
    const input = readyInput();
    input.job.policy.requiredChecks = [];
    input.validation.requiredChecks = [];
    input.validation.aggregateBucket = "no_checks";

    expect(evaluate(input)).toMatchObject({ ready: true });
  });

  test("blocks aggregate no_checks when a required check is configured", () => {
    const input = readyInput();
    input.job.policy.requiredChecks = ["lint"];
    input.validation.requiredChecks = [];
    input.validation.aggregateBucket = "no_checks";

    expectBlocked(input, "required_check_missing");
  });

  test("uses only parsed ls-remote evidence for head truth, ignoring stale gh metadata", () => {
    const input = readyInput();
    input.githubPr.headRefOid = otherSha;

    const result = evaluate(input);

    expect(result).toMatchObject({ ready: true, receipt: { headSha } });
  });

  test("returns all blocking reasons in stable code order", () => {
    const input = readyInput();
    input.projectId = "project-2";
    input.environment.worktree.clean = false;
    input.review.findings = [{ severity: "error" }];
    input.validation.outcome = "fail";

    const result = evaluate(input);

    expect(result.ready).toBe(false);
    if (result.ready) throw new Error("expected blocked gate evaluation");
    expect(result.reasons.map(({ code }: { code: string }) => code)).toEqual([
      "project_mismatch",
      "worktree_dirty",
      "review_findings",
      "validation_failed",
    ]);
  });
});
