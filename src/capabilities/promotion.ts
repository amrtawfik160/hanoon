import { createHash } from "node:crypto";
import { z } from "zod";
import type { RoutingMode } from "../domain/models";
import { TASK_RECIPES, type TaskRecipe } from "../domain/recipes";
import {
  assessModelRouteShadowEvidence,
  type ModelRouteShadowTrial,
} from "./models";

export const RECIPE_PROMOTION_ORDER = [
  "direct",
  "bounded",
  "bug",
  "skill-authoring",
  "adopted-pr",
  "architectural",
] as const satisfies readonly TaskRecipe[];

export const DETERMINISTIC_PROMOTION_CATEGORIES = [
  "descriptor",
  "identity",
  "compatibility",
  "migration",
  "receipt",
  "recipe",
  "approval",
  "restart",
] as const;

export const SAFETY_PROMOTION_COUNTERS = [
  "policy_bypasses",
  "missing_mandatory_receipts",
  "unsupported_success_claims",
  "stale_approvals",
  "duplicate_irreversible_effects",
] as const;

export type DeterministicPromotionCategory = typeof DETERMINISTIC_PROMOTION_CATEGORIES[number];
export type SafetyPromotionCounter = typeof SAFETY_PROMOTION_COUNTERS[number];
export type CapabilityJobGraphMode = "adaptive" | "legacy";

const boundedIdSchema = z.string().min(1).max(256);
const boundedReasonSchema = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const taskRecipeSchema = z.enum(TASK_RECIPES);

const deterministicEvidenceSchema = z.object({
  category: z.enum(DETERMINISTIC_PROMOTION_CATEGORIES),
  suiteId: boundedIdSchema,
  runId: boundedIdSchema,
  artifactDigest: sha256Schema,
  outcome: z.enum(["passed", "failed"]),
}).strict();

const classifierEvidenceSchema = z.object({
  corpusDigest: sha256Schema,
  runId: boundedIdSchema,
  resultDigest: sha256Schema,
  total: z.number().int().positive().max(100_000),
  correct: z.number().int().nonnegative().max(100_000),
  unsafeDowngrades: z.number().int().nonnegative().max(100_000),
}).strict().refine((value) => value.correct <= value.total, {
  message: "Classifier correct count cannot exceed the fixed corpus size",
});

const liveRunEvidenceSchema = z.object({
  runId: boundedIdSchema,
  jobId: boundedIdSchema,
  recipe: taskRecipeSchema,
  terminalState: z.literal("merged"),
  inducedFailureReceiptId: boundedIdSchema,
  recoveryReceiptId: boundedIdSchema,
  evidenceDigest: sha256Schema,
}).strict().refine(
  (value) => value.inducedFailureReceiptId !== value.recoveryReceiptId,
  { message: "Failure and recovery receipts must be distinct" },
);

const modelTrialSchema = z.object({
  trialId: boundedIdSchema,
  harnessDigest: sha256Schema,
  budgetDigest: sha256Schema,
  outcome: z.enum(["passed", "failed", "blocked"]),
}).strict();

const safetyCounterEvidenceSchema = z.object({
  counter: z.enum(SAFETY_PROMOTION_COUNTERS),
  count: z.number().int().nonnegative().safe(),
  snapshotId: boundedIdSchema,
  evidenceDigest: sha256Schema,
}).strict();

const promotionEvidenceSchema = z.object({
  recipe: taskRecipeSchema,
  deterministic: z.array(deterministicEvidenceSchema).max(DETERMINISTIC_PROMOTION_CATEGORIES.length),
  classifier: classifierEvidenceSchema.nullable(),
  liveRuns: z.array(liveRunEvidenceSchema).max(32),
  candidateModelTrials: z.array(modelTrialSchema).max(100),
  baselineModelTrials: z.array(modelTrialSchema).max(100),
  safetyCounters: z.array(safetyCounterEvidenceSchema).max(SAFETY_PROMOTION_COUNTERS.length),
}).strict().superRefine((value, context) => {
  const deterministicRunIds = value.deterministic.map((entry) => entry.runId);
  if (new Set(deterministicRunIds).size !== deterministicRunIds.length) {
    context.addIssue({ code: "custom", message: "Promotion evidence contains a duplicate deterministic run identity" });
  }
  const categories = value.deterministic.map((entry) => entry.category);
  if (new Set(categories).size !== categories.length) {
    context.addIssue({ code: "custom", message: "Promotion evidence contains a duplicate deterministic category" });
  }
  const liveRunIds = value.liveRuns.map((entry) => entry.runId);
  if (new Set(liveRunIds).size !== liveRunIds.length) {
    context.addIssue({ code: "custom", message: "Promotion evidence contains a duplicate live run identity" });
  }
  if (value.liveRuns.some((entry) => entry.recipe !== value.recipe)) {
    context.addIssue({ code: "custom", message: "Live run evidence is bound to a different recipe" });
  }
  const counters = value.safetyCounters.map((entry) => entry.counter);
  if (new Set(counters).size !== counters.length) {
    context.addIssue({ code: "custom", message: "Promotion evidence contains a duplicate safety counter" });
  }
  const snapshots = value.safetyCounters.map((entry) => entry.snapshotId);
  if (new Set(snapshots).size !== snapshots.length) {
    context.addIssue({ code: "custom", message: "Promotion evidence contains a duplicate safety snapshot identity" });
  }
});

export type RecipePromotionEvidence = z.input<typeof promotionEvidenceSchema>;

export function validatedRecipePromotionEvidence(candidate: unknown): RecipePromotionEvidence | null {
  const parsed = promotionEvidenceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export type RecipePromotionAssessment = Readonly<{
  recipe: TaskRecipe;
  status: "passed" | "incomplete" | "failed";
  ready: boolean;
  reasonCodes: readonly string[];
  evidenceDigest: string;
  candidateSuccesses: number;
  baselineSuccesses: number;
}>;

export type RecipeRolloutDecision = Readonly<{
  id: string;
  recipe: TaskRecipe;
  action: "promote" | "rollback";
  reasonCode: string;
  evidenceDigest: string | null;
  createdAt: number;
}>;

export type AppendRecipeRolloutDecisionInput = Readonly<{
  recipe: TaskRecipe;
  action: RecipeRolloutDecision["action"];
  reasonCode: string;
  evidenceDigest: string | null;
  now: number;
}>;

export interface RecipePromotionDecisionStore {
  appendRecipeRolloutDecision(input: AppendRecipeRolloutDecisionInput): RecipeRolloutDecision;
  listRecipeRolloutDecisions(recipe: TaskRecipe, limit: number): RecipeRolloutDecision[];
  getLatestRecipeRolloutDecision(recipe: TaskRecipe): RecipeRolloutDecision | null;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
  return `{${entries.join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function canonicalPromotionEvidence(evidence: z.output<typeof promotionEvidenceSchema>): unknown {
  const byRunId = <T extends { runId?: string; trialId?: string }>(left: T, right: T): number =>
    (left.runId ?? left.trialId ?? "").localeCompare(right.runId ?? right.trialId ?? "");
  return {
    ...evidence,
    deterministic: [...evidence.deterministic]
      .sort((left, right) => left.category.localeCompare(right.category) || byRunId(left, right)),
    liveRuns: [...evidence.liveRuns].sort(byRunId),
    candidateModelTrials: [...evidence.candidateModelTrials].sort(byRunId),
    baselineModelTrials: [...evidence.baselineModelTrials].sort(byRunId),
    safetyCounters: [...evidence.safetyCounters]
      .sort((left, right) => left.counter.localeCompare(right.counter)),
  };
}

function sorted(values: ReadonlySet<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function priorRecipes(recipe: TaskRecipe): readonly TaskRecipe[] {
  const index = RECIPE_PROMOTION_ORDER.indexOf(recipe);
  if (index < 0) throw new TypeError(`Unknown promotion recipe ${String(recipe)}`);
  return RECIPE_PROMOTION_ORDER.slice(0, index);
}

export function emptyRecipePromotionEvidence(recipe: TaskRecipe): RecipePromotionEvidence {
  return {
    recipe,
    deterministic: [],
    classifier: null,
    liveRuns: [],
    candidateModelTrials: [],
    baselineModelTrials: [],
    safetyCounters: [],
  };
}

export function assessRecipePromotion(input: Readonly<{
  evidence: RecipePromotionEvidence;
  activeRecipes: readonly TaskRecipe[];
}>): RecipePromotionAssessment {
  const evidence = promotionEvidenceSchema.parse(input.evidence);
  const activeRecipes = z.array(taskRecipeSchema).max(TASK_RECIPES.length).parse(input.activeRecipes);
  if (new Set(activeRecipes).size !== activeRecipes.length) {
    throw new TypeError("Active recipe evidence contains a duplicate recipe");
  }

  const incomplete = new Set<string>();
  const failed = new Set<string>();
  const deterministic = new Map(evidence.deterministic.map((entry) => [entry.category, entry]));
  for (const category of DETERMINISTIC_PROMOTION_CATEGORIES) {
    const result = deterministic.get(category);
    if (!result) incomplete.add(`deterministic_missing:${category}`);
    else if (result.outcome === "failed") failed.add(`deterministic_failed:${category}`);
  }

  if (!evidence.classifier) {
    incomplete.add("classifier_missing");
  } else {
    if (evidence.classifier.correct !== evidence.classifier.total) failed.add("classifier_not_perfect");
    if (evidence.classifier.unsafeDowngrades !== 0) failed.add("classifier_unsafe_downgrade");
  }

  if (evidence.liveRuns.length === 0) incomplete.add("live_run_missing");

  const modelAssessment = assessModelRouteShadowEvidence({
    candidate: evidence.candidateModelTrials as readonly ModelRouteShadowTrial[],
    baseline: evidence.baselineModelTrials as readonly ModelRouteShadowTrial[],
  });
  const modelTrialsMissing = evidence.candidateModelTrials.length === 0 ||
    evidence.baselineModelTrials.length === 0;
  for (const reason of modelAssessment.reasonCodes) {
    const target = reason.startsWith("insufficient_") ||
      (modelTrialsMissing && (reason === "harness_mismatch" || reason === "budget_mismatch"))
      ? incomplete
      : failed;
    target.add(`model:${reason}`);
  }

  const counters = new Map(evidence.safetyCounters.map((entry) => [entry.counter, entry]));
  for (const counter of SAFETY_PROMOTION_COUNTERS) {
    const result = counters.get(counter);
    if (!result) incomplete.add(`safety_counter_missing:${counter}`);
    else if (result.count !== 0) failed.add(`safety_counter_nonzero:${counter}`);
  }

  const active = new Set(activeRecipes);
  for (const prior of priorRecipes(evidence.recipe)) {
    if (!active.has(prior)) incomplete.add(`prior_recipe_not_promoted:${prior}`);
  }

  const status = failed.size > 0 ? "failed" as const
    : incomplete.size > 0 ? "incomplete" as const
    : "passed" as const;
  return Object.freeze({
    recipe: evidence.recipe,
    status,
    ready: status === "passed",
    reasonCodes: Object.freeze([...sorted(failed), ...sorted(incomplete)]),
    evidenceDigest: digest(canonicalPromotionEvidence(evidence)),
    candidateSuccesses: modelAssessment.candidateSuccesses,
    baselineSuccesses: modelAssessment.baselineSuccesses,
  });
}

export function routingModeForNewAttempt(
  recipe: TaskRecipe,
  graphMode: CapabilityJobGraphMode,
  latestDecision: Pick<RecipeRolloutDecision, "recipe" | "action" | "reasonCode"> | null,
): RoutingMode {
  taskRecipeSchema.parse(recipe);
  if (graphMode !== "adaptive" && graphMode !== "legacy") {
    throw new TypeError(`Unknown capability job graph mode ${String(graphMode)}`);
  }
  if (graphMode === "legacy") return "legacy";
  if (latestDecision && latestDecision.recipe !== recipe) {
    throw new TypeError("Recipe rollout decision does not match the routed recipe");
  }
  return latestDecision?.action === "promote" ? "active" : "shadow";
}

export class RecipePromotionIncompleteError extends Error {
  public constructor(public readonly assessment: RecipePromotionAssessment) {
    super(`Recipe ${assessment.recipe} promotion evidence is ${assessment.status}`);
    this.name = "RecipePromotionIncompleteError";
  }
}

export type RecipePromotionEvidenceReader = (
  recipe: TaskRecipe,
) => Promise<RecipePromotionEvidence | null> | RecipePromotionEvidence | null;

export class RecipePromotionService {
  public constructor(private readonly dependencies: Readonly<{
    store: RecipePromotionDecisionStore;
    readEvidence: RecipePromotionEvidenceReader;
    now: () => number;
  }>) {}

  public async status(recipe: TaskRecipe): Promise<RecipePromotionAssessment> {
    const parsedRecipe = taskRecipeSchema.parse(recipe);
    const evidence = await this.dependencies.readEvidence(parsedRecipe) ?? emptyRecipePromotionEvidence(parsedRecipe);
    return assessRecipePromotion({ evidence, activeRecipes: this.activeRecipes() });
  }

  public async promote(recipe: TaskRecipe): Promise<RecipeRolloutDecision> {
    const assessment = await this.status(recipe);
    if (!assessment.ready) throw new RecipePromotionIncompleteError(assessment);
    const current = this.dependencies.store.getLatestRecipeRolloutDecision(assessment.recipe);
    if (current?.action === "promote" && current.evidenceDigest === assessment.evidenceDigest) return current;
    return this.dependencies.store.appendRecipeRolloutDecision({
      recipe: assessment.recipe,
      action: "promote",
      reasonCode: "promotion_gates_passed",
      evidenceDigest: assessment.evidenceDigest,
      now: this.dependencies.now(),
    });
  }

  public rollback(recipe: TaskRecipe, reasonCode = "operator_requested"): RecipeRolloutDecision {
    const parsedRecipe = taskRecipeSchema.parse(recipe);
    const parsedReason = boundedReasonSchema.parse(reasonCode);
    const latest = this.dependencies.store.getLatestRecipeRolloutDecision(parsedRecipe);
    if (latest?.action === "rollback" && latest.reasonCode === parsedReason) return latest;
    return this.dependencies.store.appendRecipeRolloutDecision({
      recipe: parsedRecipe,
      action: "rollback",
      reasonCode: parsedReason,
      evidenceDigest: null,
      now: this.dependencies.now(),
    });
  }

  public routingStatus(recipe: TaskRecipe, graphMode: CapabilityJobGraphMode = "adaptive"): Readonly<{
    recipe: TaskRecipe;
    routingMode: RoutingMode;
    decision: RecipeRolloutDecision | null;
  }> {
    const parsedRecipe = taskRecipeSchema.parse(recipe);
    const decision = this.dependencies.store.getLatestRecipeRolloutDecision(parsedRecipe);
    return {
      recipe: parsedRecipe,
      routingMode: routingModeForNewAttempt(parsedRecipe, graphMode, decision),
      decision,
    };
  }

  public listDecisions(recipe: TaskRecipe, limit: number): RecipeRolloutDecision[] {
    return this.dependencies.store.listRecipeRolloutDecisions(taskRecipeSchema.parse(recipe), limit);
  }

  private activeRecipes(): TaskRecipe[] {
    return RECIPE_PROMOTION_ORDER.filter((recipe) =>
      this.dependencies.store.getLatestRecipeRolloutDecision(recipe)?.action === "promote");
  }
}
