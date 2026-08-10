import { parseLsRemoteHead, type RequiredCheck } from "../bb/validation";

export type GateReasonCode =
  | "project_mismatch"
  | "environment_mismatch"
  | "environment_unavailable"
  | "worktree_dirty"
  | "checkout_not_branch"
  | "origin_repository_mismatch"
  | "local_head_missing"
  | "local_head_mismatch"
  | "remote_head_missing"
  | "remote_head_malformed"
  | "remote_head_multiple"
  | "remote_head_wrong_ref"
  | "remote_head_mismatch"
  | "remote_head_moved"
  | "pr_unavailable"
  | "pr_draft"
  | "pr_closed"
  | "pr_base_mismatch"
  | "merge_conflict"
  | "merge_blocked"
  | "mergeability_unknown"
  | "reviewer_mutated"
  | "review_sha_mismatch"
  | "review_findings"
  | "validation_sha_mismatch"
  | "validation_failed"
  | "required_check_missing"
  | "required_check_unknown"
  | "required_check_pending"
  | "required_check_failed"
  | "required_check_cancelled"
  | "receipt_binding_mismatch"
  | "job_version_stale"
  | "receipt_expired";

export interface GateReason {
  code: GateReasonCode;
  message: string;
}

export interface MergeReadyReceipt {
  jobId: string;
  jobVersion: number;
  projectId: string;
  environmentId: string;
  prNumber: number;
  baseBranch: string;
  headSha: string;
  reviewAttemptId: string;
  validationCompletedAt: string;
  requiredCheckNames: string[];
  mergeMethod: "merge" | "rebase" | "squash";
  expiresAt: string;
}

export type GateEvaluation =
  | { ready: false; reasons: GateReason[] }
  | { ready: true; receipt: MergeReadyReceipt };

export interface GateInput {
  now: string | number | Date;
  projectId: string;
  environmentId: string;
  job: {
    id: string;
    version: number;
    projectId: string;
    environmentId: string;
    prNumber: number;
    policy: {
      githubRepository: string;
      baseBranch: string;
      requiredChecks: string[];
      mergeMethod: "merge" | "rebase" | "squash";
    };
  };
  environment: {
    id: string;
    projectId: string;
    status: string;
    worktree: { clean: boolean; untrackedFiles: string[] };
    checkout: { kind: string; branch?: string; branchName?: string; headSha: string | null };
  };
  originRepository: string;
  remoteHead: {
    first: { rows: string[] };
    second: { rows: string[] };
  };
  pullRequest: {
    available: boolean;
    number: number;
    state: string;
    isDraft: boolean;
    baseRefName: string;
    mergeStateStatus: string;
    mergeable: string | null;
  };
  githubPr: Record<string, unknown>;
  review: {
    attemptId: string;
    headSha: string | null;
    verdict: string;
    findings: unknown[];
    reviewerMutated: boolean;
  };
  validation: {
    outcome: string;
    headSha: string | null;
    completedAt: string;
    requiredChecks: Array<Pick<RequiredCheck, "name" | "bucket"> & Partial<Omit<RequiredCheck, "name" | "bucket">>>;
    aggregateBucket?: string;
  };
  receipt: MergeReadyReceipt;
}

const SHA = /^[0-9a-f]{40}$/;

function reason(code: GateReasonCode, message: string): GateReason {
  return { code, message };
}

function dateValue(value: string | number | Date): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(value);
}

function remoteRows(
  rows: string[],
  prNumber: number,
): { sha: string | null; reason: GateReason | null } {
  if (rows.length === 0) return { sha: null, reason: reason("remote_head_missing", "The remote pull-request head lookup returned no rows") };
  if (rows.length > 1) return { sha: null, reason: reason("remote_head_multiple", "The remote pull-request head lookup returned multiple rows") };
  try {
    return { sha: parseLsRemoteHead(rows[0], prNumber), reason: null };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "wrong_ls_remote_ref") {
      return { sha: null, reason: reason("remote_head_wrong_ref", "The remote head row has the wrong ref name") };
    }
    return { sha: null, reason: reason("remote_head_malformed", "The remote pull-request head row is malformed") };
  }
}

function requiredCheckReason(
  required: string,
  checks: Array<Pick<RequiredCheck, "name" | "bucket"> & Partial<Omit<RequiredCheck, "name" | "bucket">>>,
): GateReason | null {
  const check = checks.find((candidate) => candidate.name === required);
  if (!check) return reason("required_check_missing", `Required check ${required} is missing`);
  switch (check.bucket.toLowerCase()) {
    case "pass":
      return null;
    case "pending":
      return reason("required_check_pending", `Required check ${required} is pending`);
    case "fail":
    case "failure":
      return reason("required_check_failed", `Required check ${required} is failing`);
    case "cancel":
    case "cancelled":
      return reason("required_check_cancelled", `Required check ${required} was cancelled`);
    default:
      return reason("required_check_unknown", `Required check ${required} has an unknown outcome`);
  }
}

function receiptBindingReasons(input: GateInput, headSha: string, requiredCheckNames: string[]): GateReason[] {
  const receipt = input.receipt;
  const expected: Record<string, unknown> = {
    jobId: input.job.id,
    projectId: input.projectId,
    environmentId: input.environmentId,
    prNumber: input.job.prNumber,
    baseBranch: input.job.policy.baseBranch,
    headSha,
    reviewAttemptId: input.review.attemptId,
    validationCompletedAt: input.validation.completedAt,
    mergeMethod: input.job.policy.mergeMethod,
  };
  if (requiredCheckNames.length > 0) expected.requiredCheckNames = requiredCheckNames;
  const mismatched = Object.entries(expected).some(([key, value]) => {
    const actual = receipt[key as keyof MergeReadyReceipt];
    if (Array.isArray(value)) return JSON.stringify(actual) !== JSON.stringify(value);
    return actual !== value;
  });
  return mismatched ? [reason("receipt_binding_mismatch", "The ready receipt is not bound to the current evidence")] : [];
}

export function evaluateMergeGates(input: GateInput): GateEvaluation {
  const reasons: GateReason[] = [];
  const policy = input.job.policy;
  const environment = input.environment;
  const checkout = environment.checkout;
  const localHead = checkout.headSha;

  if (input.projectId !== input.job.projectId || environment.projectId !== input.projectId) {
    reasons.push(reason("project_mismatch", "The evidence is not for the active project"));
  }
  if (input.environmentId !== input.job.environmentId || environment.id !== input.environmentId) {
    reasons.push(reason("environment_mismatch", "The evidence is not for the active environment"));
  }
  if (environment.status !== "available") reasons.push(reason("environment_unavailable", "The environment is not available"));
  if (!environment.worktree.clean || environment.worktree.untrackedFiles.length > 0) {
    reasons.push(reason("worktree_dirty", "The environment worktree has uncommitted or untracked changes"));
  }
  if (checkout.kind !== "branch" || !(checkout.branchName ?? checkout.branch)) {
    reasons.push(reason("checkout_not_branch", "The environment is not checked out on a named branch"));
  }
  if (input.originRepository.toLowerCase() !== policy.githubRepository.toLowerCase()) {
    reasons.push(reason("origin_repository_mismatch", "The origin repository does not match policy"));
  }
  if (localHead === null) reasons.push(reason("local_head_missing", "The environment has no local HEAD"));
  else if (!SHA.test(localHead)) reasons.push(reason("local_head_missing", "The environment HEAD is not a full lowercase SHA"));

  const first = remoteRows(input.remoteHead.first.rows, input.job.prNumber);
  const second = remoteRows(input.remoteHead.second.rows, input.job.prNumber);
  if (first.reason) reasons.push(first.reason);
  if (second.reason) reasons.push(second.reason);
  if (first.sha && second.sha && first.sha !== second.sha) reasons.push(reason("remote_head_moved", "The remote pull-request head moved during collection"));
  const remoteHead = first.sha ?? second.sha;
  if (remoteHead && localHead && remoteHead !== localHead) {
    reasons.push(reason("local_head_mismatch", "Local HEAD does not match the verified remote pull-request head"));
  }

  const pullRequest = input.pullRequest;
  if (!pullRequest.available) reasons.push(reason("pr_unavailable", "The pull request is unavailable"));
  else {
    if (pullRequest.isDraft) reasons.push(reason("pr_draft", "The pull request is still a draft"));
    if (!["OPEN", "open"].includes(pullRequest.state)) reasons.push(reason("pr_closed", "The pull request is not open"));
    if (pullRequest.baseRefName !== policy.baseBranch) reasons.push(reason("pr_base_mismatch", "The pull request targets the wrong base branch"));
    if (pullRequest.mergeable === "CONFLICTING") reasons.push(reason("merge_conflict", "The pull request has merge conflicts"));
    if (pullRequest.mergeStateStatus === "BLOCKED") reasons.push(reason("merge_blocked", "The pull request is blocked from merging"));
    if (pullRequest.mergeable === "UNKNOWN" || pullRequest.mergeable === null) {
      reasons.push(reason("mergeability_unknown", "The pull request mergeability is unknown"));
    }
  }

  if (input.review.reviewerMutated) reasons.push(reason("reviewer_mutated", "The review evidence was changed by the reviewer"));
  if (input.review.headSha !== localHead || input.review.headSha !== remoteHead) {
    reasons.push(reason("review_sha_mismatch", "The review does not cover the verified head SHA"));
  }
  if (input.review.verdict !== "pass") reasons.push(reason("review_findings", "The review did not pass"));
  if (input.review.findings.length > 0) reasons.push(reason("review_findings", "The review contains findings"));

  if (input.validation.headSha !== localHead || input.validation.headSha !== remoteHead) {
    reasons.push(reason("validation_sha_mismatch", "Validation does not cover the verified head SHA"));
  }
  if (input.validation.outcome !== "pass") reasons.push(reason("validation_failed", "Configured validation did not pass"));

  const requiredNames = [...policy.requiredChecks].sort();
  if (requiredNames.length > 0) {
    for (const required of requiredNames) {
      const checkReason = requiredCheckReason(required, input.validation.requiredChecks);
      if (checkReason) reasons.push(checkReason);
    }
  } else if (input.validation.aggregateBucket && input.validation.aggregateBucket !== "no_checks") {
    const aggregate = input.validation.aggregateBucket.toLowerCase();
    if (aggregate !== "pass") reasons.push(reason("required_check_unknown", "The aggregate required-check result is not passing"));
  }

  if (input.job.version !== input.receipt.jobVersion) reasons.push(reason("job_version_stale", "The ready receipt was created for an older job version"));
  if (dateValue(input.receipt.expiresAt) <= dateValue(input.now)) reasons.push(reason("receipt_expired", "The ready receipt has expired"));

  const headForReceipt = remoteHead ?? localHead ?? "";
  if (reasons.length === 0) reasons.push(...receiptBindingReasons(input, headForReceipt, requiredNames));

  if (reasons.length > 0) return { ready: false, reasons };
  return {
    ready: true,
    receipt: {
      jobId: input.job.id,
      jobVersion: input.job.version,
      projectId: input.projectId,
      environmentId: input.environmentId,
      prNumber: input.job.prNumber,
      baseBranch: policy.baseBranch,
      headSha: headForReceipt,
      reviewAttemptId: input.review.attemptId,
      validationCompletedAt: input.validation.completedAt,
      requiredCheckNames: requiredNames,
      mergeMethod: policy.mergeMethod,
      expiresAt: input.receipt.expiresAt,
    },
  };
}
