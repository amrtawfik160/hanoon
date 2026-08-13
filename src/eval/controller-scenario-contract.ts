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
  /** Tools supplied by the task harness outside the Hanoon controller surface. */
  outerTaskTools: z.array(z.string().min(1).max(128)).max(64).optional(),
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
const controllerLayerGradeFieldsSchema = z.object({
  status: layerStatusSchema,
  graderId: graderIdSchema,
  graderVersion: z.number().int().min(1).max(10_000),
  proofRefs: proofReferencesSchema,
}).strict();

function controllerLayerGradeSchemaFor(status: typeof layerStatusSchema | typeof scenarioLayerStatusSchema) {
  return controllerLayerGradeFieldsSchema.extend({ status }).superRefine((grade, context) => {
  if (grade.status === "passed" && grade.proofRefs.length === 0) {
    context.addIssue({ code: "custom", path: ["proofRefs"], message: "passed layers require proof references" });
  }
  });
}

const controllerLayerGradeSchema = controllerLayerGradeSchemaFor(layerStatusSchema);

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
  /** Provider token usage is nullable when the adapter does not expose it. */
  tokens: z.number().int().min(0).max(2_000_000).nullable(),
  costUsd: z.number().min(0).max(1_000).nullable(),
  terminalFailureClass: z.string().min(1).max(120).nullable(),
}).strict();

export const controllerScenarioTrialSchema = z.object({
  schemaVersion: z.literal(1),
  scenarioVersion: z.number().int().min(1).max(10_000),
  scenarioDefinitionSha256: sha256Schema.optional(),
  scenarioId: scenarioIdSchema,
  trial: z.number().int().min(1).max(1_000),
  seed: z.number().int().min(0).max(2_147_483_647),
  harness: controllerHarnessIdentitySchema,
  budget: controllerTrialBudgetSchema,
  outcome: controllerLayerGradeSchemaFor(scenarioLayerStatusSchema),
  trace: controllerLayerGradeSchemaFor(scenarioLayerStatusSchema),
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

const comparisonScenarioSideSchema = scenarioSummarySchema.extend({
  scenarioVersion: z.number().int().min(1).max(10_000),
  criticalSafety: z.boolean(),
}).strict();

const interventionHarnessSchema = z.object({
  hanoonCommit: z.string().regex(/^[0-9a-f]{40}$/),
  instructionSha256: sha256Schema,
  overlaySha256: sha256Schema,
  capabilityManifestSha256: sha256Schema,
  policySha256: sha256Schema,
  contextSha256: sha256Schema,
  parameterSchemaSha256: z.record(z.string().min(1).max(128), sha256Schema),
}).strict();

const interventionTrialSchema = z.object({
  scenarioId: scenarioIdSchema,
  scenarioVersion: z.number().int().min(1).max(10_000),
  trial: z.number().int().min(1).max(1_000),
  harness: interventionHarnessSchema,
}).strict();

export const controllerEvaluationComparisonSchema = z.object({
  status: z.literal("comparable"),
  baselineLabel: z.literal("fixed"),
  afterLabel: z.literal("fixed"),
  common: z.array(z.object({
    scenarioId: scenarioIdSchema,
    scenarioVersion: z.number().int().min(1).max(10_000),
    criticalSafety: z.boolean(),
    baseline: comparisonScenarioSideSchema,
    after: comparisonScenarioSideSchema,
  }).strict()).min(1).max(64),
  newScenarios: z.array(comparisonScenarioSideSchema).max(64),
  baselineOnlyScenarios: z.array(comparisonScenarioSideSchema).max(64),
  intervention: z.object({
    baseline: z.array(interventionTrialSchema).min(1).max(512),
    after: z.array(interventionTrialSchema).min(1).max(512),
  }).strict(),
}).strict();

export type ControllerScenarioTrial = z.infer<typeof controllerScenarioTrialSchema>;
export type ControllerEvaluationReport = z.infer<typeof controllerEvaluationReportSchema>;
export type ControllerEvaluationComparison = z.infer<typeof controllerEvaluationComparisonSchema>;

function trialPairKey(trial: ControllerScenarioTrial): string {
  return `${trial.scenarioId}:${trial.trial}`;
}

function hasDuplicateTrialPairs(trials: readonly ControllerScenarioTrial[]): boolean {
  return !unique(trials.map(trialPairKey));
}

function trialClassification(trial: ControllerScenarioTrial): "passed" | "failed" | "incomplete" {
  const applicableLayers = [trial.outcome, trial.trace, trial.answer]
    .filter((grade) => grade.status !== "not_applicable");
  if (applicableLayers.some((grade) => grade.status === "failed")) return "failed";
  if (applicableLayers.some((grade) => grade.status === "incomplete")) return "incomplete";
  return "passed";
}

function derivedReportStatus(trials: readonly ControllerScenarioTrial[]): z.infer<typeof reportStatusSchema> {
  const classifications = trials.map(trialClassification);
  if (classifications.includes("failed")) return "failed";
  if (classifications.includes("incomplete")) return "incomplete";
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
  comparison: controllerEvaluationComparisonSchema.optional(),
}).strict().superRefine((report, context) => {
  if (hasDuplicateTrialPairs(report.trials)) context.addIssue({ code: "custom", message: "duplicate scenario trial pair" });
  if (report.trialCount !== report.trials.length) context.addIssue({ code: "custom", message: "trialCount must match trials" });
  if (report.status !== derivedReportStatus(report.trials)) context.addIssue({ code: "custom", message: "status must match applicable layer outcomes" });
  if (!summariesMatch(report.trials, report.scenarios)) context.addIssue({ code: "custom", message: "scenario summaries must match trials" });
});

export function parseControllerScenarioCorpus(candidate: unknown): z.infer<typeof controllerScenarioCorpusSchema> {
  return controllerScenarioCorpusSchema.parse(candidate);
}

export function parseControllerScenarioTrial(candidate: unknown): ControllerScenarioTrial {
  return controllerScenarioTrialSchema.parse(candidate);
}

/**
 * Validate evidence produced by the current evaluator. Historical reports may
 * still parse with their older proof spelling, but a new fixed trial must bind
 * every passed proof to its scenario subject.
 */
export function validateControllerScenarioTrialEvidence(
  candidate: unknown,
): ControllerScenarioTrial {
  const trial = parseControllerScenarioTrial(candidate);
  for (const [layerName, layer] of Object.entries({
    outcome: trial.outcome,
    trace: trial.trace,
    answer: trial.answer,
  })) {
    if (layer.status !== "passed") continue;
    const subjectMarker = `:${trial.scenarioId}:`;
    if (!layer.proofRefs.every((proofRef) => proofRef.includes(subjectMarker))) {
      throw new Error(`${layerName} proof references are not subject-bound to ${trial.scenarioId}`);
    }
  }
  return trial;
}

export function parseControllerEvaluationReport(candidate: unknown): ControllerEvaluationReport {
  return controllerEvaluationReportSchema.parse(candidate);
}

type ScenarioDefinition = Readonly<{
  id: string;
  scenarioVersion: number;
  criticalSafety: boolean;
}>;

type ComparableTrialSignature = Readonly<{
  scenarioVersion: number;
  outerTaskTools: readonly string[];
  provider: string;
  model: string;
  reasoningLevel: string;
  serviceTier: string;
  permissionMode: "auto" | "accept-edits" | "full";
  contextSha256: string;
  budget: ControllerScenarioTrial["budget"];
  graders: Readonly<{
    outcome: Readonly<{ graderId: string; graderVersion: number }>;
    trace: Readonly<{ graderId: string; graderVersion: number }>;
    answer: Readonly<{ graderId: string; graderVersion: number }>;
  }>;
}>;

function comparisonScenarioKey(scenarioId: string, scenarioVersion: number): string {
  return `${scenarioId}:${scenarioVersion}`;
}

function canonicalComparisonValue(comparisonValue: unknown): string {
  if (comparisonValue === null || typeof comparisonValue === "boolean" || typeof comparisonValue === "string" || typeof comparisonValue === "number") {
    return JSON.stringify(comparisonValue);
  }
  if (Array.isArray(comparisonValue)) return `[${comparisonValue.map(canonicalComparisonValue).join(",")}]`;
  if (typeof comparisonValue !== "object") throw new TypeError("comparison identity contains a non-JSON value");
  return `{${Object.entries(comparisonValue as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalComparisonValue(entry)}`)
    .join(",")}}`;
}

function trialSignature(trial: ControllerScenarioTrial): ComparableTrialSignature {
  if (trial.harness.outerTaskTools === undefined) {
    throw new Error(`fixed comparison trial ${trial.scenarioId}:${trial.trial} is missing outer task tool identity`);
  }
  return {
    scenarioVersion: trial.scenarioVersion,
    outerTaskTools: trial.harness.outerTaskTools,
    provider: trial.harness.provider,
    model: trial.harness.model,
    reasoningLevel: trial.harness.reasoningLevel,
    serviceTier: trial.harness.serviceTier,
    permissionMode: trial.harness.permissionMode,
    contextSha256: trial.harness.contextSha256,
    budget: trial.budget,
    graders: {
      outcome: { graderId: trial.outcome.graderId, graderVersion: trial.outcome.graderVersion },
      trace: { graderId: trial.trace.graderId, graderVersion: trial.trace.graderVersion },
      answer: { graderId: trial.answer.graderId, graderVersion: trial.answer.graderVersion },
    },
  };
}

function comparableTrialIdentity(trial: ControllerScenarioTrial): string {
  return canonicalComparisonValue(trialSignature(trial));
}

function scenarioSummary(
  report: ControllerEvaluationReport,
  scenarioId: string,
  scenarioVersion: number,
  criticalSafety: boolean,
): z.infer<typeof comparisonScenarioSideSchema> {
  const summary = report.scenarios.find((candidate) => candidate.scenarioId === scenarioId);
  if (!summary) throw new Error(`comparison scenario summary is missing ${scenarioId}`);
  return { ...summary, scenarioVersion, criticalSafety };
}

function scenarioDefinitionsByKey(
  definitions: readonly ScenarioDefinition[] | undefined,
): Map<string, ScenarioDefinition> {
  return new Map((definitions ?? []).map((definition) => [
    comparisonScenarioKey(definition.id, definition.scenarioVersion),
    definition,
  ]));
}

function criticalSafetyFor(
  scenarioId: string,
  scenarioVersion: number,
  definitions: Map<string, ScenarioDefinition>,
): boolean {
  return definitions.get(comparisonScenarioKey(scenarioId, scenarioVersion))?.criticalSafety ?? false;
}

function reportScenarioKeys(report: ControllerEvaluationReport): Set<string> {
  return new Set(report.trials.map((trial) => comparisonScenarioKey(trial.scenarioId, trial.scenarioVersion)));
}

function assertCleanFixedReport(report: ControllerEvaluationReport, label: "baseline" | "after"): void {
  if (report.trials.some((trial) => trial.harness.dirty)) {
    throw new Error(`fixed comparison ${label} report contains dirty trials`);
  }
}

function requiredFixedIdentity(
  trial: ControllerScenarioTrial,
  side: "baseline" | "after",
  key: string,
): { scenarioDefinitionSha256: string; outerTaskTools: readonly string[] } {
  if (trial.scenarioDefinitionSha256 === undefined) {
    throw new Error(`fixed comparison ${side} trial ${key} ${trial.trial} is missing scenario definition identity`);
  }
  if (trial.harness.outerTaskTools === undefined) {
    throw new Error(`fixed comparison ${side} trial ${key} ${trial.trial} is missing outer task tool identity`);
  }
  return {
    scenarioDefinitionSha256: trial.scenarioDefinitionSha256,
    outerTaskTools: trial.harness.outerTaskTools,
  };
}

function reportTrialsForKey(report: ControllerEvaluationReport, key: string): ControllerScenarioTrial[] {
  return report.trials.filter((trial) => comparisonScenarioKey(trial.scenarioId, trial.scenarioVersion) === key);
}

function assertFixedComparisonIdentity(
  baselineTrials: readonly ControllerScenarioTrial[],
  afterTrials: readonly ControllerScenarioTrial[],
  key: string,
): void {
  const afterByTrial = new Map(afterTrials.map((trial) => [trial.trial, trial]));
  for (const baselineTrial of baselineTrials) {
    const afterTrial = afterByTrial.get(baselineTrial.trial);
    if (!afterTrial) continue;
    const baselineIdentity = requiredFixedIdentity(baselineTrial, "baseline", key);
    const afterIdentity = requiredFixedIdentity(afterTrial, "after", key);
    if (baselineIdentity.scenarioDefinitionSha256 !== afterIdentity.scenarioDefinitionSha256) {
      throw new Error(`fixed comparison is not comparable for ${key} trial ${baselineTrial.trial} scenario definition`);
    }
    if (JSON.stringify(baselineIdentity.outerTaskTools) !== JSON.stringify(afterIdentity.outerTaskTools)) {
      throw new Error(`fixed comparison is not comparable for ${key} trial ${baselineTrial.trial} outer task tools`);
    }
    if (comparableTrialIdentity(baselineTrial) !== comparableTrialIdentity(afterTrial)) {
      throw new Error(`fixed comparison is not comparable for ${key} trial ${baselineTrial.trial}`);
    }
  }
}

function interventionTrial(trial: ControllerScenarioTrial): z.infer<typeof interventionTrialSchema> {
  return {
    scenarioId: trial.scenarioId,
    scenarioVersion: trial.scenarioVersion,
    trial: trial.trial,
    harness: {
      hanoonCommit: trial.harness.hanoonCommit,
      instructionSha256: trial.harness.instructionSha256,
      overlaySha256: trial.harness.overlaySha256,
      capabilityManifestSha256: trial.harness.capabilityManifestSha256,
      policySha256: trial.harness.policySha256,
      contextSha256: trial.harness.contextSha256,
      parameterSchemaSha256: trial.harness.parameterSchemaSha256,
    },
  };
}

function scenarioKeysWithVersion(report: ControllerEvaluationReport): Array<{ scenarioId: string; scenarioVersion: number; key: string }> {
  return [...new Set(report.trials.map((trial) => comparisonScenarioKey(trial.scenarioId, trial.scenarioVersion)))].map((key) => {
    const separator = key.lastIndexOf(":");
    const scenarioId = key.slice(0, separator);
    const scenarioVersion = Number(key.slice(separator + 1));
    return { scenarioId, scenarioVersion, key };
  }).sort((left, right) => left.key.localeCompare(right.key));
}

export function compareControllerEvaluations(input: Readonly<{
  baseline: unknown;
  after: unknown;
  scenarioDefinitions?: readonly ScenarioDefinition[];
}>): ControllerEvaluationComparison {
  const baseline = parseControllerEvaluationReport(input.baseline);
  const after = parseControllerEvaluationReport(input.after);
  if (baseline.label !== "fixed" || after.label !== "fixed") {
    throw new Error("fixed comparison requires fixed baseline and after reports");
  }
  assertCleanFixedReport(baseline, "baseline");
  assertCleanFixedReport(after, "after");
  const baselineKeys = reportScenarioKeys(baseline);
  const afterKeys = reportScenarioKeys(after);
  const commonKeys = [...baselineKeys].filter((key) => afterKeys.has(key));
  if (commonKeys.length === 0) throw new Error("fixed comparison has no intersecting scenarios");
  const definitions = scenarioDefinitionsByKey(input.scenarioDefinitions);
  const common = commonKeys.sort().map((key) => {
    const scenario = scenarioKeysWithVersion(baseline).find((candidate) => candidate.key === key);
    if (!scenario) throw new Error(`fixed comparison scenario ${key} is missing`);
    const baselineTrials = reportTrialsForKey(baseline, key);
    const afterTrials = reportTrialsForKey(after, key);
    const baselineTrialNumbers = baselineTrials.map((trial) => trial.trial).sort((left, right) => left - right);
    const afterTrialNumbers = afterTrials.map((trial) => trial.trial).sort((left, right) => left - right);
    if (JSON.stringify(baselineTrialNumbers) !== JSON.stringify(afterTrialNumbers)) {
      throw new Error(`fixed comparison is not comparable for ${key}: trial denominators differ`);
    }
    assertFixedComparisonIdentity(baselineTrials, afterTrials, key);
    return {
      scenarioId: scenario.scenarioId,
      scenarioVersion: scenario.scenarioVersion,
      criticalSafety: criticalSafetyFor(scenario.scenarioId, scenario.scenarioVersion, definitions),
      baseline: scenarioSummary(baseline, scenario.scenarioId, scenario.scenarioVersion, criticalSafetyFor(scenario.scenarioId, scenario.scenarioVersion, definitions)),
      after: scenarioSummary(after, scenario.scenarioId, scenario.scenarioVersion, criticalSafetyFor(scenario.scenarioId, scenario.scenarioVersion, definitions)),
    };
  });
  const baselineOnly = scenarioKeysWithVersion(baseline).filter(({ key }) => !afterKeys.has(key));
  const afterOnly = scenarioKeysWithVersion(after).filter(({ key }) => !baselineKeys.has(key));
  return controllerEvaluationComparisonSchema.parse({
    status: "comparable",
    baselineLabel: baseline.label,
    afterLabel: after.label,
    common,
    newScenarios: afterOnly.map(({ scenarioId, scenarioVersion }) => scenarioSummary(
      after,
      scenarioId,
      scenarioVersion,
      criticalSafetyFor(scenarioId, scenarioVersion, definitions),
    )),
    baselineOnlyScenarios: baselineOnly.map(({ scenarioId, scenarioVersion }) => scenarioSummary(
      baseline,
      scenarioId,
      scenarioVersion,
      criticalSafetyFor(scenarioId, scenarioVersion, definitions),
    )),
    intervention: {
      baseline: baseline.trials.map(interventionTrial),
      after: after.trials.map(interventionTrial),
    },
  });
}

export function attachControllerComparison(
  reportInput: ControllerEvaluationReport,
  comparisonInput: ControllerEvaluationComparison,
): ControllerEvaluationReport {
  return controllerEvaluationReportSchema.parse({ ...reportInput, comparison: comparisonInput });
}

export function aggregateControllerEvaluation(input: {
  label: z.infer<typeof controllerEvaluationReportSchema>["label"];
  generatedAt?: string;
  trials: readonly ControllerScenarioTrial[];
  comparison?: ControllerEvaluationComparison;
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
    ...(input.comparison ? { comparison: input.comparison } : {}),
  });
}
