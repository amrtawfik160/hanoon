import { z } from "zod";
import { MODEL_POOLS, type ModelPool } from "../capabilities/models";

/**
 * Per-stage model routing for the guarded job pipeline.
 *
 * Every model id a pipeline stage can run on lives in this module, with a note
 * on what it is for, instead of being scattered through the runner as string
 * literals. A stage's execution tuple comes from exactly two places: the
 * project's own stage table, or the tiered defaults declared below. It is never
 * "whatever the conversational controller happens to be set to" — retuning the
 * controller must not quietly change how plans, critiques, and reviews are
 * produced.
 */

export const PIPELINE_STAGES = [
  "plan",
  "critique",
  "implementation",
  "review",
  "validation",
  "docs",
  "merge",
  "deploy",
  "canary",
] as const;

export type PipelineStage = typeof PIPELINE_STAGES[number];

export const REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
] as const;

export const SERVICE_TIERS = ["default", "fast"] as const;
export const PERMISSION_MODES = ["accept-edits", "auto", "full"] as const;

export type ReasoningLevel = typeof REASONING_LEVELS[number];
export type StageServiceTier = typeof SERVICE_TIERS[number];
export type StagePermissionMode = typeof PERMISSION_MODES[number];

/** The tier ladder a stage climbs when its work turns out to be hard. */
export const STAGE_TIERS = MODEL_POOLS;
export type StageTier = ModelPool;

const TIER_RANK: Readonly<Record<StageTier, number>> = { fast: 0, standard: 1, strong: 2 };

export type StageModelRate = Readonly<{
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
}>;

export type StageModelEntry = Readonly<{
  providerId: string;
  /** What this model is for, so the tiering can be argued about in one place. */
  purpose: string;
  /** Sending a service tier to a provider that does not honour one is an input
   *  the provider cannot act on. */
  supportsServiceTier: boolean;
  /**
   * Published price per million tokens. Left null until the real published
   * rate is entered here: a stage attempt then records its token counts with a
   * null cost rather than a fabricated one. Filling a rate in is the only step
   * needed to turn measured tokens into measured spend.
   */
  rate: StageModelRate | null;
}>;

/**
 * Permission modes each execution provider actually accepts. Cursor, Grok, and
 * Pi reject `auto`; sending it fails spawn before the worker starts.
 */
export const EXECUTION_PROVIDER_PERMISSION_MODES = Object.freeze({
  "claude-code": Object.freeze(["accept-edits", "auto", "full"] as const satisfies readonly StagePermissionMode[]),
  codex: Object.freeze(["accept-edits", "auto", "full"] as const satisfies readonly StagePermissionMode[]),
  pi: Object.freeze(["full"] as const satisfies readonly StagePermissionMode[]),
  "acp-cursor": Object.freeze(["accept-edits", "full"] as const satisfies readonly StagePermissionMode[]),
  "acp-grok": Object.freeze(["accept-edits", "full"] as const satisfies readonly StagePermissionMode[]),
});

export type ExecutionProviderId = keyof typeof EXECUTION_PROVIDER_PERMISSION_MODES;

const PERMISSION_PREFERENCE = ["accept-edits", "full", "auto"] as const satisfies readonly StagePermissionMode[];
const UNKNOWN_PROVIDER_PERMISSION_MODES = ["accept-edits", "full"] as const satisfies readonly StagePermissionMode[];

export function providerPermissionModes(providerId: string): readonly StagePermissionMode[] {
  return Object.prototype.hasOwnProperty.call(EXECUTION_PROVIDER_PERMISSION_MODES, providerId)
    ? EXECUTION_PROVIDER_PERMISSION_MODES[providerId as ExecutionProviderId]
    : UNKNOWN_PROVIDER_PERMISSION_MODES;
}

export function providerHonoursPermissionMode(providerId: string, mode: StagePermissionMode): boolean {
  return providerPermissionModes(providerId).includes(mode);
}

/** The requested mode when the provider accepts it, otherwise the safest mode it does. */
export function compatiblePermissionMode(providerId: string, requested: StagePermissionMode): StagePermissionMode {
  if (providerHonoursPermissionMode(providerId, requested)) return requested;
  const supported = providerPermissionModes(providerId);
  return PERMISSION_PREFERENCE.find((mode) => supported.includes(mode)) ?? supported[0] ?? "full";
}

/**
 * The one place a pipeline model id may be named. `validateStageModel` rejects
 * any policy that names something absent from this table, so a bad model id
 * fails when the policy is saved or loaded rather than when a worker refuses to
 * start mid-job.
 */
export const PIPELINE_MODEL_CATALOG: Readonly<Record<string, StageModelEntry>> = Object.freeze({
  "gpt-5.6-luna": Object.freeze({
    providerId: "codex",
    purpose: "Cheapest Codex tier. Mechanical stages: docs, validation, merge, deploy, canary.",
    supportsServiceTier: true,
    rate: null,
  }),
  "gpt-5.6-terra": Object.freeze({
    providerId: "codex",
    purpose: "Mid Codex tier. Ordinary implementation work that follows an approved plan.",
    supportsServiceTier: true,
    rate: null,
  }),
  "gpt-5.6-sol": Object.freeze({
    providerId: "codex",
    purpose: "Strongest Codex tier. Planning, critique, and review, where judgement is the work.",
    supportsServiceTier: true,
    rate: null,
  }),
  "claude-opus-5[1m]": Object.freeze({
    providerId: "claude-code",
    purpose: "Strongest Claude tier with a long context. Available as a per-project stage pin.",
    supportsServiceTier: false,
    rate: null,
  }),
  "claude-opus-4-8[1m]": Object.freeze({
    providerId: "claude-code",
    purpose: "Previous strong Claude tier. Available as a per-project stage pin.",
    supportsServiceTier: false,
    rate: null,
  }),
  "claude-sonnet-5": Object.freeze({
    providerId: "claude-code",
    purpose: "Balanced Claude tier. Available as a per-project stage pin.",
    supportsServiceTier: false,
    rate: null,
  }),
  "claude-fable-5": Object.freeze({
    providerId: "claude-code",
    purpose: "Fast Claude tier. Available as a per-project stage pin.",
    supportsServiceTier: false,
    rate: null,
  }),
  "openrouter/~deepseek/deepseek-v4-flash-latest": Object.freeze({
    providerId: "pi",
    // Deliberately absent from every tier below. This is the cheap model for
    // short spawned threads, not for guarded pipeline jobs, which keep the
    // models their project configured.
    purpose: "Cheap fast model for short spawned threads. Never a pipeline default.",
    supportsServiceTier: false,
    rate: null,
  }),
  "cursor-grok-4.6-medium": Object.freeze({
    providerId: "acp-cursor",
    purpose: "Cursor Grok 4.6. Available as a controller or per-project stage pin.",
    supportsServiceTier: true,
    rate: null,
  }),
  "gpt-5.6-sol-medium": Object.freeze({
    providerId: "acp-cursor",
    purpose: "GPT-5.6 Sol through Cursor. Available as a controller or per-project stage pin.",
    supportsServiceTier: true,
    rate: null,
  }),
  "claude-opus-5-thinking-medium": Object.freeze({
    providerId: "acp-cursor",
    purpose: "Claude Opus 5 through Cursor. Available as a controller or per-project stage pin.",
    supportsServiceTier: true,
    rate: null,
  }),
  "claude-fable-5-thinking-medium": Object.freeze({
    providerId: "acp-cursor",
    purpose: "Claude Fable 5 through Cursor. Available as a controller or per-project stage pin.",
    supportsServiceTier: true,
    rate: null,
  }),
  "composer-2.5": Object.freeze({
    providerId: "acp-cursor",
    purpose: "Cursor Composer 2.5. Available as a controller or per-project stage pin.",
    supportsServiceTier: true,
    rate: null,
  }),
  "grok-4.6": Object.freeze({
    providerId: "acp-grok",
    purpose: "Grok 4.6 through Grok Build. Available as a controller or per-project stage pin.",
    supportsServiceTier: true,
    rate: null,
  }),
  "grok-4.5": Object.freeze({
    providerId: "acp-grok",
    purpose: "Grok 4.5 through Grok Build. Available as a controller or per-project stage pin.",
    supportsServiceTier: true,
    rate: null,
  }),
});

export type StageTierRoute = Readonly<{
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
}>;

/**
 * What each tier resolves to before any per-stage override.
 *
 * Every tier here names the same provider, and the consensus independence
 * check leans on that. It compares a pinned second opinion against the review
 * stage's provider at its **base** tier, which is the provider a review attempt
 * runs on today however far it escalates: a stage that pins an exact model
 * never escalates, and a stage that does not pin one climbs between routes that
 * all belong to one provider. Give any tier a different provider and that stops
 * being true — an escalated review attempt could then land on the very provider
 * the parse-time check cleared the pin against — so the consensus check in
 * `resolveConsensusExecution` and in the policy schema has to be revisited
 * before this table changes.
 */
export const STAGE_TIER_ROUTES: Readonly<Record<StageTier, StageTierRoute>> = Object.freeze({
  fast: Object.freeze({ providerId: "codex", model: "gpt-5.6-luna", reasoningLevel: "low" as const }),
  standard: Object.freeze({ providerId: "codex", model: "gpt-5.6-terra", reasoningLevel: "high" as const }),
  strong: Object.freeze({ providerId: "codex", model: "gpt-5.6-sol", reasoningLevel: "xhigh" as const }),
});

/**
 * The strongest route each provider offers. A consensus pass exists to be a
 * second opinion, so it runs on a provider the job's review stage did not use;
 * without this table the strong tier would send it straight back to the model
 * that already read this change. `pi` is deliberately absent: its one catalog
 * model is the cheap model for short threads, never a pipeline reviewer.
 */
export const PROVIDER_STRONG_ROUTES: Readonly<Record<string, StageTierRoute>> = Object.freeze({
  codex: Object.freeze({ providerId: "codex", model: "gpt-5.6-sol", reasoningLevel: "xhigh" as const }),
  "claude-code": Object.freeze({
    providerId: "claude-code",
    model: "claude-opus-5[1m]",
    reasoningLevel: "xhigh" as const,
  }),
});

/**
 * The strong route of some provider other than `providerId`, or null when the
 * catalog offers no second opinion. Null is an answer, not a failure: the
 * caller falls back to asking the owner rather than re-reviewing on the same
 * model and calling that independent.
 */
export function alternateStrongRoute(providerId: string): StageTierRoute | null {
  return Object.values(PROVIDER_STRONG_ROUTES).find((route) => route.providerId !== providerId) ?? null;
}

export type StageDefault = Readonly<{
  tier: StageTier;
  /** How many tiers this stage may climb across retries. */
  maxEscalations: number;
  /**
   * Undefined leaves permission to the project's own execution profile, which
   * is what implementation and review have always done. The pipeline-owned
   * stages state it outright.
   */
  permissionMode?: StagePermissionMode;
}>;

/**
 * Tiered defaults, so an unconfigured project still behaves sensibly. Heavy
 * reasoning is spent where judgement is the work; the mechanical stages run
 * cheap and climb only if they actually turn out to be hard.
 */
export const DEFAULT_STAGE_PROFILES: Readonly<Record<PipelineStage, StageDefault>> = Object.freeze({
  plan: Object.freeze({ tier: "strong" as const, maxEscalations: 2, permissionMode: "auto" as const }),
  critique: Object.freeze({ tier: "strong" as const, maxEscalations: 2, permissionMode: "auto" as const }),
  implementation: Object.freeze({ tier: "standard" as const, maxEscalations: 2 }),
  review: Object.freeze({ tier: "strong" as const, maxEscalations: 2 }),
  validation: Object.freeze({ tier: "fast" as const, maxEscalations: 2, permissionMode: "auto" as const }),
  docs: Object.freeze({ tier: "fast" as const, maxEscalations: 2, permissionMode: "auto" as const }),
  merge: Object.freeze({ tier: "fast" as const, maxEscalations: 1, permissionMode: "auto" as const }),
  deploy: Object.freeze({ tier: "fast" as const, maxEscalations: 1, permissionMode: "auto" as const }),
  canary: Object.freeze({ tier: "fast" as const, maxEscalations: 1, permissionMode: "auto" as const }),
});

export function stageModelEntry(model: string): StageModelEntry | null {
  return Object.prototype.hasOwnProperty.call(PIPELINE_MODEL_CATALOG, model)
    ? PIPELINE_MODEL_CATALOG[model]!
    : null;
}

export function pipelineProviderIds(): readonly string[] {
  return [...new Set(Object.values(PIPELINE_MODEL_CATALOG).map((entry) => entry.providerId))].sort();
}

export type StageModelValidation =
  | { ok: true; entry: StageModelEntry | null }
  | { ok: false; message: string };

/**
 * Fails loudly on a model no provider offers, on a provider that does not own
 * the named model, and on a service tier the provider cannot honour.
 */
export function validateStageModel(input: {
  providerId?: string;
  model?: string;
  serviceTier?: StageServiceTier;
  permissionMode?: StagePermissionMode;
}): StageModelValidation {
  const entry = input.model === undefined ? null : stageModelEntry(input.model);
  if (input.model !== undefined && entry === null) {
    return { ok: false, message: `No configured provider offers the model "${input.model}"` };
  }
  if (input.providerId !== undefined && !pipelineProviderIds().includes(input.providerId)) {
    return { ok: false, message: `Unknown execution provider "${input.providerId}"` };
  }
  // A provider on its own says nothing, because the tier already supplies a
  // model. Left alone it would pair that provider with another provider's
  // model, which is exactly the mid-job "worker will not start" this validation
  // exists to prevent.
  if (input.providerId !== undefined && input.model === undefined) {
    return { ok: false, message: `Execution provider "${input.providerId}" requires an explicit model` };
  }
  if (entry !== null && input.providerId !== undefined && entry.providerId !== input.providerId) {
    return {
      ok: false,
      message: `Provider "${input.providerId}" does not offer "${input.model}"; it belongs to "${entry.providerId}"`,
    };
  }
  if (input.serviceTier === "fast" && entry !== null && !entry.supportsServiceTier) {
    return { ok: false, message: `Provider "${entry.providerId}" does not honour a fast service tier` };
  }
  const permissionProvider = input.providerId ?? entry?.providerId;
  if (
    input.permissionMode !== undefined
    && permissionProvider !== undefined
    && !providerHonoursPermissionMode(permissionProvider, input.permissionMode)
  ) {
    return {
      ok: false,
      message: `Provider "${permissionProvider}" does not support permission mode "${input.permissionMode}"`,
    };
  }
  return { ok: true, entry };
}

/**
 * The execution overrides a project may store for one worker kind. Everything
 * is optional: an absent field takes the stage default, never the controller's
 * setting.
 */
export const stageExecutionProfileSchema = z
  .object({
    /** Picks the catalog route. Absent means the stage's default tier. */
    tier: z.enum(STAGE_TIERS).optional(),
    providerId: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    reasoningLevel: z.enum(REASONING_LEVELS).optional(),
    /** Fast mode is opt-in per stage and off unless it is stored here. */
    serviceTier: z.enum(SERVICE_TIERS).optional(),
    permissionMode: z.enum(PERMISSION_MODES).optional(),
    /** Bounds the retry climb so a stage cannot escalate forever. */
    maxEscalations: z.number().int().min(0).max(2).optional(),
  })
  .strict()
  .superRefine((profile, context) => {
    const validation = validateStageModel(profile);
    if (!validation.ok) {
      context.addIssue({
        code: "custom",
        path: profile.model === undefined ? ["providerId"] : ["model"],
        message: validation.message,
      });
    }
  });

export type StageExecutionProfile = z.infer<typeof stageExecutionProfileSchema>;

/**
 * The second opinion a project may pin for a consensus review pass. Provider
 * and model are both required, because the point of the pass is a route the
 * job's own reviewer did not use: a tier on its own would resolve straight back
 * to the model that already looked at this change. Validated against the same
 * catalog as every other stage entry, so a route no provider offers fails when
 * the policy is saved rather than when the pass is spawned.
 */
export const consensusReviewSchema = z
  .object({
    providerId: z.string().min(1),
    model: z.string().min(1),
    reasoningLevel: z.enum(REASONING_LEVELS).optional(),
    serviceTier: z.enum(SERVICE_TIERS).optional(),
    permissionMode: z.enum(PERMISSION_MODES).optional(),
  })
  .strict()
  .superRefine((profile, context) => {
    const validation = validateStageModel(profile);
    if (!validation.ok) {
      context.addIssue({ code: "custom", path: ["model"], message: validation.message });
    }
  });

export type ConsensusReviewProfile = z.infer<typeof consensusReviewSchema>;

export const stageExecutionPolicySchema = z
  .object({
    plan: stageExecutionProfileSchema.optional(),
    critique: stageExecutionProfileSchema.optional(),
    implementation: stageExecutionProfileSchema.optional(),
    review: stageExecutionProfileSchema.optional(),
    validation: stageExecutionProfileSchema.optional(),
    docs: stageExecutionProfileSchema.optional(),
    merge: stageExecutionProfileSchema.optional(),
    deploy: stageExecutionProfileSchema.optional(),
    canary: stageExecutionProfileSchema.optional(),
  })
  .strict();

export type StageExecutionPolicy = z.infer<typeof stageExecutionPolicySchema>;

/**
 * The execution tuple a project stores for implementation and review today.
 * Kept here so both the legacy fields and the new stage table share one shape.
 */
export const executionProfileSchema = z
  .object({
    providerId: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    reasoningLevel: z.enum(REASONING_LEVELS).optional(),
    serviceTier: z.enum(SERVICE_TIERS).optional(),
    permissionMode: z.enum(PERMISSION_MODES).optional(),
  })
  .strict();

export type ExecutionProfile = z.infer<typeof executionProfileSchema>;

/** Where a resolved stage tuple actually came from. No silent inheritance. */
export type StageExecutionSource =
  | "stage-policy"
  | "legacy-policy"
  | "default"
  /** Chosen by the capability router, which owns routing while a job is active. */
  | "capability-route";

export type ResolvedStageExecution = Readonly<{
  stage: PipelineStage;
  /** The tier before any retry escalation. */
  baseTier: StageTier;
  /** The tier actually used for this attempt. */
  tier: StageTier;
  escalationSteps: number;
  maxEscalations: number;
  /** True when the stage pins an exact model, which retries must not override. */
  modelPinned: boolean;
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  serviceTier: StageServiceTier;
  permissionMode: StagePermissionMode | undefined;
  source: StageExecutionSource;
}>;

export function escalatedTier(base: StageTier, steps: number): StageTier {
  const rank = Math.min(TIER_RANK[base] + Math.max(0, steps), TIER_RANK.strong);
  return STAGE_TIERS[rank]!;
}

/**
 * How many tiers a stage should climb for its next attempt. A repeated attempt
 * and a repeated review or plan cycle are the same signal — the work turned out
 * to be harder than the cheap tier could handle — so the stronger of the two
 * decides, rather than the sum.
 */
export function stageEscalationSteps(input: {
  attemptOrdinal?: number;
  repeatedCycles?: number;
  priorFailures?: number;
}): number {
  const fromOrdinal = Math.max(0, (input.attemptOrdinal ?? 1) - 1);
  const fromCycles = Math.max(0, input.repeatedCycles ?? 0);
  const fromFailures = Math.max(0, input.priorFailures ?? 0);
  return Math.max(fromOrdinal, fromCycles, fromFailures);
}

type LegacyProfiles = Readonly<{
  implementation?: ExecutionProfile;
  review?: ExecutionProfile;
}>;

function legacyProfileFor(stage: PipelineStage, legacy: LegacyProfiles | undefined): ExecutionProfile | undefined {
  if (legacy === undefined) return undefined;
  const profile = stage === "implementation" ? legacy.implementation
    : stage === "review" ? legacy.review
    : undefined;
  if (profile === undefined) return undefined;
  return Object.values(profile).some((value) => value !== undefined) ? profile : undefined;
}

export type ResolveStageExecutionInput = Readonly<{
  stage: PipelineStage;
  stageExecution?: StageExecutionPolicy;
  /**
   * The implementation and review profiles stored before the stage table
   * existed. They map onto their own stage entries so nobody re-enters config.
   */
  legacy?: LegacyProfiles;
  escalationSteps?: number;
}>;

/**
 * Resolves one stage's execution tuple. Exactly one source configures a stage,
 * so nothing is half-inherited:
 *   - a stage table entry, if the project has one, is the whole answer;
 *   - otherwise the stored implementation or review profile, for those stages;
 *   - otherwise the stage's declared default tier.
 * Anything the chosen source leaves unset comes from the tier route, and retry
 * escalation moves the tier unless the stage pins an exact model.
 */
export function resolveStageExecution(input: ResolveStageExecutionInput): ResolvedStageExecution {
  const stage = z.enum(PIPELINE_STAGES).parse(input.stage);
  const fallback = DEFAULT_STAGE_PROFILES[stage];
  const configured = input.stageExecution?.[stage];
  const legacy = configured === undefined ? legacyProfileFor(stage, input.legacy) : undefined;

  const source: StageExecutionSource = configured !== undefined
    ? "stage-policy"
    : legacy !== undefined ? "legacy-policy" : "default";

  const overrides: ExecutionProfile = { ...legacy, ...stripUndefined(configured ?? {}) };
  const baseTier = configured?.tier ?? fallback.tier;
  const maxEscalations = configured?.maxEscalations ?? fallback.maxEscalations;
  const modelPinned = overrides.model !== undefined;
  const escalationSteps = modelPinned
    ? 0
    : Math.min(Math.max(0, input.escalationSteps ?? 0), maxEscalations);
  const tier = escalatedTier(baseTier, escalationSteps);
  const route = STAGE_TIER_ROUTES[tier];

  const model = overrides.model ?? route.model;
  const entry = stageModelEntry(model);
  const providerId = overrides.providerId ?? entry?.providerId ?? route.providerId;
  const requestedServiceTier = overrides.serviceTier ?? "default";
  const permissionMode = resolvedPermissionMode(
    providerId,
    overrides.permissionMode ?? fallback.permissionMode,
  );

  return Object.freeze({
    stage,
    baseTier,
    tier,
    escalationSteps,
    maxEscalations,
    modelPinned,
    providerId,
    model,
    reasoningLevel: overrides.reasoningLevel ?? route.reasoningLevel,
    // Fast mode stays off unless this stage opted in. Nothing inherits it.
    serviceTier: entry?.supportsServiceTier === false ? "default" : requestedServiceTier,
    permissionMode,
    source,
  });
}

function resolvedPermissionMode(
  providerId: string,
  requested: StagePermissionMode | undefined,
): StagePermissionMode | undefined {
  if (requested !== undefined) return compatiblePermissionMode(providerId, requested);
  // Leave unset when BB's usual auto default is legal. Providers that reject
  // auto (Cursor, Grok, Pi) must send a mode they accept, or spawn fails.
  if (providerHonoursPermissionMode(providerId, "auto")) return undefined;
  return compatiblePermissionMode(providerId, "auto");
}

/**
 * The provider a job's review stage runs on, resolved exactly the way the
 * review attempt itself resolves it. The one place to ask "who already read
 * this change", so a check against it cannot drift from what actually ran.
 */
export function reviewStageProviderId(input: Readonly<{
  stageExecution?: StageExecutionPolicy;
  legacy?: LegacyProfiles;
}>): string {
  return resolveStageExecution({
    stage: "review",
    ...(input.stageExecution === undefined ? {} : { stageExecution: input.stageExecution }),
    ...(input.legacy === undefined ? {} : { legacy: input.legacy }),
  }).providerId;
}

/**
 * The route one consensus review pass runs on, or null when there is no
 * independent second opinion to be had.
 *
 * A consensus pass exists to disagree with the job's own reviewer if it can, so
 * it must not run on that reviewer's provider. The project may pin the route;
 * otherwise it is the strong route of a provider the review stage did not use.
 * Null is a real answer, and its caller asks the owner instead of re-reviewing
 * on the same model and calling that a second opinion.
 *
 * A pinned route is checked against the review stage's provider here as well as
 * where the policy is parsed. The parse refuses such a policy outright, so this
 * is the second lock on the same door: independence is the property this pass
 * is trusted for, and it must not rest on a single check.
 */
export function resolveConsensusExecution(input: Readonly<{
  stageExecution?: StageExecutionPolicy;
  legacy?: LegacyProfiles;
  consensusReview?: Readonly<{
    providerId: string;
    model: string;
    reasoningLevel?: ReasoningLevel;
    serviceTier?: StageServiceTier;
    permissionMode?: StagePermissionMode;
  }>;
}>): ResolvedStageExecution | null {
  const review = resolveStageExecution({
    stage: "review",
    ...(input.stageExecution === undefined ? {} : { stageExecution: input.stageExecution }),
    ...(input.legacy === undefined ? {} : { legacy: input.legacy }),
  });
  const pinned = input.consensusReview;
  const route = pinned === undefined ? alternateStrongRoute(review.providerId) : pinned;
  // The same model agreeing with itself is not a second opinion. A pin that
  // lands back on the reviewer's provider is therefore read as "no independent
  // route", which is a case the caller already handles by asking the owner.
  if (route === null || route.providerId === review.providerId) return null;
  const entry = stageModelEntry(route.model);
  const requestedServiceTier = pinned?.serviceTier ?? "default";
  return Object.freeze({
    stage: "review" as const,
    baseTier: "strong" as const,
    tier: "strong" as const,
    escalationSteps: 0,
    // A second opinion is one pass at full strength. There is no ladder to
    // climb: a consensus pass that needed a retry falls back to the owner.
    maxEscalations: 0,
    modelPinned: true,
    providerId: route.providerId,
    model: route.model,
    reasoningLevel: pinned?.reasoningLevel ?? STAGE_TIER_ROUTES.strong.reasoningLevel,
    serviceTier: entry?.supportsServiceTier === false ? "default" : requestedServiceTier,
    permissionMode: pinned?.permissionMode ?? review.permissionMode,
    source: pinned === undefined ? "default" as const : "stage-policy" as const,
  });}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/**
 * The spawn arguments for a resolved stage. Every field is declared explicit so
 * BB never substitutes a project or controller default underneath us.
 */
export function stageExecutionSpawnArgs(resolved: ResolvedStageExecution): Record<string, unknown> {
  return executionSpawnArgs({
    providerId: resolved.providerId,
    model: resolved.model,
    reasoningLevel: resolved.reasoningLevel,
    serviceTier: resolved.serviceTier,
    permissionMode: resolved.permissionMode,
  });
}

/**
 * Spawn fields for a background or controller-owned thread that is not a
 * pipeline stage. Permission is always sent, and `auto` is rewritten for
 * providers that reject it.
 */
export function modelRouteSpawnArgs(input: {
  providerId: string;
  modelId: string;
  reasoning: ReasoningLevel;
  serviceTier: StageServiceTier;
  permissionMode?: StagePermissionMode;
}): Record<string, unknown> {
  return executionSpawnArgs({
    providerId: input.providerId,
    model: input.modelId,
    reasoningLevel: input.reasoning,
    serviceTier: input.serviceTier,
    permissionMode: compatiblePermissionMode(input.providerId, input.permissionMode ?? "auto"),
  });
}

function executionSpawnArgs(input: {
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  serviceTier: StageServiceTier;
  permissionMode: StagePermissionMode | undefined;
}): Record<string, unknown> {
  const entry = stageModelEntry(input.model);
  const withTier = entry === null ? true : entry.supportsServiceTier;
  const withPermission = input.permissionMode !== undefined;
  return {
    providerId: input.providerId,
    model: input.model,
    reasoningLevel: input.reasoningLevel,
    ...(withTier ? { serviceTier: input.serviceTier } : {}),
    ...(withPermission ? { permissionMode: input.permissionMode } : {}),
    executionInputSources: {
      providerId: "explicit" as const,
      model: "explicit" as const,
      reasoningLevel: "explicit" as const,
      ...(withTier ? { serviceTier: "explicit" as const } : {}),
      ...(withPermission ? { permissionMode: "explicit" as const } : {}),
    },
  };
}

/**
 * The same measured shape for a route the capability router picked, so an
 * active job's spend is recorded next to a legacy job's rather than going
 * unmeasured.
 */
export function capabilityRouteExecution(input: {
  stage: PipelineStage;
  tier: StageTier;
  providerId: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  serviceTier: StageServiceTier;
  permissionMode: StagePermissionMode | undefined;
}): ResolvedStageExecution {
  return Object.freeze({
    stage: input.stage,
    baseTier: input.tier,
    tier: input.tier,
    escalationSteps: 0,
    maxEscalations: DEFAULT_STAGE_PROFILES[input.stage].maxEscalations,
    modelPinned: true,
    providerId: input.providerId,
    model: input.model,
    reasoningLevel: input.reasoningLevel,
    serviceTier: input.serviceTier,
    permissionMode: input.permissionMode,
    source: "capability-route",
  });
}

export type StageTokenUsage = Readonly<{
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}>;

/** Spend in micro-USD for one measured usage at one published rate. */
export function costMicroUsd(rate: StageModelRate, usage: StageTokenUsage): number {
  const billedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  // A rate in USD per million tokens is exactly micro-USD per token.
  return Math.round(
    billedInput * rate.inputUsdPerMillion
    + usage.cachedInputTokens * rate.cachedInputUsdPerMillion
    + usage.outputTokens * rate.outputUsdPerMillion,
  );
}

/**
 * Measured spend in micro-USD, or null when this model has no published rate
 * entered in the catalog yet. A null cost means "not measured", never "free".
 */
export function stageCostMicroUsd(model: string, usage: StageTokenUsage): number | null {
  const rate = stageModelEntry(model)?.rate ?? null;
  return rate === null ? null : costMicroUsd(rate, usage);
}
