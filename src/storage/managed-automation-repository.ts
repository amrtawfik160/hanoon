import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { BbAutomation, BbAutomationDefinition, BbAutomationRun } from "../bb/automation";

type SqliteDatabase = Database.Database;

export type ManagedAutomationState = "pending" | "active" | "paused" | "updating" | "retiring" | "retired" | "failed";
export type ManagedAutomationBinding = Readonly<{
  id: string;
  controllerKey: string;
  sourceKey: string;
  projectId: string;
  bbAutomationId: string | null;
  name: string;
  mode: "agent" | "script";
  definition: BbAutomationDefinition;
  definitionSha256: string;
  authority: Readonly<Record<string, unknown>>;
  notificationPolicy: "material" | "always" | "silent";
  state: ManagedAutomationState;
  legacyMonitorId: string | null;
  observed: BbAutomation | null;
  observedSha256: string | null;
  lastReconciledAt: number | null;
  lastRunId: string | null;
  lastRunStatus: BbAutomationRun["status"] | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}>;

export type ManagedAutomationNotification = Readonly<{
  sequence: number;
  bbRunId: string;
  bindingId: string;
  controllerKey: string;
  updateId: number;
  inputText: string;
  createdAt: number;
}>;

type ManagedAutomationRow = Readonly<{
  id: string;
  controller_key: string;
  source_key: string;
  project_id: string;
  bb_automation_id: string | null;
  name: string;
  mode: string;
  definition_json: string;
  definition_sha256: string;
  authority_json: string;
  notification_policy: string;
  state: string;
  legacy_monitor_id: string | null;
  observed_json: string | null;
  observed_sha256: string | null;
  last_reconciled_at: number | null;
  last_run_id: string | null;
  last_run_status: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}>;

const reserveSchema = z.object({
  controllerKey: z.string().min(1).max(256),
  sourceKey: z.string().min(1).max(256),
  projectId: z.string().min(1).max(256),
  name: z.string().min(1).max(200),
  definition: z.custom<BbAutomationDefinition>((value) => typeof value === "object" && value !== null),
  authority: z.record(z.string(), z.unknown()),
  notificationPolicy: z.enum(["material", "always", "silent"]),
  legacyMonitorId: z.string().min(1).max(256).nullable().default(null),
  now: z.number().int().nonnegative().safe(),
}).strict();

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("managed automation contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("managed automation contains a non-JSON value");
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

export function managedAutomationDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function parseRow(row: ManagedAutomationRow): ManagedAutomationBinding {
  if (!(["agent", "script"] as const).includes(row.mode as "agent" | "script")) {
    throw new Error(`Unknown managed automation mode ${row.mode}`);
  }
  if (!(["pending", "active", "paused", "updating", "retiring", "retired", "failed"] as const).includes(row.state as ManagedAutomationState)) {
    throw new Error(`Unknown managed automation state ${row.state}`);
  }
  if (!(["material", "always", "silent"] as const).includes(row.notification_policy as "material" | "always" | "silent")) {
    throw new Error(`Unknown managed automation notification policy ${row.notification_policy}`);
  }
  return {
    id: row.id,
    controllerKey: row.controller_key,
    sourceKey: row.source_key,
    projectId: row.project_id,
    bbAutomationId: row.bb_automation_id,
    name: row.name,
    mode: row.mode as "agent" | "script",
    definition: JSON.parse(row.definition_json) as BbAutomationDefinition,
    definitionSha256: row.definition_sha256,
    authority: JSON.parse(row.authority_json) as Record<string, unknown>,
    notificationPolicy: row.notification_policy as "material" | "always" | "silent",
    state: row.state as ManagedAutomationState,
    legacyMonitorId: row.legacy_monitor_id,
    observed: row.observed_json === null ? null : JSON.parse(row.observed_json) as BbAutomation,
    observedSha256: row.observed_sha256,
    lastReconciledAt: row.last_reconciled_at,
    lastRunId: row.last_run_id,
    lastRunStatus: row.last_run_status as BbAutomationRun["status"] | null,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ManagedAutomationRepository {
  public constructor(private readonly db: SqliteDatabase) {}

  public get(id: string): ManagedAutomationBinding | null {
    const row = this.db.prepare("SELECT * FROM managed_automations WHERE id = ?").get(id) as ManagedAutomationRow | undefined;
    return row ? parseRow(row) : null;
  }

  public getBySource(controllerKey: string, sourceKey: string): ManagedAutomationBinding | null {
    const row = this.db.prepare(
      "SELECT * FROM managed_automations WHERE controller_key = ? AND source_key = ?",
    ).get(controllerKey, sourceKey) as ManagedAutomationRow | undefined;
    return row ? parseRow(row) : null;
  }

  public list(controllerKey: string, includeRetired = false): ManagedAutomationBinding[] {
    const rows = this.db.prepare(
      `SELECT * FROM managed_automations
        WHERE controller_key = ? ${includeRetired ? "" : "AND state <> 'retired'"}
        ORDER BY created_at DESC LIMIT 100`,
    ).all(controllerKey) as ManagedAutomationRow[];
    return rows.map(parseRow);
  }

  public listReconciliationCandidates(before: number, limit = 20): ManagedAutomationBinding[] {
    if (!Number.isSafeInteger(before) || before < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("managed automation reconciliation window is invalid");
    }
    const rows = this.db.prepare(
      `SELECT * FROM managed_automations
        WHERE state IN ('active', 'paused', 'updating', 'retiring', 'failed') AND bb_automation_id IS NOT NULL
          AND (last_reconciled_at IS NULL OR last_reconciled_at <= ?)
        ORDER BY COALESCE(last_reconciled_at, 0), created_at LIMIT ?`,
    ).all(before, limit) as ManagedAutomationRow[];
    return rows.map(parseRow);
  }

  public reserve(raw: z.input<typeof reserveSchema>): ManagedAutomationBinding {
    const input = reserveSchema.parse(raw);
    if (input.definition.projectId !== input.projectId || input.definition.name !== input.name) {
      throw new TypeError("managed automation identity must match its definition");
    }
    const definitionJson = canonical(input.definition);
    const authorityJson = canonical(input.authority);
    const definitionSha256 = managedAutomationDigest(input.definition);
    return this.db.transaction(() => {
      const existing = this.getBySource(input.controllerKey, input.sourceKey);
      if (existing) {
        if (existing.definitionSha256 !== definitionSha256 || existing.state === "retired") {
          throw new Error("managed automation source already has a different durable definition");
        }
        return existing;
      }
      const id = `automation-binding-${randomUUID()}`;
      this.db.prepare(
        `INSERT INTO managed_automations (
           id, controller_key, source_key, project_id, bb_automation_id, name, mode,
           definition_json, definition_sha256, authority_json, notification_policy,
           state, legacy_monitor_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ).run(
        id,
        input.controllerKey,
        input.sourceKey,
        input.projectId,
        input.name,
        input.definition.mode,
        definitionJson,
        definitionSha256,
        authorityJson,
        input.notificationPolicy,
        input.legacyMonitorId,
        input.now,
        input.now,
      );
      return this.get(id)!;
    }).immediate();
  }

  public activate(input: {
    id: string;
    automation: BbAutomation;
    now: number;
  }): ManagedAutomationBinding {
    const observedJson = canonical(input.automation);
    const observedSha256 = managedAutomationDigest(input.automation);
    const result = this.db.prepare(
      `UPDATE managed_automations
          SET bb_automation_id = ?, observed_json = ?, observed_sha256 = ?,
              state = CASE WHEN ? THEN 'active' ELSE 'paused' END,
              last_reconciled_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND state IN ('pending', 'active', 'paused', 'updating', 'failed')`,
    ).run(input.automation.id, observedJson, observedSha256, input.automation.enabled ? 1 : 0, input.now, input.now, input.id);
    if (result.changes !== 1) throw new Error("managed automation activation fence was lost");
    return this.get(input.id)!;
  }

  public fail(id: string, errorClass: string, now: number): ManagedAutomationBinding {
    const result = this.db.prepare(
      `UPDATE managed_automations SET state = 'failed', last_error = ?, updated_at = ?
        WHERE id = ? AND state NOT IN ('updating', 'retiring', 'retired')`,
    ).run(errorClass.slice(0, 256), now, id);
    if (result.changes !== 1) throw new Error("managed automation failure fence was lost");
    return this.get(id)!;
  }

  public beginUpdate(input: {
    id: string;
    definition: BbAutomationDefinition;
    now: number;
  }): ManagedAutomationBinding {
    const existing = this.get(input.id);
    if (!existing || existing.bbAutomationId === null || existing.projectId !== input.definition.projectId) {
      throw new Error("managed automation update identity is invalid");
    }
    const result = this.db.prepare(
      `UPDATE managed_automations
          SET name = ?, mode = ?, definition_json = ?, definition_sha256 = ?,
              state = 'updating', last_error = NULL, updated_at = ?
        WHERE id = ? AND state IN ('active', 'paused', 'failed')`,
    ).run(
      input.definition.name,
      input.definition.mode,
      canonical(input.definition),
      managedAutomationDigest(input.definition),
      input.now,
      input.id,
    );
    if (result.changes !== 1) throw new Error("managed automation update intent fence was lost");
    return this.get(input.id)!;
  }

  public markPolicyBlocked(id: string, now: number): ManagedAutomationBinding {
    const result = this.db.prepare(
      `UPDATE managed_automations
          SET state = 'paused', last_error = 'managed_automation_authority_stale',
              last_reconciled_at = ?, updated_at = ?
        WHERE id = ? AND state IN ('active', 'paused', 'updating', 'failed')`,
    ).run(now, now, id);
    if (result.changes !== 1) throw new Error("managed automation policy block fence was lost");
    return this.get(id)!;
  }

  public markExecutionContractBlocked(id: string, now: number): ManagedAutomationBinding {
    const result = this.db.prepare(
      `UPDATE managed_automations
          SET state = 'paused', last_error = 'bb_agent_execution_contract_unsupported',
              last_reconciled_at = ?, updated_at = ?
        WHERE id = ? AND state IN ('active', 'paused', 'updating', 'failed')`,
    ).run(now, now, id);
    if (result.changes !== 1) throw new Error("managed automation execution contract block fence was lost");
    return this.get(id)!;
  }

  public beginRetirement(id: string, now: number): ManagedAutomationBinding {
    const result = this.db.prepare(
      `UPDATE managed_automations SET state = 'retiring', last_error = NULL, updated_at = ?
        WHERE id = ? AND state IN ('active', 'paused', 'failed')`,
    ).run(now, id);
    if (result.changes !== 1) throw new Error("managed automation retirement intent fence was lost");
    return this.get(id)!;
  }

  public retire(id: string, now: number): ManagedAutomationBinding {
    const existing = this.get(id);
    if (existing?.state === "retired") return existing;
    const result = this.db.prepare(
      `UPDATE managed_automations SET state = 'retired', updated_at = ?
        WHERE id = ? AND state = 'retiring'`,
    ).run(now, id);
    if (result.changes !== 1) throw new Error("managed automation retirement fence was lost");
    return this.get(id)!;
  }

  public recordRun(bindingId: string, run: BbAutomationRun, now: number): boolean {
    return this.db.transaction(() => {
      const binding = this.get(bindingId);
      if (!binding || binding.bbAutomationId !== run.automationId || ["retiring", "retired"].includes(binding.state)) {
        throw new Error("managed automation run does not match its active binding");
      }
      const outputSha256 = run.output === null ? null : managedAutomationDigest(run.output);
      const contract = managedAutomationRunContract(binding, run);
      const errorClass = contract.errorClass ?? (run.error === null ? null : "bb_automation_run_failed");
      const evidenceJson = canonical({
        automationId: run.automationId,
        contractOutcome: contract.outcome,
        errorClass,
        exitCode: run.exitCode,
        finishedAt: run.finishedAt,
        id: run.id,
        output: outputSha256 === null ? null : { screened: true, sha256: outputSha256 },
        runMode: run.runMode,
        scheduledFor: run.scheduledFor,
        skipReason: run.skipReason,
        startedAt: run.startedAt,
        status: run.status,
        threadId: run.threadId,
        trigger: run.trigger,
      });
      const inserted = this.db.prepare(
        `INSERT OR IGNORE INTO managed_automation_run_evidence (
           binding_id, bb_run_id, bb_automation_id, status, run_mode, trigger_kind,
           thread_id, output_sha256, error_class, scheduled_for, started_at,
           finished_at, observed_at, evidence_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        bindingId,
        run.id,
        run.automationId,
        run.status,
        run.runMode,
        run.trigger,
        run.threadId,
        outputSha256,
        errorClass,
        run.scheduledFor,
        run.startedAt,
        run.finishedAt,
        now,
        evidenceJson,
      );
      if (inserted.changes === 0) return false;
      this.db.prepare(
        `UPDATE managed_automations
            SET last_run_id = ?, last_run_status = ?, updated_at = ?
          WHERE id = ?`,
      ).run(run.id, run.status, now, bindingId);
      if (run.status !== "running" && binding.notificationPolicy !== "silent") {
        const notification = this.db.prepare(
          `INSERT OR IGNORE INTO managed_automation_notifications (
             bb_run_id, binding_id, controller_key, update_id, input_text,
             state, created_at, enqueued_at
           ) VALUES (?, ?, ?, NULL, ?, 'pending', ?, NULL)`,
        ).run(
          run.id,
          bindingId,
          binding.controllerKey,
          managedAutomationNotificationText(binding, run),
          now,
        );
        if (notification.changes === 1) {
          const sequence = Number(notification.lastInsertRowid);
          this.db.prepare(
            "UPDATE managed_automation_notifications SET update_id = ? WHERE sequence = ? AND update_id IS NULL",
          ).run(7_000_000_000_000 + sequence, sequence);
        }
      }
      return true;
    }).immediate();
  }

  public listPendingNotifications(limit = 20): ManagedAutomationNotification[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError("notification limit must be 1-100");
    const rows = this.db.prepare(
      `SELECT sequence, bb_run_id, binding_id, controller_key, update_id, input_text, created_at
         FROM managed_automation_notifications
        WHERE state = 'pending' AND update_id IS NOT NULL
        ORDER BY sequence LIMIT ?`,
    ).all(limit) as Array<{
      sequence: number;
      bb_run_id: string;
      binding_id: string;
      controller_key: string;
      update_id: number;
      input_text: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      sequence: row.sequence,
      bbRunId: row.bb_run_id,
      bindingId: row.binding_id,
      controllerKey: row.controller_key,
      updateId: row.update_id,
      inputText: row.input_text,
      createdAt: row.created_at,
    }));
  }

  public markNotificationEnqueued(sequence: number, now: number): boolean {
    const result = this.db.prepare(
      `UPDATE managed_automation_notifications SET state = 'enqueued', enqueued_at = ?
        WHERE sequence = ? AND state = 'pending'`,
    ).run(now, sequence);
    return result.changes === 1;
  }
}

function clip(value: string | null, limit: number): string {
  if (!value) return "(none)";
  return value.length <= limit ? value : `${value.slice(0, limit).trimEnd()}…`;
}

function managedAutomationNotificationText(
  binding: ManagedAutomationBinding,
  run: BbAutomationRun,
): string {
  const instruction = binding.definition.mode === "agent"
    ? binding.definition.prompt
    : `Run the script automation named ${binding.name}.`;
  const contract = managedAutomationRunContract(binding, run);
  return [
    "A BB Automation run finished. Treat this as a scheduled system handoff, not a new owner request.",
    `Schedule: ${binding.name}`,
    `Result: ${run.status}`,
    `Original instruction: ${clip(instruction, 1_000)}`,
    run.output === null
      ? "Worker output: (none)"
      : `Worker output: screened (sha256 ${managedAutomationDigest(run.output)})`,
    `Result contract: ${contract.outcome}`,
    `Error class: ${contract.errorClass ?? (run.error === null ? "(none)" : "bb_automation_run_failed")}`,
    ...(run.threadId ? [`BB worker thread: ${run.threadId}`] : []),
    binding.notificationPolicy === "always"
      ? "Give the owner a short result in simple language."
      : "Continue any safe follow-up that is clearly required. Tell the owner only when the result is material, needs a decision, or needs help. Otherwise stay silent.",
  ].join("\n");
}

function managedAutomationRunContract(
  binding: ManagedAutomationBinding,
  run: BbAutomationRun,
): Readonly<{
  outcome: "not_applicable" | "pending" | "satisfied" | "violated";
  errorClass: string | null;
}> {
  if (binding.definition.mode !== "agent") return { outcome: "not_applicable", errorClass: null };
  if (run.status === "running") return { outcome: "pending", errorClass: null };
  if (run.finishedAt !== null && run.finishedAt - run.startedAt > binding.definition.timeoutMs) {
    return { outcome: "violated", errorClass: "bb_automation_timeout_contract_violated" };
  }
  if (run.output !== null &&
    Buffer.byteLength(run.output, "utf8") > binding.definition.resultContract.maximumBytes) {
    return { outcome: "violated", errorClass: "bb_automation_result_contract_violated" };
  }
  return { outcome: "satisfied", errorClass: null };
}
