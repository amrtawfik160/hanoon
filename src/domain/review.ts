import { z } from "zod";
import {
  guardResultEnvelopeSchema,
  type GuardResultEnvelope,
} from "../capabilities/guards";
import type {
  ReviewAssessment,
  ReviewCheck,
  ReviewFinding,
  ReviewSeverity,
  ReviewVerdict,
} from "./models";

const reviewFindingSchema = z
  .object({
    severity: z.enum(["critical", "high", "medium", "low"]),
    file: z.string().min(1).nullable(),
    line: z.number().int().positive().nullable(),
    title: z.string().min(1).max(200),
    details: z.string().min(1).max(2_000),
  })
  .strict();

const reviewCheckSchema = z
  .object({
    name: z.string().min(1).max(100),
    command: z.string().nullable(),
    outcome: z.enum(["passed", "failed", "blocked"]),
    exitCode: z.number().int().nullable(),
    summary: z.string().min(1).max(1_000),
  })
  .strict();

export const reviewVerdictSchema = z
  .object({
    verdict: z.enum(["pass", "changes_requested", "blocked"]),
    reviewedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
    summary: z.string().min(1).max(2_000),
    findings: z.array(reviewFindingSchema).max(100),
    checks: z.array(reviewCheckSchema).max(50),
  })
  .strict();

export class InvalidReviewOutputError extends Error {
  public constructor(message = "Review output does not match the strict JSON contract") {
    super(message);
    this.name = "InvalidReviewOutputError";
  }
}

export function parseReviewVerdict(text: string): ReviewVerdict {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new InvalidReviewOutputError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new InvalidReviewOutputError();
  }
  try {
    return reviewVerdictSchema.parse(parsed) as ReviewVerdict;
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    throw new InvalidReviewOutputError();
  }
}

export function parseGuardResultEnvelope(text: string): GuardResultEnvelope {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new InvalidReviewOutputError("Guard output does not match the strict JSON contract");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new InvalidReviewOutputError("Guard output does not match the strict JSON contract");
  }
  const result = guardResultEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidReviewOutputError("Guard output does not match the strict JSON contract");
  }
  return result.data;
}

const SEVERITY_RANK: Record<ReviewSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function compareNullableText(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
}

function compareFindings(left: ReviewFinding, right: ReviewFinding): number {
  const severityOrder = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  if (severityOrder !== 0) return severityOrder;
  const fileOrder = compareNullableText(left.file, right.file);
  if (fileOrder !== 0) return fileOrder;
  const leftLine = left.line ?? Number.MAX_SAFE_INTEGER;
  const rightLine = right.line ?? Number.MAX_SAFE_INTEGER;
  if (leftLine !== rightLine) return leftLine - rightLine;
  if (left.title !== right.title) return left.title < right.title ? -1 : 1;
  if (left.details === right.details) return 0;
  return left.details < right.details ? -1 : 1;
}

function sortedFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort(compareFindings);
}

function blockedCheckReason(check: ReviewCheck): string {
  return `check ${check.name} was blocked: ${check.summary}`;
}

function failedCheckReason(check: ReviewCheck): string {
  return `check ${check.name} failed: ${check.summary}`;
}

export function assessReview(
  verdict: ReviewVerdict,
  expectedSha: string,
): ReviewAssessment {
  const findings = sortedFindings(verdict.findings);
  if (verdict.reviewedHeadSha !== expectedSha) {
    return {
      outcome: "blocked",
      reasons: ["reviewed head SHA does not match the expected head SHA"],
      findings,
    };
  }

  const blockedCheck = verdict.checks.find((check) => check.outcome === "blocked");
  if (blockedCheck) {
    return { outcome: "blocked", reasons: [blockedCheckReason(blockedCheck)], findings };
  }

  const failedCheck = verdict.checks.find((check) => check.outcome === "failed");
  if (failedCheck) {
    return { outcome: "changes_requested", reasons: [failedCheckReason(failedCheck)], findings };
  }

  if (verdict.verdict === "blocked") {
    return { outcome: "blocked", reasons: ["review verdict was blocked"], findings };
  }
  if (verdict.verdict === "changes_requested") {
    return { outcome: "changes_requested", reasons: ["review verdict requested changes"], findings };
  }
  if (findings.length > 0) {
    return {
      outcome: "changes_requested",
      reasons: ["review reported findings despite a pass verdict"],
      findings,
    };
  }

  return { outcome: "pass", reasons: [], findings };
}
