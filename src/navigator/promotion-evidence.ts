import { createHash } from "node:crypto";
import { z } from "zod";
import {
  NAVIGATOR_DETERMINISTIC_CATEGORIES,
  NAVIGATOR_ENGINE_ID,
  NAVIGATOR_LIVE_SCENARIOS,
  NAVIGATOR_SAFETY_COUNTERS,
  type NavigatorPromotionEvidence,
  validatedNavigatorPromotionEvidence,
} from "./promotion";

const boundedIdSchema = z.string().min(1).max(256);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const nonNegativeIntegerSchema = z.number().int().nonnegative().safe();
const terminalModelOutcomeSchema = z.enum(["passed", "failed", "blocked"]);

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
  correct: nonNegativeIntegerSchema.max(100_000),
  unauthorizedEffects: nonNegativeIntegerSchema.max(100_000),
}).strict().refine((value) => value.correct <= value.total, {
  message: "Corpus correct count cannot exceed the fixed corpus size",
});

const liveRunEvidenceSchema = z.object({
  runId: boundedIdSchema,
  jobId: boundedIdSchema,
  scenario: z.enum(NAVIGATOR_LIVE_SCENARIOS),
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
  count: nonNegativeIntegerSchema,
  snapshotId: boundedIdSchema,
  evidenceDigest: sha256Schema,
}).strict();

const manifestSchema = z.object({
  id: boundedIdSchema,
  deterministicIds: z.array(boundedIdSchema).max(NAVIGATOR_DETERMINISTIC_CATEGORIES.length + 1),
  corpusId: boundedIdSchema.nullable(),
  liveRunIds: z.array(boundedIdSchema).max(NAVIGATOR_LIVE_SCENARIOS.length + 1),
  candidateModelRefIds: z.array(boundedIdSchema).max(101),
  baselineModelRefIds: z.array(boundedIdSchema).max(101),
  safetyIds: z.array(boundedIdSchema).max(NAVIGATOR_SAFETY_COUNTERS.length + 1),
  reviewed: z.boolean(),
  createdAt: nonNegativeIntegerSchema,
}).strict();

const deterministicRecordSchema = deterministicEvidenceSchema.extend({
  id: boundedIdSchema,
  recordDigest: sha256Schema,
  createdAt: nonNegativeIntegerSchema,
}).strict();

const corpusRecordSchema = corpusEvidenceSchema.extend({
  id: boundedIdSchema,
  recordDigest: sha256Schema,
  createdAt: nonNegativeIntegerSchema,
}).strict();

const liveRunRecordSchema = liveRunEvidenceSchema.extend({
  id: boundedIdSchema,
  recordDigest: sha256Schema,
  createdAt: nonNegativeIntegerSchema,
}).strict();

const modelReferenceRecordSchema = z.object({
  id: boundedIdSchema,
  cohort: z.enum(["candidate", "baseline"]),
  modelTrialId: boundedIdSchema,
  harnessDigest: sha256Schema,
  budgetDigest: sha256Schema,
  recordDigest: sha256Schema,
  createdAt: nonNegativeIntegerSchema,
}).strict();

const safetyRecordSchema = safetyCounterEvidenceSchema.extend({
  id: boundedIdSchema,
  recordDigest: sha256Schema,
  createdAt: nonNegativeIntegerSchema,
}).strict();

const liveJobSchema = z.object({
  id: boundedIdSchema,
  workflowEngine: z.literal(NAVIGATOR_ENGINE_ID),
  state: z.string().min(1).max(64),
}).strict();

const modelTrialRecordSchema = z.object({
  id: boundedIdSchema,
  outcome: z.enum(["selected", "passed", "failed", "blocked"]),
  failureSignature: sha256Schema.nullable(),
}).strict();

const snapshotSchema = z.object({
  manifest: manifestSchema,
  deterministic: z.array(deterministicRecordSchema).max(NAVIGATOR_DETERMINISTIC_CATEGORIES.length + 1),
  corpus: corpusRecordSchema.nullable(),
  liveRuns: z.array(liveRunRecordSchema).max(NAVIGATOR_LIVE_SCENARIOS.length + 1),
  modelReferences: z.array(modelReferenceRecordSchema).max(202),
  safetyCounters: z.array(safetyRecordSchema).max(NAVIGATOR_SAFETY_COUNTERS.length + 1),
  jobs: z.array(liveJobSchema).max(NAVIGATOR_LIVE_SCENARIOS.length + 1),
  modelTrials: z.array(modelTrialRecordSchema).max(202),
}).strict();

function digestFields(kind: string, values: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify([kind, ...values]), "utf8").digest("hex");
}

export function navigatorDeterministicRecordDigest(
  input: Omit<z.output<typeof deterministicRecordSchema>, "id" | "recordDigest">,
): string {
  return digestFields("navigator-deterministic-record-v1", [
    input.category, input.suiteId, input.runId, input.artifactDigest, input.outcome, input.createdAt,
  ]);
}

export function navigatorCorpusRecordDigest(
  input: Omit<z.output<typeof corpusRecordSchema>, "id" | "recordDigest">,
): string {
  return digestFields("navigator-corpus-record-v1", [
    input.corpusDigest, input.runId, input.resultDigest, input.total, input.correct,
    input.unauthorizedEffects, input.createdAt,
  ]);
}

export function navigatorLiveRecordDigest(
  input: Omit<z.output<typeof liveRunRecordSchema>, "id" | "recordDigest">,
): string {
  return digestFields("navigator-live-record-v1", [
    input.runId, input.jobId, input.scenario, input.terminalState, input.evidenceDigest, input.createdAt,
  ]);
}

export function navigatorModelReferenceRecordDigest(
  input: Omit<z.output<typeof modelReferenceRecordSchema>, "id" | "recordDigest">,
): string {
  return digestFields("navigator-model-reference-record-v1", [
    input.cohort, input.modelTrialId, input.harnessDigest, input.budgetDigest, input.createdAt,
  ]);
}

export function navigatorSafetyRecordDigest(
  input: Omit<z.output<typeof safetyRecordSchema>, "id" | "recordDigest">,
): string {
  return digestFields("navigator-safety-record-v1", [
    input.counter, input.count, input.snapshotId, input.evidenceDigest, input.createdAt,
  ]);
}

function unique(ids: readonly string[]): boolean {
  return new Set(ids).size === ids.length;
}

function recordById<T extends { id: string }>(rows: readonly T[]): Map<string, T> | null {
  if (!unique(rows.map((row) => row.id))) return null;
  return new Map(rows.map((row) => [row.id, row]));
}

function terminalTrial(
  trial: z.output<typeof modelTrialRecordSchema> | undefined,
): trial is z.output<typeof modelTrialRecordSchema> & { outcome: "passed" | "failed" | "blocked" } {
  return trial !== undefined && terminalModelOutcomeSchema.safeParse(trial.outcome).success;
}

function digestMatches<T extends { recordDigest: string }>(
  record: T,
  expected: string,
): boolean {
  return record.recordDigest === expected;
}

export function resolveDurableNavigatorPromotionEvidence(rawSnapshot: unknown): NavigatorPromotionEvidence | null {
  const parsed = snapshotSchema.safeParse(rawSnapshot);
  if (!parsed.success) return null;
  const snapshot = parsed.data;
  const deterministic = recordById(snapshot.deterministic);
  const liveRuns = recordById(snapshot.liveRuns);
  const modelReferences = recordById(snapshot.modelReferences);
  const safety = recordById(snapshot.safetyCounters);
  if (!deterministic || !liveRuns || !modelReferences || !safety) return null;
  if (snapshot.manifest.corpusId !== (snapshot.corpus?.id ?? null)) return null;
  if (!snapshot.manifest.deterministicIds.every((id) => deterministic.has(id))) return null;
  if (!snapshot.manifest.liveRunIds.every((id) => liveRuns.has(id))) return null;
  if (!snapshot.manifest.candidateModelRefIds.every((id) => modelReferences.has(id))) return null;
  if (!snapshot.manifest.baselineModelRefIds.every((id) => modelReferences.has(id))) return null;
  if (!snapshot.manifest.safetyIds.every((id) => safety.has(id))) return null;
  if (snapshot.deterministic.some((record) =>
    !digestMatches(record, navigatorDeterministicRecordDigest(record)))) return null;
  if (snapshot.corpus && !digestMatches(snapshot.corpus, navigatorCorpusRecordDigest(snapshot.corpus))) {
    return null;
  }
  if (snapshot.liveRuns.some((record) => !digestMatches(record, navigatorLiveRecordDigest(record)))) {
    return null;
  }
  if (snapshot.modelReferences.some((record) =>
    !digestMatches(record, navigatorModelReferenceRecordDigest(record)))) return null;
  if (snapshot.safetyCounters.some((record) =>
    !digestMatches(record, navigatorSafetyRecordDigest(record)))) return null;

  const jobs = new Map(snapshot.jobs.map((job) => [job.id, job]));
  for (const run of snapshot.liveRuns) {
    const job = jobs.get(run.jobId);
    if (!job || job.workflowEngine !== NAVIGATOR_ENGINE_ID || job.state !== run.terminalState) {
      return null;
    }
  }

  const trials = new Map(snapshot.modelTrials.map((trial) => [trial.id, trial]));
  const candidate: NavigatorPromotionEvidence["candidateModelTrials"] = [];
  const baseline: NavigatorPromotionEvidence["baselineModelTrials"] = [];
  for (const id of snapshot.manifest.candidateModelRefIds) {
    const reference = modelReferences.get(id);
    const trial = reference ? trials.get(reference.modelTrialId) : undefined;
    if (!reference || !terminalTrial(trial) || reference.cohort !== "candidate") return null;
    candidate.push({
      trialId: trial.id,
      harnessDigest: reference.harnessDigest,
      budgetDigest: reference.budgetDigest,
      outcome: trial.outcome,
    });
  }
  for (const id of snapshot.manifest.baselineModelRefIds) {
    const reference = modelReferences.get(id);
    const trial = reference ? trials.get(reference.modelTrialId) : undefined;
    if (!reference || !terminalTrial(trial) || reference.cohort !== "baseline") return null;
    baseline.push({
      trialId: trial.id,
      harnessDigest: reference.harnessDigest,
      budgetDigest: reference.budgetDigest,
      outcome: trial.outcome,
    });
  }

  const projection: NavigatorPromotionEvidence = {
    engine: NAVIGATOR_ENGINE_ID,
    deterministic: snapshot.manifest.deterministicIds.map((id) => {
      const record = deterministic.get(id)!;
      return {
        category: record.category,
        suiteId: record.suiteId,
        runId: record.runId,
        artifactDigest: record.artifactDigest,
        outcome: record.outcome,
      };
    }),
    corpus: snapshot.corpus ? {
      corpusDigest: snapshot.corpus.corpusDigest,
      runId: snapshot.corpus.runId,
      resultDigest: snapshot.corpus.resultDigest,
      total: snapshot.corpus.total,
      correct: snapshot.corpus.correct,
      unauthorizedEffects: snapshot.corpus.unauthorizedEffects,
    } : null,
    liveRuns: snapshot.manifest.liveRunIds.map((id) => {
      const record = liveRuns.get(id)!;
      return {
        runId: record.runId,
        jobId: record.jobId,
        scenario: record.scenario,
        terminalState: record.terminalState,
        evidenceDigest: record.evidenceDigest,
      };
    }),
    candidateModelTrials: candidate,
    baselineModelTrials: baseline,
    safetyCounters: snapshot.manifest.safetyIds.map((id) => {
      const record = safety.get(id)!;
      return {
        counter: record.counter,
        count: record.count,
        snapshotId: record.snapshotId,
        evidenceDigest: record.evidenceDigest,
      };
    }),
    reviewed: snapshot.manifest.reviewed,
  };
  return validatedNavigatorPromotionEvidence(projection);
}

export type DurableNavigatorPromotionEvidenceSource = {
  readDurableNavigatorPromotionEvidenceSnapshot(): unknown | null;
};

export class DurableNavigatorPromotionEvidenceReader {
  public constructor(private readonly source: DurableNavigatorPromotionEvidenceSource) {}

  public read(): NavigatorPromotionEvidence | null {
    try {
      const snapshot = this.source.readDurableNavigatorPromotionEvidenceSnapshot();
      return snapshot === null ? null : resolveDurableNavigatorPromotionEvidence(snapshot);
    } catch {
      return null;
    }
  }
}
