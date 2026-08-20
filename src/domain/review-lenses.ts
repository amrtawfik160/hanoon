import type { DeliveryMode, ReviewFinding } from "./models";
import { assessReview, reviewVerdictSchema } from "./review";
import {
  assessGuardEnvelope,
  guardAssessmentPolicySchema,
  guardResultEnvelopeSchema,
} from "../capabilities/guards";

/**
 * `quality` and `risk` are the lenses a review group requires. `consensus` is
 * deliberately not one of them: it is a single extra pass, run after the
 * pipeline's own reviews already passed, to stand in for the owner's look at a
 * change that argued with its review. It never joins a required group, and
 * `requiredReviewLenses` never returns it.
 */
export type ReviewLens = "quality" | "risk" | "consensus";

export type ReviewLensAttemptEvidence = Readonly<{
  id: string;
  reviewLens: ReviewLens | null;
  headSha: string | null;
  resultJson: string | null;
}>;

export type ReviewGroupAssessment = Readonly<{
  outcome: "pending" | "pass" | "changes_requested" | "blocked";
  attemptIds: string[];
  findings: ReviewFinding[];
  reasons: string[];
  summary: string | null;
}>;

type SettledLens = Readonly<{
  lens: ReviewLens;
  outcome: "pass" | "changes_requested" | "blocked";
  findings: ReviewFinding[];
  reasons: string[];
  summary: string;
}>;

const LENS_ORDER: Readonly<Record<ReviewLens, number>> = { quality: 0, risk: 1, consensus: 2 };

export function requiredReviewLenses(deliveryMode: DeliveryMode): readonly ReviewLens[] {
  return deliveryMode === "small_fix" ? ["quality"] : ["quality", "risk"];
}

export type ConsensusAssessment = "pending" | "pass" | "not_pass";

/**
 * What one consensus pass says about the exact head it was spawned for.
 *
 * Deliberately strict: only a settled verdict of `pass` carrying no findings at
 * all, for this exact head, counts. Anything else — findings of any severity, a
 * blocked or changes-requested verdict, unreadable evidence, or evidence bound
 * to a different head — is `not_pass`, and the owner is asked. The pass is
 * standing in for a person's judgement, so it has to be unambiguous.
 */
export function assessConsensusReview(
  attempt: ReviewLensAttemptEvidence | null,
  expectedHeadSha: string,
): ConsensusAssessment {
  if (!attempt || attempt.reviewLens !== "consensus") return "pending";
  if (attempt.headSha !== expectedHeadSha) return "not_pass";
  const settled = parseSettledLens({ ...attempt, reviewLens: "consensus" }, expectedHeadSha);
  if (settled === "pending") return "pending";
  if (settled === "invalid") return "not_pass";
  return settled.outcome === "pass" && settled.findings.length === 0 ? "pass" : "not_pass";
}

function blocked(attemptIds: string[], reason: string): ReviewGroupAssessment {
  return {
    outcome: "blocked",
    attemptIds,
    findings: [],
    reasons: [reason],
    summary: null,
  };
}

function parseSettledLens(
  attempt: ReviewLensAttemptEvidence & Readonly<{ reviewLens: ReviewLens }>,
  expectedHeadSha: string,
): SettledLens | "pending" | "invalid" {
  if (attempt.resultJson === null) return "pending";
  let value: unknown;
  try {
    value = JSON.parse(attempt.resultJson);
  } catch {
    return "invalid";
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "invalid";
  const result = value as Record<string, unknown>;
  if (result.outcome === "format_correction_sent") return "pending";

  const reasons = Array.isArray(result.reasons) && result.reasons.every((reason) => typeof reason === "string")
    ? result.reasons as string[]
    : null;
  if (reasons === null) return "invalid";

  if (result.guardEnvelope !== undefined || result.guardPolicy !== undefined) {
    const envelope = guardResultEnvelopeSchema.safeParse(result.guardEnvelope);
    const policy = guardAssessmentPolicySchema.safeParse(result.guardPolicy);
    if (!envelope.success || !policy.success) return "invalid";
    const assessment = assessGuardEnvelope(envelope.data, policy.data);
    const expectedOutcome = assessment.outcome === "blocked"
      ? "blocked"
      : assessment.outcome === "changes_requested"
        ? "changes_requested"
        : "pass";
    if (result.outcome !== expectedOutcome || result.reviewedHeadSha !== envelope.data.reviewedHeadSha ||
      envelope.data.reviewedHeadSha !== expectedHeadSha ||
      JSON.stringify(reasons) !== JSON.stringify(assessment.reasons)) return "invalid";
    return {
      lens: attempt.reviewLens,
      outcome: expectedOutcome,
      findings: assessment.findings.map((finding) => ({
        severity: finding.severity,
        file: finding.subject,
        line: finding.line,
        title: `${finding.capabilityId}:${finding.ruleId}`,
        details: finding.evidence,
      })),
      reasons: [...assessment.reasons],
      summary: `guard assessment ${assessment.outcome}`,
    };
  }

  const verdict = reviewVerdictSchema.safeParse(result.verdict);
  if (!verdict.success) {
    if (result.outcome !== "blocked" || reasons.length === 0) return "invalid";
    return {
      lens: attempt.reviewLens,
      outcome: "blocked",
      findings: [],
      reasons,
      summary: reasons.join("; "),
    };
  }

  const assessment = assessReview(verdict.data, expectedHeadSha);
  if (
    result.outcome !== assessment.outcome ||
    result.reviewedHeadSha !== verdict.data.reviewedHeadSha ||
    (assessment.outcome === "pass" && reasons.length !== 0)
  ) return "invalid";

  return {
    lens: attempt.reviewLens,
    outcome: assessment.outcome,
    findings: assessment.findings,
    reasons,
    summary: verdict.data.summary,
  };
}

export function assessReviewGroup(
  attempts: readonly ReviewLensAttemptEvidence[],
  deliveryMode: DeliveryMode,
  expectedHeadSha: string,
): ReviewGroupAssessment {
  const required = requiredReviewLenses(deliveryMode);
  const ordered = [...attempts].sort((left, right) => {
    const leftOrder = left.reviewLens === null ? 2 : LENS_ORDER[left.reviewLens];
    const rightOrder = right.reviewLens === null ? 2 : LENS_ORDER[right.reviewLens];
    return leftOrder - rightOrder || left.id.localeCompare(right.id);
  });
  const attemptIds = ordered.map((attempt) => attempt.id);
  const byLens = new Map<ReviewLens, ReviewLensAttemptEvidence>();
  for (const attempt of ordered) {
    if (attempt.reviewLens === null || !required.includes(attempt.reviewLens)) {
      return blocked(attemptIds, "review evidence contains an unexpected lens");
    }
    if (byLens.has(attempt.reviewLens)) {
      return blocked(attemptIds, `review evidence contains duplicate ${attempt.reviewLens} lenses`);
    }
    byLens.set(attempt.reviewLens, attempt);
  }
  if (required.some((lens) => !byLens.has(lens))) {
    return { outcome: "pending", attemptIds, findings: [], reasons: [], summary: null };
  }

  const settled: SettledLens[] = [];
  for (const lens of required) {
    const attempt = byLens.get(lens);
    if (!attempt) return { outcome: "pending", attemptIds, findings: [], reasons: [], summary: null };
    if (attempt.headSha !== expectedHeadSha) {
      return blocked(attemptIds, `${lens} review evidence targets a different head`);
    }
    const parsed = parseSettledLens({ ...attempt, reviewLens: lens }, expectedHeadSha);
    if (parsed === "pending") {
      return { outcome: "pending", attemptIds, findings: [], reasons: [], summary: null };
    }
    if (parsed === "invalid") return blocked(attemptIds, `${lens} review evidence is invalid`);
    settled.push(parsed);
  }

  const combinedSummaries = settled.map((lens) => `${lens.lens}: ${lens.summary}`).join("; ");
  const summaries = combinedSummaries.length <= 2_000
    ? combinedSummaries
    : `${combinedSummaries.slice(0, 1_999).trimEnd()}…`;
  const findings = settled.flatMap((lens) => lens.findings).slice(0, 100);
  const reasons = settled.flatMap((lens) => lens.reasons.map((reason) => `${lens.lens}: ${reason}`)).slice(0, 100);
  if (settled.some((lens) => lens.outcome === "blocked")) {
    return { outcome: "blocked", attemptIds, findings, reasons, summary: summaries };
  }
  if (settled.some((lens) => lens.outcome === "changes_requested")) {
    return { outcome: "changes_requested", attemptIds, findings, reasons, summary: summaries };
  }
  return { outcome: "pass", attemptIds, findings, reasons, summary: summaries };
}
