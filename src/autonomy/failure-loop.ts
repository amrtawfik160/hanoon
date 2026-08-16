import { createHash } from "node:crypto";

/**
 * Three failures in an afternoon is not automatically a problem — three
 * failures with the *same cause* is. Counting failures flags a busy day;
 * clustering them by cause flags a loop, which is the thing worth stopping for.
 *
 * Escalation is deduplicated by fingerprint for a week, so a cause the owner
 * has already been told about does not produce a message every hour while they
 * decide what to do about it.
 */
export const FAILURE_WINDOW_MS = 4 * 60 * 60_000;
export const FAILURE_CLUSTER_THRESHOLD = 3;
export const ESCALATION_DEDUP_MS = 7 * 24 * 60 * 60_000;

export type FailedJobObservation = Readonly<{
  jobId: string;
  projectId: string | null;
  reason: string | null;
  failedAt: number;
}>;

export type FailureCluster = Readonly<{
  fingerprint: string;
  projectId: string | null;
  reason: string;
  jobIds: readonly string[];
  size: number;
}>;

/**
 * Reduce a failure reason to its recurring shape. Job ids, SHAs, timestamps,
 * paths, and numbers differ on every occurrence of the same underlying fault,
 * so leaving them in would make each repeat look unique and no loop would ever
 * be detected.
 */
export function failureFingerprint(projectId: string | null, reason: string | null): string {
  const normalized = (reason ?? "unknown failure")
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, "<sha>")
    .replace(/\b\d{4}-\d{2}-\d{2}t[\d:.]+z?\b/g, "<time>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/(?:\/[\w.-]+){2,}/g, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return createHash("sha256").update(`${projectId ?? "-"}\0${normalized}`, "utf8").digest("hex");
}

/**
 * Clusters at or above the threshold, largest first. Pure: the caller supplies
 * the window of failures and decides what to do with the result.
 */
export function detectFailureClusters(input: {
  failures: readonly FailedJobObservation[];
  threshold?: number;
}): FailureCluster[] {
  const threshold = input.threshold ?? FAILURE_CLUSTER_THRESHOLD;
  if (!Number.isInteger(threshold) || threshold < 2) {
    throw new TypeError("threshold must be an integer of at least 2");
  }
  const grouped = new Map<string, { projectId: string | null; reason: string; jobIds: string[] }>();
  for (const failure of input.failures) {
    const fingerprint = failureFingerprint(failure.projectId, failure.reason);
    const existing = grouped.get(fingerprint);
    if (existing) {
      if (!existing.jobIds.includes(failure.jobId)) existing.jobIds.push(failure.jobId);
      continue;
    }
    grouped.set(fingerprint, {
      projectId: failure.projectId,
      reason: (failure.reason ?? "unknown failure").slice(0, 200),
      jobIds: [failure.jobId],
    });
  }
  return [...grouped.entries()]
    .map(([fingerprint, cluster]) => ({
      fingerprint,
      projectId: cluster.projectId,
      reason: cluster.reason,
      jobIds: [...cluster.jobIds],
      size: cluster.jobIds.length,
    }))
    .filter((cluster) => cluster.size >= threshold)
    .sort((left, right) => right.size - left.size || left.fingerprint.localeCompare(right.fingerprint));
}

export function failureLoopNotice(cluster: FailureCluster, alias: string | null): string {
  const where = alias ? ` on ${alias.slice(0, 40)}` : "";
  return `The same failure has happened ${cluster.size} times in a row${where}, so I have stopped starting new work there until someone looks at it.\n\nWhat keeps failing: ${cluster.reason}\n\nWork already running is unaffected and will finish. Tell the owner in a line or two what the repeated failure is and what you think is causing it. Do not start a job to fix it without asking. They can send /resume to start work there again.`;
}
