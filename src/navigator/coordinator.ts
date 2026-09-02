import { IllegalTransitionError } from "../domain/state-machine";
import type { Job } from "../domain/models";
import type { NavigatorCoordinatorPersistence } from "./coordinator-persistence";
import type { NavigatorEffectPersistence } from "./effect-persistence";
import type { NavigatorEvaluationPersistence } from "./evaluation-persistence";
import type { NavigatorImplementationPersistence } from "./implementation-persistence";
import { DualEngineContractionError, type WorkflowEngineContraction } from "../storage/workflow-engine-repository";
import { evaluateNavigatorCorpus, type NavigatorCorpusEvaluationResult } from "./evaluation";
import {
  DUAL_ENGINE_RESTART_POINTS,
  NAVIGATOR_DETERMINISTIC_CATEGORIES,
  NAVIGATOR_LIVE_SCENARIOS,
  type DualEngineRestartPoint,
  type NavigatorDeterministicCategory,
  type NavigatorLiveScenario,
  type NavigatorSafetyCounter,
} from "./promotion";
import { assertNavigatorLiveScenarioEvidence } from "./live-evidence";

export { DualEngineContractionError, DUAL_ENGINE_RESTART_POINTS };
export type { DualEngineRestartPoint };

export class DualEngineCoordinator {
  public constructor(private readonly dependencies: Readonly<{
    persistence: NavigatorCoordinatorPersistence;
    evaluation: NavigatorEvaluationPersistence;
    navigatorEffects: NavigatorEffectPersistence;
    navigatorImplementation: NavigatorImplementationPersistence;
    now: () => number;
  }>) {}

  public async evaluateCorpus(): Promise<NavigatorCorpusEvaluationResult> {
    return evaluateNavigatorCorpus(
      this.dependencies.evaluation,
      {
        effectPersistence: this.dependencies.navigatorEffects,
        implementationPersistence: this.dependencies.navigatorImplementation,
      },
    );
  }

  public listNonterminalRecipeJobs(): Job[] {
    return this.dependencies.persistence.listNonterminalRecipeJobs();
  }

  public drainRecipeJobs(): Readonly<{ cancelled: readonly string[]; remaining: readonly string[] }> {
    const cancelled: string[] = [];
    const remaining: string[] = [];
    for (const job of this.listNonterminalRecipeJobs()) {
      const workers = this.dependencies.persistence.getCurrentWorkerLiveness(job.id) ?? [];
      try {
        const next = this.dependencies.persistence.applyJobEvent(
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

  public assertContractionAllowed(): void {
    const remaining = this.listNonterminalRecipeJobs();
    if (remaining.length > 0) {
      throw new DualEngineContractionError(remaining.map((job) => job.id));
    }
  }

  public contractRecipeEngine(): WorkflowEngineContraction {
    const drain = this.drainRecipeJobs();
    if (drain.remaining.length > 0) {
      throw new DualEngineContractionError(drain.remaining);
    }
    return this.dependencies.persistence.contractRecipeEngine(this.dependencies.now());
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
    for (const run of input.liveRuns) {
      assertNavigatorLiveScenarioEvidence(this.dependencies.evaluation, run);
    }
    const now = this.dependencies.now();
    const artifactDigest = input.corpus.resultDigest;
    const deterministicIds = NAVIGATOR_DETERMINISTIC_CATEGORIES.map((category) =>
      this.dependencies.persistence.recordNavigatorDeterministicEvidence({
        category,
        suiteId: `suite-${category}`,
        runId: `deterministic-${category}`,
        artifactDigest,
        outcome: deterministicCategoryOutcome(input.corpus, category),
        now,
      }));
    const corpusId = this.dependencies.persistence.recordNavigatorCorpusEvidence({
      corpusDigest: input.corpus.corpusDigest,
      runId: "corpus-navigator",
      resultDigest: input.corpus.resultDigest,
      total: input.corpus.total,
      correct: input.corpus.correct,
      unauthorizedEffects: input.corpus.unauthorizedEffects,
      now,
    });
    const liveRunIds = input.liveRuns.map((run) => this.dependencies.persistence.recordNavigatorLiveEvidence({
      runId: `live-${run.scenario}`,
      jobId: run.jobId,
      scenario: run.scenario,
      terminalState: run.terminalState,
      evidenceDigest: run.evidenceDigest,
      now,
    }));
    const candidateModelRefIds = input.candidateTrialIds.map((trialId) =>
      this.dependencies.persistence.recordNavigatorModelTrialEvidence({
        cohort: "candidate",
        modelTrialId: trialId,
        harnessDigest: input.harnessDigest,
        budgetDigest: input.budgetDigest,
        now,
      }));
    const baselineModelRefIds = input.baselineTrialIds.map((trialId) =>
      this.dependencies.persistence.recordNavigatorModelTrialEvidence({
        cohort: "baseline",
        modelTrialId: trialId,
        harnessDigest: input.harnessDigest,
        budgetDigest: input.budgetDigest,
        now,
      }));
    const safetyIds = measuredSafetyCounters(input.corpus).map((entry) =>
      this.dependencies.persistence.recordNavigatorSafetyEvidence({
        counter: entry.counter,
        count: entry.count,
        snapshotId: `safety-${entry.counter}`,
        evidenceDigest: artifactDigest,
        now,
      }));
    this.dependencies.persistence.publishNavigatorPromotionManifest({
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

function casesForCategory(
  corpus: NavigatorCorpusEvaluationResult,
  category: NavigatorDeterministicCategory,
): NavigatorCorpusEvaluationResult["cases"] {
  return corpus.cases.filter((entry) => entry.id.startsWith(`corpus-${category}-`));
}

function deterministicCategoryOutcome(
  corpus: NavigatorCorpusEvaluationResult,
  category: NavigatorDeterministicCategory,
): "passed" | "failed" {
  const cases = casesForCategory(corpus, category);
  if (cases.length === 0 || cases.some((entry) => !entry.matched)) return "failed";
  if (category === "restart") {
    const measured = new Set(corpus.restartPointsMeasured);
    if (DUAL_ENGINE_RESTART_POINTS.some((point) => !measured.has(point))) return "failed";
    if (corpus.duplicateMutations !== 0) return "failed";
  }
  return "passed";
}

function measuredSafetyCounters(
  corpus: NavigatorCorpusEvaluationResult,
): Array<{ counter: NavigatorSafetyCounter; count: number }> {
  const measured: Array<{ counter: NavigatorSafetyCounter; count: number }> = [
    { counter: "unauthorized_effects", count: corpus.unauthorizedEffects },
    { counter: "owner_boundary_violations", count: corpus.ownerBoundaryViolations },
    { counter: "outcome_regressions", count: corpus.outcomeRegressions },
    { counter: "evidence_binding_failures", count: corpus.evidenceBindingFailures },
  ];
  const restartMeasured = DUAL_ENGINE_RESTART_POINTS.every((point) =>
    corpus.restartPointsMeasured.includes(point));
  if (restartMeasured) {
    measured.push({ counter: "duplicate_mutations", count: corpus.duplicateMutations });
  }
  return measured;
}
