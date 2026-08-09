import { expect, it } from "vitest";
import {
  buildImplementationInstruction,
  buildRemediationPrompt,
  buildReviewFormatCorrectionPrompt,
  buildReviewInstruction,
} from "../src/bb/prompts";
import { jobFixture } from "./helpers";

const artifact = {
  filename: "review-packet.json",
  mimeType: "application/json" as const,
  bytes: new Uint8Array([123, 125]),
  sha256: "b".repeat(64),
};

it("keeps implementation and review instructions tiny and attachment-only", () => {
  const implementation = buildImplementationInstruction({
    ...artifact,
    filename: "work-order.md",
  });
  const review = buildReviewInstruction(artifact);

  expect(implementation.length).toBeLessThan(400);
  expect(review.length).toBeLessThan(400);
  expect(implementation).toContain("work-order.md");
  expect(review).toContain("review-packet.json");
  expect(implementation).toContain("b".repeat(64));
  expect(review).toContain("b".repeat(64));
  expect(implementation).not.toContain("Ignore previous");
  expect(review).not.toContain("Ignore previous");
});

it("bounds inline remediation and format-correction prompts", () => {
  const remediation = buildRemediationPrompt(jobFixture(), [
    {
      severity: "high",
      file: "src/telegram/ingress.ts",
      line: 42,
      title: "The request is not fenced",
      details: "The finding should be sent to the implementation worker as bounded evidence.",
    },
  ]);
  const correction = buildReviewFormatCorrectionPrompt();

  expect(remediation.length).toBeLessThan(2_000);
  expect(correction.length).toBeLessThan(400);
  expect(remediation).toContain("job_1");
  expect(remediation).toContain("src/telegram/ingress.ts");
  expect(correction).toContain("strict JSON");
});
