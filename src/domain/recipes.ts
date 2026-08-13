export const TASK_RECIPES = [
  "direct",
  "bounded",
  "bug",
  "architectural",
  "skill-authoring",
  "adopted-pr",
] as const;

export type TaskRecipe = typeof TASK_RECIPES[number];

export type RecipeExecutionPolicy = Readonly<{
  planning: "none" | "approved-design" | "plan-and-critique";
  diagnosis: boolean;
  baselineTest: boolean;
  review: "diff-guards" | "single" | "task-and-integrated";
  documentation: "conditional";
}>;

const RECIPE_POLICIES: Readonly<Record<TaskRecipe, RecipeExecutionPolicy>> = {
  direct: {
    planning: "none",
    diagnosis: false,
    baselineTest: false,
    review: "diff-guards",
    documentation: "conditional",
  },
  bounded: {
    planning: "approved-design",
    diagnosis: false,
    baselineTest: true,
    review: "single",
    documentation: "conditional",
  },
  bug: {
    planning: "none",
    diagnosis: true,
    baselineTest: true,
    review: "single",
    documentation: "conditional",
  },
  architectural: {
    planning: "plan-and-critique",
    diagnosis: false,
    baselineTest: true,
    review: "task-and-integrated",
    documentation: "conditional",
  },
  "skill-authoring": {
    planning: "none",
    diagnosis: false,
    baselineTest: true,
    review: "single",
    documentation: "conditional",
  },
  "adopted-pr": {
    planning: "none",
    diagnosis: false,
    baselineTest: true,
    review: "single",
    documentation: "conditional",
  },
};

export function recipeExecutionPolicy(recipe: TaskRecipe): RecipeExecutionPolicy {
  const policy = RECIPE_POLICIES[recipe];
  if (!policy) throw new TypeError(`Unknown task recipe ${String(recipe)}`);
  return policy;
}
