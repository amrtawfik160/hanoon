import { decideCrashRevert, revertWorkOrder } from "../autonomy/crash-revert";
import { redactError } from "../errors";
import type { TelegramAgentStore } from "../storage/store";

/**
 * Undoing a merge that broke production, through the pipeline that made it.
 *
 * A deploy or canary failure already runs the rollback command, which puts
 * production back on the last good build. Nothing puts the *repository* back:
 * the bad merge is still on the trunk, and the next deploy ships it again. When
 * the merge was one this agent made unattended, closing that gap is its own
 * mess to clean up.
 *
 * The revert is ordinary work. It is validated, reviewed, and merged under the
 * project's own rules, exactly like any other change — a revert pushed around
 * the gates would be the one unreviewed write to the trunk in the whole system,
 * and it would be made by the component that just proved it can be wrong.
 *
 * Bounded once per merge commit for all time. A revert that itself fails feeds
 * the failure brake like any other failing job, and a second automatic attempt
 * at the same commit is exactly the loop the brake exists to stop.
 */

export type CrashRevertDependencies = {
  store: Pick<
    TelegramAgentStore,
    "getLatestCompletedMerge" | "createAutonomousJob" | "getCrashRevertJob"
  >;
  onWorkAvailable?: () => void;
  warn?: (message: string) => void;
};

export type CrashRevertOutcome =
  | Readonly<{ outcome: "started"; jobId: string; mergeCommitSha: string }>
  | Readonly<{ outcome: "investigate"; reason: string }>;

export class CrashRevertService {
  public constructor(private readonly dependencies: CrashRevertDependencies) {}

  /**
   * Called once, when production health crosses into failing.
   *
   * Every path that is not a started revert returns `investigate`, which is what
   * the health service has always done. A revert that cannot be started is not
   * an error to report; it just means the owner hears about the fault the way
   * they always did.
   */
  public start(input: Readonly<{
    projectId: string;
    alias: string;
    now: number;
  }>): CrashRevertOutcome {
    let decision: ReturnType<typeof decideCrashRevert>;
    try {
      decision = decideCrashRevert({
        merge: this.dependencies.store.getLatestCompletedMerge(input.projectId),
        now: input.now,
      });
    } catch (error) {
      this.dependencies.warn?.(
        `Auto-revert could not read this project's merges: ${redactError(error).slice(0, 160)}`,
      );
      return { outcome: "investigate", reason: "the merge history could not be read" };
    }
    if (decision.outcome === "investigate") return decision;

    let created: ReturnType<TelegramAgentStore["createAutonomousJob"]>;
    try {
      created = this.dependencies.store.createAutonomousJob({
        projectId: input.projectId,
        task: revertWorkOrder({
          mergeCommitSha: decision.merge.mergeCommitSha,
          alias: input.alias,
        }),
        origin: "crash_revert",
        // A revert is a fix for a fault, not a tidy-up: it reproduces the
        // breakage, undoes the cause, and proves production is back.
        minimumRecipe: "bug",
        revert: {
          mergeCommitSha: decision.merge.mergeCommitSha,
          mergedJobId: decision.merge.jobId,
        },
        now: input.now,
      });
    } catch (error) {
      this.dependencies.warn?.(
        `Auto-revert could not be started: ${redactError(error).slice(0, 160)}`,
      );
      return { outcome: "investigate", reason: "the revert job could not be created" };
    }
    if (created.outcome !== "created") {
      return { outcome: "investigate", reason: refusalReason(created.reason) };
    }
    this.dependencies.onWorkAvailable?.();
    return {
      outcome: "started",
      jobId: created.job.id,
      mergeCommitSha: decision.merge.mergeCommitSha,
    };
  }
}

function refusalReason(reason: string): string {
  if (reason === "already_reverted") return "this merge has already had its one automatic revert";
  if (reason === "project_paused") return "this project's failure brake is on";
  if (reason === "open_job") return "this project already has work running";
  return "this project cannot take unattended work right now";
}
