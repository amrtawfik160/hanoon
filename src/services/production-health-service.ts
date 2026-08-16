import { redactError } from "../errors";
import type { PolicyCommand } from "../domain/models";
import type { ProductionHealthRecord, TelegramAgentStore } from "../storage/store";

/**
 * Canary commands run once, immediately after a deploy, and then nothing looks
 * at production again. That is how a crash loop runs for days while the agent
 * cheerfully reports every job green: it was watching its own work, not the
 * thing its work produced.
 *
 * This probe closes that gap without spending a model on it. Running the check
 * is deterministic, so it costs nothing but the command itself; the agent is
 * only woken when the answer *changes*. A probe that reports every quiet tick
 * would be both expensive and ignored.
 */
export const DEFAULT_HEALTH_INTERVAL_MS = 15 * 60_000;
// One bad reading is a blip — a deploy in flight, a restarting node. Three in a
// row is a fault worth waking someone for.
export const HEALTH_FAILURE_THRESHOLD = 3;
const MAX_SUMMARY = 400;
const PROBE_BATCH = 5;

export type HealthCommandRunner = {
  run(input: {
    projectId: string;
    command: PolicyCommand;
  }): Promise<{ ok: boolean; summary: string }>;
};

export type ProductionHealthDependencies = {
  store: Pick<
    TelegramAgentStore,
    | "listEnabledProjectPolicies"
    | "getProductionHealth"
    | "recordProductionHealth"
    | "recordProductionHealthReported"
    | "getOwner"
    | "getControllerForOwner"
    | "enqueueControllerTurn"
  >;
  commands: HealthCommandRunner;
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
 * Only a change is worth a message: a fault that has already been reported is
 * still on the owner's screen, and a recovery is worth exactly one line.
 */
export function healthNotice(input: {
  alias: string;
  state: ProductionHealthRecord["state"];
  reported: string | null;
  summary: string | null;
}): string | null {
  if (input.state === "failing" && input.reported !== "failing") {
    return `Production looks broken on ${input.alias}, and it is not something you asked about — the health check has failed ${HEALTH_FAILURE_THRESHOLD} times in a row.\n\nWhat it reported: ${input.summary ?? "no output"}\n\nFind out what is actually wrong and tell the owner in a line or two: what is failing, since when, and what you propose. Do not start a job to fix it without asking.`;
  }
  if (input.state === "ok" && input.reported === "failing") {
    return `Production is healthy again on ${input.alias}. Tell the owner in one line, and say what fixed it if you know.`;
  }
  return null;
}

export class ProductionHealthService {
  public constructor(private readonly dependencies: ProductionHealthDependencies) {}

  public async processDue(): Promise<boolean> {
    const owner = this.dependencies.store.getOwner();
    if (!owner) return false;
    const controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
    if (!controller) return false;
    let worked = false;
    let probed = 0;
    for (const { policy } of this.dependencies.store.listEnabledProjectPolicies()) {
      const commands = policy.production?.healthCommands;
      if (!commands || commands.length === 0) continue;
      if (probed >= PROBE_BATCH) break;
      const now = this.dependencies.clock.now();
      const previous = this.dependencies.store.getProductionHealth(policy.projectId);
      const interval = policy.production?.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
      if (previous && now - (previous.lastCheckedAt ?? 0) < interval) continue;
      probed += 1;
      const outcome = await this.probe(policy.projectId, commands);
      const record = this.dependencies.store.recordProductionHealth({
        projectId: policy.projectId,
        ok: outcome.ok,
        summary: outcome.summary,
        failureThreshold: HEALTH_FAILURE_THRESHOLD,
        now,
      });
      const notice = healthNotice({
        alias: policy.alias,
        state: record.state,
        reported: record.reportedState,
        summary: record.lastSummary,
      });
      if (notice === null) continue;
      // Claim the transition before enqueuing, so a crash cannot re-report it.
      if (!this.dependencies.store.recordProductionHealthReported({
        projectId: policy.projectId,
        state: record.state,
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

  /** The first failing command decides the verdict; the rest are not run. */
  private async probe(
    projectId: string,
    commands: readonly PolicyCommand[],
  ): Promise<{ ok: boolean; summary: string }> {
    for (const command of commands) {
      try {
        const result = await this.dependencies.commands.run({ projectId, command });
        if (!result.ok) return { ok: false, summary: summarize(`${command.name}: ${result.summary}`) };
      } catch (error) {
        this.dependencies.warn?.(
          `Production health check for ${projectId} could not run: ${redactError(error).slice(0, 200)}`,
        );
        // An unrunnable probe is not evidence that production is broken.
        return { ok: true, summary: "health check could not run" };
      }
    }
    return { ok: true, summary: "all checks passed" };
  }
}
