import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import type { BbAutomationDefinition, BbAutomationRun } from "../src/bb/automation";
import {
  ManagedAutomationReconciler,
  ManagedAutomationService,
  managedAutomationAuthorityIsCurrent,
  migrateLegacyClockMonitor,
} from "../src/services/managed-automation-service";
import { ManagedAutomationRepository } from "../src/storage/managed-automation-repository";
import { openStore, type MonitorRecord, type TelegramAgentStore } from "../src/storage/store";
import { hashSecret } from "../src/crypto";
import { policyFixture } from "./helpers";
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

describe("managed BB automations", () => {
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

  it("adopts an automation already carrying the binding's name instead of asking BB for a second one", async () => {
    // BB's create has no idempotency key. If the acknowledgement never reached
    // Hanoon, the schedule still exists under the deterministic name.
    const { repository } = fixture();
    const fake = createFakeBbAutomationAdapter(NOW);
    const orphan = observedBbAutomation(definition, NOW, { id: "auto_orphan" });
    fake.automations.set(orphan.id, orphan);
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);

    const binding = await service.create(createInput());

    expect(binding).toMatchObject({ state: "active", bbAutomationId: "auto_orphan" });
    expect(fake.create).not.toHaveBeenCalled();
    expect(fake.automations.size).toBe(1);
  });

  it("refuses to adopt a same-named automation whose definition differs and leaves it untouched", async () => {
    const { repository } = fixture();
    const fake = createFakeBbAutomationAdapter(NOW);
    const stranger = observedBbAutomation(definition, NOW, {
      id: "auto_stranger",
      trigger: { triggerType: "schedule", cron: "*/5 * * * *", timezone: "Etc/UTC" },
    });
    fake.automations.set(stranger.id, stranger);
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);

    await expect(service.create(createInput())).rejects.toThrow("schedule did not reconcile");

    expect(fake.create).not.toHaveBeenCalled();
    expect(fake.adapter.delete).not.toHaveBeenCalled();
    expect(fake.automations.get("auto_stranger")).toEqual(stranger);
    expect(service.list("owner-7-controller")).toMatchObject([{
      state: "failed",
      lastError: "bb_automation_name_conflict",
      bbAutomationId: "auto_stranger",
    }]);
  });

  it("removes a schedule BB cannot read back exactly and starts clean on the next create", async () => {
    const { repository } = fixture();
    const fake = createFakeBbAutomationAdapter(NOW);
    vi.mocked(fake.adapter.show).mockRejectedValueOnce(new Error("BB read timed out"));
    const service = new ManagedAutomationService(repository, fake.adapter, () => true);

    await expect(service.create(createInput())).rejects.toThrow("timed out");

    // No hidden schedule survives an unverified create, and the binding no
    // longer points at the deleted id.
    expect(fake.automations.size).toBe(0);
    expect(service.list("owner-7-controller")).toMatchObject([{
      state: "failed",
      lastError: "bb_automation_timeout",
      bbAutomationId: null,
    }]);

    const retried = await service.create({ ...createInput(), now: NOW + 1 });

    expect(retried).toMatchObject({ state: "active", bbAutomationId: "auto_1" });
    expect(fake.create).toHaveBeenCalledTimes(2);
    expect(fake.automations.size).toBe(1);
  });

  it("keeps BB's id when a mismatched schedule cannot be deleted, so reconciliation retries the read-back", async () => {
    const { repository } = fixture();
    const fake = createFakeBbAutomationAdapter(NOW);
    vi.mocked(fake.adapter.show).mockResolvedValueOnce(observedBbAutomation(definition, NOW, {
      trigger: { triggerType: "schedule", cron: "0 9 * * *", timezone: "Etc/UTC" },
    }));
    vi.mocked(fake.adapter.delete).mockRejectedValueOnce(new Error("Permission denied"));
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
