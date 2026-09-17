import type Database from "better-sqlite3";
import {
  BOOT_ORPHAN_RETIRE_REASON,
  type BootGitObservation,
  type BootReconciliationPlan,
} from "../domain/boot-reconciliation";
import { JOB_LEDGER_HEAD } from "../domain/job-ledger";
import { readJobById } from "../storage/job-persistence";
import {
  loadBootJobSnapshots,
  reconcileJobsOnBoot,
} from "../storage/boot-reconciliation";

type SqliteDatabase = Database.Database;

export type BootThreadListing = Readonly<{
  threadId: string;
  title: string | null;
}>;

export type BootGitPorts = Readonly<{
  listThreads(): Promise<readonly BootThreadListing[]>;
  observeGit(job: Readonly<{
    id: string;
    environmentId: string;
    baseBranch: string;
  }>): Promise<{ branch: string; head: string } | null>;
  notifyOwner?(notice: Readonly<{
    text: string;
    threadId: string;
    retireResourceId?: string;
  }>): void;
}>;

export function bootOrphanRetireResourceId(payload: Record<string, unknown>): string | null {
  return typeof payload.retireResourceId === "string" && payload.retireResourceId.length > 0
    ? payload.retireResourceId
    : null;
}

export async function applyBootOrphanOutbox(
  payload: Record<string, unknown>,
  retireWorker: (resourceId: string, allowMissing: boolean) => Promise<void>,
): Promise<void> {
  const resourceId = bootOrphanRetireResourceId(payload);
  if (resourceId === null) return;
  await retireWorker(resourceId, true);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function bootGitFromEnvironmentStatus(status: unknown): { branch: string; head: string } | null {
  const value = asRecord(status);
  const workspace = asRecord(value.workspace);
  const checkout = asRecord(value.checkout ?? workspace.checkout);
  const head = checkout.headSha;
  const branch = checkout.branchName ?? checkout.branch;
  if (typeof branch !== "string" || typeof head !== "string") return null;
  return readableGitObservation({ branch, head });
}

function readableGitObservation(value: { branch: string; head: string } | null): { branch: string; head: string } | null {
  if (value === null) return null;
  if (value.branch.length === 0 || value.branch.length > 256) return null;
  if (!JOB_LEDGER_HEAD.test(value.head) || value.head.length === 0) return null;
  return value;
}

async function collectGitObservations(
  db: SqliteDatabase,
  observeGit: BootGitPorts["observeGit"],
): Promise<BootGitObservation[]> {
  const observations: BootGitObservation[] = [];
  for (const snapshot of loadBootJobSnapshots(db)) {
    const job = readJobById(db, snapshot.ledger.id);
    if (!job?.environmentId || !job.policy) continue;
    try {
      const observed = readableGitObservation(await observeGit({
        id: job.id,
        environmentId: job.environmentId,
        baseBranch: job.policy.baseBranch,
      }));
      if (observed) observations.push({ jobId: job.id, ...observed });
    } catch {
      // A missing worktree is not a licence to rewrite or drain the ledger.
    }
  }
  return observations;
}

export async function reconcileBootFromGitAndBb(
  db: SqliteDatabase,
  ports: BootGitPorts,
  now: number,
): Promise<BootReconciliationPlan> {
  const git = await collectGitObservations(db, ports.observeGit);
  const threads = await ports.listThreads();
  const plan = reconcileJobsOnBoot(db, { git, threads }, now);
  const existingJobs = new Set(loadBootJobSnapshots(db).map((job) => job.ledger.id));
  for (const thread of plan.threads) {
    if (thread.action !== "retire") continue;
    const missing = thread.jobId === null || !existingJobs.has(thread.jobId);
    ports.notifyOwner?.({
      text: BOOT_ORPHAN_RETIRE_REASON,
      threadId: thread.threadId,
      ...(missing ? { retireResourceId: thread.threadId } : {}),
    });
  }
  return plan;
}
