import { type JobLedgerRow } from "./job-ledger";
import { type JobState } from "./models";

export const BOOT_ORPHAN_RETIRE_REASON =
  "Restart retired this worker thread because it no longer belongs to a live job.";

export type BootThreadRole =
  | "plan"
  | "critique"
  | "implementation"
  | "review"
  | "docs"
  | "final-review";

export type BootThreadSlot = "implementation" | "review" | "documentation";

export type BootJobSnapshot = Readonly<{
  ledger: JobLedgerRow;
  implementationThreadId: string | null;
  reviewThreadId: string | null;
  documentationThreadId: string | null;
}>;

export type BootGitObservation = Readonly<{
  jobId: string;
  branch: string;
  head: string;
}>;

export type BootThreadObservation = Readonly<{
  threadId: string;
  jobId: string | null;
  role: BootThreadRole | null;
}>;

export type BootReconciliationSnapshot = Readonly<{
  jobs: readonly BootJobSnapshot[];
  /** Observed so a restart can confirm worktrees without rewriting the ledger. */
  git: readonly BootGitObservation[];
  threads: readonly BootThreadObservation[];
}>;

export type BootJobDecision = Readonly<{ action: "resume"; row: JobLedgerRow }>;

export type BootThreadDecision =
  | Readonly<{
      action: "adopt";
      threadId: string;
      jobId: string;
      slot: BootThreadSlot | null;
    }>
  | Readonly<{
      action: "retire";
      threadId: string;
      jobId: string | null;
      reason: typeof BOOT_ORPHAN_RETIRE_REASON;
    }>;

export type BootReconciliationPlan = Readonly<{
  jobs: readonly BootJobDecision[];
  threads: readonly BootThreadDecision[];
}>;

const TERMINAL_STAGES: ReadonlySet<JobState> = new Set([
  "complete",
  "failed",
  "cancelled",
  "merged",
  "production_failed",
]);

function jobIsLive(stage: JobState): boolean {
  return !TERMINAL_STAGES.has(stage);
}

function slotForRole(role: BootThreadRole): BootThreadSlot | null {
  if (role === "implementation") return "implementation";
  if (role === "review" || role === "final-review") return "review";
  if (role === "docs") return "documentation";
  return null;
}

function boundSlot(job: BootJobSnapshot, threadId: string): BootThreadSlot | null {
  if (job.implementationThreadId === threadId) return "implementation";
  if (job.reviewThreadId === threadId) return "review";
  if (job.documentationThreadId === threadId) return "documentation";
  return null;
}

function slotIsEmpty(job: BootJobSnapshot, slot: BootThreadSlot | null): boolean {
  if (slot === "implementation") return job.implementationThreadId === null;
  if (slot === "review") return job.reviewThreadId === null;
  if (slot === "documentation") return job.documentationThreadId === null;
  return true;
}

function roleMatchesStage(role: BootThreadRole, stage: JobState): boolean {
  switch (role) {
    case "plan":
      return stage === "planning";
    case "critique":
      return stage === "critiquing";
    case "implementation":
      return stage === "creating_implementation" || stage === "implementing" || stage === "remediating";
    case "review":
      return stage === "reviewing";
    case "final-review":
      return stage === "final_reviewing";
    case "docs":
      return stage === "documenting";
  }
}

export function decideBootReconciliation(snapshot: BootReconciliationSnapshot): BootReconciliationPlan {
  const jobsById = new Map(snapshot.jobs.map((job) => [job.ledger.id, job]));
  const jobs: BootJobDecision[] = snapshot.jobs.map((job) => ({
    action: "resume",
    row: job.ledger,
  }));
  const threads: BootThreadDecision[] = [];
  for (const thread of snapshot.threads) {
    if (thread.jobId === null || thread.role === null) continue;
    const job = jobsById.get(thread.jobId);
    if (job && jobIsLive(job.ledger.stage)) {
      const bound = boundSlot(job, thread.threadId);
      if (bound !== null) {
        threads.push({
          action: "adopt",
          threadId: thread.threadId,
          jobId: job.ledger.id,
          slot: bound,
        });
        continue;
      }
      const slot = slotForRole(thread.role);
      if (roleMatchesStage(thread.role, job.ledger.stage) && slotIsEmpty(job, slot)) {
        threads.push({
          action: "adopt",
          threadId: thread.threadId,
          jobId: job.ledger.id,
          slot,
        });
        continue;
      }
    }
    threads.push({
      action: "retire",
      threadId: thread.threadId,
      jobId: thread.jobId,
      reason: BOOT_ORPHAN_RETIRE_REASON,
    });
  }
  return { jobs, threads };
}
