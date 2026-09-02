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
  ManagedAutomationService,
  managedAutomationAuthorityIsCurrent,
  migrateLegacyClockMonitor,
  type ManagedAutomationAdapter,
} from "../src/services/managed-automation-service";
import { ManagedAutomationRepository } from "../src/storage/managed-automation-repository";
import { openStore, type MonitorRecord, type TelegramAgentStore } from "../src/storage/store";
import { runJobExecutorService } from "../src/services/job-executor-service";
import { hashSecret } from "../src/crypto";
import { registerControllerTools } from "../src/controller/tools";
import { policyFixture } from "./helpers";
import { submittedControllerFixture } from "./support/controller-trust-fixtures";
import type {
  ManagedAutomationCreateReceipt,
  ManagedAutomationObservation,
  ManagedAutomationProviderIdentity,
} from "../src/domain/managed-automation";
import { createFakeBbAutomationAdapter, observedBbAutomation } from "./support/fake-bb-automation-adapter";

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

function fakeAdapter() {
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
    runNow: vi.fn(async ({ automationId }) => runEvidence({ automationId, trigger: "manual" })),
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

/** A paired owner whose controller row exists, so the reconciler has a current controller key. */
function pairOwner(
  store: TelegramAgentStore,
  options: { projectEnabled?: boolean; repositoryPolicy?: boolean; controllerProjectId?: string } = {},
) {
  store.createPairingCode(hashSecret("pair-automation"), NOW - 1_000, NOW + 10_000);
  expect(store.pairOwnerWithPrivateChatCode(hashSecret("pair-automation"), "7", "70", NOW - 500)).toEqual({ ok: true });
  store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "70",
    updateId: 1,
    inputText: "Create the controller fixture.",
    now: NOW - 400,
  });
  if (options.controllerProjectId) {
    // The controller's project and host are recorded when its thread spawns.
    const lease = store.acquireExecutorLease("executor", NOW - 350, 30_000);
    if (!lease.acquired) throw new Error("missing executor lease");
    const turn = store.claimNextControllerTurn({ ownerId: "executor", generation: lease.generation, now: NOW + 2_650 });
    if (!turn) throw new Error("missing controller turn");
    expect(store.markControllerSpawned({
      turnId: turn.id,
      ownerId: "executor",
      generation: lease.generation,
      now: NOW - 350,
      projectId: options.controllerProjectId,
      hostId: "host_owner",
      threadId: "thr_controller",
    })).toBe(true);
    expect(store.releaseExecutorLease("executor", lease.generation, NOW - 350)).toBe(true);
  }
  if (options.repositoryPolicy !== false) {
    store.upsertProjectPolicy(policyFixture({
      projectId: "proj_owner",
      alias: "owner",
      enabled: options.projectEnabled ?? true,
    }), NOW - 300);
  }
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
  // BB natively enforces neither the wall-clock timeout, the result bound, nor
  // pre-run authority, and Hanoon enforces all three itself around each run.
  // An agent schedule is therefore never refused before BB is asked: refusing
  // here left the owner with no schedule at all, upkeep included.
  it("asks BB for an agent schedule even though BB enforces none of the contract itself", async () => {
    const { repository } = fixture();
    const run = vi.fn(async () => ({ outcome: "exited" as const, exitCode: 1, output: "boom" }));
    const service = new ManagedAutomationService(
      repository,
      new TerminalBbAutomationAdapter({ run }),
      () => true,
    );

    await expect(service.create(createInput())).rejects.toThrow();

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      command: expect.stringContaining("bb automation create"),
    });
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
    const providerCreate = vi.spyOn(fake.adapter, "create").mockImplementation(async (
      input: Parameters<ManagedAutomationAdapter["create"]>[0],
    ) => {
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
    const fake = createFakeBbAutomationAdapter(NOW);
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

  // BB's create has no idempotency key, so a create it acknowledged is never
  // compensated away: the binding keeps BB's id and the ownership marker, and
  // reconciliation finishes the read-back rather than asking for a second
  // schedule. A retried operation finds the marked automation instead.
  it("keeps a schedule BB acknowledged but could not read back, then reconciles it", async () => {
    const { repository } = fixture();
    const fake = createFakeBbAutomationAdapter(NOW);
    vi.mocked(fake.adapter.show).mockRejectedValueOnce(new Error("BB read timed out"));
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);

    await expect(service.create(createInput())).rejects.toThrow("timed out");

    // The schedule BB created is still there and still Hanoon's, recorded
    // rather than hidden or deleted.
    expect(fake.automations.size).toBe(1);
    const failed = service.get(service.list("owner-7-controller")[0]!.id)!;
    expect(failed).toMatchObject({
      state: "failed",
      lastError: "bb_automation_provider_readback_failed",
      bbAutomationId: "auto_1",
    });
    expect(fake.adapter.delete).not.toHaveBeenCalled();
    expect(repository.listReconciliationCandidates(NOW + 1)).toMatchObject([{ id: failed.id }]);

    await service.reconcile({ binding: failed, scope: SCOPE, now: NOW + 2 });

    expect(service.get(failed.id)).toMatchObject({ state: "active", bbAutomationId: "auto_1" });
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect(fake.automations.size).toBe(1);
  });

  it("keeps BB's id when the read-back shows a different schedule, so reconciliation retries it", async () => {
    const { repository } = fixture();
    const fake = createFakeBbAutomationAdapter(NOW);
    vi.mocked(fake.adapter.show).mockRejectedValueOnce(new Error("BB automation schedule did not reconcile"));
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);

    await expect(service.create(createInput())).rejects.toThrow("schedule did not reconcile");

    const failed = service.get(service.list("owner-7-controller")[0]!.id)!;
    expect(failed).toMatchObject({ state: "failed", bbAutomationId: "auto_1" });
    expect(repository.listReconciliationCandidates(NOW + 1)).toMatchObject([{ id: failed.id }]);

    await service.reconcile({ binding: failed, scope: SCOPE, now: NOW + 2 });

    expect(service.get(failed.id)).toMatchObject({ state: "active", bbAutomationId: "auto_1" });
    expect(fake.create).toHaveBeenCalledTimes(1);
  });

  it("keeps run evidence append-only and de-duplicates a repeated observation", async () => {
    const { bb, repository } = fixture();
    const fake = createFakeBbAutomationAdapter(NOW);
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
    const fake = createFakeBbAutomationAdapter(NOW);
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
    const fake = createFakeBbAutomationAdapter(NOW);
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

  it("classifies a run that outlived its declared timeout instead of claiming BB stopped it", async () => {
    const { bb, repository } = fixture();
    const fake = createFakeBbAutomationAdapter(NOW);
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const binding = await service.create(createInput());

    repository.recordRun(binding.id, runEvidence({
      automationId: binding.bbAutomationId!,
      startedAt: NOW,
      finishedAt: NOW + definition.timeoutMs + 1,
    }), NOW + definition.timeoutMs + 2);

    expect(bb.storage.database().prepare(
      `SELECT error_class FROM managed_automation_run_evidence WHERE bb_run_id = 'run_1'`,
    ).get()).toEqual({ error_class: "bb_automation_timeout_contract_violated" });
  });

  it("persists retirement intent before deleting and reconciles an interrupted retirement", async () => {
    const { repository } = fixture();
    const fake = createFakeBbAutomationAdapter(NOW);
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

  it("re-arms a retired source when it is created again, instead of rejecting the source forever", async () => {
    // Self-maintenance toggled off retires the upkeep bindings; toggled back
    // on, the same source keys must be installable again.
    const { repository } = fixture();
    const fake = createFakeBbAutomationAdapter(NOW);
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    const binding = await service.create(createInput());
    await service.retire({ id: binding.id, scope: SCOPE, now: NOW + 1 });
    expect(service.get(binding.id)?.state).toBe("retired");

    const rearmed = await service.create({ ...createInput(), now: NOW + 2 });

    expect(rearmed).toMatchObject({ id: binding.id, state: "active" });
    expect(rearmed.bbAutomationId).not.toBeNull();
    expect(fake.create).toHaveBeenCalledTimes(2);
  });

  it("redefines a failed source that never reached BB instead of rejecting it forever", async () => {
    const { repository } = fixture();
    const fake = createFakeBbAutomationAdapter(NOW);
    fake.create.mockRejectedValueOnce(new Error("BB unavailable"));
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    await expect(service.create(createInput())).rejects.toThrow("BB unavailable");
    const failed = service.list("owner-7-controller")[0]!;
    expect(failed).toMatchObject({ state: "failed", bbAutomationId: null });

    const renamed = await service.create({
      ...createInput(),
      definition: { ...definition, name: "Daily release health (renamed)" },
      now: NOW + 1,
    });

    expect(renamed).toMatchObject({ id: failed.id, state: "active", name: "Daily release health (renamed)" });
    // A binding that does hold a BB automation keeps its definition.
    await expect(service.create({
      ...createInput(),
      definition: { ...definition, name: "Daily release health (again)" },
      now: NOW + 2,
    })).rejects.toThrow("different durable definition");
  });

  it("reconciles an interrupted governed definition update from durable intent", async () => {
    const { repository } = fixture();
    const fake = createFakeBbAutomationAdapter(NOW);
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
    pairOwner(store);
    const fake = createFakeBbAutomationAdapter(NOW);
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
    pairOwner(store, { projectEnabled: false });
    const fake = createFakeBbAutomationAdapter(NOW);
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

  it("treats the controller's own project as authorized without a repository policy", async () => {
    // Production, 2026-09-02: the controller runs in BB's personal project,
    // which never has a Hanoon repository policy, so every upkeep schedule
    // failed its authority preflight before BB was ever asked.
    const { store, repository } = fixture();
    pairOwner(store, { repositoryPolicy: false, controllerProjectId: "proj_owner" });
    const controller = store.getControllerForOwner("7", "70");
    expect(controller?.projectId).toBe("proj_owner");
    const authorityIsCurrent = (binding: Parameters<typeof managedAutomationAuthorityIsCurrent>[0]) =>
      managedAutomationAuthorityIsCurrent(
        binding,
        store.getControllerForOwner("7", "70"),
        store.getProjectPolicy(binding.projectId)?.policy.enabled === true,
      );
    const fake = createFakeBbAutomationAdapter(NOW);
    const service = new ManagedAutomationService(repository, fake.adapter, authorityIsCurrent);

    const binding = await service.create(createInput());
    expect(binding.state).toBe("active");
    fake.runs.set(binding.bbAutomationId!, [runEvidence({ automationId: binding.bbAutomationId! })]);
    const reconciler = new ManagedAutomationReconciler({ repository, service, store, notify: vi.fn() });
    await reconciler.processDue(NOW + 60_001);

    expect(fake.adapter.setEnabled).not.toHaveBeenCalled();
    expect(service.get(binding.id)).toMatchObject({ state: "active", lastRunId: "run_1" });
    // A schedule in any other project still needs an enabled repository policy.
    expect(managedAutomationAuthorityIsCurrent(
      { ...binding, projectId: "proj_other", authority: { ...binding.authority, projectId: "proj_other" } },
      controller,
      false,
    )).toBe(false);
  });

  it("finishes an interrupted legacy handover on the next sweep, so one task never fires through two schedulers", async () => {
    const { store, repository } = fixture();
    pairOwner(store);
    const legacy = store.createMonitor({
      controllerKey: "owner-7-controller",
      kind: "schedule",
      cron: definition.trigger.kind === "cron" ? definition.trigger.cron : "0 8 * * *",
      instruction: definition.prompt,
      dueAt: NOW + 60_000,
      now: NOW,
    });
    const fake = createFakeBbAutomationAdapter(NOW);
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);
    // BB has read the schedule back and the binding is active, but the process
    // died before the local clock row was cancelled.
    const binding = await service.create({ ...createInput(), legacyMonitorId: legacy.id });
    expect(binding.state).toBe("active");
    expect(store.listArmedMonitors(10)).toMatchObject([{ id: legacy.id, state: "armed" }]);
    const reconciler = new ManagedAutomationReconciler({
      repository,
      service,
      store,
      notify: vi.fn(),
    });

    await reconciler.processDue(NOW + 60_001);

    expect(store.listMonitors("owner-7-controller", true)).toMatchObject([{ id: legacy.id, state: "cancelled" }]);
    expect(service.get(binding.id)?.state).toBe("active");
  });

  it("does not create a scheduled agent when its current authority preflight fails", async () => {
    const { repository } = fixture();
    const fake = createFakeBbAutomationAdapter(NOW);
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
    const fake = createFakeBbAutomationAdapter(NOW);
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
    const fake = createFakeBbAutomationAdapter(NOW);
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
    const fake = createFakeBbAutomationAdapter(NOW);
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
