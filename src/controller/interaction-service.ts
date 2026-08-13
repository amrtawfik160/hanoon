import type { BbPluginApi } from "@bb/plugin-sdk";
import type { ControllerLeaseFence } from "./models";
import type { ControllerInteractionStore } from "../storage/controller-interaction-repository";

type Interactions = BbPluginApi["sdk"]["threads"]["interactions"];

/**
 * Delivers a durable owner decision only after BB proves the exact interaction
 * still belongs to the persisted hidden-controller generation.
 */
export class ControllerInteractionService {
  public constructor(private readonly dependencies: {
    store: ControllerInteractionStore;
    interactions: Interactions;
    clock: () => number;
  }) {}

  public async deliverAnswered(input: ControllerLeaseFence & { controllerKey: string; signal?: AbortSignal }): Promise<boolean> {
    const delivery = this.dependencies.store.getAnswered(input.controllerKey);
    if (!delivery) return false;
    const current = await this.dependencies.interactions.get({
      threadId: delivery.bbThreadId,
      interactionId: delivery.interactionId,
      signal: input.signal,
    });
    if (current.threadId !== delivery.bbThreadId || current.id !== delivery.interactionId) return false;
    if (current.status === "resolved" || current.status === "interrupted") {
      return this.dependencies.store.markDelivered({
        ...input,
        now: this.dependencies.clock(),
        interactionId: delivery.interactionId,
        turnId: delivery.turnId,
        bbThreadId: delivery.bbThreadId,
      });
    }
    if (current.status !== "pending") return false;
    const resolved = await this.dependencies.interactions.resolve({
      threadId: delivery.bbThreadId,
      interactionId: delivery.interactionId,
      resolution: delivery.answer,
    });
    if (resolved.id !== delivery.interactionId || resolved.threadId !== delivery.bbThreadId || resolved.status !== "resolved") return false;
    return this.dependencies.store.markDelivered({
      ...input,
      now: this.dependencies.clock(),
      interactionId: delivery.interactionId,
      turnId: delivery.turnId,
      bbThreadId: delivery.bbThreadId,
    });
  }
}
