import { createHash } from "node:crypto";
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
  /** Optional only for parsing historical reports created before fixture identity was recorded. */
  answerFixtureSha256: sha256Schema.optional(),
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
const proofFactValueSchema = z.union([
  z.string().max(160),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const evidenceRecordRefSchema = z.string()
  .regex(/^fact:[a-z0-9]+(?:-[a-z0-9]+)*:(?:outcome|trace|answer):[a-z][a-z0-9_]{0,79}$/)
  .max(256);
const controllerScenarioEvidenceRecordSchema = z.object({
  ref: evidenceRecordRefSchema,
  subject: scenarioIdSchema,
  layer: z.enum(["outcome", "trace", "answer"]),
  assertion: assertionIdSchema,
  observed: z.boolean(),
  /** Redacted observations only; raw provider or owner text is never a fact value. */
  facts: z.record(z.string().min(1).max(64), proofFactValueSchema)
    .refine((facts) => Object.keys(facts).length <= 48, "evidence facts must remain bounded"),
}).strict();
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
  /** Current harnesses must expose these counters; historical reports may omit them until audited. */
  turns: z.number().int().min(0).max(16).optional(),
  toolCalls: z.number().int().min(0).max(512).optional(),
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
  evidenceRecords: z.array(controllerScenarioEvidenceRecordSchema).max(64).optional(),
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
  /** Optional only so historical reports can be rejected with a contract error rather than a JSON parse error. */
  scenarioVersion: z.number().int().min(1).max(10_000).optional(),
  denominator: z.number().int().min(1).max(512),
  passed: z.number().int().min(0).max(512),
  failed: z.number().int().min(0).max(512),
  incomplete: z.number().int().min(0).max(512),
}).strict();

const evaluationRunIdentitySchema = z.object({
  checkpoint: z.enum(["baseline", "kernel", "cutover"]),
  trialsPerScenario: z.number().int().min(1).max(512),
  seed: z.number().int().min(0).max(2_147_483_647),
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
  answerFixtureSha256: sha256Schema,
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
export type ControllerScenarioCase = z.infer<typeof controllerScenarioCaseSchema>;
export type ControllerScenarioCorpus = z.infer<typeof controllerScenarioCorpusSchema>;
export type ControllerScenarioEvidenceRecord = z.infer<typeof controllerScenarioEvidenceRecordSchema>;
export type ControllerEvaluationReport = z.infer<typeof controllerEvaluationReportSchema>;
export type ControllerEvaluationComparison = z.infer<typeof controllerEvaluationComparisonSchema>;

function trialPairKey(trial: ControllerScenarioTrial): string {
  return `${trial.scenarioId}:${trial.scenarioVersion}:${trial.trial}`;
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
  const countsByScenario = new Map<string, { scenarioId: string; scenarioVersion: number; passed: number; failed: number; incomplete: number }>();
  for (const currentTrial of trials) {
    const key = comparisonScenarioKey(currentTrial.scenarioId, currentTrial.scenarioVersion);
    const counts = countsByScenario.get(key) ?? {
      scenarioId: currentTrial.scenarioId,
      scenarioVersion: currentTrial.scenarioVersion,
      passed: 0,
      failed: 0,
      incomplete: 0,
    };
    counts[trialClassification(currentTrial)] += 1;
    countsByScenario.set(key, counts);
  }
  return [...countsByScenario.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, counts]) => ({
    scenarioId: counts.scenarioId,
    scenarioVersion: counts.scenarioVersion,
    denominator: counts.passed + counts.failed + counts.incomplete,
    passed: counts.passed,
    failed: counts.failed,
    incomplete: counts.incomplete,
  }));
}

function summariesMatch(trials: readonly ControllerScenarioTrial[], summaries: readonly z.infer<typeof scenarioSummarySchema>[]): boolean {
  return JSON.stringify(summarizeTrials(trials)) === JSON.stringify(summaries);
}

export const controllerEvaluationReportSchema = z.object({
  schemaVersion: z.literal(1),
  label: z.enum(["fixed", "strong", "smoke"]),
  /** Optional only for parsing historical artifacts; every current evaluator write requires it. */
  run: evaluationRunIdentitySchema.optional(),
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
  if (report.scenarios.some((summary) => summary.scenarioVersion === undefined)) {
    context.addIssue({ code: "custom", message: "scenario summaries must include scenarioVersion" });
  }
  if (!summariesMatch(report.trials, report.scenarios)) context.addIssue({ code: "custom", message: "scenario summaries must match trials" });
});

export function parseControllerScenarioCorpus(candidate: unknown): z.infer<typeof controllerScenarioCorpusSchema> {
  return controllerScenarioCorpusSchema.parse(candidate);
}

export function parseControllerScenarioTrial(candidate: unknown): ControllerScenarioTrial {
  return controllerScenarioTrialSchema.parse(candidate);
}

function validateEvidenceRecords(trial: ControllerScenarioTrial): void {
  const records = trial.evidenceRecords ?? [];
  const recordsByRef = new Map<string, ControllerScenarioEvidenceRecord>();
  for (const record of records) {
    if (recordsByRef.has(record.ref)) throw new Error(`duplicate evidence record ${record.ref}`);
    if (record.subject !== trial.scenarioId) {
      throw new Error(`evidence record ${record.ref} is not bound to ${trial.scenarioId}`);
    }
    const expectedRef = `fact:${record.subject}:${record.layer}:${record.assertion}`;
    if (record.ref !== expectedRef) throw new Error(`evidence record ${record.ref} has an invalid subject or assertion binding`);
    recordsByRef.set(record.ref, record);
  }
  for (const layer of [trial.outcome, trial.trace, trial.answer]) {
    for (const proofRef of layer.proofRefs) {
      if (proofRef.startsWith("fact:") && !recordsByRef.has(proofRef)) {
        throw new Error(`proof reference ${proofRef} has no resolvable evidence record`);
      }
    }
  }
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
  validateEvidenceRecords(trial);
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

export function validateControllerScenarioTrialBudget(candidate: unknown): ControllerScenarioTrial {
  const trial = parseControllerScenarioTrial(candidate);
  const counters: ReadonlyArray<readonly [string, number | undefined, number]> = [
    ["turns", trial.metrics.turns, trial.budget.maxTurns],
    ["toolCalls", trial.metrics.toolCalls, trial.budget.maxToolCalls],
    ["wallMs", trial.metrics.wallMs, trial.budget.maxWallMs],
  ];
  for (const [name, observed, maximum] of counters) {
    if (observed === undefined) throw new Error(`${name} execution counter is unavailable for ${trial.scenarioId}:${trial.trial}`);
    if (observed > maximum) throw new Error(`${name} execution counter exceeds budget for ${trial.scenarioId}:${trial.trial}`);
  }
  if (trial.metrics.tokens !== null && trial.metrics.tokens > trial.budget.maxTokens) {
    throw new Error(`tokens execution counter exceeds budget for ${trial.scenarioId}:${trial.trial}`);
  }
  if (trial.budget.maxCostUsd !== null && trial.metrics.costUsd !== null && trial.metrics.costUsd > trial.budget.maxCostUsd) {
    throw new Error(`cost execution counter exceeds budget for ${trial.scenarioId}:${trial.trial}`);
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
  instructionSha256: string;
  overlaySha256: string;
  capabilityManifestSha256: string;
  policySha256: string;
  contextSha256: string;
  answerFixtureSha256: string;
  advertisedTools: readonly string[];
  parameterSchemaSha256: Readonly<Record<string, string>>;
  budget: ControllerScenarioTrial["budget"];
  graders: Readonly<{
    outcome: Readonly<{ graderId: string; graderVersion: number; proofRefs: readonly string[] }>;
    trace: Readonly<{ graderId: string; graderVersion: number; proofRefs: readonly string[] }>;
    answer: Readonly<{ graderId: string; graderVersion: number; proofRefs: readonly string[] }>;
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

export function controllerScenarioDefinitionSha256(scenarioCase: ControllerScenarioCase): string {
  return createHash("sha256")
    .update(canonicalComparisonValue(scenarioCase), "utf8")
    .digest("hex");
}

function matchingScenarioDefinitions(
  trial: ControllerScenarioTrial,
  corpus: ControllerScenarioCorpus,
): ControllerScenarioCase[] {
  return corpus.cases.filter((scenarioCase) => (
    scenarioCase.id === trial.scenarioId && scenarioCase.scenarioVersion === trial.scenarioVersion
  ));
}

function assertCurrentTrialIdentity(trial: ControllerScenarioTrial): void {
  if (trial.scenarioDefinitionSha256 === undefined) {
    throw new Error(`current trial ${trial.scenarioId}:${trial.trial} is missing scenario definition identity; historical reports may remain incomplete`);
  }
  if (trial.harness.outerTaskTools === undefined) {
    throw new Error(`current trial ${trial.scenarioId}:${trial.trial} is missing outer task tool identity; historical reports may remain incomplete`);
  }
  if (trial.harness.answerFixtureSha256 === undefined) {
    throw new Error(`current trial ${trial.scenarioId}:${trial.trial} is missing answer fixture identity; historical reports may remain incomplete`);
  }
  if (trial.evidenceRecords === undefined) {
    throw new Error(`current trial ${trial.scenarioId}:${trial.trial} is missing redacted evidence records; historical reports may remain incomplete`);
  }
  if (trial.harness.instructionSha256.length === 0
    || trial.harness.capabilityManifestSha256.length === 0
    || trial.harness.policySha256.length === 0
    || trial.harness.parameterSchemaSha256 === undefined
    || Object.keys(trial.harness.parameterSchemaSha256).length === 0
    || trial.harness.advertisedTools.length === 0) {
    throw new Error(`current trial ${trial.scenarioId}:${trial.trial} is missing per-run capability or policy identity`);
  }
  assertTrialCapabilityIdentity(trial);
}

function assertTrialCapabilityIdentity(trial: ControllerScenarioTrial): void {
  const advertisedTools = [...trial.harness.advertisedTools].sort();
  const parameterSchemaTools = Object.keys(trial.harness.parameterSchemaSha256).sort();
  if (JSON.stringify(advertisedTools) !== JSON.stringify(parameterSchemaTools)) {
    throw new Error(`current trial ${trial.scenarioId}:${trial.trial} capability tools and parameter schemas do not match`);
  }
  if (new Set(trial.harness.advertisedTools).size !== trial.harness.advertisedTools.length) {
    throw new Error(`current trial ${trial.scenarioId}:${trial.trial} capability manifest contains duplicate tools`);
  }
}

function assertCurrentTrialFactReferences(trial: ControllerScenarioTrial): void {
  for (const [layerName, layer] of Object.entries({
    outcome: trial.outcome,
    trace: trial.trace,
    answer: trial.answer,
  })) {
    if (!layer.proofRefs.every((proofRef) => proofRef.startsWith("fact:"))) {
      throw new Error(`current trial ${trial.scenarioId}:${trial.trial} ${layerName} proof references must resolve to redacted evidence facts`);
    }
  }
}

function currentScenarioDefinition(
  trial: ControllerScenarioTrial,
  corpus: ControllerScenarioCorpus,
): ControllerScenarioCase {
  const matches = matchingScenarioDefinitions(trial, corpus);
  if (matches.length === 0) {
    throw new Error(`current trial references an unknown or unsupported scenario version ${trial.scenarioId}:${trial.scenarioVersion}`);
  }
  if (matches.length > 1) {
    throw new Error(`current trial references an ambiguous scenario version ${trial.scenarioId}:${trial.scenarioVersion}`);
  }
  const scenarioCase = matches[0];
  if (!scenarioCase) throw new Error(`current trial references an unknown scenario ${trial.scenarioId}:${trial.scenarioVersion}`);
  if (controllerScenarioDefinitionSha256(scenarioCase) !== trial.scenarioDefinitionSha256) {
    throw new Error(`current trial ${trial.scenarioId}:${trial.trial} has a scenario definition identity mismatch`);
  }
  return scenarioCase;
}

function expectedEvidenceRefsByLayer(
  trial: ControllerScenarioTrial,
  scenarioCase: ControllerScenarioCase,
) {
  return {
    outcome: [
      ...scenarioCase.requiredOutcomeAssertions,
      ...scenarioCase.forbiddenOutcomeAssertions,
    ].map((assertion) => `fact:${trial.scenarioId}:outcome:${assertion}`),
    trace: scenarioCase.requiredTraceAssertions
      .map((assertion) => `fact:${trial.scenarioId}:trace:${assertion}`),
    answer: scenarioCase.answerGrader === "required"
      ? [`fact:${trial.scenarioId}:answer:answer_grader`]
      : [],
  } as const;
}

function assertEvidenceRecordsPresent(
  trial: ControllerScenarioTrial,
  recordsByRef: ReadonlyMap<string, ControllerScenarioEvidenceRecord>,
  expectedRefs: readonly string[],
): void {
  for (const expectedRef of expectedRefs) {
    const record = recordsByRef.get(expectedRef);
    if (!record) {
      throw new Error(`current trial ${trial.scenarioId}:${trial.trial} is missing evidence record ${expectedRef}`);
    }
    if (Object.keys(record.facts).length === 0) {
      throw new Error(`current trial ${trial.scenarioId}:${trial.trial} evidence record ${expectedRef} has incomplete proof facts`);
    }
  }
}

function assertOutcomeFactsObserved(
  trial: ControllerScenarioTrial,
  recordsByRef: ReadonlyMap<string, ControllerScenarioEvidenceRecord>,
  assertions: readonly string[],
  expectedObserved: boolean,
): void {
  for (const assertion of assertions) {
    const ref = `fact:${trial.scenarioId}:outcome:${assertion}`;
    if (recordsByRef.get(ref)?.observed !== expectedObserved) {
      const state = expectedObserved ? "was not observed" : "was observed";
      throw new Error(`current trial ${trial.scenarioId}:${trial.trial} outcome fact ${ref} ${state}`);
    }
  }
}

function assertTraceFactsObserved(
  trial: ControllerScenarioTrial,
  recordsByRef: ReadonlyMap<string, ControllerScenarioEvidenceRecord>,
  assertions: readonly string[],
): void {
  for (const assertion of assertions) {
    const ref = `fact:${trial.scenarioId}:trace:${assertion}`;
    if (recordsByRef.get(ref)?.observed !== true) {
      throw new Error(`current trial ${trial.scenarioId}:${trial.trial} required trace fact ${ref} was not observed`);
    }
  }
}

function assertAnswerApplicability(
  trial: ControllerScenarioTrial,
  scenarioCase: ControllerScenarioCase,
  recordsByRef: ReadonlyMap<string, ControllerScenarioEvidenceRecord>,
): void {
  if (scenarioCase.answerGrader === "required") {
    if (trial.answer.status === "not_applicable") {
      throw new Error(`current trial ${trial.scenarioId}:${trial.trial} cannot relabel a required answer grader as not_applicable`);
    }
    const answerRecord = recordsByRef.get(`fact:${trial.scenarioId}:answer:answer_grader`);
    const answerObserved = trial.answer.status === "passed";
    if (answerRecord?.observed !== answerObserved) {
      throw new Error(`current trial ${trial.scenarioId}:${trial.trial} answer fact does not match answer layer status`);
    }
  } else if (trial.answer.status !== "not_applicable") {
    throw new Error(`current trial ${trial.scenarioId}:${trial.trial} has an answer grader where the corpus marks it not_applicable`);
  }
}

function assertPassedLayerProofRefs(
  trial: ControllerScenarioTrial,
  layerName: "outcome" | "trace" | "answer",
  layer: ControllerScenarioTrial["outcome"] | ControllerScenarioTrial["trace"] | ControllerScenarioTrial["answer"],
  expectedRefs: readonly string[],
): void {
  if (layer.status !== "passed") return;
  const actualRefs = new Set(layer.proofRefs);
  if (actualRefs.size !== expectedRefs.length || expectedRefs.some((ref) => !actualRefs.has(ref))) {
    throw new Error(`current trial ${trial.scenarioId}:${trial.trial} ${layerName} proof is incomplete or not bound to all declared facts`);
  }
}

function assertExpectedEvidenceRecords(
  trial: ControllerScenarioTrial,
  scenarioCase: ControllerScenarioCase,
): void {
  const recordsByRef = new Map((trial.evidenceRecords ?? []).map((record) => [record.ref, record]));
  const expectedByLayer = expectedEvidenceRefsByLayer(trial, scenarioCase);
  assertEvidenceRecordsPresent(trial, recordsByRef, [
    ...expectedByLayer.outcome,
    ...expectedByLayer.trace,
    ...expectedByLayer.answer,
  ]);
  assertOutcomeFactsObserved(trial, recordsByRef, scenarioCase.requiredOutcomeAssertions, true);
  assertOutcomeFactsObserved(trial, recordsByRef, scenarioCase.forbiddenOutcomeAssertions, false);
  assertTraceFactsObserved(trial, recordsByRef, scenarioCase.requiredTraceAssertions);
  assertAnswerApplicability(trial, scenarioCase, recordsByRef);
  assertPassedLayerProofRefs(trial, "outcome", trial.outcome, expectedByLayer.outcome);
  assertPassedLayerProofRefs(trial, "trace", trial.trace, expectedByLayer.trace);
  assertPassedLayerProofRefs(trial, "answer", trial.answer, expectedByLayer.answer);
}

export function validateControllerScenarioTrialAgainstCorpus(
  candidate: unknown,
  corpus: ControllerScenarioCorpus,
): ControllerScenarioTrial {
  const trial = validateControllerScenarioTrialEvidence(candidate);
  assertCurrentTrialIdentity(trial);
  assertCurrentTrialFactReferences(trial);
  const scenarioCase = currentScenarioDefinition(trial, corpus);
  assertExpectedEvidenceRecords(trial, scenarioCase);
  return trial;
}

export function validateControllerScenarioTrialsAgainstCorpus(
  candidates: readonly unknown[],
  corpus: ControllerScenarioCorpus,
): { trials: ControllerScenarioTrial[]; criticalSafetyFailed: boolean } {
  const trials = candidates.map((candidate) => validateControllerScenarioTrialAgainstCorpus(candidate, corpus));
  return {
    trials,
    criticalSafetyFailed: trials.some((trial) => {
      const [scenarioCase] = matchingScenarioDefinitions(trial, corpus);
      return scenarioCase?.criticalSafety === true && trial.outcome.status === "failed";
    }),
  };
}

function trialSignature(trial: ControllerScenarioTrial): ComparableTrialSignature {
  if (trial.harness.outerTaskTools === undefined) {
    throw new Error(`fixed comparison trial ${trial.scenarioId}:${trial.trial} is missing outer task tool identity`);
  }
  if (trial.harness.answerFixtureSha256 === undefined) {
    throw new Error(`fixed comparison trial ${trial.scenarioId}:${trial.trial} is missing answer fixture identity`);
  }
  return {
    scenarioVersion: trial.scenarioVersion,
    outerTaskTools: trial.harness.outerTaskTools,
    provider: trial.harness.provider,
    model: trial.harness.model,
    reasoningLevel: trial.harness.reasoningLevel,
    serviceTier: trial.harness.serviceTier,
    permissionMode: trial.harness.permissionMode,
    instructionSha256: trial.harness.instructionSha256,
    overlaySha256: trial.harness.overlaySha256,
    capabilityManifestSha256: trial.harness.capabilityManifestSha256,
    policySha256: trial.harness.policySha256,
    contextSha256: trial.harness.contextSha256,
    answerFixtureSha256: trial.harness.answerFixtureSha256,
    advertisedTools: trial.harness.advertisedTools,
    parameterSchemaSha256: trial.harness.parameterSchemaSha256,
    budget: trial.budget,
    graders: {
      outcome: { graderId: trial.outcome.graderId, graderVersion: trial.outcome.graderVersion, proofRefs: trial.outcome.proofRefs },
      trace: { graderId: trial.trace.graderId, graderVersion: trial.trace.graderVersion, proofRefs: trial.trace.proofRefs },
      answer: { graderId: trial.answer.graderId, graderVersion: trial.answer.graderVersion, proofRefs: trial.answer.proofRefs },
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
  const candidates = report.scenarios.filter((candidate) => candidate.scenarioId === scenarioId);
  const summary = candidates.find((candidate) => candidate.scenarioVersion === scenarioVersion);
  if (!summary) {
    throw new Error(`comparison scenario summary is missing or legacy for ${scenarioId}:${scenarioVersion}`);
  }
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
  const definition = definitions.get(comparisonScenarioKey(scenarioId, scenarioVersion));
  if (!definition) throw new Error(`comparison scenario definition is missing ${scenarioId}:${scenarioVersion}`);
  return definition.criticalSafety;
}

function reportScenarioKeys(report: ControllerEvaluationReport): Set<string> {
  return new Set(report.trials.map((trial) => comparisonScenarioKey(trial.scenarioId, trial.scenarioVersion)));
}

function assertCleanFixedReport(report: ControllerEvaluationReport, label: "baseline" | "after"): void {
  if (report.trials.some((trial) => trial.harness.dirty)) {
    throw new Error(`fixed comparison ${label} report contains dirty trials`);
  }
}

function assertFixedReportEvidence(report: ControllerEvaluationReport, label: "baseline" | "after"): void {
  for (const trial of report.trials) {
    try {
      validateControllerScenarioTrialEvidence(trial);
    } catch (error) {
      throw new Error(`fixed comparison ${label} trial ${trial.scenarioId}:${trial.trial} has invalid proof evidence: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function assertReportTrialIdentity(report: ControllerEvaluationReport, label: "baseline" | "after"): void {
  const run = report.run;
  if (!run) throw new Error(`fixed comparison ${label} report is missing run identity`);
  if (hasDuplicateTrialPairs(report.trials)) {
    throw new Error(`fixed comparison ${label} report contains duplicate trial identity`);
  }
  if (report.trials.some((trial) => trial.seed !== run.seed)) {
    throw new Error(`fixed comparison ${label} trial identity does not match the report seed`);
  }
  const trialNumbersByScenario = new Map<string, number[]>();
  for (const trial of report.trials) {
    const key = comparisonScenarioKey(trial.scenarioId, trial.scenarioVersion);
    const trialNumbers = trialNumbersByScenario.get(key) ?? [];
    trialNumbers.push(trial.trial);
    trialNumbersByScenario.set(key, trialNumbers);
  }
  const expectedTrialNumbers = Array.from({ length: run.trialsPerScenario }, (_, index) => index + 1);
  for (const [key, trialNumbers] of trialNumbersByScenario) {
    trialNumbers.sort((left, right) => left - right);
    if (JSON.stringify(trialNumbers) !== JSON.stringify(expectedTrialNumbers)) {
      throw new Error(`fixed comparison ${label} report trial identity is incomplete for ${key}`);
    }
  }
}

function assertFixedRunRelationship(
  baseline: ControllerEvaluationReport,
  after: ControllerEvaluationReport,
): void {
  if (!baseline.run || !after.run) throw new Error("fixed comparison requires explicit run identity");
  assertReportTrialIdentity(baseline, "baseline");
  assertReportTrialIdentity(after, "after");
  if (baseline.run.seed !== after.run.seed) {
    throw new Error("fixed comparison requires matching run seeds");
  }
  if (baseline.run.trialsPerScenario !== after.run.trialsPerScenario) {
    throw new Error("fixed comparison requires matching trial identity denominators");
  }
  const checkpointRank = { baseline: 0, kernel: 1, cutover: 2 } as const;
  if (checkpointRank[after.run.checkpoint] < checkpointRank[baseline.run.checkpoint]) {
    throw new Error("fixed comparison requires an after checkpoint at or after the baseline checkpoint");
  }
  const baselinePairs = new Set(baseline.trials.map(trialPairKey));
  const afterPairs = new Set(after.trials.map(trialPairKey));
  if ([...baselinePairs].some((pair) => !afterPairs.has(pair))) {
    throw new Error("fixed comparison requires matching trial identities");
  }
}

function assertComparableTrialBudgetEvidence(
  baselineTrial: ControllerScenarioTrial,
  afterTrial: ControllerScenarioTrial,
  key: string,
): void {
  validateControllerScenarioTrialBudget(baselineTrial);
  validateControllerScenarioTrialBudget(afterTrial);
  for (const [side, trial] of [["baseline", baselineTrial], ["after", afterTrial]] as const) {
    if (trial.metrics.turns === undefined || trial.metrics.toolCalls === undefined) {
      throw new Error(`fixed comparison ${side} trial ${key}:${trial.trial} lacks measurable turn/tool budget evidence`);
    }
  }
  const availabilityFields = [
    ["token", baselineTrial.metrics.tokens, afterTrial.metrics.tokens],
    ["cost", baselineTrial.metrics.costUsd, afterTrial.metrics.costUsd],
  ] as const;
  for (const [name, baselineMetric, afterMetric] of availabilityFields) {
    if ((baselineMetric === null) !== (afterMetric === null)) {
      throw new Error(`fixed comparison ${key} ${name} usage availability differs between baseline and after`);
    }
  }
  const scriptedFake = (trial: ControllerScenarioTrial): boolean =>
    trial.harness.provider === "fake-bb" && trial.harness.model === "scripted-controller";
  if ((baselineTrial.metrics.tokens === null || baselineTrial.metrics.costUsd === null) &&
      (!scriptedFake(baselineTrial) || !scriptedFake(afterTrial))) {
    throw new Error(`fixed comparison ${key} has unavailable real-provider usage evidence`);
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
  if (trial.harness.answerFixtureSha256 === undefined) {
    throw new Error(`fixed comparison ${side} trial ${key} ${trial.trial} is missing answer fixture identity`);
  }
  if (trial.harness.instructionSha256.length === 0
    || trial.harness.capabilityManifestSha256.length === 0
    || trial.harness.policySha256.length === 0
    || trial.harness.parameterSchemaSha256 === undefined
    || Object.keys(trial.harness.parameterSchemaSha256).length === 0
    || trial.harness.advertisedTools.length === 0) {
    throw new Error(`fixed comparison ${side} trial ${key} ${trial.trial} is missing per-run capability or policy identity`);
  }
  assertTrialCapabilityIdentity(trial);
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
      answerFixtureSha256: trial.harness.answerFixtureSha256!,
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
  scenarioCorpus?: ReturnType<typeof parseControllerScenarioCorpus>;
}>): ControllerEvaluationComparison {
  const baseline = parseControllerEvaluationReport(input.baseline);
  const after = parseControllerEvaluationReport(input.after);
  if (baseline.label !== "fixed" || after.label !== "fixed") {
    throw new Error("fixed comparison requires fixed baseline and after reports");
  }
  if (!baseline.run || !after.run) {
    throw new Error("fixed comparison requires explicit checkpoint, trial, and seed identity on both reports");
  }
  assertFixedRunRelationship(baseline, after);
  assertCleanFixedReport(baseline, "baseline");
  assertCleanFixedReport(after, "after");
  assertFixedReportEvidence(baseline, "baseline");
  assertFixedReportEvidence(after, "after");
  if (input.scenarioCorpus) {
    const baselineValidation = validateControllerScenarioTrialsAgainstCorpus(baseline.trials, input.scenarioCorpus);
    const afterValidation = validateControllerScenarioTrialsAgainstCorpus(after.trials, input.scenarioCorpus);
    baselineValidation.trials.forEach(validateControllerScenarioTrialBudget);
    afterValidation.trials.forEach(validateControllerScenarioTrialBudget);
  }
  const baselineKeys = reportScenarioKeys(baseline);
  const afterKeys = reportScenarioKeys(after);
  const commonKeys = [...baselineKeys].filter((key) => afterKeys.has(key));
  if (commonKeys.length === 0) throw new Error("fixed comparison has no intersecting scenarios");
  if (!input.scenarioDefinitions) throw new Error("fixed comparison requires definitions for every scenario");
  const definitions = scenarioDefinitionsByKey(input.scenarioDefinitions);
  for (const key of new Set([...baselineKeys, ...afterKeys])) {
    if (!definitions.has(key)) throw new Error(`fixed comparison scenario definition is missing ${key}`);
  }
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
    for (const baselineTrial of baselineTrials) {
      const afterTrial = afterTrials.find((candidate) => candidate.trial === baselineTrial.trial);
      if (!afterTrial) throw new Error(`fixed comparison is not comparable for ${key}: missing trial ${baselineTrial.trial}`);
      assertComparableTrialBudgetEvidence(baselineTrial, afterTrial, key);
    }
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
  run?: z.infer<typeof evaluationRunIdentitySchema>;
  trials: readonly ControllerScenarioTrial[];
  comparison?: ControllerEvaluationComparison;
}): ControllerEvaluationReport {
  const trials = input.trials.map(parseControllerScenarioTrial);
  return controllerEvaluationReportSchema.parse({
    schemaVersion: 1,
    label: input.label,
    ...(input.run ? { run: input.run } : {}),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    status: derivedReportStatus(trials),
    trialCount: trials.length,
    trials,
    scenarios: summarizeTrials(trials),
    ...(input.comparison ? { comparison: input.comparison } : {}),
  });
}
