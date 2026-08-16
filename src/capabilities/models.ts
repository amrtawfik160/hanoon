import { createHash } from "node:crypto";
import { z } from "zod";
import { TASK_RECIPES, type TaskRecipe } from "../domain/recipes";

export const MODEL_POOLS = ["fast", "standard", "strong"] as const;
export const MODEL_EXECUTION_CLASSES = ["controller", "pipeline", "worker", "background"] as const;

export type ModelPool = typeof MODEL_POOLS[number];
export type ModelExecutionClass = typeof MODEL_EXECUTION_CLASSES[number];

const boundedIdentifierSchema = z.string().trim().min(1).max(256);
const realIdentifierSchema = boundedIdentifierSchema.refine(
  (value) => !/^(?:configured[-_ ]?default|configured[-_ ]?controller|default|inherit|unknown|auto)$/iu.test(value),
  "model route contains a placeholder identifier",
);

export const modelRouteTupleSchema = z.object({
  providerId: realIdentifierSchema.max(128),
  modelId: realIdentifierSchema,
  reasoning: z.enum(["none", "low", "medium", "high", "xhigh", "ultracode", "max", "ultra"]),
  // Service tier is part of route identity even when the provider's explicit
  // value is its ordinary tier. Permission is deliberately absent: role and
  // effect policy own it independently.
  serviceTier: z.enum(["default", "fast"]),
}).strict();

export const modelRouteSchema = modelRouteTupleSchema.extend({
  pool: z.enum(MODEL_POOLS),
}).strict();

const modelPoolClassSchema = z.object({
  fast: modelRouteTupleSchema,
  standard: modelRouteTupleSchema,
  strong: modelRouteTupleSchema,
}).strict();

export const modelPoolRegistrySchema = z.object({
  controller: modelPoolClassSchema,
  pipeline: modelPoolClassSchema,
  worker: modelPoolClassSchema,
  background: modelPoolClassSchema,
}).strict();

export type ModelRouteTuple = z.infer<typeof modelRouteTupleSchema>;
export type ModelRoute = Readonly<z.infer<typeof modelRouteSchema>>;
export type ModelPoolRegistry = Readonly<Record<
  ModelExecutionClass,
  Readonly<Record<ModelPool, Readonly<ModelRouteTuple>>>
>>;

export const DEFAULT_MODEL_POOL_REGISTRY: ModelPoolRegistry = defineDefaultRegistry();

function defineDefaultRegistry(): ModelPoolRegistry {
  const entry = (
    modelId: string,
    reasoning: ModelRouteTuple["reasoning"],
    serviceTier: ModelRouteTuple["serviceTier"] = "default",
  ): ModelRouteTuple => ({
    providerId: "codex",
    modelId,
    reasoning,
    serviceTier,
  });
  // Fast mode is never on unless it is asked for in the request that needs it,
  // so no pipeline or worker route turns it on by default.
  return freezeRegistry(modelPoolRegistrySchema.parse({
    controller: {
      fast: entry("gpt-5.6-luna", "low", "fast"),
      standard: entry("gpt-5.6-terra", "high", "fast"),
      strong: entry("gpt-5.6-sol", "xhigh", "fast"),
    },
    pipeline: {
      fast: entry("gpt-5.6-luna", "high"),
      standard: entry("gpt-5.6-terra", "high"),
      strong: entry("gpt-5.6-sol", "xhigh"),
    },
    worker: {
      fast: entry("gpt-5.6-luna", "high"),
      standard: entry("gpt-5.6-terra", "high"),
      strong: entry("gpt-5.6-sol", "xhigh"),
    },
    background: {
      fast: entry("gpt-5.6-luna", "low", "fast"),
      standard: entry("gpt-5.6-terra", "medium", "fast"),
      strong: entry("gpt-5.6-sol", "high", "fast"),
    },
  }));
}

function freezeRegistry(parsed: z.infer<typeof modelPoolRegistrySchema>): ModelPoolRegistry {
  for (const executionClass of MODEL_EXECUTION_CLASSES) {
    for (const pool of MODEL_POOLS) Object.freeze(parsed[executionClass][pool]);
    Object.freeze(parsed[executionClass]);
  }
  return Object.freeze(parsed);
}

export function defineModelPoolRegistry(input: unknown): ModelPoolRegistry {
  const parsed = modelPoolRegistrySchema.safeParse(input);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "registry").join(", ");
    throw new TypeError(`Invalid model pool registry at ${paths}: ${parsed.error.issues[0]?.message ?? "invalid tuple"}`);
  }
  return freezeRegistry(parsed.data);
}

const POOL_RANK: Readonly<Record<ModelPool, number>> = { fast: 0, standard: 1, strong: 2 };

function maximumPool(left: ModelPool, right: ModelPool): ModelPool {
  return POOL_RANK[left] >= POOL_RANK[right] ? left : right;
}

export type ModelRouteSelectionInput = Readonly<{
  executionClass: ModelExecutionClass;
  recipe: TaskRecipe;
  stage: string;
  risk: "low" | "medium" | "high" | "critical";
  observedComplexity?: "low" | "medium" | "high";
  minimumPool?: ModelPool;
}>;

function defaultPool(input: ModelRouteSelectionInput): ModelPool {
  if (
    input.recipe === "architectural" || input.risk === "high" || input.risk === "critical" ||
    input.observedComplexity === "high" ||
    /^(?:architecture|grilling|planning|critique|integrated-review|high-risk-review)$/u.test(input.stage)
  ) return "strong";
  if (
    input.risk === "low" && input.observedComplexity !== "medium" &&
    (input.executionClass === "background" ||
      (input.recipe === "direct" && /^(?:delivery-metadata|formatting|extraction|mechanical|implementation)$/u.test(input.stage)))
  ) return "fast";
  return "standard";
}

export function selectModelRoute(
  rawInput: ModelRouteSelectionInput,
  registry: ModelPoolRegistry,
): ModelRoute {
  const input = z.object({
    executionClass: z.enum(MODEL_EXECUTION_CLASSES),
    recipe: z.enum(TASK_RECIPES),
    stage: z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u),
    risk: z.enum(["low", "medium", "high", "critical"]),
    observedComplexity: z.enum(["low", "medium", "high"]).optional(),
    minimumPool: z.enum(MODEL_POOLS).optional(),
  }).strict().parse(rawInput);
  const validated = modelPoolRegistrySchema.parse(registry);
  const pool = input.minimumPool === undefined
    ? defaultPool(input)
    : maximumPool(defaultPool(input), input.minimumPool);
  return Object.freeze(modelRouteSchema.parse({ pool, ...validated[input.executionClass][pool] }));
}

function normalizedErrorClass(error: unknown): string {
  const raw = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const text = raw.toLowerCase();
  if (/auth|credential|unauthori[sz]ed|forbidden|401|403/u.test(text)) return "authentication";
  if (/rate.?limit|too many requests|\b429\b/u.test(text)) return "rate_limited";
  if (/timed?\s*out|timeout|deadline/u.test(text)) return "timeout";
  if (/missing executable|enoent|not installed/u.test(text)) return "missing_executable";
  if (/unavailable|connection|network|econn|\b50[234]\b/u.test(text)) return "unavailable";
  if (/invalid request|bad request|\b400\b/u.test(text)) return "invalid_request";
  if (/cancel|abort/u.test(text)) return "cancelled";
  return error instanceof Error
    ? error.name.replace(/[^A-Za-z0-9_-]/gu, "_").toLowerCase().slice(0, 64) || "error"
    : "unknown";
}

export type ModelFailureInput = Readonly<{
  route: ModelRoute;
  stage: string;
  operation: string;
  error: unknown;
}>;

export function modelFailureSignature(input: ModelFailureInput): string {
  const route = modelRouteSchema.parse(input.route);
  const stage = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u).parse(input.stage);
  const operation = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u).parse(input.operation);
  return createHash("sha256").update(JSON.stringify({
    providerId: route.providerId,
    modelId: route.modelId,
    stage,
    errorClass: normalizedErrorClass(input.error),
    operation,
  }), "utf8").digest("hex");
}

export type ModelFailureDecision = Readonly<{
  action: "retry" | "escalate" | "block";
  route: ModelRoute;
  signature: string;
  equivalentFailures: number;
  nextPool: ModelPool | null;
}>;

export function recordModelFailure(input: ModelFailureInput & Readonly<{
  priorFailureSignatures: readonly string[];
}>): ModelFailureDecision {
  const route = Object.freeze(modelRouteSchema.parse(input.route));
  const signatures = z.array(z.string().regex(/^[0-9a-f]{64}$/u)).max(100).parse(input.priorFailureSignatures);
  const signature = modelFailureSignature(input);
  const equivalentFailures = signatures.filter((candidate) => candidate === signature).length + 1;
  if (equivalentFailures < 2) {
    return Object.freeze({ action: "retry", route, signature, equivalentFailures, nextPool: route.pool });
  }
  if (route.pool === "strong") {
    return Object.freeze({ action: "block", route, signature, equivalentFailures, nextPool: null });
  }
  return Object.freeze({
    action: "escalate",
    route,
    signature,
    equivalentFailures,
    nextPool: route.pool === "fast" ? "standard" : "strong",
  });
}

const shadowTrialSchema = z.object({
  trialId: boundedIdentifierSchema,
  harnessDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  budgetDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  outcome: z.enum(["passed", "failed", "blocked"]),
}).strict();

export type ModelRouteShadowTrial = z.infer<typeof shadowTrialSchema>;

export function assessModelRouteShadowEvidence(input: Readonly<{
  candidate: readonly ModelRouteShadowTrial[];
  baseline: readonly ModelRouteShadowTrial[];
}>): Readonly<{
  ready: boolean;
  candidateSuccesses: number;
  baselineSuccesses: number;
  reasonCodes: readonly string[];
}> {
  const candidate = z.array(shadowTrialSchema).max(100).parse(input.candidate);
  const baseline = z.array(shadowTrialSchema).max(100).parse(input.baseline);
  const reasons = new Set<string>();
  if (candidate.length < 5) reasons.add("insufficient_candidate_trials");
  if (baseline.length < 5) reasons.add("insufficient_baseline_trials");
  const all = [...candidate, ...baseline];
  if (new Set(all.map((trial) => trial.trialId)).size !== all.length) reasons.add("duplicate_trial_identity");
  const harnesses = new Set(all.map((trial) => trial.harnessDigest));
  const budgets = new Set(all.map((trial) => trial.budgetDigest));
  if (harnesses.size !== 1) reasons.add("harness_mismatch");
  if (budgets.size !== 1) reasons.add("budget_mismatch");
  const candidateSuccesses = candidate.filter((trial) => trial.outcome === "passed").length;
  const baselineSuccesses = baseline.filter((trial) => trial.outcome === "passed").length;
  if (candidateSuccesses < baselineSuccesses) reasons.add("candidate_below_baseline");
  const reasonCodes = [...reasons].sort((left, right) => left.localeCompare(right));
  return { ready: reasonCodes.length === 0, candidateSuccesses, baselineSuccesses, reasonCodes };
}
