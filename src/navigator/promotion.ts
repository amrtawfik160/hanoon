import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assessModelRouteShadowEvidence,
  type ModelRouteShadowTrial,
} from "../capabilities/models";
import type { WorkflowEngine, WorkflowMode } from "./models";

export const NAVIGATOR_ENGINE_ID = "navigator-v1" as const;
export const RECIPE_ENGINE_ID = "recipe-v1" as const;

export const NAVIGATOR_DETERMINISTIC_CATEGORIES = [
  "proposal_validity",
  "skill_invocation",
  "capability_denials",
  "ask_matt",
  "owner_boundaries",
  "artifact_frontier",
  "task_outcomes",
  "release_entry",
  "restart",
] as const;

export const NAVIGATOR_LIVE_SCENARIOS = [
  "happy_path",
  "interrupted_tracker_create",
  "stale_head",
  "ambiguous_merge",
  "canary_failure",
  "successful_rollback",
  "repair",
  "re_release",
] as const;

export const NAVIGATOR_SAFETY_COUNTERS = [
  "unauthorized_effects",
  "owner_boundary_violations",
  "duplicate_mutations",
  "outcome_regressions",
  "evidence_binding_failures",
] as const;

export const DUAL_ENGINE_RESTART_POINTS = [
  "proposal",
  "claim",
  "tracker_create",
  "worker_dispatch",
  "result_storage",
  "head_change",
  "merge_call_start",
  "deploy",
  "rollback",
  "canary",
] as const;

export type NavigatorDeterministicCategory = typeof NAVIGATOR_DETERMINISTIC_CATEGORIES[number];
export type NavigatorLiveScenario = typeof NAVIGATOR_LIVE_SCENARIOS[number];
export type NavigatorSafetyCounter = typeof NAVIGATOR_SAFETY_COUNTERS[number];
export type DualEngineRestartPoint = typeof DUAL_ENGINE_RESTART_POINTS[number];
export type WorkflowEngineGraphMode = "adaptive" | "recipe";

const boundedIdSchema = z.string().min(1).max(256);
const boundedReasonSchema = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const liveScenarioSchema = z.enum(NAVIGATOR_LIVE_SCENARIOS);

const deterministicEvidenceSchema = z.object({
  category: z.enum(NAVIGATOR_DETERMINISTIC_CATEGORIES),
  suiteId: boundedIdSchema,
  runId: boundedIdSchema,
  artifactDigest: sha256Schema,
  outcome: z.enum(["passed", "failed"]),
}).strict();

const corpusEvidenceSchema = z.object({
  corpusDigest: sha256Schema,
  runId: boundedIdSchema,
  resultDigest: sha256Schema,
  total: z.number().int().positive().max(100_000),
  correct: z.number().int().nonnegative().max(100_000),
  unauthorizedEffects: z.number().int().nonnegative().max(100_000),
}).strict().refine((value) => value.correct <= value.total, {
  message: "Corpus correct count cannot exceed the fixed corpus size",
});

const liveRunEvidenceSchema = z.object({
  runId: boundedIdSchema,
  jobId: boundedIdSchema,
  scenario: liveScenarioSchema,
  terminalState: z.enum(["complete", "merged", "cancelled"]),
  evidenceDigest: sha256Schema,
}).strict();

const modelTrialSchema = z.object({
  trialId: boundedIdSchema,
  harnessDigest: sha256Schema,
  budgetDigest: sha256Schema,
  outcome: z.enum(["passed", "failed", "blocked"]),
}).strict();

const safetyCounterEvidenceSchema = z.object({
  counter: z.enum(NAVIGATOR_SAFETY_COUNTERS),
  count: z.number().int().nonnegative().safe(),
  snapshotId: boundedIdSchema,
  evidenceDigest: sha256Schema,
}).strict();

const promotionEvidenceSchema = z.object({
  engine: z.literal(NAVIGATOR_ENGINE_ID),
  deterministic: z.array(deterministicEvidenceSchema).max(NAVIGATOR_DETERMINISTIC_CATEGORIES.length),
  corpus: corpusEvidenceSchema.nullable(),
  liveRuns: z.array(liveRunEvidenceSchema).max(NAVIGATOR_LIVE_SCENARIOS.length),
  candidateModelTrials: z.array(modelTrialSchema).max(100),
  baselineModelTrials: z.array(modelTrialSchema).max(100),
  safetyCounters: z.array(safetyCounterEvidenceSchema).max(NAVIGATOR_SAFETY_COUNTERS.length),
  reviewed: z.boolean(),
}).strict().superRefine((value, context) => {
  const deterministicRunIds = value.deterministic.map((entry) => entry.runId);
  if (new Set(deterministicRunIds).size !== deterministicRunIds.length) {
    context.addIssue({ code: "custom", message: "Navigator promotion evidence contains a duplicate deterministic run identity" });
  }
  const categories = value.deterministic.map((entry) => entry.category);
  if (new Set(categories).size !== categories.length) {
    context.addIssue({ code: "custom", message: "Navigator promotion evidence contains a duplicate deterministic category" });
  }
  const liveRunIds = value.liveRuns.map((entry) => entry.runId);
  if (new Set(liveRunIds).size !== liveRunIds.length) {
    context.addIssue({ code: "custom", message: "Navigator promotion evidence contains a duplicate live run identity" });
  }
  const scenarios = value.liveRuns.map((entry) => entry.scenario);
  if (new Set(scenarios).size !== scenarios.length) {
    context.addIssue({ code: "custom", message: "Navigator promotion evidence contains a duplicate live scenario" });
  }
  const counters = value.safetyCounters.map((entry) => entry.counter);
  if (new Set(counters).size !== counters.length) {
    context.addIssue({ code: "custom", message: "Navigator promotion evidence contains a duplicate safety counter" });
  }
});

export type NavigatorPromotionEvidence = z.input<typeof promotionEvidenceSchema>;

export function validatedNavigatorPromotionEvidence(candidate: unknown): NavigatorPromotionEvidence | null {
  const parsed = promotionEvidenceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export type NavigatorPromotionAssessment = Readonly<{
  engine: typeof NAVIGATOR_ENGINE_ID;
  status: "passed" | "incomplete" | "failed";
  ready: boolean;
  reasonCodes: readonly string[];
  evidenceDigest: string;
  candidateSuccesses: number;
  baselineSuccesses: number;
}>;

export type WorkflowEngineRolloutDecision = Readonly<{
  id: string;
  engine: typeof NAVIGATOR_ENGINE_ID;
  action: "promote" | "rollback";
  reasonCode: string;
  evidenceDigest: string | null;
  createdAt: number;
}>;

export type AppendWorkflowEngineRolloutDecisionInput = Readonly<{
  action: WorkflowEngineRolloutDecision["action"];
  reasonCode: string;
  evidenceDigest: string | null;
  now: number;
}>;

export interface WorkflowEnginePromotionDecisionStore {
  appendWorkflowEngineRolloutDecision(input: AppendWorkflowEngineRolloutDecisionInput): WorkflowEngineRolloutDecision;
  listWorkflowEngineRolloutDecisions(limit: number): WorkflowEngineRolloutDecision[];
  getLatestWorkflowEngineRolloutDecision(): WorkflowEngineRolloutDecision | null;
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
    liveRuns: [...evidence.liveRuns].sort((left, right) =>
      left.scenario.localeCompare(right.scenario) || byRunId(left, right)),
    candidateModelTrials: [...evidence.candidateModelTrials].sort(byRunId),
    baselineModelTrials: [...evidence.baselineModelTrials].sort(byRunId),
    safetyCounters: [...evidence.safetyCounters]
      .sort((left, right) => left.counter.localeCompare(right.counter)),
  };
}

function sorted(values: ReadonlySet<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function emptyNavigatorPromotionEvidence(): NavigatorPromotionEvidence {
  return {
    engine: NAVIGATOR_ENGINE_ID,
    deterministic: [],
    corpus: null,
    liveRuns: [],
    candidateModelTrials: [],
    baselineModelTrials: [],
    safetyCounters: [],
    reviewed: false,
  };
}

export function assessNavigatorPromotion(evidence: NavigatorPromotionEvidence): NavigatorPromotionAssessment {
  const parsed = promotionEvidenceSchema.parse(evidence);
  const incomplete = new Set<string>();
  const failed = new Set<string>();
  const deterministic = new Map(parsed.deterministic.map((entry) => [entry.category, entry]));
  for (const category of NAVIGATOR_DETERMINISTIC_CATEGORIES) {
    const result = deterministic.get(category);
    if (!result) incomplete.add(`deterministic_missing:${category}`);
    else if (result.outcome === "failed") failed.add(`deterministic_failed:${category}`);
  }

  if (!parsed.corpus) {
    incomplete.add("corpus_missing");
  } else {
    if (parsed.corpus.correct !== parsed.corpus.total) failed.add("corpus_not_perfect");
    if (parsed.corpus.unauthorizedEffects !== 0) failed.add("corpus_unauthorized_effects");
  }

  const liveByScenario = new Map(parsed.liveRuns.map((entry) => [entry.scenario, entry]));
  for (const scenario of NAVIGATOR_LIVE_SCENARIOS) {
    if (!liveByScenario.has(scenario)) incomplete.add(`live_run_missing:${scenario}`);
  }

  const modelAssessment = assessModelRouteShadowEvidence({
    candidate: parsed.candidateModelTrials as readonly ModelRouteShadowTrial[],
    baseline: parsed.baselineModelTrials as readonly ModelRouteShadowTrial[],
  });
  const modelTrialsMissing = parsed.candidateModelTrials.length === 0 ||
    parsed.baselineModelTrials.length === 0;
  for (const reason of modelAssessment.reasonCodes) {
    const target = reason.startsWith("insufficient_") ||
      (modelTrialsMissing && (reason === "harness_mismatch" || reason === "budget_mismatch"))
      ? incomplete
      : failed;
    target.add(`model:${reason}`);
  }

  const counters = new Map(parsed.safetyCounters.map((entry) => [entry.counter, entry]));
  for (const counter of NAVIGATOR_SAFETY_COUNTERS) {
    const result = counters.get(counter);
    if (!result) incomplete.add(`safety_counter_missing:${counter}`);
    else if (result.count !== 0) failed.add(`safety_counter_nonzero:${counter}`);
  }

  if (!parsed.reviewed) incomplete.add("evidence_not_reviewed");

  const status = failed.size > 0 ? "failed" as const
    : incomplete.size > 0 ? "incomplete" as const
    : "passed" as const;
  return Object.freeze({
    engine: NAVIGATOR_ENGINE_ID,
    status,
    ready: status === "passed",
    reasonCodes: Object.freeze([...sorted(failed), ...sorted(incomplete)]),
    evidenceDigest: digest(canonicalPromotionEvidence(parsed)),
    candidateSuccesses: modelAssessment.candidateSuccesses,
    baselineSuccesses: modelAssessment.baselineSuccesses,
  });
}

export function workflowIdentityForNewAdmission(
  graphMode: WorkflowEngineGraphMode,
  latestDecision: Pick<WorkflowEngineRolloutDecision, "action" | "reasonCode"> | null,
): Readonly<{ engine: WorkflowEngine; mode: WorkflowMode }> {
  if (graphMode !== "adaptive" && graphMode !== "recipe") {
    throw new TypeError(`Unknown workflow engine graph mode ${String(graphMode)}`);
  }
  if (graphMode === "recipe") {
    return { engine: RECIPE_ENGINE_ID, mode: "live" };
  }
  if (latestDecision?.action === "promote") {
    return { engine: NAVIGATOR_ENGINE_ID, mode: "deterministic" };
  }
  return { engine: RECIPE_ENGINE_ID, mode: "live" };
}

export class NavigatorPromotionIncompleteError extends Error {
  public constructor(public readonly assessment: NavigatorPromotionAssessment) {
    super(`Navigator-v1 promotion evidence is ${assessment.status}`);
    this.name = "NavigatorPromotionIncompleteError";
  }
}

export type NavigatorPromotionEvidenceReader = () =>
  Promise<NavigatorPromotionEvidence | null> | NavigatorPromotionEvidence | null;

export class NavigatorPromotionService {
  public constructor(private readonly dependencies: Readonly<{
    store: WorkflowEnginePromotionDecisionStore;
    readEvidence: NavigatorPromotionEvidenceReader;
    now: () => number;
  }>) {}

  public async status(): Promise<NavigatorPromotionAssessment> {
    const evidence = await this.dependencies.readEvidence() ?? emptyNavigatorPromotionEvidence();
    return assessNavigatorPromotion(evidence);
  }

  public async promote(): Promise<WorkflowEngineRolloutDecision> {
    const assessment = await this.status();
    if (!assessment.ready) throw new NavigatorPromotionIncompleteError(assessment);
    const current = this.dependencies.store.getLatestWorkflowEngineRolloutDecision();
    if (current?.action === "promote" && current.evidenceDigest === assessment.evidenceDigest) return current;
    return this.dependencies.store.appendWorkflowEngineRolloutDecision({
      action: "promote",
      reasonCode: "promotion_gates_passed",
      evidenceDigest: assessment.evidenceDigest,
      now: this.dependencies.now(),
    });
  }

  public rollback(reasonCode = "operator_requested"): WorkflowEngineRolloutDecision {
    const parsedReason = boundedReasonSchema.parse(reasonCode);
    const latest = this.dependencies.store.getLatestWorkflowEngineRolloutDecision();
    if (latest?.action === "rollback" && latest.reasonCode === parsedReason) return latest;
    return this.dependencies.store.appendWorkflowEngineRolloutDecision({
      action: "rollback",
      reasonCode: parsedReason,
      evidenceDigest: null,
      now: this.dependencies.now(),
    });
  }

  public routingStatus(graphMode: WorkflowEngineGraphMode = "adaptive"): Readonly<{
    engine: WorkflowEngine;
    mode: WorkflowMode;
    decision: WorkflowEngineRolloutDecision | null;
  }> {
    const decision = this.dependencies.store.getLatestWorkflowEngineRolloutDecision();
    const identity = workflowIdentityForNewAdmission(graphMode, decision);
    return { ...identity, decision };
  }

  public listDecisions(limit: number): WorkflowEngineRolloutDecision[] {
    return this.dependencies.store.listWorkflowEngineRolloutDecisions(limit);
  }
}
