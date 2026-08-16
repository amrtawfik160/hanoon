import { createHash } from "node:crypto";
import { z } from "zod";
import { TASK_RECIPES, type TaskRecipe } from "../domain/recipes";
import {
  DETERMINISTIC_PROMOTION_CATEGORIES,
  SAFETY_PROMOTION_COUNTERS,
  type RecipePromotionEvidence,
  validatedRecipePromotionEvidence,
} from "./promotion";

const boundedIdSchema = z.string().min(1).max(256);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const taskRecipeSchema = z.enum(TASK_RECIPES);
const nonNegativeIntegerSchema = z.number().int().nonnegative().safe();
const terminalModelOutcomeSchema = z.enum(["passed", "failed", "blocked"]);

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
  correct: nonNegativeIntegerSchema.max(100_000),
  unsafeDowngrades: nonNegativeIntegerSchema.max(100_000),
}).strict().refine((value) => value.correct <= value.total, {
  message: "Classifier correct count cannot exceed total",
});

const safetyCounterEvidenceSchema = z.object({
  counter: z.enum(SAFETY_PROMOTION_COUNTERS),
  count: nonNegativeIntegerSchema,
  snapshotId: boundedIdSchema,
  evidenceDigest: sha256Schema,
}).strict();

const manifestSchema = z.object({
  id: boundedIdSchema,
  recipe: taskRecipeSchema,
  deterministicIds: z.array(boundedIdSchema).max(DETERMINISTIC_PROMOTION_CATEGORIES.length + 1),
  classifierId: boundedIdSchema.nullable(),
  liveRunIds: z.array(boundedIdSchema).max(33),
  candidateModelRefIds: z.array(boundedIdSchema).max(101),
  baselineModelRefIds: z.array(boundedIdSchema).max(101),
  safetyIds: z.array(boundedIdSchema).max(SAFETY_PROMOTION_COUNTERS.length + 1),
  createdAt: nonNegativeIntegerSchema,
}).strict();

const deterministicRecordSchema = deterministicEvidenceSchema.extend({
  id: boundedIdSchema,
  recipe: taskRecipeSchema,
  recordDigest: sha256Schema,
  createdAt: nonNegativeIntegerSchema,
}).strict();

const classifierRecordSchema = classifierEvidenceSchema.extend({
  id: boundedIdSchema,
  recipe: taskRecipeSchema,
  recordDigest: sha256Schema,
  createdAt: nonNegativeIntegerSchema,
}).strict();

const liveRunRecordSchema = z.object({
  id: boundedIdSchema,
  recipe: taskRecipeSchema,
  jobId: boundedIdSchema,
  evidenceDigest: sha256Schema,
  createdAt: nonNegativeIntegerSchema,
}).strict();

const liveReceiptRecordSchema = z.object({
  id: boundedIdSchema,
  runId: boundedIdSchema,
  recipe: taskRecipeSchema,
  jobId: boundedIdSchema,
  receiptKind: z.enum(["induced_failure", "recovery"]),
  modelTrialId: boundedIdSchema,
  evidenceDigest: sha256Schema,
  createdAt: nonNegativeIntegerSchema,
}).strict();

const modelReferenceRecordSchema = z.object({
  id: boundedIdSchema,
  recipe: taskRecipeSchema,
  cohort: z.enum(["candidate", "baseline"]),
  modelTrialId: boundedIdSchema,
  harnessDigest: sha256Schema,
  budgetDigest: sha256Schema,
  recordDigest: sha256Schema,
  createdAt: nonNegativeIntegerSchema,
}).strict();

const safetyRecordSchema = safetyCounterEvidenceSchema.extend({
  id: boundedIdSchema,
  recipe: taskRecipeSchema,
  recordDigest: sha256Schema,
  createdAt: nonNegativeIntegerSchema,
}).strict();

const promotionJobSchema = z.object({
  id: boundedIdSchema,
  recipe: taskRecipeSchema,
  routingMode: z.enum(["legacy", "shadow", "active"]),
  state: z.string().min(1).max(64),
  mergeCommitSha: z.string().regex(/^[0-9a-f]{40}$/u).nullable(),
  mergedAt: z.string().min(1).max(128).nullable(),
}).strict();

const modelTrialRecordSchema = z.object({
  id: boundedIdSchema,
  outcome: terminalModelOutcomeSchema.or(z.literal("selected")),
  failureSignature: z.string().min(1).max(256).nullable(),
  subjectJobId: boundedIdSchema.nullable(),
  subjectJobRecipe: taskRecipeSchema.nullable(),
  subjectJobRoutingMode: z.enum(["legacy", "shadow", "active"]).nullable(),
  createdAt: nonNegativeIntegerSchema,
  settledAt: nonNegativeIntegerSchema.nullable(),
}).strict();

const snapshotSchema = z.object({
  manifest: manifestSchema,
  deterministic: z.array(deterministicRecordSchema).max(DETERMINISTIC_PROMOTION_CATEGORIES.length + 1),
  classifier: classifierRecordSchema.nullable(),
  liveRuns: z.array(liveRunRecordSchema).max(33),
  liveReceipts: z.array(liveReceiptRecordSchema).max(66),
  modelReferences: z.array(modelReferenceRecordSchema).max(202),
  safetyCounters: z.array(safetyRecordSchema).max(SAFETY_PROMOTION_COUNTERS.length + 1),
  jobs: z.array(promotionJobSchema).max(64),
  modelTrials: z.array(modelTrialRecordSchema).max(234),
}).strict();

export type DurableRecipePromotionEvidenceSnapshot = z.input<typeof snapshotSchema>;

export interface DurableRecipePromotionEvidenceSource {
  readDurableRecipePromotionEvidenceSnapshot(recipe: TaskRecipe): unknown | null;
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function exactRecordMap<T extends { id: string }>(
  ids: readonly string[],
  records: readonly T[],
): Map<string, T> | null {
  if (!unique(ids) || !unique(records.map((record) => record.id))) return null;
  const expected = new Set(ids);
  if (records.length !== expected.size || records.some((record) => !expected.has(record.id))) return null;
  return new Map(records.map((record) => [record.id, record]));
}

function digestFields(label: string, fields: readonly (string | number)[]): string {
  const hash = createHash("sha256").update(label, "utf8").update("\0", "utf8");
  for (const field of fields) hash.update(String(field), "utf8").update("\0", "utf8");
  return hash.digest("hex");
}

export function promotionDeterministicRecordDigest(
  input: Omit<z.output<typeof deterministicRecordSchema>, "id" | "recordDigest">,
): string {
  return digestFields("promotion-deterministic-record-v1", [
    input.recipe,
    input.category,
    input.suiteId,
    input.runId,
    input.artifactDigest,
    input.outcome,
    input.createdAt,
  ]);
}

export function promotionClassifierRecordDigest(
  input: Omit<z.output<typeof classifierRecordSchema>, "id" | "recordDigest">,
): string {
  return digestFields("promotion-classifier-record-v1", [
    input.recipe,
    input.corpusDigest,
    input.runId,
    input.resultDigest,
    input.total,
    input.correct,
    input.unsafeDowngrades,
    input.createdAt,
  ]);
}

export function promotionModelReferenceRecordDigest(
  input: Omit<z.output<typeof modelReferenceRecordSchema>, "id" | "recordDigest">,
): string {
  return digestFields("promotion-model-reference-v1", [
    input.recipe,
    input.cohort,
    input.modelTrialId,
    input.harnessDigest,
    input.budgetDigest,
    input.createdAt,
  ]);
}

export function promotionSafetyRecordDigest(
  input: Omit<z.output<typeof safetyRecordSchema>, "id" | "recordDigest">,
): string {
  return digestFields("promotion-safety-record-v1", [
    input.recipe,
    input.counter,
    input.count,
    input.snapshotId,
    input.evidenceDigest,
    input.createdAt,
  ]);
}

export function promotionLiveReceiptDigest(input: Readonly<{
  receiptKind: "induced_failure" | "recovery";
  runId: string;
  jobId: string;
  modelTrialId: string;
  trialOutcome: "passed" | "failed" | "blocked";
  failureSignature: string | null;
  trialSettledAt: number;
}>): string {
  return digestFields("promotion-live-receipt-v1", [
    input.receiptKind,
    input.runId,
    input.jobId,
    input.modelTrialId,
    input.trialOutcome,
    input.failureSignature ?? "",
    input.trialSettledAt,
  ]);
}

export function promotionLiveRunDigest(input: Readonly<{
  runId: string;
  jobId: string;
  recipe: TaskRecipe;
  mergeCommitSha: string;
  mergedAt: string;
  inducedFailureReceiptId: string;
  recoveryReceiptId: string;
  inducedFailureTrialId: string;
  recoveryTrialId: string;
}>): string {
  return digestFields("promotion-live-run-v1", [
    input.runId,
    input.jobId,
    input.recipe,
    input.mergeCommitSha,
    input.mergedAt,
    input.inducedFailureReceiptId,
    input.recoveryReceiptId,
    input.inducedFailureTrialId,
    input.recoveryTrialId,
  ]);
}

const POST_MERGE_STATES = new Set([
  "merged",
  "deploying",
  "verifying_production",
  "production_failed",
  "complete",
]);

type PromotionSnapshot = z.output<typeof snapshotSchema>;
type DeterministicRecord = z.output<typeof deterministicRecordSchema>;
type LiveRunRecord = z.output<typeof liveRunRecordSchema>;
type LiveReceiptRecord = z.output<typeof liveReceiptRecordSchema>;
type ModelReferenceRecord = z.output<typeof modelReferenceRecordSchema>;
type SafetyRecord = z.output<typeof safetyRecordSchema>;
type PromotionJob = z.output<typeof promotionJobSchema>;
type ModelTrialRecord = z.output<typeof modelTrialRecordSchema>;
type ModelTrialProjection = RecipePromotionEvidence["candidateModelTrials"][number];
type TerminalModelTrial = ModelTrialRecord & {
  outcome: "passed" | "failed" | "blocked";
  settledAt: number;
};
type MergedPromotionJob = PromotionJob & { mergeCommitSha: string; mergedAt: string };

type EvidenceRecordMaps = Readonly<{
  deterministic: Map<string, DeterministicRecord>;
  liveRuns: Map<string, LiveRunRecord>;
  safety: Map<string, SafetyRecord>;
  candidate: Map<string, ModelReferenceRecord>;
  baseline: Map<string, ModelReferenceRecord>;
}>;

type AuthorityRecordMaps = Readonly<{
  jobs: Map<string, PromotionJob>;
  trials: Map<string, ModelTrialRecord>;
  comparedTrialIds: ReadonlySet<string>;
}>;

type ModelEvidenceProjection = Readonly<{
  candidate: ModelTrialProjection[];
  baseline: ModelTrialProjection[];
}>;

type LiveReceiptPair = Readonly<{
  failure: LiveReceiptRecord;
  recovery: LiveReceiptRecord;
}>;

type LiveTrialPair = Readonly<{
  failure: TerminalModelTrial;
  recovery: TerminalModelTrial;
}>;

function manifestClassifierMatches(snapshot: PromotionSnapshot): boolean {
  const classifierId = snapshot.manifest.classifierId;
  return classifierId === null
    ? snapshot.classifier === null
    : snapshot.classifier?.id === classifierId;
}

function evidenceRecordMaps(snapshot: PromotionSnapshot): EvidenceRecordMaps | null {
  const candidateRecords = snapshot.modelReferences.filter((record) => record.cohort === "candidate");
  const baselineRecords = snapshot.modelReferences.filter((record) => record.cohort === "baseline");
  const maps = {
    deterministic: exactRecordMap(snapshot.manifest.deterministicIds, snapshot.deterministic),
    liveRuns: exactRecordMap(snapshot.manifest.liveRunIds, snapshot.liveRuns),
    safety: exactRecordMap(snapshot.manifest.safetyIds, snapshot.safetyCounters),
    candidate: exactRecordMap(snapshot.manifest.candidateModelRefIds, candidateRecords),
    baseline: exactRecordMap(snapshot.manifest.baselineModelRefIds, baselineRecords),
  };
  return Object.values(maps).some((records) => records === null) ? null : maps as EvidenceRecordMaps;
}

function evidenceRows(snapshot: PromotionSnapshot) {
  return [
    ...snapshot.deterministic,
    ...(snapshot.classifier ? [snapshot.classifier] : []),
    ...snapshot.liveRuns,
    ...snapshot.liveReceipts,
    ...snapshot.modelReferences,
    ...snapshot.safetyCounters,
  ];
}

function evidenceRowsMatchManifest(recipe: TaskRecipe, snapshot: PromotionSnapshot): boolean {
  return evidenceRows(snapshot).every((record) =>
    record.recipe === recipe && record.createdAt < snapshot.manifest.createdAt);
}

function evidenceRecordDigestsMatch(snapshot: PromotionSnapshot): boolean {
  const deterministicMatch = snapshot.deterministic.every((record) =>
    record.recordDigest === promotionDeterministicRecordDigest(record));
  const classifierMatch = snapshot.classifier === null ||
    snapshot.classifier.recordDigest === promotionClassifierRecordDigest(snapshot.classifier);
  const modelReferencesMatch = snapshot.modelReferences.every((record) =>
    record.recordDigest === promotionModelReferenceRecordDigest(record));
  const safetyMatch = snapshot.safetyCounters.every((record) =>
    record.recordDigest === promotionSafetyRecordDigest(record));
  return deterministicMatch && classifierMatch && modelReferencesMatch && safetyMatch;
}

function authorityRecordMaps(snapshot: PromotionSnapshot): AuthorityRecordMaps | null {
  const jobs = exactRecordMap(snapshot.jobs.map((job) => job.id), snapshot.jobs);
  const trials = exactRecordMap(snapshot.modelTrials.map((trial) => trial.id), snapshot.modelTrials);
  if (!jobs || !trials) return null;
  const referencedTrialIds = [
    ...snapshot.modelReferences.map((reference) => reference.modelTrialId),
    ...snapshot.liveReceipts.map((receipt) => receipt.modelTrialId),
  ];
  const expectedTrialIds = new Set(referencedTrialIds);
  if (expectedTrialIds.size !== snapshot.modelTrials.length) return null;
  if (snapshot.modelTrials.some((trial) => !expectedTrialIds.has(trial.id))) return null;
  const comparedTrialIds = snapshot.modelReferences.map((reference) => reference.modelTrialId);
  return unique(comparedTrialIds) ? { jobs, trials, comparedTrialIds: new Set(comparedTrialIds) } : null;
}

function terminalTrial(trial: ModelTrialRecord | undefined): trial is TerminalModelTrial {
  return trial !== undefined && trial.outcome !== "selected" && trial.settledAt !== null;
}

function modelTrialMatchesReference(input: Readonly<{
  recipe: TaskRecipe;
  reference: ModelReferenceRecord;
  trial: TerminalModelTrial;
}>): boolean {
  const { recipe, reference, trial } = input;
  if (trial.subjectJobId === null || trial.subjectJobRecipe !== recipe) return false;
  if (trial.subjectJobRoutingMode === null || trial.subjectJobRoutingMode === "legacy") return false;
  if (reference.createdAt < trial.settledAt) return false;
  return trial.outcome === "passed" ? trial.failureSignature === null : trial.failureSignature !== null;
}

function modelTrialProjection(input: Readonly<{
  recipe: TaskRecipe;
  reference: ModelReferenceRecord;
  trials: ReadonlyMap<string, ModelTrialRecord>;
}>): ModelTrialProjection | null {
  const trial = input.trials.get(input.reference.modelTrialId);
  if (!terminalTrial(trial)) return null;
  if (!modelTrialMatchesReference({ recipe: input.recipe, reference: input.reference, trial })) return null;
  return {
    trialId: trial.id,
    harnessDigest: input.reference.harnessDigest,
    budgetDigest: input.reference.budgetDigest,
    outcome: trial.outcome,
  };
}

function modelCohortProjection(input: Readonly<{
  recipe: TaskRecipe;
  ids: readonly string[];
  references: ReadonlyMap<string, ModelReferenceRecord>;
  trials: ReadonlyMap<string, ModelTrialRecord>;
}>): ModelTrialProjection[] | null {
  const projected = input.ids.map((id) => {
    const reference = input.references.get(id);
    return reference ? modelTrialProjection({ ...input, reference }) : null;
  });
  if (projected.some((trial) => trial === null)) return null;
  return projected.filter((trial): trial is ModelTrialProjection => trial !== null);
}

function modelEvidenceProjection(input: Readonly<{
  recipe: TaskRecipe;
  snapshot: PromotionSnapshot;
  evidence: EvidenceRecordMaps;
  authority: AuthorityRecordMaps;
}>): ModelEvidenceProjection | null {
  const { recipe, snapshot, evidence, authority } = input;
  const candidate = modelCohortProjection({
    recipe, ids: snapshot.manifest.candidateModelRefIds, references: evidence.candidate, trials: authority.trials,
  });
  const baseline = modelCohortProjection({
    recipe, ids: snapshot.manifest.baselineModelRefIds, references: evidence.baseline, trials: authority.trials,
  });
  return candidate && baseline ? { candidate, baseline } : null;
}

function mergedPromotionJob(
  recipe: TaskRecipe,
  run: LiveRunRecord,
  jobs: ReadonlyMap<string, PromotionJob>,
): MergedPromotionJob | null {
  const job = jobs.get(run.jobId);
  if (!job || job.recipe !== recipe || job.routingMode !== "active") return null;
  if (!POST_MERGE_STATES.has(job.state) || job.mergeCommitSha === null || job.mergedAt === null) return null;
  return Number.isFinite(Date.parse(job.mergedAt)) ? job as MergedPromotionJob : null;
}

function liveReceiptPair(input: Readonly<{
  snapshot: PromotionSnapshot;
  run: LiveRunRecord;
  comparedTrialIds: ReadonlySet<string>;
}>): LiveReceiptPair | null {
  const receipts = input.snapshot.liveReceipts.filter((receipt) => receipt.runId === input.run.id);
  if (receipts.length !== 2) return null;
  const failure = receipts.find((receipt) => receipt.receiptKind === "induced_failure");
  const recovery = receipts.find((receipt) => receipt.receiptKind === "recovery");
  if (!failure || !recovery || failure.id === recovery.id) return null;
  if (failure.jobId !== input.run.jobId || recovery.jobId !== input.run.jobId) return null;
  if (failure.createdAt >= recovery.createdAt) return null;
  if (!input.comparedTrialIds.has(failure.modelTrialId)) return null;
  return input.comparedTrialIds.has(recovery.modelTrialId) ? { failure, recovery } : null;
}

function liveTrialPair(
  receipts: LiveReceiptPair,
  run: LiveRunRecord,
  trials: ReadonlyMap<string, ModelTrialRecord>,
): LiveTrialPair | null {
  const failure = trials.get(receipts.failure.modelTrialId);
  const recovery = trials.get(receipts.recovery.modelTrialId);
  if (!terminalTrial(failure) || !terminalTrial(recovery)) return null;
  if (failure.outcome === "passed" || failure.failureSignature === null) return null;
  if (recovery.outcome !== "passed" || recovery.failureSignature !== null) return null;
  if (failure.subjectJobId !== run.jobId || recovery.subjectJobId !== run.jobId) return null;
  return { failure, recovery };
}

function liveChronologyIsCausal(input: Readonly<{
  run: LiveRunRecord;
  receipts: LiveReceiptPair;
  trials: LiveTrialPair;
  job: MergedPromotionJob;
  manifestCreatedAt: number;
}>): boolean {
  const { run, receipts, trials, job, manifestCreatedAt } = input;
  const mergedAt = Date.parse(job.mergedAt);
  return trials.failure.settledAt < receipts.failure.createdAt &&
    trials.failure.settledAt < trials.recovery.settledAt &&
    trials.recovery.settledAt < receipts.recovery.createdAt &&
    receipts.recovery.createdAt < mergedAt && mergedAt < run.createdAt &&
    run.createdAt < manifestCreatedAt;
}

function liveReceiptDigestMatches(receipt: LiveReceiptRecord, trial: TerminalModelTrial): boolean {
  return receipt.evidenceDigest === promotionLiveReceiptDigest({
    receiptKind: receipt.receiptKind,
    runId: receipt.runId,
    jobId: receipt.jobId,
    modelTrialId: trial.id,
    trialOutcome: trial.outcome,
    failureSignature: trial.failureSignature,
    trialSettledAt: trial.settledAt,
  });
}

function liveRunDigestMatches(input: Readonly<{
  run: LiveRunRecord;
  receipts: LiveReceiptPair;
  trials: LiveTrialPair;
  job: MergedPromotionJob;
  recipe: TaskRecipe;
}>): boolean {
  const { run, receipts, trials, job, recipe } = input;
  return run.evidenceDigest === promotionLiveRunDigest({
    runId: run.id,
    jobId: run.jobId,
    recipe,
    mergeCommitSha: job.mergeCommitSha,
    mergedAt: job.mergedAt,
    inducedFailureReceiptId: receipts.failure.id,
    recoveryReceiptId: receipts.recovery.id,
    inducedFailureTrialId: trials.failure.id,
    recoveryTrialId: trials.recovery.id,
  });
}

function liveRunProjection(input: Readonly<{
  recipe: TaskRecipe;
  snapshot: PromotionSnapshot;
  run: LiveRunRecord;
  authority: AuthorityRecordMaps;
}>): RecipePromotionEvidence["liveRuns"][number] | null {
  const { recipe, snapshot, run, authority } = input;
  const job = mergedPromotionJob(recipe, run, authority.jobs);
  const receipts = liveReceiptPair({ snapshot, run, comparedTrialIds: authority.comparedTrialIds });
  if (!job || !receipts) return null;
  const trials = liveTrialPair(receipts, run, authority.trials);
  if (!trials) return null;
  if (!liveChronologyIsCausal({ run, receipts, trials, job, manifestCreatedAt: snapshot.manifest.createdAt })) return null;
  if (!liveReceiptDigestMatches(receipts.failure, trials.failure)) return null;
  if (!liveReceiptDigestMatches(receipts.recovery, trials.recovery)) return null;
  if (!liveRunDigestMatches({ run, receipts, trials, job, recipe })) return null;
  return {
    runId: run.id, jobId: run.jobId, recipe, terminalState: "merged",
    inducedFailureReceiptId: receipts.failure.id,
    recoveryReceiptId: receipts.recovery.id, evidenceDigest: run.evidenceDigest,
  };
}

function liveEvidenceProjection(input: Readonly<{
  recipe: TaskRecipe;
  snapshot: PromotionSnapshot;
  evidence: EvidenceRecordMaps;
  authority: AuthorityRecordMaps;
}>): RecipePromotionEvidence["liveRuns"] | null {
  if (!unique(input.snapshot.liveReceipts.map((receipt) => receipt.id))) return null;
  const projected = input.snapshot.manifest.liveRunIds.map((runId) => {
    const run = input.evidence.liveRuns.get(runId);
    return run ? liveRunProjection({ ...input, run }) : null;
  });
  if (projected.some((run) => run === null)) return null;
  const expectedRunIds = new Set(input.snapshot.manifest.liveRunIds);
  if (input.snapshot.liveReceipts.some((receipt) => !expectedRunIds.has(receipt.runId))) return null;
  return projected.filter((run): run is RecipePromotionEvidence["liveRuns"][number] => run !== null);
}

function deterministicProjection(snapshot: PromotionSnapshot, evidence: EvidenceRecordMaps) {
  return snapshot.manifest.deterministicIds.map((id) => {
    const record = evidence.deterministic.get(id)!;
    return {
      category: record.category, suiteId: record.suiteId, runId: record.runId,
      artifactDigest: record.artifactDigest, outcome: record.outcome,
    };
  });
}

function safetyProjection(snapshot: PromotionSnapshot, evidence: EvidenceRecordMaps) {
  return snapshot.manifest.safetyIds.map((id) => {
    const record = evidence.safety.get(id)!;
    return {
      counter: record.counter, count: record.count, snapshotId: record.snapshotId,
      evidenceDigest: record.evidenceDigest,
    };
  });
}

function classifierProjection(snapshot: PromotionSnapshot): RecipePromotionEvidence["classifier"] {
  const classifier = snapshot.classifier;
  return classifier ? {
    corpusDigest: classifier.corpusDigest, runId: classifier.runId,
    resultDigest: classifier.resultDigest, total: classifier.total,
    correct: classifier.correct, unsafeDowngrades: classifier.unsafeDowngrades,
  } : null;
}

function promotionEvidenceProjection(input: Readonly<{
  recipe: TaskRecipe;
  snapshot: PromotionSnapshot;
  evidence: EvidenceRecordMaps;
  model: ModelEvidenceProjection;
  liveRuns: RecipePromotionEvidence["liveRuns"];
}>): RecipePromotionEvidence {
  return {
    recipe: input.recipe,
    deterministic: deterministicProjection(input.snapshot, input.evidence),
    classifier: classifierProjection(input.snapshot),
    liveRuns: input.liveRuns,
    candidateModelTrials: input.model.candidate,
    baselineModelTrials: input.model.baseline,
    safetyCounters: safetyProjection(input.snapshot, input.evidence),
  };
}

export function resolveDurableRecipePromotionEvidence(
  recipe: TaskRecipe,
  rawSnapshot: unknown,
): RecipePromotionEvidence | null {
  const parsedRecipe = taskRecipeSchema.safeParse(recipe);
  const parsedSnapshot = snapshotSchema.safeParse(rawSnapshot);
  if (!parsedRecipe.success || !parsedSnapshot.success) return null;
  const snapshot = parsedSnapshot.data;
  if (snapshot.manifest.recipe !== parsedRecipe.data) return null;
  if (!manifestClassifierMatches(snapshot)) return null;
  const evidence = evidenceRecordMaps(snapshot);
  if (!evidence || !evidenceRowsMatchManifest(parsedRecipe.data, snapshot)) return null;
  if (!evidenceRecordDigestsMatch(snapshot)) return null;
  const authority = authorityRecordMaps(snapshot);
  if (!authority) return null;
  const model = modelEvidenceProjection({ recipe: parsedRecipe.data, snapshot, evidence, authority });
  if (!model) return null;
  const liveRuns = liveEvidenceProjection({ recipe: parsedRecipe.data, snapshot, evidence, authority });
  if (!liveRuns) return null;
  const projection = promotionEvidenceProjection({
    recipe: parsedRecipe.data, snapshot, evidence, model, liveRuns,
  });
  return validatedRecipePromotionEvidence(projection);
}

/** Treats storage or decoding failures as incomplete evidence so promotion cannot block plugin startup. */
export class DurableRecipePromotionEvidenceReader {
  public constructor(private readonly source: DurableRecipePromotionEvidenceSource) {}

  public read(recipe: TaskRecipe): RecipePromotionEvidence | null {
    try {
      const snapshot = this.source.readDurableRecipePromotionEvidenceSnapshot(recipe);
      return snapshot === null ? null : resolveDurableRecipePromotionEvidence(recipe, snapshot);
    } catch {
      return null;
    }
  }
}
