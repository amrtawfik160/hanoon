import type Database from "better-sqlite3";
import {
  promotionClassifierRecordDigest,
  promotionDeterministicRecordDigest,
  promotionLiveReceiptDigest,
  promotionLiveRunDigest,
  promotionModelReferenceRecordDigest,
  promotionSafetyRecordDigest,
} from "../src/capabilities/promotion-evidence";
import {
  DETERMINISTIC_PROMOTION_CATEGORIES,
  SAFETY_PROMOTION_COUNTERS,
  type RecipePromotionEvidence,
} from "../src/capabilities/promotion";
import type { TaskRecipe } from "../src/domain/recipes";
import type { TelegramAgentStore } from "../src/storage/store";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

let fixtureSequence = 10_000;

/** Inserts a fully linked ledger only for reader tests; production exposes no equivalent ingestion API. */
export function insertResolvedPromotionLedgerFixture(input: Readonly<{
  db: Database.Database;
  store: TelegramAgentStore;
  recipe?: TaskRecipe;
  prefix?: string;
}>): RecipePromotionEvidence {
  const recipe = input.recipe ?? "direct";
  const prefix = input.prefix ?? `promotion-${fixtureSequence++}`;
  const baseTime = 1_800_000_000_000 + fixtureSequence++ * 1_000;
  const job = input.store.createJob({
    id: `job-${prefix}`,
    sourceUpdateId: fixtureSequence++,
    requestText: `Disposable ${recipe} promotion run`,
    now: baseTime,
  });
  const mergedAt = new Date(baseTime + 135).toISOString();
  const mergeCommitSha = "e".repeat(40);
  input.db.prepare(
    `UPDATE jobs
        SET state = 'complete', task_recipe = ?, routing_mode = 'active',
            merge_commit_sha = ?, merged_at = ?
      WHERE id = ?`,
  ).run(recipe, mergeCommitSha, mergedAt, job.id);

  const candidateIndexes = new Set([1, 2, 3, 4, 5]);
  const trials: Array<Readonly<{
    id: string;
    outcome: "passed" | "failed";
    createdAt: number;
    failureSignature: string | null;
  }>> = [];
  for (let index = 0; index < 10; index += 1) {
    const attemptId = `attempt-${prefix}-${index}`;
    const createdAt = baseTime + index * 10;
    const candidate = candidateIndexes.has(index);
    input.store.createAttempt({
      id: attemptId,
      jobId: job.id,
      kind: "implementation",
      ordinal: index + 1,
      now: createdAt,
    });
    const selected = input.store.recordModelRouteSelection({
      subjectKind: "worker_attempt",
      subjectId: attemptId,
      attempt: 1,
      stage: "implementation",
      operation: candidate ? "candidate" : "baseline",
      route: {
        pool: candidate ? "standard" : "strong",
        providerId: "codex",
        modelId: candidate ? "candidate-model" : "baseline-model",
        reasoning: "high",
        serviceTier: "default",
      },
      now: createdAt,
    });
    const outcome = index === 0 ? "failed" as const : "passed" as const;
    const failureSignature = outcome === "failed" ? SHA_D : null;
    input.store.settleModelRouteTrial({
      subjectKind: "worker_attempt",
      subjectId: attemptId,
      attempt: 1,
      outcome,
      failureSignature,
      now: createdAt + 2,
    });
    trials.push({ id: selected.id, outcome, createdAt: createdAt + 2, failureSignature });
  }

  const deterministic = DETERMINISTIC_PROMOTION_CATEGORIES.map((category, index) => {
    const id = `promotion-deterministic-${prefix}-${index}`;
    const createdAt = baseTime + 150;
    const record = {
      category,
      suiteId: `suite-${prefix}-${category}`,
      runId: `deterministic-${prefix}-${index}`,
      artifactDigest: SHA_C,
      outcome: "passed" as const,
    };
    const recordDigest = promotionDeterministicRecordDigest({ recipe, ...record, createdAt });
    input.db.prepare(
      `INSERT INTO recipe_deterministic_evidence (
         id, recipe, category, suite_id, run_id, artifact_digest, outcome, record_digest, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      recipe,
      record.category,
      record.suiteId,
      record.runId,
      record.artifactDigest,
      record.outcome,
      recordDigest,
      createdAt,
    );
    return { id, record };
  });

  const classifierId = `promotion-classifier-${prefix}`;
  const classifierCreatedAt = baseTime + 150;
  const classifier = {
    corpusDigest: SHA_A,
    runId: `classifier-${prefix}`,
    resultDigest: SHA_B,
    total: 48,
    correct: 48,
    unsafeDowngrades: 0,
  };
  const classifierRecordDigest = promotionClassifierRecordDigest({
    recipe,
    ...classifier,
    createdAt: classifierCreatedAt,
  });
  input.db.prepare(
    `INSERT INTO recipe_classifier_evidence (
       id, recipe, corpus_digest, run_id, result_digest, total, correct,
       unsafe_downgrades, record_digest, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    classifierId,
    recipe,
    classifier.corpusDigest,
    classifier.runId,
    classifier.resultDigest,
    classifier.total,
    classifier.correct,
    classifier.unsafeDowngrades,
    classifierRecordDigest,
    classifierCreatedAt,
  );

  const candidateTrials = trials.filter((_trial, index) => candidateIndexes.has(index));
  const baselineTrials = trials.filter((_trial, index) => !candidateIndexes.has(index));
  const insertModelReferences = (
    cohort: "candidate" | "baseline",
    records: readonly typeof trials[number][],
  ) => records.map((trial, index) => {
    const id = `promotion-model-ref-${prefix}-${cohort}-${index}`;
    const createdAt = baseTime + 150;
    const recordDigest = promotionModelReferenceRecordDigest({
      recipe,
      cohort,
      modelTrialId: trial.id,
      harnessDigest: SHA_A,
      budgetDigest: SHA_B,
      createdAt,
    });
    input.db.prepare(
      `INSERT INTO recipe_model_trial_evidence (
         id, recipe, cohort, model_trial_id, harness_digest, budget_digest,
         record_digest, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, recipe, cohort, trial.id, SHA_A, SHA_B, recordDigest, createdAt);
    return { id, trial };
  });
  const candidateReferences = insertModelReferences("candidate", candidateTrials);
  const baselineReferences = insertModelReferences("baseline", baselineTrials);

  const failureTrial = trials[0]!;
  const recoveryTrial = trials[1]!;
  const liveRunId = `live-${prefix}`;
  const failureReceiptId = `promotion-live-receipt-${prefix}-failure`;
  const recoveryReceiptId = `promotion-live-receipt-${prefix}-recovery`;
  const failureReceiptDigest = promotionLiveReceiptDigest({
    receiptKind: "induced_failure",
    runId: liveRunId,
    jobId: job.id,
    modelTrialId: failureTrial.id,
    trialOutcome: failureTrial.outcome,
    failureSignature: failureTrial.failureSignature,
    trialSettledAt: failureTrial.createdAt,
  });
  const recoveryReceiptDigest = promotionLiveReceiptDigest({
    receiptKind: "recovery",
    runId: liveRunId,
    jobId: job.id,
    modelTrialId: recoveryTrial.id,
    trialOutcome: recoveryTrial.outcome,
    failureSignature: recoveryTrial.failureSignature,
    trialSettledAt: recoveryTrial.createdAt,
  });
  const liveRunDigest = promotionLiveRunDigest({
    runId: liveRunId,
    jobId: job.id,
    recipe,
    mergeCommitSha,
    mergedAt,
    inducedFailureReceiptId: failureReceiptId,
    recoveryReceiptId,
    inducedFailureTrialId: failureTrial.id,
    recoveryTrialId: recoveryTrial.id,
  });
  input.db.prepare(
    `INSERT INTO recipe_live_evidence (id, recipe, job_id, evidence_digest, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(liveRunId, recipe, job.id, liveRunDigest, baseTime + 140);
  const insertLiveReceipt = input.db.prepare(
    `INSERT INTO recipe_live_evidence_receipts (
       id, run_id, recipe, job_id, receipt_kind, model_trial_id, evidence_digest, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertLiveReceipt.run(
    failureReceiptId,
    liveRunId,
    recipe,
    job.id,
    "induced_failure",
    failureTrial.id,
    failureReceiptDigest,
    baseTime + 120,
  );
  insertLiveReceipt.run(
    recoveryReceiptId,
    liveRunId,
    recipe,
    job.id,
    "recovery",
    recoveryTrial.id,
    recoveryReceiptDigest,
    baseTime + 130,
  );

  const safetyCounters = SAFETY_PROMOTION_COUNTERS.map((counter, index) => {
    const id = `promotion-safety-${prefix}-${index}`;
    const createdAt = baseTime + 150;
    const record = {
      counter,
      count: 0,
      snapshotId: `safety-${prefix}-${counter}`,
      evidenceDigest: SHA_C,
    };
    const recordDigest = promotionSafetyRecordDigest({ recipe, ...record, createdAt });
    input.db.prepare(
      `INSERT INTO recipe_safety_evidence (
         id, recipe, counter, counter_count, snapshot_id, evidence_digest,
         record_digest, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      recipe,
      record.counter,
      record.count,
      record.snapshotId,
      record.evidenceDigest,
      recordDigest,
      createdAt,
    );
    return { id, record };
  });

  input.db.prepare(
    `INSERT INTO recipe_promotion_evidence_manifests (
       id, recipe, deterministic_ids_json, classifier_id, live_run_ids_json,
       candidate_model_ref_ids_json, baseline_model_ref_ids_json, safety_ids_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `promotion-manifest-${prefix}`,
    recipe,
    JSON.stringify(deterministic.map((entry) => entry.id)),
    classifierId,
    JSON.stringify([liveRunId]),
    JSON.stringify(candidateReferences.map((entry) => entry.id)),
    JSON.stringify(baselineReferences.map((entry) => entry.id)),
    JSON.stringify(safetyCounters.map((entry) => entry.id)),
    baseTime + 200,
  );

  return {
    recipe,
    deterministic: deterministic.map((entry) => entry.record),
    classifier,
    liveRuns: [{
      runId: liveRunId,
      jobId: job.id,
      recipe,
      terminalState: "merged",
      inducedFailureReceiptId: failureReceiptId,
      recoveryReceiptId,
      evidenceDigest: liveRunDigest,
    }],
    candidateModelTrials: candidateReferences.map(({ trial }) => ({
      trialId: trial.id,
      harnessDigest: SHA_A,
      budgetDigest: SHA_B,
      outcome: trial.outcome,
    })),
    baselineModelTrials: baselineReferences.map(({ trial }) => ({
      trialId: trial.id,
      harnessDigest: SHA_A,
      budgetDigest: SHA_B,
      outcome: trial.outcome,
    })),
    safetyCounters: safetyCounters.map((entry) => entry.record),
  };
}
