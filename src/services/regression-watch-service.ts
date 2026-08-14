import { redactError } from "../errors";
import type { PolicyCommand } from "../domain/models";
import { regressionNotice, regressionTransition } from "./regression-report";
import type { TelegramAgentStore } from "../storage/store";

export const DEFAULT_REGRESSION_INTERVAL_MS = 24 * 60 * 60_000;
const MAX_SUMMARY = 400;
const PROBE_BATCH = 2;

export type RegressionCommandRunner = {
  run(input: {
    projectId: string;
    command: PolicyCommand;
  }): Promise<{ ok: boolean; summary: string }>;
};

export type RegressionWatchDependencies = {
  store: Pick<
    TelegramAgentStore,
    | "listEnabledProjectPolicies"
    | "getRegressionWatch"
    | "recordRegressionReading"
    | "recordRegressionReported"
    | "getOwner"
    | "getControllerForOwner"
    | "enqueueControllerTurn"
  >;
  commands: RegressionCommandRunner;
  clock: { now(): number };
  issueUpdateId(now: number): number;
  warn?: (message: string) => void;
};

function summarize(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return "no output";
  return normalized.length <= MAX_SUMMARY ? normalized : `${normalized.slice(0, MAX_SUMMARY - 1)}…`;
}

/**
 * Runs each project's configured checks on a timer and tells the owner only
 * when something is *newly* broken. Everything about this service exists to
 * keep that message rare enough to be worth reading: failures are re-run before
 * they count, tracked by name rather than by count, and reported once.
 */
export class RegressionWatchService {
  public constructor(private readonly dependencies: RegressionWatchDependencies) {}

  public async processDue(): Promise<boolean> {
    const owner = this.dependencies.store.getOwner();
    if (!owner) return false;
    const controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
    if (!controller) return false;
    let worked = false;
    let probed = 0;
    for (const { policy } of this.dependencies.store.listEnabledProjectPolicies()) {
      const regression = policy.regression;
      if (!regression || regression.commands.length === 0) continue;
      if (probed >= PROBE_BATCH) break;
      const now = this.dependencies.clock.now();
      const previous = this.dependencies.store.getRegressionWatch(policy.projectId);
      const interval = regression.intervalMs ?? DEFAULT_REGRESSION_INTERVAL_MS;
      if (previous && now - (previous.lastCheckedAt ?? 0) < interval) continue;
      probed += 1;

      const reading = await this.probe(policy.projectId, regression.commands);
      const record = this.dependencies.store.recordRegressionReading({
        projectId: policy.projectId,
        confirmed: reading.confirmed,
        flaky: reading.flaky,
        summary: reading.summary,
        now,
      });
      if (reading.flaky.length > 0) {
        this.dependencies.warn?.(
          `Regression check for ${policy.alias} had flaky commands: ${reading.flaky.join(", ")}`,
        );
      }

      const transition = regressionTransition({
        confirmed: record.confirmedFailures,
        reported: record.reportedFailures,
      });
      const notice = regressionNotice({
        alias: policy.alias,
        transition,
        summary: record.lastSummary,
      });
      if (notice === null) continue;
      // Claim the report before enqueuing, so a crash cannot repeat it.
      if (!this.dependencies.store.recordRegressionReported({
        projectId: policy.projectId,
        reported: record.confirmedFailures,
        now,
      })) continue;
      this.dependencies.store.enqueueControllerTurn({
        controllerKey: controller.controllerKey,
        telegramUserId: owner.userId,
        telegramChatId: owner.chatId,
        updateId: this.dependencies.issueUpdateId(now),
        inputText: notice,
        origin: "system",
        now,
      });
      worked = true;
    }
    return worked;
  }

  /**
   * Every command runs; unlike a job's validation there is no reason to stop at
   * the first failure, because the whole point is knowing the full set. A
   * failing command is immediately re-run once: passing the second time makes
   * it flaky, failing twice makes it real.
   */
  private async probe(
    projectId: string,
    commands: readonly PolicyCommand[],
  ): Promise<{ confirmed: string[]; flaky: string[]; summary: string }> {
    const confirmed: string[] = [];
    const flaky: string[] = [];
    const details: string[] = [];
    for (const command of commands) {
      const first = await this.runOnce(projectId, command);
      if (first === null) continue;
      if (first.ok) continue;
      const second = await this.runOnce(projectId, command);
      if (second === null) continue;
      if (second.ok) {
        flaky.push(command.name);
        continue;
      }
      confirmed.push(command.name);
      details.push(`${command.name}: ${second.summary}`);
    }
    return {
      confirmed,
      flaky,
      summary: details.length > 0 ? summarize(details.join(" | ")) : "all checks passed",
    };
  }

  /** null means the check could not run, which is not evidence of a regression. */
  private async runOnce(
    projectId: string,
    command: PolicyCommand,
  ): Promise<{ ok: boolean; summary: string } | null> {
    try {
      return await this.dependencies.commands.run({ projectId, command });
    } catch (error) {
      this.dependencies.warn?.(
        `Regression check for ${projectId} could not run: ${redactError(error).slice(0, 200)}`,
      );
      return null;
    }
  }
}
