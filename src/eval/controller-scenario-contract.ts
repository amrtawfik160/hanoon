import { z } from "zod";

const assertionIdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
const graderIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/).max(80);
const scenarioIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const unique = <T>(entries: readonly T[]): boolean => new Set(entries).size === entries.length;

export const controllerHarnessIdentitySchema = z.object({
  hanoonCommit: z.string().regex(/^[0-9a-f]{40}$/),
  dirty: z.boolean(),
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(120),
  reasoningLevel: z.string().min(1).max(40),
  serviceTier: z.string().min(1).max(40),
  permissionMode: z.enum(["auto", "accept-edits", "full"]),
  instructionSha256: sha256Schema,
  overlaySha256: sha256Schema,
  capabilityManifestSha256: sha256Schema,
  policySha256: sha256Schema,
  contextSha256: sha256Schema,
  advertisedTools: z.array(z.string().min(1).max(128)).max(64),
  parameterSchemaSha256: z.record(z.string().min(1).max(128), sha256Schema),
}).strict();

export const controllerTrialBudgetSchema = z.object({
  maxTurns: z.number().int().min(1).max(16),
  maxToolCalls: z.number().int().min(0).max(512),
  maxTokens: z.number().int().min(0).max(2_000_000),
  maxWallMs: z.number().int().min(1).max(3_600_000),
  maxCostUsd: z.number().min(0).max(1_000).nullable(),
}).strict();

const assertionListSchema = z.array(assertionIdSchema).max(16).refine(unique, "assertions must be unique");
const layerStatusSchema = z.enum(["passed", "failed", "incomplete", "not_applicable"]);
const scenarioLayerStatusSchema = z.enum(["passed", "failed", "incomplete"]);
const proofReferencesSchema = z.array(z.string().min(1).max(256)).max(128).refine(unique, "proof references must be unique");
const controllerLayerGradeSchema = z.object({
  status: layerStatusSchema,
  graderId: graderIdSchema,
  graderVersion: z.number().int().min(1).max(10_000),
  proofRefs: proofReferencesSchema,
}).strict();

const controllerScenarioCaseSchema = z.object({
  id: scenarioIdSchema,
  scenarioVersion: z.literal(1),
  checkpoint: z.enum(["baseline", "kernel", "cutover"]),
  criticalSafety: z.boolean(),
  ownerMessage: z.string().min(1).max(1_000).refine((message) => message.trim() === message && message.trim().length > 0, "ownerMessage must be nonblank and trimmed"),
  budget: controllerTrialBudgetSchema,
  requiredOutcomeAssertions: assertionListSchema.min(1),
  forbiddenOutcomeAssertions: assertionListSchema,
  requiredTraceAssertions: assertionListSchema,
  answerGrader: z.enum(["required", "not_applicable"]),
}).strict();

export const controllerScenarioCorpusSchema = z.object({
  schemaVersion: z.literal(1),
  cases: z.array(controllerScenarioCaseSchema).min(1).max(64).refine(
    (cases) => unique(cases.map((scenarioCase) => scenarioCase.id)),
    "scenario case ids must be unique",
  ),
}).strict();

const controllerMetricsSchema = z.object({
  wallMs: z.number().int().min(0).max(3_600_000),
  tokens: z.number().int().min(0).max(2_000_000),
  costUsd: z.number().min(0).max(1_000).nullable(),
  terminalFailureClass: z.string().min(1).max(120).nullable(),
}).strict();

export const controllerScenarioTrialSchema = z.object({
  schemaVersion: z.literal(1),
  scenarioVersion: z.number().int().min(1).max(10_000),
  scenarioId: scenarioIdSchema,
  trial: z.number().int().min(1).max(1_000),
  seed: z.number().int().min(0).max(2_147_483_647),
  harness: controllerHarnessIdentitySchema,
  budget: controllerTrialBudgetSchema,
  outcome: controllerLayerGradeSchema.extend({ status: scenarioLayerStatusSchema }),
  trace: controllerLayerGradeSchema.extend({ status: scenarioLayerStatusSchema }),
  answer: controllerLayerGradeSchema,
  metrics: controllerMetricsSchema,
}).strict();

const reportStatusSchema = z.enum(["passed", "failed", "incomplete"]);
const iso8601TimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/;

function hasValidGeneratedAtCalendar(timestamp: string): boolean {
  const parts = iso8601TimestampPattern.exec(timestamp);
  if (parts === null) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = parts.slice(1).map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1]
    && hour <= 23 && minute <= 59 && second <= 59
    && (Number.isNaN(offsetHour) || (offsetHour <= 23 && offsetMinute <= 59));
}

const reportGeneratedAtSchema = z.string().refine(
  hasValidGeneratedAtCalendar,
  "generatedAt must be an ISO-8601 timestamp with an offset",
);
const scenarioSummarySchema = z.object({
  scenarioId: scenarioIdSchema,
  denominator: z.number().int().min(1).max(512),
  passed: z.number().int().min(0).max(512),
  failed: z.number().int().min(0).max(512),
  incomplete: z.number().int().min(0).max(512),
}).strict();

export type ControllerScenarioTrial = z.infer<typeof controllerScenarioTrialSchema>;
export type ControllerEvaluationReport = z.infer<typeof controllerEvaluationReportSchema>;

function trialPairKey(trial: ControllerScenarioTrial): string {
  return `${trial.scenarioId}:${trial.trial}`;
}

function hasDuplicateTrialPairs(trials: readonly ControllerScenarioTrial[]): boolean {
  return !unique(trials.map(trialPairKey));
}

function derivedReportStatus(trials: readonly ControllerScenarioTrial[]): z.infer<typeof reportStatusSchema> {
  if (trials.some((trial) => trial.outcome.status === "failed")) return "failed";
  if (trials.some((trial) => [trial.outcome, trial.trace, trial.answer].some((grade) => grade.status === "incomplete"))) return "incomplete";
  return "passed";
}

function trialClassification(trial: ControllerScenarioTrial): "passed" | "failed" | "incomplete" {
  if (trial.outcome.status === "failed") return "failed";
  if ([trial.outcome, trial.trace, trial.answer].some((grade) => grade.status === "incomplete")) return "incomplete";
  return "passed";
}

function summarizeTrials(trials: readonly ControllerScenarioTrial[]): z.infer<typeof scenarioSummarySchema>[] {
  const countsByScenario = new Map<string, { passed: number; failed: number; incomplete: number }>();
  for (const currentTrial of trials) {
    const counts = countsByScenario.get(currentTrial.scenarioId) ?? { passed: 0, failed: 0, incomplete: 0 };
    counts[trialClassification(currentTrial)] += 1;
    countsByScenario.set(currentTrial.scenarioId, counts);
  }
  return [...countsByScenario.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([scenarioId, counts]) => ({
    scenarioId,
    denominator: counts.passed + counts.failed + counts.incomplete,
    ...counts,
  }));
}

function summariesMatch(trials: readonly ControllerScenarioTrial[], summaries: readonly z.infer<typeof scenarioSummarySchema>[]): boolean {
  return JSON.stringify(summarizeTrials(trials)) === JSON.stringify(summaries);
}

export const controllerEvaluationReportSchema = z.object({
  schemaVersion: z.literal(1),
  label: z.enum(["fixed", "strong", "smoke"]),
  generatedAt: reportGeneratedAtSchema,
  status: reportStatusSchema,
  trialCount: z.number().int().min(1).max(512),
  trials: z.array(controllerScenarioTrialSchema).min(1).max(512),
  scenarios: z.array(scenarioSummarySchema).max(64),
  /** Present only when a report was generated against a baseline. */
  comparison: z.lazy(() => controllerComparisonSchema).nullable().optional(),
}).strict().superRefine((report, context) => {
  if (hasDuplicateTrialPairs(report.trials)) context.addIssue({ code: "custom", message: "duplicate scenario trial pair" });
  if (report.trialCount !== report.trials.length) context.addIssue({ code: "custom", message: "trialCount must match trials" });
  if (report.status !== derivedReportStatus(report.trials)) context.addIssue({ code: "custom", message: "status must match trial outcomes" });
  if (!summariesMatch(report.trials, report.scenarios)) context.addIssue({ code: "custom", message: "scenario summaries must match trials" });
});

export const CONTROLLER_CHECKPOINTS = ["baseline", "kernel", "cutover"] as const;
export type ControllerCheckpoint = (typeof CONTROLLER_CHECKPOINTS)[number];

/**
 * Checkpoint selection is cumulative, not exact. A later checkpoint runs every
 * earlier checkpoint's cases unchanged, which is the only way `--baseline` has a
 * real like-for-like intersection to compare.
 */
export function controllerCheckpointCases(checkpoint: ControllerCheckpoint): ControllerCheckpoint[] {
  return CONTROLLER_CHECKPOINTS.slice(0, CONTROLLER_CHECKPOINTS.indexOf(checkpoint) + 1);
}

const rateSchema = z.object({
  passed: z.number().int().min(0).max(512),
  denominator: z.number().int().min(1).max(512),
}).strict();

const interventionSchema = z.object({
  hanoonCommit: z.array(z.string().regex(/^[0-9a-f]{40}$/)).min(1).max(64),
  instructionSha256: z.array(sha256Schema).min(1).max(64),
  overlaySha256: z.array(sha256Schema).min(1).max(64),
  capabilityManifestSha256: z.array(sha256Schema).min(1).max(64),
  policySha256: z.array(sha256Schema).min(1).max(64),
  contextSha256: z.array(sha256Schema).min(1).max(512),
  parameterSchemaSha256: z.array(sha256Schema).max(512),
}).strict();

export const controllerComparisonSchema = z.object({
  status: z.enum(["comparable", "strong", "incomparable"]),
  baselineLabel: z.enum(["fixed", "strong", "smoke"]),
  currentLabel: z.enum(["fixed", "strong", "smoke"]),
  scenarios: z.array(z.object({
    scenarioId: scenarioIdSchema,
    scenarioVersion: z.number().int().min(1).max(10_000),
    baseline: rateSchema,
    current: rateSchema,
    regressed: z.boolean(),
  }).strict()).max(64),
  regressions: z.array(scenarioIdSchema).max(64),
  currentOnly: z.array(scenarioIdSchema).max(64),
  baselineOnly: z.array(scenarioIdSchema).max(64),
  incomparableReasons: z.array(z.string().min(1).max(200)).max(32),
  intervention: z.object({ baseline: interventionSchema, current: interventionSchema }).strict(),
}).strict();

export type ControllerEvaluationComparison = z.infer<typeof controllerComparisonSchema>;

/** How a scenario's trials scored, as a rate that is never a bare percentage. */
function scenarioRate(trials: readonly ControllerScenarioTrial[]): z.infer<typeof rateSchema> {
  return {
    passed: trials.filter((trial) => trialClassification(trial) === "passed").length,
    denominator: trials.length,
  };
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function interventionOf(report: ControllerEvaluationReport): z.infer<typeof interventionSchema> {
  return {
    hanoonCommit: distinct(report.trials.map((trial) => trial.harness.hanoonCommit)),
    instructionSha256: distinct(report.trials.map((trial) => trial.harness.instructionSha256)),
    overlaySha256: distinct(report.trials.map((trial) => trial.harness.overlaySha256)),
    capabilityManifestSha256: distinct(report.trials.map((trial) => trial.harness.capabilityManifestSha256)),
    policySha256: distinct(report.trials.map((trial) => trial.harness.policySha256)),
    contextSha256: distinct(report.trials.map((trial) => trial.harness.contextSha256)),
    parameterSchemaSha256: distinct(report.trials.flatMap((trial) => Object.values(trial.harness.parameterSchemaSha256))),
  };
}

/**
 * The fixed conditions two trials must share to be a direct comparison. The
 * Hanoon commit and the manifest, policy, instruction, overlay, context, and
 * parameter-schema digests are deliberately absent — including the advertised
 * Hanoon tool list those digests cover. They are the intervention being
 * measured, disclosed side by side: a kernel that adds capabilities would
 * otherwise be unmeasurable by construction.
 */
function fixedConditions(trial: ControllerScenarioTrial): string {
  return JSON.stringify({
    provider: trial.harness.provider,
    model: trial.harness.model,
    reasoningLevel: trial.harness.reasoningLevel,
    serviceTier: trial.harness.serviceTier,
    permissionMode: trial.harness.permissionMode,
    budget: trial.budget,
    graders: [trial.outcome, trial.trace, trial.answer].map((grade) => [grade.graderId, grade.graderVersion]),
  });
}

function trialsByScenario(report: ControllerEvaluationReport): Map<string, ControllerScenarioTrial[]> {
  const grouped = new Map<string, ControllerScenarioTrial[]>();
  for (const trial of report.trials) {
    grouped.set(trial.scenarioId, [...(grouped.get(trial.scenarioId) ?? []), trial]);
  }
  return grouped;
}

/**
 * Compares a report against an earlier one over the scenarios they genuinely
 * share. An outcome failure is a regression that no amount of trace or answer
 * success can average away.
 */
export function compareControllerEvaluations(input: {
  current: ControllerEvaluationReport;
  baseline: ControllerEvaluationReport;
}): ControllerEvaluationComparison {
  const current = controllerEvaluationReportSchema.parse(input.current);
  const baseline = controllerEvaluationReportSchema.parse(input.baseline);
  const currentByScenario = trialsByScenario(current);
  const baselineByScenario = trialsByScenario(baseline);
  const reasons: string[] = [];
  const scenarios: ControllerEvaluationComparison["scenarios"] = [];

  for (const [scenarioId, baselineTrials] of [...baselineByScenario.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const currentTrials = currentByScenario.get(scenarioId);
    if (!currentTrials) continue;
    const baselineVersion = baselineTrials[0]!.scenarioVersion;
    if (currentTrials.some((trial) => trial.scenarioVersion !== baselineVersion)) {
      reasons.push(`${scenarioId}: scenario version changed`);
      continue;
    }
    const conditions = new Set([...baselineTrials, ...currentTrials].map(fixedConditions));
    if (conditions.size !== 1) reasons.push(`${scenarioId}: fixed conditions differ`);
    const baselineRate = scenarioRate(baselineTrials);
    const currentRate = scenarioRate(currentTrials);
    scenarios.push({
      scenarioId,
      scenarioVersion: baselineVersion,
      baseline: baselineRate,
      current: currentRate,
      regressed: currentRate.passed * baselineRate.denominator < baselineRate.passed * currentRate.denominator,
    });
  }

  const status = scenarios.length === 0
    ? "incomparable"
    : reasons.length === 0 ? "comparable" : "strong";
  return controllerComparisonSchema.parse({
    status,
    baselineLabel: baseline.label,
    currentLabel: current.label,
    scenarios,
    regressions: scenarios.filter((scenario) => scenario.regressed).map((scenario) => scenario.scenarioId),
    currentOnly: [...currentByScenario.keys()].filter((scenarioId) => !baselineByScenario.has(scenarioId)).sort(),
    baselineOnly: [...baselineByScenario.keys()].filter((scenarioId) => !currentByScenario.has(scenarioId)).sort(),
    incomparableReasons: reasons,
    intervention: { baseline: interventionOf(baseline), current: interventionOf(current) },
  });
}

/** `passed/denominator`, never a bare percentage. */
export function formatControllerRate(rate: z.infer<typeof rateSchema>): string {
  return `${rate.passed}/${rate.denominator}`;
}

export function parseControllerScenarioCorpus(candidate: unknown): z.infer<typeof controllerScenarioCorpusSchema> {
  return controllerScenarioCorpusSchema.parse(candidate);
}

export function parseControllerScenarioTrial(candidate: unknown): ControllerScenarioTrial {
  return controllerScenarioTrialSchema.parse(candidate);
}

export function aggregateControllerEvaluation(input: {
  label: z.infer<typeof controllerEvaluationReportSchema>["label"];
  generatedAt?: string;
  trials: readonly ControllerScenarioTrial[];
}): ControllerEvaluationReport {
  const trials = input.trials.map(parseControllerScenarioTrial);
  return controllerEvaluationReportSchema.parse({
    schemaVersion: 1,
    label: input.label,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    status: derivedReportStatus(trials),
    trialCount: trials.length,
    trials,
    scenarios: summarizeTrials(trials),
  });
}
