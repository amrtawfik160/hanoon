import type Database from "better-sqlite3";
import {
  NAVIGATOR_DETERMINISTIC_CATEGORIES,
  NAVIGATOR_LIVE_SCENARIOS,
  NAVIGATOR_SAFETY_COUNTERS,
} from "../../src/navigator/promotion";
import {
  NAVIGATOR_EVALUATION_BUDGET_DIGEST,
  NAVIGATOR_EVALUATION_HARNESS_DIGEST,
} from "../../src/navigator/evaluation-corpus";
import type { TelegramAgentStore } from "../../src/storage/store";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

let ledgerSequence = 20_000;

export function insertResolvedNavigatorPromotionLedger(input: Readonly<{
  store: TelegramAgentStore;
  db: Database.Database;
  reviewed?: boolean;
  prefix?: string;
}>): Readonly<{
  liveJobIds: readonly string[];
  candidateTrialIds: readonly string[];
  baselineTrialIds: readonly string[];
}> {
  const prefix = input.prefix ?? `nav-ledger-${ledgerSequence++}`;
  const now = 3_000_000 + ledgerSequence;
  const liveJobIds: string[] = [];
  for (const scenario of NAVIGATOR_LIVE_SCENARIOS) {
    const job = input.store.createJob({
      id: `job-${prefix}-${scenario}`.slice(0, 256),
      sourceUpdateId: ledgerSequence++,
      requestText: `Disposable navigator ${scenario}`,
      workflow: { engine: "navigator-v1", mode: "deterministic" },
      now,
    });
    const terminalState = scenario === "interrupted_tracker_create" ? "cancelled" as const : "complete" as const;
    input.db.prepare("UPDATE jobs SET state = ? WHERE id = ?").run(terminalState, job.id);
    input.store.recordNavigatorLiveEvidence({
      runId: `live-${prefix}-${scenario}`.slice(0, 256),
      jobId: job.id,
      scenario,
      terminalState,
      evidenceDigest: SHA_C,
      now,
    });
    liveJobIds.push(job.id);
  }

  const trialJob = input.store.createJob({
    id: `job-${prefix}-trials`,
    sourceUpdateId: ledgerSequence++,
    requestText: "Navigator model trial host",
    now,
  });
  const candidateTrialIds: string[] = [];
  const baselineTrialIds: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const candidate = index < 5;
    const attemptId = `attempt-${prefix}-${index}`;
    input.store.createAttempt({
      id: attemptId,
      jobId: trialJob.id,
      kind: "implementation",
      ordinal: index + 1,
      now: now + index,
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
      now: now + index,
    });
    input.store.settleModelRouteTrial({
      subjectKind: "worker_attempt",
      subjectId: attemptId,
      attempt: 1,
      outcome: "passed",
      failureSignature: null,
      now: now + index + 1,
    });
    if (candidate) candidateTrialIds.push(selected.id);
    else baselineTrialIds.push(selected.id);
  }

  const artifactDigest = SHA_C;
  const deterministicIds = NAVIGATOR_DETERMINISTIC_CATEGORIES.map((category) =>
    input.store.recordNavigatorDeterministicEvidence({
      category,
      suiteId: `suite-${prefix}-${category}`.slice(0, 256),
      runId: `deterministic-${prefix}-${category}`.slice(0, 256),
      artifactDigest,
      outcome: "passed",
      now,
    }));
  const corpusId = input.store.recordNavigatorCorpusEvidence({
    corpusDigest: SHA_A,
    runId: `corpus-${prefix}`.slice(0, 256),
    resultDigest: SHA_B,
    total: 48,
    correct: 48,
    unauthorizedEffects: 0,
    now,
  });
  const candidateModelRefIds = candidateTrialIds.map((trialId) =>
    input.store.recordNavigatorModelTrialEvidence({
      cohort: "candidate",
      modelTrialId: trialId,
      harnessDigest: NAVIGATOR_EVALUATION_HARNESS_DIGEST,
      budgetDigest: NAVIGATOR_EVALUATION_BUDGET_DIGEST,
      now,
    }));
  const baselineModelRefIds = baselineTrialIds.map((trialId) =>
    input.store.recordNavigatorModelTrialEvidence({
      cohort: "baseline",
      modelTrialId: trialId,
      harnessDigest: NAVIGATOR_EVALUATION_HARNESS_DIGEST,
      budgetDigest: NAVIGATOR_EVALUATION_BUDGET_DIGEST,
      now,
    }));
  const safetyIds = NAVIGATOR_SAFETY_COUNTERS.map((counter) =>
    input.store.recordNavigatorSafetyEvidence({
      counter,
      count: 0,
      snapshotId: `safety-${prefix}-${counter}`.slice(0, 256),
      evidenceDigest: SHA_C,
      now,
    }));
  input.store.publishNavigatorPromotionManifest({
    deterministicIds,
    corpusId,
    liveRunIds: NAVIGATOR_LIVE_SCENARIOS.map((scenario) => `nav-live-${scenario}`),
    candidateModelRefIds,
    baselineModelRefIds,
    safetyIds,
    reviewed: input.reviewed ?? true,
    now,
  });
  return { liveJobIds, candidateTrialIds, baselineTrialIds };
}
