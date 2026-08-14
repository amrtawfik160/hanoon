import type { ControllerLeaseFence } from "./models";
import { canonicalControllerJson } from "./capability-executor";
import {
  type ControllerInteractionDelivery,
  type ControllerInteractionDeliveryFence,
  type ControllerInteractionStore,
} from "../storage/controller-interaction-repository";

export type ControllerInteractionRemote = Readonly<{
  id: string;
  threadId: string;
  status: string;
  resolution?: unknown;
}>;

export function controllerInteractionResolutionMatches(
  observed: unknown,
  expected: Record<string, unknown>,
): boolean {
  if (observed === null || observed === undefined) return false;
  try {
    return canonicalControllerJson(observed) === canonicalControllerJson(expected);
  } catch {
    return false;
  }
}

type ControllerInteractionApi = Readonly<{
  get(
    threadId: string,
    interactionId: string,
    signal?: AbortSignal,
  ): Promise<ControllerInteractionRemote | null>;
  resolve(
    input: {
      threadId: string;
      interactionId: string;
      resolution: Record<string, unknown>;
    },
    signal?: AbortSignal,
  ): Promise<ControllerInteractionRemote | null>;
}>;

type FencedInteractionStore = ControllerInteractionStore & Readonly<{
  isControllerInteractionDeliveryFenceCurrent: (input: ControllerInteractionDeliveryFence) => boolean;
}>;

export class ControllerInteractionService {
  private readonly store: FencedInteractionStore;
  private readonly interactions: ControllerInteractionApi;
  private readonly clock: { now(): number };

  public constructor(input: {
    store: FencedInteractionStore;
    interactions: ControllerInteractionApi;
    clock: { now(): number };
  }) {
    this.store = input.store;
    this.interactions = input.interactions;
    this.clock = input.clock;
  }

  /**
   * Resolves one durable owner answer, retaining it until BB has returned an
   * exact terminal interaction. A lost fence or an ambiguous provider result
   * leaves the answer available for the next executor generation.
   */
  public async deliverAnswered(
    controllerKey: string,
    fence: ControllerLeaseFence,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (this.isAborted(signal)) return false;
    const answered = this.store.getAnswered(controllerKey);
    if (!answered || !this.freshFenceIfCurrent(answered, fence, signal)) return false;

    const observed = await this.authoritativeGet(answered, signal);
    if (!observed || this.isAborted(signal)) return false;

    if (this.isResolvedWithExactAnswer(observed, answered.resolution)) {
      return this.markDelivered(answered, fence, signal);
    }
    if (observed.status !== "pending") return false;
    if (!this.freshFenceIfCurrent(answered, fence, signal)) return false;

    let resolved: ControllerInteractionRemote | null;
    try {
      resolved = await this.interactions.resolve({
        threadId: answered.bbThreadId,
        interactionId: answered.interactionId,
        resolution: answered.resolution,
      }, signal);
    } catch {
      // Provider failures are deliberately ambiguous; the durable answer must
      // remain available for a later authoritative retry.
      return false;
    }
    if (!resolved || !this.matches(answered, resolved) ||
        !this.isResolvedWithExactAnswer(resolved, answered.resolution)) return false;
    return this.markDelivered(answered, fence, signal);
  }

  private async authoritativeGet(
    answered: ControllerInteractionDelivery,
    signal?: AbortSignal,
  ): Promise<ControllerInteractionRemote | null> {
    try {
      const observed = await this.interactions.get(answered.bbThreadId, answered.interactionId, signal);
      return observed && this.matches(answered, observed) ? observed : null;
    } catch {
      // A failed authoritative read cannot prove either absence or delivery.
      return null;
    }
  }

  private markDelivered(
    answered: ControllerInteractionDelivery,
    fence: ControllerLeaseFence,
    signal?: AbortSignal,
  ): boolean {
    const deliveryFence = this.freshFenceIfCurrent(answered, fence, signal);
    return deliveryFence !== null && this.store.markDelivered(deliveryFence);
  }

  private freshFenceIfCurrent(
    answered: ControllerInteractionDelivery,
    fence: ControllerLeaseFence,
    signal?: AbortSignal,
  ): ControllerInteractionDeliveryFence | null {
    if (this.isAborted(signal)) return null;
    try {
      const deliveryFence: ControllerInteractionDeliveryFence = {
        ownerId: fence.ownerId,
        generation: fence.generation,
        now: this.clock.now(),
        interactionId: answered.interactionId,
        turnId: answered.turnId,
        controllerKey: answered.controllerKey,
        bbThreadId: answered.bbThreadId,
        controllerGenerationId: answered.controllerGenerationId,
      };
      const predicateCurrent = this.store.isControllerInteractionDeliveryFenceCurrent(deliveryFence);
      return predicateCurrent && !this.isAborted(signal) ? deliveryFence : null;
    } catch {
      return null;
    }
  }

  private isAborted(signal?: AbortSignal): boolean {
    return signal?.aborted === true;
  }

  private matches(
    answered: ControllerInteractionDelivery,
    remote: ControllerInteractionRemote,
  ): boolean {
    return remote.id === answered.interactionId && remote.threadId === answered.bbThreadId;
  }

  private isResolvedWithExactAnswer(
    remote: ControllerInteractionRemote,
    expected: Record<string, unknown>,
  ): boolean {
    return remote.status === "resolved" && controllerInteractionResolutionMatches(remote.resolution, expected);
  }
}
