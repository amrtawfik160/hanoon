import { createHash } from "node:crypto";
import { changedPathsFromGitDiff } from "../capabilities/change-surface";
import { TASK_RECIPES, type TaskRecipe } from "./recipes";

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

export type RecipeStage =
  | "approved-design"
  | "baseline"
  | "critique"
  | "delivery"
  | "diagnosis"
  | "diff-guards"
  | "documentation"
  | "implementation"
  | "inspection"
  | "integrated-review"
  | "plan"
  | "regression"
  | "resolve-head"
  | "review"
  | "task-review"
  | "validation";

export type RecipeProjection = Readonly<{
  recipe: TaskRecipe;
  stages: readonly RecipeStage[];
  implementationWritersPerWorktree: 1;
  reviewLanes: readonly Readonly<{ id: string; independent: true }>[];
}>;

const RECIPE_STAGES: Readonly<Record<TaskRecipe, readonly RecipeStage[]>> = {
  direct: ["implementation", "validation", "diff-guards", "delivery"],
  bounded: ["approved-design", "implementation", "validation", "review", "delivery"],
  bug: ["diagnosis", "regression", "implementation", "validation", "review", "delivery"],
  architectural: ["plan", "critique", "implementation", "task-review", "validation", "integrated-review", "delivery"],
  "skill-authoring": ["baseline", "implementation", "validation", "review", "delivery"],
  "adopted-pr": ["resolve-head", "inspection", "validation", "review", "delivery"],
};

function reviewLanes(recipe: TaskRecipe): RecipeProjection["reviewLanes"] {
  if (recipe === "architectural") {
    return [
      { id: "task-review", independent: true },
      { id: "integrated-review", independent: true },
    ];
  }
  return [{ id: recipe === "direct" ? "diff-guards" : "review", independent: true }];
}

export function runRecipe(
  recipe: TaskRecipe,
  options: Readonly<{ documentationRequired?: boolean }> = {},
): RecipeProjection {
  if (!TASK_RECIPES.includes(recipe)) throw new TypeError(`Unknown task recipe ${String(recipe)}`);
  const stages = [...RECIPE_STAGES[recipe]];
  if (options.documentationRequired === true) {
    const insertionPoint = recipe === "architectural"
      ? stages.indexOf("validation")
      : stages.indexOf("delivery");
    stages.splice(insertionPoint, 0, "documentation");
  }
  return Object.freeze({
    recipe,
    stages: Object.freeze(stages),
    implementationWritersPerWorktree: 1,
    reviewLanes: Object.freeze(reviewLanes(recipe)),
  });
}

const DOCUMENTATION_PATH = /(^|\/)(?:docs?|documentation)(?:\/|$)|(^|\/)(?:readme|changelog|contributing)(?:\.[^/]*)?$/iu;
const CLI_PATH = /(^|\/)(?:cli|commands?)(?:[./-]|\/)|(^|\/)bin\//iu;
const CONFIG_PATH = /(^|\/)(?:config|configuration)(?:[./-]|\/)|(?:^|\.)config\.[^/]+$|(^|\/)package\.json$/iu;
const PUBLIC_CONTRACT_PATH = /(^|\/)(?:api|public|schemas?)(?:[./-]|\/)|(^|\/)src\/index\.[^/]+$/iu;
const PUBLIC_EXPORT = /^\+(?!\+\+\s)(?:export\s|module\.exports\b|exports\.)/mu;

export type DocumentationRequirement = Readonly<{
  required: boolean;
  diffDigest: string;
  paths: readonly string[];
  reasons: readonly string[];
}>;

export function documentationRequirement(input: Readonly<{
  diff: string;
  traits: readonly string[];
  reasonCodes: readonly string[];
}>): DocumentationRequirement {
  if (!Array.isArray(input.traits) || input.traits.length > 64 ||
    !Array.isArray(input.reasonCodes) || input.reasonCodes.length > 64) {
    throw new TypeError("Documentation selection requires bounded durable traits and reason codes");
  }
  const paths = changedPathsFromGitDiff(input.diff);
  const reasons = new Set<string>();
  if (paths.some((path) => DOCUMENTATION_PATH.test(path))) reasons.add("docs_path");
  if (paths.some((path) => CLI_PATH.test(path))) reasons.add("cli_behavior");
  if (paths.some((path) => CONFIG_PATH.test(path))) reasons.add("configuration_behavior");
  if (paths.some((path) => PUBLIC_CONTRACT_PATH.test(path)) || PUBLIC_EXPORT.test(input.diff) ||
    input.traits.includes("public-contract")) reasons.add("public_contract");
  if (input.reasonCodes.includes("work_order:documentation_required") ||
    input.traits.includes("documentation-only")) reasons.add("work_order_required");
  return Object.freeze({
    required: reasons.size > 0,
    diffDigest: createHash("sha256").update(input.diff, "utf8").digest("hex"),
    paths: Object.freeze(paths),
    reasons: Object.freeze([...reasons].sort((left, right) => left.localeCompare(right))),
  });
}

/**
 * Delivery metadata on the recipe-v1 engine, which is now always deterministic.
 *
 * A nontrivial diff used to route to a bundled writing skill. That skill is no
 * longer shipped, and its replacement cannot be added to the recipe-v1
 * catalog: those descriptors are frozen by a registry digest that installed
 * jobs already recorded. Selecting an unshipped skill would fail at the
 * provider rather than at the boundary, so this engine names none. The fields
 * are kept so an existing consumer reads the same shape.
 */
export type DeliveryMetadataPolicy = Readonly<{
  mode: "deterministic";
  capabilityId: null;
  diffDigest: string;
}>;

export function deliveryMetadataPolicy(input: Readonly<{
  recipe: TaskRecipe;
  diff: string;
}>): DeliveryMetadataPolicy {
  if (!TASK_RECIPES.includes(input.recipe)) throw new TypeError(`Unknown task recipe ${String(input.recipe)}`);
  return Object.freeze({
    mode: "deterministic",
    capabilityId: null,
    diffDigest: createHash("sha256").update(input.diff, "utf8").digest("hex"),
  });
}

export type PipelineRouteInput = {
  stage: string;
  outcome: string;
  patchCycles: number;
  critiqueCycles: number;
  productionConfigured?: boolean;
  smallFix?: boolean;
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
  if (input.stage === "PLAN" && input.outcome === "success") {
    if (input.smallFix) return "BUILD";
    return input.critiqueCycles >= 1 ? "BUILD" : "CRITIQUE";
  }
  if (input.stage === "INTAKE" && input.outcome === "success" && input.smallFix) {
    return "BUILD";
  }
  if (input.stage === "REVIEW" && input.outcome === "success" && input.smallFix) {
    return "COMPLETE";
  }
  if (input.stage === "FINAL_REVIEW" && input.outcome === "success" && input.productionConfigured === false) {
    return "COMPLETE";
  }
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
