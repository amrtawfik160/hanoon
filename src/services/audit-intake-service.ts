import { intakeWorkOrders, type IntakeWorkOrder } from "../autonomy/audit-intake";
import type { AuditResult } from "../autonomy/audit-contract";
import { redactError } from "../errors";
import type { AutonomousJobRefusal, TelegramAgentStore } from "../storage/store";
import type { AuditProject } from "./audit-service";

/**
 * Starting work from what the audits found.
 *
 * The audits have always been able to see that documentation names a file that
 * is gone, or that a bug has sat untouched for six weeks. What they could not do
 * is anything about it, so every finding waited for the owner to read a message
 * and type a request. This closes that loop, and everything hard about it is in
 * what it refuses to do.
 *
 * Nothing here is a new kind of work. A started job is an ordinary pipeline job:
 * it plans, implements, is reviewed, and asks for the merge on exactly the terms
 * the project's policy already sets. Starting needs no approval because starting
 * is not the irreversible half; merging is, and merging is governed elsewhere and
 * unchanged.
 *
 * Every bound lives in the store, inside the transaction that creates the job,
 * because a cap this checked itself would be a cap two passes could both clear.
 * What lives here is the part that is not a bound: which finding to spend today's
 * allowance on, and telling the owner what was started in their absence.
 */

export type AuditIntakeDependencies = {
  store: Pick<
    TelegramAgentStore,
    | "listEnabledProjectPolicies"
    | "createAutonomousJob"
    | "getOwner"
    | "getControllerForOwner"
    | "enqueueControllerTurn"
  >;
  clock: { now(): number };
  issueUpdateId(now: number): number;
  onWorkAvailable?: () => void;
  warn?: (message: string) => void;
};

export type IntakeStart = Readonly<{
  jobId: string;
  origin: "audit_intake" | "self_diagnosis";
  /** The check that found it, or `self-diagnosis` for a diagnosed failure. */
  auditId: string;
  subject: string;
  task: string;
}>;

/**
 * Refusals that mean "not today", as opposed to "not this finding". Hitting one
 * ends the pass: the allowance is spent, the project is braked, or something is
 * already running, and trying the next finding would only ask the same question
 * again with a different subject.
 */
const PROJECT_WIDE_REFUSALS: ReadonlySet<AutonomousJobRefusal> = new Set<AutonomousJobRefusal>([
  "project_not_enabled",
  "intake_not_configured",
  "project_paused",
  "open_job",
  "daily_cap",
]);

function startedNotice(input: Readonly<{
  alias: string;
  start: IntakeStart;
}>): string {
  const because = input.start.origin === "self_diagnosis"
    ? "a failure this agent diagnosed in its own controller"
    : "the daily check on this project found something it is configured to act on";
  return [
    `A job just started on ${input.alias} that nobody asked for: ${because}.`,
    "",
    `What it is working on: ${input.start.task}`,
    `Where it came from: ${input.start.auditId}, on ${input.start.subject}.`,
    "",
    "Tell the owner in one or two plain lines that this started and what it is for. This is a notice, not a question — do not ask them to approve anything, and do not offer to stop it unless they ask.",
  ].join("\n");
}

export class AuditIntakeService {
  public constructor(private readonly dependencies: AuditIntakeDependencies) {}

  /**
   * Spend as much of today's allowance as this sweep's findings deserve.
   *
   * Fails closed on every unreadable thing: a policy that will not load, a store
   * that throws, an owner that is not paired. An intake that cannot read its own
   * bounds starts nothing.
   */
  public consider(
    project: AuditProject,
    results: readonly AuditResult[],
    now: number,
  ): readonly IntakeStart[] {
    const alias = this.aliasWithIntake(project.projectId);
    if (alias === null) return [];

    const started: IntakeStart[] = [];
    for (const candidate of intakeWorkOrders({ results })) {
      const outcome = this.start(project.projectId, candidate, "audit_intake", undefined, now);
      if (outcome === null) break;
      if (outcome === "skipped") continue;
      started.push(outcome);
      this.notify(alias, outcome, now);
    }
    if (started.length > 0) this.dependencies.onWorkAvailable?.();
    return started;
  }

  /**
   * File one work order that did not come from an audit finding, under the same
   * allowance and the same ledger.
   *
   * Sharing them is the point rather than a convenience: a project that said it
   * would start two jobs a day meant two, and a second source of unattended work
   * that kept its own count would quietly make that four.
   */
  public file(input: Readonly<{
    projectId: string;
    task: string;
    auditId: string;
    subject: string;
    fingerprint: string;
    now: number;
  }>): IntakeStart | { refused: string } {
    const alias = this.aliasWithIntake(input.projectId);
    if (alias === null) return { refused: "the project has no audit intake allowance" };
    // A diagnosis is a guess about a failure, so it goes down the bug route:
    // reproduce first, then fix. Nothing about it is a typo or a copy change.
    const started = this.start(input.projectId, input, "self_diagnosis", "bug", input.now);
    if (started === null) return { refused: "the project cannot take unattended work right now" };
    if (started === "skipped") return { refused: "this failure has already had its job" };
    this.notify(alias, started, input.now);
    this.dependencies.onWorkAvailable?.();
    return started;
  }

  /** The project's alias when it accepts unattended work, and null when it does not. */
  private aliasWithIntake(projectId: string): string | null {
    try {
      const record = this.dependencies.store.listEnabledProjectPolicies()
        .find((entry) => entry.policy.projectId === projectId);
      return record?.policy.autonomy?.intake === undefined ? null : record.policy.alias;
    } catch (error) {
      this.dependencies.warn?.(
        `Audit intake could not read its bounds: ${redactError(error).slice(0, 160)}`,
      );
      return null;
    }
  }

  /**
   * One work order, offered to the store. `null` ends the pass, `"skipped"`
   * moves to the next finding, and a start is a job that exists.
   */
  private start(
    projectId: string,
    candidate: IntakeWorkOrder,
    origin: "audit_intake" | "self_diagnosis",
    minimumRecipe: "bug" | undefined,
    now: number,
  ): IntakeStart | "skipped" | null {
    let outcome: ReturnType<TelegramAgentStore["createAutonomousJob"]>;
    try {
      outcome = this.dependencies.store.createAutonomousJob({
        projectId,
        task: candidate.task,
        origin,
        ...(minimumRecipe === undefined ? {} : { minimumRecipe }),
        intake: {
          fingerprint: candidate.fingerprint,
          auditId: candidate.auditId,
          subject: candidate.subject,
        },
        now,
      });
    } catch (error) {
      this.dependencies.warn?.(
        `Audit intake could not start a job: ${redactError(error).slice(0, 160)}`,
      );
      return null;
    }
    if (outcome.outcome === "created") {
      return {
        jobId: outcome.job.id,
        origin,
        auditId: candidate.auditId,
        subject: candidate.subject,
        task: candidate.task,
      };
    }
    return PROJECT_WIDE_REFUSALS.has(outcome.reason) ? null : "skipped";
  }

  private notify(alias: string, start: IntakeStart, now: number): void {
    const owner = this.dependencies.store.getOwner();
    if (!owner) return;
    const controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
    if (!controller) return;
    this.dependencies.store.enqueueControllerTurn({
      controllerKey: controller.controllerKey,
      telegramUserId: owner.userId,
      telegramChatId: owner.chatId,
      updateId: this.dependencies.issueUpdateId(now),
      inputText: startedNotice({ alias, start }),
      // Not the owner speaking, and never their verdict on the last answer.
      origin: "system",
      now,
    });
  }
}
