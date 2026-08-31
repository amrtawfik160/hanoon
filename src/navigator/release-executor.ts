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

export function navigatorReleaseTitle(requestText: string): string {
  const trimmed = requestText.trim();
  if (trimmed.length === 0) return "Ship accepted navigator tickets";
  return trimmed.length <= 72 ? trimmed : `${trimmed.slice(0, 69).trimEnd()}...`;
}

function abortWhenSignaled(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("navigator release was aborted"));
      return;
    }
    signal.addEventListener("abort", () => {
      reject(signal.reason ?? new Error("navigator release was aborted"));
    }, { once: true });
  });
}

export class NavigatorReleaseExecutor {
  public constructor(private readonly dependencies: NavigatorReleaseExecutorDependencies) {}

  public integrationEnvironmentId(jobId: string): string {
    return this.dependencies.integrationWorktreeId(jobId);
  }

  public async executeEntry(
    input: Readonly<{ jobId: string; title: string; body: string }>,
    signal: AbortSignal,
  ): Promise<NavigatorPullRequestRecord> {
    return Promise.race([
      this.dependencies.publishPullRequest(input),
      abortWhenSignaled(signal),
    ]);
  }

  public async processOne(fence: EffectFence, signal: AbortSignal): Promise<boolean> {
    const now = this.dependencies.clock.now();
    const effect = this.dependencies.store.leaseNavigatorReleaseEffect({
      ownerId: fence.ownerId,
      generation: fence.generation,
      now,
      leaseMs: this.dependencies.leaseMs ?? 30_000,
    });
    if (!effect) return false;
    return this.processLeased(effect, fence, signal);
  }

  public async processLeased(effect: StoredEffect, fence: EffectFence, signal: AbortSignal): Promise<boolean> {
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
    const published = await Promise.race([
      this.dependencies.publishPullRequest({
        jobId: effect.jobId,
        title: navigatorReleaseTitle(this.dependencies.store.getJob(effect.jobId)?.requestText ?? ""),
        body: "Exact-head release of the accepted implementation tickets.",
      }),
      abortWhenSignaled(signal),
    ]);
    if (!this.dependencies.store.settleNavigatorReleaseEffect({
      effectIdempotencyKey: effect.idempotencyKey,
      number: published.number,
      url: published.url,
      environmentId: this.dependencies.integrationWorktreeId(effect.jobId),
      ownerId: fence.ownerId,
      generation: fence.generation,
      now: this.dependencies.clock.now(),
    })) {
      throw new Error("navigator release effect lease changed before settlement");
    }
    return true;
  }
}
