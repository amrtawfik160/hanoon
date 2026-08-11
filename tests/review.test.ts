import { describe, expect, it } from "vitest";

import {
  assessReview,
  parseReviewVerdict,
  reviewVerdictSchema,
} from "../src/domain/review";

describe("review verdict contract", () => {
  it("accepts one strict JSON object for the expected head", () => {
    const text = JSON.stringify({
      verdict: "pass",
      reviewedHeadSha: "a".repeat(40),
      summary: "No actionable findings",
      findings: [],
      checks: [
        {
          name: "unit",
          command: "npm test",
          outcome: "passed",
          exitCode: 0,
          summary: "12 passed",
        },
      ],
    });

    expect(parseReviewVerdict(text).verdict).toBe("pass");
  });

  it.each([
    "```json\n{}\n```",
    "preface {}",
    JSON.stringify({
      verdict: "pass",
      reviewedHeadSha: "bad",
      summary: "x",
      findings: [],
      checks: [],
    }),
  ])("rejects non-contract review output", (text) => {
    expect(() => parseReviewVerdict(text)).toThrow();
  });

  it("does not assess a nominal pass with findings as PASS", () => {
    const verdict = reviewVerdictSchema.parse({
      verdict: "pass",
      reviewedHeadSha: "a".repeat(40),
      summary: "finding remains",
      findings: [
        {
          severity: "high",
          file: "src/a.ts",
          line: 1,
          title: "bug",
          details: "evidence",
        },
      ],
      checks: [],
    });

    expect(assessReview(verdict, "a".repeat(40)).outcome).toBe(
      "changes_requested",
    );
  });
});
