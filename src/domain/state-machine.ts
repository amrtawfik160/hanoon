import {
  projectPolicySchema,
  type Job,
  type JobEffect,
  type JobEvent,
  type JobState,
  type ReviewFinding,
  type WorkerLiveness,
} from "./models";

export interface TransitionResult {
  job: Job;
  effects: JobEffect[];
}

export class IllegalTransitionError extends Error {
  public constructor(state: JobState, eventType: JobEvent["type"]) {
    super(`Event ${eventType} is not legal from state ${state}`);
    this.name = "IllegalTransitionError";
  }
}

const HEAD_SHA = /^[0-9a-f]{40}$/;
const MAX_FAILURE_SUMMARY_LENGTH = 500;
const SENSITIVE_FAILURE_PATTERNS = [
  /\bbearer\s+\S+/i,
  /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+/i,
  /\b(?:sk|rk)-[A-Za-z0-9_-]{10,}\b/i,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
];
const ACTIVE_WORKER_STATES = new Set<WorkerLiveness["state"]>([
  "starting",
  "active",
]);

function illegal(job: Job, event: JobEvent): never {
  throw new IllegalTransitionError(job.state, event.type);
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
}

function assertSummary(value: string | undefined, field: string): void {
  if (value !== undefined && (typeof value !== "string" || value.length > 2_000)) {
    throw new TypeError(`${field} must be at most 2000 characters`);
  }
}

export function containsCredentialLikeText(value: string): boolean {
  return SENSITIVE_FAILURE_PATTERNS.some((pattern) => pattern.test(value));
}

export function assertSafeFailureSummary(error: string): void {
  if (typeof error !== "string" || error.length === 0 || error.length > MAX_FAILURE_SUMMARY_LENGTH) {
    throw new TypeError("error must be a non-empty summary of at most 500 characters");
  }
  if (containsCredentialLikeText(error)) {
    throw new TypeError("error must not contain credential-like text");
  }
}

function assertHeadSha(headSha: string): void {
  if (!HEAD_SHA.test(headSha)) throw new TypeError("headSha must be a 40-character lowercase SHA");
}

function emitEffect(
  job: Job,
  effects: JobEffect[],
  kind: JobEffect["kind"],
  payload: Record<string, unknown> = {},
): void {
  effects.push({
    idempotencyKey: `${job.id}:${job.version + 1}:${kind}`,
    jobId: job.id,
    kind,
    payload,
  });
}

function finish(job: Job, effects: JobEffect[], now: number): TransitionResult {
  job.version += 1;
  job.updatedAt = now;
  return { job, effects };
}

function failJob(
  job: Job,
  effects: JobEffect[],
  error: string,
): void {
  assertSafeFailureSummary(error);
  if (["failed", "blocked", "cancelled", "merged", "production_failed", "complete"].includes(job.state)) {
    throw new IllegalTransitionError(job.state, "FAILED");
  }
  job.resumeState = job.state;
  job.lastError = error;
  job.state = "failed";
  emitEffect(job, effects, "render_status");
}

function failOnThread(
  job: Job,
  effects: JobEffect[],
  event: Extract<JobEvent, { type: "THREAD_FAILED" }>,
): void {
  failJob(job, effects, event.error ?? "Worker thread failed");
}

function clearHeadAndReceipts(job: Job, effects: JobEffect[]): void {
  job.prHeadSha = null;
  emitEffect(job, effects, "revoke_approvals");
}

function enterLocatingPr(job: Job, effects: JobEffect[]): void {
  clearHeadAndReceipts(job, effects);
  job.state = "locating_pr";
  emitEffect(job, effects, "inspect_implementation");
}

function invalidateDriftedHead(job: Job, effects: JobEffect[]): void {
  clearHeadAndReceipts(job, effects);
  job.state = "resolving_pr_head";
  emitEffect(job, effects, "resolve_pr_head");
}

function headMatches(job: Job, headSha: string | undefined): boolean {
  return job.prHeadSha !== null && headSha === job.prHeadSha;
}

function retryEffect(job: Job, effects: JobEffect[], resumeState: JobState): void {
  const effectByState: Partial<Record<JobState, JobEffect["kind"]>> = {
    planning: "spawn_plan",
    critiquing: "spawn_critique",
    creating_implementation: "spawn_implementation",
    implementing: "inspect_implementation",
    locating_pr: "inspect_implementation",
    resolving_pr_head: "resolve_pr_head",
    reviewing: "spawn_review",
    remediating: "send_remediation",
    validating: "run_validation",
    documenting: "spawn_docs",
    resolving_docs_head: "resolve_pr_head",
    final_validating: "run_final_validation",
    final_reviewing: "spawn_final_review",
    awaiting_merge_approval: "issue_approval",
    merging: "merge_pr",
    deploying: "deploy_production",
    verifying_production: "verify_production",
  };
  const kind = effectByState[resumeState];
  if (!kind) throw new IllegalTransitionError(job.state, "RETRY");
  emitEffect(job, effects, kind, job.prHeadSha ? { headSha: job.prHeadSha } : {});
}

function stopActiveWorker(
  job: Job,
  effects: JobEffect[],
  worker: WorkerLiveness | null | undefined,
): void {
  if (!worker || worker.jobId !== job.id || !ACTIVE_WORKER_STATES.has(worker.state)) return;
  emitEffect(job, effects, "stop_thread", {
    generation: worker.generation,
    resourceId: worker.resourceId,
    resourceKind: worker.resourceKind,
    workerKind: worker.workerKind,
  });
}

function applyCancellation(
  job: Job,
  event: Extract<JobEvent, { type: "CANCEL_REQUESTED" }>,
  effects: JobEffect[],
  now: number,
): TransitionResult {
  if (["cancelled", "merged", "deploying", "verifying_production", "production_failed", "complete"].includes(job.state)) illegal(job, event);
  if (job.cancelRequestedAt === null) {
    job.cancelRequestedAt = now;
    emitEffect(job, effects, "revoke_approvals");
    const worker = event.activeWorker;
    const workerActive = !!worker && worker.jobId === job.id && ACTIVE_WORKER_STATES.has(worker.state);
    if (workerActive) {
      stopActiveWorker(job, effects, worker);
    } else if (worker !== undefined) {
      // Nothing to stop, and CANCEL_CONFIRMED is otherwise applied only by the
      // stop_thread effect that an idle job never emits. Without this a
      // cancelled-but-idle job sits in "cancel requested" forever: every later
      // event is swallowed below, so it can never reach a terminal state.
      // `undefined` means the caller supplied no evidence either way, so it
      // keeps the conservative wait rather than orphaning a live worker.
      job.state = "cancelled";
      emitEffect(job, effects, "render_status");
    }
  }
  return finish(job, effects, now);
}

function applyCancellationUnconfirmed(
  job: Job,
  event: Extract<JobEvent, { type: "CANCELLATION_UNCONFIRMED" }>,
  effects: JobEffect[],
  now: number,
): TransitionResult {
  if (job.cancelRequestedAt === null || job.state === "cancelled" || job.state === "merged") illegal(job, event);
  const reason = event.reason ?? "Cancellation could not be confirmed while the worker remained active";
  assertSafeFailureSummary(reason);
  job.resumeState = job.state;
  job.state = "blocked";
  job.blockedReason = "cancellation_unconfirmed";
  job.lastError = reason;
  emitEffect(job, effects, "revoke_approvals");
  emitEffect(job, effects, "render_status");
  return finish(job, effects, now);
}

type StateTransitionHandler = (job: Job, event: JobEvent, effects: JobEffect[]) => void;

function transitionAwaitingProject(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type !== "PROJECT_SELECTED") illegal(job, event);
  if (event.projectId !== event.policy.projectId) throw new TypeError("Selected policy project does not match projectId");
  if (!Number.isInteger(event.policyVersion) || event.policyVersion < 1) throw new TypeError("policyVersion must be a positive integer");
  job.policy = projectPolicySchema.parse(event.policy);
  job.projectId = event.projectId;
  job.policyVersion = event.policyVersion;
  job.reviewBlockAt = job.policy.maxReviewCycles;
  job.state = "awaiting_confirmation";
  emitEffect(job, effects, "render_status");
}

function transitionAwaitingConfirmation(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type !== "CONFIRMED") illegal(job, event);
  job.state = "planning";
  emitEffect(job, effects, "spawn_plan", {
    policyVersion: job.policyVersion,
    projectId: job.projectId,
  });
}

function transitionPlanning(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type === "PLAN_CREATED") {
    assertNonEmpty(event.attemptId, "attemptId");
    assertNonEmpty(event.threadId, "threadId");
    assertNonEmpty(event.environmentId, "environmentId");
    job.environmentId = event.environmentId;
    emitEffect(job, effects, "render_status");
    return;
  }
  if (event.type === "PLAN_READY") {
    assertNonEmpty(event.attemptId, "attemptId");
    job.state = "critiquing";
    emitEffect(job, effects, "spawn_critique", { planAttemptId: event.attemptId });
    return;
  }
  illegal(job, event);
}

function transitionCritiquing(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type === "CRITIQUE_PASSED") {
    assertNonEmpty(event.attemptId, "attemptId");
    job.state = "creating_implementation";
    emitEffect(job, effects, "spawn_implementation", { critiqueAttemptId: event.attemptId });
    return;
  }
  if (event.type === "CRITIQUE_NEEDS_REVISION") {
    assertNonEmpty(event.attemptId, "attemptId");
    assertSummary(event.summary, "summary");
    assertNonEmpty(event.summary, "summary");
    job.planCycle += 1;
    if (job.planCycle >= 2) {
      job.state = "blocked";
      job.blockedReason = "review_limit";
      job.lastError = "Plan critique limit reached";
      emitEffect(job, effects, "render_status");
      return;
    }
    job.state = "planning";
    emitEffect(job, effects, "spawn_plan", {
      critiqueAttemptId: event.attemptId,
      summary: event.summary,
    });
    return;
  }
  illegal(job, event);
}

function transitionCreatingImplementation(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type !== "IMPLEMENTATION_CREATED") illegal(job, event);
  assertNonEmpty(event.threadId, "threadId");
  assertNonEmpty(event.environmentId, "environmentId");
  job.implementationThreadId = event.threadId;
  job.environmentId = event.environmentId;
  job.state = "implementing";
  emitEffect(job, effects, "render_status");
}

function transitionImplementing(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type !== "IMPLEMENTATION_IDLE") illegal(job, event);
  enterLocatingPr(job, effects);
}

function transitionLocatingPr(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type === "PR_LOCATED") {
    if (!Number.isInteger(event.number) || event.number < 1) throw new TypeError("PR number must be positive");
    assertNonEmpty(event.url, "url");
    job.prNumber = event.number;
    job.prUrl = event.url;
    job.state = "resolving_pr_head";
    emitEffect(job, effects, "resolve_pr_head", { number: event.number, url: event.url });
    return;
  }
  if (event.type === "PR_MISSING" || event.type === "PR_UNAVAILABLE") {
    failJob(job, effects, event.reason ?? event.type);
    return;
  }
  illegal(job, event);
}

function transitionResolvingPrHead(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type === "PR_MISSING" || event.type === "PR_UNAVAILABLE") {
    failJob(job, effects, event.reason ?? event.type);
    return;
  }
  if (event.type !== "PR_HEAD_RESOLVED") illegal(job, event);
  assertHeadSha(event.headSha);
  job.prHeadSha = event.headSha;
  job.state = "validating";
  emitEffect(job, effects, "run_validation", { headSha: event.headSha });
}

function transitionReviewPassed(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type !== "REVIEW_PASSED") illegal(job, event);
  assertHeadSha(event.headSha);
  if (!headMatches(job, event.headSha)) {
    invalidateDriftedHead(job, effects);
    return;
  }
  job.state = "documenting";
  emitEffect(job, effects, "spawn_docs", { headSha: event.headSha });
}

function enterPatch(
  job: Job,
  effects: JobEffect[],
  summary: string,
  evidence: { findings?: ReviewFinding[]; reasons?: string[] } = {},
): void {
  assertSummary(summary, "summary");
  job.reviewCycle += 1;
  if (job.reviewCycle >= job.reviewBlockAt) {
    job.state = "blocked";
    job.blockedReason = "review_limit";
    job.lastError = "Patch, test, and review limit reached";
    emitEffect(job, effects, "render_status");
    return;
  }
  job.state = "remediating";
  emitEffect(job, effects, "send_remediation", {
    summary,
    findings: evidence.findings?.slice(0, 20) ?? [],
    reasons: evidence.reasons?.slice(0, 20) ?? [],
  });
}

function transitionReviewChanges(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type !== "REVIEW_CHANGES_REQUESTED") illegal(job, event);
  assertSummary(event.summary, "summary");
  if (!headMatches(job, event.headSha)) {
    invalidateDriftedHead(job, effects);
    return;
  }
  enterPatch(job, effects, event.summary ?? "Review requested changes", {
    findings: event.findings,
    reasons: event.reasons,
  });
}

function transitionReviewing(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type === "REVIEW_STARTED") return;
  if (event.type === "REVIEW_PASSED") {
    transitionReviewPassed(job, event, effects);
    return;
  }
  if (event.type === "REVIEW_CHANGES_REQUESTED") {
    transitionReviewChanges(job, event, effects);
    return;
  }
  if (event.type === "REVIEW_BLOCKED") {
    job.state = "blocked";
    job.blockedReason = event.reason ?? "configuration";
    emitEffect(job, effects, "render_status");
    return;
  }
  illegal(job, event);
}

function transitionRemediating(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type === "REMEDIATION_SENT") {
    job.state = "implementing";
    return;
  }
  if (event.type === "IMPLEMENTATION_IDLE") {
    enterLocatingPr(job, effects);
    return;
  }
  illegal(job, event);
}

function transitionValidationPassed(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type !== "VALIDATION_PASSED") illegal(job, event);
  assertHeadSha(event.headSha);
  if (!headMatches(job, event.headSha)) {
    invalidateDriftedHead(job, effects);
    return;
  }
  job.state = "reviewing";
  emitEffect(job, effects, "spawn_review", { headSha: event.headSha });
}

function transitionValidationFailed(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type !== "VALIDATION_FAILED") illegal(job, event);
  if (event.headSha !== undefined) {
    assertHeadSha(event.headSha);
    if (!headMatches(job, event.headSha)) {
      invalidateDriftedHead(job, effects);
      return;
    }
  }
  enterPatch(job, effects, event.reason ?? "Validation failed");
}

function transitionValidating(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type === "VALIDATION_PASSED") {
    transitionValidationPassed(job, event, effects);
    return;
  }
  if (event.type === "VALIDATION_FAILED") {
    transitionValidationFailed(job, event, effects);
    return;
  }
  illegal(job, event);
}

function transitionDocumenting(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type === "DOCS_CREATED") {
    assertNonEmpty(event.attemptId, "attemptId");
    assertNonEmpty(event.threadId, "threadId");
    assertNonEmpty(event.environmentId, "environmentId");
    if (job.environmentId !== event.environmentId) throw new TypeError("Docs must reuse the implementation environment");
    job.documentationThreadId = event.threadId;
    emitEffect(job, effects, "render_status");
    return;
  }
  if (event.type === "DOCS_IDLE") {
    clearHeadAndReceipts(job, effects);
    job.state = "resolving_docs_head";
    emitEffect(job, effects, "resolve_pr_head", job.prNumber ? { number: job.prNumber } : {});
    return;
  }
  illegal(job, event);
}

function transitionResolvingDocsHead(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type === "PR_MISSING" || event.type === "PR_UNAVAILABLE") {
    failJob(job, effects, event.reason ?? event.type);
    return;
  }
  if (event.type !== "PR_HEAD_RESOLVED") illegal(job, event);
  assertHeadSha(event.headSha);
  job.prHeadSha = event.headSha;
  job.state = "final_validating";
  emitEffect(job, effects, "run_final_validation", { headSha: event.headSha });
}

function transitionFinalValidating(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type === "VALIDATION_PASSED") {
    assertHeadSha(event.headSha);
    if (!headMatches(job, event.headSha)) {
      invalidateDriftedHead(job, effects);
      return;
    }
    job.state = "final_reviewing";
    emitEffect(job, effects, "spawn_final_review", { headSha: event.headSha });
    return;
  }
  if (event.type === "VALIDATION_FAILED") {
    transitionValidationFailed(job, event, effects);
    return;
  }
  illegal(job, event);
}

function transitionFinalReviewing(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type === "REVIEW_STARTED") return;
  if (event.type === "REVIEW_PASSED") {
    assertHeadSha(event.headSha);
    if (!headMatches(job, event.headSha)) {
      invalidateDriftedHead(job, effects);
      return;
    }
    if (!job.policy?.production) {
      job.state = "blocked";
      job.blockedReason = "configuration";
      job.lastError = "Production deployment and canary are not configured";
      emitEffect(job, effects, "render_status");
      return;
    }
    job.state = "awaiting_merge_approval";
    emitEffect(job, effects, "issue_approval", { headSha: event.headSha });
    return;
  }
  if (event.type === "REVIEW_CHANGES_REQUESTED") {
    transitionReviewChanges(job, event, effects);
    return;
  }
  if (event.type === "REVIEW_BLOCKED") {
    job.state = "blocked";
    job.blockedReason = event.reason ?? "configuration";
    emitEffect(job, effects, "render_status");
    return;
  }
  illegal(job, event);
}

function transitionApprovalAccepted(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type !== "APPROVAL_ACCEPTED") illegal(job, event);
  assertHeadSha(event.headSha);
  if (!headMatches(job, event.headSha)) {
    invalidateDriftedHead(job, effects);
    return;
  }
  job.state = "merging";
  emitEffect(job, effects, "merge_pr", { headSha: event.headSha });
}

function transitionAwaitingMergeApproval(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type === "APPROVAL_ACCEPTED") {
    transitionApprovalAccepted(job, event, effects);
    return;
  }
  if (event.type === "APPROVAL_STALE") {
    if (event.headSha !== undefined) assertHeadSha(event.headSha);
    invalidateDriftedHead(job, effects);
    return;
  }
  illegal(job, event);
}

function transitionMerging(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type === "MERGE_SUCCEEDED") {
    assertSummary(event.message, "message");
    assertNonEmpty(event.message, "message");
    assertHeadSha(event.mergeCommitSha);
    if (event.mergedAt.length > 128 || !Number.isFinite(Date.parse(event.mergedAt))) {
      throw new TypeError("mergedAt must be a bounded timestamp");
    }
    job.mergeMessage = event.message;
    job.mergeCommitSha = event.mergeCommitSha;
    job.mergedAt = event.mergedAt;
    if (!event.baseContentVerified) {
      enterProductionIncident(job, effects, "Merge succeeded but the base branch did not verify the approved content");
      return;
    }
    if (!job.policy?.production) {
      enterProductionIncident(job, effects, "Merge succeeded but production deployment and canary are not configured");
      return;
    }
    job.state = "deploying";
    emitEffect(job, effects, "render_status");
    emitEffect(job, effects, "deploy_production");
    return;
  }
  if (event.type === "MERGE_FAILED") {
    failJob(job, effects, event.reason ?? "Merge failed");
    return;
  }
  illegal(job, event);
}

function enterProductionIncident(job: Job, effects: JobEffect[], reason: string): void {
  assertSafeFailureSummary(reason);
  job.lastError = reason;
  job.state = "production_failed";
  emitEffect(job, effects, "render_status");
}

function transitionDeploying(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type === "DEPLOY_SUCCEEDED") {
    assertSummary(event.summary, "summary");
    assertNonEmpty(event.summary, "summary");
    job.deploymentSummary = event.summary;
    job.state = "verifying_production";
    emitEffect(job, effects, "render_status");
    emitEffect(job, effects, "verify_production");
    return;
  }
  if (event.type === "DEPLOY_FAILED") {
    enterProductionIncident(job, effects, event.reason);
    return;
  }
  illegal(job, event);
}

function transitionVerifyingProduction(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type === "CANARY_SUCCEEDED") {
    assertSummary(event.summary, "summary");
    assertNonEmpty(event.summary, "summary");
    job.canarySummary = event.summary;
    job.state = "complete";
    emitEffect(job, effects, "render_status");
    return;
  }
  if (event.type === "CANARY_FAILED") {
    enterProductionIncident(job, effects, event.reason);
    return;
  }
  illegal(job, event);
}

function transitionFailed(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type !== "RETRY" || job.resumeState === null) illegal(job, event);
  const resumeState = job.resumeState;
  job.state = resumeState;
  job.resumeState = null;
  job.lastError = null;
  retryEffect(job, effects, resumeState);
}

function transitionBlocked(job: Job, event: JobEvent, effects: JobEffect[]): void {
  if (event.type !== "CONTINUE_REVIEW" || job.blockedReason !== "review_limit") illegal(job, event);
  job.blockedReason = null;
  job.reviewBlockAt = job.reviewCycle + 3;
  job.state = "reviewing";
  emitEffect(job, effects, "spawn_review", job.prHeadSha ? { headSha: job.prHeadSha } : {});
}

function transitionTerminal(job: Job, event: JobEvent): void {
  illegal(job, event);
}

const STATE_HANDLERS: Record<JobState, StateTransitionHandler> = {
  awaiting_project: transitionAwaitingProject,
  awaiting_confirmation: transitionAwaitingConfirmation,
  planning: transitionPlanning,
  critiquing: transitionCritiquing,
  creating_implementation: transitionCreatingImplementation,
  implementing: transitionImplementing,
  locating_pr: transitionLocatingPr,
  resolving_pr_head: transitionResolvingPrHead,
  reviewing: transitionReviewing,
  remediating: transitionRemediating,
  validating: transitionValidating,
  documenting: transitionDocumenting,
  resolving_docs_head: transitionResolvingDocsHead,
  final_validating: transitionFinalValidating,
  final_reviewing: transitionFinalReviewing,
  awaiting_merge_approval: transitionAwaitingMergeApproval,
  merging: transitionMerging,
  deploying: transitionDeploying,
  verifying_production: transitionVerifyingProduction,
  production_failed: transitionTerminal,
  complete: transitionTerminal,
  failed: transitionFailed,
  blocked: transitionBlocked,
  cancelled: transitionTerminal,
  merged: transitionTerminal,
};

export function transition(job: Job, event: JobEvent, now: number): TransitionResult {
  const next = structuredClone(job);
  const effects: JobEffect[] = [];

  if (event.type === "CANCEL_REQUESTED") return applyCancellation(next, event, effects, now);
  if (event.type === "CANCEL_CONFIRMED") {
    if (next.cancelRequestedAt === null || ["cancelled", "merged", "production_failed", "complete"].includes(next.state)) illegal(next, event);
    next.state = "cancelled";
    emitEffect(next, effects, "render_status");
    return finish(next, effects, now);
  }
  if (event.type === "CANCELLATION_UNCONFIRMED") {
    return applyCancellationUnconfirmed(next, event, effects, now);
  }
  if (next.cancelRequestedAt !== null) return finish(next, [], now);
  if (event.type === "FAILED") {
    failJob(next, effects, event.error);
    return finish(next, effects, now);
  }
  if (event.type === "THREAD_FAILED") {
    failOnThread(next, effects, event);
    return finish(next, effects, now);
  }

  STATE_HANDLERS[next.state](next, event, effects);
  return finish(next, effects, now);
}
