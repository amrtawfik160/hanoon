import {
  detectFailureClusters,
  failureLoopNotice,
  ESCALATION_DEDUP_MS,
  FAILURE_CLUSTER_THRESHOLD,
  FAILURE_WINDOW_MS,
} from "../autonomy/failure-loop";
import type { TelegramAgentStore } from "../storage/store";

const SCAN_INTERVAL_MS = 60 * 60_000;
const MAX_FAILURES_SCANNED = 200;

export type FailureLoopDependencies = {
  store: Pick<
    TelegramAgentStore,
    | "listRecentJobFailures"
    | "claimFailureEscalation"
    | "pauseProjectAdmission"
    | "listEnabledProjectPolicies"
    | "getOwner"
    | "getControllerForOwner"
    | "enqueueControllerTurn"
  >;
  clock: { now(): number };
  issueUpdateId(now: number): number;
  warn?: (message: string) => void;
};

/**
 * Watches for the same failure happening over and over. A repeated failure is
 * not a busy day, it is a fault that will keep consuming attempts until someone
 * changes something, so the affected project stops taking new work and the
 * owner is told once.
 *
 * In-flight work is deliberately untouched: pausing admission is a brake on
 * starting more, not a kill switch on what is already running.
 */
export class FailureLoopService {
  private lastScanAt = 0;

  public constructor(private readonly dependencies: FailureLoopDependencies) {}

  public processDue(): boolean {
    const now = this.dependencies.clock.now();
    if (now - this.lastScanAt < SCAN_INTERVAL_MS) return false;
    this.lastScanAt = now;
    try {
      return this.scan(now);
    } catch (error) {
      // A detector that can crash the executor is worse than no detector.
      this.dependencies.warn?.(
        `Failure-loop scan did not complete: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`,
      );
      return false;
    }
  }

  private scan(now: number): boolean {
    const owner = this.dependencies.store.getOwner();
    if (!owner) return false;
    const controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
    if (!controller) return false;

    const failures = this.dependencies.store.listRecentJobFailures({
      since: Math.max(0, now - FAILURE_WINDOW_MS),
      limit: MAX_FAILURES_SCANNED,
    });
    const clusters = detectFailureClusters({ failures, threshold: FAILURE_CLUSTER_THRESHOLD });
    if (clusters.length === 0) return false;

    const aliases = new Map(
      this.dependencies.store.listEnabledProjectPolicies()
        .map(({ policy }) => [policy.projectId, policy.alias] as const),
    );
    let worked = false;
    for (const cluster of clusters) {
      // Claim first: the pause and the message must never happen twice for one
      // cause, and claiming is the only step that can decide that.
      const claimed = this.dependencies.store.claimFailureEscalation({
        fingerprint: cluster.fingerprint,
        projectId: cluster.projectId,
        clusterSize: cluster.size,
        reason: cluster.reason,
        now,
        dedupMs: ESCALATION_DEDUP_MS,
      });
      if (!claimed) continue;
      if (cluster.projectId !== null) {
        this.dependencies.store.pauseProjectAdmission({
          projectId: cluster.projectId,
          reason: `the same failure repeated ${cluster.size} times`,
          fingerprint: cluster.fingerprint,
          now,
        });
      }
      this.dependencies.store.enqueueControllerTurn({
        controllerKey: controller.controllerKey,
        telegramUserId: owner.userId,
        telegramChatId: owner.chatId,
        updateId: this.dependencies.issueUpdateId(now),
        inputText: failureLoopNotice(
          cluster,
          cluster.projectId === null ? null : aliases.get(cluster.projectId) ?? null,
        ),
        origin: "system",
        now,
      });
      worked = true;
    }
    return worked;
  }
}
