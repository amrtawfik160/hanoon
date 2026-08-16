import { describe, expect, it } from "vitest";
import {
  classifyTaskTraits,
  promoteTaskRecipe,
  selectTaskRecipe,
} from "../src/capabilities/routing";
import { recipeExecutionPolicy } from "../src/domain/recipes";

describe("deterministic task routing", () => {
  it.each([
    [{ origin: "adopted_pr" as const, text: "fix auth" }, "adopted-pr"],
    [{ origin: "requested" as const, text: "update the foo skill" }, "skill-authoring"],
    [{ origin: "requested" as const, text: "migrate the public billing schema" }, "architectural"],
    [{ origin: "requested" as const, text: "reproduce the crash when saving" }, "bug"],
    [{ origin: "requested" as const, text: "change README wording" }, "direct"],
    [{ origin: "requested" as const, text: "add a filter to the existing list" }, "bounded"],
  ])("selects the expected recipe for %#", (input, expected) => {
    const classification = classifyTaskTraits(input);
    expect(classification.recipe).toBe(expected);
    expect(selectTaskRecipe(classification.traits)).toBe(expected);
  });

  it("keeps adopted PR and skill-authoring identity while retaining architectural traits", () => {
    const adopted = classifyTaskTraits({
      origin: "adopted_pr",
      text: "review the authentication migration",
      policyTraits: ["security"],
    });
    const skill = classifyTaskTraits({
      origin: "requested",
      text: "change the deployment skill for public API migrations",
    });

    expect(adopted.recipe).toBe("adopted-pr");
    expect(adopted.traits.map((entry) => entry.id)).toContain("security");
    expect(skill.recipe).toBe("skill-authoring");
    expect(skill.traits.map((entry) => entry.id)).toContain("public-contract");
  });

  it("requires no behavioral risk before selecting direct", () => {
    expect(classifyTaskTraits({
      origin: "requested",
      text: "change README wording",
      diffTraits: ["behavioral-risk"],
    }).recipe).toBe("bounded");
    expect(classifyTaskTraits({
      origin: "requested",
      text: "change auth configuration wording",
    }).recipe).toBe("architectural");
  });

  it("records sorted bounded provenance and ignores suppression of safety facts", () => {
    const result = classifyTaskTraits({
      origin: "requested",
      text: "migrate the billing schema",
      ownerSuppressedTraits: ["billing", "migration", "schema-change", "copy-only"],
      repositoryTraits: ["concurrency"],
    });

    expect(result.recipe).toBe("architectural");
    expect(result.traits).toEqual([...result.traits].sort((left, right) => left.id.localeCompare(right.id)));
    expect(result.traits).toEqual(expect.arrayContaining([
      { id: "billing", provenance: ["owner"] },
      { id: "concurrency", provenance: ["repository"] },
      { id: "migration", provenance: ["owner"] },
      { id: "schema-change", provenance: ["owner"] },
    ]));
  });

  it("lets the owner increase rigor but never reduce computed safety rigor", () => {
    expect(classifyTaskTraits({
      origin: "requested",
      text: "change README wording",
      ownerMinimumRecipe: "bounded",
    }).recipe).toBe("bounded");
    expect(classifyTaskTraits({
      origin: "requested",
      text: "migrate the authentication schema",
      ownerMinimumRecipe: "direct",
    }).recipe).toBe("architectural");
  });

  it("never downgrades a persisted recipe on retry or restart", () => {
    const retry = classifyTaskTraits({
      origin: "requested",
      text: "change README wording",
      previous: { recipe: "architectural", promotionCount: 1 },
    });
    expect(retry.recipe).toBe("architectural");
    expect(retry.reasonCodes).toContain("persisted_recipe_floor");
  });

  it("allows two automatic promotions and blocks the third", () => {
    const first = promoteTaskRecipe({ recipe: "direct", promotionCount: 0 }, "behavior_observed");
    const second = promoteTaskRecipe(first, "public_contract_observed");
    const third = promoteTaskRecipe(second, "scope_expanded");

    expect(first).toEqual({ recipe: "bounded", promotionCount: 1, blocked: false, reasonCode: "behavior_observed" });
    expect(second).toEqual({ recipe: "architectural", promotionCount: 2, blocked: false, reasonCode: "public_contract_observed" });
    expect(third).toEqual({ recipe: "architectural", promotionCount: 2, blocked: true, reasonCode: "promotion_limit" });
  });
});

describe("recipe execution policy", () => {
  it("maps every recipe to its fixed orchestration invariants", () => {
    expect(recipeExecutionPolicy("direct")).toEqual({
      planning: "none",
      diagnosis: false,
      baselineTest: false,
      review: "diff-guards",
      documentation: "conditional",
    });
    expect(recipeExecutionPolicy("bounded")).toMatchObject({
      planning: "approved-design",
      diagnosis: false,
      baselineTest: true,
      review: "single",
    });
    expect(recipeExecutionPolicy("bug")).toMatchObject({ diagnosis: true, baselineTest: true, review: "single" });
    expect(recipeExecutionPolicy("architectural")).toMatchObject({
      planning: "plan-and-critique",
      review: "task-and-integrated",
    });
    expect(recipeExecutionPolicy("skill-authoring")).toMatchObject({ baselineTest: true, review: "single" });
    expect(recipeExecutionPolicy("adopted-pr")).toMatchObject({ baselineTest: true, review: "single" });
  });
});
