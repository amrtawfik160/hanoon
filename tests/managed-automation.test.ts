import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import type {
  BbAutomation,
  BbAutomationDefinition,
  BbAutomationRun,
} from "../src/bb/automation";
import {
  assertAutomationMatches,
  BbAutomationNotFoundError,
  TerminalBbAutomationAdapter,
} from "../src/bb/automation";
import {
  ManagedAutomationReconciler,
  ManagedAgentExecutionContractUnsupportedError,
  ManagedAutomationService,
  migrateLegacyClockMonitor,
  type ManagedAutomationAdapter,
} from "../src/services/managed-automation-service";
import { ManagedAutomationRepository } from "../src/storage/managed-automation-repository";
import { openStore, type MonitorRecord } from "../src/storage/store";
import { runJobExecutorService } from "../src/services/job-executor-service";
import { hashSecret } from "../src/crypto";
import { registerControllerTools } from "../src/controller/tools";
import { policyFixture } from "./helpers";
import { submittedControllerFixture } from "./support/controller-trust-fixtures";
import type {
  ManagedAutomationAuthority,
  ManagedAutomationCreateReceipt,
  ManagedAutomationObservation,
  ManagedAutomationProviderIdentity,
} from "../src/domain/managed-automation";

const NOW = 1_800_000_000_000;
const SCOPE = { kind: "environment", environmentId: "env_owner" } as const;
let fixtureNumber = 0;

const definition: BbAutomationDefinition = {
  mode: "agent",
  projectId: "proj_owner",
  name: "Daily release health",
  trigger: { kind: "cron", cron: "0 8 * * *", timezone: "Etc/UTC" },
  prompt: "Check production and report only a material change.",
  providerId: "codex-provider",
  model: "gpt-5.6-sol",
  permissionMode: "full",
  target: { kind: "project-default" },
  timeoutMs: 900_000,
  resultContract: { kind: "bounded-text", maximumBytes: 32_768 },
};

function automation(
  value: BbAutomationDefinition = definition,
  overrides: Partial<BbAutomation> = {},
): BbAutomation {
  return {
    id: "auto_1",
    projectId: value.projectId,
    name: value.name,
    enabled: true,
    trigger: value.trigger.kind === "cron"
      ? { triggerType: "schedule", cron: value.trigger.cron, timezone: value.trigger.timezone }
      : { triggerType: "once", runAt: NOW + 60_000 },
    execution: value.mode === "agent"
      ? {
          mode: "agent",
          prompt: value.prompt,
          providerId: value.providerId,
          model: value.model,
          ...(value.reasoningLevel ? { reasoningLevel: value.reasoningLevel } : {}),
          ...(value.serviceTier ? { serviceTier: value.serviceTier } : {}),
          permissionMode: value.permissionMode,
          environment: { type: "project-default" },
        }
      : {
          mode: "script",
          interpreter: value.interpreter,
          timeoutMs: value.timeoutMs,
          script: value.source.kind === "inline" ? value.source.script : "",
          env: value.env,
          storedScriptPath: "/managed/script.sh",
        },
    origin: "agent",
    createdByThreadId: "thr_controller",
    nextRunAt: NOW + 60_000,
    lastRunAt: null,
    runCount: 0,
    lastRunStatus: null,
    lastRunThreadId: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function providerName(name: string, identity?: ManagedAutomationProviderIdentity): string {
  return identity ? `${name} [${identity.ownershipMarker}]` : name;
}

function managedObservation(
  value: BbAutomation,
  expectedDefinition?: BbAutomationDefinition,
): ManagedAutomationObservation {
  return {
    providerAutomationId: value.id,
    projectId: value.projectId,
    name: expectedDefinition?.name ?? value.name,
    enabled: value.enabled,
    trigger: value.trigger.triggerType === "schedule"
      ? { kind: "cron", cron: value.trigger.cron, timezone: value.trigger.timezone }
      : { kind: "once", at: new Date(value.trigger.runAt).toISOString() },
    mode: value.execution.mode,
    target: value.execution.mode === "script"
      ? null
      : value.execution.targetThreadId
        ? { kind: "target-thread", threadId: value.execution.targetThreadId }
        : value.execution.environment.type === "project-default"
          ? { kind: "project-default" }
          : value.execution.environment.type === "reuse"
            ? { kind: "environment", environmentId: value.execution.environment.environmentId }
            : { kind: "new-worktree", baseBranch: value.execution.environment.workspace.baseBranch.name },
    nextRunAt: value.nextRunAt,
    lastRunAt: value.lastRunAt,
    runCount: value.runCount,
    lastRunStatus: value.lastRunStatus,
    lastRunThreadId: value.lastRunThreadId,
    lastError: value.lastError,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function runEvidence(overrides: Partial<BbAutomationRun> = {}): BbAutomationRun {
  return {
    id: "run_1",
    automationId: "auto_1",
    runMode: "agent",
    threadId: "thr_run_1",
    status: "succeeded",
    trigger: "schedule",
    skipReason: null,
    error: null,
    output: "Production is healthy.",
    exitCode: null,
    scheduledFor: NOW,
    startedAt: NOW + 1,
    finishedAt: NOW + 2,
    ...overrides,
  };
}

function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `managed-automation-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => NOW);
  const repository = new ManagedAutomationRepository(bb.storage.database());
  return { bb, store, repository };
}

function fakeAdapter(runClock = NOW) {
  const automations = new Map<string, BbAutomation>();
  const runs = new Map<string, BbAutomationRun[]>();
  const create = vi.fn(async ({ definition: value, identity }: {
    definition: BbAutomationDefinition;
    identity: ManagedAutomationProviderIdentity;
  }): Promise<ManagedAutomationCreateReceipt> => {
    const created = automation(value, {
      id: `auto_${automations.size + 1}`,
      name: providerName(value.name, identity),
    });
    automations.set(created.id, created);
    return {
      version: 1,
      operationId: identity.operationId,
      ownershipMarker: identity.ownershipMarker,
      providerAutomationId: created.id,
    };
  });
  const adapter: ManagedAutomationAdapter = {
    agentAutomationCapabilities: {
      executionTimeout: true,
      resultContract: true,
      preRunAuthority: true,
    },
    create,
    update: vi.fn(async ({ automationId, definition: value, identity }) => {
      const found = automations.get(automationId);
      if (!found) throw new Error("missing automation");
      const updated = automation(value, {
        id: automationId,
        name: providerName(value.name, identity),
        enabled: found.enabled,
        createdAt: found.createdAt,
        updatedAt: NOW + 1,
      });
      automations.set(automationId, updated);
      return managedObservation(updated, value);
    }),
    show: vi.fn(async ({ automationId, expectedDefinition, expectedEnabled, identity }) => {
      const found = automations.get(automationId);
      if (!found) throw new Error("missing automation");
      if (expectedDefinition) {
        assertAutomationMatches({ ...expectedDefinition, name: providerName(expectedDefinition.name, identity) }, found, expectedEnabled ?? true);
      }
      return managedObservation(found, expectedDefinition);
    }),
    setEnabled: vi.fn(async ({ automationId, enabled, expectedDefinition }) => {
      const found = automations.get(automationId);
      if (!found) throw new Error("missing automation");
      const updated = { ...found, enabled, nextRunAt: enabled ? NOW + 60_000 : null };
      automations.set(automationId, updated);
      return managedObservation(updated, expectedDefinition);
    }),
    runNow: vi.fn(async ({ automationId, idempotencyKey }) => {
      const previous = (runs.get(automationId) ?? []).find((candidate) => candidate.idempotencyKey === idempotencyKey);
      if (previous) return previous;
      const run = runEvidence({
        automationId,
        trigger: "manual",
        idempotencyKey,
        scheduledFor: runClock,
        startedAt: runClock + 1,
        finishedAt: runClock + 2,
      });
      runs.set(automationId, [...(runs.get(automationId) ?? []), run]);
      return run;
    }),
    runs: vi.fn(async ({ automationId }) => runs.get(automationId) ?? []),
    delete: vi.fn(async ({ automationId }) => {
      if (!automations.delete(automationId)) throw new BbAutomationNotFoundError();
    }),
    findByDefinition: vi.fn(async ({ definition: requested, identity }) => {
      const found = [...automations.values()].find((candidate) => {
        try {
          assertAutomationMatches({ ...requested, name: providerName(requested.name, identity) }, candidate);
          return true;
        } catch {
          return false;
        }
      });
      return found ? managedObservation(found, requested) : null;
    }),
  };
  return { adapter, automations, runs, create };
}

function createInput() {
  return {
    scope: SCOPE,
    controllerKey: "owner-7-controller",
    sourceKey: "owner-schedule:daily-health",
    definition,
    authority: {
      source: "owner",
      controllerKey: "owner-7-controller",
      projectId: "proj_owner",
      hostId: "host_owner",
      mayWidenAutomation: false,
    },
    notificationPolicy: "material" as const,
    now: NOW,
  };
}

function versionedOwnerAuthority(turnId = "turn_owner"): Record<string, unknown> {
  return {
    version: 1,
    origin: "owner",
    controllerKey: "owner-7-controller",
    projectId: "proj_owner",
    hostId: "host_owner",
    taskAuthority: {
      version: 1,
      kind: "controller-turn",
      turnId,
      revision: 1,
    },
    standingAuthority: null,
    capabilityEvidence: {
      version: 1,
      profileId: "profile_owner",
      profileRevision: 1,
      capabilityId: "telegram_agent_watch",
      descriptorVersion: "1",
      descriptorDigest: "a".repeat(64),
      evidenceRefs: ["capability-profile:profile_owner:1"],
    },
    mayWidenAutomation: false,
  };
}

describe("managed BB automations", () => {
  it("refuses an agent schedule before invoking BB when the installed contract cannot enforce its boundaries", async () => {
    const { repository } = fixture();
    const run = vi.fn();
    const service = new ManagedAutomationService(
      repository,
      new TerminalBbAutomationAdapter({ run }),
      () => true,
    );

    await expect(service.create(createInput())).rejects.toMatchObject({
      code: "BB_AGENT_EXECUTION_CONTRACT_UNSUPPORTED",
    });

    expect(run).not.toHaveBeenCalled();
    expect(service.list("owner-7-controller")).toEqual([]);
  });

  it("records an owner tool request as pending durable state before the executor can call BB", async () => {
    const controllerFixture = submittedControllerFixture();
    try {
      const controller = controllerFixture.store.getControllerForOwner("7", "7");
      if (!controller?.threadId || !controller.projectId || !controller.hostId) {
        throw new Error("controller fixture is incomplete");
      }
      controllerFixture.store.upsertProjectPolicy(policyFixture(), 2_000);
      if (!controllerFixture.turn.capabilityProfileId) throw new Error("controller profile is missing");
      expect(controllerFixture.store.requestControllerCapabilityExpansion({
        controllerKey: controller.controllerKey,
        turnId: controllerFixture.turn.id,
        expectedProfileId: controllerFixture.turn.capabilityProfileId,
        bundleIds: ["monitoring"],
        now: 2_000,
      }).outcome).toBe("resume_required");
      const repository = new ManagedAutomationRepository(controllerFixture.bb.storage.database());
      const fake = fakeAdapter();
      const service = new ManagedAutomationService(repository, fake.adapter, () => true);
      registerControllerTools(controllerFixture.bb, {
        store: controllerFixture.store,
        sdk: controllerFixture.bb.sdk,
        threadOperations: { request: vi.fn() },
        health: () => ({ ok: true }),
        notify: vi.fn(),
        now: () => 2_000,
        controllerProviderId: () => "codex-provider",
        controllerExecution: () => ({
          model: "gpt-5.6-sol",
          reasoningLevel: "high",
          serviceTier: "default",
          permissionMode: "auto",
        }),
        automations: service,
      });

      const result = await controllerFixture.harness.behavior.callAgentTool(
        "telegram_agent_watch",
        { kind: "schedule", cron: "0 9 * * 1-5", instruction: "Send the weekday morning digest." },
        { threadId: controller.threadId, projectId: controller.projectId, signal: new AbortController().signal },
      );
      const projection = (typeof result === "string" ? JSON.parse(result) : result) as {
        watching: { id: string; state: string; nextDueAt: number | null; observed: unknown };
        _hanoonEvidence?: { outcome: string; proofKinds: string[] };
      };
      if (!projection.watching) throw new Error(`owner watch result was ${JSON.stringify(result)}`);
      expect(projection.watching).toMatchObject({ state: "pending", nextDueAt: null, observed: null });
      expect(projection._hanoonEvidence).toMatchObject({
        outcome: "observed",
        proofKinds: ["monitor_state", "obligation"],
      });
      expect(fake.create).not.toHaveBeenCalled();

      const binding = repository.get(projection.watching.id);
      expect(binding).toMatchObject({ state: "pending", bbAutomationId: null, lastOperationOutcome: "pending" });
      const operation = repository.getOperation(binding!.lastOperationId!);
      expect(operation).toMatchObject({
        operationClass: "create",
        state: "pending",
        targetProjectId: controller.projectId,
        definitionRevision: 1,
        controllerFence: {
          ownerId: controllerFixture.fence.ownerId,
          generation: controllerFixture.fence.generation,
          turnId: controllerFixture.turn.id,
        },
      });
      expect(controllerFixture.bb.storage.database().prepare(
        `SELECT controller_owner_id, controller_generation, controller_turn_id
           FROM managed_automation_operations WHERE id = ?`,
      ).get(operation!.id)).toEqual({
        controller_owner_id: controllerFixture.fence.ownerId,
        controller_generation: controllerFixture.fence.generation,
        controller_turn_id: controllerFixture.turn.id,
      });
    } finally {
      await controllerFixture.dispose();
    }
  });

  it("queues an owner definition update without calling BB during controller submission", async () => {
    const controllerFixture = submittedControllerFixture();
    try {
      const controller = controllerFixture.store.getControllerForOwner("7", "7");
      if (!controller?.threadId || !controller.projectId || !controller.hostId) {
        throw new Error("controller fixture is incomplete");
      }
      controllerFixture.store.upsertProjectPolicy(policyFixture(), 2_000);
      if (!controllerFixture.turn.capabilityProfileId) throw new Error("controller profile is missing");
      expect(controllerFixture.store.requestControllerCapabilityExpansion({
        controllerKey: controller.controllerKey,
        turnId: controllerFixture.turn.id,
        expectedProfileId: controllerFixture.turn.capabilityProfileId,
        bundleIds: ["monitoring"],
        now: 2_000,
      }).outcome).toBe("resume_required");
      const repository = new ManagedAutomationRepository(controllerFixture.bb.storage.database());
      const fake = fakeAdapter();
      const service = new ManagedAutomationService(repository, fake.adapter, () => true);
      registerControllerTools(controllerFixture.bb, {
        store: controllerFixture.store,
        sdk: controllerFixture.bb.sdk,
        threadOperations: { request: vi.fn() },
        health: () => ({ ok: true }),
        notify: vi.fn(),
        now: () => 2_000,
        controllerProviderId: () => "codex-provider",
        controllerExecution: () => ({
          model: "gpt-5.6-sol",
          reasoningLevel: "high",
          serviceTier: "default",
          permissionMode: "auto",
        }),
        automations: service,
      });
      const context = {
        threadId: controller.threadId,
        projectId: controller.projectId,
        signal: new AbortController().signal,
      };
      const createdValue = await controllerFixture.harness.behavior.callAgentTool(
        "telegram_agent_watch",
        { kind: "schedule", cron: "0 9 * * 1-5", instruction: "Send the weekday morning digest." },
        context,
      );
      const created = JSON.parse(typeof createdValue === "string" ? createdValue : JSON.stringify(createdValue)) as {
        watching: { id: string };
      };
      const reconciler = new ManagedAutomationReconciler({
        repository,
        service,
        store: controllerFixture.store,
        notify: vi.fn(),
      });
      await reconciler.processDue(2_001, context.signal, {
        ownerId: controllerFixture.fence.ownerId,
        generation: controllerFixture.fence.generation,
        signal: context.signal,
      });
      expect(fake.create).toHaveBeenCalledOnce();
      vi.mocked(fake.adapter.update).mockClear();

      const updatedValue = await controllerFixture.harness.behavior.callAgentTool(
        "telegram_agent_watch",
        {
          kind: "update_schedule",
          id: created.watching.id,
          cron: "30 9 * * 1-5",
          instruction: "Send the revised weekday digest.",
        },
        context,
      );
      const updated = JSON.parse(typeof updatedValue === "string" ? updatedValue : JSON.stringify(updatedValue)) as {
        watching: { id: string; state: string; definitionRevision: number; desiredState: string; observed: unknown };
      };

      expect(fake.adapter.update).not.toHaveBeenCalled();
      expect(updated.watching).toMatchObject({
        id: created.watching.id,
        state: "updating",
        definitionRevision: 2,
        desiredState: "enabled",
        observed: expect.objectContaining({ enabled: true }),
      });
      expect(repository.get(created.watching.id)).toMatchObject({
        state: "updating",
        definitionRevision: 2,
        desiredState: "enabled",
        lastOperationOutcome: "pending",
        lastReconciledOperationId: expect.any(String),
      });
      expect(repository.getOperation(repository.get(created.watching.id)!.lastOperationId!)).toMatchObject({
        operationClass: "update",
        state: "pending",
        definitionRevision: 2,
        intentKey: controllerFixture.turn.id,
      });

      const retriedValue = await controllerFixture.harness.behavior.callAgentTool(
        "telegram_agent_watch",
        {
          kind: "update_schedule",
          id: created.watching.id,
          cron: "30 9 * * 1-5",
          instruction: "Send the revised weekday digest.",
        },
        context,
      );
      const retried = JSON.parse(typeof retriedValue === "string" ? retriedValue : JSON.stringify(retriedValue)) as {
        watching: { id: string; state: string; definitionRevision: number };
      };
      expect(fake.adapter.update).not.toHaveBeenCalled();
      expect(retried.watching).toMatchObject({
        id: created.watching.id,
        state: "updating",
        definitionRevision: 2,
      });
    } finally {
      await controllerFixture.dispose();
    }
  });

  it("routes registered owner pause, resume, run-now, and retirement through the durable executor", async () => {
    const controllerFixture = submittedControllerFixture();
    try {
      const controller = controllerFixture.store.getControllerForOwner("7", "7");
      if (!controller?.threadId || !controller.projectId || !controller.hostId) {
        throw new Error("controller fixture is incomplete");
      }
      controllerFixture.store.upsertProjectPolicy(policyFixture(), 2_000);
      if (!controllerFixture.turn.capabilityProfileId) throw new Error("controller profile is missing");
      expect(controllerFixture.store.requestControllerCapabilityExpansion({
        controllerKey: controller.controllerKey,
        turnId: controllerFixture.turn.id,
        expectedProfileId: controllerFixture.turn.capabilityProfileId,
        bundleIds: ["monitoring"],
        now: 2_000,
      }).outcome).toBe("resume_required");

      const repository = new ManagedAutomationRepository(controllerFixture.bb.storage.database());
      const fake = fakeAdapter(2_000);
      const service = new ManagedAutomationService(repository, fake.adapter, () => true);
      registerControllerTools(controllerFixture.bb, {
        store: controllerFixture.store,
        sdk: controllerFixture.bb.sdk,
        threadOperations: { request: vi.fn() },
        health: () => ({ ok: true }),
        notify: vi.fn(),
        now: () => 2_000,
        controllerProviderId: () => "codex-provider",
        controllerExecution: () => ({
          model: "gpt-5.6-sol",
          reasoningLevel: "high",
          serviceTier: "default",
          permissionMode: "auto",
        }),
        automations: service,
      });
      const context = {
        threadId: controller.threadId,
        projectId: controller.projectId,
        signal: new AbortController().signal,
      };
      const process = async (now: number): Promise<void> => {
        const reconciler = new ManagedAutomationReconciler({
          repository,
          service,
          store: controllerFixture.store,
          notify: vi.fn(),
        });
        await reconciler.processDue(now, context.signal, {
          ownerId: controllerFixture.fence.ownerId,
          generation: controllerFixture.fence.generation,
          signal: context.signal,
        });
      };
      const parseWatching = (value: unknown) => JSON.parse(
        typeof value === "string" ? value : JSON.stringify(value),
      ) as { watching: { id: string; state: string; desiredState: string } };

      const created = parseWatching(await controllerFixture.harness.behavior.callAgentTool(
        "telegram_agent_watch",
        { kind: "schedule", cron: "0 9 * * 1-5", instruction: "Send the weekday morning digest." },
        context,
      ));
      await process(2_001);
      expect(fake.create).toHaveBeenCalledOnce();

      const paused = parseWatching(await controllerFixture.harness.behavior.callAgentTool(
        "telegram_agent_watch",
        { kind: "pause_schedule", id: created.watching.id },
        context,
      ));
      expect(fake.adapter.setEnabled).not.toHaveBeenCalled();
      expect(paused.watching).toMatchObject({ state: "updating", desiredState: "paused" });
      await process(2_002);
      expect(fake.adapter.setEnabled).toHaveBeenCalledTimes(1);
      expect(repository.get(created.watching.id)).toMatchObject({ state: "paused", desiredState: "paused" });

      const pausedUpdate = parseWatching(await controllerFixture.harness.behavior.callAgentTool(
        "telegram_agent_watch",
        {
          kind: "update_schedule",
          id: created.watching.id,
          cron: "15 9 * * 1-5",
          instruction: "Send the revised paused weekday digest.",
        },
        context,
      ));
      expect(pausedUpdate.watching).toMatchObject({ state: "updating", desiredState: "paused" });
      await process(2_003);
      expect(repository.get(created.watching.id)).toMatchObject({
        state: "paused",
        desiredState: "paused",
        definitionRevision: 2,
      });

      const resumed = parseWatching(await controllerFixture.harness.behavior.callAgentTool(
        "telegram_agent_watch",
        { kind: "resume_schedule", id: created.watching.id },
        context,
      ));
      expect(fake.adapter.setEnabled).toHaveBeenCalledTimes(1);
      expect(resumed.watching).toMatchObject({ state: "updating", desiredState: "enabled" });
      await process(2_003);
      expect(fake.adapter.setEnabled).toHaveBeenCalledTimes(2);
      expect(repository.get(created.watching.id)).toMatchObject({ state: "active", desiredState: "enabled" });

      const runNow = parseWatching(await controllerFixture.harness.behavior.callAgentTool(
        "telegram_agent_watch",
        { kind: "run_now", id: created.watching.id },
        context,
      ));
      expect(fake.adapter.runNow).not.toHaveBeenCalled();
      expect(runNow.watching).toMatchObject({ state: "active", desiredState: "enabled" });
      await process(2_004);
      expect(fake.adapter.runNow).toHaveBeenCalledOnce();
      const runOperation = repository.getOperation(repository.get(created.watching.id)!.lastOperationId!);
      expect(runOperation).toMatchObject({
        operationClass: "run_now",
        state: "succeeded",
        outcome: { kind: "settled", runReceipt: expect.objectContaining({
          version: 1,
          automationBindingId: created.watching.id,
          initiatingOperationId: runOperation?.id,
          outcomeClass: "succeeded",
        }) },
      });

      const cancelled = await controllerFixture.harness.behavior.callAgentTool(
        "telegram_agent_cancel_watch",
        { id: created.watching.id },
        context,
      );
      expect(cancelled).toContain('"cancelled":true');
      expect(fake.adapter.delete).not.toHaveBeenCalled();
      expect(repository.get(created.watching.id)).toMatchObject({ state: "retiring", desiredState: "retired" });
      await process(2_005);
      expect(fake.adapter.delete).toHaveBeenCalledOnce();
      expect(repository.get(created.watching.id)).toMatchObject({ state: "retired", desiredState: "retired" });
    } finally {
      await controllerFixture.dispose();
    }
  });

  it("settles an owner definition update through the real SQLite executor", async () => {
    const { store, repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const created = await service.create({
      ...createInput(),
      authority: versionedOwnerAuthority() as ManagedAutomationAuthority,
    });
    const updatedDefinition = {
      ...definition,
      trigger: { kind: "cron" as const, cron: "30 8 * * *", timezone: "Etc/UTC" },
      prompt: "Check production and report the revised material change.",
    };
    const updateAuthority = versionedOwnerAuthority("turn_update") as ManagedAutomationAuthority;
    const submitted = service.submitLifecycleOperation({
      id: created.id,
      operationClass: "update",
      desiredState: "enabled",
      authority: updateAuthority,
      controllerFence: { ownerId: "controller-executor", generation: 1, turnId: "turn_update" },
      definition: updatedDefinition,
      now: NOW + 1,
      mutate: (mutation) => mutation(),
    });
    const lease = store.acquireExecutorLease("automation-executor", NOW + 1, 120_000);
    if (!lease.acquired) throw new Error("missing automation executor lease");
    const reconciler = new ManagedAutomationReconciler({
      repository,
      service,
      store,
      notify: vi.fn(),
    });

    await reconciler.processDue(NOW + 2, new AbortController().signal, {
      ownerId: "automation-executor",
      generation: lease.generation,
      signal: new AbortController().signal,
    });

    expect(fake.adapter.update).toHaveBeenCalledOnce();
    expect(repository.get(submitted.id)).toMatchObject({
      state: "active",
      definitionRevision: 2,
      desiredState: "enabled",
      definition: updatedDefinition,
      lastOperationOutcome: "succeeded",
      lastReconciledOperationId: submitted.lastOperationId,
      lastReconciledOperationOutcome: "succeeded",
    });
    expect(repository.getOperation(submitted.lastOperationId!)).toMatchObject({
      state: "succeeded",
      operationClass: "update",
      definitionRevision: 2,
    });
  });

  it("routes pause, resume, and run-now through durable operations", async () => {
    const { store, repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const created = await service.create(createInput());
    const lease = store.acquireExecutorLease("automation-executor", NOW, 120_000);
    if (!lease.acquired) throw new Error("missing automation executor lease");
    const execute = async (
      turnId: string,
      operationClass: "disable" | "enable" | "run_now",
      desiredState: "paused" | "enabled",
      now: number,
    ) => {
      const callsBefore = vi.mocked(fake.adapter.setEnabled).mock.calls.length + vi.mocked(fake.adapter.runNow).mock.calls.length;
      const submitted = service.submitLifecycleOperation({
        id: created.id,
        operationClass,
        desiredState,
        authority: versionedOwnerAuthority(turnId) as ManagedAutomationAuthority,
        controllerFence: { ownerId: "controller-executor", generation: 1, turnId },
        now,
        mutate: (mutation) => mutation(),
      });
      expect(vi.mocked(fake.adapter.setEnabled).mock.calls.length + vi.mocked(fake.adapter.runNow).mock.calls.length).toBe(callsBefore);
      const reconciler = new ManagedAutomationReconciler({
        repository,
        service,
        store,
        notify: vi.fn(),
      });
      await reconciler.processDue(now + 1, new AbortController().signal, {
        ownerId: "automation-executor",
        generation: lease.generation,
        signal: new AbortController().signal,
      });
      return submitted;
    };

    const paused = await execute("turn_pause", "disable", "paused", NOW + 1);
    expect(repository.get(paused.id)).toMatchObject({ state: "paused", desiredState: "paused" });
    const resumed = await execute("turn_resume", "enable", "enabled", NOW + 3);
    expect(repository.get(resumed.id)).toMatchObject({ state: "active", desiredState: "enabled" });
    const run = await execute("turn_run", "run_now", "enabled", NOW + 5);

    expect(fake.adapter.setEnabled).toHaveBeenCalledTimes(2);
    expect(fake.adapter.runNow).toHaveBeenCalledTimes(1);
    expect(repository.getOperation(run.lastOperationId!)).toMatchObject({
      operationClass: "run_now",
      state: "succeeded",
      outcome: {
        kind: "settled",
        runReceipt: expect.objectContaining({
          version: 1,
          providerRunId: "run_1",
          automationBindingId: created.id,
          definitionRevision: 1,
          initiatingOperationId: run.lastOperationId,
          outcomeClass: "succeeded",
        }),
      },
    });
    expect(repository.get(created.id)).toMatchObject({
      lastReconciledOperationId: run.lastOperationId,
      lastReconciledOperationOutcome: "succeeded",
      lastRunId: "run_1",
    });
    const retry = service.submitLifecycleOperation({
      id: created.id,
      operationClass: "run_now",
      desiredState: "enabled",
      authority: versionedOwnerAuthority("turn_run") as ManagedAutomationAuthority,
      controllerFence: { ownerId: "controller-executor", generation: 1, turnId: "turn_run" },
      now: NOW + 7,
      mutate: (mutation) => mutation(),
    });
    expect(retry.lastOperationId).toBe(run.lastOperationId);
    expect(fake.adapter.runNow).toHaveBeenCalledTimes(1);
  });

  it("rejects lifecycle submission when persisted capability evidence is not current", async () => {
    const { repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true, () => false);
    const created = await service.create(createInput());

    expect(() => service.submitLifecycleOperation({
      id: created.id,
      operationClass: "disable",
      desiredState: "paused",
      authority: versionedOwnerAuthority("turn_denied") as ManagedAutomationAuthority,
      controllerFence: { ownerId: "controller-executor", generation: 1, turnId: "turn_denied" },
      now: NOW + 1,
      mutate: (mutation) => mutation(),
    })).toThrow("capability evidence is not current");

    expect(fake.adapter.setEnabled).not.toHaveBeenCalled();
    expect(repository.get(created.id)).toMatchObject({
      state: "active",
      desiredState: "enabled",
      lastOperationId: null,
    });
  });

  it("executes lifecycle submissions promptly when the reconciler instance is reused", async () => {
    const { store, repository } = fixture();
    const fake = fakeAdapter(2_000);
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const created = await service.create(createInput());
    const lease = store.acquireExecutorLease("automation-executor", NOW, 120_000);
    if (!lease.acquired) throw new Error("missing automation executor lease");
    const reconciler = new ManagedAutomationReconciler({ repository, service, store, notify: vi.fn() });
    const signal = new AbortController().signal;

    service.submitLifecycleOperation({
      id: created.id,
      operationClass: "disable",
      desiredState: "paused",
      authority: versionedOwnerAuthority("turn_prompt_pause") as ManagedAutomationAuthority,
      controllerFence: { ownerId: "controller-executor", generation: 1, turnId: "turn_prompt_pause" },
      now: NOW + 1,
      mutate: (mutation) => mutation(),
    });
    await reconciler.processDue(NOW + 2, signal, {
      ownerId: "automation-executor",
      generation: lease.generation,
      signal,
    });

    service.submitLifecycleOperation({
      id: created.id,
      operationClass: "enable",
      desiredState: "enabled",
      authority: versionedOwnerAuthority("turn_prompt_resume") as ManagedAutomationAuthority,
      controllerFence: { ownerId: "controller-executor", generation: 1, turnId: "turn_prompt_resume" },
      now: NOW + 3,
      mutate: (mutation) => mutation(),
    });
    await reconciler.processDue(NOW + 4, signal, {
      ownerId: "automation-executor",
      generation: lease.generation,
      signal,
    });

    expect(fake.adapter.setEnabled).toHaveBeenCalledTimes(2);
    expect(repository.get(created.id)).toMatchObject({ state: "active", desiredState: "enabled" });
  });

  it("routes retirement through a durable operation and makes the terminal state idempotent", async () => {
    const { store, repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const created = await service.create(createInput());
    const authority = versionedOwnerAuthority("turn_retire") as ManagedAutomationAuthority;
    const submitted = service.submitLifecycleOperation({
      id: created.id,
      operationClass: "retire",
      desiredState: "retired",
      authority,
      controllerFence: { ownerId: "controller-executor", generation: 1, turnId: "turn_retire" },
      now: NOW + 1,
      mutate: (mutation) => mutation(),
    });

    expect(fake.adapter.delete).not.toHaveBeenCalled();
    expect(submitted).toMatchObject({
      state: "retiring",
      desiredState: "retired",
      observed: expect.objectContaining({ providerAutomationId: "auto_1" }),
      lastOperationOutcome: "pending",
    });

    const lease = store.acquireExecutorLease("automation-executor", NOW + 1, 120_000);
    if (!lease.acquired) throw new Error("missing automation executor lease");
    const reconciler = new ManagedAutomationReconciler({
      repository,
      service,
      store,
      notify: vi.fn(),
    });
    const signal = new AbortController().signal;
    await reconciler.processDue(NOW + 2, signal, {
      ownerId: "automation-executor",
      generation: lease.generation,
      signal,
    });

    expect(fake.adapter.delete).toHaveBeenCalledOnce();
    expect(repository.get(created.id)).toMatchObject({
      state: "retired",
      desiredState: "retired",
      lastOperationId: submitted.lastOperationId,
      lastOperationOutcome: "succeeded",
      lastReconciledOperationId: submitted.lastOperationId,
      lastReconciledOperationOutcome: "succeeded",
    });
    expect(repository.getOperation(submitted.lastOperationId!)).toMatchObject({
      operationClass: "retire",
      state: "succeeded",
    });

    const retry = service.submitLifecycleOperation({
      id: created.id,
      operationClass: "retire",
      desiredState: "retired",
      authority,
      controllerFence: { ownerId: "controller-executor", generation: 1, turnId: "turn_retire" },
      now: NOW + 3,
      mutate: (mutation) => mutation(),
    });
    expect(retry.lastOperationId).toBe(submitted.lastOperationId);
    expect(fake.adapter.delete).toHaveBeenCalledOnce();
  });

  it("retries an ambiguous retirement by observing absence before deleting again", async () => {
    const { store, repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const created = await service.create(createInput());
    const submitted = service.submitLifecycleOperation({
      id: created.id,
      operationClass: "retire",
      desiredState: "retired",
      authority: versionedOwnerAuthority("turn_retire_timeout") as ManagedAutomationAuthority,
      controllerFence: { ownerId: "controller-executor", generation: 1, turnId: "turn_retire_timeout" },
      now: NOW + 1,
      mutate: (mutation) => mutation(),
    });
    const originalDelete = fake.adapter.delete;
    const deleteCall = vi.spyOn(fake.adapter, "delete").mockImplementationOnce(async (input) => {
      await originalDelete(input);
      throw new Error("BB automation delete timed out after applying");
    });
    const originalShow = fake.adapter.show;
    const showCall = vi.spyOn(fake.adapter, "show").mockImplementation(async (input) => {
      try {
        return await originalShow(input);
      } catch {
        throw new BbAutomationNotFoundError();
      }
    });
    const lease = store.acquireExecutorLease("automation-executor", NOW + 1, 120_000);
    if (!lease.acquired) throw new Error("missing automation executor lease");
    const reconciler = new ManagedAutomationReconciler({ repository, service, store, notify: vi.fn() });
    const signal = new AbortController().signal;

    await reconciler.processDue(NOW + 2, signal, {
      ownerId: "automation-executor",
      generation: lease.generation,
      signal,
    });
    expect(repository.getOperation(submitted.lastOperationId!)).toMatchObject({ state: "ambiguous" });

    await reconciler.processDue(NOW + 60_003, signal, {
      ownerId: "automation-executor",
      generation: lease.generation,
      signal,
    });

    expect(deleteCall).toHaveBeenCalledOnce();
    expect(showCall).toHaveBeenCalledOnce();
    expect(repository.get(created.id)).toMatchObject({ state: "retired", desiredState: "retired" });
    expect(repository.getOperation(submitted.lastOperationId!)).toMatchObject({ state: "succeeded" });
  });

  it("runs reconciliation as the same durable operation path and records observed provider truth", async () => {
    const { store, repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const created = await service.create({
      ...createInput(),
      authority: versionedOwnerAuthority() as ManagedAutomationAuthority,
    });
    fake.automations.set(created.bbAutomationId!, automation(definition, {
      id: created.bbAutomationId!,
      name: providerName(definition.name, {
        operationId: created.id,
        ownershipMarker: created.providerOwnershipMarker!,
      }),
      enabled: false,
    }));
    vi.mocked(fake.adapter.show).mockClear();
    vi.mocked(fake.adapter.update).mockClear();
    vi.mocked(fake.adapter.setEnabled).mockClear();
    vi.mocked(fake.adapter.runs).mockClear();

    const submitted = service.submitReconciliationOperation({
      binding: created,
      now: NOW + 1,
      mutate: (mutation) => mutation(),
    });
    expect(submitted).toMatchObject({ state: "active", lastOperationOutcome: "pending" });
    expect(repository.getOperation(submitted!.lastOperationId!)).toMatchObject({
      operationClass: "reconcile",
      state: "pending",
      intentKey: "reconcile:initial",
    });
    expect(fake.adapter.show).toHaveBeenCalledTimes(0);
    expect(fake.adapter.update).toHaveBeenCalledTimes(0);
    expect(fake.adapter.setEnabled).toHaveBeenCalledTimes(0);

    const lease = store.acquireExecutorLease("automation-executor", NOW + 1, 120_000);
    if (!lease.acquired) throw new Error("missing automation executor lease");
    const reconciler = new ManagedAutomationReconciler({
      repository,
      service,
      store,
      notify: vi.fn(),
    });
    const signal = new AbortController().signal;
    await reconciler.processDue(NOW + 2, signal, {
      ownerId: "automation-executor",
      generation: lease.generation,
      signal,
    });

    expect(fake.adapter.show).toHaveBeenCalledOnce();
    expect(fake.adapter.update).toHaveBeenCalledOnce();
    expect(fake.adapter.setEnabled).toHaveBeenCalledOnce();
    expect(fake.adapter.runs).toHaveBeenCalledOnce();
    expect(repository.get(created.id)).toMatchObject({
      state: "active",
      desiredState: "enabled",
      observed: expect.objectContaining({ enabled: true }),
      lastOperationOutcome: "succeeded",
      lastReconciledOperationOutcome: "succeeded",
    });
  });

  it("reconciles an update timeout by operation identity before retrying the provider", async () => {
    const { store, repository } = fixture();
    store.createPairingCode(hashSecret("pair-update-timeout"), NOW - 1_000, NOW + 10_000);
    expect(store.pairOwnerWithPrivateChatCode(
      hashSecret("pair-update-timeout"),
      "7",
      "70",
      NOW - 500,
    )).toEqual({ ok: true });
    store.enqueueControllerTurn({
      controllerKey: "owner-7-controller",
      telegramUserId: "7",
      telegramChatId: "70",
      updateId: 1,
      inputText: "Create the controller fixture.",
      now: NOW - 400,
    });
    store.upsertProjectPolicy(policyFixture({ projectId: "proj_owner", alias: "owner" }), NOW - 300);
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const created = await service.create(createInput());
    const updatedDefinition = {
      ...definition,
      trigger: { kind: "cron" as const, cron: "30 8 * * *", timezone: "Etc/UTC" },
    };
    const submitted = service.submitLifecycleOperation({
      id: created.id,
      operationClass: "update",
      desiredState: "enabled",
      authority: versionedOwnerAuthority("turn_update_timeout") as ManagedAutomationAuthority,
      controllerFence: {
        ownerId: "controller-executor",
        generation: 1,
        turnId: "turn_update_timeout",
      },
      definition: updatedDefinition,
      now: NOW + 1,
      mutate: (mutation) => mutation(),
    });
    const originalUpdate = fake.adapter.update;
    let updateCalls = 0;
    const timedOutUpdate = vi.spyOn(fake.adapter, "update").mockImplementation(async (input) => {
      updateCalls += 1;
      const observed = await originalUpdate(input);
      throw new Error("BB automation command timed out after applying the update");
    });
    const lease = store.acquireExecutorLease("automation-executor", NOW + 1, 120_000);
    if (!lease.acquired) throw new Error("missing automation executor lease");
    const reconciler = new ManagedAutomationReconciler({ repository, service, store, notify: vi.fn() });
    const signal = new AbortController().signal;
    await reconciler.processDue(NOW + 2, signal, {
      ownerId: "automation-executor",
      generation: lease.generation,
      signal,
    });

    expect(updateCalls).toBe(1);
    expect(repository.getOperation(submitted.lastOperationId!)).toMatchObject({ state: "ambiguous" });
    expect(repository.get(submitted.id)).toMatchObject({
      state: "updating",
      lastReconciledOperationOutcome: "ambiguous",
    });

    timedOutUpdate.mockRestore();
    await reconciler.processDue(NOW + 60_003, signal, {
      ownerId: "automation-executor",
      generation: lease.generation,
      signal,
    });

    expect(updateCalls).toBe(1);
    expect(repository.get(submitted.id)).toMatchObject({
      state: "active",
      definitionRevision: 2,
      lastOperationOutcome: "succeeded",
      lastReconciledOperationOutcome: "succeeded",
    });
  });

  it("reconciles a run-now timeout from its stable idempotency key before retrying", async () => {
    const { store, repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const created = await service.create(createInput());
    const authority = versionedOwnerAuthority("turn_run_timeout") as ManagedAutomationAuthority;
    const submitted = service.submitLifecycleOperation({
      id: created.id,
      operationClass: "run_now",
      desiredState: "enabled",
      authority,
      controllerFence: { ownerId: "controller-executor", generation: 1, turnId: "turn_run_timeout" },
      now: NOW + 1,
      mutate: (mutation) => mutation(),
    });
    const originalRunNow = fake.adapter.runNow;
    let runNowCalls = 0;
    const timedOutRunNow = vi.spyOn(fake.adapter, "runNow").mockImplementation(async (input) => {
      runNowCalls += 1;
      const run = await originalRunNow(input);
      throw new Error("BB automation command timed out after accepting the run");
    });
    const lease = store.acquireExecutorLease("automation-executor", NOW + 1, 120_000);
    if (!lease.acquired) throw new Error("missing automation executor lease");
    const reconciler = new ManagedAutomationReconciler({ repository, service, store, notify: vi.fn() });
    const signal = new AbortController().signal;
    await reconciler.processDue(NOW + 2, signal, {
      ownerId: "automation-executor",
      generation: lease.generation,
      signal,
    });

    expect(runNowCalls).toBe(1);
    expect(repository.getOperation(submitted.lastOperationId!)).toMatchObject({ state: "ambiguous" });
    timedOutRunNow.mockRestore();
    await reconciler.processDue(NOW + 60_003, signal, {
      ownerId: "automation-executor",
      generation: lease.generation,
      signal,
    });

    expect(runNowCalls).toBe(1);
    expect(repository.getOperation(submitted.lastOperationId!)).toMatchObject({
      state: "succeeded",
      outcome: { kind: "settled", runReceipt: expect.objectContaining({
        initiatingOperationId: submitted.lastOperationId,
        providerRunId: "run_1",
      }) },
    });
  });

  it.each(["update", "run_now"] as const)(
    "does not call BB when the executor lease is lost before a %s operation",
    async (operationClass) => {
      const { bb, store, repository } = fixture();
      const fake = fakeAdapter();
      const service = new ManagedAutomationService(repository, fake.adapter, () => true);
      const created = await service.create(createInput());
      const updatedDefinition = {
        ...definition,
        trigger: { kind: "cron" as const, cron: "30 8 * * *", timezone: "Etc/UTC" },
      };
      const submitted = operationClass === "update"
        ? service.submitLifecycleOperation({
            id: created.id,
            operationClass,
            desiredState: "enabled",
            authority: versionedOwnerAuthority(`turn_before_${operationClass}`) as ManagedAutomationAuthority,
            controllerFence: {
              ownerId: "controller-executor",
              generation: 1,
              turnId: `turn_before_${operationClass}`,
            },
            definition: updatedDefinition,
            now: NOW + 1,
            mutate: (mutation) => mutation(),
          })
        : service.submitLifecycleOperation({
            id: created.id,
            operationClass,
            desiredState: "enabled",
            authority: versionedOwnerAuthority(`turn_before_${operationClass}`) as ManagedAutomationAuthority,
            controllerFence: {
              ownerId: "controller-executor",
              generation: 1,
              turnId: `turn_before_${operationClass}`,
            },
            now: NOW + 1,
            mutate: (mutation) => mutation(),
          });
      const originalRenew = repository.renewOperationLease.bind(repository);
      const renewal = vi.spyOn(repository, "renewOperationLease").mockImplementation((input) => {
        const row = bb.storage.database().prepare(
          "SELECT owner_id, generation FROM executor_lease WHERE singleton = 1",
        ).get() as { owner_id: string | null; generation: number } | undefined;
        if (row?.owner_id !== null && row?.owner_id !== undefined) {
          store.releaseExecutorLease(row.owner_id, row.generation, input.now);
        }
        return originalRenew(input);
      });
      const stop = new AbortController();
      const reconciler = new ManagedAutomationReconciler({ repository, service, store, notify: vi.fn() });
      await runJobExecutorService({
        store,
        clock: { now: () => NOW + 2 },
        automations: reconciler,
        releaseOnShutdown: true,
        sleep: async () => stop.abort(),
      }, stop.signal);
      renewal.mockRestore();

      expect(operationClass === "update" ? fake.adapter.update : fake.adapter.runNow).not.toHaveBeenCalled();
      expect(repository.get(submitted.id)).toMatchObject({
        state: operationClass === "update" ? "updating" : "active",
      });
      expect(repository.getOperation(submitted.lastOperationId!)).toMatchObject({
        state: "leased",
        attempts: 1,
      });
    },
  );

  it.each(["update", "run_now"] as const)(
    "reconciles a %s after the provider call loses its executor lease without duplicating the effect",
    async (operationClass) => {
      const { bb, store, repository } = fixture();
      const fake = fakeAdapter();
      const service = new ManagedAutomationService(repository, fake.adapter, () => true);
      const created = await service.create(createInput());
      const updatedDefinition = {
        ...definition,
        trigger: { kind: "cron" as const, cron: "30 8 * * *", timezone: "Etc/UTC" },
      };
      const turnId = `turn_after_${operationClass}`;
      const submitted = operationClass === "update"
        ? service.submitLifecycleOperation({
            id: created.id,
            operationClass,
            desiredState: "enabled",
            authority: versionedOwnerAuthority(turnId) as ManagedAutomationAuthority,
            controllerFence: { ownerId: "controller-executor", generation: 1, turnId },
            definition: updatedDefinition,
            now: NOW + 1,
            mutate: (mutation) => mutation(),
          })
        : service.submitLifecycleOperation({
            id: created.id,
            operationClass,
            desiredState: "enabled",
            authority: versionedOwnerAuthority(turnId) as ManagedAutomationAuthority,
            controllerFence: { ownerId: "controller-executor", generation: 1, turnId },
            now: NOW + 1,
            mutate: (mutation) => mutation(),
          });
      const firstStop = new AbortController();
      let now = NOW + 2;
      let providerCalls = 0;
      const releaseExecutorLeaseAfterProvider = (): void => {
        const row = bb.storage.database().prepare(
          "SELECT owner_id, generation FROM executor_lease WHERE singleton = 1",
        ).get() as { owner_id: string | null; generation: number } | undefined;
        if (!row?.owner_id) throw new Error("executor lease was missing during provider call");
        if (!store.releaseExecutorLease(row.owner_id, row.generation, now)) {
          throw new Error("executor lease could not be released during provider call");
        }
        firstStop.abort(new Error("test lease lost after provider call"));
      };
      const originalUpdate = fake.adapter.update;
      const originalRunNow = fake.adapter.runNow;
      const update = vi.spyOn(fake.adapter, "update").mockImplementation(async (input) => {
        providerCalls += 1;
        const result = await originalUpdate(input);
        if (providerCalls === 1) releaseExecutorLeaseAfterProvider();
        return result;
      });
      const runNow = vi.spyOn(fake.adapter, "runNow").mockImplementation(async (input) => {
        providerCalls += 1;
        const result = await originalRunNow(input);
        if (providerCalls === 1) releaseExecutorLeaseAfterProvider();
        return result;
      });
      const reconciler = new ManagedAutomationReconciler({ repository, service, store, notify: vi.fn() });
      await runJobExecutorService({
        store,
        clock: { now: () => now },
        automations: reconciler,
        releaseOnShutdown: true,
        sleep: async () => firstStop.abort(),
      }, firstStop.signal);

      expect(providerCalls).toBe(1);
      expect(repository.getOperation(submitted.lastOperationId!)).toMatchObject({ state: "leased" });
      expect(operationClass === "update" ? update : runNow).toHaveBeenCalledOnce();

      now = NOW + 120_003;
      const successorStop = new AbortController();
      await runJobExecutorService({
        store,
        clock: { now: () => now },
        automations: reconciler,
        releaseOnShutdown: true,
        sleep: async () => successorStop.abort(),
      }, successorStop.signal);

      expect(providerCalls).toBe(1);
      expect(repository.getOperation(submitted.lastOperationId!)).toMatchObject({ state: "succeeded" });
      expect(repository.get(submitted.id)).toMatchObject({ lastOperationOutcome: "succeeded" });
    },
  );

  it("refuses an owner schedule when its profile has no assignment or selected receipt", async () => {
    const controllerFixture = submittedControllerFixture();
    try {
      const controller = controllerFixture.store.getControllerForOwner("7", "7");
      if (!controller?.threadId || !controller.projectId || !controller.hostId) {
        throw new Error("controller fixture is incomplete");
      }
      controllerFixture.store.upsertProjectPolicy(policyFixture(), 2_000);
      const repository = new ManagedAutomationRepository(controllerFixture.bb.storage.database());
      const fake = fakeAdapter();
      const service = new ManagedAutomationService(repository, fake.adapter, () => true);
      registerControllerTools(controllerFixture.bb, {
        store: controllerFixture.store,
        sdk: controllerFixture.bb.sdk,
        threadOperations: { request: vi.fn() },
        health: () => ({ ok: true }),
        notify: vi.fn(),
        now: () => 2_000,
        controllerProviderId: () => "codex-provider",
        controllerExecution: () => ({
          model: "gpt-5.6-sol",
          reasoningLevel: "high",
          serviceTier: "default",
          permissionMode: "auto",
        }),
        automations: service,
      });

      await expect(controllerFixture.harness.behavior.callAgentTool(
        "telegram_agent_watch",
        { kind: "schedule", cron: "0 9 * * 1-5", instruction: "Send the weekday morning digest." },
        { threadId: controller.threadId, projectId: controller.projectId, signal: new AbortController().signal },
      )).rejects.toThrow("does not authorize BB schedule management");

      expect(fake.create).not.toHaveBeenCalled();
      expect(repository.list(controller.controllerKey)).toEqual([]);
    } finally {
      await controllerFixture.dispose();
    }
  });

  it.each([
    ["malformed", { version: 1, value: { mode: "agent" } }],
    ["unknown-versioned", { version: 2, value: definition }],
  ])("fails closed when a %s current definition crosses the store boundary", async (_label, serialized) => {
    const { bb, repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const binding = await service.create(createInput());

    bb.storage.database().prepare(
      "UPDATE managed_automations SET definition_json = ? WHERE id = ?",
    ).run(JSON.stringify(serialized), binding.id);

    expect(() => repository.get(binding.id)).toThrow();
  });

  it("keeps an immediately preceding legacy definition readable", async () => {
    const { bb, repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const binding = await service.create(createInput());

    bb.storage.database().prepare(
      "UPDATE managed_automations SET definition_json = ? WHERE id = ?",
    ).run(JSON.stringify(definition), binding.id);

    expect(repository.get(binding.id)).toMatchObject({ id: binding.id, definition });
  });

  it.each([
    ["malformed", { version: 1, value: { providerAutomationId: "auto_1" } }],
    ["unknown-versioned", { version: 2, value: { providerAutomationId: "auto_1" } }],
  ])("fails closed when a %s current observation crosses the store boundary", async (_label, serialized) => {
    const { bb, repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const binding = await service.create(createInput());

    bb.storage.database().prepare(
      "UPDATE managed_automations SET observed_json = ? WHERE id = ?",
    ).run(JSON.stringify(serialized), binding.id);

    expect(() => repository.get(binding.id)).toThrow();
  });

  it("fails closed on an unknown current operation outcome while preserving a legacy outcome", async () => {
    const { bb, repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const pending = await service.create({
      ...createInput(),
      authority: versionedOwnerAuthority(),
      deferProvider: true,
      operation: {
        version: 1,
        operationClass: "create",
        targetProjectId: definition.projectId,
        definitionRevision: 1,
      },
      controllerFence: {
        ownerId: "controller-executor",
        generation: 1,
        turnId: "turn_owner",
      },
      mutate: (mutation) => mutation(),
    });
    const operationId = pending.lastOperationId!;
    const db = bb.storage.database();

    db.prepare("UPDATE managed_automation_operations SET outcome_json = ? WHERE id = ?")
      .run(JSON.stringify({ version: 2, kind: "settled" }), operationId);
    expect(() => repository.getOperation(operationId)).toThrow();

    db.prepare("UPDATE managed_automation_operations SET outcome_json = ? WHERE id = ?")
      .run(JSON.stringify({ legacy: true }), operationId);
    expect(repository.getOperation(operationId)).toMatchObject({ outcome: { legacy: true } });
  });

  it("reserves before the executor creates BB state and settles one durable outcome", async () => {
    const { store, repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const lease = store.acquireExecutorLease("automation-executor", NOW, 120_000);
    if (!lease.acquired) throw new Error("missing automation executor lease");
    const pending = await service.create({
      ...createInput(),
      authority: versionedOwnerAuthority(),
      deferProvider: true,
      operation: {
        version: 1,
        operationClass: "create",
        targetProjectId: definition.projectId,
        definitionRevision: 1,
      },
      controllerFence: {
        ownerId: "controller-executor",
        generation: 1,
        turnId: "turn_owner",
      },
      mutate: (mutation) => mutation(),
    });

    expect(pending.state).toBe("pending");
    expect(pending.bbAutomationId).toBeNull();
    expect(fake.create).not.toHaveBeenCalled();

    const reconciler = new ManagedAutomationReconciler({
      repository,
      service,
      store,
      notify: vi.fn(),
    });
    const signal = new AbortController().signal;
    await reconciler.processDue(NOW + 1, signal, {
      ownerId: "automation-executor",
      generation: lease.generation,
      signal,
    });

    const settled = service.get(pending.id);
    expect(settled).toMatchObject({
      state: "active",
      bbAutomationId: "auto_1",
      lastOperationOutcome: "succeeded",
    });
    expect(repository.getOperation(pending.lastOperationId!)).toMatchObject({
      state: "succeeded",
      providerAutomationId: "auto_1",
    });
    expect(fake.create).toHaveBeenCalledTimes(1);
  });

  it("runs the durable automation through the primary executor seam and converges after lease loss", async () => {
    const { store, repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const pending = await service.create({
      ...createInput(),
      authority: versionedOwnerAuthority(),
      deferProvider: true,
      operation: {
        version: 1,
        operationClass: "create",
        targetProjectId: definition.projectId,
        definitionRevision: 1,
      },
      controllerFence: {
        ownerId: "controller-executor",
        generation: 1,
        turnId: "turn_owner",
      },
      mutate: (mutation) => mutation(),
    });
    const reconciler = new ManagedAutomationReconciler({
      repository,
      service,
      store,
      notify: vi.fn(),
    });
    let now = NOW;
    const firstExecutorAbort = new AbortController();
    let stolenGeneration: number | null = null;
    let providerSawAbort = false;
    let firstProviderCall = true;
    const originalCreate = fake.adapter.create;
    const providerCreate = vi.spyOn(fake.adapter, "create").mockImplementation(async (input) => {
      if (!firstProviderCall) throw new Error("unexpected duplicate provider create");
      firstProviderCall = false;
      const receipt = await originalCreate(input);
      now = NOW + 30_001;
      const stolen = store.acquireExecutorLease("lease-successor", now, 30_000);
      if (!stolen.acquired) throw new Error("could not take over the executor lease");
      stolenGeneration = stolen.generation;
      const aborted = new Promise<void>((resolve) => {
        if (input.signal?.aborted) {
          providerSawAbort = true;
          resolve();
          return;
        }
        input.signal?.addEventListener("abort", () => {
          providerSawAbort = true;
          resolve();
        }, { once: true });
      });
      firstExecutorAbort.abort(new Error("test executor lease lost"));
      await aborted;
      return receipt;
    });

    await runJobExecutorService({
      store,
      clock: { now: () => now },
      automations: reconciler,
      releaseOnShutdown: true,
      sleep: async () => firstExecutorAbort.abort(),
    }, firstExecutorAbort.signal);

    expect(providerSawAbort).toBe(true);
    expect(providerCreate).toHaveBeenCalledTimes(1);
    expect(fake.adapter.delete).not.toHaveBeenCalled();
    expect(repository.getOperation(pending.lastOperationId!)).toMatchObject({
      state: "leased",
      providerAutomationId: null,
    });
    if (stolenGeneration === null) throw new Error("missing stolen executor lease");
    expect(store.releaseExecutorLease("lease-successor", stolenGeneration, now)).toBe(true);

    fake.automations.set("auto_unrelated", automation(definition, { id: "auto_unrelated" }));
    now = NOW + 120_002;
    const successorAbort = new AbortController();
    await runJobExecutorService({
      store,
      clock: { now: () => now },
      automations: reconciler,
      releaseOnShutdown: true,
      sleep: async () => successorAbort.abort(),
    }, successorAbort.signal);

    const settled = repository.get(pending.id);
    const operation = repository.getOperation(pending.lastOperationId!);
    expect(settled).toMatchObject({
      state: "active",
      bbAutomationId: "auto_1",
      observed: { providerAutomationId: "auto_1" },
      lastOperationOutcome: "succeeded",
    });
    expect(operation).toMatchObject({
      state: "succeeded",
      providerAutomationId: "auto_1",
      outcome: { version: 1, kind: "settled", outcome: "succeeded" },
    });
    expect(providerCreate).toHaveBeenCalledTimes(1);
    expect(fake.adapter.findByDefinition).toHaveBeenCalledTimes(1);
    expect(fake.adapter.delete).not.toHaveBeenCalled();
    expect(fake.automations.size).toBe(2);
  });

  it("blocks a current owner operation before the provider when its capability receipt is stale", async () => {
    const { store, repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(
      repository,
      fake.adapter,
      () => true,
      (_binding, operation) => operation.capabilityEvidence?.evidenceRefs.some((ref) => ref.startsWith("capability-receipt:")) === true,
    );
    const pending = await service.create({
      ...createInput(),
      authority: versionedOwnerAuthority(),
      deferProvider: true,
      operation: {
        version: 1,
        operationClass: "create",
        targetProjectId: definition.projectId,
        definitionRevision: 1,
      },
      controllerFence: {
        ownerId: "controller-executor",
        generation: 1,
        turnId: "turn_owner",
      },
      mutate: (mutation) => mutation(),
    });
    const reconciler = new ManagedAutomationReconciler({
      repository,
      service,
      store,
      notify: vi.fn(),
    });
    const abort = new AbortController();
    await runJobExecutorService({
      store,
      clock: { now: () => NOW },
      automations: reconciler,
      releaseOnShutdown: true,
      sleep: async () => abort.abort(),
    }, abort.signal);

    expect(fake.create).not.toHaveBeenCalled();
    expect(repository.get(pending.id)).toMatchObject({ state: "failed", bbAutomationId: null });
    expect(repository.getOperation(pending.lastOperationId!)).toMatchObject({ state: "failed" });
  });

  it("reconciles a provider success after executor restart without creating a duplicate", async () => {
    const { store, repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const firstLease = store.acquireExecutorLease("automation-executor", NOW, 120_000);
    if (!firstLease.acquired) throw new Error("missing first executor lease");
    const pending = await service.create({
      ...createInput(),
      authority: versionedOwnerAuthority(),
      deferProvider: true,
      operation: {
        version: 1,
        operationClass: "create",
        targetProjectId: definition.projectId,
        definitionRevision: 1,
      },
      controllerFence: {
        ownerId: "controller-executor",
        generation: 1,
        turnId: "turn_owner",
      },
      mutate: (mutation) => mutation(),
    });
    const operation = repository.claimOperation({
      operationId: pending.lastOperationId!,
      ownerId: "automation-executor",
      generation: firstLease.generation,
      now: NOW + 1,
      leaseMs: 120_000,
    });
    if (!operation) throw new Error("missing claimed automation operation");
    await service.executeClaimedOperation({
      binding: pending,
      operation,
      scope: SCOPE,
    });
    expect(store.releaseExecutorLease("automation-executor", firstLease.generation, NOW + 2)).toBe(true);

    const secondLease = store.acquireExecutorLease("automation-restart", NOW + 120_002, 120_000);
    if (!secondLease.acquired) throw new Error("missing replacement executor lease");
    const restarted = new ManagedAutomationReconciler({
      repository,
      service: new ManagedAutomationService(repository, fake.adapter, () => true),
      store,
      notify: vi.fn(),
    });
    const signal = new AbortController().signal;
    await restarted.processDue(NOW + 120_002, signal, {
      ownerId: "automation-restart",
      generation: secondLease.generation,
      signal,
    });

    expect(service.get(pending.id)).toMatchObject({
      state: "active",
      bbAutomationId: "auto_1",
      lastOperationOutcome: "succeeded",
    });
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(repository.getOperation(pending.lastOperationId!)).toMatchObject({ state: "succeeded" });
  });

  it("does not call BB when current capability evidence denies the operation", async () => {
    const { store, repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true, () => false);
    const lease = store.acquireExecutorLease("automation-executor", NOW, 120_000);
    if (!lease.acquired) throw new Error("missing automation executor lease");
    const pending = await service.create({
      ...createInput(),
      authority: versionedOwnerAuthority(),
      deferProvider: true,
      operation: {
        version: 1,
        operationClass: "create",
        targetProjectId: definition.projectId,
        definitionRevision: 1,
      },
      controllerFence: {
        ownerId: "controller-executor",
        generation: 1,
        turnId: "turn_owner",
      },
      mutate: (mutation) => mutation(),
    });
    const reconciler = new ManagedAutomationReconciler({
      repository,
      service,
      store,
      notify: vi.fn(),
    });
    const signal = new AbortController().signal;
    await reconciler.processDue(NOW + 1, signal, {
      ownerId: "automation-executor",
      generation: lease.generation,
      signal,
    });

    expect(fake.create).not.toHaveBeenCalled();
    expect(service.get(pending.id)).toMatchObject({
      state: "failed",
      lastError: "managed_automation_capability_evidence_stale",
    });
    expect(repository.getOperation(pending.lastOperationId!)).toMatchObject({ state: "failed" });
  });

  it("rejects a stale executor settlement and lets the successor reconcile the same operation", async () => {
    const { store, repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const firstLease = store.acquireExecutorLease("automation-executor", NOW, 120_000);
    if (!firstLease.acquired) throw new Error("missing first executor lease");
    const pending = await service.create({
      ...createInput(),
      authority: versionedOwnerAuthority(),
      deferProvider: true,
      operation: {
        version: 1,
        operationClass: "create",
        targetProjectId: definition.projectId,
        definitionRevision: 1,
      },
      controllerFence: {
        ownerId: "controller-executor",
        generation: 1,
        turnId: "turn_owner",
      },
      mutate: (mutation) => mutation(),
    });
    const claimed = repository.claimOperation({
      operationId: pending.lastOperationId!,
      ownerId: "automation-executor",
      generation: firstLease.generation,
      now: NOW + 1,
      leaseMs: 120_000,
    });
    if (!claimed) throw new Error("missing claimed automation operation");
    expect(store.releaseExecutorLease("automation-executor", firstLease.generation, NOW + 2)).toBe(true);

    expect(repository.settleOperation({
      operationId: claimed.id,
      ownerId: "automation-executor",
      generation: firstLease.generation,
      now: NOW + 2,
      outcome: "succeeded",
      automation: managedObservation(automation()),
    })).toBeNull();
    expect(repository.getOperation(claimed.id)).toMatchObject({ state: "leased" });
    expect(service.get(pending.id)).toMatchObject({ state: "pending", bbAutomationId: null });

    const successor = store.acquireExecutorLease("automation-successor", NOW + 120_002, 120_000);
    if (!successor.acquired) throw new Error("missing successor executor lease");
    const reconciler = new ManagedAutomationReconciler({
      repository,
      service,
      store,
      notify: vi.fn(),
    });
    const signal = new AbortController().signal;
    await reconciler.processDue(NOW + 120_002, signal, {
      ownerId: "automation-successor",
      generation: successor.generation,
      signal,
    });

    expect(service.get(pending.id)).toMatchObject({ state: "active", bbAutomationId: "auto_1" });
    expect(repository.getOperation(claimed.id)).toMatchObject({ state: "succeeded" });
    expect(fake.create).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight provider call when the owning executor fence is lost", async () => {
    const { store, repository } = fixture();
    const fake = fakeAdapter();
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    let providerAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      providerAborted = resolve;
    });
    const adapter: ManagedAutomationAdapter = {
      ...fake.adapter,
      create: vi.fn(async ({ signal }) => {
        providerStarted();
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            providerAborted();
            reject(new Error("provider aborted"));
          }, { once: true });
        });
        throw new Error("provider did not abort");
      }),
    };
    const service = new ManagedAutomationService(repository, adapter, () => true);
    const lease = store.acquireExecutorLease("automation-executor", NOW, 120_000);
    if (!lease.acquired) throw new Error("missing automation executor lease");
    const pending = await service.create({
      ...createInput(),
      authority: versionedOwnerAuthority(),
      deferProvider: true,
      operation: {
        version: 1,
        operationClass: "create",
        targetProjectId: definition.projectId,
        definitionRevision: 1,
      },
      controllerFence: {
        ownerId: "controller-executor",
        generation: 1,
        turnId: "turn_owner",
      },
      mutate: (mutation) => mutation(),
    });
    const reconciler = new ManagedAutomationReconciler({
      repository,
      service,
      store,
      notify: vi.fn(),
    });
    const fenceAbort = new AbortController();
    const run = reconciler.processDue(NOW + 1, undefined, {
      ownerId: "automation-executor",
      generation: lease.generation,
      signal: fenceAbort.signal,
    });
    await started;
    fenceAbort.abort(new Error("executor lease lost"));
    await aborted;
    await run;

    expect(adapter.create).toHaveBeenCalledTimes(1);
    expect(repository.getOperation(pending.lastOperationId!)).toMatchObject({ state: "leased" });
    expect(service.get(pending.id)).toMatchObject({ state: "pending", bbAutomationId: null });
  });

  it("restarts by reconciling the same durable BB id without creating a duplicate", async () => {
    const { repository } = fixture();
    const fake = fakeAdapter();
    const firstService = new ManagedAutomationService(repository, fake.adapter, () => true);
    const created = await firstService.create(createInput());
    fake.runs.set(created.bbAutomationId!, [runEvidence({ automationId: created.bbAutomationId! })]);

    const restartedService = new ManagedAutomationService(repository, fake.adapter, () => true);
    const reconciled = await restartedService.create({ ...createInput(), now: NOW + 100 });

    expect(reconciled.id).toBe(created.id);
    expect(reconciled.bbAutomationId).toBe(created.bbAutomationId);
    expect(reconciled.lastRunId).toBe("run_1");
    expect(fake.create).toHaveBeenCalledTimes(1);
  });

  it("keeps run evidence append-only and de-duplicates a repeated observation", async () => {
    const { bb, repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const binding = await service.create(createInput());
    const run = runEvidence({ automationId: binding.bbAutomationId! });

    expect(repository.recordRun(binding.id, run, NOW + 1)).toBe(true);
    expect(repository.recordRun(binding.id, run, NOW + 2)).toBe(false);
    expect(() => bb.storage.database().prepare(
      "UPDATE managed_automation_run_evidence SET status = 'failed' WHERE bb_run_id = 'run_1'",
    ).run()).toThrow("append-only");
  });

  it("screens worker output and errors before durable evidence or controller handoff", async () => {
    const { bb, repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const binding = await service.create(createInput());
    const privateOutput = "deployment token: telegram-worker-output-secret";
    const privateError = "provider rejected telegram-worker-error-secret";

    expect(repository.recordRun(binding.id, runEvidence({
      automationId: binding.bbAutomationId!,
      status: "failed",
      output: privateOutput,
      error: privateError,
    }), NOW + 1)).toBe(true);

    const persisted = JSON.stringify(bb.storage.database().prepare(
      `SELECT evidence_json FROM managed_automation_run_evidence WHERE bb_run_id = 'run_1'`,
    ).get());
    const handoff = JSON.stringify(bb.storage.database().prepare(
      `SELECT input_text FROM managed_automation_notifications WHERE bb_run_id = 'run_1'`,
    ).get());
    expect(persisted).not.toContain(privateOutput);
    expect(persisted).not.toContain(privateError);
    expect(handoff).not.toContain(privateOutput);
    expect(handoff).not.toContain(privateError);
    expect(`${persisted}\n${handoff}`).toContain("bb_automation_run_failed");
  });

  it("fails closed when an agent result exceeds its declared result contract", async () => {
    const { bb, repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const binding = await service.create(createInput());

    repository.recordRun(binding.id, runEvidence({
      automationId: binding.bbAutomationId!,
      output: "x".repeat(definition.resultContract.maximumBytes + 1),
    }), NOW + 1);

    expect(bb.storage.database().prepare(
      `SELECT error_class, evidence_json FROM managed_automation_run_evidence WHERE bb_run_id = 'run_1'`,
    ).get()).toMatchObject({
      error_class: "bb_automation_result_contract_violated",
      evidence_json: expect.stringContaining('"contractOutcome":"violated"'),
    });
    expect(bb.storage.database().prepare(
      `SELECT input_text FROM managed_automation_notifications WHERE bb_run_id = 'run_1'`,
    ).get()).toMatchObject({
      input_text: expect.stringContaining("Result contract: violated"),
    });
  });

  it("persists retirement intent before deleting and reconciles an interrupted retirement", async () => {
    const { repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const binding = await service.create(createInput());
    let mutationCount = 0;

    await expect(service.retire({
      id: binding.id,
      scope: SCOPE,
      now: NOW + 1,
      mutate: (mutation) => {
        mutationCount += 1;
        if (mutationCount === 2) throw new Error("controller fence was lost");
        return mutation();
      },
    })).rejects.toThrow("controller fence was lost");

    const interrupted = service.get(binding.id)!;
    expect(interrupted.state).toBe("retiring");
    await service.reconcile({ binding: interrupted, scope: SCOPE, now: NOW + 2 });
    expect(service.get(binding.id)?.state).toBe("retired");
    expect(fake.adapter.delete).toHaveBeenCalledTimes(2);
  });

  it("reconciles an interrupted governed definition update from durable intent", async () => {
    const { repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const binding = await service.create(createInput());
    const updatedDefinition: BbAutomationDefinition = {
      ...definition,
      name: "Twice-daily release health",
      trigger: { kind: "cron", cron: "0 8,20 * * *", timezone: "Etc/UTC" },
    };
    let mutationCount = 0;

    await expect(service.update({
      id: binding.id,
      scope: SCOPE,
      definition: updatedDefinition,
      now: NOW + 1,
      mutate: (mutation) => {
        mutationCount += 1;
        if (mutationCount === 2) throw new Error("controller fence was lost");
        return mutation();
      },
    })).rejects.toThrow("controller fence was lost");

    const interrupted = service.get(binding.id)!;
    expect(interrupted).toMatchObject({ state: "updating", name: updatedDefinition.name });
    await service.reconcile({ binding: interrupted, scope: SCOPE, now: NOW + 2 });
    expect(service.get(binding.id)).toMatchObject({ state: "active", name: updatedDefinition.name });
    expect(fake.adapter.update).toHaveBeenCalledTimes(2);
  });

  it("records running and terminal states once, then hands the terminal result to the controller exactly once", async () => {
    const { bb, store, repository } = fixture();
    store.createPairingCode(hashSecret("pair-automation"), NOW - 1_000, NOW + 10_000);
    expect(store.pairOwnerWithPrivateChatCode(
      hashSecret("pair-automation"),
      "7",
      "70",
      NOW - 500,
    )).toEqual({ ok: true });
    store.enqueueControllerTurn({
      controllerKey: "owner-7-controller",
      telegramUserId: "7",
      telegramChatId: "70",
      updateId: 1,
      inputText: "Create the controller fixture.",
      now: NOW - 400,
    });
    store.upsertProjectPolicy(policyFixture({ projectId: "proj_owner", alias: "owner" }), NOW - 300);
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const binding = await service.create(createInput());
    fake.runs.set(binding.bbAutomationId!, [
      runEvidence({ automationId: binding.bbAutomationId!, status: "running", finishedAt: null, output: null }),
    ]);
    const reconciler = new ManagedAutomationReconciler({
      repository,
      service,
      store,
      notify: vi.fn(),
    });

    await reconciler.processDue(NOW + 60_001);
    fake.runs.set(binding.bbAutomationId!, [
      runEvidence({ automationId: binding.bbAutomationId!, status: "succeeded" }),
    ]);
    await reconciler.processDue(NOW + 120_002);
    await reconciler.processDue(NOW + 180_003);

    expect(bb.storage.database().prepare(
      "SELECT status FROM managed_automation_run_evidence WHERE bb_run_id = 'run_1' ORDER BY sequence",
    ).all()).toEqual([{ status: "running" }, { status: "succeeded" }]);
    expect(store.listControllerTurns("owner-7-controller", 10).filter((turn) => turn.origin === "system"))
      .toMatchObject([{
      origin: "system",
      inputText: expect.stringContaining("A BB Automation run finished"),
      }]);
    expect(bb.storage.database().prepare(
      "SELECT state FROM managed_automation_notifications WHERE bb_run_id = 'run_1'",
    ).all()).toEqual([{ state: "enqueued" }]);
  });

  it("pauses a scheduled agent before reading runs when its stored authority is no longer current", async () => {
    const { store, repository } = fixture();
    store.createPairingCode(hashSecret("pair-policy-gate"), NOW - 1_000, NOW + 10_000);
    expect(store.pairOwnerWithPrivateChatCode(
      hashSecret("pair-policy-gate"),
      "7",
      "70",
      NOW - 500,
    )).toEqual({ ok: true });
    store.enqueueControllerTurn({
      controllerKey: "owner-7-controller",
      telegramUserId: "7",
      telegramChatId: "70",
      updateId: 1,
      inputText: "Create the controller fixture.",
      now: NOW - 400,
    });
    store.upsertProjectPolicy(policyFixture({
      projectId: "proj_owner",
      alias: "owner",
      enabled: false,
    }), NOW - 300);
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const binding = await service.create(createInput());
    fake.runs.set(binding.bbAutomationId!, [runEvidence({ automationId: binding.bbAutomationId! })]);
    const reconciler = new ManagedAutomationReconciler({
      repository,
      service,
      store,
      notify: vi.fn(),
    });

    await reconciler.processDue(NOW + 60_001);

    expect(fake.adapter.setEnabled).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(fake.adapter.runs).not.toHaveBeenCalled();
    expect(service.get(binding.id)).toMatchObject({
      state: "paused",
      lastError: "managed_automation_authority_stale",
    });
  });

  it("pauses an existing agent schedule before reading runs when BB cannot enforce its execution contract", async () => {
    const { repository } = fixture();
    const fake = fakeAdapter();
    const supportedService = new ManagedAutomationService(repository, fake.adapter, () => true);
    const binding = await supportedService.create(createInput());
    fake.runs.set(binding.bbAutomationId!, [runEvidence({ automationId: binding.bbAutomationId! })]);
    const service = new ManagedAutomationService(repository, {
      ...fake.adapter,
      agentAutomationCapabilities: {
        executionTimeout: false,
        resultContract: false,
        preRunAuthority: false,
      },
    }, () => true);

    await service.reconcile({ binding, scope: SCOPE, now: NOW + 1 });

    expect(fake.adapter.setEnabled).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(fake.adapter.runs).not.toHaveBeenCalled();
    expect(service.get(binding.id)).toMatchObject({
      state: "paused",
      lastError: "bb_agent_execution_contract_unsupported",
    });
  });

  it("refuses resume, update, and manual execution when an agent contract is unsupported", async () => {
    const { repository } = fixture();
    const fake = fakeAdapter();
    const supportedService = new ManagedAutomationService(repository, fake.adapter, () => true);
    const binding = await supportedService.create(createInput());
    const adapter: ManagedAutomationAdapter = {
      ...fake.adapter,
      agentAutomationCapabilities: {
        executionTimeout: false,
        resultContract: false,
        preRunAuthority: false,
      },
    };
    const service = new ManagedAutomationService(repository, adapter, () => true);
    vi.mocked(fake.adapter.setEnabled).mockClear();
    vi.mocked(fake.adapter.update).mockClear();
    vi.mocked(fake.adapter.runNow).mockClear();

    await expect(service.setEnabled({ id: binding.id, scope: SCOPE, enabled: true, now: NOW + 1 }))
      .rejects.toBeInstanceOf(ManagedAgentExecutionContractUnsupportedError);
    await expect(service.update({
      id: binding.id,
      scope: SCOPE,
      definition: { ...definition, prompt: "Updated prompt" },
      now: NOW + 1,
    })).rejects.toBeInstanceOf(ManagedAgentExecutionContractUnsupportedError);
    await expect(service.runNow({
      id: binding.id,
      scope: SCOPE,
      idempotencyKey: "manual-unsupported",
      now: NOW + 1,
    })).rejects.toBeInstanceOf(ManagedAgentExecutionContractUnsupportedError);

    expect(fake.adapter.setEnabled).not.toHaveBeenCalled();
    expect(fake.adapter.update).not.toHaveBeenCalled();
    expect(fake.adapter.runNow).not.toHaveBeenCalled();
  });

  it("does not create a scheduled agent when its current authority preflight fails", async () => {
    const { repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => false);

    await expect(service.create(createInput())).rejects.toThrow("authority is not current");

    expect(fake.create).not.toHaveBeenCalled();
    expect(service.list("owner-7-controller")).toMatchObject([{
      state: "failed",
      lastError: "managed_automation_authority_stale",
    }]);
  });

  it("turns on BB first, reads it back, and only then disables the legacy clock", async () => {
    const { store, repository } = fixture();
    const monitor = store.createMonitor({
      controllerKey: "owner-7-controller",
      kind: "schedule",
      cron: "0 8 * * *",
      instruction: definition.prompt,
      dueAt: NOW + 60_000,
      now: NOW,
    });
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);

    const binding = await migrateLegacyClockMonitor({
      monitor,
      store,
      service,
      scope: SCOPE,
      projectId: "proj_owner",
      controllerKey: "owner-7-controller",
      providerId: "codex-provider",
      model: "gpt-5.6-sol",
      permissionMode: "full",
      now: NOW,
    });

    expect(binding.state).toBe("active");
    expect(store.listMonitors("owner-7-controller", true)).toMatchObject([{ id: monitor.id, state: "cancelled" }]);
    expect(fake.create).toHaveBeenCalledTimes(1);
  });

  it("leaves the legacy clock armed when BB creation or read-back fails", async () => {
    const { store, repository } = fixture();
    const monitor = store.createMonitor({
      controllerKey: "owner-7-controller",
      kind: "schedule",
      cron: "0 8 * * *",
      instruction: definition.prompt,
      dueAt: NOW + 60_000,
      now: NOW,
    });
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, {
      ...fake.adapter,
      create: vi.fn(async () => { throw new Error("BB read-back mismatch"); }),
    }, () => true);

    await expect(migrateLegacyClockMonitor({
      monitor,
      store,
      service,
      scope: SCOPE,
      projectId: "proj_owner",
      controllerKey: "owner-7-controller",
      providerId: "codex-provider",
      model: "gpt-5.6-sol",
      permissionMode: "full",
      now: NOW,
    })).rejects.toThrow("read-back mismatch");

    expect(store.listArmedMonitors(10)).toMatchObject([{ id: monitor.id, state: "armed" }]);
  });

  it("pauses BB if the local disable fence is lost, so two schedulers cannot stay active", async () => {
    const { repository } = fixture();
    const fake = fakeAdapter();
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const monitor: MonitorRecord = {
      id: "mon_legacy",
      controllerKey: "owner-7-controller",
      kind: "schedule",
      threadId: null,
      cron: "0 8 * * *",
      instruction: definition.prompt,
      state: "armed",
      systemKey: null,
      dueAt: NOW + 60_000,
      fireCount: 0,
      lastFiredAt: null,
      lastError: null,
      stallNotifiedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };

    await expect(migrateLegacyClockMonitor({
      monitor,
      store: { cancelMonitor: () => false },
      service,
      scope: SCOPE,
      projectId: "proj_owner",
      controllerKey: "owner-7-controller",
      providerId: "codex-provider",
      model: "gpt-5.6-sol",
      permissionMode: "full",
      now: NOW,
    })).rejects.toThrow("could not be disabled");

    expect(fake.adapter.setEnabled).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(service.list("owner-7-controller")).toMatchObject([{ state: "paused" }]);
  });
});
