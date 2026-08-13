import type { ControllerLeaseFence } from "./models";
import {
  type ControllerInteractionDelivery,
  type ControllerInteractionStore,
} from "../storage/controller-interaction-repository";

export type ControllerInteractionRemote = Readonly<{
  id: string;
  threadId: string;
  status: string;
}>;

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
  isExecutorLeaseCurrent: (ownerId: string, generation: number, now: number) => boolean;
}>;

export class ControllerInteractionService {
  private readonly store: FencedInteractionStore;
  private readonly interactions: ControllerInteractionApi;

  public constructor(input: {
    store: FencedInteractionStore;
    interactions: ControllerInteractionApi;
  }) {
    this.store = input.store;
    this.interactions = input.interactions;
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
    if (!this.fenceIsCurrent(fence)) return false;
    const answered = this.store.getAnswered(controllerKey);
    if (!answered || !this.fenceIsCurrent(fence)) return false;

    const observed = await this.authoritativeGet(answered, signal);
    if (!observed || !this.fenceIsCurrent(fence)) return false;

    if (this.isTerminal(observed)) {
      return this.markDelivered(answered, fence);
    }
    if (observed.status !== "pending") return false;
    if (!this.fenceIsCurrent(fence)) return false;

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
    if (!resolved || !this.matches(answered, resolved) || !this.isTerminal(resolved)) return false;
    return this.markDelivered(answered, fence);
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
  ): boolean {
    if (!this.fenceIsCurrent(fence)) return false;
    return this.store.markDelivered({
      ...fence,
      interactionId: answered.interactionId,
      turnId: answered.turnId,
      bbThreadId: answered.bbThreadId,
    });
  }

  private fenceIsCurrent(fence: ControllerLeaseFence): boolean {
    return this.store.isExecutorLeaseCurrent(fence.ownerId, fence.generation, fence.now);
  }

  private matches(
    answered: ControllerInteractionDelivery,
    remote: ControllerInteractionRemote,
  ): boolean {
    return remote.id === answered.interactionId && remote.threadId === answered.bbThreadId;
  }

  private isTerminal(remote: ControllerInteractionRemote): boolean {
    return remote.status === "resolved" || remote.status === "interrupted";
  }
}
