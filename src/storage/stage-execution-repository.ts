import type Database from "better-sqlite3";
import { z } from "zod";
import {
  PIPELINE_STAGES,
  REASONING_LEVELS,
  SERVICE_TIERS,
  STAGE_TIERS,
  stageCostMicroUsd,
  type PipelineStage,
  type StageTokenUsage,
} from "../domain/stage-execution";

type SqliteDatabase = Database.Database;

/**
 * The per-attempt ledger of what each pipeline stage actually ran on. Written
 * at spawn and settled when the worker stops, so the tiering can be tuned from
 * observed tokens, cost, and duration instead of from a guess.
 */

const boundedIdSchema = z.string().min(1).max(256);
const nonNegativeIntegerSchema = z.number().int().min(0);

export const STAGE_EXECUTION_OUTCOMES = ["succeeded", "failed", "cancelled"] as const;
export type StageExecutionOutcome = typeof STAGE_EXECUTION_OUTCOMES[number];

const startInputSchema = z.object({
  jobId: boundedIdSchema,
  attemptId: boundedIdSchema,
  stage: z.enum(PIPELINE_STAGES),
  attemptOrdinal: z.number().int().min(1),
  threadId: boundedIdSchema.nullable().optional(),
  baseTier: z.enum(STAGE_TIERS),
  tier: z.enum(STAGE_TIERS),
  escalationSteps: z.number().int().min(0).max(2),
  source: z.enum(["stage-policy", "legacy-policy", "default", "capability-route"]),
  providerId: z.string().min(1).max(128),
  modelId: boundedIdSchema,
  reasoningLevel: z.enum(REASONING_LEVELS),
  serviceTier: z.enum(SERVICE_TIERS),
  now: nonNegativeIntegerSchema,
}).strict();

const usageSchema = z.object({
  inputTokens: nonNegativeIntegerSchema,
  cachedInputTokens: nonNegativeIntegerSchema,
  outputTokens: nonNegativeIntegerSchema,
  reasoningOutputTokens: nonNegativeIntegerSchema,
  totalTokens: nonNegativeIntegerSchema,
}).strict();

const settleInputSchema = z.object({
  jobId: boundedIdSchema,
  attemptId: boundedIdSchema,
  stage: z.enum(PIPELINE_STAGES),
  outcome: z.enum(STAGE_EXECUTION_OUTCOMES),
  threadId: boundedIdSchema.nullable().optional(),
  usage: usageSchema.nullable().optional(),
  now: nonNegativeIntegerSchema,
}).strict();

export type RecordStageExecutionInput = z.input<typeof startInputSchema>;
export type SettleStageExecutionInput = z.input<typeof settleInputSchema>;

export type StageExecutionRecord = Readonly<{
  id: string;
  jobId: string;
  attemptId: string;
  stage: PipelineStage;
  attemptOrdinal: number;
  threadId: string | null;
  baseTier: typeof STAGE_TIERS[number];
  tier: typeof STAGE_TIERS[number];
  escalationSteps: number;
  /** True when this attempt ran on a stronger tier than the stage's baseline. */
  escalated: boolean;
  source: "stage-policy" | "legacy-policy" | "default" | "capability-route";
  providerId: string;
  modelId: string;
  reasoningLevel: typeof REASONING_LEVELS[number];
  serviceTier: typeof SERVICE_TIERS[number];
  usage: StageTokenUsage | null;
  /** Null means the model has no published rate entered yet, never "free". */
  costMicroUsd: number | null;
  durationMs: number | null;
  outcome: StageExecutionOutcome | null;
  startedAt: number;
  settledAt: number | null;
}>;

type StageExecutionRow = {
  id: string;
  job_id: string;
  attempt_id: string;
  stage: PipelineStage;
  attempt_ordinal: number;
  thread_id: string | null;
  base_tier: StageExecutionRecord["baseTier"];
  tier: StageExecutionRecord["tier"];
  escalation_steps: number;
  source: StageExecutionRecord["source"];
  provider_id: string;
  model_id: string;
  reasoning_level: StageExecutionRecord["reasoningLevel"];
  service_tier: StageExecutionRecord["serviceTier"];
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_tokens: number | null;
  cost_micro_usd: number | null;
  duration_ms: number | null;
  outcome: StageExecutionOutcome | null;
  started_at: number;
  settled_at: number | null;
};

const SELECT_COLUMNS = `id, job_id, attempt_id, stage, attempt_ordinal, thread_id, base_tier, tier,
       escalation_steps, source, provider_id, model_id, reasoning_level, service_tier,
       input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
       cost_micro_usd, duration_ms, outcome, started_at, settled_at`;

function projectRow(row: StageExecutionRow): StageExecutionRecord {
  const usage = row.total_tokens === null ? null : Object.freeze({
    inputTokens: row.input_tokens ?? 0,
    cachedInputTokens: row.cached_input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    reasoningOutputTokens: row.reasoning_output_tokens ?? 0,
    totalTokens: row.total_tokens,
  });
  return Object.freeze({
    id: row.id,
    jobId: row.job_id,
    attemptId: row.attempt_id,
    stage: row.stage,
    attemptOrdinal: row.attempt_ordinal,
    threadId: row.thread_id,
    baseTier: row.base_tier,
    tier: row.tier,
    escalationSteps: row.escalation_steps,
    escalated: row.escalation_steps > 0,
    source: row.source,
    providerId: row.provider_id,
    modelId: row.model_id,
    reasoningLevel: row.reasoning_level,
    serviceTier: row.service_tier,
    usage,
    costMicroUsd: row.cost_micro_usd,
    durationMs: row.duration_ms,
    outcome: row.outcome,
    startedAt: row.started_at,
    settledAt: row.settled_at,
  });
}

export class StageExecutionRepository {
  public constructor(private readonly db: SqliteDatabase) {}

  /**
   * Records the tuple a stage attempt was dispatched on. Re-dispatching the
   * same attempt keeps the first row: an attempt runs on one model, and a
   * retried spawn of the same attempt is the same measurement.
   */
  public recordStageExecution(rawInput: RecordStageExecutionInput): StageExecutionRecord {
    const input = startInputSchema.parse(rawInput);
    const id = `stage_exec:${input.jobId}:${input.stage}:${input.attemptId}`;
    this.db.prepare(
      `INSERT INTO stage_executions (
         id, job_id, attempt_id, stage, attempt_ordinal, thread_id, base_tier, tier,
         escalation_steps, source, provider_id, model_id, reasoning_level, service_tier, started_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, stage, attempt_id) DO UPDATE SET
         thread_id = COALESCE(excluded.thread_id, stage_executions.thread_id)`,
    ).run(
      id,
      input.jobId,
      input.attemptId,
      input.stage,
      input.attemptOrdinal,
      input.threadId ?? null,
      input.baseTier,
      input.tier,
      input.escalationSteps,
      input.source,
      input.providerId,
      input.modelId,
      input.reasoningLevel,
      input.serviceTier,
      input.now,
    );
    const stored = this.getStageExecution(input.jobId, input.stage, input.attemptId);
    if (!stored) throw new Error("Stage execution record disappeared after persistence");
    return stored;
  }

  /**
   * Closes the record with measured tokens, cost, and duration. Settling twice
   * is a no-op so a retried observation cannot rewrite what was measured.
   */
  public settleStageExecution(rawInput: SettleStageExecutionInput): StageExecutionRecord | null {
    const input = settleInputSchema.parse(rawInput);
    const existing = this.getStageExecution(input.jobId, input.stage, input.attemptId);
    if (!existing) return null;
    if (existing.settledAt !== null) return existing;
    if (input.now < existing.startedAt) throw new TypeError("A stage execution cannot settle before it started");
    const usage = input.usage ?? null;
    this.db.prepare(
      `UPDATE stage_executions
          SET thread_id = COALESCE(?, thread_id),
              input_tokens = ?, cached_input_tokens = ?, output_tokens = ?,
              reasoning_output_tokens = ?, total_tokens = ?, cost_micro_usd = ?,
              duration_ms = ?, outcome = ?, settled_at = ?
        WHERE id = ? AND settled_at IS NULL`,
    ).run(
      input.threadId ?? null,
      usage?.inputTokens ?? null,
      usage?.cachedInputTokens ?? null,
      usage?.outputTokens ?? null,
      usage?.reasoningOutputTokens ?? null,
      usage?.totalTokens ?? null,
      usage === null ? null : stageCostMicroUsd(existing.modelId, usage),
      input.now - existing.startedAt,
      input.outcome,
      input.now,
      existing.id,
    );
    return this.getStageExecution(input.jobId, input.stage, input.attemptId);
  }

  public getStageExecution(
    jobId: string,
    stage: PipelineStage,
    attemptId: string,
  ): StageExecutionRecord | null {
    const row = this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM stage_executions
        WHERE job_id = ? AND stage = ? AND attempt_id = ?`,
    ).get(jobId, stage, attemptId) as StageExecutionRow | undefined;
    return row ? projectRow(row) : null;
  }

  /** Every stage attempt of one job, oldest first. */
  public listStageExecutions(jobId: string, requestedLimit = 200): StageExecutionRecord[] {
    const limit = Math.min(Math.max(1, Math.trunc(requestedLimit)), 500);
    const rows = this.db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM stage_executions
        WHERE job_id = ? ORDER BY started_at ASC, id ASC LIMIT ?`,
    ).all(boundedIdSchema.parse(jobId), limit) as StageExecutionRow[];
    return rows.map(projectRow);
  }
}

export type StageSpendSummary = Readonly<{
  attempts: number;
  escalatedAttempts: number;
  totalTokens: number;
  /** Null when no attempt in the set had a priced model. */
  costMicroUsd: number | null;
  durationMs: number;
}>;

/** Rolls a job's ledger into the one line a reader actually wants. */
export function summariseStageSpend(records: readonly StageExecutionRecord[]): StageSpendSummary {
  const priced = records.filter((record) => record.costMicroUsd !== null);
  return Object.freeze({
    attempts: records.length,
    escalatedAttempts: records.filter((record) => record.escalated).length,
    totalTokens: records.reduce((total, record) => total + (record.usage?.totalTokens ?? 0), 0),
    costMicroUsd: priced.length === 0
      ? null
      : priced.reduce((total, record) => total + (record.costMicroUsd ?? 0), 0),
    durationMs: records.reduce((total, record) => total + (record.durationMs ?? 0), 0),
  });
}
