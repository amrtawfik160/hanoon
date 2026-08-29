import type { StoredEffect } from "../domain/models";
import type { EffectFence } from "../services/effect-runner";
import type { TelegramAgentStore } from "../storage/store";
import type { NavigatorPullRequestRecord } from "./implementation-contracts";

export type NavigatorReleaseExecutorDependencies = Readonly<{
  store: TelegramAgentStore;
  publishPullRequest(input: Readonly<{ jobId: string; title: string; body: string }>): Promise<NavigatorPullRequestRecord>;
  integrationWorktreeId(jobId: string): string;
  clock: { now(): number };
  leaseMs?: number;
}>;

function payloadIdentifier(effect: StoredEffect, key: string): string {
  const payloadValue = effect.payload[key];
  if (typeof payloadValue !== "string" || payloadValue.length === 0 || payloadValue.length > 256) {
    throw new TypeError(`navigator release effect ${key} is invalid`);
  }
  return payloadValue;
}

function releaseTitle(requestText: string): string {
  const trimmed = requestText.trim();
  if (trimmed.length === 0) return "Ship accepted navigator tickets";
  return trimmed.length <= 72 ? trimmed : `${trimmed.slice(0, 69).trimEnd()}...`;
}

export class NavigatorReleaseExecutor {
  public constructor(private readonly dependencies: NavigatorReleaseExecutorDependencies) {}

  public async processOne(fence: EffectFence, _signal: AbortSignal): Promise<boolean> {
    const now = this.dependencies.clock.now();
    const effect = this.dependencies.store.leaseNavigatorReleaseEffect({
      ownerId: fence.ownerId,
      generation: fence.generation,
      now,
      leaseMs: this.dependencies.leaseMs ?? 30_000,
    });
    if (!effect) return false;
    const attemptId = payloadIdentifier(effect, "attemptId");
    const workflowStepId = payloadIdentifier(effect, "workflowStepId");
    const attempt = this.dependencies.store.getNavigatorReleaseAttempt(attemptId);
    if (!attempt || attempt.effectIdempotencyKey !== effect.idempotencyKey || attempt.workflowStepId !== workflowStepId) {
      this.dependencies.store.deadLetterEffect(
        effect.idempotencyKey,
        fence.ownerId,
        fence.generation,
        "Navigator release attempt identity is unavailable",
        this.dependencies.clock.now(),
      );
      return true;
    }
    if (!this.dependencies.store.taskAuthorityOperationIsCurrent(effect, "pull_request")) {
      this.dependencies.store.deadLetterEffect(
        effect.idempotencyKey,
        fence.ownerId,
        fence.generation,
        "task authority effect admission is absent, stale, or denied",
        this.dependencies.clock.now(),
      );
      return true;
    }
    const published = await this.dependencies.publishPullRequest({
      jobId: effect.jobId,
      title: releaseTitle(this.dependencies.store.getJob(effect.jobId)?.requestText ?? ""),
      body: "Exact-head release of the accepted implementation tickets.",
    });
    const current = this.dependencies.store.getJob(effect.jobId);
    if (current?.state === "implementing") {
      const updated = this.dependencies.store.applyExecutorJobEvent({
        jobId: current.id,
        expectedVersion: current.version,
        event: {
          type: "RELEASE_STARTED",
          number: published.number,
          url: published.url,
          environmentId: this.dependencies.integrationWorktreeId(current.id),
        },
        ownerId: fence.ownerId,
        generation: fence.generation,
        now: this.dependencies.clock.now(),
      });
      if (!updated) throw new Error("executor refused the RELEASE_STARTED job transition");
    }
    if (!this.dependencies.store.completeEffect(
      effect.idempotencyKey,
      fence.ownerId,
      fence.generation,
      this.dependencies.clock.now(),
    )) {
      throw new Error("navigator release effect lease changed before settlement");
    }
    return true;
  }
}
