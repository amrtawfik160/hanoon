import type { PipelineStage, StageTokenUsage } from "../domain/stage-execution";
import type { StageExecutionRecord } from "../storage/stage-execution-repository";
import type { TelegramAgentStore } from "../storage/store";

export type StageLedgerStore = Pick<TelegramAgentStore, "settleStageExecution">;

export type SettleStageLedgerInput = Readonly<{
  store: StageLedgerStore;
  /** Reads the worker thread's measured token usage from the provider. */
  readUsage: (threadId: string) => Promise<StageTokenUsage | null>;
  jobId: string;
  /** Absent when this worker was adopted and has no ledger row of its own. */
  attemptId: string | undefined;
  stage: PipelineStage;
  threadId: string;
  /** How the worker ended. The stage's verdict lives in the attempt record. */
  outcome: "succeeded" | "failed";
  now: number;
}>;

/**
 * Closes one stage attempt's ledger row with what its worker actually used.
 *
 * A provider that cannot report usage leaves the row settled with no tokens:
 * "not measured" is the honest answer, and it must not cost the job its
 * settlement or its terminal transition.
 */
export async function settleStageLedger(
  input: SettleStageLedgerInput,
): Promise<StageExecutionRecord | null> {
  if (input.attemptId === undefined || input.attemptId.length === 0) return null;
  let usage: StageTokenUsage | null = null;
  try {
    usage = await input.readUsage(input.threadId);
  } catch {
    usage = null;
  }
  return input.store.settleStageExecution({
    jobId: input.jobId,
    attemptId: input.attemptId,
    stage: input.stage,
    outcome: input.outcome,
    threadId: input.threadId,
    usage,
    now: input.now,
  });
}
