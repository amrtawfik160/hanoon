import type Database from "better-sqlite3";
import { IllegalTransitionError } from "../domain/state-machine";
import type { Job } from "../domain/models";
import type { TelegramAgentStore } from "../storage/store";
import { DualEngineContractionError, type WorkflowEngineContraction } from "../storage/workflow-engine-repository";
import { evaluateNavigatorCorpus, type NavigatorCorpusEvaluationResult } from "./evaluation";
import {
  NAVIGATOR_DETERMINISTIC_CATEGORIES,
  NAVIGATOR_LIVE_SCENARIOS,
  NAVIGATOR_SAFETY_COUNTERS,
  type NavigatorLiveScenario,
} from "./promotion";

export { DualEngineContractionError };

export type DualEngineRestartPoint =
  | "proposal"
  | "claim"
  | "tracker_create"
  | "worker_dispatch"
  | "result_storage"
  | "head_change"
  | "merge_call_start"
  | "deploy"
  | "rollback"
  | "canary";

export const DUAL_ENGINE_RESTART_POINTS: readonly DualEngineRestartPoint[] = [
  "proposal",
  "claim",
  "tracker_create",
  "worker_dispatch",
  "result_storage",
  "head_change",
  "merge_call_start",
  "deploy",
  "rollback",
  "canary",
];

export class DualEngineCoordinator {
  public constructor(private readonly dependencies: Readonly<{
    store: TelegramAgentStore;
    database: Database.Database;
    now: () => number;
  }>) {}

  public evaluateCorpus(): NavigatorCorpusEvaluationResult {
    return evaluateNavigatorCorpus(this.dependencies.store, this.dependencies.database);
  }

  public listNonterminalRecipeJobs(): Job[] {
    return this.dependencies.store.listNonterminalRecipeJobs();
  }

  public drainRecipeJobs(): Readonly<{ cancelled: readonly string[]; remaining: readonly string[] }> {
    const cancelled: string[] = [];
    const remaining: string[] = [];
    for (const job of this.listNonterminalRecipeJobs()) {
      const workers = this.dependencies.store.getCurrentWorkerLiveness(job.id) ?? [];
      try {
        const next = this.dependencies.store.applyJobEvent(
          job.id,
          job.version,
          { type: "CANCEL_REQUESTED", activeWorker: workers[0] ?? null, activeWorkers: workers },
          this.dependencies.now(),
        );
        if (next.state === "cancelled") cancelled.push(job.id);
        else remaining.push(job.id);
      } catch (error) {
        if (!(error instanceof IllegalTransitionError)) throw error;
        remaining.push(job.id);
      }
    }
    return { cancelled, remaining };
  }

  public contractRecipeEngine(): WorkflowEngineContraction {
    const drain = this.drainRecipeJobs();
    if (drain.remaining.length > 0) {
      throw new DualEngineContractionError(drain.remaining);
    }
    return this.dependencies.store.contractRecipeEngine(this.dependencies.now());
  }

  public persistEvaluationEvidence(input: Readonly<{
    corpus: NavigatorCorpusEvaluationResult;
    liveRuns: readonly Readonly<{
      scenario: NavigatorLiveScenario;
      jobId: string;
      terminalState: "complete" | "merged" | "cancelled";
      evidenceDigest: string;
    }>[];
    candidateTrialIds: readonly string[];
    baselineTrialIds: readonly string[];
    harnessDigest: string;
    budgetDigest: string;
    reviewed: boolean;
  }>): void {
    if (NAVIGATOR_LIVE_SCENARIOS.some((scenario) => !input.liveRuns.some((run) => run.scenario === scenario))) {
      throw new TypeError("Navigator live evidence is missing a required disposable scenario");
    }
    const now = this.dependencies.now();
    const artifactDigest = input.corpus.resultDigest;
    const deterministicIds = NAVIGATOR_DETERMINISTIC_CATEGORIES.map((category) =>
      this.dependencies.store.recordNavigatorDeterministicEvidence({
        category,
        suiteId: `suite-${category}`,
        runId: `deterministic-${category}`,
        artifactDigest,
        outcome: "passed",
        now,
      }));
    const corpusId = this.dependencies.store.recordNavigatorCorpusEvidence({
      corpusDigest: input.corpus.corpusDigest,
      runId: "corpus-navigator",
      resultDigest: input.corpus.resultDigest,
      total: input.corpus.total,
      correct: input.corpus.correct,
      unauthorizedEffects: input.corpus.unauthorizedEffects,
      now,
    });
    const liveRunIds = input.liveRuns.map((run) => this.dependencies.store.recordNavigatorLiveEvidence({
      runId: `live-${run.scenario}`,
      jobId: run.jobId,
      scenario: run.scenario,
      terminalState: run.terminalState,
      evidenceDigest: run.evidenceDigest,
      now,
    }));
    const candidateModelRefIds = input.candidateTrialIds.map((trialId) =>
      this.dependencies.store.recordNavigatorModelTrialEvidence({
        cohort: "candidate",
        modelTrialId: trialId,
        harnessDigest: input.harnessDigest,
        budgetDigest: input.budgetDigest,
        now,
      }));
    const baselineModelRefIds = input.baselineTrialIds.map((trialId) =>
      this.dependencies.store.recordNavigatorModelTrialEvidence({
        cohort: "baseline",
        modelTrialId: trialId,
        harnessDigest: input.harnessDigest,
        budgetDigest: input.budgetDigest,
        now,
      }));
    const safetyIds = NAVIGATOR_SAFETY_COUNTERS.map((counter) =>
      this.dependencies.store.recordNavigatorSafetyEvidence({
        counter,
        count: 0,
        snapshotId: `safety-${counter}`,
        evidenceDigest: artifactDigest,
        now,
      }));
    this.dependencies.store.publishNavigatorPromotionManifest({
      deterministicIds,
      corpusId,
      liveRunIds,
      candidateModelRefIds,
      baselineModelRefIds,
      safetyIds,
      reviewed: input.reviewed,
      now,
    });
  }
}
