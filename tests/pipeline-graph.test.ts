import { expect, it } from "vitest";
import { nextPipelineStage } from "../src/domain/pipeline-graph";

it.each([
  ["PLAN", "success", 0, 0, "CRITIQUE"],
  ["CRITIQUE", "needs_revision", 0, 0, "PLAN"],
  ["CRITIQUE", "needs_revision", 0, 1, "BLOCKED"],
  ["CRITIQUE", "success", 0, 0, "BUILD"],
  ["BUILD", "success", 0, 0, "TEST"],
  ["TEST", "fail", 1, 0, "PATCH"],
  ["REVIEW", "changes_requested", 2, 0, "PATCH"],
  ["PATCH", "success", 2, 0, "TEST"],
  ["DOCS", "success", 0, 0, "FINAL_TEST"],
  ["FINAL_REVIEW", "success", 0, 0, "APPROVAL"],
  ["MERGE", "success", 0, 0, "DEPLOY"],
  ["CANARY", "success", 0, 0, "COMPLETE"],
] as const)("routes %s/%s to %s", (stage, outcome, patchCycles, critiqueCycles, expected) => {
  expect(nextPipelineStage({ stage, outcome, patchCycles, critiqueCycles })).toBe(expected);
});

it.each([
  { stage: "CRITIQUE", outcome: "needs_revision", patchCycles: 0, critiqueCycles: 2 },
  { stage: "TEST", outcome: "fail", patchCycles: 3, critiqueCycles: 0 },
  { stage: "UNKNOWN", outcome: "success", patchCycles: 0, critiqueCycles: 0 },
  { stage: "PLAN", outcome: "unknown", patchCycles: 0, critiqueCycles: 0 },
])("fails closed for exhausted or unknown route %#", (input) => {
  expect(nextPipelineStage(input)).toBe("BLOCKED");
});
