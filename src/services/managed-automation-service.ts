import type { TerminalScope } from "../bb/terminal-command";
import {
  assertAutomationMatches,
  type BbAutomation,
  type BbAutomationDefinition,
  type BbAutomationRun,
  type BbAutomationTarget,
} from "../bb/automation";
import type { MonitorRecord, TelegramAgentStore } from "../storage/store";
import {
  ManagedAutomationRepository,
  type ManagedAutomationBinding,
} from "../storage/managed-automation-repository";

export type ManagedAutomationAdapter = Readonly<{
  create(input: {
    scope: TerminalScope;
    definition: BbAutomationDefinition;
    signal?: AbortSignal;
  }): Promise<BbAutomation>;
  show(input: {
    scope: TerminalScope;
    projectId: string;
    automationId: string;
    signal?: AbortSignal;
  }): Promise<BbAutomation>;
  setEnabled(input: {
    scope: TerminalScope;
    projectId: string;
    automationId: string;
    enabled: boolean;
    signal?: AbortSignal;
  }): Promise<BbAutomation>;
  runNow(input: {
    scope: TerminalScope;
    projectId: string;
    automationId: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<BbAutomationRun>;
  runs(input: {
    scope: TerminalScope;
    projectId: string;
    automationId: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<readonly BbAutomationRun[]>;
  delete(input: {
    scope: TerminalScope;
    projectId: string;
    automationId: string;
    signal?: AbortSignal;
  }): Promise<void>;
}>;

export type CreateManagedAutomationInput = Readonly<{
  scope: TerminalScope;
  controllerKey: string;
  sourceKey: string;
  definition: BbAutomationDefinition;
  authority: Readonly<Record<string, unknown>>;
  notificationPolicy: "material" | "always" | "silent";
  legacyMonitorId?: string | null;
  now: number;
  mutate?: ManagedAutomationMutation;
  signal?: AbortSignal;
}>;

export type ManagedAutomationMutation = <T>(mutation: () => T) => T;

function applyMutation<T>(mutate: ManagedAutomationMutation | undefined, mutation: () => T): T {
  return mutate ? mutate(mutation) : mutation();
}

export class ManagedAutomationService {
  public constructor(
    private readonly repository: ManagedAutomationRepository,
    private readonly adapter: ManagedAutomationAdapter,
  ) {}

  public get(id: string): ManagedAutomationBinding | null {
    return this.repository.get(id);
  }

  public list(controllerKey: string, includeRetired = false): ManagedAutomationBinding[] {
    return this.repository.list(controllerKey, includeRetired);
  }

  public async create(input: CreateManagedAutomationInput): Promise<ManagedAutomationBinding> {
    const reserved = applyMutation(input.mutate, () => this.repository.reserve({
      controllerKey: input.controllerKey,
      sourceKey: input.sourceKey,
      projectId: input.definition.projectId,
      name: input.definition.name,
      definition: input.definition,
      authority: input.authority,
      notificationPolicy: input.notificationPolicy,
      legacyMonitorId: input.legacyMonitorId ?? null,
      now: input.now,
    }));
    if (reserved.bbAutomationId !== null) {
      return this.reconcile({
        binding: reserved,
        scope: input.scope,
        now: input.now,
        mutate: input.mutate,
        signal: input.signal,
      });
    }
    let automation: BbAutomation | null = null;
    try {
      automation = await this.adapter.create({
        scope: input.scope,
        definition: input.definition,
        signal: input.signal,
      });
      return applyMutation(input.mutate, () => this.repository.activate({
        id: reserved.id,
        automation: automation!,
        now: input.now,
      }));
    } catch (error) {
      if (automation !== null) {
        try {
          await this.adapter.delete({
            scope: input.scope,
            projectId: input.definition.projectId,
            automationId: automation.id,
            signal: input.signal,
          });
        } catch {
          // The durable binding remains pending/failed and cannot be reported
          // as active. A later reconciliation must resolve this closed state.
        }
      }
      try {
        applyMutation(input.mutate, () => this.repository.fail(
          reserved.id,
          automationErrorClass(error),
          input.now,
        ));
      } catch {
        // A stale controller fence is the primary failure and must not be
        // bypassed merely to persist an error marker.
      }
      throw error;
    }
  }

  public async reconcile(input: {
    binding: ManagedAutomationBinding;
    scope: TerminalScope;
    now: number;
    mutate?: ManagedAutomationMutation;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationBinding> {
    if (input.binding.bbAutomationId === null) throw new Error("managed automation has no BB automation id");
    try {
      const automation = await this.adapter.show({
        scope: input.scope,
        projectId: input.binding.projectId,
        automationId: input.binding.bbAutomationId,
        signal: input.signal,
      });
      assertAutomationMatches(input.binding.definition, automation, input.binding.state !== "paused");
      const active = applyMutation(input.mutate, () => this.repository.activate({
        id: input.binding.id,
        automation,
        now: input.now,
      }));
      const runs = await this.adapter.runs({
        scope: input.scope,
        projectId: input.binding.projectId,
        automationId: input.binding.bbAutomationId,
        limit: 20,
        signal: input.signal,
      });
      applyMutation(input.mutate, () => {
        for (const run of [...runs].reverse()) this.repository.recordRun(active.id, run, input.now);
      });
      return this.repository.get(active.id)!;
    } catch (error) {
      try {
        applyMutation(input.mutate, () => this.repository.fail(
          input.binding.id,
          automationErrorClass(error),
          input.now,
        ));
      } catch {
        // Preserve a stale authorization fence over a secondary error marker.
      }
      throw error;
    }
  }

  public async setEnabled(input: {
    id: string;
    scope: TerminalScope;
    enabled: boolean;
    now: number;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationBinding> {
    const binding = requireActiveBinding(this.repository, input.id);
    const automation = await this.adapter.setEnabled({
      scope: input.scope,
      projectId: binding.projectId,
      automationId: binding.bbAutomationId!,
      enabled: input.enabled,
      signal: input.signal,
    });
    return this.repository.activate({ id: binding.id, automation, now: input.now });
  }

  public async runNow(input: {
    id: string;
    scope: TerminalScope;
    idempotencyKey: string;
    now: number;
    signal?: AbortSignal;
  }): Promise<BbAutomationRun> {
    const binding = requireActiveBinding(this.repository, input.id);
    const run = await this.adapter.runNow({
      scope: input.scope,
      projectId: binding.projectId,
      automationId: binding.bbAutomationId!,
      idempotencyKey: input.idempotencyKey,
      signal: input.signal,
    });
    this.repository.recordRun(binding.id, run, input.now);
    return run;
  }

  public async retire(input: {
    id: string;
    scope: TerminalScope;
    now: number;
    mutate?: ManagedAutomationMutation;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationBinding> {
    const binding = applyMutation(input.mutate, () => requireActiveBinding(this.repository, input.id));
    await this.adapter.delete({
      scope: input.scope,
      projectId: binding.projectId,
      automationId: binding.bbAutomationId!,
      signal: input.signal,
    });
    return applyMutation(input.mutate, () => this.repository.retire(binding.id, input.now));
  }
}

function requireActiveBinding(
  repository: ManagedAutomationRepository,
  id: string,
): ManagedAutomationBinding {
  const binding = repository.get(id);
  if (!binding || binding.bbAutomationId === null || binding.state === "retired") {
    throw new Error("managed automation is unavailable");
  }
  return binding;
}

function automationErrorClass(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("timed out")) return "bb_automation_timeout";
  if (message.includes("aborted")) return "bb_automation_aborted";
  if (message.includes("reconcile")) return "bb_automation_reconciliation_failed";
  return "bb_automation_operation_failed";
}

export async function migrateLegacyClockMonitor(input: {
  monitor: MonitorRecord;
  store: Pick<TelegramAgentStore, "cancelMonitor">;
  service: ManagedAutomationService;
  scope: TerminalScope;
  projectId: string;
  controllerKey: string;
  providerId: string;
  model: string;
  reasoningLevel?: string;
  serviceTier?: "default" | "fast";
  permissionMode: "accept-edits" | "auto" | "full";
  target?: BbAutomationTarget;
  hostId?: string;
  now: number;
  signal?: AbortSignal;
}): Promise<ManagedAutomationBinding> {
  if (input.monitor.kind !== "schedule" || input.monitor.state !== "armed" || !input.monitor.cron) {
    throw new TypeError("only an armed Hanoon clock schedule can migrate");
  }
  const binding = await input.service.create({
    scope: input.scope,
    controllerKey: input.controllerKey,
    sourceKey: input.monitor.systemKey ?? `legacy-monitor:${input.monitor.id}`,
    definition: {
      mode: "agent",
      projectId: input.projectId,
      name: input.monitor.systemKey ?? `Hanoon schedule ${input.monitor.id.slice(0, 24)}`,
      trigger: { kind: "cron", cron: input.monitor.cron, timezone: "Etc/UTC" },
      prompt: input.monitor.instruction,
      providerId: input.providerId,
      model: input.model,
      ...(input.reasoningLevel ? { reasoningLevel: input.reasoningLevel } : {}),
      ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
      permissionMode: input.permissionMode,
      target: input.target ?? { kind: "project-default" },
    },
    authority: {
      source: input.monitor.systemKey ? "system" : "owner",
      controllerKey: input.controllerKey,
      ...(input.hostId ? { hostId: input.hostId } : {}),
      mayWidenAutomation: false,
    },
    notificationPolicy: "material",
    legacyMonitorId: input.monitor.id,
    now: input.now,
    signal: input.signal,
  });
  if (binding.state !== "active" || binding.bbAutomationId === null || binding.observed?.nextRunAt === null) {
    throw new Error("BB automation was not active with a verified next run");
  }
  if (!input.store.cancelMonitor(input.monitor.id, input.now)) {
    // Do not leave two schedulers active when the local handoff fence is lost.
    await input.service.setEnabled({
      id: binding.id,
      scope: input.scope,
      enabled: false,
      now: input.now,
      signal: input.signal,
    });
    throw new Error("legacy Hanoon schedule could not be disabled after BB verification");
  }
  return binding;
}

const AUTOMATION_RECONCILIATION_INTERVAL_MS = 60_000;

export class ManagedAutomationReconciler {
  private lastSweepAt = Number.NEGATIVE_INFINITY;

  public constructor(private readonly dependencies: Readonly<{
    repository: ManagedAutomationRepository;
    service: ManagedAutomationService;
    store: Pick<TelegramAgentStore, "getOwner" | "getControllerForOwner" | "enqueueControllerTurn">;
    notify(): void;
    warn?(message: string): void;
  }>) {}

  public async processDue(now: number, signal?: AbortSignal): Promise<boolean> {
    if (now - this.lastSweepAt < AUTOMATION_RECONCILIATION_INTERVAL_MS) return false;
    this.lastSweepAt = now;
    let didWork = false;
    const candidates = this.dependencies.repository.listReconciliationCandidates(
      Math.max(0, now - AUTOMATION_RECONCILIATION_INTERVAL_MS),
      20,
    );
    for (const binding of candidates) {
      const hostId = typeof binding.authority.hostId === "string" ? binding.authority.hostId : null;
      if (!hostId) {
        this.dependencies.warn?.(`Managed automation ${binding.id} has no verified BB host`);
        continue;
      }
      try {
        await this.dependencies.service.reconcile({
          binding,
          scope: { kind: "host_path", hostId, cwd: null },
          now,
          signal,
        });
        didWork = true;
      } catch {
        this.dependencies.warn?.(`Managed automation ${binding.id} could not be reconciled`);
      }
    }

    const owner = this.dependencies.store.getOwner();
    if (!owner) return didWork;
    const controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
    if (!controller) return didWork;
    for (const notification of this.dependencies.repository.listPendingNotifications(20)) {
      if (notification.controllerKey !== controller.controllerKey) continue;
      this.dependencies.store.enqueueControllerTurn({
        controllerKey: notification.controllerKey,
        telegramUserId: owner.userId,
        telegramChatId: owner.chatId,
        updateId: notification.updateId,
        inputText: notification.inputText,
        origin: "system",
        now,
      });
      if (this.dependencies.repository.markNotificationEnqueued(notification.sequence, now)) {
        didWork = true;
        this.dependencies.notify();
      }
    }
    return didWork;
  }
}
