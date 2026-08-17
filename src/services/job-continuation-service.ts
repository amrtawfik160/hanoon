import {
  continuationEscalationNotice,
  continuationKey,
  planJobContinuation,
} from "../autonomy/job-continuation";
import type { TelegramAgentStore } from "../storage/store";

const SCAN_INTERVAL_MS = 5 * 60_000;
const MAX_CANDIDATES_SCANNED = 50;

function legacyContinuationKey(job: {
  blockedReason: string | null;
  resumeState: string | null;
}): string {
  return `${job.blockedReason ?? "-"}:${job.resumeState ?? "-"}`;
}

export type JobContinuationDependencies = {
  store: Pick<
    TelegramAgentStore,
    | "listContinuationCandidates"
    | "recordAutoContinue"
    | "recordContinuationEscalation"
    | "retryFailedJob"
    | "requeueReviewAdmission"
    | "listEnabledProjectPolicies"
    | "getOwner"
    | "getControllerForOwner"
    | "enqueueControllerTurn"
  >;
  clock: { now(): number };
  issueUpdateId(now: number): number;
  onWorkAvailable?: () => void;
  warn?: (message: string) => void;
};

/**
 * Carries blocked jobs onward instead of leaving them for the owner to notice.
 *
 * Every recoverable block already had a resume path in the state machine; the
 * only thing missing was something to walk it. Until this existed the owner was
 * the scheduler, and jobs that hit one bad minute sat blocked until they were
 * cancelled. Across the first 26 jobs, none ever reached a merge.
 *
 * Bounded on purpose: a job gets a few pushes at the same wall, and if it is
 * still there the owner hears about it once. Resuming is routed through the
 * same guarded store calls the owner's own buttons use, so an automatic push
 * can never reach a state a manual retry could not.
 */
export class JobContinuationService {
  private lastScanAt = 0;

  public constructor(private readonly dependencies: JobContinuationDependencies) {}

  public processDue(): boolean {
    const now = this.dependencies.clock.now();
    if (now - this.lastScanAt < SCAN_INTERVAL_MS) return false;
    this.lastScanAt = now;
    try {
      return this.scan(now);
    } catch (error) {
      // A sweep that can crash the executor would cost more than the jobs it
      // recovers.
      this.dependencies.warn?.(
        `Job continuation sweep did not complete: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`,
      );
      return false;
    }
  }

  private scan(now: number): boolean {
    const candidates = this.dependencies.store.listContinuationCandidates(MAX_CANDIDATES_SCANNED);
    if (candidates.length === 0) return false;

    let worked = false;
    for (const candidate of candidates) {
      const { job } = candidate;
      // Attempts only count when they were spent on *this* block. A job that
      // cleared one wall and stopped at a later one starts its ladder over.
      const key = continuationKey(job);
      const legacyKey = legacyContinuationKey(job);
      const sameLegacyWall = candidate.key === legacyKey;
      const attempts = candidate.key === key || sameLegacyWall ? candidate.attempts : 0;
      const recordKey = sameLegacyWall ? legacyKey : key;
      const decision = planJobContinuation({ job, attempts });
      if (decision.action === "hold") continue;
      if (decision.action === "escalate") {
        worked = this.escalate(candidate.job, decision.reason, now) || worked;
        continue;
      }
      worked = this.resume(candidate.job, decision.event, recordKey, now) || worked;
    }
    return worked;
  }

  private resume(
    job: { id: string; version: number },
    event: "RETRY" | "CONTINUE_REVIEW",
    key: string,
    now: number,
  ): boolean {
    const outcome = event === "RETRY"
      ? this.dependencies.store.retryFailedJob(job.id, job.version, now).outcome
      : this.dependencies.store.requeueReviewAdmission(job.id, job.version, now).outcome;
    // A draining admission resolves itself, so waiting costs nothing and
    // counting it would spend the ladder on a sweep that was simply early.
    if (outcome === "still_cleaning_up" || outcome === "already_queued") return false;
    // `unavailable` still counts. It usually means the job moved under us, and
    // then its block changes and the ladder resets anyway — but it also covers
    // a job the guarded retry will never accept, and those must reach the owner
    // rather than be re-decided every sweep forever.
    this.dependencies.store.recordAutoContinue({ jobId: job.id, key, now });
    if (outcome === "unavailable") return false;
    this.dependencies.onWorkAvailable?.();
    return true;
  }

  private escalate(
    job: { id: string; projectId: string | null; lastError: string | null },
    reason: string,
    now: number,
  ): boolean {
    const owner = this.dependencies.store.getOwner();
    if (!owner) return false;
    const controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
    if (!controller) return false;

    // Marked before the message is queued: a job the owner has already been
    // told about must not be re-decided on the next sweep, and a duplicate
    // notice costs them more than a missed one.
    this.dependencies.store.recordContinuationEscalation({ jobId: job.id, now });
    const alias = job.projectId === null ? null : this.dependencies.store
      .listEnabledProjectPolicies()
      .find(({ policy }) => policy.projectId === job.projectId)?.policy.alias ?? null;
    this.dependencies.store.enqueueControllerTurn({
      controllerKey: controller.controllerKey,
      telegramUserId: owner.userId,
      telegramChatId: owner.chatId,
      updateId: this.dependencies.issueUpdateId(now),
      inputText: continuationEscalationNotice({ reason, lastError: job.lastError, alias }),
      origin: "system",
      now,
    });
    return true;
  }
}
