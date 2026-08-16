import type Database from "better-sqlite3";
import type { TaskRecipe } from "../domain/recipes";

type SqliteDatabase = Database.Database;

type ManifestRow = {
  id: string;
  recipe: TaskRecipe;
  deterministic_ids_json: string;
  classifier_id: string | null;
  live_run_ids_json: string;
  candidate_model_ref_ids_json: string;
  baseline_model_ref_ids_json: string;
  safety_ids_json: string;
  created_at: number;
};

type DeterministicRow = {
  id: string; recipe: TaskRecipe; category: string; suite_id: string; run_id: string;
  artifact_digest: string; outcome: "passed" | "failed"; record_digest: string; created_at: number;
};

type ClassifierRow = {
  id: string; recipe: TaskRecipe; corpus_digest: string; run_id: string; result_digest: string;
  total: number; correct: number; unsafe_downgrades: number; record_digest: string; created_at: number;
};

type LiveRunRow = {
  id: string; recipe: TaskRecipe; job_id: string; evidence_digest: string; created_at: number;
};

type LiveReceiptRow = {
  id: string; run_id: string; recipe: TaskRecipe; job_id: string;
  receipt_kind: "induced_failure" | "recovery"; model_trial_id: string;
  evidence_digest: string; created_at: number;
};

type ModelReferenceRow = {
  id: string; recipe: TaskRecipe; cohort: "candidate" | "baseline";
  model_trial_id: string; harness_digest: string; budget_digest: string;
  record_digest: string; created_at: number;
};

type SafetyRow = {
  id: string; recipe: TaskRecipe; counter: string; counter_count: number;
  snapshot_id: string; evidence_digest: string; record_digest: string; created_at: number;
};

type JobRow = {
  id: string; task_recipe: TaskRecipe; routing_mode: "legacy" | "shadow" | "active";
  state: string; merge_commit_sha: string | null; merged_at: string | null;
};

type ModelTrialAuthorityRow = {
  id: string; outcome: "selected" | "passed" | "failed" | "blocked";
  failure_signature: string | null; created_at: number; settled_at: number | null;
  attempt_job_id: string | null; stage_job_id: string | null;
  job_recipe: TaskRecipe | null; job_routing_mode: "legacy" | "shadow" | "active" | null;
};

type ManifestReferences = Readonly<{
  deterministic: unknown;
  liveRuns: unknown;
  candidateModels: unknown;
  baselineModels: unknown;
  safety: unknown;
}>;

type ManifestReferenceIds = Readonly<{
  deterministic: string[];
  liveRuns: string[];
  candidateModels: string[];
  baselineModels: string[];
  safety: string[];
}>;

function promotionManifest(db: SqliteDatabase, recipe: TaskRecipe): ManifestRow | null {
  return db.prepare(
    `SELECT id, recipe, deterministic_ids_json, classifier_id, live_run_ids_json,
            candidate_model_ref_ids_json, baseline_model_ref_ids_json, safety_ids_json, created_at
       FROM recipe_promotion_evidence_manifests
      WHERE recipe = ? ORDER BY sequence DESC LIMIT 1`,
  ).get(recipe) as ManifestRow | undefined ?? null;
}

function parsedJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function boundedIds(reference: unknown, limit: number): string[] {
  if (!Array.isArray(reference) || reference.length > limit) return [];
  return reference.every((id) => typeof id === "string" && id.length >= 1 && id.length <= 256)
    ? reference
    : [];
}

function manifestReferences(manifest: ManifestRow): ManifestReferences {
  return {
    deterministic: parsedJson(manifest.deterministic_ids_json),
    liveRuns: parsedJson(manifest.live_run_ids_json),
    candidateModels: parsedJson(manifest.candidate_model_ref_ids_json),
    baselineModels: parsedJson(manifest.baseline_model_ref_ids_json),
    safety: parsedJson(manifest.safety_ids_json),
  };
}

function manifestReferenceIds(references: ManifestReferences): ManifestReferenceIds {
  return {
    deterministic: boundedIds(references.deterministic, 9),
    liveRuns: boundedIds(references.liveRuns, 33),
    candidateModels: boundedIds(references.candidateModels, 101),
    baselineModels: boundedIds(references.baselineModels, 101),
    safety: boundedIds(references.safety, 6),
  };
}

function deterministicRecords(db: SqliteDatabase, ids: readonly string[]) {
  const statement = db.prepare(
    `SELECT id, recipe, category, suite_id, run_id, artifact_digest, outcome,
            record_digest, created_at FROM recipe_deterministic_evidence WHERE id = ?`,
  );
  return ids.flatMap((id) => {
    const row = statement.get(id) as DeterministicRow | undefined;
    return row ? [{
      id: row.id, recipe: row.recipe, category: row.category, suiteId: row.suite_id,
      runId: row.run_id, artifactDigest: row.artifact_digest, outcome: row.outcome,
      recordDigest: row.record_digest, createdAt: row.created_at,
    }] : [];
  });
}

function classifierRecord(db: SqliteDatabase, id: string | null) {
  if (id === null) return null;
  const row = db.prepare(
    `SELECT id, recipe, corpus_digest, run_id, result_digest, total, correct,
            unsafe_downgrades, record_digest, created_at
       FROM recipe_classifier_evidence WHERE id = ?`,
  ).get(id) as ClassifierRow | undefined;
  return row ? {
    id: row.id, recipe: row.recipe, corpusDigest: row.corpus_digest, runId: row.run_id,
    resultDigest: row.result_digest, total: row.total, correct: row.correct,
    unsafeDowngrades: row.unsafe_downgrades, recordDigest: row.record_digest, createdAt: row.created_at,
  } : null;
}

function liveRunRecords(db: SqliteDatabase, ids: readonly string[]) {
  const statement = db.prepare(
    `SELECT id, recipe, job_id, evidence_digest, created_at
       FROM recipe_live_evidence WHERE id = ?`,
  );
  return ids.flatMap((id) => {
    const row = statement.get(id) as LiveRunRow | undefined;
    return row ? [{
      id: row.id, recipe: row.recipe, jobId: row.job_id,
      evidenceDigest: row.evidence_digest, createdAt: row.created_at,
    }] : [];
  });
}

function liveReceiptRecords(db: SqliteDatabase, runIds: readonly string[]) {
  const statement = db.prepare(
    `SELECT id, run_id, recipe, job_id, receipt_kind, model_trial_id,
            evidence_digest, created_at
       FROM recipe_live_evidence_receipts WHERE run_id = ? ORDER BY receipt_kind ASC`,
  );
  return runIds.flatMap((runId) => (statement.all(runId) as LiveReceiptRow[]).map((row) => ({
    id: row.id, runId: row.run_id, recipe: row.recipe, jobId: row.job_id,
    receiptKind: row.receipt_kind, modelTrialId: row.model_trial_id,
    evidenceDigest: row.evidence_digest, createdAt: row.created_at,
  })));
}

function modelReferenceRecords(db: SqliteDatabase, ids: readonly string[]) {
  const statement = db.prepare(
    `SELECT id, recipe, cohort, model_trial_id, harness_digest, budget_digest,
            record_digest, created_at FROM recipe_model_trial_evidence WHERE id = ?`,
  );
  return ids.flatMap((id) => {
    const row = statement.get(id) as ModelReferenceRow | undefined;
    return row ? [{
      id: row.id, recipe: row.recipe, cohort: row.cohort, modelTrialId: row.model_trial_id,
      harnessDigest: row.harness_digest, budgetDigest: row.budget_digest,
      recordDigest: row.record_digest, createdAt: row.created_at,
    }] : [];
  });
}

function safetyRecords(db: SqliteDatabase, ids: readonly string[]) {
  const statement = db.prepare(
    `SELECT id, recipe, counter, counter_count, snapshot_id, evidence_digest,
            record_digest, created_at FROM recipe_safety_evidence WHERE id = ?`,
  );
  return ids.flatMap((id) => {
    const row = statement.get(id) as SafetyRow | undefined;
    return row ? [{
      id: row.id, recipe: row.recipe, counter: row.counter, count: row.counter_count,
      snapshotId: row.snapshot_id, evidenceDigest: row.evidence_digest,
      recordDigest: row.record_digest, createdAt: row.created_at,
    }] : [];
  });
}

function jobRecords(db: SqliteDatabase, jobIds: readonly string[]) {
  const statement = db.prepare(
    `SELECT id, task_recipe, routing_mode, state, merge_commit_sha, merged_at
       FROM jobs WHERE id = ?`,
  );
  return jobIds.flatMap((id) => {
    const row = statement.get(id) as JobRow | undefined;
    return row ? [{
      id: row.id, recipe: row.task_recipe, routingMode: row.routing_mode,
      state: row.state, mergeCommitSha: row.merge_commit_sha, mergedAt: row.merged_at,
    }] : [];
  });
}

function modelTrialRecord(db: SqliteDatabase, id: string) {
  const row = db.prepare(
    `SELECT trial.id, trial.outcome, trial.failure_signature, trial.created_at, trial.settled_at,
            attempt.job_id AS attempt_job_id, stage.job_id AS stage_job_id,
            job.task_recipe AS job_recipe, job.routing_mode AS job_routing_mode
       FROM model_route_trials AS trial
       LEFT JOIN attempts AS attempt ON trial.subject_kind = 'worker_attempt' AND attempt.id = trial.subject_id
       LEFT JOIN pipeline_stage_attempts AS stage
         ON trial.subject_kind = 'worker_attempt' AND stage.id = trial.subject_id
       LEFT JOIN jobs AS job ON job.id = COALESCE(attempt.job_id, stage.job_id)
      WHERE trial.id = ?`,
  ).get(id) as ModelTrialAuthorityRow | undefined;
  if (!row) return null;
  const conflictingJobs = row.attempt_job_id !== null && row.stage_job_id !== null &&
    row.attempt_job_id !== row.stage_job_id;
  const subjectJobId = conflictingJobs ? null : row.attempt_job_id ?? row.stage_job_id;
  return {
    id: row.id, outcome: row.outcome, failureSignature: row.failure_signature, subjectJobId,
    subjectJobRecipe: subjectJobId === null ? null : row.job_recipe,
    subjectJobRoutingMode: subjectJobId === null ? null : row.job_routing_mode,
    createdAt: row.created_at, settledAt: row.settled_at,
  };
}

function modelTrialRecords(db: SqliteDatabase, ids: readonly string[]) {
  return ids.flatMap((id) => {
    const trial = modelTrialRecord(db, id);
    return trial ? [trial] : [];
  });
}

function manifestProjection(manifest: ManifestRow, references: ManifestReferences) {
  return {
    id: manifest.id, recipe: manifest.recipe,
    deterministicIds: references.deterministic, classifierId: manifest.classifier_id,
    liveRunIds: references.liveRuns, candidateModelRefIds: references.candidateModels,
    baselineModelRefIds: references.baselineModels, safetyIds: references.safety,
    createdAt: manifest.created_at,
  };
}

export function readDurablePromotionEvidenceSnapshot(
  db: SqliteDatabase,
  recipe: TaskRecipe,
): unknown | null {
  const manifest = promotionManifest(db, recipe);
  if (!manifest) return null;
  const references = manifestReferences(manifest);
  const ids = manifestReferenceIds(references);
  const liveRuns = liveRunRecords(db, ids.liveRuns);
  const liveReceipts = liveReceiptRecords(db, ids.liveRuns);
  const modelReferences = modelReferenceRecords(db, [...ids.candidateModels, ...ids.baselineModels]);
  const trialIds = [...new Set([
    ...modelReferences.map((reference) => reference.modelTrialId),
    ...liveReceipts.map((receipt) => receipt.modelTrialId),
  ])];
  return {
    manifest: manifestProjection(manifest, references),
    deterministic: deterministicRecords(db, ids.deterministic),
    classifier: classifierRecord(db, manifest.classifier_id),
    liveRuns, liveReceipts, modelReferences,
    safetyCounters: safetyRecords(db, ids.safety),
    jobs: jobRecords(db, [...new Set(liveRuns.map((run) => run.jobId))]),
    modelTrials: modelTrialRecords(db, trialIds),
  };
}
