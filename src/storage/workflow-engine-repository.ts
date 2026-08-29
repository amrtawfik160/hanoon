import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  NAVIGATOR_DETERMINISTIC_CATEGORIES,
  NAVIGATOR_ENGINE_ID,
  NAVIGATOR_LIVE_SCENARIOS,
  NAVIGATOR_SAFETY_COUNTERS,
  RECIPE_ENGINE_ID,
  type AppendWorkflowEngineRolloutDecisionInput,
  type NavigatorDeterministicCategory,
  type NavigatorLiveScenario,
  type NavigatorSafetyCounter,
  type WorkflowEngineRolloutDecision,
} from "../navigator/promotion";
import {
  navigatorCorpusRecordDigest,
  navigatorDeterministicRecordDigest,
  navigatorLiveRecordDigest,
  navigatorModelReferenceRecordDigest,
  navigatorSafetyRecordDigest,
} from "../navigator/promotion-evidence";
import { readDurableNavigatorPromotionEvidenceSnapshot } from "./navigator-promotion-evidence-snapshot";
import { JOB_SELECT, parseJobRow as parseJob, type JobRow } from "./job-persistence";
import type { Job } from "../domain/models";

type SqliteDatabase = Database.Database;

const boundedIdSchema = z.string().min(1).max(256);
const boundedKeySchema = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const nonNegativeIntegerSchema = z.number().int().nonnegative().safe();

const appendDecisionSchema = z.object({
  action: z.enum(["promote", "rollback"]),
  reasonCode: boundedKeySchema,
  evidenceDigest: sha256Schema.nullable(),
  now: nonNegativeIntegerSchema,
}).strict().superRefine((value, context) => {
  if (value.action === "promote") {
    if (value.reasonCode !== "promotion_gates_passed") {
      context.addIssue({ code: "custom", message: "Promotion requires the passed-gates reason" });
    }
    if (value.evidenceDigest === null) {
      context.addIssue({ code: "custom", message: "Promotion requires an evidence digest" });
    }
  } else if (value.evidenceDigest !== null) {
    context.addIssue({ code: "custom", message: "Rollback cannot claim promotion evidence" });
  }
});

type DecisionRow = {
  id: string;
  engine: typeof NAVIGATOR_ENGINE_ID;
  action: "promote" | "rollback";
  reason_code: string;
  evidence_digest: string | null;
  subject_id: string;
  created_at: number;
};

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/u.test(error.message);
}

function parseDecision(row: DecisionRow): WorkflowEngineRolloutDecision {
  const prefix = `rollout:${NAVIGATOR_ENGINE_ID}:`;
  if (row.engine !== NAVIGATOR_ENGINE_ID || !row.subject_id.startsWith(prefix)) {
    throw new TypeError("Persisted workflow engine rollout identity is invalid");
  }
  const suffix = row.subject_id.slice(prefix.length);
  if (suffix.startsWith("promote:")) {
    const [evidenceDigestValue, decisionToken, ...extra] = suffix.slice("promote:".length).split(":");
    if (extra.length > 0 || decisionToken === undefined) {
      throw new TypeError("Persisted workflow engine promotion subject identity is invalid");
    }
    const evidenceDigest = sha256Schema.parse(evidenceDigestValue);
    boundedIdSchema.parse(decisionToken);
    if (row.action !== "promote" || row.reason_code !== "promotion_gates_passed") {
      throw new TypeError("Persisted workflow engine promotion reason is invalid");
    }
    return {
      id: row.id,
      engine: NAVIGATOR_ENGINE_ID,
      action: "promote",
      reasonCode: row.reason_code,
      evidenceDigest,
      createdAt: row.created_at,
    };
  }
  if (!suffix.startsWith("rollback:")) throw new TypeError("Persisted workflow engine rollout action is invalid");
  boundedIdSchema.parse(suffix.slice("rollback:".length));
  return {
    id: row.id,
    engine: NAVIGATOR_ENGINE_ID,
    action: "rollback",
    reasonCode: boundedKeySchema.parse(row.reason_code),
    evidenceDigest: null,
    createdAt: row.created_at,
  };
}

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

  public appendWorkflowEngineRolloutDecision(
    rawInput: AppendWorkflowEngineRolloutDecisionInput,
  ): WorkflowEngineRolloutDecision {
    const input = appendDecisionSchema.parse(rawInput);
    const subjectId = input.action === "promote"
      ? `rollout:${NAVIGATOR_ENGINE_ID}:promote:${input.evidenceDigest ?? ""}:${randomUUID()}`
      : `rollout:${NAVIGATOR_ENGINE_ID}:rollback:${randomUUID()}`;
    const id = `engine_rollout:${randomUUID()}`;
    try {
      this.db.prepare(
        `INSERT INTO workflow_engine_promotions (
           id, engine, action, reason_code, evidence_digest, subject_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, NAVIGATOR_ENGINE_ID, input.action, input.reasonCode, input.evidenceDigest, subjectId, input.now);
    } catch (error) {
      if (input.action !== "promote" || !isUniqueConstraint(error)) throw error;
    }
    const row = this.db.prepare(
      `SELECT id, engine, action, reason_code, evidence_digest, subject_id, created_at
         FROM workflow_engine_promotions WHERE subject_id = ?`,
    ).get(subjectId) as DecisionRow | undefined;
    if (!row) throw new Error("Workflow engine rollout decision disappeared after persistence");
    const decision = parseDecision(row);
    if (
      decision.action !== input.action || decision.reasonCode !== input.reasonCode ||
      decision.evidenceDigest !== input.evidenceDigest
    ) {
      throw new TypeError("Workflow engine rollout decision conflicts with its durable identity");
    }
    return decision;
  }

  public listWorkflowEngineRolloutDecisions(requestedLimit: number): WorkflowEngineRolloutDecision[] {
    const limit = z.number().int().positive().max(1_000).parse(requestedLimit);
    const rows = this.db.prepare(
      `SELECT id, engine, action, reason_code, evidence_digest, subject_id, created_at
         FROM (
           SELECT rowid AS sequence, id, engine, action, reason_code, evidence_digest, subject_id, created_at
             FROM workflow_engine_promotions
            ORDER BY created_at DESC, rowid DESC LIMIT ?
         )
        ORDER BY created_at ASC, sequence ASC`,
    ).all(limit) as DecisionRow[];
    return rows.map(parseDecision);
  }

  public getLatestWorkflowEngineRolloutDecision(): WorkflowEngineRolloutDecision | null {
    const row = this.db.prepare(
      `SELECT id, engine, action, reason_code, evidence_digest, subject_id, created_at
         FROM workflow_engine_promotions
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get() as DecisionRow | undefined;
    return row ? parseDecision(row) : null;
  }

  public readDurableNavigatorPromotionEvidenceSnapshot(): unknown | null {
    return readDurableNavigatorPromotionEvidenceSnapshot(this.db);
  }

  public recordNavigatorDeterministicEvidence(input: Readonly<{
    category: NavigatorDeterministicCategory;
    suiteId: string;
    runId: string;
    artifactDigest: string;
    outcome: "passed" | "failed";
    now: number;
  }>): string {
    const category = z.enum(NAVIGATOR_DETERMINISTIC_CATEGORIES).parse(input.category);
    const suiteId = boundedIdSchema.parse(input.suiteId);
    const runId = boundedIdSchema.parse(input.runId);
    const artifactDigest = sha256Schema.parse(input.artifactDigest);
    const outcome = z.enum(["passed", "failed"]).parse(input.outcome);
    const createdAt = nonNegativeIntegerSchema.parse(input.now);
    const recordDigest = navigatorDeterministicRecordDigest({
      category, suiteId, runId, artifactDigest, outcome, createdAt,
    });
    const id = `nav-det-${category}`;
    try {
      this.db.prepare(
        `INSERT INTO navigator_deterministic_evidence (
           id, category, suite_id, run_id, artifact_digest, outcome, record_digest, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, category, suiteId, runId, artifactDigest, outcome, recordDigest, createdAt);
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
    }
    const stored = this.db.prepare(
      `SELECT id, category, suite_id AS suiteId, run_id AS runId, artifact_digest AS artifactDigest,
              outcome, record_digest AS recordDigest, created_at AS createdAt
         FROM navigator_deterministic_evidence WHERE category = ?`,
    ).get(category) as {
      id: string; category: string; suiteId: string; runId: string; artifactDigest: string;
      outcome: string; recordDigest: string; createdAt: number;
    } | undefined;
    if (!stored || stored.recordDigest !== recordDigest) {
      throw new TypeError("Navigator deterministic evidence conflicts with its durable identity");
    }
    return stored.id;
  }

  public recordNavigatorCorpusEvidence(input: Readonly<{
    corpusDigest: string;
    runId: string;
    resultDigest: string;
    total: number;
    correct: number;
    unauthorizedEffects: number;
    now: number;
  }>): string {
    const corpusDigest = sha256Schema.parse(input.corpusDigest);
    const runId = boundedIdSchema.parse(input.runId);
    const resultDigest = sha256Schema.parse(input.resultDigest);
    const total = z.number().int().positive().max(100_000).parse(input.total);
    const correct = z.number().int().nonnegative().max(100_000).parse(input.correct);
    const unauthorizedEffects = nonNegativeIntegerSchema.parse(input.unauthorizedEffects);
    const createdAt = nonNegativeIntegerSchema.parse(input.now);
    if (correct > total) throw new TypeError("Corpus correct count cannot exceed the fixed corpus size");
    const recordDigest = navigatorCorpusRecordDigest({
      corpusDigest, runId, resultDigest, total, correct, unauthorizedEffects, createdAt,
    });
    const id = "nav-corpus";
    try {
      this.db.prepare(
        `INSERT INTO navigator_corpus_evidence (
           id, corpus_digest, run_id, result_digest, total, correct, unauthorized_effects,
           record_digest, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, corpusDigest, runId, resultDigest, total, correct, unauthorizedEffects, recordDigest, createdAt);
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
    }
    const stored = this.db.prepare(
      "SELECT id, record_digest AS recordDigest FROM navigator_corpus_evidence WHERE id = ?",
    ).get(id) as { id: string; recordDigest: string } | undefined;
    if (!stored || stored.recordDigest !== recordDigest) {
      throw new TypeError("Navigator corpus evidence conflicts with its durable identity");
    }
    return stored.id;
  }

  public recordNavigatorLiveEvidence(input: Readonly<{
    runId: string;
    jobId: string;
    scenario: NavigatorLiveScenario;
    terminalState: "complete" | "merged" | "cancelled";
    evidenceDigest: string;
    now: number;
  }>): string {
    const runId = boundedIdSchema.parse(input.runId);
    const jobId = boundedIdSchema.parse(input.jobId);
    const scenario = z.enum(NAVIGATOR_LIVE_SCENARIOS).parse(input.scenario);
    const terminalState = z.enum(["complete", "merged", "cancelled"]).parse(input.terminalState);
    const evidenceDigest = sha256Schema.parse(input.evidenceDigest);
    const createdAt = nonNegativeIntegerSchema.parse(input.now);
    const job = this.db.prepare(
      "SELECT workflow_engine, state FROM jobs WHERE id = ?",
    ).get(jobId) as { workflow_engine: string; state: string } | undefined;
    if (!job || job.workflow_engine !== NAVIGATOR_ENGINE_ID || job.state !== terminalState) {
      throw new TypeError("Navigator live evidence is not bound to a matching navigator job");
    }
    const recordDigest = navigatorLiveRecordDigest({
      runId, jobId, scenario, terminalState, evidenceDigest, createdAt,
    });
    const id = `nav-live-${scenario}`;
    try {
      this.db.prepare(
        `INSERT INTO navigator_live_evidence (
           id, run_id, job_id, scenario, terminal_state, evidence_digest, record_digest, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, runId, jobId, scenario, terminalState, evidenceDigest, recordDigest, createdAt);
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
    }
    const stored = this.db.prepare(
      "SELECT id, record_digest AS recordDigest FROM navigator_live_evidence WHERE scenario = ?",
    ).get(scenario) as { id: string; recordDigest: string } | undefined;
    if (!stored || stored.recordDigest !== recordDigest) {
      throw new TypeError("Navigator live evidence conflicts with its durable identity");
    }
    return stored.id;
  }

  public recordNavigatorModelTrialEvidence(input: Readonly<{
    cohort: "candidate" | "baseline";
    modelTrialId: string;
    harnessDigest: string;
    budgetDigest: string;
    now: number;
  }>): string {
    const cohort = z.enum(["candidate", "baseline"]).parse(input.cohort);
    const modelTrialId = boundedIdSchema.parse(input.modelTrialId);
    const harnessDigest = sha256Schema.parse(input.harnessDigest);
    const budgetDigest = sha256Schema.parse(input.budgetDigest);
    const createdAt = nonNegativeIntegerSchema.parse(input.now);
    const trial = this.db.prepare("SELECT id FROM model_route_trials WHERE id = ?").get(modelTrialId);
    if (!trial) throw new TypeError("Navigator model trial evidence is not bound to a model route trial");
    const recordDigest = navigatorModelReferenceRecordDigest({
      cohort, modelTrialId, harnessDigest, budgetDigest, createdAt,
    });
    const id = `nav-model-${cohort}-${modelTrialId}`.slice(0, 256);
    try {
      this.db.prepare(
        `INSERT INTO navigator_model_trial_evidence (
           id, cohort, model_trial_id, harness_digest, budget_digest, record_digest, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, cohort, modelTrialId, harnessDigest, budgetDigest, recordDigest, createdAt);
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
    }
    const stored = this.db.prepare(
      `SELECT id, record_digest AS recordDigest FROM navigator_model_trial_evidence
        WHERE cohort = ? AND model_trial_id = ?`,
    ).get(cohort, modelTrialId) as { id: string; recordDigest: string } | undefined;
    if (!stored || stored.recordDigest !== recordDigest) {
      throw new TypeError("Navigator model trial evidence conflicts with its durable identity");
    }
    return stored.id;
  }

  public recordNavigatorSafetyEvidence(input: Readonly<{
    counter: NavigatorSafetyCounter;
    count: number;
    snapshotId: string;
    evidenceDigest: string;
    now: number;
  }>): string {
    const counter = z.enum(NAVIGATOR_SAFETY_COUNTERS).parse(input.counter);
    const count = nonNegativeIntegerSchema.parse(input.count);
    const snapshotId = boundedIdSchema.parse(input.snapshotId);
    const evidenceDigest = sha256Schema.parse(input.evidenceDigest);
    const createdAt = nonNegativeIntegerSchema.parse(input.now);
    const recordDigest = navigatorSafetyRecordDigest({
      counter, count, snapshotId, evidenceDigest, createdAt,
    });
    const id = `nav-safety-${counter}`;
    try {
      this.db.prepare(
        `INSERT INTO navigator_safety_evidence (
           id, counter, counter_count, snapshot_id, evidence_digest, record_digest, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, counter, count, snapshotId, evidenceDigest, recordDigest, createdAt);
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
    }
    const stored = this.db.prepare(
      "SELECT id, record_digest AS recordDigest FROM navigator_safety_evidence WHERE counter = ?",
    ).get(counter) as { id: string; recordDigest: string } | undefined;
    if (!stored || stored.recordDigest !== recordDigest) {
      throw new TypeError("Navigator safety evidence conflicts with its durable identity");
    }
    return stored.id;
  }

  public publishNavigatorPromotionManifest(input: Readonly<{
    deterministicIds: readonly string[];
    corpusId: string | null;
    liveRunIds: readonly string[];
    candidateModelRefIds: readonly string[];
    baselineModelRefIds: readonly string[];
    safetyIds: readonly string[];
    reviewed: boolean;
    now: number;
  }>): string {
    const deterministicIds = z.array(boundedIdSchema).max(NAVIGATOR_DETERMINISTIC_CATEGORIES.length)
      .parse(input.deterministicIds);
    const corpusId = input.corpusId === null ? null : boundedIdSchema.parse(input.corpusId);
    const liveRunIds = z.array(boundedIdSchema).max(NAVIGATOR_LIVE_SCENARIOS.length).parse(input.liveRunIds);
    const candidateModelRefIds = z.array(boundedIdSchema).max(100).parse(input.candidateModelRefIds);
    const baselineModelRefIds = z.array(boundedIdSchema).max(100).parse(input.baselineModelRefIds);
    const safetyIds = z.array(boundedIdSchema).max(NAVIGATOR_SAFETY_COUNTERS.length).parse(input.safetyIds);
    const createdAt = nonNegativeIntegerSchema.parse(input.now);
    const id = `nav-manifest:${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO navigator_promotion_evidence_manifests (
         id, deterministic_ids_json, corpus_id, live_run_ids_json,
         candidate_model_ref_ids_json, baseline_model_ref_ids_json, safety_ids_json,
         reviewed, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      JSON.stringify(deterministicIds),
      corpusId,
      JSON.stringify(liveRunIds),
      JSON.stringify(candidateModelRefIds),
      JSON.stringify(baselineModelRefIds),
      JSON.stringify(safetyIds),
      input.reviewed ? 1 : 0,
      createdAt,
    );
    return id;
  }

  public listNonterminalRecipeJobs(): Job[] {
    const placeholders = RECIPE_TERMINAL_STATES.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `${JOB_SELECT}
        WHERE workflow_engine = 'recipe-v1'
          AND state NOT IN (${placeholders})
        ORDER BY created_at ASC, id ASC`,
    ).all(...RECIPE_TERMINAL_STATES) as JobRow[];
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
