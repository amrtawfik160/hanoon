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
const reportGeneratedAtSchema = z.string().refine(
  (timestamp) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) && !Number.isNaN(Date.parse(timestamp)),
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
}).strict().superRefine((report, context) => {
  if (hasDuplicateTrialPairs(report.trials)) context.addIssue({ code: "custom", message: "duplicate scenario trial pair" });
  if (report.trialCount !== report.trials.length) context.addIssue({ code: "custom", message: "trialCount must match trials" });
  if (report.status !== derivedReportStatus(report.trials)) context.addIssue({ code: "custom", message: "status must match trial outcomes" });
  if (!summariesMatch(report.trials, report.scenarios)) context.addIssue({ code: "custom", message: "scenario summaries must match trials" });
});

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
