import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import type {
  BbAutomation,
  BbAutomationDefinition,
  BbAutomationRun,
} from "../src/bb/automation";
import {
  ManagedAutomationReconciler,
  ManagedAutomationService,
  migrateLegacyClockMonitor,
  type ManagedAutomationAdapter,
} from "../src/services/managed-automation-service";
import { ManagedAutomationRepository } from "../src/storage/managed-automation-repository";
import { openStore, type MonitorRecord } from "../src/storage/store";
import { hashSecret } from "../src/crypto";
import { policyFixture } from "./helpers";

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
    delete: vi.fn(async ({ automationId }) => { automations.delete(automationId); }),
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

describe("managed BB automations", () => {
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
