import { z } from "zod";
import { TASK_RECIPES, type TaskRecipe } from "../domain/recipes";

export const TASK_TRAITS = [
  "adopted-pr",
  "authentication",
  "behavioral-risk",
  "billing",
  "concurrency",
  "configuration-only",
  "copy-only",
  "data-integrity",
  "documentation-only",
  "existing-flow",
  "high-risk",
  "mechanical-only",
  "migration",
  "multi-session",
  "new-subsystem",
  "public-contract",
  "reproducible-bug",
  "schema-change",
  "security",
  "skill-authoring",
  "styling-only",
] as const;

export const TRAIT_PROVENANCE = [
  "owner",
  "origin",
  "policy",
  "repository",
  "diff",
  "failure",
] as const;

export type TaskTrait = typeof TASK_TRAITS[number];
export type TaskTraitProvenance = typeof TRAIT_PROVENANCE[number];
export type TaskTraitEvidence = Readonly<{
  id: TaskTrait;
  provenance: readonly TaskTraitProvenance[];
}>;

export const taskTraitEvidenceSchema = z.object({
  id: z.enum(TASK_TRAITS),
  provenance: z.array(z.enum(TRAIT_PROVENANCE)).min(1).max(6),
}).strict();

export const taskTraitSnapshotSchema = z.array(taskTraitEvidenceSchema).max(32);
export const taskReasonCodesSchema = z.array(
  z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u),
).max(64);

export type TaskClassification = Readonly<{
  recipe: TaskRecipe;
  traits: readonly TaskTraitEvidence[];
  reasonCodes: readonly string[];
  promotionCount: number;
}>;

export type TaskRoutingInput = Readonly<{
  origin: "requested" | "adopted_pr";
  text: string;
  ownerMinimumRecipe?: TaskRecipe;
  ownerSuppressedTraits?: readonly TaskTrait[];
  policyTraits?: readonly TaskTrait[];
  repositoryTraits?: readonly TaskTrait[];
  diffTraits?: readonly TaskTrait[];
  failureTraits?: readonly TaskTrait[];
  previous?: Readonly<{ recipe: TaskRecipe; promotionCount: number }>;
}>;

export type RecipePromotion = Readonly<{
  recipe: TaskRecipe;
  promotionCount: number;
  blocked: boolean;
  reasonCode: string;
}>;

const inputSchema = z.object({
  origin: z.enum(["requested", "adopted_pr"]),
  text: z.string().min(1).max(8_000),
  ownerMinimumRecipe: z.enum(TASK_RECIPES).optional(),
  ownerSuppressedTraits: z.array(z.enum(TASK_TRAITS)).max(32).optional(),
  policyTraits: z.array(z.enum(TASK_TRAITS)).max(32).optional(),
  repositoryTraits: z.array(z.enum(TASK_TRAITS)).max(32).optional(),
  diffTraits: z.array(z.enum(TASK_TRAITS)).max(32).optional(),
  failureTraits: z.array(z.enum(TASK_TRAITS)).max(32).optional(),
  previous: z.object({
    recipe: z.enum(TASK_RECIPES),
    promotionCount: z.number().int().min(0).max(2),
  }).strict().optional(),
}).strict();

const SAFETY_TRAITS = new Set<TaskTrait>([
  "authentication",
  "behavioral-risk",
  "billing",
  "concurrency",
  "data-integrity",
  "high-risk",
  "migration",
  "multi-session",
  "new-subsystem",
  "public-contract",
  "schema-change",
  "security",
]);

const ARCHITECTURAL_TRAITS = new Set<TaskTrait>([
  "authentication",
  "billing",
  "concurrency",
  "data-integrity",
  "high-risk",
  "migration",
  "multi-session",
  "new-subsystem",
  "public-contract",
  "schema-change",
  "security",
]);

const DIRECT_TRAITS = new Set<TaskTrait>([
  "configuration-only",
  "copy-only",
  "documentation-only",
  "mechanical-only",
  "styling-only",
]);

const OWNER_TEXT_RULES: readonly Readonly<{ trait: TaskTrait; pattern: RegExp }>[] = [
  { trait: "skill-authoring", pattern: /\b(?:create|change|edit|improve|update|write)\b[^\n]{0,80}\b(?:agent\s+)?skill\b|\bSKILL\.md\b/iu },
  { trait: "new-subsystem", pattern: /\b(?:new\s+(?:system|subsystem|service|project)|greenfield)\b/iu },
  { trait: "public-contract", pattern: /\b(?:public\s+(?:api|contract)|api\s+contract)\b/iu },
  { trait: "schema-change", pattern: /\b(?:schema|database\s+shape|public\s+type)\b/iu },
  { trait: "authentication", pattern: /\b(?:authentication|authorization|auth|oauth|sign[ -]?in|login)\b/iu },
  { trait: "billing", pattern: /\b(?:billing|payment|invoice|subscription|checkout)\b/iu },
  { trait: "security", pattern: /\b(?:security|permission|credential|secret|encryption)\b/iu },
  { trait: "migration", pattern: /\b(?:migrate|migration|backfill)\b/iu },
  { trait: "concurrency", pattern: /\b(?:concurrency|concurrent|race\s+condition|locking|deadlock)\b/iu },
  { trait: "data-integrity", pattern: /\b(?:data\s+integrity|atomicity|transactional\s+integrity)\b/iu },
  { trait: "high-risk", pattern: /\b(?:high[ -]?risk|irreversible|production-critical)\b/iu },
  { trait: "multi-session", pattern: /\b(?:multi[ -]?session|multiple\s+sessions|unattended|autonomous)\b/iu },
  { trait: "reproducible-bug", pattern: /\b(?:reproduc(?:e|ible)|regression|crash|incorrect\s+behavior|known\s+bug)\b/iu },
  { trait: "documentation-only", pattern: /\b(?:README|documentation|docs?)\b/iu },
  { trait: "copy-only", pattern: /\b(?:wording|copy|typo|text\s+only)\b/iu },
  { trait: "styling-only", pattern: /\b(?:styling|css|visual\s+only|spacing|color)\b/iu },
  { trait: "configuration-only", pattern: /\b(?:configuration|config)\b/iu },
  { trait: "mechanical-only", pattern: /\b(?:mechanical|rename|formatting|lint-only)\b/iu },
  { trait: "existing-flow", pattern: /\b(?:existing|current)\b[^\n]{0,60}\b(?:flow|list|screen|endpoint)\b/iu },
];

const RECIPE_RIGOR: Readonly<Record<TaskRecipe, number>> = {
  direct: 0,
  bounded: 1,
  bug: 1,
  "skill-authoring": 1,
  "adopted-pr": 1,
  architectural: 2,
};

function addTrait(
  traits: Map<TaskTrait, Set<TaskTraitProvenance>>,
  trait: TaskTrait,
  provenance: TaskTraitProvenance,
): void {
  const sources = traits.get(trait) ?? new Set<TaskTraitProvenance>();
  sources.add(provenance);
  traits.set(trait, sources);
}

function evidenceList(traits: Map<TaskTrait, Set<TaskTraitProvenance>>): TaskTraitEvidence[] {
  return [...traits.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, sources]) => ({
      id,
      provenance: [...sources].sort((left, right) => left.localeCompare(right)),
    }));
}

function traitIds(evidence: readonly TaskTraitEvidence[]): ReadonlySet<TaskTrait> {
  return new Set(evidence.map((entry) => entry.id));
}

export function selectTaskRecipe(evidence: readonly TaskTraitEvidence[]): TaskRecipe {
  const traits = traitIds(evidence);
  if (traits.has("adopted-pr")) return "adopted-pr";
  if (traits.has("skill-authoring")) return "skill-authoring";
  if ([...ARCHITECTURAL_TRAITS].some((trait) => traits.has(trait))) return "architectural";
  if (traits.has("reproducible-bug")) return "bug";
  const direct = [...traits].some((trait) => DIRECT_TRAITS.has(trait));
  if (direct && !traits.has("behavioral-risk")) return "direct";
  return "bounded";
}

function recipeFloor(selected: TaskRecipe, floor: TaskRecipe): TaskRecipe {
  if (RECIPE_RIGOR[floor] > RECIPE_RIGOR[selected]) return floor;
  if (RECIPE_RIGOR[floor] === RECIPE_RIGOR[selected] && floor !== "bounded" && floor !== "direct") {
    return floor;
  }
  return selected;
}

export function classifyTaskTraits(rawInput: TaskRoutingInput): TaskClassification {
  const input = inputSchema.parse(rawInput);
  const traits = new Map<TaskTrait, Set<TaskTraitProvenance>>();
  if (input.origin === "adopted_pr") addTrait(traits, "adopted-pr", "origin");
  for (const rule of OWNER_TEXT_RULES) {
    if (rule.pattern.test(input.text)) addTrait(traits, rule.trait, "owner");
  }
  for (const [provenance, values] of [
    ["policy", input.policyTraits ?? []],
    ["repository", input.repositoryTraits ?? []],
    ["diff", input.diffTraits ?? []],
    ["failure", input.failureTraits ?? []],
  ] as const) {
    for (const trait of values) addTrait(traits, trait, provenance);
  }
  for (const suppressed of input.ownerSuppressedTraits ?? []) {
    if (!SAFETY_TRAITS.has(suppressed) && suppressed !== "adopted-pr" && suppressed !== "skill-authoring") {
      traits.delete(suppressed);
    }
  }

  const evidence = evidenceList(traits);
  const computed = selectTaskRecipe(evidence);
  let recipe = input.ownerMinimumRecipe === undefined
    ? computed
    : recipeFloor(computed, input.ownerMinimumRecipe);
  const reasonCodes = new Set<string>([`recipe_${recipe}`]);
  if (recipe !== computed) reasonCodes.add("owner_rigor_floor");
  if (input.previous !== undefined) {
    const persisted = recipeFloor(recipe, input.previous.recipe);
    if (persisted !== recipe) reasonCodes.add("persisted_recipe_floor");
    recipe = persisted;
  }
  return {
    recipe,
    traits: evidence,
    reasonCodes: [...reasonCodes].sort((left, right) => left.localeCompare(right)),
    promotionCount: input.previous?.promotionCount ?? 0,
  };
}

export function promoteTaskRecipe(
  current: Readonly<{ recipe: TaskRecipe; promotionCount: number }>,
  reasonCode: string,
): RecipePromotion {
  if (!Number.isSafeInteger(current.promotionCount) || current.promotionCount < 0 || current.promotionCount > 2) {
    throw new TypeError("promotionCount must be an integer from 0 through 2");
  }
  if (!/^[a-z][a-z0-9._:-]{0,127}$/u.test(reasonCode)) {
    throw new TypeError("promotion reasonCode must be a bounded key");
  }
  if (current.promotionCount >= 2) {
    return {
      recipe: current.recipe,
      promotionCount: current.promotionCount,
      blocked: true,
      reasonCode: "promotion_limit",
    };
  }
  const recipe = current.recipe === "direct"
    ? "bounded"
    : current.recipe === "bounded" || current.recipe === "bug"
      ? "architectural"
      : current.recipe;
  return {
    recipe,
    promotionCount: current.promotionCount + 1,
    blocked: false,
    reasonCode,
  };
}
