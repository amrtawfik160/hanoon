import type Database from "better-sqlite3";

type SqliteDatabase = Database.Database;

type ManifestRow = {
  id: string;
  deterministic_ids_json: string;
  corpus_id: string | null;
  live_run_ids_json: string;
  candidate_model_ref_ids_json: string;
  baseline_model_ref_ids_json: string;
  safety_ids_json: string;
  reviewed: number;
  created_at: number;
};

function parseIdList(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function latestManifest(db: SqliteDatabase): ManifestRow | null {
  return db.prepare(
    `SELECT id, deterministic_ids_json, corpus_id, live_run_ids_json,
            candidate_model_ref_ids_json, baseline_model_ref_ids_json,
            safety_ids_json, reviewed, created_at
       FROM navigator_promotion_evidence_manifests
      ORDER BY sequence DESC LIMIT 1`,
  ).get() as ManifestRow | undefined ?? null;
}

export function readDurableNavigatorPromotionEvidenceSnapshot(db: SqliteDatabase): unknown | null {
  const manifest = latestManifest(db);
  if (!manifest) return null;
  const deterministicIds = parseIdList(manifest.deterministic_ids_json);
  const liveRunIds = parseIdList(manifest.live_run_ids_json);
  const candidateModelRefIds = parseIdList(manifest.candidate_model_ref_ids_json);
  const baselineModelRefIds = parseIdList(manifest.baseline_model_ref_ids_json);
  const safetyIds = parseIdList(manifest.safety_ids_json);
  if (
    !Array.isArray(deterministicIds) || !Array.isArray(liveRunIds) ||
    !Array.isArray(candidateModelRefIds) || !Array.isArray(baselineModelRefIds) ||
    !Array.isArray(safetyIds)
  ) return null;

  const deterministic = db.prepare(
    `SELECT id, category, suite_id AS suiteId, run_id AS runId, artifact_digest AS artifactDigest,
            outcome, record_digest AS recordDigest, created_at AS createdAt
       FROM navigator_deterministic_evidence WHERE id IN (${deterministicIds.map(() => "?").join(",") || "NULL"})`,
  ).all(...deterministicIds) as unknown[];
  const corpus = manifest.corpus_id === null ? null : db.prepare(
    `SELECT id, corpus_digest AS corpusDigest, run_id AS runId, result_digest AS resultDigest,
            total, correct, unauthorized_effects AS unauthorizedEffects,
            record_digest AS recordDigest, created_at AS createdAt
       FROM navigator_corpus_evidence WHERE id = ?`,
  ).get(manifest.corpus_id) as unknown | undefined ?? null;
  const liveRuns = db.prepare(
    `SELECT id, run_id AS runId, job_id AS jobId, scenario, terminal_state AS terminalState,
            evidence_digest AS evidenceDigest, record_digest AS recordDigest, created_at AS createdAt
       FROM navigator_live_evidence WHERE id IN (${liveRunIds.map(() => "?").join(",") || "NULL"})`,
  ).all(...liveRunIds) as Array<{ jobId: string }>;
  const modelRefIds = [...candidateModelRefIds, ...baselineModelRefIds];
  const modelReferences = db.prepare(
    `SELECT id, cohort, model_trial_id AS modelTrialId, harness_digest AS harnessDigest,
            budget_digest AS budgetDigest, record_digest AS recordDigest, created_at AS createdAt
       FROM navigator_model_trial_evidence WHERE id IN (${modelRefIds.map(() => "?").join(",") || "NULL"})`,
  ).all(...modelRefIds) as Array<{ modelTrialId: string }>;
  const safetyCounters = db.prepare(
    `SELECT id, counter, counter_count AS count, snapshot_id AS snapshotId,
            evidence_digest AS evidenceDigest, record_digest AS recordDigest, created_at AS createdAt
       FROM navigator_safety_evidence WHERE id IN (${safetyIds.map(() => "?").join(",") || "NULL"})`,
  ).all(...safetyIds) as unknown[];
  const jobIds = [...new Set(liveRuns.map((run) => run.jobId))];
  const jobs = db.prepare(
    `SELECT id, workflow_engine AS workflowEngine, state
       FROM jobs WHERE id IN (${jobIds.map(() => "?").join(",") || "NULL"})`,
  ).all(...jobIds) as unknown[];
  const trialIds = [...new Set(modelReferences.map((reference) => reference.modelTrialId))];
  const modelTrials = db.prepare(
    `SELECT id, outcome, failure_signature AS failureSignature
       FROM model_route_trials WHERE id IN (${trialIds.map(() => "?").join(",") || "NULL"})`,
  ).all(...trialIds) as unknown[];

  return {
    manifest: {
      id: manifest.id,
      deterministicIds,
      corpusId: manifest.corpus_id,
      liveRunIds,
      candidateModelRefIds,
      baselineModelRefIds,
      safetyIds,
      reviewed: manifest.reviewed === 1,
      createdAt: manifest.created_at,
    },
    deterministic,
    corpus,
    liveRuns,
    modelReferences,
    safetyCounters,
    jobs,
    modelTrials,
  };
}
