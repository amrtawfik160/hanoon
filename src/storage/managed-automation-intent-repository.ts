import type Database from "better-sqlite3";
import { z } from "zod";

type SqliteDatabase = Database.Database;

const boundedId = z.string().min(1).max(256);
const originSchema = z.enum(["standing-policy", "automation-triggered"]);
const stateSchema = z.enum(["pending", "leased", "succeeded", "failed"]);
const nonNegativeInteger = z.number().int().nonnegative().safe();
const positiveInteger = z.number().int().positive().safe();

const intentRowSchema = z.object({
  id: boundedId,
  origin: originSchema,
  input_json: z.string().min(1),
  state: stateSchema,
  attempts: nonNegativeInteger,
  lease_owner: boundedId.nullable(),
  lease_generation: positiveInteger.nullable(),
  lease_expires_at: nonNegativeInteger.nullable(),
  last_error: z.string().max(16_384).nullable(),
  created_at: nonNegativeInteger,
  updated_at: nonNegativeInteger,
}).strict();

export type ManagedAutomationIntentOrigin = z.infer<typeof originSchema>;
export type ManagedAutomationIntentState = z.infer<typeof stateSchema>;

export type ManagedAutomationIntent = Readonly<{
  id: string;
  origin: ManagedAutomationIntentOrigin;
  input: unknown;
  state: ManagedAutomationIntentState;
  attempts: number;
  leaseOwner: string | null;
  leaseGeneration: number | null;
  leaseExpiresAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}>;

function serializeInput(input: unknown): string {
  const serialized = JSON.stringify(input);
  if (serialized === undefined) throw new TypeError("managed automation intent input must be JSON serializable");
  return serialized;
}

function parseInput(serialized: string): unknown {
  return JSON.parse(serialized) as unknown;
}

function parseIntent(row: unknown): ManagedAutomationIntent {
  const value = intentRowSchema.parse(row);
  return {
    id: value.id,
    origin: value.origin,
    input: parseInput(value.input_json),
    state: value.state,
    attempts: value.attempts,
    leaseOwner: value.lease_owner,
    leaseGeneration: value.lease_generation,
    leaseExpiresAt: value.lease_expires_at,
    lastError: value.last_error,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function assertLeaseInput(input: Readonly<{
  intentId: string;
  ownerId: string;
  generation: number;
  now: number;
  leaseMs: number;
}>): void {
  boundedId.parse(input.intentId);
  boundedId.parse(input.ownerId);
  positiveInteger.parse(input.generation);
  nonNegativeInteger.parse(input.now);
  positiveInteger.parse(input.leaseMs);
}

export class ManagedAutomationIntentRepository {
  public constructor(private readonly db: SqliteDatabase) {}

  public enqueue(input: Readonly<{
    id: string;
    origin: ManagedAutomationIntentOrigin;
    input: unknown;
    now: number;
  }>): ManagedAutomationIntent {
    const id = boundedId.parse(input.id);
    const origin = originSchema.parse(input.origin);
    const serializedInput = serializeInput(input.input);
    const now = nonNegativeInteger.parse(input.now);
    return this.db.transaction(() => {
      const existing = this.db.prepare(
        "SELECT * FROM managed_automation_intents WHERE id = ?",
      ).get(id) as { origin: string; input_json: string } | undefined;
      if (existing) {
        if (existing.origin !== origin || existing.input_json !== serializedInput) {
          throw new TypeError("managed automation intent identity changed");
        }
        return this.get(id)!;
      }
      this.db.prepare(
        `INSERT INTO managed_automation_intents (
           id, origin, input_json, state, attempts, lease_owner, lease_generation,
           lease_expires_at, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?)`,
      ).run(id, origin, serializedInput, now, now);
      return this.get(id)!;
    }).immediate();
  }

  public get(id: string): ManagedAutomationIntent | null {
    const validId = boundedId.parse(id);
    const row = this.db.prepare(
      "SELECT * FROM managed_automation_intents WHERE id = ?",
    ).get(validId);
    return row === undefined ? null : parseIntent(row);
  }

  public listDue(now: number, limit = 20): ManagedAutomationIntent[] {
    const validNow = nonNegativeInteger.parse(now);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("managed automation intent window is invalid");
    }
    const rows = this.db.prepare(
      `SELECT * FROM managed_automation_intents
        WHERE state = 'pending' OR (state = 'leased' AND lease_expires_at <= ?)
        ORDER BY created_at LIMIT ?`,
    ).all(validNow, limit);
    return rows.map(parseIntent);
  }

  public claim(input: Readonly<{
    intentId: string;
    ownerId: string;
    generation: number;
    now: number;
    leaseMs: number;
  }>): ManagedAutomationIntent | null {
    assertLeaseInput(input);
    const leaseExpiresAt = nonNegativeInteger.parse(input.now + input.leaseMs);
    return this.db.transaction(() => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, input.now)) return null;
      const updated = this.db.prepare(
        `UPDATE managed_automation_intents
            SET state = 'leased', attempts = attempts + 1, lease_owner = ?,
                lease_generation = ?, lease_expires_at = ?, last_error = NULL, updated_at = ?
          WHERE id = ? AND (
            state = 'pending' OR (state = 'leased' AND lease_expires_at <= ?)
          )`,
      ).run(
        input.ownerId,
        input.generation,
        leaseExpiresAt,
        input.now,
        input.intentId,
        input.now,
      );
      if (updated.changes !== 1) return null;
      return this.get(input.intentId);
    }).immediate();
  }

  public settle(input: Readonly<{
    intentId: string;
    ownerId: string;
    generation: number;
    now: number;
    outcome: Exclude<ManagedAutomationIntentState, "pending" | "leased">;
    error?: string | null;
  }>): boolean {
    boundedId.parse(input.intentId);
    boundedId.parse(input.ownerId);
    positiveInteger.parse(input.generation);
    const now = nonNegativeInteger.parse(input.now);
    const outcome = z.enum(["succeeded", "failed"]).parse(input.outcome);
    const error = input.error === undefined || input.error === null
      ? null
      : z.string().min(1).max(16_384).parse(input.error);
    return this.db.transaction(() => {
      if (!this.executorLeaseIsCurrent(input.ownerId, input.generation, now)) return false;
      return this.db.prepare(
        `UPDATE managed_automation_intents
            SET state = ?, lease_owner = NULL, lease_generation = NULL,
                lease_expires_at = NULL, last_error = ?, updated_at = ?
          WHERE id = ? AND state = 'leased' AND lease_owner = ? AND lease_generation = ?`,
      ).run(
        outcome,
        error,
        now,
        input.intentId,
        input.ownerId,
        input.generation,
      ).changes === 1;
    }).immediate();
  }

  private executorLeaseIsCurrent(ownerId: string, generation: number, now: number): boolean {
    const row = this.db.prepare(
      "SELECT owner_id, generation, lease_expires_at FROM executor_lease WHERE singleton = 1",
    ).get() as { owner_id: string | null; generation: number; lease_expires_at: number | null } | undefined;
    return row?.owner_id === ownerId && row.generation === generation &&
      row.lease_expires_at !== null && row.lease_expires_at > now;
  }
}
