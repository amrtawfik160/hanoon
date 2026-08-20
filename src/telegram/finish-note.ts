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
  if (job.state !== "complete" && job.state !== "merged") return null;
  if (job.prNumber === null || job.prUrl === null) return null;
  const summary = finishSummary(job.requestText);
  const shipped = job.policy?.production !== undefined && job.mergeCommitSha !== null && job.canarySummary !== null;
  if (shipped) {
    return `Shipped “${summary}” and verified it in production. PR #${job.prNumber} has the final change: ${job.prUrl}`;
  }
  // Merged with nothing configured to deploy. Saying it landed is true; saying
  // it shipped would claim a step this project does not have.
  if (job.state === "merged" && job.mergeCommitSha !== null) {
    return `Merged “${summary}”. This project has nothing to deploy, so that finishes it. PR #${job.prNumber}: ${job.prUrl}`;
  }
  return `Finished “${summary}”; validation and review passed. PR #${job.prNumber} is ready for your decision: ${job.prUrl}`;
}
