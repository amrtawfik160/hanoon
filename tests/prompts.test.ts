import { expect, it } from "vitest";
import {
  buildImplementationInstruction,
  buildRemediationPrompt,
  buildReviewFormatCorrectionPrompt,
  buildReviewInstruction,
} from "../src/bb/prompts";
import { buildWorkOrder } from "../src/bb/handoffs";
import { buildWorkerInstructions } from "../src/agent-skills/role-resolver";
import { jobFixture, policyFixture } from "./helpers";

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
  expect(implementation).not.toMatch(/SKILL\.md|systematic-debugging|test-driven-development|docs-guard/);
  expect(review).not.toMatch(/SKILL\.md|systematic-debugging|test-driven-development|docs-guard/);
});

it("keeps packet authority above selected skill suggestions", () => {
  const job = jobFixture({ projectId: "proj_1", policy: policyFixture() });
  const packet = new TextDecoder().decode(buildWorkOrder(job, job.policy!).bytes);
  const instructions = buildWorkerInstructions({ role: "implementation" });

  expect(packet).toContain("This attachment is the immutable execution contract");
  expect(packet).toContain("## Validation policy");
  expect(instructions).toContain(
    "The immutable attached work order/review packet and durable project policy outrank skill suggestions.",
  );
  expect(instructions).toContain("The worker must obey the packet's response contract.");
});

it("keeps review output contracts structural and attachment-bound", () => {
  const review = buildReviewInstruction(artifact);
  const correction = buildReviewFormatCorrectionPrompt();

  expect(review).toContain(artifact.filename);
  expect(review).toContain(`SHA-256 ${artifact.sha256}`);
  expect(review).toMatch(/strict JSON/i);
  expect(review).not.toContain("```");
  expect(correction).toMatch(/strict JSON/i);
  expect(correction).toMatch(/markdown fences/i);
  expect(correction).toMatch(/additional keys/i);
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
