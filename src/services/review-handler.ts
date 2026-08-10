import {
  assessReview,
  InvalidReviewOutputError,
  parseReviewVerdict,
} from "../domain/review";
import type {
  ReviewAssessment,
  ReviewAttemptResult,
  ReviewFinding,
  ReviewVerdict,
} from "../domain/models";
import { buildReviewFormatCorrectionPrompt } from "../bb/prompts";

export interface ReviewThreadClient {
  output(threadId: string): Promise<unknown>;
  send(threadId: string, prompt: string): Promise<void>;
  create(parentThreadId: string, prompt: string): Promise<{ id: string }>;
}

export interface ReviewEnvironmentClient {
  status(): Promise<{
    available: boolean;
    clean: boolean;
    headSha?: string | null;
  }>;
}

export interface ReviewAttemptState {
  threadId?: string | null;
  formatCorrectionSent?: boolean;
  requiresNewHead?: boolean;
  headSha?: string;
  result?: ReviewAttemptResult | null;
}

export interface ReviewAttemptStore {
  get(attemptId: string): Promise<ReviewAttemptState> | ReviewAttemptState;
  update(
    attemptId: string,
    patch: Partial<ReviewAttemptState>,
  ): Promise<void> | void;
  claimFormatCorrection(
    attemptId: string,
    threadId: string,
    headSha: string,
  ): Promise<boolean> | boolean;
}

export interface ReviewHandlerEvent {
  type: "REVIEW_PASSED" | "REVIEW_CHANGES_REQUESTED" | "REVIEW_BLOCKED";
  payload: Record<string, unknown>;
}

export interface ReviewHandlerDependencies {
  threads: ReviewThreadClient;
  environment: ReviewEnvironmentClient;
  attempts: ReviewAttemptStore;
  emit(event: ReviewHandlerEvent): void;
}

export interface ReviewThreadIdleInput {
  attemptId: string;
  reviewThreadId: string;
  implementationThreadId: string;
  expectedSha: string;
}

export interface ReviewCycleInput {
  attemptId: string;
  implementationThreadId: string;
  expectedSha: string;
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

function environmentReason(status: Awaited<ReturnType<ReviewEnvironmentClient["status"]>>, expectedSha: string): string | null {
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

export class ReviewHandler {
  public constructor(private readonly dependencies: ReviewHandlerDependencies) {}

  public async handleThreadIdle(input: ReviewThreadIdleInput): Promise<ReviewHandlerResult> {
    const [status, attempt] = await Promise.all([
      this.dependencies.environment.status(),
      this.dependencies.attempts.get(input.attemptId),
    ]);
    const blockedReason = environmentReason(status, input.expectedSha);
    if (blockedReason) return this.block(input, blockedReason);
    if (attempt.threadId !== input.reviewThreadId || attempt.headSha !== input.expectedSha) {
      return this.block(input, "review attempt is not bound to the exact idle thread and expected head");
    }
    if (attempt.requiresNewHead && attempt.headSha === input.expectedSha) {
      return this.block(input, "a new head is required after changes were requested");
    }

    const rawOutput = await this.dependencies.threads.output(input.reviewThreadId);
    let verdict: ReviewVerdict;
    try {
      verdict = parseReviewVerdict(outputText(rawOutput));
    } catch (error) {
      if (!(error instanceof InvalidReviewOutputError) && !(error instanceof SyntaxError)) throw error;
      return this.handleInvalidOutput(input, attempt);
    }

    const assessment = assessReview(verdict, input.expectedSha);
    if (assessment.outcome === "pass") return this.pass(input, verdict, assessment);
    if (assessment.outcome === "changes_requested") {
      return this.requestChanges(input, verdict, assessment);
    }
    return this.completeBlocked(input, verdict, assessment);
  }

  public async startReviewCycle(input: ReviewCycleInput): Promise<{ reviewThreadId: string }> {
    const prompt = `Review the implementation at exact head ${input.expectedSha} and return one strict JSON verdict.`;
    const thread = await this.dependencies.threads.create(input.implementationThreadId, prompt);
    await this.dependencies.attempts.update(input.attemptId, {
      threadId: thread.id,
      headSha: input.expectedSha,
      formatCorrectionSent: false,
      requiresNewHead: false,
      result: null,
    });
    return { reviewThreadId: thread.id };
  }

  private async claimFormatCorrection(input: ReviewThreadIdleInput): Promise<boolean> {
    return this.dependencies.attempts.claimFormatCorrection(
      input.attemptId,
      input.reviewThreadId,
      input.expectedSha,
    );
  }

  private async handleInvalidOutput(
    input: ReviewThreadIdleInput,
    attempt: ReviewAttemptState,
  ): Promise<ReviewHandlerResult> {
    if (attempt.formatCorrectionSent) {
      return this.block(input, "review output remained invalid after format correction");
    }
    const claimed = await this.claimFormatCorrection(input);
    if (!claimed) return this.block(input, "review output remained invalid after format correction");
    const result: ReviewHandlerResult = {
      outcome: "format_correction_sent",
      reasons: ["review output did not match the strict JSON contract"],
      findings: [],
      reviewedHeadSha: null,
      formatCorrectionSent: true,
    };
    await this.dependencies.threads.send(
      input.reviewThreadId,
      buildReviewFormatCorrectionPrompt(),
    );
    await this.dependencies.attempts.update(input.attemptId, {
      formatCorrectionSent: true,
      result,
    });
    return result;
  }

  private async pass(
    input: ReviewThreadIdleInput,
    verdict: ReviewVerdict,
    assessment: ReviewAssessment,
  ): Promise<ReviewHandlerResult> {
    const result = {
      ...resultFromAssessment(assessment, verdict.reviewedHeadSha),
      verdict,
    };
    await this.dependencies.attempts.update(input.attemptId, {
      threadId: input.reviewThreadId,
      headSha: input.expectedSha,
      requiresNewHead: false,
      result,
    });
    this.dependencies.emit({
      type: "REVIEW_PASSED",
      payload: { headSha: input.expectedSha, verdict },
    });
    return result;
  }

  private async requestChanges(
    input: ReviewThreadIdleInput,
    verdict: ReviewVerdict,
    assessment: ReviewAssessment,
  ): Promise<ReviewHandlerResult> {
    const result = {
      ...resultFromAssessment(assessment, verdict.reviewedHeadSha),
      verdict,
    };
    await this.dependencies.attempts.update(input.attemptId, {
      threadId: input.reviewThreadId,
      headSha: input.expectedSha,
      requiresNewHead: true,
      result,
    });
    this.dependencies.emit({
      type: "REVIEW_CHANGES_REQUESTED",
      payload: {
        headSha: input.expectedSha,
        summary: verdict.summary,
        findings: assessment.findings,
        reasons: assessment.reasons,
      },
    });
    return result;
  }

  private async completeBlocked(
    input: ReviewThreadIdleInput,
    verdict: ReviewVerdict,
    assessment: ReviewAssessment,
  ): Promise<ReviewHandlerResult> {
    const result = {
      ...resultFromAssessment(assessment, verdict.reviewedHeadSha),
      verdict,
    };
    await this.dependencies.attempts.update(input.attemptId, {
      threadId: input.reviewThreadId,
      headSha: input.expectedSha,
      result,
    });
    this.dependencies.emit({
      type: "REVIEW_BLOCKED",
      payload: { headSha: input.expectedSha, reasons: assessment.reasons, verdict },
    });
    return result;
  }

  private async block(
    input: ReviewThreadIdleInput,
    reason: string,
  ): Promise<ReviewHandlerResult> {
    const result: ReviewHandlerResult = {
      outcome: "blocked",
      reasons: [reason],
      findings: [],
      reviewedHeadSha: null,
    };
    await this.dependencies.attempts.update(input.attemptId, {
      result,
    });
    this.dependencies.emit({
      type: "REVIEW_BLOCKED",
      payload: { headSha: input.expectedSha, reasons: result.reasons },
    });
    return result;
  }
}
