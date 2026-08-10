export type PipelineStage =
  | "INTAKE"
  | "PLAN"
  | "CRITIQUE"
  | "BUILD"
  | "TEST"
  | "REVIEW"
  | "PATCH"
  | "DOCS"
  | "FINAL_TEST"
  | "FINAL_REVIEW"
  | "APPROVAL"
  | "MERGE"
  | "DEPLOY"
  | "CANARY"
  | "COMPLETE"
  | "BLOCKED";

export type PipelineRouteInput = {
  stage: string;
  outcome: string;
  patchCycles: number;
  critiqueCycles: number;
};

const SUCCESS_ROUTES: Readonly<Record<string, PipelineStage>> = {
  PLAN: "CRITIQUE",
  CRITIQUE: "BUILD",
  BUILD: "TEST",
  TEST: "REVIEW",
  REVIEW: "DOCS",
  PATCH: "TEST",
  DOCS: "FINAL_TEST",
  FINAL_TEST: "FINAL_REVIEW",
  FINAL_REVIEW: "APPROVAL",
  APPROVAL: "MERGE",
  MERGE: "DEPLOY",
  DEPLOY: "CANARY",
  CANARY: "COMPLETE",
};

export function nextPipelineStage(input: PipelineRouteInput): PipelineStage {
  if (!Number.isInteger(input.patchCycles) || input.patchCycles < 0 ||
    !Number.isInteger(input.critiqueCycles) || input.critiqueCycles < 0) return "BLOCKED";
  if (input.stage === "CRITIQUE" && input.outcome === "needs_revision") {
    return input.critiqueCycles < 1 ? "PLAN" : "BLOCKED";
  }
  if ((input.stage === "TEST" || input.stage === "FINAL_TEST") && input.outcome === "fail") {
    return input.patchCycles < 3 ? "PATCH" : "BLOCKED";
  }
  if ((input.stage === "REVIEW" || input.stage === "FINAL_REVIEW") && input.outcome === "changes_requested") {
    return input.patchCycles < 3 ? "PATCH" : "BLOCKED";
  }
  if (input.outcome !== "success") return "BLOCKED";
  return SUCCESS_ROUTES[input.stage] ?? "BLOCKED";
}
