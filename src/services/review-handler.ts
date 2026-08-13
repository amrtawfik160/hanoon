import {
  assessReview,
  InvalidReviewOutputError,
  parseGuardResultEnvelope,
  parseReviewVerdict,
} from "../domain/review";
import {
  assessGuardEnvelope,
  type GuardAssessmentPolicy,
  type GuardEnvelopeAssessment,
  type GuardResultEnvelope,
} from "../capabilities/guards";
import type {
  ReviewAssessment,
  ReviewAttemptResult,
  ReviewVerdict,
} from "../domain/models";
import { buildReviewFormatCorrectionPrompt } from "../bb/prompts";

export interface ReviewThreadClient {
  output(threadId: string, signal?: AbortSignal): Promise<unknown>;
  send(threadId: string, prompt: string, signal?: AbortSignal): Promise<void>;
  create(parentThreadId: string, prompt: string, signal?: AbortSignal): Promise<{ id: string }>;
}

export type ReviewEnvironmentStatusInput = Readonly<{
  environmentId: string;
  mergeBaseBranch: string;
  signal: AbortSignal;
}>;

export type ReviewEnvironmentStatus = Readonly<{
  available: boolean;
  clean: boolean;
  headSha?: string | null;
}>;

export interface ReviewEnvironmentClient {
  status(input: ReviewEnvironmentStatusInput): Promise<ReviewEnvironmentStatus>;
}

export interface ReviewAttemptState {
  threadId?: string | null;
  formatCorrectionSent?: boolean;
  requiresNewHead?: boolean;
  headSha?: string;
  result?: ReviewAttemptResult | null;
}

export type ReviewAttemptLookup = Readonly<{
  jobId: string;
  attemptId: string;
  signal: AbortSignal;
}>;

export type ReviewAttemptUpdate = Readonly<ReviewAttemptLookup & {
  patch: Partial<ReviewAttemptState>;
}>;

export type ReviewFormatCorrectionClaim = Readonly<ReviewAttemptLookup & {
  threadId: string;
  headSha: string;
}>;

export interface ReviewAttemptStore {
  get(input: ReviewAttemptLookup): Promise<ReviewAttemptState> | ReviewAttemptState;
  update(input: ReviewAttemptUpdate): Promise<void> | void;
  claimFormatCorrection(input: ReviewFormatCorrectionClaim): Promise<boolean> | boolean;
}

export interface LegacyReviewEnvironmentClient {
  status(): Promise<ReviewEnvironmentStatus>;
}

export interface LegacyReviewAttemptStore {
  get(attemptId: string): Promise<ReviewAttemptState> | ReviewAttemptState;
  update(attemptId: string, patch: Partial<ReviewAttemptState>): Promise<void> | void;
  claimFormatCorrection(attemptId: string, threadId: string, headSha: string): Promise<boolean> | boolean;
}

export interface ReviewHandlerEvent {
  type: "REVIEW_PASSED" | "REVIEW_CHANGES_REQUESTED" | "REVIEW_BLOCKED";
  payload: Record<string, unknown>;
}

export interface ReviewHandlerInvocationDependencies {
  threads: ReviewThreadClient;
  environment: ReviewEnvironmentClient;
  attempts: ReviewAttemptStore;
  guards?: ReviewGuardSettlement;
  emit?: never;
}

export type ReviewGuardSettlementInput = Readonly<{
  invocation: ReviewInvocation;
  envelope: GuardResultEnvelope;
  policy: GuardAssessmentPolicy;
  assessment: GuardEnvelopeAssessment;
}>;

export interface ReviewGuardSettlement {
  settle(input: ReviewGuardSettlementInput): Promise<GuardEnvelopeAssessment> | GuardEnvelopeAssessment;
  block(input: Readonly<{
    invocation: ReviewInvocation;
    policy: GuardAssessmentPolicy;
    reasonCode: string;
  }>): Promise<void> | void;
}

export interface ReviewHandlerLegacyDependencies {
  threads: ReviewThreadClient;
  environment: LegacyReviewEnvironmentClient;
  attempts: LegacyReviewAttemptStore;
  emit: (event: ReviewHandlerEvent) => void;
}

export type ReviewHandlerDependencies = ReviewHandlerInvocationDependencies | ReviewHandlerLegacyDependencies;

export type ReviewInvocation = Readonly<{
  jobId: string;
  attemptId: string;
  reviewThreadId: string;
  implementationThreadId: string;
  environmentId: string;
  mergeBaseBranch: string;
  expectedSha: string;
  guardPolicy?: GuardAssessmentPolicy;
  signal: AbortSignal;
}>;

export type ReviewHandlerCompletion = Readonly<{
  result: ReviewHandlerResult;
  event: ReviewHandlerEvent | null;
}>;

export class ReviewInvocationStaleError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReviewInvocationStaleError";
  }
}

/** @deprecated Use ReviewInvocation for executor-owned review reconciliation. */
export interface ReviewThreadIdleInput {
  attemptId: string;
  reviewThreadId: string;
  implementationThreadId: string;
  expectedSha: string;
}

export interface ReviewCycleInput {
  jobId?: string;
  attemptId: string;
  implementationThreadId: string;
  expectedSha: string;
  signal?: AbortSignal;
}

export type ReviewHandlerResult = ReviewAttemptResult & {
  verdict?: ReviewVerdict;
};

function resultFromAssessment(
  assessment: ReviewAssessment,
  reviewedHeadSha: string | null,
): ReviewHandlerResult {
  return { ...assessment, reviewedHeadSha };
}

function environmentReason(status: ReviewEnvironmentStatus, expectedSha: string): string | null {
  if (!status.available) return "review environment status is unavailable";
  if (!status.clean) return "review environment worktree is dirty";
  if (status.headSha !== expectedSha) return "review environment HEAD differs from the pre-review SHA";
  return null;
}

function outputText(rawOutput: unknown): string {
  if (typeof rawOutput === "string") return rawOutput;
  if (typeof rawOutput !== "object" || rawOutput === null) {
    throw new InvalidReviewOutputError("BB thread output is not text");
  }
  const record = rawOutput as Record<string, unknown>;
  for (const field of ["output", "text", "content"]) {
    if (typeof record[field] === "string") return record[field];
  }
  throw new InvalidReviewOutputError("BB thread output does not contain text");
}

function isInvocation(input: ReviewInvocation | ReviewThreadIdleInput): input is ReviewInvocation {
  return "jobId" in input && "environmentId" in input && "mergeBaseBranch" in input && "signal" in input;
}

export class ReviewHandler {
  private readonly legacy: boolean;
  private readonly dependencies: ReviewHandlerDependencies;

  public constructor(dependencies: ReviewHandlerInvocationDependencies);
  public constructor(dependencies: ReviewHandlerLegacyDependencies);
  public constructor(dependencies: ReviewHandlerDependencies) {
    this.dependencies = dependencies;
    this.legacy = typeof dependencies.emit === "function";
  }

  public async handleThreadIdle(input: ReviewInvocation): Promise<ReviewHandlerCompletion>;
  /** @deprecated Use the invocation-scoped overload. */
  public async handleThreadIdle(input: ReviewThreadIdleInput): Promise<ReviewHandlerResult>;
  public async handleThreadIdle(
    input: ReviewInvocation | ReviewThreadIdleInput,
  ): Promise<ReviewHandlerCompletion | ReviewHandlerResult> {
    const invocation = isInvocation(input) ? input : this.legacyInvocation(input);
    const completion = await this.handleInvocation(invocation);
    if (isInvocation(input)) return completion;
    return completion.result;
  }

  public async startReviewCycle(input: ReviewCycleInput): Promise<{ reviewThreadId: string }> {
    const signal = input.signal ?? new AbortController().signal;
    this.assertActive(signal);
    const prompt = `Review the implementation at exact head ${input.expectedSha} and return one strict JSON verdict.`;
    const thread = await this.dependencies.threads.create(input.implementationThreadId, prompt, signal);
    this.assertActive(signal);
    if (!this.legacy && !input.jobId) throw new TypeError("review cycle jobId is required");
    await this.updateAttempt({
      jobId: input.jobId ?? "legacy-review-job",
      attemptId: input.attemptId,
      signal,
      patch: {
        threadId: thread.id,
        headSha: input.expectedSha,
        formatCorrectionSent: false,
        requiresNewHead: false,
        result: null,
      },
    });
    return { reviewThreadId: thread.id };
  }

  private legacyInvocation(input: ReviewThreadIdleInput): ReviewInvocation {
    return {
      jobId: "legacy-review-job",
      attemptId: input.attemptId,
      reviewThreadId: input.reviewThreadId,
      implementationThreadId: input.implementationThreadId,
      environmentId: "legacy-review-environment",
      mergeBaseBranch: "legacy-review-branch",
      expectedSha: input.expectedSha,
      signal: new AbortController().signal,
    };
  }

  private async handleInvocation(input: ReviewInvocation): Promise<ReviewHandlerCompletion> {
    this.assertActive(input.signal);
    const [status, attempt] = await Promise.all([
      this.environmentStatus(input),
      this.getAttempt(input),
    ]);
    this.assertActive(input.signal);
    const blockedReason = environmentReason(status, input.expectedSha);
    if (blockedReason) return this.block(input, blockedReason);
    if (attempt.threadId !== input.reviewThreadId || attempt.headSha !== input.expectedSha) {
      return this.block(input, "review attempt is not bound to the exact idle thread and expected head");
    }
    if (attempt.requiresNewHead && attempt.headSha === input.expectedSha) {
      return this.block(input, "a new head is required after changes were requested");
    }

    this.assertActive(input.signal);
    const rawOutput = await this.dependencies.threads.output(input.reviewThreadId, input.signal);
    this.assertActive(input.signal);
    let text: string;
    try {
      text = outputText(rawOutput);
    } catch (error) {
      if (!(error instanceof InvalidReviewOutputError) && !(error instanceof SyntaxError)) throw error;
      return this.handleInvalidOutput(input, attempt);
    }
    if (input.guardPolicy !== undefined) {
      let envelope: GuardResultEnvelope;
      try {
        envelope = parseGuardResultEnvelope(text);
      } catch (error) {
        if (!(error instanceof InvalidReviewOutputError) && !(error instanceof SyntaxError)) throw error;
        return this.handleInvalidOutput(input, attempt);
      }
      let guardAssessment = assessGuardEnvelope(envelope, input.guardPolicy);
      const guards = !this.legacy && "guards" in this.dependencies
        ? this.dependencies.guards
        : undefined;
      if (guards) {
        this.assertActive(input.signal);
        guardAssessment = await guards.settle({
          invocation: input,
          envelope,
          policy: input.guardPolicy,
          assessment: guardAssessment,
        });
        this.assertActive(input.signal);
      }
      return this.completeGuard(input, envelope, input.guardPolicy, guardAssessment);
    }

    let verdict: ReviewVerdict;
    try {
      verdict = parseReviewVerdict(text);
    } catch (error) {
      if (!(error instanceof InvalidReviewOutputError) && !(error instanceof SyntaxError)) throw error;
      return this.handleInvalidOutput(input, attempt);
    }

    const assessment = assessReview(verdict, input.expectedSha);
    if (assessment.outcome === "pass") return this.pass(input, verdict, assessment);
    if (assessment.outcome === "changes_requested") return this.requestChanges(input, verdict, assessment);
    return this.completeBlocked(input, verdict, assessment);
  }

  private async completeGuard(
    input: ReviewInvocation,
    envelope: GuardResultEnvelope,
    policy: GuardAssessmentPolicy,
    assessment: GuardEnvelopeAssessment,
  ): Promise<ReviewHandlerCompletion> {
    const findings = assessment.findings.map((finding) => ({
      severity: finding.severity,
      file: finding.subject,
      line: finding.line,
      title: `${finding.capabilityId}:${finding.ruleId}`,
      details: finding.evidence,
    }));
    const outcome = assessment.outcome === "blocked"
      ? "blocked" as const
      : assessment.outcome === "changes_requested"
        ? "changes_requested" as const
        : "pass" as const;
    const result: ReviewHandlerResult = {
      outcome,
      reasons: [...assessment.reasons],
      findings,
      reviewedHeadSha: envelope.reviewedHeadSha,
      guardEnvelope: envelope,
      guardPolicy: policy,
      guardAssessment: assessment,
    };
    await this.updateAttempt({
      jobId: input.jobId,
      attemptId: input.attemptId,
      signal: input.signal,
      patch: {
        threadId: input.reviewThreadId,
        headSha: input.expectedSha,
        requiresNewHead: outcome === "changes_requested",
        result,
      },
    });
    if (outcome === "pass") {
      return this.completion(result, {
        type: "REVIEW_PASSED",
        payload: { headSha: input.expectedSha, guardAssessment: assessment.outcome },
      });
    }
    if (outcome === "changes_requested") {
      return this.completion(result, {
        type: "REVIEW_CHANGES_REQUESTED",
        payload: {
          headSha: input.expectedSha,
          summary: "Mandatory guard findings require remediation",
          findings,
          reasons: result.reasons,
        },
      });
    }
    return this.completion(result, {
      type: "REVIEW_BLOCKED",
      payload: { headSha: input.expectedSha, reasons: result.reasons },
    });
  }

  private async environmentStatus(input: ReviewInvocation): Promise<ReviewEnvironmentStatus> {
    this.assertActive(input.signal);
    const status = this.legacy
      ? await (this.dependencies.environment as LegacyReviewEnvironmentClient).status()
      : await (this.dependencies.environment as ReviewEnvironmentClient).status({
          environmentId: input.environmentId,
          mergeBaseBranch: input.mergeBaseBranch,
          signal: input.signal,
        });
    this.assertActive(input.signal);
    return status;
  }

  private async getAttempt(input: ReviewInvocation): Promise<ReviewAttemptState> {
    this.assertActive(input.signal);
    const attempt = this.legacy
      ? await (this.dependencies.attempts as LegacyReviewAttemptStore).get(input.attemptId)
      : await (this.dependencies.attempts as ReviewAttemptStore).get({
          jobId: input.jobId,
          attemptId: input.attemptId,
          signal: input.signal,
        });
    this.assertActive(input.signal);
    return attempt;
  }

  private async updateAttempt(input: ReviewAttemptUpdate): Promise<void> {
    this.assertActive(input.signal);
    if (this.legacy) {
      await (this.dependencies.attempts as LegacyReviewAttemptStore).update(input.attemptId, input.patch);
    } else {
      await (this.dependencies.attempts as ReviewAttemptStore).update(input);
    }
    this.assertActive(input.signal);
  }

  private async claimFormatCorrection(input: ReviewFormatCorrectionClaim): Promise<boolean> {
    this.assertActive(input.signal);
    const claimed = this.legacy
      ? await (this.dependencies.attempts as LegacyReviewAttemptStore).claimFormatCorrection(
          input.attemptId,
          input.threadId,
          input.headSha,
        )
      : await (this.dependencies.attempts as ReviewAttemptStore).claimFormatCorrection(input);
    this.assertActive(input.signal);
    return claimed;
  }

  private async handleInvalidOutput(
    input: ReviewInvocation,
    attempt: ReviewAttemptState,
  ): Promise<ReviewHandlerCompletion> {
    if (attempt.formatCorrectionSent) {
      return this.block(input, "review output remained invalid after format correction");
    }
    const claimed = await this.claimFormatCorrection({
      jobId: input.jobId,
      attemptId: input.attemptId,
      threadId: input.reviewThreadId,
      headSha: input.expectedSha,
      signal: input.signal,
    });
    if (!claimed) return this.block(input, "review output remained invalid after format correction");
    const result: ReviewHandlerResult = {
      outcome: "format_correction_sent",
      reasons: ["review output did not match the strict JSON contract"],
      findings: [],
      reviewedHeadSha: null,
      formatCorrectionSent: true,
    };
    this.assertActive(input.signal);
    await this.dependencies.threads.send(
      input.reviewThreadId,
      buildReviewFormatCorrectionPrompt(),
      input.signal,
    );
    await this.updateAttempt({
      jobId: input.jobId,
      attemptId: input.attemptId,
      signal: input.signal,
      patch: { formatCorrectionSent: true, result },
    });
    return this.completion(result, null);
  }

  private async pass(
    input: ReviewInvocation,
    verdict: ReviewVerdict,
    assessment: ReviewAssessment,
  ): Promise<ReviewHandlerCompletion> {
    const result = {
      ...resultFromAssessment(assessment, verdict.reviewedHeadSha),
      verdict,
    };
    await this.updateAttempt({
      jobId: input.jobId,
      attemptId: input.attemptId,
      signal: input.signal,
      patch: {
        threadId: input.reviewThreadId,
        headSha: input.expectedSha,
        requiresNewHead: false,
        result,
      },
    });
    return this.completion(result, {
      type: "REVIEW_PASSED",
      payload: { headSha: input.expectedSha, verdict },
    });
  }

  private async requestChanges(
    input: ReviewInvocation,
    verdict: ReviewVerdict,
    assessment: ReviewAssessment,
  ): Promise<ReviewHandlerCompletion> {
    const result = {
      ...resultFromAssessment(assessment, verdict.reviewedHeadSha),
      verdict,
    };
    await this.updateAttempt({
      jobId: input.jobId,
      attemptId: input.attemptId,
      signal: input.signal,
      patch: {
        threadId: input.reviewThreadId,
        headSha: input.expectedSha,
        requiresNewHead: true,
        result,
      },
    });
    return this.completion(result, {
      type: "REVIEW_CHANGES_REQUESTED",
      payload: {
        headSha: input.expectedSha,
        summary: verdict.summary,
        findings: assessment.findings,
        reasons: assessment.reasons,
      },
    });
  }

  private async completeBlocked(
    input: ReviewInvocation,
    verdict: ReviewVerdict,
    assessment: ReviewAssessment,
  ): Promise<ReviewHandlerCompletion> {
    const result = {
      ...resultFromAssessment(assessment, verdict.reviewedHeadSha),
      verdict,
    };
    await this.updateAttempt({
      jobId: input.jobId,
      attemptId: input.attemptId,
      signal: input.signal,
      patch: {
        threadId: input.reviewThreadId,
        headSha: input.expectedSha,
        result,
      },
    });
    return this.completion(result, {
      type: "REVIEW_BLOCKED",
      payload: { headSha: input.expectedSha, reasons: assessment.reasons, verdict },
    });
  }

  private async block(input: ReviewInvocation, reason: string): Promise<ReviewHandlerCompletion> {
    const guards = !this.legacy && "guards" in this.dependencies
      ? this.dependencies.guards
      : undefined;
    if (input.guardPolicy !== undefined && guards) {
      this.assertActive(input.signal);
      await guards.block({
        invocation: input,
        policy: input.guardPolicy,
        reasonCode: "guard_review_blocked",
      });
      this.assertActive(input.signal);
    }
    const result: ReviewHandlerResult = {
      outcome: "blocked",
      reasons: [reason],
      findings: [],
      reviewedHeadSha: null,
    };
    await this.updateAttempt({
      jobId: input.jobId,
      attemptId: input.attemptId,
      signal: input.signal,
      patch: { result },
    });
    return this.completion(result, {
      type: "REVIEW_BLOCKED",
      payload: { headSha: input.expectedSha, reasons: result.reasons },
    });
  }

  private completion(result: ReviewHandlerResult, event: ReviewHandlerEvent | null): ReviewHandlerCompletion {
    if (this.legacy && event) this.dependencies.emit?.(event);
    return { result, event };
  }

  private assertActive(signal: AbortSignal): void {
    if (!signal.aborted) return;
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error("review invocation was aborted");
  }
}
