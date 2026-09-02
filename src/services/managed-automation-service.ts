import type { TerminalScope } from "../bb/terminal-command";
import {
  assertAutomationMatches,
  BbAutomationNotFoundError,
  DEFAULT_BB_AGENT_AUTOMATION_RESULT_CONTRACT,
  DEFAULT_BB_AGENT_AUTOMATION_TIMEOUT_MS,
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
  list(input: {
    scope: TerminalScope;
    projectId: string;
    signal?: AbortSignal;
  }): Promise<readonly BbAutomation[]>;
  update(input: {
    scope: TerminalScope;
    definition: BbAutomationDefinition;
    automationId: string;
    expectedEnabled: boolean;
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

async function deleteAutomationForRetirement(
  adapter: ManagedAutomationAdapter,
  input: Parameters<ManagedAutomationAdapter["delete"]>[0],
): Promise<void> {
  try {
    await adapter.delete(input);
  } catch (error) {
    if (!(error instanceof BbAutomationNotFoundError)) throw error;
  }
}

export class ManagedAutomationService {
  public constructor(
    private readonly repository: ManagedAutomationRepository,
    private readonly adapter: ManagedAutomationAdapter,
    private readonly authorityIsCurrent: (binding: ManagedAutomationBinding) => boolean,
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
    if (reserved.mode === "agent" && !this.authorityIsCurrent(reserved)) {
      if (reserved.bbAutomationId === null) {
        applyMutation(input.mutate, () => this.repository.fail(
          reserved.id,
          "managed_automation_authority_stale",
          input.now,
        ));
      } else {
        await this.pauseForStaleAuthority({
          binding: reserved,
          scope: input.scope,
          now: input.now,
          signal: input.signal,
        });
      }
      throw new Error("managed automation authority is not current");
    }
    if (reserved.bbAutomationId !== null) {
      return this.reconcile({
        binding: reserved,
        scope: input.scope,
        now: input.now,
        mutate: input.mutate,
        signal: input.signal,
      });
    }
    return this.createOnBb(reserved, input);
  }

  /**
   * BB's create has no idempotency key, so the durable order is: adopt an
   * automation already carrying this binding's deterministic name, else ask
   * BB for one; persist the id; read it back exactly; only then activate.
   * A crash anywhere in between is finished by reconciliation or by the next
   * create, never by a second BB schedule.
   */
  private async createOnBb(
    reserved: ManagedAutomationBinding,
    input: CreateManagedAutomationInput,
  ): Promise<ManagedAutomationBinding> {
    const scope = { scope: input.scope, projectId: input.definition.projectId, signal: input.signal };
    let attachedId: string | null = null;
    let adopted = false;
    try {
      const orphan = (await this.adapter.list(scope))
        .find((candidate) => candidate.name === input.definition.name) ?? null;
      adopted = orphan !== null;
      const created = orphan ?? await this.adapter.create({
        scope: input.scope,
        definition: input.definition,
        signal: input.signal,
      });
      applyMutation(input.mutate, () => this.repository.attach({
        id: reserved.id,
        automationId: created.id,
        now: input.now,
      }));
      attachedId = created.id;
      const observed = await this.adapter.show({ ...scope, automationId: created.id });
      assertAutomationMatches(input.definition, observed, adopted ? observed.enabled : true);
      return applyMutation(input.mutate, () => this.repository.activate({
        id: reserved.id,
        automation: observed,
        now: input.now,
      }));
    } catch (error) {
      let detach = false;
      if (attachedId !== null && !adopted) {
        // Hanoon asked for this automation and BB could not read it back
        // exactly. Remove it so no hidden, untrusted schedule is left. An
        // automation adopted by name is not Hanoon's to delete.
        try {
          await deleteAutomationForRetirement(this.adapter, { ...scope, automationId: attachedId });
          detach = true;
        } catch {
          // The binding keeps BB's id in a failed state, so reconciliation
          // retries the exact read-back instead of creating a second schedule.
        }
      }
      try {
        applyMutation(input.mutate, () => this.repository.fail(
          reserved.id,
          adopted ? "bb_automation_name_conflict" : automationErrorClass(error),
          input.now,
          { detach },
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
    if (input.binding.state === "retiring") {
      await deleteAutomationForRetirement(this.adapter, {
        scope: input.scope,
        projectId: input.binding.projectId,
        automationId: input.binding.bbAutomationId,
        signal: input.signal,
      });
      return applyMutation(input.mutate, () => this.repository.retire(input.binding.id, input.now));
    }
    if (input.binding.mode === "agent" && !this.authorityIsCurrent(input.binding)) {
      return this.pauseForStaleAuthority({
        binding: input.binding,
        scope: input.scope,
        now: input.now,
        signal: input.signal,
      });
    }
    if (input.binding.state === "updating") {
      const automation = await this.adapter.update({
        scope: input.scope,
        definition: input.binding.definition,
        automationId: input.binding.bbAutomationId,
        expectedEnabled: input.binding.observed?.enabled ?? true,
        signal: input.signal,
      });
      return applyMutation(input.mutate, () => this.repository.activate({
        id: input.binding.id,
        automation,
        now: input.now,
      }));
    }
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
    if (input.enabled && binding.mode === "agent" && !this.authorityIsCurrent(binding)) {
      throw new Error("managed automation authority is not current");
    }
    const automation = await this.adapter.setEnabled({
      scope: input.scope,
      projectId: binding.projectId,
      automationId: binding.bbAutomationId!,
      enabled: input.enabled,
      signal: input.signal,
    });
    return this.repository.activate({ id: binding.id, automation, now: input.now });
  }

  public async update(input: {
    id: string;
    scope: TerminalScope;
    definition: BbAutomationDefinition;
    now: number;
    mutate?: ManagedAutomationMutation;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationBinding> {
    const updating = applyMutation(input.mutate, () => this.repository.beginUpdate({
      id: input.id,
      definition: input.definition,
      now: input.now,
    }));
    if (updating.mode === "agent" && !this.authorityIsCurrent(updating)) {
      await this.pauseForStaleAuthority({
        binding: updating,
        scope: input.scope,
        now: input.now,
        signal: input.signal,
      });
      throw new Error("managed automation authority is not current");
    }
    const automation = await this.adapter.update({
      scope: input.scope,
      definition: updating.definition,
      automationId: updating.bbAutomationId!,
      expectedEnabled: updating.observed?.enabled ?? true,
      signal: input.signal,
    });
    return applyMutation(input.mutate, () => this.repository.activate({
      id: updating.id,
      automation,
      now: input.now,
    }));
  }

  public async pauseForStaleAuthority(input: {
    binding: ManagedAutomationBinding;
    scope: TerminalScope;
    now: number;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationBinding> {
    let binding = input.binding;
    if (binding.state === "updating") {
      const updated = await this.adapter.update({
        scope: input.scope,
        definition: binding.definition,
        automationId: binding.bbAutomationId!,
        expectedEnabled: binding.observed?.enabled ?? true,
        signal: input.signal,
      });
      binding = this.repository.activate({ id: binding.id, automation: updated, now: input.now });
    }
    if (binding.observed?.enabled !== false) {
      const paused = await this.adapter.setEnabled({
        scope: input.scope,
        projectId: binding.projectId,
        automationId: binding.bbAutomationId!,
        enabled: false,
        signal: input.signal,
      });
      binding = this.repository.activate({ id: binding.id, automation: paused, now: input.now });
    }
    return this.repository.markPolicyBlocked(binding.id, input.now);
  }

  public async runNow(input: {
    id: string;
    scope: TerminalScope;
    idempotencyKey: string;
    now: number;
    signal?: AbortSignal;
  }): Promise<BbAutomationRun> {
    const binding = requireActiveBinding(this.repository, input.id);
    if (binding.mode === "agent" && !this.authorityIsCurrent(binding)) {
      throw new Error("managed automation authority is not current");
    }
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
    const binding = applyMutation(input.mutate, () => {
      const current = this.repository.get(input.id);
      if (current?.state === "retiring" && current.bbAutomationId !== null) return current;
      const active = requireActiveBinding(this.repository, input.id);
      return this.repository.beginRetirement(active.id, input.now);
    });
    await deleteAutomationForRetirement(this.adapter, {
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
  if (!binding || binding.bbAutomationId === null ||
    !["active", "paused", "failed"].includes(binding.state)) {
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
      timeoutMs: DEFAULT_BB_AGENT_AUTOMATION_TIMEOUT_MS,
      resultContract: DEFAULT_BB_AGENT_AUTOMATION_RESULT_CONTRACT,
    },
    authority: {
      source: input.monitor.systemKey ? "system" : "owner",
      controllerKey: input.controllerKey,
      projectId: input.projectId,
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
    store: Pick<
      TelegramAgentStore,
      "getOwner" | "getControllerForOwner" | "getProjectPolicy" | "enqueueControllerTurn" | "cancelMonitor"
    >;
    notify(): void;
    warn?(message: string): void;
  }>) {}

  public async processDue(now: number, signal?: AbortSignal): Promise<boolean> {
    if (now - this.lastSweepAt < AUTOMATION_RECONCILIATION_INTERVAL_MS) return false;
    this.lastSweepAt = now;
    let didWork = false;
    const owner = this.dependencies.store.getOwner();
    const controller = owner
      ? this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId)
      : null;
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
        if (binding.mode === "agent" && !managedAutomationAuthorityIsCurrent(
          binding,
          controller,
          this.dependencies.store.getProjectPolicy(binding.projectId)?.policy.enabled === true,
        )) {
          await this.dependencies.service.pauseForStaleAuthority({
            binding,
            scope: { kind: "host_path", hostId, cwd: null },
            now,
            signal,
          });
          didWork = true;
          continue;
        }
        const current = binding.state === "paused" &&
          binding.lastError === "managed_automation_authority_stale"
          ? await this.dependencies.service.setEnabled({
              id: binding.id,
              scope: { kind: "host_path", hostId, cwd: null },
              enabled: true,
              now,
              signal,
            })
          : binding;
        const reconciled = await this.dependencies.service.reconcile({
          binding: current,
          scope: { kind: "host_path", hostId, cwd: null },
          now,
          signal,
        });
        if (reconciled.legacyMonitorId !== null &&
          this.dependencies.store.cancelMonitor(reconciled.legacyMonitorId, now)) {
          // The handover to BB was interrupted after BB had read the schedule
          // back. Finishing it here keeps one task out of two schedulers.
          this.dependencies.warn?.(`Managed automation ${binding.id} cancelled its leftover legacy schedule`);
        }
        didWork = true;
      } catch {
        this.dependencies.warn?.(`Managed automation ${binding.id} could not be reconciled`);
      }
    }

    if (!owner) return didWork;
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

export function managedAutomationAuthorityIsCurrent(
  binding: ManagedAutomationBinding,
  controller: Readonly<{ controllerKey: string; projectId: string | null }> | null,
  projectPolicyEnabled: boolean,
): boolean {
  if (controller === null || controller.controllerKey !== binding.controllerKey) return false;
  // The controller's own project needs no repository policy: upkeep and the
  // owner's follow-up schedules run where the controller itself already runs.
  // Any other project must still be an enabled Hanoon project.
  const projectAuthorized = projectPolicyEnabled ||
    (controller.projectId !== null && controller.projectId === binding.projectId);
  return projectAuthorized &&
    binding.authority.controllerKey === binding.controllerKey &&
    binding.authority.projectId === binding.projectId &&
    typeof binding.authority.hostId === "string" &&
    binding.authority.mayWidenAutomation === false;
}
