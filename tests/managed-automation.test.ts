import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import type {
  BbAutomation,
  BbAutomationDefinition,
  BbAutomationRun,
} from "../src/bb/automation";
import { BbAutomationNotFoundError, TerminalBbAutomationAdapter } from "../src/bb/automation";
import {
  ManagedAutomationReconciler,
  ManagedAgentExecutionContractUnsupportedError,
  ManagedAutomationService,
  migrateLegacyClockMonitor,
  type ManagedAutomationAdapter,
} from "../src/services/managed-automation-service";
import { ManagedAutomationRepository } from "../src/storage/managed-automation-repository";
import { openStore, type MonitorRecord } from "../src/storage/store";
import { hashSecret } from "../src/crypto";
import { registerControllerTools } from "../src/controller/tools";
import { policyFixture } from "./helpers";
import { submittedControllerFixture } from "./support/controller-trust-fixtures";

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
  const create = vi.fn(async ({ definition: value }: { definition: BbAutomationDefinition }) => {
    const created = automation(value, { id: `auto_${automations.size + 1}` });
    automations.set(created.id, created);
    return created;
  });
  const adapter: ManagedAutomationAdapter = {
    agentAutomationCapabilities: {
      executionTimeout: true,
      resultContract: true,
      preRunAuthority: true,
    },
    create,
    update: vi.fn(async ({ automationId, definition: value }) => {
      const found = automations.get(automationId);
      if (!found) throw new Error("missing automation");
      const updated = automation(value, {
        id: automationId,
        enabled: found.enabled,
        createdAt: found.createdAt,
        updatedAt: NOW + 1,
      });
      automations.set(automationId, updated);
      return updated;
    }),
    show: vi.fn(async ({ automationId }) => {
      const found = automations.get(automationId);
      if (!found) throw new Error("missing automation");
      return found;
    }),
    setEnabled: vi.fn(async ({ automationId, enabled }) => {
      const found = automations.get(automationId);
      if (!found) throw new Error("missing automation");
      const updated = { ...found, enabled, nextRunAt: enabled ? NOW + 60_000 : null };
      automations.set(automationId, updated);
      return updated;
    }),
    runNow: vi.fn(async ({ automationId }) => runEvidence({ automationId, trigger: "manual" })),
    runs: vi.fn(async ({ automationId }) => runs.get(automationId) ?? []),
    delete: vi.fn(async ({ automationId }) => {
      if (!automations.delete(automationId)) throw new BbAutomationNotFoundError();
    }),
    findByDefinition: vi.fn(async ({ definition: requested }) => [...automations.values()].find((candidate) => {
      const expected = automation(requested, { id: candidate.id });
      return candidate.projectId === expected.projectId &&
        candidate.name === expected.name &&
        JSON.stringify(candidate.trigger) === JSON.stringify(expected.trigger) &&
        JSON.stringify(candidate.execution) === JSON.stringify(expected.execution);
    }) ?? null),
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
      automation: automation(),
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
