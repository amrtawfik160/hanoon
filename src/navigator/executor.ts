import type { ModelRoute } from "../capabilities/models";
import type { StoredEffect } from "../domain/models";
import type { EffectFence } from "../services/effect-runner";
import type { TelegramAgentStore } from "../storage/store";
import type {
  NavigatorInferenceObservation,
  NavigatorProposalDecision,
  NavigatorSkillAttempt,
  NavigatorSnapshot,
} from "./models";
import { NAVIGATOR_RESEARCH_STEP_CONTRACT } from "./models";
import {
  NavigatorPublicationDriftError,
  type NavigatorPlanningPublication,
} from "./planning-publisher";
import { navigatorStepContract } from "./planning-contracts";

export interface WorkflowNavigator {
  propose(snapshot: NavigatorSnapshot): Promise<unknown>;
}

export type NavigatorSkillResource = Readonly<{
  kind: "bb_thread";
  id: string;
}>;

export interface NavigatorSkillRunner {
  run(
    attempt: NavigatorSkillAttempt,
    hooks: Readonly<{
      bindResource(resource: NavigatorSkillResource): Promise<void>;
    }>,
    signal: AbortSignal,
  ): Promise<Readonly<{
    resource: NavigatorSkillResource;
    observedExternalStateDigest: string;
    result: unknown;
  }>>;
}

export type NavigatorWorkflowExecutorDependencies = Readonly<{
  store: TelegramAgentStore;
  navigator: WorkflowNavigator;
  observeInference(snapshot: NavigatorSnapshot): Promise<NavigatorInferenceObservation>;
  skillRunner: NavigatorSkillRunner;
  planningPublisher?: Readonly<{
    publish(
      attempt: NavigatorSkillAttempt,
      result: unknown,
      fence: Readonly<{ ownerId: string; generation: number; now: number }>,
    ): Promise<NavigatorPlanningPublication>;
  }>;
  modelRoute(): ModelRoute;
  clock: { now(): number };
  leaseMs?: number;
}>;

function payloadIdentifier(effect: StoredEffect, key: string): string {
  const payloadValue = effect.payload[key];
  if (typeof payloadValue !== "string" || payloadValue.length === 0 || payloadValue.length > 256) {
    throw new TypeError(`navigator effect ${key} is invalid`);
  }
  return payloadValue;
}

function failureSummary(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const normalized = raw.replace(/\s+/gu, " ").trim();
  return (normalized || "Navigator skill runner failed").slice(0, 500);
}

export class NavigatorWorkflowExecutor {
  public constructor(private readonly dependencies: NavigatorWorkflowExecutorDependencies) {}

  public async proposeNext(input: Readonly<{
    jobId: string;
    externalStateDigest: string;
    evidenceRefs: readonly string[];
  }>): Promise<NavigatorProposalDecision> {
    const snapshot = this.dependencies.store.createNavigatorSnapshot({
      ...input,
      now: this.dependencies.clock.now(),
    });
    const rawProposal = await this.dependencies.navigator.propose(snapshot);
    const observation = await this.dependencies.observeInference(snapshot);
    return this.dependencies.store.recordNavigatorProposal({
      snapshotId: snapshot.snapshotId,
      rawProposal,
      observation,
      selectModelRoute: this.dependencies.modelRoute,
      now: this.dependencies.clock.now(),
    });
  }

  public async processOne(fence: EffectFence, signal: AbortSignal): Promise<boolean> {
    const now = this.dependencies.clock.now();
    const effect = this.dependencies.store.leaseNavigatorSkillEffect({
      ownerId: fence.ownerId,
      generation: fence.generation,
      now,
      leaseMs: this.dependencies.leaseMs ?? 30_000,
    });
    if (!effect) return false;
    const attemptId = payloadIdentifier(effect, "attemptId");
    const attempt = this.dependencies.store.getNavigatorSkillAttempt(attemptId);
    if (!attempt || attempt.effectIdempotencyKey !== effect.idempotencyKey) {
      this.dependencies.store.deadLetterEffect(
        effect.idempotencyKey,
        fence.ownerId,
        fence.generation,
        "Navigator skill attempt identity is unavailable",
        this.dependencies.clock.now(),
      );
      return true;
    }
    const leaseMs = this.dependencies.leaseMs ?? 30_000;
    const leaseAbort = new AbortController();
    const timeoutAbort = new AbortController();
    const runSignal = AbortSignal.any([signal, fence.signal, leaseAbort.signal, timeoutAbort.signal]);
    const interruption = new Promise<never>((_resolve, reject) => {
      if (runSignal.aborted) {
        reject(runSignal.reason ?? new Error("navigator skill run was aborted"));
        return;
      }
      runSignal.addEventListener("abort", () => {
        reject(runSignal.reason ?? new Error("navigator skill run was aborted"));
      }, { once: true });
    });
    const contract = navigatorStepContract(attempt.skillId) ?? NAVIGATOR_RESEARCH_STEP_CONTRACT;
    const timeout = setTimeout(() => {
      timeoutAbort.abort(new Error("navigator skill step timed out"));
    }, contract.timeoutMs);
    const renewal = setInterval(() => {
      try {
        const renewed = this.dependencies.store.renewJobOperationFences({
          jobId: effect.jobId,
          effectIdempotencyKey: effect.idempotencyKey,
          ownerId: fence.ownerId,
          generation: fence.generation,
          now: this.dependencies.clock.now(),
          leaseMs,
        });
        if (!renewed && !leaseAbort.signal.aborted) {
          leaseAbort.abort(new Error("navigator effect lease was lost"));
        }
      } catch (renewalError) {
        if (!leaseAbort.signal.aborted) leaseAbort.abort(renewalError);
      }
    }, Math.max(1, Math.min(10_000, Math.floor(leaseMs / 3))));
    try {
      const hooks = {
        bindResource: async (resource: NavigatorSkillResource): Promise<void> => {
          const bound = this.dependencies.store.bindNavigatorSkillAttemptResource({
            attemptId: attempt.id,
            effectIdempotencyKey: effect.idempotencyKey,
            resource,
            ownerId: fence.ownerId,
            generation: fence.generation,
            now: this.dependencies.clock.now(),
          });
          if (!bound) throw new Error("navigator skill resource fence was lost");
        },
      };
      const persistedResult = this.dependencies.store.getNavigatorPlanningResult(attempt.id);
      const skillRun = persistedResult === null
        ? await Promise.race([
          this.dependencies.skillRunner.run(attempt, hooks, runSignal),
          interruption,
        ])
        : {
          resource: attempt.resource!,
          observedExternalStateDigest: persistedResult.observedExternalStateDigest,
          result: persistedResult.result,
        };
      const returnedDifferentResource = attempt.resource !== null && (
        attempt.resource.kind !== skillRun.resource.kind || attempt.resource.id !== skillRun.resource.id
      );
      if (!returnedDifferentResource) await hooks.bindResource(skillRun.resource);
      const rebound = this.dependencies.store.getNavigatorSkillAttempt(attempt.id);
      const policyFailureReason = !returnedDifferentResource && rebound?.resource?.kind === skillRun.resource.kind &&
        rebound.resource.id === skillRun.resource.id
        ? undefined
        : "bb_resource_mismatch";
      const durableResult = policyFailureReason === undefined
        ? persistedResult ?? this.dependencies.store.recordNavigatorPlanningResult({
          attemptId: attempt.id,
          effectIdempotencyKey: effect.idempotencyKey,
          observedExternalStateDigest: skillRun.observedExternalStateDigest,
          result: skillRun.result,
          ownerId: fence.ownerId,
          generation: fence.generation,
          now: this.dependencies.clock.now(),
        })
        : null;
      let publication: NavigatorPlanningPublication | null = null;
      if (durableResult && this.dependencies.planningPublisher) {
        publication = await this.dependencies.planningPublisher.publish(
          attempt,
          durableResult.result,
          {
            ownerId: fence.ownerId,
            generation: fence.generation,
            now: this.dependencies.clock.now(),
          },
        );
      }
      const settled = this.dependencies.store.settleNavigatorSkillAttempt({
        attemptId: attempt.id,
        effectIdempotencyKey: effect.idempotencyKey,
        observedExternalStateDigest: skillRun.observedExternalStateDigest,
        result: durableResult?.result ?? skillRun.result,
        ...(publication === null ? {} : { publishedArtifactBindings: publication.artifactBindings }),
        ...(publication === null ? {} : { reconciledArtifactIds: publication.reconciledArtifactIds }),
        ...(policyFailureReason === undefined ? {} : { policyFailureReason }),
        ownerId: fence.ownerId,
        generation: fence.generation,
        now: this.dependencies.clock.now(),
      });
      if (!settled) throw new Error("navigator skill settlement fence was lost");
      return true;
    } catch (error) {
      const durableResult = this.dependencies.store.getNavigatorPlanningResult(attempt.id);
      if (error instanceof NavigatorPublicationDriftError && durableResult) {
        const settled = this.dependencies.store.settleNavigatorSkillAttempt({
          attemptId: attempt.id,
          effectIdempotencyKey: effect.idempotencyKey,
          observedExternalStateDigest: durableResult.observedExternalStateDigest,
          result: durableResult.result,
          policyFailureReason: error.reasonCode,
          ownerId: fence.ownerId,
          generation: fence.generation,
          now: this.dependencies.clock.now(),
        });
        if (!settled) throw new Error("navigator publication drift settlement fence was lost");
        return true;
      }
      this.dependencies.store.failEffect(
        effect.idempotencyKey,
        fence.ownerId,
        fence.generation,
        failureSummary(error),
        this.dependencies.clock.now() + 500,
        this.dependencies.clock.now(),
      );
      return true;
    } finally {
      clearInterval(renewal);
      clearTimeout(timeout);
    }
  }

}
