import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  NAVIGATOR_ENGINE_ID,
  RECIPE_ENGINE_ID,
} from "../navigator/models";
import { JOB_SELECT, parseJobRow as parseJob, type JobRow } from "./job-persistence";
import type { Job } from "../domain/models";

type SqliteDatabase = Database.Database;

const boundedIdSchema = z.string().min(1).max(256);
const nonNegativeIntegerSchema = z.number().int().nonnegative().safe();

const RECIPE_TERMINAL_STATES = ["cancelled", "complete", "merged", "production_failed"] as const;

export class DualEngineContractionError extends Error {
  public constructor(public readonly remainingJobIds: readonly string[]) {
    super("Recipe-v1 jobs remain before contraction; remaining jobs still require a legacy skill or state handler");
    this.name = "DualEngineContractionError";
  }
}

export type WorkflowEngineContraction = Readonly<{
  id: string;
  engine: typeof RECIPE_ENGINE_ID;
  remainingJobIds: readonly [];
  createdAt: number;
}>;

export class WorkflowEngineRepository {
  public constructor(private readonly db: SqliteDatabase) {}

  public listNonterminalRecipeJobs(): Job[] {
    const placeholders = RECIPE_TERMINAL_STATES.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `${JOB_SELECT}
        WHERE workflow_engine = ?
          AND state NOT IN (${placeholders})
        ORDER BY created_at ASC, id ASC`,
    ).all(RECIPE_ENGINE_ID, ...RECIPE_TERMINAL_STATES) as JobRow[];
    return rows.map(parseJob);
  }

  public getLatestWorkflowEngineContraction(): WorkflowEngineContraction | null {
    const row = this.db.prepare(
      `SELECT id, engine, remaining_job_ids_json, created_at
         FROM workflow_engine_contractions
        WHERE engine = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
    ).get(RECIPE_ENGINE_ID) as {
      id: string;
      engine: typeof RECIPE_ENGINE_ID;
      remaining_job_ids_json: string;
      created_at: number;
    } | undefined;
    if (!row) return null;
    const remainingJobIds = z.tuple([]).parse(JSON.parse(row.remaining_job_ids_json));
    return {
      id: boundedIdSchema.parse(row.id),
      engine: RECIPE_ENGINE_ID,
      remainingJobIds,
      createdAt: row.created_at,
    };
  }

  public contractRecipeEngine(now: number): WorkflowEngineContraction {
    const remaining = this.listNonterminalRecipeJobs();
    if (remaining.length > 0) {
      throw new DualEngineContractionError(remaining.map((job) => job.id));
    }
    const existing = this.getLatestWorkflowEngineContraction();
    if (existing) return existing;
    const createdAt = nonNegativeIntegerSchema.parse(now);
    const id = `engine_contract:${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO workflow_engine_contractions (id, engine, remaining_job_ids_json, created_at)
       VALUES (?, ?, '[]', ?)`,
    ).run(id, RECIPE_ENGINE_ID, createdAt);
    return { id, engine: RECIPE_ENGINE_ID, remainingJobIds: [], createdAt };
  }
}
