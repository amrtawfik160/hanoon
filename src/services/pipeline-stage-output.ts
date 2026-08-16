import { buildDocsReportArtifact, buildPlanArtifact, parseCritiqueResult } from "../bb/pipeline-handoffs";
import type { PipelineStageAttempt } from "../storage/store";

export type PipelineStageOutputRole = Extract<PipelineStageAttempt["role"], "PLAN" | "CRITIQUE" | "DOCS">;

/**
 * A planner turn that ends before the plan is written leaves only its preamble behind, and the
 * thread reads as idle. Treat anything below this as an unfinished turn rather than a plan.
 */
export const MIN_PLAN_OUTPUT_CHARS = 800;

/** Bounded number of corrective re-asks per stage attempt before the job fails. */
export const MAX_STAGE_OUTPUT_CORRECTIONS = 2;

const PLAN_CORRECTION =
  "Your turn ended before a usable plan was delivered. Do not restate the work order and do not ask questions. " +
  "Reply with the complete implementation and verification plan as Markdown, in this message, as your entire final output. " +
  "Do not edit files, commit, push, merge, or deploy.";

const CRITIQUE_CORRECTION =
  "Your last reply was not the required output. Reply with the critique result as strict JSON only: " +
  "no prose, no Markdown fences, no preamble, matching the critique contract you were given.";

const DOCS_CORRECTION =
  "Your last reply was not the required output. Reply with the documentation report as Markdown, " +
  "in this message, as your entire final output.";

/**
 * Returns the corrective prompt to send back to the stage thread when its output cannot be
 * accepted, or null when the output satisfies the stage contract.
 */
export function stageOutputCorrection(role: PipelineStageOutputRole, output: string): string | null {
  if (role === "PLAN") {
    if (typeof output !== "string" || output.trim().length < MIN_PLAN_OUTPUT_CHARS) return PLAN_CORRECTION;
    try {
      buildPlanArtifact(output);
    } catch {
      return PLAN_CORRECTION;
    }
    return null;
  }
  if (role === "DOCS") {
    try {
      buildDocsReportArtifact(output);
    } catch {
      return DOCS_CORRECTION;
    }
    return null;
  }
  try {
    parseCritiqueResult(output);
  } catch {
    return CRITIQUE_CORRECTION;
  }
  return null;
}

/** In-memory, bounded ledger of corrective re-asks keyed by stage attempt id. */
export class StageOutputCorrections {
  private readonly counts = new Map<string, number>();

  public consume(attemptId: string): boolean {
    const used = this.counts.get(attemptId) ?? 0;
    if (used >= MAX_STAGE_OUTPUT_CORRECTIONS) return false;
    this.counts.set(attemptId, used + 1);
    return true;
  }

  public clear(attemptId: string): void {
    this.counts.delete(attemptId);
  }
}
