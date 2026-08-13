import type { Job } from "../domain/models";

const FINISH_SUMMARY_LIMIT = 180;

function finishSummary(requestText: string): string {
  const summary = requestText
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[“”]/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
  if (summary.length <= FINISH_SUMMARY_LIMIT) return summary;
  return `${summary.slice(0, FINISH_SUMMARY_LIMIT - 1).trimEnd()}…`;
}

export function renderJobFinishNote(
  job: Pick<Job, "state" | "requestText" | "prNumber" | "prUrl" | "policy" | "mergeCommitSha" | "canarySummary">,
): string | null {
  if (job.state !== "complete" || job.prNumber === null || job.prUrl === null) return null;
  const summary = finishSummary(job.requestText);
  const shipped = job.policy?.production !== undefined && job.mergeCommitSha !== null && job.canarySummary !== null;
  return shipped
    ? `Shipped “${summary}” and verified it in production. PR #${job.prNumber} has the final change: ${job.prUrl}`
    : `Finished “${summary}”; validation and review passed. PR #${job.prNumber} is ready for your decision: ${job.prUrl}`;
}
