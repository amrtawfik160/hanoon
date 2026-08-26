import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ModelRoute } from "../capabilities/models";
import type { StoredEffect } from "../domain/models";
import type { EffectFence } from "../services/effect-runner";
import type { TelegramAgentStore } from "../storage/store";
import type { WorkArtifactClaim } from "../work-artifacts/models";
import {
  NAVIGATOR_TICKET_STEP_CONTRACTS,
  navigatorCodeReviewResultSchema,
  navigatorImplementationResultSchema,
  navigatorJsonDigest,
  navigatorPullRequestRequestSchema,
  navigatorTicketWorkerProfile,
  navigatorTicketWorkerProfileSchema,
  navigatorTicketWorkerResultSchema,
  navigatorTicketWorkOrderSchema,
  parseNavigatorTicketModelRoute,
  type NavigatorPullRequestRecord,
  type NavigatorPullRequestRequest,
  type NavigatorTicketStepContract,
  type NavigatorTicketTaskEvidence,
  type NavigatorTicketWorkerProfile,
  type NavigatorTicketWorkerResult,
  type NavigatorTicketWorkOrder,
} from "./implementation-contracts";
import { artifactBindingSchema, type NavigatorArtifactBinding } from "./models";

const GIT_SHA = /^[0-9a-f]{40}$/u;
const IDENTIFIER = /^[A-Za-z0-9_.:/-]{1,256}$/u;

export type NavigatorTicketWorkerAttempt = Readonly<{
  id: string;
  jobId: string;
  sliceId: string;
  kind: "implementation" | "review";
  ordinal: number;
  effectIdempotencyKey: string;
  workOrder: NavigatorTicketWorkOrder;
  workOrderDigest: string;
  stepContract: NavigatorTicketStepContract;
  profile: NavigatorTicketWorkerProfile;
  modelRoute: ModelRoute;
  resource: { kind: "bb_thread"; id: string } | null;
  createdAt: number;
  updatedAt: number;
}>;

export type NavigatorTicketWorkerOutcome = Readonly<{
  attemptId: string;
  sliceId: string;
  outcome: "succeeded" | "findings" | "worker_unavailable" | "policy_failure";
  reasonCode: string;
  exactHeadSha: string;
  result: unknown;
  resultDigest: string;
  recordedAt: number;
}>;

export type NavigatorIntegrationSnapshot = Readonly<{
  integration: Readonly<{
    jobId: string;
    specification: NavigatorArtifactBinding;
    baseBranch: string;
    integrationBranch: string;
    worktreeId: string;
    baseHeadSha: string;
    currentHeadSha: string;
    state: "implementing" | "invalidated" | "ready_for_pull_request" | "publishing_pull_request" | "ready_for_release";
    activeSliceId: string | null;
    pullRequestNumber: number | null;
    pullRequestUrl: string | null;
    evidenceRefs: readonly string[];
  }>;
  tickets: readonly Readonly<{
    artifactId: string;
    snapshotId: string;
    snapshotDigest: string;
    order: number;
    state: "pending" | "active" | "accepted" | "resolved" | "invalidated";
    acceptedHeadSha: string | null;
  }>[];
  activeSlice: Readonly<{
    id: string;
    ticketArtifactId: string;
    claimId: number;
    state: string;
    acceptedHeadSha: string | null;
  }> | null;
  attempts: readonly NavigatorTicketWorkerAttempt[];
  outcomes: readonly NavigatorTicketWorkerOutcome[];
}>;

export interface NavigatorTicketWorkerRunner {
  run(
    attempt: NavigatorTicketWorkerAttempt,
    hooks: Readonly<{ bindResource(resource: { kind: "bb_thread"; id: string }): Promise<void> }>,
    signal: AbortSignal,
  ): Promise<Readonly<{
    resource: { kind: "bb_thread"; id: string };
    result: unknown;
  }>>;
}

export class NavigatorTicketWorkerUnavailableError extends Error {
  public readonly name = "NavigatorTicketWorkerUnavailableError";

  public constructor(public readonly reason: "missing" | "stale") {
    super(`navigator ticket worker is ${reason}`);
  }
}

export interface NavigatorPullRequestPublisher {
  createOrRefresh(request: NavigatorPullRequestRequest): Promise<NavigatorPullRequestRecord>;
}

type AttemptRow = Readonly<{
  id: string;
  job_id: string;
  slice_id: string;
  kind: "implementation" | "review";
  ordinal: number;
  effect_idempotency_key: string;
  work_order_json: string;
  work_order_digest: string;
  step_contract_id: string;
  step_contract_revision: number;
  step_contract_digest: string;
  profile_json: string;
  profile_digest: string;
  model_route_json: string;
  resource_kind: "bb_thread" | null;
  resource_id: string | null;
  created_at: number;
  updated_at: number;
}>;

type IntegrationRow = Readonly<{
  job_id: string;
  specification_artifact_id: string;
  specification_snapshot_id: string;
  specification_snapshot_digest: string;
  base_branch: string;
  integration_branch: string;
  worktree_id: string;
  project_policy_version: number;
  project_policy_json: string;
  project_policy_digest: string;
  base_head_sha: string;
  current_head_sha: string;
  state: NavigatorIntegrationSnapshot["integration"]["state"];
  active_slice_id: string | null;
  pull_request_number: number | null;
  pull_request_url: string | null;
  evidence_refs_json: string;
}>;

type TicketRow = Readonly<{
  job_id: string;
  artifact_id: string;
  snapshot_id: string;
  snapshot_digest: string;
  ticket_order: number;
  state: NavigatorIntegrationSnapshot["tickets"][number]["state"];
  accepted_head_sha: string | null;
}>;

type SliceRow = Readonly<{
  id: string;
  job_id: string;
  ticket_artifact_id: string;
  ticket_snapshot_id: string;
  ticket_snapshot_digest: string;
  claim_id: number;
  integration_base_head_sha: string;
  state: string;
  accepted_head_sha: string | null;
}>;

type OutcomeRow = Readonly<{
  attempt_id: string;
  slice_id: string;
  outcome: NavigatorTicketWorkerOutcome["outcome"];
  reason_code: string;
  exact_head_sha: string;
  result_json: string;
  result_digest: string;
  recorded_at: number;
}>;

type NavigatorImplementationExecutorDependencies = Readonly<{
  store: TelegramAgentStore;
  database: Database.Database;
  workerRunner: NavigatorTicketWorkerRunner;
  pullRequests: NavigatorPullRequestPublisher;
  modelRoute(kind: "implementation" | "review"): ModelRoute;
  clock: { now(): number };
  leaseMs?: number;
}>;

function assertIdentifier(value: string, field: string): string {
  if (!IDENTIFIER.test(value)) throw new TypeError(`${field} is invalid`);
  return value;
}

function assertGitSha(value: string, field: string): string {
  if (!GIT_SHA.test(value)) throw new TypeError(`${field} must be a full Git SHA`);
  return value;
}

function boundedRefs(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > 128) throw new TypeError("evidenceRefs must be bounded");
  const refs = values.map((value) => {
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > 1_024) throw new TypeError("evidence ref is invalid");
    return normalized;
  });
  if (new Set(refs).size !== refs.length) throw new TypeError("evidence refs contain duplicates");
  return refs;
}

function mergeEvidenceRefs(...groups: readonly (readonly string[])[]): readonly string[] {
  return boundedRefs([...new Set(groups.flat())]);
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\0"), "utf8").digest("base64url").slice(0, 24)}`;
}

function parseAttempt(row: AttemptRow): NavigatorTicketWorkerAttempt {
  const workOrder = navigatorTicketWorkOrderSchema.parse(JSON.parse(row.work_order_json));
  const profile = navigatorTicketWorkerProfileSchema.parse(JSON.parse(row.profile_json));
  const stepContract = NAVIGATOR_TICKET_STEP_CONTRACTS[row.kind];
  if (
    navigatorJsonDigest(workOrder) !== row.work_order_digest ||
    stepContract.id !== row.step_contract_id ||
    stepContract.revision !== row.step_contract_revision ||
    stepContract.digest !== row.step_contract_digest ||
    profile.digest !== row.profile_digest
  ) {
    throw new Error(`navigator ticket attempt ${row.id} has invalid durable identity`);
  }
  return {
    id: row.id,
    jobId: row.job_id,
    sliceId: row.slice_id,
    kind: row.kind,
    ordinal: row.ordinal,
    effectIdempotencyKey: row.effect_idempotency_key,
    workOrder,
    workOrderDigest: row.work_order_digest,
    stepContract,
    profile,
    modelRoute: parseNavigatorTicketModelRoute(JSON.parse(row.model_route_json), row.kind),
    resource: row.resource_kind === null ? null : { kind: row.resource_kind, id: row.resource_id! },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseOutcome(row: OutcomeRow): NavigatorTicketWorkerOutcome {
  const result = JSON.parse(row.result_json) as unknown;
  if (navigatorJsonDigest(result) !== row.result_digest) {
    throw new Error(`navigator ticket outcome ${row.attempt_id} has invalid digest`);
  }
  return {
    attemptId: row.attempt_id,
    sliceId: row.slice_id,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    exactHeadSha: row.exact_head_sha,
    result,
    resultDigest: row.result_digest,
    recordedAt: row.recorded_at,
  };
}

function effectPayload(effect: StoredEffect, key: string): string {
  const value = effect.payload[key];
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(`navigator ticket effect ${key} is invalid`);
  }
  return value;
}

function resultCapabilitiesAreAccepted(
  result: NavigatorTicketWorkerResult,
  profile: NavigatorTicketWorkerProfile,
): boolean {
  const outcomes = new Map(result.capabilityOutcomes.map((outcome) => [outcome.capabilityId, outcome]));
  return outcomes.size === result.capabilityOutcomes.length &&
    profile.assignments.every((selected) => {
      const outcome = outcomes.get(selected.capabilityId)?.outcome;
      return outcome === "passed" || (result.kind === "code_review_result" && result.outcome === "findings" && outcome === "findings");
    }) &&
    result.capabilityOutcomes.every((outcome) =>
      profile.assignments.some((selected) => selected.capabilityId === outcome.capabilityId));
}

export class NavigatorImplementationExecutor {
  private readonly db: Database.Database;

  public constructor(private readonly dependencies: NavigatorImplementationExecutorDependencies) {
    this.db = dependencies.database;
  }

  public startIntegration(input: Readonly<{
    jobId: string;
    specificationArtifactId: string;
    implementationTicketIds: readonly string[];
    baseBranch: string;
    integrationBranch: string;
    worktreeId: string;
    baseHeadSha: string;
    evidenceRefs: readonly string[];
  }>): NavigatorIntegrationSnapshot {
    assertIdentifier(input.jobId, "jobId");
    assertIdentifier(input.specificationArtifactId, "specificationArtifactId");
    assertIdentifier(input.baseBranch, "baseBranch");
    assertIdentifier(input.integrationBranch, "integrationBranch");
    assertIdentifier(input.worktreeId, "worktreeId");
    assertGitSha(input.baseHeadSha, "baseHeadSha");
    const evidenceRefs = boundedRefs(input.evidenceRefs);
    if (evidenceRefs.length === 0) throw new TypeError("navigator integration evidence is required");
    if (input.implementationTicketIds.length === 0 || input.implementationTicketIds.length > 128 ||
      new Set(input.implementationTicketIds).size !== input.implementationTicketIds.length) {
      throw new TypeError("implementation ticket ids must be a bounded unique list");
    }
    const job = this.dependencies.store.getJob(input.jobId);
    if (!job || job.workflowEngine !== "navigator-v1" || job.workflowMode !== "deterministic") {
      throw new TypeError("navigator integration requires a deterministic navigator job");
    }
    if (job.policyVersion === null || job.policy === null) {
      throw new TypeError("navigator integration requires an immutable project policy");
    }
    const projectPolicyJson = JSON.stringify(job.policy);
    const projectPolicyDigest = navigatorJsonDigest(job.policy);
    const specification = this.boundCurrentArtifact(job.artifactBindings, input.specificationArtifactId, "specification");
    const tickets = input.implementationTicketIds.map((artifactId) =>
      this.boundCurrentArtifact(job.artifactBindings, artifactId, "implementation_ticket"));
    this.db.transaction(() => {
      const existing = this.integrationRow(input.jobId);
      if (existing) {
        const storedTicketIds = this.ticketRows(input.jobId).map((ticket) => ticket.artifact_id);
        if (
          existing.specification_artifact_id !== specification.artifactId ||
          existing.specification_snapshot_id !== specification.snapshotId ||
          existing.specification_snapshot_digest !== specification.snapshotDigest ||
          existing.project_policy_version !== job.policyVersion ||
          existing.project_policy_digest !== projectPolicyDigest ||
          existing.base_branch !== input.baseBranch ||
          existing.integration_branch !== input.integrationBranch || existing.worktree_id !== input.worktreeId ||
          existing.base_head_sha !== input.baseHeadSha ||
          existing.evidence_refs_json !== JSON.stringify(evidenceRefs) ||
          JSON.stringify(storedTicketIds) !== JSON.stringify(input.implementationTicketIds)
        ) throw new TypeError("navigator integration identity changed during replay");
        return;
      }
      const now = this.dependencies.clock.now();
      this.db.prepare(
        `INSERT INTO navigator_integrations (
           job_id, specification_artifact_id, specification_snapshot_id,
           specification_snapshot_digest, base_branch, integration_branch, worktree_id,
           project_policy_version, project_policy_json, project_policy_digest,
           base_head_sha, current_head_sha, state, active_slice_id,
           pull_request_number, pull_request_url, evidence_refs_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'implementing', NULL, NULL, NULL, ?, ?, ?)`,
      ).run(
        input.jobId,
        specification.artifactId,
        specification.snapshotId,
        specification.snapshotDigest,
        input.baseBranch,
        input.integrationBranch,
        input.worktreeId,
        job.policyVersion,
        projectPolicyJson,
        projectPolicyDigest,
        input.baseHeadSha,
        input.baseHeadSha,
        JSON.stringify(evidenceRefs),
        now,
        now,
      );
      const insertTicket = this.db.prepare(
        `INSERT INTO navigator_integration_tickets (
           job_id, artifact_id, snapshot_id, snapshot_digest, ticket_order,
           state, accepted_head_sha, resolved_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL)`,
      );
      tickets.forEach((ticket, order) => insertTicket.run(
        input.jobId,
        ticket.artifactId,
        ticket.snapshotId,
        ticket.snapshotDigest,
        order,
      ));
    }).immediate();
    return this.snapshot(input.jobId);
  }

  public beginClaimedTicket(input: Readonly<{
    jobId: string;
    ticketArtifactId: string;
    claimId: number;
    taskEvidence: readonly string[];
    evidenceRefs: readonly string[];
  }>) {
    assertIdentifier(input.jobId, "jobId");
    assertIdentifier(input.ticketArtifactId, "ticketArtifactId");
    if (!Number.isSafeInteger(input.claimId) || input.claimId < 1) throw new TypeError("claimId is invalid");
    const claimEvidenceRefs = boundedRefs(input.evidenceRefs);
    return this.db.transaction(() => {
      const integration = this.requireWritableIntegration(input.jobId);
      const evidenceRefs = mergeEvidenceRefs(
        JSON.parse(integration.evidence_refs_json) as readonly string[],
        claimEvidenceRefs,
      );
      const existing = this.sliceForTicket(input.jobId, input.ticketArtifactId);
      if (existing) {
        if (existing.claim_id !== input.claimId) throw new TypeError("ticket claim changed during replay");
        return this.sliceValue(existing);
      }
      if (integration.active_slice_id !== null) throw new Error("navigator integration already has an active writer");
      const ticket = this.ticketRows(input.jobId).find((candidate) => candidate.artifact_id === input.ticketArtifactId);
      if (!ticket || ticket.state !== "pending" || this.nextEligibleTicket(input.jobId)?.artifact_id !== ticket.artifact_id) {
        throw new TypeError("claimed ticket is not the next eligible implementation ticket");
      }
      const claim = this.dependencies.store.getWorkArtifactClaim(input.claimId);
      this.assertClaim(claim, input.jobId, ticket);
      const now = this.dependencies.clock.now();
      const sliceId = stableId("navslice", input.jobId, ticket.artifact_id, ticket.snapshot_digest);
      this.db.prepare(
        `INSERT INTO navigator_ticket_slices (
           id, job_id, ticket_artifact_id, ticket_snapshot_id, ticket_snapshot_digest,
           claim_id, integration_base_head_sha, state, accepted_head_sha, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'implementation_pending', NULL, ?, ?)`,
      ).run(
        sliceId,
        input.jobId,
        ticket.artifact_id,
        ticket.snapshot_id,
        ticket.snapshot_digest,
        input.claimId,
        integration.current_head_sha,
        now,
        now,
      );
      this.db.prepare(
        "UPDATE navigator_integration_tickets SET state = 'active' WHERE job_id = ? AND artifact_id = ?",
      ).run(input.jobId, ticket.artifact_id);
      this.db.prepare(
        "UPDATE navigator_integrations SET active_slice_id = ?, updated_at = ? WHERE job_id = ?",
      ).run(sliceId, now, input.jobId);
      this.createAttempt({
        integration,
        sliceId,
        ticket,
        kind: "implementation",
        ordinal: 1,
        taskEvidence: input.taskEvidence,
        evidenceRefs,
        changedPaths: [],
        baseHeadSha: integration.current_head_sha,
        comparisonBaseHeadSha: integration.current_head_sha,
        now,
      });
      return this.sliceValue(this.requireSlice(sliceId));
    }).immediate();
  }

  public scheduleRepair(input: Readonly<{
    jobId: string;
    ticketArtifactId: string;
    taskEvidence: readonly string[];
    evidenceRefs: readonly string[];
  }>): NavigatorTicketWorkerAttempt {
    return this.db.transaction(() => {
      const integration = this.requireWritableIntegration(input.jobId);
      const slice = this.requireSliceForTicket(input.jobId, input.ticketArtifactId);
      if (slice.state !== "repair_pending" || integration.active_slice_id !== slice.id) {
        throw new TypeError("ticket is not awaiting an agent-owned repair");
      }
      const ticket = this.requireTicket(input.jobId, input.ticketArtifactId);
      const ordinal = this.nextAttemptOrdinal(slice.id, "implementation");
      const priorReview = this.latestAttempt(slice.id, "review");
      const evidenceRefs = mergeEvidenceRefs(
        priorReview.workOrder.evidenceRefs,
        boundedRefs(input.evidenceRefs),
        [`navigator-result:${priorReview.id}`],
      );
      const now = this.dependencies.clock.now();
      const attempt = this.createAttempt({
        integration,
        sliceId: slice.id,
        ticket,
        kind: "implementation",
        ordinal,
        taskEvidence: input.taskEvidence,
        evidenceRefs,
        changedPaths: priorReview.workOrder.changedPaths,
        baseHeadSha: integration.current_head_sha,
        comparisonBaseHeadSha: slice.integration_base_head_sha,
        now,
      });
      this.db.prepare(
        "UPDATE navigator_ticket_slices SET state = 'implementation_pending', updated_at = ? WHERE id = ?",
      ).run(now, slice.id);
      return attempt;
    }).immediate();
  }

  public async processOne(fence: EffectFence, signal: AbortSignal): Promise<boolean> {
    const now = this.dependencies.clock.now();
    const effect = this.leaseEffect(fence, now);
    if (!effect) return false;
    const attemptId = effectPayload(effect, "attemptId");
    const attempt = this.getAttempt(attemptId);
    if (!attempt || attempt.effectIdempotencyKey !== effect.idempotencyKey) {
      this.finishEffect(effect, fence, now, "dead", "navigator ticket attempt identity is unavailable");
      return true;
    }
    const leaseMs = this.dependencies.leaseMs ?? 30_000;
    const leaseAbort = new AbortController();
    const timeoutAbort = new AbortController();
    const runSignal = AbortSignal.any([signal, fence.signal, leaseAbort.signal, timeoutAbort.signal]);
    const interruption = new Promise<never>((_resolve, reject) => {
      if (runSignal.aborted) {
        reject(runSignal.reason ?? new Error("navigator ticket worker was aborted"));
        return;
      }
      runSignal.addEventListener("abort", () => {
        reject(runSignal.reason ?? new Error("navigator ticket worker was aborted"));
      }, { once: true });
    });
    const timeout = setTimeout(() => {
      timeoutAbort.abort(new Error("navigator ticket worker timed out"));
    }, attempt.stepContract.timeoutMs);
    const renewal = setInterval(() => {
      try {
        const renewed = this.dependencies.store.renewJobOperationFences({
          jobId: effect.jobId,
          effectIdempotencyKey: effect.idempotencyKey,
          ownerId: fence.ownerId,
          generation: fence.generation,
          now: this.dependencies.clock.now(),
          leaseMs,
        });
        if (!renewed && !leaseAbort.signal.aborted) {
          leaseAbort.abort(new Error("navigator ticket worker lease was lost"));
        }
      } catch (renewalError) {
        if (!leaseAbort.signal.aborted) leaseAbort.abort(renewalError);
      }
    }, Math.max(1, Math.min(10_000, Math.floor(leaseMs / 3))));
    try {
      const run = await Promise.race([
        this.dependencies.workerRunner.run(attempt, {
          bindResource: async (resource) => {
            if (!this.bindResource(attempt.id, effect.idempotencyKey, resource, fence, this.dependencies.clock.now())) {
              throw new Error("navigator ticket worker resource binding was lost");
            }
          },
        }, runSignal),
        interruption,
      ]);
      if (!this.bindResource(attempt.id, effect.idempotencyKey, run.resource, fence, this.dependencies.clock.now())) {
        throw new Error("navigator ticket worker returned a different resource");
      }
      this.settleAttempt(attempt.id, effect.idempotencyKey, run.result, fence, this.dependencies.clock.now());
    } catch (error) {
      if (error instanceof NavigatorTicketWorkerUnavailableError) {
        this.replaceUnavailableAttempt(
          attempt,
          effect.idempotencyKey,
          error.reason,
          fence,
          this.dependencies.clock.now(),
        );
        return true;
      }
      const summary = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const failedAt = this.dependencies.clock.now();
      if (this.effectLeaseCurrent(effect.idempotencyKey, fence, failedAt)) {
        this.finishEffect(effect, fence, failedAt, "failed", summary.slice(0, 500));
      }
    } finally {
      clearInterval(renewal);
      clearTimeout(timeout);
    }
    return true;
  }

  public markTicketResolved(input: Readonly<{ jobId: string; ticketArtifactId: string }>): NavigatorIntegrationSnapshot {
    return this.db.transaction(() => {
      const integration = this.integrationRow(input.jobId);
      if (!integration || integration.state !== "implementing") throw new TypeError("integration is not accepting ticket resolution");
      const slice = this.requireSliceForTicket(input.jobId, input.ticketArtifactId);
      if (slice.state !== "accepted") throw new TypeError("ticket has no accepted review outcome");
      const review = this.latestAttempt(slice.id, "review");
      const outcome = this.getOutcome(review.id);
      const resolution = this.dependencies.store.getWorkArtifactResolution(input.ticketArtifactId);
      if (
        outcome?.outcome !== "succeeded" ||
        resolution?.outcome !== "resolved" ||
        resolution.snapshotId !== slice.ticket_snapshot_id ||
        !resolution.evidenceRefs.includes(`navigator-result:${review.id}`)
      ) throw new TypeError("ticket closure is not bound to its accepted review evidence");
      const now = this.dependencies.clock.now();
      this.db.prepare(
        "UPDATE navigator_ticket_slices SET state = 'resolved', updated_at = ? WHERE id = ?",
      ).run(now, slice.id);
      this.db.prepare(
        `UPDATE navigator_integration_tickets
            SET state = 'resolved', resolved_at = ?
          WHERE job_id = ? AND artifact_id = ?`,
      ).run(now, input.jobId, input.ticketArtifactId);
      const pending = this.db.prepare(
        "SELECT 1 FROM navigator_integration_tickets WHERE job_id = ? AND state <> 'resolved' LIMIT 1",
      ).get(input.jobId);
      this.db.prepare(
        `UPDATE navigator_integrations
            SET active_slice_id = NULL, state = ?, updated_at = ?
          WHERE job_id = ?`,
      ).run(pending ? "implementing" : "ready_for_pull_request", now, input.jobId);
      return this.snapshot(input.jobId);
    }).immediate();
  }

  public async publishPullRequest(input: Readonly<{
    jobId: string;
    title: string;
    body: string;
  }>): Promise<NavigatorPullRequestRecord> {
    const request = this.preparePullRequest(input);
    const existing = this.pullRequestRow(input.jobId);
    if (existing?.status === "published") return this.publishedPullRequest(existing);
    const published = await this.dependencies.pullRequests.createOrRefresh(request);
    if (
      published.operationId !== request.operationId || published.jobId !== request.jobId ||
      published.headSha !== request.headSha ||
      !Number.isSafeInteger(published.number) || published.number < 1 || published.url.trim().length === 0
    ) throw new TypeError("pull request publisher returned an invalid exact-head result");
    return this.db.transaction(() => {
      const current = this.pullRequestRow(input.jobId);
      if (!current || current.request_digest !== navigatorJsonDigest(request)) {
        throw new Error("pull request request changed before settlement");
      }
      if (current.status === "published") return this.publishedPullRequest(current);
      const now = this.dependencies.clock.now();
      this.db.prepare(
        `UPDATE navigator_pull_requests
            SET status = 'published', number = ?, url = ?, settled_at = ?
          WHERE job_id = ? AND status = 'pending'`,
      ).run(published.number, published.url, now, input.jobId);
      this.db.prepare(
        `UPDATE navigator_integrations
            SET state = 'ready_for_release', pull_request_number = ?, pull_request_url = ?, updated_at = ?
          WHERE job_id = ? AND state = 'publishing_pull_request' AND current_head_sha = ?`,
      ).run(published.number, published.url, now, input.jobId, request.headSha);
      return this.publishedPullRequest(this.pullRequestRow(input.jobId)!);
    }).immediate();
  }

  public snapshot(jobId: string): NavigatorIntegrationSnapshot {
    const integration = this.integrationRow(jobId);
    if (!integration) throw new Error(`navigator integration ${jobId} was not found`);
    const tickets = this.ticketRows(jobId);
    const attempts = this.db.prepare(
      "SELECT * FROM navigator_ticket_worker_attempts WHERE job_id = ? ORDER BY created_at, id",
    ).all(jobId) as AttemptRow[];
    const outcomes = this.db.prepare(
      `SELECT outcome.* FROM navigator_ticket_worker_outcomes AS outcome
        JOIN navigator_ticket_worker_attempts AS attempt ON attempt.id = outcome.attempt_id
       WHERE attempt.job_id = ? ORDER BY outcome.recorded_at, outcome.attempt_id`,
    ).all(jobId) as OutcomeRow[];
    const activeSlice = integration.active_slice_id === null ? null : this.requireSlice(integration.active_slice_id);
    return {
      integration: {
        jobId: integration.job_id,
        specification: {
          artifactId: integration.specification_artifact_id,
          snapshotId: integration.specification_snapshot_id,
          snapshotDigest: integration.specification_snapshot_digest,
        },
        baseBranch: integration.base_branch,
        integrationBranch: integration.integration_branch,
        worktreeId: integration.worktree_id,
        baseHeadSha: integration.base_head_sha,
        currentHeadSha: integration.current_head_sha,
        state: integration.state,
        activeSliceId: integration.active_slice_id,
        pullRequestNumber: integration.pull_request_number,
        pullRequestUrl: integration.pull_request_url,
        evidenceRefs: JSON.parse(integration.evidence_refs_json) as readonly string[],
      },
      tickets: tickets.map((ticket) => ({
        artifactId: ticket.artifact_id,
        snapshotId: ticket.snapshot_id,
        snapshotDigest: ticket.snapshot_digest,
        order: ticket.ticket_order,
        state: ticket.state,
        acceptedHeadSha: ticket.accepted_head_sha,
      })),
      activeSlice: activeSlice === null ? null : this.sliceValue(activeSlice),
      attempts: attempts.map(parseAttempt),
      outcomes: outcomes.map(parseOutcome),
    };
  }

  private boundCurrentArtifact(
    bindings: readonly NavigatorArtifactBinding[],
    artifactId: string,
    kind: "specification" | "implementation_ticket",
  ): NavigatorArtifactBinding {
    const binding = bindings.find((candidate) => candidate.artifactId === artifactId);
    const artifact = this.dependencies.store.getWorkArtifact(artifactId);
    const snapshot = this.dependencies.store.getCurrentWorkArtifactSnapshot(artifactId);
    if (
      !binding || artifact?.kind !== kind || snapshot?.id !== binding.snapshotId ||
      snapshot.snapshotDigest !== binding.snapshotDigest ||
      !this.dependencies.store.isWorkArtifactSnapshotValid(binding.snapshotId)
    ) throw new TypeError(`navigator integration ${kind} binding is stale or unavailable`);
    return artifactBindingSchema.parse(binding);
  }

  private requireWritableIntegration(jobId: string): IntegrationRow {
    const integration = this.integrationRow(jobId);
    if (!integration || integration.state !== "implementing") {
      throw new TypeError("navigator integration is not writable");
    }
    if (!this.bindingIsCurrent({
      artifactId: integration.specification_artifact_id,
      snapshotId: integration.specification_snapshot_id,
      snapshotDigest: integration.specification_snapshot_digest,
    })) {
      this.invalidateIntegration(integration, "stale_specification", this.dependencies.clock.now());
      throw new TypeError("navigator integration specification snapshot is stale");
    }
    return integration;
  }

  private ticketIsEligible(jobId: string, ticket: TicketRow): boolean {
    const relationships = this.dependencies.store.listWorkArtifactRelationships(ticket.artifact_id);
    const parent = this.integrationRow(jobId)?.specification_artifact_id;
    if (!relationships.some((relationship) =>
      relationship.kind === "parent" && relationship.targetArtifactId === parent)) return false;
    return relationships.filter((relationship) => relationship.kind === "blocks").every((relationship) => {
      const blocker = relationship.sourceArtifactId === null
        ? null
        : this.dependencies.store.getWorkArtifact(relationship.sourceArtifactId);
      return blocker !== null && (blocker.status === "resolved" || blocker.status === "cancelled") &&
        blocker.externalStatus !== "open";
    });
  }

  private nextEligibleTicket(jobId: string): TicketRow | null {
    return this.ticketRows(jobId).find((ticket) =>
      ticket.state === "pending" && this.ticketIsEligible(jobId, ticket)) ?? null;
  }

  private assertClaim(claim: WorkArtifactClaim | null, jobId: string, ticket: TicketRow): void {
    if (
      !claim || claim.state !== "held" || claim.jobId !== jobId ||
      claim.artifactId !== ticket.artifact_id || claim.snapshotId !== ticket.snapshot_id ||
      !this.bindingIsCurrent({
        artifactId: ticket.artifact_id,
        snapshotId: ticket.snapshot_id,
        snapshotDigest: ticket.snapshot_digest,
      })
    ) throw new TypeError("implementation ticket claim is stale or belongs to another lane");
  }

  private createAttempt(input: Readonly<{
    integration: IntegrationRow;
    sliceId: string;
    ticket: TicketRow;
    kind: "implementation" | "review";
    ordinal: number;
    taskEvidence: readonly string[];
    evidenceRefs: readonly string[];
    changedPaths: readonly string[];
    baseHeadSha: string;
    comparisonBaseHeadSha: string;
    now: number;
  }>): NavigatorTicketWorkerAttempt {
    const workOrder = navigatorTicketWorkOrderSchema.parse({
      kind: "navigator_ticket_work_order",
      jobId: input.integration.job_id,
      integrationBranch: input.integration.integration_branch,
      baseBranch: input.integration.base_branch,
      worktreeId: input.integration.worktree_id,
      baseHeadSha: input.baseHeadSha,
      comparisonBaseHeadSha: input.comparisonBaseHeadSha,
      projectPolicyVersion: input.integration.project_policy_version,
      projectPolicy: JSON.parse(input.integration.project_policy_json),
      projectPolicyDigest: input.integration.project_policy_digest,
      specification: {
        artifactId: input.integration.specification_artifact_id,
        snapshotId: input.integration.specification_snapshot_id,
        snapshotDigest: input.integration.specification_snapshot_digest,
      },
      ticket: {
        artifactId: input.ticket.artifact_id,
        snapshotId: input.ticket.snapshot_id,
        snapshotDigest: input.ticket.snapshot_digest,
      },
      taskEvidence: input.taskEvidence,
      evidenceRefs: input.evidenceRefs,
      changedPaths: input.changedPaths,
    });
    const profile = navigatorTicketWorkerProfile({
      kind: input.kind,
      taskEvidence: input.taskEvidence,
      changedPaths: input.changedPaths,
    });
    const stepContract = NAVIGATOR_TICKET_STEP_CONTRACTS[input.kind];
    const route = parseNavigatorTicketModelRoute(this.dependencies.modelRoute(input.kind), input.kind);
    const attemptId = stableId("navworker", input.sliceId, input.kind, String(input.ordinal));
    const effectKey = `${input.integration.job_id}:navigator-ticket:${attemptId}`;
    this.db.prepare(
      `INSERT INTO effects (
         idempotency_key, job_id, kind, payload_json, status, attempts,
         next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, 'run_navigator_ticket_worker', ?, 'pending', 0, ?, ?, ?)`,
    ).run(
      effectKey,
      input.integration.job_id,
      JSON.stringify({ attemptId, sliceId: input.sliceId }),
      input.now,
      input.now,
      input.now,
    );
    this.db.prepare(
      `INSERT INTO navigator_ticket_worker_attempts (
         id, job_id, slice_id, kind, ordinal, effect_idempotency_key,
         work_order_json, work_order_digest, step_contract_id, step_contract_revision,
         step_contract_digest, profile_json, profile_digest, model_route_json,
         resource_kind, resource_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      attemptId,
      input.integration.job_id,
      input.sliceId,
      input.kind,
      input.ordinal,
      effectKey,
      JSON.stringify(workOrder),
      navigatorJsonDigest(workOrder),
      stepContract.id,
      stepContract.revision,
      stepContract.digest,
      JSON.stringify(profile),
      profile.digest,
      JSON.stringify(route),
      input.now,
      input.now,
    );
    return this.getAttempt(attemptId)!;
  }

  private leaseEffect(fence: EffectFence, now: number): StoredEffect | null {
    const leaseMs = this.dependencies.leaseMs ?? 30_000;
    return this.db.transaction(() => {
      if (!this.dependencies.store.isExecutorLeaseCurrent(fence.ownerId, fence.generation, now)) return null;
      const row = this.db.prepare(
        `SELECT effect.* FROM effects AS effect
          JOIN navigator_ticket_worker_attempts AS attempt
            ON attempt.effect_idempotency_key = effect.idempotency_key
          JOIN navigator_integrations AS integration ON integration.job_id = attempt.job_id
         WHERE effect.kind = 'run_navigator_ticket_worker'
           AND integration.state = 'implementing'
           AND NOT EXISTS (
             SELECT 1 FROM navigator_ticket_worker_outcomes AS outcome WHERE outcome.attempt_id = attempt.id
           )
           AND ((effect.status IN ('pending', 'failed') AND effect.next_attempt_at <= ?)
             OR (effect.status = 'leased' AND effect.lease_expires_at <= ?))
         ORDER BY effect.created_at, effect.idempotency_key LIMIT 1`,
      ).get(now, now) as Parameters<typeof this.parseEffect>[0] | undefined;
      if (!row) return null;
      const changed = this.db.prepare(
        `UPDATE effects SET status = 'leased', lease_owner = ?, lease_generation = ?,
             lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
          WHERE idempotency_key = ? AND (
            (status IN ('pending', 'failed') AND next_attempt_at <= ?)
            OR (status = 'leased' AND lease_expires_at <= ?)
          )`,
      ).run(fence.ownerId, fence.generation, now + leaseMs, now, row.idempotency_key, now, now);
      return changed.changes === 1
        ? this.parseEffect(this.db.prepare("SELECT * FROM effects WHERE idempotency_key = ?").get(row.idempotency_key) as Parameters<typeof this.parseEffect>[0])
        : null;
    }).immediate();
  }

  private parseEffect(row: Readonly<{
    idempotency_key: string;
    job_id: string;
    kind: StoredEffect["kind"];
    payload_json: string;
    status: StoredEffect["status"];
    attempts: number;
    lease_owner: string | null;
    lease_generation: number | null;
    lease_expires_at: number | null;
    next_attempt_at: number;
    last_error: string | null;
    created_at: number;
    updated_at: number;
  }>): StoredEffect {
    return {
      idempotencyKey: row.idempotency_key,
      jobId: row.job_id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      status: row.status,
      attempts: row.attempts,
      leaseOwner: row.lease_owner,
      leaseGeneration: row.lease_generation,
      leaseExpiresAt: row.lease_expires_at,
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private bindResource(
    attemptId: string,
    effectKey: string,
    resource: { kind: "bb_thread"; id: string },
    fence: EffectFence,
    now: number,
  ): boolean {
    assertIdentifier(resource.id, "worker resource id");
    return this.db.transaction(() => {
      if (!this.effectLeaseCurrent(effectKey, fence, now)) return false;
      const attempt = this.getAttempt(attemptId);
      if (!attempt || attempt.effectIdempotencyKey !== effectKey) return false;
      if (attempt.resource !== null) return attempt.resource.id === resource.id;
      const bound = this.db.prepare(
        `UPDATE navigator_ticket_worker_attempts
            SET resource_kind = 'bb_thread', resource_id = ?, updated_at = ?
          WHERE id = ? AND resource_id IS NULL`,
      ).run(resource.id, now, attemptId).changes === 1;
      if (!bound) return false;
      this.db.prepare(
        "UPDATE navigator_ticket_slices SET state = ?, updated_at = ? WHERE id = ?",
      ).run(attempt.kind === "implementation" ? "implementation_running" : "review_running", now, attempt.sliceId);
      return true;
    }).immediate();
  }

  private settleAttempt(
    attemptId: string,
    effectKey: string,
    rawResult: unknown,
    fence: EffectFence,
    now: number,
  ): NavigatorTicketWorkerOutcome | null {
    return this.db.transaction(() => {
      if (!this.effectLeaseCurrent(effectKey, fence, now)) return null;
      const attempt = this.getAttempt(attemptId);
      if (!attempt || attempt.effectIdempotencyKey !== effectKey || attempt.resource === null) return null;
      const existing = this.getOutcome(attemptId);
      if (existing) return existing;
      const rawResultJson = JSON.stringify(rawResult);
      const resultTooLarge = rawResultJson !== undefined &&
        Buffer.byteLength(rawResultJson, "utf8") > attempt.stepContract.maximumResultBytes;
      const parsed = navigatorTicketWorkerResultSchema.safeParse(resultTooLarge ? undefined : rawResult);
      const integration = this.integrationRow(attempt.jobId)!;
      let outcome: NavigatorTicketWorkerOutcome["outcome"] = "succeeded";
      let reasonCode = "accepted";
      let result: unknown = parsed.success ? parsed.data : { kind: "policy_failure", reasonCode: "malformed_result" };
      if (resultTooLarge) {
        outcome = "policy_failure";
        reasonCode = "result_too_large";
        result = { kind: "policy_failure", reasonCode };
      } else if (!parsed.success || parsed.data.kind !== (attempt.kind === "implementation" ? "implementation_result" : "code_review_result")) {
        outcome = "policy_failure";
        reasonCode = "malformed_result";
      } else if (!this.bindingIsCurrent(attempt.workOrder.specification)) {
        outcome = "policy_failure";
        reasonCode = "stale_specification";
      } else if (!this.bindingIsCurrent(attempt.workOrder.ticket)) {
        outcome = "policy_failure";
        reasonCode = "stale_ticket";
      } else if (!resultCapabilitiesAreAccepted(parsed.data, attempt.profile)) {
        outcome = "policy_failure";
        reasonCode = "capability_outcome_missing";
      } else if (parsed.data.kind === "implementation_result") {
        if (
          parsed.data.baseHeadSha !== attempt.workOrder.baseHeadSha ||
          integration.current_head_sha !== attempt.workOrder.baseHeadSha ||
          parsed.data.focusedVerification.some((receipt) => receipt.outcome !== "passed") ||
          parsed.data.fullVerification.some((receipt) => receipt.outcome !== "passed")
        ) {
          outcome = "policy_failure";
          reasonCode = integration.current_head_sha !== attempt.workOrder.baseHeadSha
            ? "integration_head_drift"
            : "implementation_evidence_rejected";
        }
      } else if (parsed.data.reviewedHeadSha !== attempt.workOrder.baseHeadSha) {
        outcome = "policy_failure";
        reasonCode = "review_head_mismatch";
      } else if (parsed.data.outcome === "findings") {
        outcome = "findings";
        reasonCode = "review_findings";
      }
      const exactHeadSha = parsed.success && parsed.data.kind === "implementation_result"
        ? parsed.data.headSha
        : attempt.workOrder.baseHeadSha;
      const resultDigest = navigatorJsonDigest(result);
      this.db.prepare(
        `INSERT INTO navigator_ticket_worker_outcomes (
           attempt_id, slice_id, outcome, reason_code, exact_head_sha,
           result_json, result_digest, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        attempt.id,
        attempt.sliceId,
        outcome,
        reasonCode,
        exactHeadSha,
        JSON.stringify(result),
        resultDigest,
        now,
      );
      if (outcome === "policy_failure") {
        this.invalidateIntegration(integration, reasonCode, now);
      } else if (attempt.kind === "implementation") {
        const implementationResult = navigatorImplementationResultSchema.parse(result);
        this.acceptImplementation(attempt, implementationResult.headSha, implementationResult.changedPaths, now);
      } else if (outcome === "findings") {
        this.db.prepare(
          "UPDATE navigator_ticket_slices SET state = 'repair_pending', updated_at = ? WHERE id = ?",
        ).run(now, attempt.sliceId);
      } else {
        navigatorCodeReviewResultSchema.parse(result);
        this.db.prepare(
          "UPDATE navigator_ticket_slices SET state = 'accepted', accepted_head_sha = ?, updated_at = ? WHERE id = ?",
        ).run(exactHeadSha, now, attempt.sliceId);
        this.db.prepare(
          `UPDATE navigator_integration_tickets
              SET state = 'accepted', accepted_head_sha = ?
            WHERE job_id = ? AND artifact_id = ?`,
        ).run(exactHeadSha, attempt.jobId, attempt.workOrder.ticket.artifactId);
      }
      this.finishEffectByKey(effectKey, fence, now, "done", null);
      return this.getOutcome(attempt.id);
    }).immediate();
  }

  private acceptImplementation(
    attempt: NavigatorTicketWorkerAttempt,
    headSha: string,
    changedPaths: readonly string[],
    now: number,
  ): void {
    const integration = this.integrationRow(attempt.jobId)!;
    this.db.prepare(
      "UPDATE navigator_integrations SET current_head_sha = ?, updated_at = ? WHERE job_id = ?",
    ).run(headSha, now, attempt.jobId);
    this.db.prepare(
      "UPDATE navigator_ticket_slices SET state = 'review_pending', updated_at = ? WHERE id = ?",
    ).run(now, attempt.sliceId);
    const ticket = this.requireTicket(attempt.jobId, attempt.workOrder.ticket.artifactId);
    const nextIntegration = this.integrationRow(attempt.jobId)!;
    this.createAttempt({
      integration: nextIntegration,
      sliceId: attempt.sliceId,
      ticket,
      kind: "review",
      ordinal: this.nextAttemptOrdinal(attempt.sliceId, "review"),
      taskEvidence: attempt.workOrder.taskEvidence,
      evidenceRefs: mergeEvidenceRefs(attempt.workOrder.evidenceRefs, [`navigator-result:${attempt.id}`]),
      changedPaths,
      baseHeadSha: headSha,
      comparisonBaseHeadSha: this.requireSlice(attempt.sliceId).integration_base_head_sha,
      now,
    });
  }

  private replaceUnavailableAttempt(
    attempt: NavigatorTicketWorkerAttempt,
    effectKey: string,
    reason: "missing" | "stale",
    fence: EffectFence,
    now: number,
  ): void {
    this.db.transaction(() => {
      if (!this.effectLeaseCurrent(effectKey, fence, now) || this.getOutcome(attempt.id) !== null) return;
      const integration = this.integrationRow(attempt.jobId);
      if (!integration || integration.state !== "implementing") return;
      const staleReason = !this.bindingIsCurrent(attempt.workOrder.specification)
        ? "stale_specification"
        : !this.bindingIsCurrent(attempt.workOrder.ticket)
          ? "stale_ticket"
          : null;
      if (staleReason !== null) {
        const staleResult = { kind: "policy_failure", reasonCode: staleReason } as const;
        this.db.prepare(
          `INSERT INTO navigator_ticket_worker_outcomes (
             attempt_id, slice_id, outcome, reason_code, exact_head_sha,
             result_json, result_digest, recorded_at
           ) VALUES (?, ?, 'policy_failure', ?, ?, ?, ?, ?)`,
        ).run(
          attempt.id,
          attempt.sliceId,
          staleReason,
          attempt.workOrder.baseHeadSha,
          JSON.stringify(staleResult),
          navigatorJsonDigest(staleResult),
          now,
        );
        this.invalidateIntegration(integration, staleReason, now);
        this.finishEffectByKey(effectKey, fence, now, "done", null);
        return;
      }
      const result = { kind: "worker_unavailable", reason } as const;
      this.db.prepare(
        `INSERT INTO navigator_ticket_worker_outcomes (
           attempt_id, slice_id, outcome, reason_code, exact_head_sha,
           result_json, result_digest, recorded_at
         ) VALUES (?, ?, 'worker_unavailable', ?, ?, ?, ?, ?)`,
      ).run(
        attempt.id,
        attempt.sliceId,
        `worker_${reason}`,
        attempt.workOrder.baseHeadSha,
        JSON.stringify(result),
        navigatorJsonDigest(result),
        now,
      );
      this.finishEffectByKey(effectKey, fence, now, "done", null);
      this.createAttempt({
        integration,
        sliceId: attempt.sliceId,
        ticket: this.requireTicket(attempt.jobId, attempt.workOrder.ticket.artifactId),
        kind: attempt.kind,
        ordinal: this.nextAttemptOrdinal(attempt.sliceId, attempt.kind),
        taskEvidence: attempt.workOrder.taskEvidence,
        evidenceRefs: mergeEvidenceRefs(attempt.workOrder.evidenceRefs, [`navigator-result:${attempt.id}`]),
        changedPaths: attempt.workOrder.changedPaths,
        baseHeadSha: attempt.workOrder.baseHeadSha,
        comparisonBaseHeadSha: attempt.workOrder.comparisonBaseHeadSha,
        now,
      });
      this.db.prepare(
        "UPDATE navigator_ticket_slices SET state = ?, updated_at = ? WHERE id = ?",
      ).run(attempt.kind === "implementation" ? "implementation_pending" : "review_pending", now, attempt.sliceId);
    }).immediate();
  }

  private preparePullRequest(input: Readonly<{ jobId: string; title: string; body: string }>): NavigatorPullRequestRequest {
    return this.db.transaction(() => {
      let integration = this.integrationRow(input.jobId);
      if (!integration || !["ready_for_pull_request", "publishing_pull_request", "ready_for_release"].includes(integration.state)) {
        throw new TypeError("navigator integration is not ready for one final pull request");
      }
      if (!this.bindingIsCurrent({
        artifactId: integration.specification_artifact_id,
        snapshotId: integration.specification_snapshot_id,
        snapshotDigest: integration.specification_snapshot_digest,
      })) {
        this.invalidateIntegration(integration, "stale_specification", this.dependencies.clock.now());
        throw new TypeError("navigator integration specification changed before pull request publication");
      }
      const existing = this.pullRequestRow(input.jobId);
      if (existing) return navigatorPullRequestRequestSchema.parse(JSON.parse(existing.request_json));
      const outcomeRefs = this.db.prepare(
        `SELECT 'navigator-result:' || outcome.attempt_id AS evidence_ref
           FROM navigator_ticket_worker_outcomes AS outcome
           JOIN navigator_ticket_worker_attempts AS attempt ON attempt.id = outcome.attempt_id
          WHERE attempt.job_id = ? AND outcome.outcome = 'succeeded'
          ORDER BY outcome.recorded_at, outcome.attempt_id`,
      ).all(input.jobId) as Array<{ evidence_ref: string }>;
      const request = navigatorPullRequestRequestSchema.parse({
        operationId: stableId("navigator-pr", input.jobId, integration.current_head_sha),
        jobId: input.jobId,
        baseBranch: integration.base_branch,
        integrationBranch: integration.integration_branch,
        headSha: integration.current_head_sha,
        title: input.title,
        body: input.body,
        evidenceRefs: outcomeRefs.map((row) => row.evidence_ref),
      });
      const now = this.dependencies.clock.now();
      this.db.prepare(
        `INSERT INTO navigator_pull_requests (
           job_id, operation_id, request_json, request_digest, status,
           number, url, head_sha, created_at, settled_at
         ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL)`,
      ).run(
        input.jobId,
        request.operationId,
        JSON.stringify(request),
        navigatorJsonDigest(request),
        request.headSha,
        now,
      );
      this.db.prepare(
        "UPDATE navigator_integrations SET state = 'publishing_pull_request', updated_at = ? WHERE job_id = ?",
      ).run(now, input.jobId);
      integration = this.integrationRow(input.jobId)!;
      return request;
    }).immediate();
  }

  private publishedPullRequest(row: Readonly<{
    operation_id: string;
    job_id: string;
    number: number | null;
    url: string | null;
    head_sha: string;
  }>): NavigatorPullRequestRecord {
    if (row.number === null || row.url === null) throw new Error("published pull request is incomplete");
    return {
      operationId: row.operation_id,
      jobId: row.job_id,
      number: row.number,
      url: row.url,
      headSha: row.head_sha,
    };
  }

  private pullRequestRow(jobId: string) {
    return this.db.prepare("SELECT * FROM navigator_pull_requests WHERE job_id = ?").get(jobId) as Readonly<{
      job_id: string;
      operation_id: string;
      request_json: string;
      request_digest: string;
      status: "pending" | "published";
      number: number | null;
      url: string | null;
      head_sha: string;
    }> | undefined;
  }

  private invalidateIntegration(integration: IntegrationRow, reasonCode: string, now: number): void {
    this.db.prepare(
      `UPDATE navigator_integrations SET state = 'invalidated', updated_at = ? WHERE job_id = ?`,
    ).run(now, integration.job_id);
    if (integration.active_slice_id !== null) {
      this.db.prepare(
        "UPDATE navigator_ticket_slices SET state = 'invalidated', updated_at = ? WHERE id = ?",
      ).run(now, integration.active_slice_id);
      this.db.prepare(
        `UPDATE navigator_integration_tickets SET state = 'invalidated'
          WHERE job_id = ? AND artifact_id = (
            SELECT ticket_artifact_id FROM navigator_ticket_slices WHERE id = ?
          )`,
      ).run(integration.job_id, integration.active_slice_id);
    }
    this.db.prepare(
      `UPDATE jobs SET last_error = ?, updated_at = ? WHERE id = ?`,
    ).run(`Navigator implementation invalidated: ${reasonCode}`, now, integration.job_id);
  }

  private bindingIsCurrent(binding: NavigatorArtifactBinding): boolean {
    const snapshot = this.dependencies.store.getCurrentWorkArtifactSnapshot(binding.artifactId);
    return snapshot?.id === binding.snapshotId && snapshot.snapshotDigest === binding.snapshotDigest &&
      this.dependencies.store.isWorkArtifactSnapshotValid(binding.snapshotId);
  }

  private integrationRow(jobId: string): IntegrationRow | null {
    return this.db.prepare("SELECT * FROM navigator_integrations WHERE job_id = ?").get(jobId) as IntegrationRow | undefined ?? null;
  }

  private ticketRows(jobId: string): TicketRow[] {
    return this.db.prepare(
      "SELECT * FROM navigator_integration_tickets WHERE job_id = ? ORDER BY ticket_order",
    ).all(jobId) as TicketRow[];
  }

  private requireTicket(jobId: string, artifactId: string): TicketRow {
    const ticket = this.ticketRows(jobId).find((candidate) => candidate.artifact_id === artifactId);
    if (!ticket) throw new Error(`navigator integration ticket ${artifactId} was not found`);
    return ticket;
  }

  private sliceForTicket(jobId: string, ticketArtifactId: string): SliceRow | null {
    return this.db.prepare(
      "SELECT * FROM navigator_ticket_slices WHERE job_id = ? AND ticket_artifact_id = ?",
    ).get(jobId, ticketArtifactId) as SliceRow | undefined ?? null;
  }

  private requireSliceForTicket(jobId: string, ticketArtifactId: string): SliceRow {
    const slice = this.sliceForTicket(jobId, ticketArtifactId);
    if (!slice) throw new Error(`navigator ticket slice ${ticketArtifactId} was not found`);
    return slice;
  }

  private requireSlice(sliceId: string): SliceRow {
    const slice = this.db.prepare("SELECT * FROM navigator_ticket_slices WHERE id = ?").get(sliceId) as SliceRow | undefined;
    if (!slice) throw new Error(`navigator ticket slice ${sliceId} was not found`);
    return slice;
  }

  private sliceValue(slice: SliceRow) {
    return {
      id: slice.id,
      ticketArtifactId: slice.ticket_artifact_id,
      claimId: slice.claim_id,
      state: slice.state,
      acceptedHeadSha: slice.accepted_head_sha,
    } as const;
  }

  private getAttempt(attemptId: string): NavigatorTicketWorkerAttempt | null {
    const row = this.db.prepare("SELECT * FROM navigator_ticket_worker_attempts WHERE id = ?").get(attemptId) as AttemptRow | undefined;
    return row ? parseAttempt(row) : null;
  }

  private latestAttempt(sliceId: string, kind: "implementation" | "review"): NavigatorTicketWorkerAttempt {
    const row = this.db.prepare(
      `SELECT * FROM navigator_ticket_worker_attempts
        WHERE slice_id = ? AND kind = ? ORDER BY ordinal DESC LIMIT 1`,
    ).get(sliceId, kind) as AttemptRow | undefined;
    if (!row) throw new Error(`navigator ${kind} attempt was not found`);
    return parseAttempt(row);
  }

  private nextAttemptOrdinal(sliceId: string, kind: "implementation" | "review"): number {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM navigator_ticket_worker_attempts WHERE slice_id = ? AND kind = ?",
    ).get(sliceId, kind) as { ordinal: number };
    return row.ordinal + 1;
  }

  private getOutcome(attemptId: string): NavigatorTicketWorkerOutcome | null {
    const row = this.db.prepare(
      "SELECT * FROM navigator_ticket_worker_outcomes WHERE attempt_id = ?",
    ).get(attemptId) as OutcomeRow | undefined;
    return row ? parseOutcome(row) : null;
  }

  private effectLeaseCurrent(effectKey: string, fence: EffectFence, now: number): boolean {
    return this.dependencies.store.isExecutorLeaseCurrent(fence.ownerId, fence.generation, now) &&
      this.db.prepare(
        `SELECT 1 FROM effects WHERE idempotency_key = ? AND status = 'leased'
          AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?`,
      ).get(effectKey, fence.ownerId, fence.generation, now) !== undefined;
  }

  private finishEffect(
    effect: StoredEffect,
    fence: EffectFence,
    now: number,
    status: "done" | "failed" | "dead",
    error: string | null,
  ): void {
    this.finishEffectByKey(effect.idempotencyKey, fence, now, status, error);
  }

  private finishEffectByKey(
    effectKey: string,
    fence: EffectFence,
    now: number,
    status: "done" | "failed" | "dead",
    error: string | null,
  ): void {
    const changed = this.db.prepare(
      `UPDATE effects SET status = ?, lease_owner = NULL, lease_generation = NULL,
           lease_expires_at = NULL, next_attempt_at = ?, last_error = ?, updated_at = ?
        WHERE idempotency_key = ? AND status = 'leased' AND lease_owner = ?
          AND lease_generation = ? AND lease_expires_at > ?`,
    ).run(status, now, error, now, effectKey, fence.ownerId, fence.generation, now);
    if (changed.changes !== 1) throw new Error("navigator ticket effect lease changed before settlement");
  }
}
