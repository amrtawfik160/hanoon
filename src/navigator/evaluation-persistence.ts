import type Database from "better-sqlite3";
import { projectResourceKey, productionResourceKey } from "../autonomy/models";
import type { Job, JobState, StoredEffect } from "../domain/models";
import { EffectRunner } from "../services/effect-runner";
import type { ProductionPhase, ProductionStageSnapshot } from "../services/production-runner";
import type { TelegramAgentStore } from "../storage/store";
import type { CaptureWorkArtifactInput, WorkArtifactCapture } from "../work-artifacts/repository";
import type { WorkArtifact, WorkArtifactClaim, WorkArtifactSnapshot } from "../work-artifacts/models";
import type { NavigatorProposalDecision, NavigatorSnapshot } from "./models";
import type { NavigatorEffectPersistence } from "./effect-persistence";
import type { NavigatorImplementationReadStore } from "./implementation-executor";

type NavigatorEvaluationStore = Pick<TelegramAgentStore,
  | "captureWorkArtifact"
  | "createJob"
  | "applyJobEvent"
  | "bindNavigatorJobArtifacts"
  | "createNavigatorSnapshot"
  | "recordNavigatorProposal"
  | "listEffectsForJob"
  | "getJob"
  | "getWorkArtifact"
  | "getCurrentWorkArtifactSnapshot"
  | "observeWorkArtifact"
  | "claimWorkArtifact"
  | "prepareWorkArtifactCreateIntent"
  | "acquireExecutorLease"
  | "releaseExecutorLease"
  | "leaseNextJobEffect"
  | "completeEffect"
  | "countNavigatorReleaseIncidents"
> & NavigatorImplementationReadStore;

type EvaluationFacts = Readonly<{
  jobId: string;
  taskOutcome?: string | null;
  state?: JobState;
}>;

type RestartProductionState = Readonly<{
  jobId: string;
  ownerId: string;
  generation: number;
  now: number;
  state: Extract<JobState, "deploying" | "verifying_production">;
}>;

type EvaluationProductionInput = Readonly<{
  jobId: string;
  ownerId: string;
  generation: number;
  now: () => number;
  runProductionStage: (phase: ProductionPhase) => Promise<ProductionStageSnapshot>;
}>;

export type NavigatorEvaluationPersistence = NavigatorEvaluationStore & Readonly<{
  setEvaluationJobFacts(input: EvaluationFacts): void;
  holdEvaluationProjectClaim(input: Readonly<{
    jobId: string;
    projectId: string;
    ownerId: string;
    generation: number;
    now: number;
    leaseMs: number;
  }>): void;
  seedNavigatorProductionState(input: RestartProductionState): void;
  countNavigatorProposals(jobId: string): number;
  countWorkArtifactClaims(artifactId: string): number;
  countWorkArtifactCreateIntents(operationId: string): number;
  countWorkArtifactCreateIntentsForEffort(effortId: string): number;
  countNavigatorImplementationAttempts(jobId: string): number;
  countNavigatorImplementationOutcomes(jobId: string): number;
  countNavigatorIntegrationHeads(jobId: string): number;
  countNavigatorGitObservationRejections(jobId: string): number;
  countNavigatorReleaseIncidentsByPhase(jobId: string, phase: "deploy" | "canary"): number;
  countNavigatorSuccessfulRollbacks(jobId: string): number;
  countNavigatorReleaseFindings(jobId: string): number;
  countNavigatorRepairProposals(jobId: string): number;
  runNavigatorProductionEffect(input: EvaluationProductionInput): Promise<void>;
}>;

function rowCount(database: Database.Database, sql: string, params: readonly unknown[]): number {
  const row = database.prepare(sql).get(...params) as { count?: unknown } | undefined;
  return typeof row?.count === "number" ? row.count : 0;
}

function setEvaluationJobFacts(database: Database.Database, input: EvaluationFacts): void {
  database.transaction(() => {
    if (input.taskOutcome !== undefined) {
      database.prepare(
        "UPDATE jobs SET task_outcome = ?, task_constraints_json = ? WHERE id = ?",
      ).run(input.taskOutcome, JSON.stringify([]), input.jobId);
    }
    if (input.state !== undefined) {
      database.prepare("UPDATE jobs SET state = ? WHERE id = ?").run(input.state, input.jobId);
    }
  })();
}

function holdEvaluationProjectClaim(
  database: Database.Database,
  input: Readonly<{
    jobId: string;
    projectId: string;
    ownerId: string;
    generation: number;
    now: number;
    leaseMs: number;
  }>,
): void {
  database.transaction(() => {
    const held = database.prepare(
      "SELECT 1 FROM job_resource_claims WHERE job_id = ? AND resource_key = ? AND state = 'held' LIMIT 1",
    ).get(input.jobId, projectResourceKey(input.projectId));
    if (held) return;
    database.prepare(
      `INSERT INTO job_resource_claims (
         job_id, resource_key, resource_kind, state, owner_id, generation,
         lease_expires_at, acquired_at, renewed_at, released_at, release_reason
       ) VALUES (?, ?, 'project', 'held', ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      input.jobId,
      projectResourceKey(input.projectId),
      input.ownerId,
      input.generation,
      input.now + input.leaseMs,
      input.now,
      input.now,
    );
  })();
}

function seedNavigatorProductionState(
  database: Database.Database,
  store: Pick<TelegramAgentStore, "getJob">,
  input: RestartProductionState,
): void {
  const job = store.getJob(input.jobId);
  if (!job?.policy || !job.projectId) throw new Error("restart production job is missing");
  const projectId = job.projectId;
  const policy = job.policy;
  database.transaction(() => {
    database.prepare(
      `UPDATE jobs SET state = ?, environment_id = 'env_eval_restart', pr_number = 43,
         pr_url = 'https://github.com/acme/eval/pull/43', pr_head_sha = ?,
         merge_message = 'Merged pull request #43', merge_commit_sha = ?,
         merged_at = '2026-08-10T00:00:00.000Z', version = version + 1
       WHERE id = ?`,
    ).run(input.state, "2".repeat(40), "d".repeat(40), input.jobId);
    database.prepare("UPDATE effects SET status = 'done' WHERE job_id = ?").run(input.jobId);
    database.prepare(
      "UPDATE job_admissions SET project_id = ?, state = 'admitted', admitted_at = ? WHERE job_id = ?",
    ).run(job.projectId, input.now, input.jobId);
    const held = database.prepare(
      "SELECT 1 FROM job_resource_claims WHERE job_id = ? AND state = 'held' LIMIT 1",
    ).get(input.jobId);
    if (!held) {
      const insertClaim = database.prepare(
        `INSERT INTO job_resource_claims (
           job_id, resource_key, resource_kind, state, owner_id, generation,
           lease_expires_at, acquired_at, renewed_at
         ) VALUES (?, ?, ?, 'held', ?, ?, ?, ?, ?)`,
      );
      insertClaim.run(
        input.jobId,
        projectResourceKey(projectId),
        "project",
        input.ownerId,
        input.generation,
        input.now + 100_000,
        input.now,
        input.now,
      );
      insertClaim.run(
        input.jobId,
        productionResourceKey(policy),
        "production_target",
        input.ownerId,
        input.generation,
        input.now + 100_000,
        input.now,
        input.now,
      );
    }
    const current = store.getJob(input.jobId);
    if (!current) throw new Error("restart production job disappeared");
    const kind = input.state === "deploying" ? "deploy_production" : "verify_production";
    const key = `${current.id}:${current.version + 1}:${kind}`;
    database.prepare(
      `INSERT INTO effects (
         idempotency_key, job_id, kind, payload_json, status, attempts,
         next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, ?, '{}', 'pending', 0, ?, ?, ?)`,
    ).run(key, current.id, kind, input.now, input.now, input.now);
  })();
}

async function runNavigatorProductionEffect(
  store: TelegramAgentStore,
  input: EvaluationProductionInput,
): Promise<void> {
  const fence = {
    ownerId: input.ownerId,
    generation: input.generation,
    signal: new AbortController().signal,
  };
  const lease = () => store.leaseNextJobEffect({
    jobId: input.jobId,
    ownerId: input.ownerId,
    generation: input.generation,
    now: input.now(),
    leaseMs: 30_000,
  });
  let claimed = lease();
  while (claimed?.kind === "render_status") {
    store.completeEffect(claimed.idempotencyKey, input.ownerId, input.generation, input.now());
    claimed = lease();
  }
  if (!claimed) return;
  const firstKey = claimed.idempotencyKey;
  const firstKind = claimed.kind;
  const run = (effect: StoredEffect) => new EffectRunner({
    store,
    fence,
    now: input.now,
    runProductionStage: async (_job, _effect, phase) => input.runProductionStage(phase),
  }).run(effect);
  await run(claimed);
  store.completeEffect(claimed.idempotencyKey, input.ownerId, input.generation, input.now());
  let replay = lease();
  while (replay?.kind === "render_status") {
    store.completeEffect(replay.idempotencyKey, input.ownerId, input.generation, input.now());
    replay = lease();
  }
  if (replay && replay.kind === firstKind && replay.idempotencyKey !== firstKey) {
    await run(replay);
    store.completeEffect(replay.idempotencyKey, input.ownerId, input.generation, input.now());
  }
}

export function createNavigatorEvaluationPersistence(
  store: TelegramAgentStore,
  database: Database.Database,
): NavigatorEvaluationPersistence {
  return {
    captureWorkArtifact: (input: CaptureWorkArtifactInput): WorkArtifactCapture => store.captureWorkArtifact(input),
    createJob: (input) => store.createJob(input),
    applyJobEvent: (jobId, expectedVersion, event, now) => store.applyJobEvent(jobId, expectedVersion, event, now),
    bindNavigatorJobArtifacts: (input) => store.bindNavigatorJobArtifacts(input),
    createNavigatorSnapshot: (input): NavigatorSnapshot => store.createNavigatorSnapshot(input),
    recordNavigatorProposal: (input): NavigatorProposalDecision => store.recordNavigatorProposal(input),
    listEffectsForJob: (jobId) => store.listEffectsForJob(jobId),
    getJob: (jobId) => store.getJob(jobId),
    getWorkArtifact: (id): WorkArtifact | null => store.getWorkArtifact(id),
    getCurrentWorkArtifactSnapshot: (artifactId): WorkArtifactSnapshot | null => store.getCurrentWorkArtifactSnapshot(artifactId),
    isWorkArtifactSnapshotValid: (snapshotId) => store.isWorkArtifactSnapshotValid(snapshotId),
    observeWorkArtifact: (input) => store.observeWorkArtifact(input),
    claimWorkArtifact: (input): WorkArtifactClaim | null => store.claimWorkArtifact(input),
    prepareWorkArtifactCreateIntent: (input) => store.prepareWorkArtifactCreateIntent(input),
    acquireExecutorLease: (ownerId, now, leaseMs) => store.acquireExecutorLease(ownerId, now, leaseMs),
    releaseExecutorLease: (ownerId, generation, now) => store.releaseExecutorLease(ownerId, generation, now),
    leaseNextJobEffect: (input) => store.leaseNextJobEffect(input),
    completeEffect: (key, ownerId, generation, now) => store.completeEffect(key, ownerId, generation, now),
    countNavigatorReleaseIncidents: (input) => store.countNavigatorReleaseIncidents(input),
    setEvaluationJobFacts: (input) => setEvaluationJobFacts(database, input),
    holdEvaluationProjectClaim: (input) => holdEvaluationProjectClaim(database, input),
    seedNavigatorProductionState: (input) => seedNavigatorProductionState(database, store, input),
    countNavigatorProposals: (jobId) => rowCount(
      database,
      "SELECT COUNT(*) AS count FROM navigator_proposals WHERE job_id = ?",
      [jobId],
    ),
    countWorkArtifactClaims: (artifactId) => rowCount(
      database,
      "SELECT COUNT(*) AS count FROM work_artifact_claims WHERE artifact_id = ?",
      [artifactId],
    ),
    countWorkArtifactCreateIntents: (operationId) => rowCount(
      database,
      "SELECT COUNT(*) AS count FROM work_artifact_create_intents WHERE operation_id = ?",
      [operationId],
    ),
    countWorkArtifactCreateIntentsForEffort: (effortId) => rowCount(
      database,
      "SELECT COUNT(*) AS count FROM work_artifact_create_intents WHERE effort_id = ?",
      [effortId],
    ),
    countNavigatorImplementationAttempts: (jobId) => rowCount(
      database,
      "SELECT COUNT(*) AS count FROM navigator_ticket_worker_attempts WHERE job_id = ? AND kind = 'implementation'",
      [jobId],
    ),
    countNavigatorImplementationOutcomes: (jobId) => rowCount(
      database,
      `SELECT COUNT(*) AS count
         FROM navigator_ticket_worker_outcomes AS outcome
         JOIN navigator_ticket_worker_attempts AS attempt ON attempt.id = outcome.attempt_id
        WHERE attempt.job_id = ? AND attempt.kind = 'implementation'`,
      [jobId],
    ),
    countNavigatorIntegrationHeads: (jobId) => rowCount(
      database,
      "SELECT COUNT(DISTINCT current_head_sha) AS count FROM navigator_integrations WHERE job_id = ?",
      [jobId],
    ),
    countNavigatorGitObservationRejections: (jobId) => rowCount(
      database,
      `SELECT COUNT(*) AS count
         FROM navigator_ticket_worker_outcomes AS outcome
         JOIN navigator_ticket_worker_attempts AS attempt ON attempt.id = outcome.attempt_id
        WHERE attempt.job_id = ? AND outcome.reason_code = 'git_observation_rejected'`,
      [jobId],
    ),
    countNavigatorReleaseIncidentsByPhase: (jobId, phase) => rowCount(
      database,
      "SELECT COUNT(*) AS count FROM navigator_release_incidents WHERE job_id = ? AND phase = ?",
      [jobId, phase],
    ),
    countNavigatorSuccessfulRollbacks: (jobId) => rowCount(
      database,
      "SELECT COUNT(*) AS count FROM navigator_release_incidents WHERE job_id = ? AND rollback_outcome = 'pass'",
      [jobId],
    ),
    countNavigatorReleaseFindings: (jobId) => rowCount(
      database,
      "SELECT COUNT(*) AS count FROM navigator_release_findings WHERE job_id = ?",
      [jobId],
    ),
    countNavigatorRepairProposals: (jobId) => rowCount(
      database,
      `SELECT COUNT(*) AS count
         FROM navigator_ticket_repair_proposals AS proposal
         JOIN navigator_ticket_repair_snapshots AS snapshot ON snapshot.id = proposal.snapshot_id
        WHERE snapshot.job_id = ?`,
      [jobId],
    ),
    runNavigatorProductionEffect: (input) => runNavigatorProductionEffect(store, input),
  };
}
