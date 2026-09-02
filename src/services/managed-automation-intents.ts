import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  managedAutomationDefinitionSchema,
  managedAutomationOperationClassSchema,
  type ManagedAutomationDefinition,
} from "../domain/managed-automation";
import { redactError } from "../errors";
import {
  managedAutomationDigest,
  type ManagedAutomationBinding,
} from "../storage/managed-automation-repository";
import {
  ManagedAutomationIntentRepository,
  type ManagedAutomationIntent,
  type ManagedAutomationIntentOrigin,
} from "../storage/managed-automation-intent-repository";
import type { TelegramAgentStore } from "../storage/store";
import {
  managedAutomationExecutorMutation,
  type ManagedAutomationMutation,
  type ManagedAutomationService,
} from "./managed-automation-service";
import type { EffectFence } from "./effect-runner";

const boundedId = z.string().min(1).max(256);
const notificationPolicySchema = z.enum(["material", "always", "silent"]);
const desiredStateSchema = z.enum(["enabled", "paused", "retired"]);
const lifecycleOperationClassSchema = z.enum([
  "update",
  "enable",
  "disable",
  "run_now",
  "retire",
  "reconcile",
]);

const standingPolicyCreateIntentSchema = z.object({
  kind: z.literal("create"),
  requestId: boundedId,
  sourceKey: boundedId,
  definition: managedAutomationDefinitionSchema,
  notificationPolicy: notificationPolicySchema,
  intentKey: boundedId.optional(),
}).strict();

const standingPolicyLifecycleIntentSchema = z.object({
  kind: z.literal("submit"),
  requestId: boundedId,
  id: boundedId,
  operationClass: lifecycleOperationClassSchema,
  desiredState: desiredStateSchema,
  definition: managedAutomationDefinitionSchema.optional(),
  intentKey: boundedId.optional(),
}).strict();

export const managedAutomationStandingPolicyIntentSchema = z.discriminatedUnion("kind", [
  standingPolicyCreateIntentSchema,
  standingPolicyLifecycleIntentSchema,
]);

export const managedAutomationTriggeredIntentSchema = z.object({
  requestId: boundedId,
  id: boundedId,
  operationClass: lifecycleOperationClassSchema,
  desiredState: desiredStateSchema,
  parentOperationId: boundedId,
  definition: managedAutomationDefinitionSchema.optional(),
  intentKey: boundedId.optional(),
}).strict();

const managedAutomationIntentResultSchema = z.object({
  intentId: boundedId,
  state: z.enum(["pending", "leased", "succeeded", "failed"]),
}).strict();

export const managedAutomationIntentRpcContract = defineRpcContract({
  managed_automation_standing_policy: {
    input: managedAutomationStandingPolicyIntentSchema,
    output: managedAutomationIntentResultSchema,
  },
  managed_automation_automation_triggered: {
    input: managedAutomationTriggeredIntentSchema,
    output: managedAutomationIntentResultSchema,
  },
});

export type ManagedAutomationStandingPolicyIntent = z.infer<typeof managedAutomationStandingPolicyIntentSchema>;
export type ManagedAutomationTriggeredIntent = z.infer<typeof managedAutomationTriggeredIntentSchema>;
export type ManagedAutomationIntentResult = z.infer<typeof managedAutomationIntentResultSchema>;

type ManagedAutomationIntentRepositoryPort = Pick<
  ManagedAutomationIntentRepository,
  "enqueue" | "get" | "listDue" | "claim" | "settle"
>;

type ManagedAutomationIntentStore = Pick<
  TelegramAgentStore,
  "getOwner" | "getControllerForOwner" | "runExecutorMutation"
>;

export type ManagedAutomationIntentDispatcherDependencies = Readonly<{
  repository: ManagedAutomationIntentRepositoryPort;
  service: Pick<ManagedAutomationService, "intentAdapters">;
  store: ManagedAutomationIntentStore;
  clock: { now(): number };
  onWorkAvailable?: () => void;
  warn?: (message: string) => void;
}>;

const INTENT_LEASE_MS = 120_000;

function intentId(origin: ManagedAutomationIntentOrigin, requestId: string): string {
  return `managed-automation-intent-${managedAutomationDigest({ origin, requestId }).slice(0, 48)}`;
}

function intentError(error: unknown): string {
  const message = redactError(error).replace(/\s+/g, " ").trim();
  return message || "managed automation intent dispatch failed";
}

function currentController(store: ManagedAutomationIntentStore): Readonly<{
  controllerKey: string;
  projectId: string;
  hostId: string;
}> {
  const owner = store.getOwner();
  if (!owner) throw new Error("managed automation standing-policy intent requires a paired owner");
  const controller = store.getControllerForOwner(owner.userId, owner.chatId);
  if (!controller?.projectId || !controller.hostId) {
    throw new Error("managed automation standing-policy intent requires a verified controller project and host");
  }
  return {
    controllerKey: controller.controllerKey,
    projectId: controller.projectId,
    hostId: controller.hostId,
  };
}

export class ManagedAutomationIntentDispatcher {
  public constructor(private readonly dependencies: ManagedAutomationIntentDispatcherDependencies) {}

  public enqueueStandingPolicy(input: ManagedAutomationStandingPolicyIntent): ManagedAutomationIntentResult {
    const parsed = managedAutomationStandingPolicyIntentSchema.parse(input);
    return this.enqueue("standing-policy", parsed);
  }

  public enqueueAutomationTriggered(input: ManagedAutomationTriggeredIntent): ManagedAutomationIntentResult {
    const parsed = managedAutomationTriggeredIntentSchema.parse(input);
    return this.enqueue("automation-triggered", parsed);
  }

  public async processDue(
    now: number,
    signal: AbortSignal | undefined,
    fence: EffectFence,
  ): Promise<boolean> {
    if (!fence) throw new Error("managed automation intent processing requires an EffectFence");
    if (fence.signal.aborted || signal?.aborted) return false;
    const operationSignal = signal
      ? AbortSignal.any([fence.signal, signal])
      : fence.signal;
    let didWork = false;
    for (const pending of this.dependencies.repository.listDue(now, 20)) {
      if (operationSignal.aborted) break;
      const claimed = this.dependencies.repository.claim({
        intentId: pending.id,
        ownerId: fence.ownerId,
        generation: fence.generation,
        now,
        leaseMs: INTENT_LEASE_MS,
      });
      if (!claimed) continue;
      didWork = true;
      try {
        await this.dispatch(claimed, now, operationSignal, fence);
        if (operationSignal.aborted) break;
        if (!this.dependencies.repository.settle({
          intentId: claimed.id,
          ownerId: fence.ownerId,
          generation: fence.generation,
          now,
          outcome: "succeeded",
        })) break;
      } catch (error) {
        if (operationSignal.aborted) break;
        if (!this.dependencies.repository.settle({
          intentId: claimed.id,
          ownerId: fence.ownerId,
          generation: fence.generation,
          now,
          outcome: "failed",
          error: intentError(error),
        })) break;
        this.dependencies.warn?.(`Managed automation intent ${claimed.id} was refused: ${intentError(error)}`);
      }
    }
    return didWork;
  }

  private enqueue(
    origin: ManagedAutomationIntentOrigin,
    input: ManagedAutomationStandingPolicyIntent | ManagedAutomationTriggeredIntent,
  ): ManagedAutomationIntentResult {
    const id = intentId(origin, input.requestId);
    const record = this.dependencies.repository.enqueue({
      id,
      origin,
      input,
      now: this.dependencies.clock.now(),
    });
    if (record.state === "pending") this.dependencies.onWorkAvailable?.();
    return { intentId: record.id, state: record.state };
  }

  private async dispatch(
    intent: ManagedAutomationIntent,
    now: number,
    signal: AbortSignal,
    fence: EffectFence,
  ): Promise<ManagedAutomationBinding> {
    const mutate = managedAutomationExecutorMutation(this.dependencies.store, fence);
    if (intent.origin === "standing-policy") {
      const input = managedAutomationStandingPolicyIntentSchema.parse(intent.input);
      if (input.kind === "create") return this.dispatchStandingCreate(input, now, signal, mutate);
      return this.dependencies.service.intentAdapters.standingPolicy.submit({
        id: input.id,
        operationClass: input.operationClass,
        desiredState: input.desiredState,
        ...(input.definition ? { definition: input.definition } : {}),
        intentKey: input.intentKey ?? input.requestId,
        now,
        mutate,
      });
    }
    const input = managedAutomationTriggeredIntentSchema.parse(intent.input);
    return this.dependencies.service.intentAdapters.automationTriggered.submit({
      id: input.id,
      operationClass: input.operationClass,
      desiredState: input.desiredState,
      parentOperationId: input.parentOperationId,
      ...(input.definition ? { definition: input.definition } : {}),
      intentKey: input.intentKey ?? input.requestId,
      now,
      mutate,
    });
  }

  private async dispatchStandingCreate(
    input: Extract<ManagedAutomationStandingPolicyIntent, { kind: "create" }>,
    now: number,
    signal: AbortSignal,
    mutate: ManagedAutomationMutation,
  ): Promise<ManagedAutomationBinding> {
    const controller = currentController(this.dependencies.store);
    if (controller.projectId !== input.definition.projectId) {
      throw new Error("managed automation standing-policy intent project does not match the current controller");
    }
    const definition: ManagedAutomationDefinition = input.definition;
    return this.dependencies.service.intentAdapters.standingPolicy.create({
      scope: { kind: "host", hostId: controller.hostId, cwd: null },
      controllerKey: controller.controllerKey,
      sourceKey: input.sourceKey,
      definition,
      hostId: controller.hostId,
      notificationPolicy: input.notificationPolicy,
      now,
      mutate,
      signal,
      operation: {
        version: 1,
        operationClass: "create",
        targetProjectId: definition.projectId,
        targetHostId: controller.hostId,
        definitionRevision: 1,
        intentKey: input.intentKey ?? input.requestId,
      },
    });
  }
}

export function managedAutomationIntentRpcHandlers(
  dispatcher: ManagedAutomationIntentDispatcher,
): {
  managed_automation_standing_policy: (
    input: ManagedAutomationStandingPolicyIntent,
  ) => ManagedAutomationIntentResult;
  managed_automation_automation_triggered: (
    input: ManagedAutomationTriggeredIntent,
  ) => ManagedAutomationIntentResult;
} {
  return {
    managed_automation_standing_policy: (input) => dispatcher.enqueueStandingPolicy(input),
    managed_automation_automation_triggered: (input) => dispatcher.enqueueAutomationTriggered(input),
  };
}

export function registerManagedAutomationIntentRpc(
  bb: Pick<BbPluginApi, "rpc">,
  dispatcher: ManagedAutomationIntentDispatcher,
): void {
  bb.rpc.register(
    managedAutomationIntentRpcContract,
    managedAutomationIntentRpcHandlers(dispatcher),
  );
}
