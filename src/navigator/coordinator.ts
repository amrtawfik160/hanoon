import type Database from "better-sqlite3";
import { IllegalTransitionError } from "../domain/state-machine";
import type { Job } from "../domain/models";
import type { TelegramAgentStore } from "../storage/store";
import { DualEngineContractionError, type WorkflowEngineContraction } from "../storage/workflow-engine-repository";
import { evaluateNavigatorCorpus, type NavigatorCorpusEvaluationResult } from "./evaluation";
import { DUAL_ENGINE_RESTART_POINTS, type DualEngineRestartPoint } from "./models";

export { DualEngineContractionError, DUAL_ENGINE_RESTART_POINTS };
export type { DualEngineRestartPoint };

export class DualEngineCoordinator {
  public constructor(private readonly dependencies: Readonly<{
    store: TelegramAgentStore;
    database: Database.Database;
    now: () => number;
  }>) {}

  public async evaluateCorpus(): Promise<NavigatorCorpusEvaluationResult> {
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
    return this.dependencies.store.contractRecipeEngine(this.dependencies.now());
  }
}
