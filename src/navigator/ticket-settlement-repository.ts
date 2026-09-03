import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Job, StoredEffect } from "../domain/models";
import { projectResourceKey } from "../autonomy/models";
import { CAPABILITY_GRAPH_DIGEST, CAPABILITY_REGISTRY_DIGEST } from "../capabilities/catalog";
import { DEFAULT_MODEL_POOL_REGISTRY, modelRouteSchema, type ModelRoute } from "../capabilities/models";
import { CapabilityRepository } from "../storage/capability-repository";
import { WorkArtifactRepository } from "../work-artifacts/repository";
import type { NavigatorTicketWorkerAttempt } from "./implementation-executor";
import {
  navigatorTicketReceiptSchema,
  type NavigatorTicketReceipt,
  type NavigatorTicketWorkerResourceBindingInput,
  type NavigatorTicketSettlementInput,
} from "./effect-contracts";
import {
  navigatorAcceptanceCriteriaAreSatisfied,
  NAVIGATOR_TICKET_STEP_CONTRACTS,
  navigatorCodeReviewResultSchema,
  navigatorGitObservationSchema,
  navigatorImplementationResultSchema,
  navigatorJsonDigest,
  navigatorPersistedTicketStepContractSchema,
  navigatorReviewFindingSchema,
  navigatorTicketWorkerProfileSchema,
  navigatorTicketWorkerProfile,
  navigatorTicketWorkerFailureResultSchema,
  navigatorTicketWorkerUnavailableResultSchema,
  navigatorTicketWorkerResultSchema,
  navigatorTicketWorkOrderSchema,
  parseNavigatorTicketModelRoute,
  type NavigatorGitObservation,
  type NavigatorReviewFinding,
  type NavigatorTicketWorkerFailureResult,
  type NavigatorTicketWorkerProfile,
  type NavigatorTicketWorkerResult,
  type NavigatorTicketWorkerUnavailableResult,
} from "./implementation-contracts";

export type NavigatorTicketWorkerOutcome = Readonly<{
  attemptId: string;
  sliceId: string;
  outcome: "succeeded" | "findings" | "worker_unavailable" | "policy_failure" | "dead_letter";
  reasonCode: string;
  exactHeadSha: string;
  result: unknown;
  resultDigest: string;
  gitObservation: NavigatorGitObservation | null;
  recordedAt: number;
}>;

export type NavigatorFindingLedgerEntry = Readonly<{
  rootCauseId: string;
  sliceId: string;
  sourceReviewAttemptId: string;
  verificationAttemptId: string;
  disposition: "must_fix" | "advisory";
  state: "open" | "resolved" | "disputed";
  occurrence: number;
  blockingBurden: number;
  headSha: string;
  finding: NavigatorReviewFinding;
}>;

type SqliteDatabase = Database.Database;
type EffectRow = Readonly<{
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
}>;

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
  step_contract_json: string;
  profile_json: string;
  profile_digest: string;
  model_route_json: string;
  resource_kind: "bb_thread" | null;
  resource_id: string | null;
  created_at: number;
  updated_at: number;
  capability_profile_id: string | null;
  capability_profile_revision: number | null;
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
  state: "implementing" | "invalidated" | "ready_for_pull_request" | "publishing_pull_request" | "ready_for_release";
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
  state: "pending" | "active" | "accepted" | "resolved" | "invalidated";
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
  git_observation_json: string | null;
  git_observation_digest: string | null;
  recorded_at: number;
}>;

type FindingEventRow = Readonly<{
  sequence: number;
  id: string;
  job_id: string;
  slice_id: string;
  source_review_attempt_id: string;
  verification_attempt_id: string;
  root_cause_id: string;
  capability_id: string;
  rule_id: string;
  disposition: "must_fix" | "advisory";
  event: "opened" | "reobserved" | "resolved" | "disputed";
  head_sha: string;
  finding_json: string;
  evidence_refs_json: string;
  occurrence: number;
  blocking_burden: number;
  created_at: number;
}>;

type ConvergenceRow = Readonly<{
  slice_id: string;
  last_blocking_burden: number;
  plateau_recoveries: number;
  review_cycles: number;
  updated_at: number;
}>;

const NAVIGATOR_FINDING_POLICY = Object.freeze({
  "code-review": Object.freeze({ defaultDisposition: "must_fix" as const, mustFixRuleIds: Object.freeze([]) }),
  "clean-code-guard": Object.freeze({
    defaultDisposition: "advisory" as const,
    mustFixRuleIds: Object.freeze(["clean.rule-1"]),
  }),
  "docs-guard": Object.freeze({
    defaultDisposition: "advisory" as const,
    mustFixRuleIds: Object.freeze(["docs.rule-1"]),
  }),
  "test-guard": Object.freeze({
    defaultDisposition: "advisory" as const,
    mustFixRuleIds: Object.freeze(["tests.rule-1"]),
  }),
});

function assertIdentifier(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive safe integer`);
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
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

function retryMaximum(contract: NavigatorTicketWorkerAttempt["stepContract"]): number {
  return "maximumAttempts" in contract && contract.maximumAttempts !== undefined ? contract.maximumAttempts : 1;
}

function retryDelay(contract: NavigatorTicketWorkerAttempt["stepContract"], attempts: number): number {
  if (
    "backoffBaseMs" in contract && contract.backoffBaseMs !== undefined &&
    "backoffMaximumMs" in contract && contract.backoffMaximumMs !== undefined
  ) return Math.min(contract.backoffMaximumMs, contract.backoffBaseMs * 2 ** Math.max(0, attempts - 1));
  return 1;
}

function findingState(event: FindingEventRow["event"]): NavigatorFindingLedgerEntry["state"] {
  if (event === "opened" || event === "reobserved") return "open";
  return event === "resolved" ? "resolved" : "disputed";
}

function sameRootCause(left: NavigatorReviewFinding, right: NavigatorReviewFinding): boolean {
  return left.rootCauseId === right.rootCauseId && left.capabilityId === right.capabilityId &&
    left.ruleId === right.ruleId && left.subject === right.subject && left.line === right.line &&
    left.requirementId === right.requirementId;
}

export function navigatorFindingDisposition(
  finding: NavigatorReviewFinding,
): "must_fix" | "advisory" | null {
  const policy = NAVIGATOR_FINDING_POLICY[finding.capabilityId as keyof typeof NAVIGATOR_FINDING_POLICY];
  if (!policy) return null;
  return policy.mustFixRuleIds.some((ruleId) => ruleId === finding.ruleId)
    ? "must_fix"
    : policy.defaultDisposition;
}

function parseTicketAttempt(row: AttemptRow): NavigatorTicketWorkerAttempt {
  const workOrder = navigatorTicketWorkOrderSchema.parse(JSON.parse(row.work_order_json));
  const profile = navigatorTicketWorkerProfileSchema.parse(JSON.parse(row.profile_json));
  const stepContract = navigatorPersistedTicketStepContractSchema.parse(JSON.parse(row.step_contract_json));
  const { digest: _digest, ...unsignedContract } = stepContract;
  if (
    navigatorJsonDigest(workOrder) !== row.work_order_digest ||
    stepContract.id !== row.step_contract_id || stepContract.revision !== row.step_contract_revision ||
    stepContract.digest !== row.step_contract_digest || navigatorJsonDigest(unsignedContract) !== stepContract.digest ||
    profile.digest !== row.profile_digest
  ) throw new Error(`navigator ticket attempt ${row.id} has invalid durable identity`);
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
    capabilityProfileId: row.capability_profile_id,
    capabilityProfileRevision: row.capability_profile_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseTicketOutcome(row: OutcomeRow): NavigatorTicketWorkerOutcome {
  const result = JSON.parse(row.result_json) as unknown;
  if (navigatorJsonDigest(result) !== row.result_digest) throw new Error(`navigator ticket outcome ${row.attempt_id} has invalid digest`);
  const gitObservation = row.git_observation_json === null
    ? null
    : navigatorGitObservationSchema.parse(JSON.parse(row.git_observation_json));
  if (
    (gitObservation === null) !== (row.git_observation_digest === null) ||
    (gitObservation !== null && navigatorJsonDigest(gitObservation) !== row.git_observation_digest)
  ) throw new Error(`navigator ticket outcome ${row.attempt_id} has invalid Git observation`);
  return {
    attemptId: row.attempt_id,
    sliceId: row.slice_id,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    exactHeadSha: row.exact_head_sha,
    result,
    resultDigest: row.result_digest,
    gitObservation,
    recordedAt: row.recorded_at,
  };
}

function resultCapabilitiesAreAccepted(
  workerResult: NavigatorTicketWorkerResult,
  profile: NavigatorTicketWorkerProfile,
): boolean {
  const outcomes = new Map(workerResult.capabilityOutcomes.map((outcome) => [outcome.capabilityId, outcome]));
  return outcomes.size === workerResult.capabilityOutcomes.length &&
    profile.assignments.every((selected) => {
      const outcome = outcomes.get(selected.capabilityId)?.outcome;
      return outcome === "passed" ||
        (workerResult.kind === "code_review_result" && workerResult.outcome === "findings" && outcome === "findings");
    }) &&
    workerResult.capabilityOutcomes.every((outcome) =>
      profile.assignments.some((selected) => selected.capabilityId === outcome.capabilityId));
}

function parseEffect(row: EffectRow): StoredEffect {
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

function effectPayloadIdentifier(effect: StoredEffect, key: string): string | null {
  const payloadValue = effect.payload[key];
  return typeof payloadValue === "string" && payloadValue.length > 0 && payloadValue.length <= 256
    ? payloadValue
    : null;
}

type TicketSettlementAssessment = Readonly<{
  outcome: NavigatorTicketWorkerOutcome["outcome"] | null;
  reasonCode: string;
  result: unknown;
  parsedResult: NavigatorTicketWorkerResult | null;
  gitObservation: NavigatorGitObservation | null;
  exactHeadSha: string;
  verifiedBlockingBurden: number | null;
  scheduleRetry: boolean;
  retrySameAttempt: boolean;
}>;

type TicketSettlementCurrent = Readonly<{
  effect: StoredEffect;
  attempt: NavigatorTicketWorkerAttempt;
  receipt: NavigatorTicketReceipt;
  now: number;
  ownerId: string;
  generation: number;
}>;

export class NavigatorTicketSettlementRepository {
  private readonly artifacts: WorkArtifactRepository;
  private readonly capabilities: CapabilityRepository;

  public constructor(private readonly db: SqliteDatabase) {
    this.artifacts = new WorkArtifactRepository(db);
    this.capabilities = new CapabilityRepository(db);
  }

  public settle(input: NavigatorTicketSettlementInput): NavigatorTicketWorkerOutcome | null {
    const receipt = navigatorTicketReceiptSchema.safeParse(input.receipt);
    if (!receipt.success) return null;
    assertIdentifier(input.attemptId, "attemptId");
    assertIdentifier(input.effectIdempotencyKey, "effectIdempotencyKey");
    assertIdentifier(input.ownerId, "ownerId");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction(() => this.settleReceipt({
      attemptId: input.attemptId,
      effectIdempotencyKey: input.effectIdempotencyKey,
      receipt: receipt.data,
      ownerId: input.ownerId,
      generation: input.generation,
      now: input.now,
    })).immediate();
  }

  public bindResource(input: NavigatorTicketWorkerResourceBindingInput): boolean {
    assertIdentifier(input.attemptId, "attemptId");
    assertIdentifier(input.effectIdempotencyKey, "effectIdempotencyKey");
    assertIdentifier(input.ownerId, "ownerId");
    assertPositiveInteger(input.generation, "generation");
    if (input.resource.kind !== "bb_thread") throw new TypeError("navigator ticket worker resource kind is invalid");
    assertIdentifier(input.resource.id, "resource id");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction(() => this.bindResourceInTransaction(input)).immediate();
  }

  private settleReceipt(input: NavigatorTicketSettlementInput & Readonly<{ receipt: NavigatorTicketReceipt }>): NavigatorTicketWorkerOutcome | null {
    const effect = this.effect(input.effectIdempotencyKey);
    if (!effect || !this.effectLeaseCurrent(input.effectIdempotencyKey, input.ownerId, input.generation, input.now)) return null;
    const attempt = this.ticketAttempt(input.attemptId);
    if (!attempt || !this.receiptIdentityMatches(input.receipt, effect, attempt)) return null;
    const existing = this.ticketOutcome(attempt.id);
    if (existing) return existing;
    if (!this.claimFenceIsCurrent(attempt, input.ownerId, input.generation, input.now)) return null;
    const integration = this.integrationRow(attempt.jobId);
    if (!integration) return null;
    if (!this.bindResourceInTransaction({
      attemptId: input.attemptId,
      effectIdempotencyKey: input.effectIdempotencyKey,
      resource: input.receipt.resource,
      ownerId: input.ownerId,
      generation: input.generation,
      now: input.now,
    })) return null;
    const settlement = this.assessReceipt(attempt, integration, effect, input.receipt, input.now);
    if (settlement.outcome !== null) {
      this.recordReceipt(input.receipt, attempt.jobId, input);
      this.recordOutcome(attempt, settlement, input.now);
    }
    this.applyWorkflowState(attempt, integration, effect, settlement, input.now);
    if (settlement.retrySameAttempt) {
      this.retryEffect(input.effectIdempotencyKey, input.ownerId, input.generation, attempt, input.now);
    } else {
      this.finishEffect(input.effectIdempotencyKey, input.ownerId, input.generation, input.now);
    }
    return settlement.outcome === null ? this.pendingOutcome(attempt, settlement, input.now) : this.ticketOutcome(attempt.id);
  }

  private effect(effectKey: string): StoredEffect | null {
    const row = this.db.prepare("SELECT * FROM effects WHERE idempotency_key = ?").get(effectKey) as EffectRow | undefined;
    return row ? parseEffect(row) : null;
  }

  private ticketAttempt(attemptId: string): NavigatorTicketWorkerAttempt | null {
    const row = this.db.prepare("SELECT * FROM navigator_ticket_worker_attempts WHERE id = ?").get(attemptId) as AttemptRow | undefined;
    return row ? parseTicketAttempt(row) : null;
  }

  private ticketOutcome(attemptId: string): NavigatorTicketWorkerOutcome | null {
    const row = this.db.prepare("SELECT * FROM navigator_ticket_worker_outcomes WHERE attempt_id = ?").get(attemptId) as OutcomeRow | undefined;
    return row ? parseTicketOutcome(row) : null;
  }

  private pendingOutcome(
    attempt: NavigatorTicketWorkerAttempt,
    assessment: TicketSettlementAssessment,
    now: number,
  ): NavigatorTicketWorkerOutcome {
    return {
      attemptId: attempt.id,
      sliceId: attempt.sliceId,
      outcome: "worker_unavailable",
      reasonCode: assessment.reasonCode,
      exactHeadSha: assessment.exactHeadSha,
      result: assessment.result,
      resultDigest: navigatorJsonDigest(assessment.result),
      gitObservation: assessment.gitObservation,
      recordedAt: now,
    };
  }

  private receiptIdentityMatches(
    receipt: NavigatorTicketReceipt,
    effect: StoredEffect,
    attempt: NavigatorTicketWorkerAttempt,
  ): boolean {
    return effect.kind === "run_navigator_ticket_worker" && receipt.effectIdempotencyKey === effect.idempotencyKey &&
      receipt.attemptId === attempt.id && attempt.effectIdempotencyKey === effect.idempotencyKey;
  }

  private bindResourceInTransaction(input: NavigatorTicketWorkerResourceBindingInput): boolean {
    const effect = this.effect(input.effectIdempotencyKey);
    if (!effect || effect.kind !== "run_navigator_ticket_worker" ||
      !this.effectLeaseCurrent(input.effectIdempotencyKey, input.ownerId, input.generation, input.now)) return false;
    const attempt = this.ticketAttempt(input.attemptId);
    if (!attempt || attempt.effectIdempotencyKey !== input.effectIdempotencyKey ||
      !this.claimFenceIsCurrent(attempt, input.ownerId, input.generation, input.now)) return false;
    const integration = this.integrationRow(attempt.jobId);
    if (!integration || integration.state !== "implementing" || integration.active_slice_id !== attempt.sliceId ||
      integration.current_head_sha !== attempt.workOrder.baseHeadSha) return false;
    if (attempt.resource !== null) {
      return attempt.resource.kind === input.resource.kind && attempt.resource.id === input.resource.id;
    }
    const bound = this.db.prepare(
      `UPDATE navigator_ticket_worker_attempts
          SET resource_kind = 'bb_thread', resource_id = ?, updated_at = ?
        WHERE id = ? AND effect_idempotency_key = ? AND resource_kind IS NULL AND resource_id IS NULL`,
    ).run(input.resource.id, input.now, input.attemptId, input.effectIdempotencyKey).changes === 1;
    if (!bound) return false;
    this.db.prepare(
      "UPDATE navigator_ticket_slices SET state = ?, updated_at = ? WHERE id = ?",
    ).run(attempt.kind === "implementation" ? "implementation_running" : "review_running", input.now, attempt.sliceId);
    return true;
  }

  private assessReceipt(
    attempt: NavigatorTicketWorkerAttempt,
    integration: IntegrationRow,
    effect: StoredEffect,
    receipt: NavigatorTicketReceipt,
    now: number,
  ): TicketSettlementAssessment {
    const unavailable = navigatorTicketWorkerUnavailableResultSchema.safeParse(receipt.result);
    if (unavailable.success) return this.assessUnavailable(attempt, effect, receipt, unavailable.data);
    const failure = navigatorTicketWorkerFailureResultSchema.safeParse(receipt.result);
    if (failure.success) return this.assessWorkerFailure(attempt, effect, receipt, failure.data);
    const rawJson = JSON.stringify(receipt.result);
    const resultTooLarge = rawJson !== undefined &&
      Buffer.byteLength(rawJson, "utf8") > attempt.stepContract.maximumResultBytes;
    const parsedResult = navigatorTicketWorkerResultSchema.safeParse(resultTooLarge ? undefined : receipt.result);
    const parsedGit = navigatorGitObservationSchema.safeParse(receipt.gitObservation);
    const gitObservation = parsedGit.success ? parsedGit.data : null;
    const exactHeadSha = gitObservation?.headSha ?? this.resultHead(parsedResult, attempt);
    const reasonCode = this.receiptFailureReason({
      attempt,
      integration,
      receipt,
      parsedResult,
      parsedGit,
      exactHeadSha,
      resultTooLarge,
    });
    let outcome: NavigatorTicketWorkerOutcome["outcome"] = reasonCode === null ? "succeeded" : "policy_failure";
    let finalReasonCode = reasonCode ?? "accepted";
    let verifiedBlockingBurden: number | null = null;
    if (reasonCode === null && parsedResult.success && parsedResult.data.kind === "code_review_result") {
      const review = this.assessReview(attempt, parsedResult.data, now);
      outcome = review.outcome;
      finalReasonCode = review.reasonCode;
      verifiedBlockingBurden = review.blockingBurden;
    }
    const result = parsedResult.success ? parsedResult.data : { kind: "policy_failure", reasonCode: finalReasonCode };
    return {
      outcome,
      reasonCode: finalReasonCode,
      result,
      parsedResult: parsedResult.success ? parsedResult.data : null,
      gitObservation,
      exactHeadSha,
      verifiedBlockingBurden,
      scheduleRetry: false,
      retrySameAttempt: false,
    };
  }

  private assessUnavailable(
    attempt: NavigatorTicketWorkerAttempt,
    effect: StoredEffect,
    receipt: NavigatorTicketReceipt,
    result: NavigatorTicketWorkerUnavailableResult,
  ): TicketSettlementAssessment {
    const validObservation = result.resourceObservation.resource.id === receipt.resource.id &&
      result.resourceObservation.state === (result.reason === "missing" ? "missing" : "terminal") &&
      receipt.exactHeadSha === attempt.workOrder.baseHeadSha;
    if (!validObservation) return this.policyFailureAssessment(attempt, "worker_reconciliation_rejected");
    const exhausted = effect.attempts >= retryMaximum(attempt.stepContract);
    return {
      outcome: exhausted ? "dead_letter" : "worker_unavailable",
      reasonCode: exhausted ? "retry_exhausted" : `worker_${result.reason}`,
      result: exhausted ? {
        kind: "worker_failure",
        failureClass: "retryable",
        retryClass: "bounded_exponential",
        attempts: effect.attempts,
        summary: `Navigator ticket worker remained unavailable (${result.reason})`,
      } : result,
      parsedResult: null,
      gitObservation: null,
      exactHeadSha: receipt.exactHeadSha,
      verifiedBlockingBurden: null,
      scheduleRetry: !exhausted,
      retrySameAttempt: false,
    };
  }

  private assessWorkerFailure(
    attempt: NavigatorTicketWorkerAttempt,
    effect: StoredEffect,
    receipt: NavigatorTicketReceipt,
    result: NavigatorTicketWorkerFailureResult,
  ): TicketSettlementAssessment {
    if (result.attempts !== effect.attempts || receipt.exactHeadSha !== attempt.workOrder.baseHeadSha) {
      return this.policyFailureAssessment(attempt, "worker_failure_rejected");
    }
    const exhausted = result.failureClass === "permanent" || effect.attempts >= retryMaximum(attempt.stepContract);
    return {
      outcome: exhausted ? "dead_letter" : null,
      reasonCode: exhausted ? (result.failureClass === "permanent" ? "permanent_failure" : "retry_exhausted") : "worker_retryable",
      result,
      parsedResult: null,
      gitObservation: null,
      exactHeadSha: receipt.exactHeadSha,
      verifiedBlockingBurden: null,
      scheduleRetry: false,
      retrySameAttempt: !exhausted,
    };
  }

  private policyFailureAssessment(
    attempt: NavigatorTicketWorkerAttempt,
    reasonCode: string,
  ): TicketSettlementAssessment {
    return {
      outcome: "policy_failure",
      reasonCode,
      result: { kind: "policy_failure", reasonCode },
      parsedResult: null,
      gitObservation: null,
      exactHeadSha: attempt.workOrder.baseHeadSha,
      verifiedBlockingBurden: null,
      scheduleRetry: false,
      retrySameAttempt: false,
    };
  }

  private assessReview(
    attempt: NavigatorTicketWorkerAttempt,
    reviewResult: Readonly<Extract<NavigatorTicketWorkerResult, { kind: "code_review_result" }>>,
    now: number,
  ): Readonly<{ outcome: NavigatorTicketWorkerOutcome["outcome"]; reasonCode: string; blockingBurden: number | null }> {
    if (attempt.workOrder.verificationOf !== undefined) {
      const verification = this.recordFindingVerification(attempt, reviewResult, now);
      if (verification.policyFailureReason !== null) {
        return { outcome: "policy_failure", reasonCode: verification.policyFailureReason, blockingBurden: verification.blockingBurden };
      }
      return verification.blockingBurden > 0
        ? { outcome: "findings", reasonCode: "confirmed_review_findings", blockingBurden: verification.blockingBurden }
        : { outcome: "succeeded", reasonCode: reviewResult.findings.length > 0 ? "accepted_advisories" : "findings_disputed", blockingBurden: 0 };
    }
    if (reviewResult.outcome === "findings") return { outcome: "findings", reasonCode: "review_findings_unverified", blockingBurden: null };
    const convergenceFailure = this.recordPassingReview(attempt, reviewResult, now);
    return convergenceFailure === null
      ? { outcome: "succeeded", reasonCode: "accepted", blockingBurden: 0 }
      : { outcome: "policy_failure", reasonCode: convergenceFailure, blockingBurden: null };
  }

  private resultHead(
    parsedResult: { success: false } | { success: true; data: NavigatorTicketWorkerResult },
    attempt: NavigatorTicketWorkerAttempt,
  ): string {
    if (!parsedResult.success) return attempt.workOrder.baseHeadSha;
    return parsedResult.data.kind === "implementation_result"
      ? parsedResult.data.headSha
      : parsedResult.data.reviewedHeadSha;
  }

  private receiptFailureReason(input: Readonly<{
    attempt: NavigatorTicketWorkerAttempt;
    integration: IntegrationRow;
    receipt: NavigatorTicketReceipt;
    parsedResult: { success: false } | { success: true; data: NavigatorTicketWorkerResult };
    parsedGit: { success: false } | { success: true; data: NavigatorGitObservation };
    exactHeadSha: string;
    resultTooLarge: boolean;
  }>): string | null {
    const { attempt, integration, receipt, parsedResult, parsedGit, exactHeadSha } = input;
    if (receipt.exactHeadSha !== exactHeadSha) return "receipt_head_mismatch";
    if (input.resultTooLarge) return "result_too_large";
    if (!parsedResult.success || parsedResult.data.kind !== (attempt.kind === "implementation" ? "implementation_result" : "code_review_result")) {
      return "malformed_result";
    }
    if (!this.bindingIsCurrent(attempt.workOrder.specification)) return "stale_specification";
    if (!this.bindingIsCurrent(attempt.workOrder.ticket)) return "stale_ticket";
    if (!resultCapabilitiesAreAccepted(parsedResult.data, attempt.profile)) return "capability_outcome_missing";
    if (!parsedGit.success || !this.gitObservationMatches(attempt, parsedResult.data, parsedGit.data)) return "git_observation_rejected";
    if (parsedResult.data.kind === "implementation_result") return this.implementationFailureReason(attempt, integration, parsedResult.data);
    if (parsedResult.data.reviewedHeadSha !== attempt.workOrder.baseHeadSha) return "review_head_mismatch";
    if (attempt.workOrder.verificationOf !== undefined && !this.verificationSourceMatches(attempt, parsedResult.data)) {
      return "finding_verification_source_mismatch";
    }
    return null;
  }

  private implementationFailureReason(
    attempt: NavigatorTicketWorkerAttempt,
    integration: IntegrationRow,
    result: Readonly<Extract<NavigatorTicketWorkerResult, { kind: "implementation_result" }>>,
  ): string | null {
    const ticketSnapshot = this.artifacts.getSnapshot(attempt.workOrder.ticket.snapshotId);
    if (
      result.baseHeadSha !== attempt.workOrder.baseHeadSha || result.headSha === attempt.workOrder.baseHeadSha ||
      integration.current_head_sha !== attempt.workOrder.baseHeadSha || ticketSnapshot === null ||
      !navigatorAcceptanceCriteriaAreSatisfied(ticketSnapshot, result.acceptanceCriteria) ||
      result.focusedVerification.some((verification) => verification.outcome !== "passed") ||
      result.fullVerification.some((verification) => verification.outcome !== "passed")
    ) return result.headSha === attempt.workOrder.baseHeadSha
      ? "implementation_head_not_advanced"
      : integration.current_head_sha !== attempt.workOrder.baseHeadSha
        ? "integration_head_drift"
        : "implementation_evidence_rejected";
    return null;
  }

  private verificationSourceMatches(
    attempt: NavigatorTicketWorkerAttempt,
    result: Readonly<Extract<NavigatorTicketWorkerResult, { kind: "code_review_result" }>>,
  ): boolean {
    const source = attempt.workOrder.verificationOf;
    if (source === undefined) return true;
    const sourceOutcome = this.ticketOutcome(source.attemptId);
    return sourceOutcome?.outcome === "findings" && sourceOutcome.resultDigest === source.resultDigest &&
      sourceOutcome.exactHeadSha === attempt.workOrder.baseHeadSha;
  }

  private gitObservationMatches(
    attempt: NavigatorTicketWorkerAttempt,
    workerResult: NavigatorTicketWorkerResult,
    observation: NavigatorGitObservation,
  ): boolean {
    const expectedHeadSha = workerResult.kind === "implementation_result" ? workerResult.headSha : workerResult.reviewedHeadSha;
    const expectedChangedPaths = workerResult.kind === "implementation_result"
      ? workerResult.changedPaths
      : attempt.workOrder.changedPaths;
    return observation.worktreeId === attempt.workOrder.worktreeId && observation.branch === attempt.workOrder.integrationBranch &&
      observation.headSha === expectedHeadSha && observation.baseHeadSha === attempt.workOrder.baseHeadSha && observation.baseHeadIsAncestor &&
      observation.comparisonBaseHeadSha === attempt.workOrder.comparisonBaseHeadSha && observation.comparisonBaseHeadIsAncestor && observation.clean &&
      JSON.stringify(observation.changedPaths) === JSON.stringify(expectedChangedPaths);
  }

  private bindingIsCurrent(binding: Readonly<{ artifactId: string; snapshotId: string; snapshotDigest: string }>): boolean {
    const snapshot = this.artifacts.getCurrentSnapshot(binding.artifactId);
    return snapshot?.id === binding.snapshotId && snapshot.snapshotDigest === binding.snapshotDigest &&
      this.artifacts.isSnapshotValid(binding.snapshotId);
  }

  private integrationRow(jobId: string): IntegrationRow | null {
    return this.db.prepare("SELECT * FROM navigator_integrations WHERE job_id = ?").get(jobId) as IntegrationRow | undefined ?? null;
  }

  private recordReceipt(
    receipt: NavigatorTicketReceipt,
    jobId: string,
    input: Readonly<{ ownerId: string; generation: number; now: number }>,
  ): void {
    const receiptJson = JSON.stringify(receipt);
    this.db.prepare(
      `INSERT INTO navigator_effect_receipts (
         effect_idempotency_key, job_id, kind, receipt_json, receipt_digest,
         owner_id, generation, recorded_at
       ) VALUES (?, ?, 'run_navigator_ticket_worker', ?, ?, ?, ?, ?)`,
    ).run(
      receipt.effectIdempotencyKey,
      jobId,
      receiptJson,
      createHash("sha256").update(receiptJson, "utf8").digest("hex"),
      input.ownerId,
      input.generation,
      input.now,
    );
  }

  private recordOutcome(
    attempt: NavigatorTicketWorkerAttempt,
    assessment: TicketSettlementAssessment,
    now: number,
  ): void {
    const gitObservationDigest = assessment.gitObservation === null ? null : navigatorJsonDigest(assessment.gitObservation);
    const resultJson = JSON.stringify(assessment.result);
    this.db.prepare(
      `INSERT INTO navigator_ticket_worker_outcomes (
         attempt_id, slice_id, outcome, reason_code, exact_head_sha,
         result_json, result_digest, git_observation_json, git_observation_digest, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      attempt.id,
      attempt.sliceId,
      assessment.outcome,
      assessment.reasonCode,
      assessment.exactHeadSha,
      resultJson,
      navigatorJsonDigest(assessment.result),
      assessment.gitObservation === null ? null : JSON.stringify(assessment.gitObservation),
      gitObservationDigest,
      now,
    );
  }

  private applyWorkflowState(
    attempt: NavigatorTicketWorkerAttempt,
    integration: IntegrationRow,
    effect: StoredEffect,
    assessment: TicketSettlementAssessment,
    now: number,
  ): void {
    if (assessment.scheduleRetry) {
      this.scheduleRetryAttempt(attempt, integration, effect, now);
      return;
    }
    if (assessment.outcome === null) return;
    if (assessment.retrySameAttempt) return;
    if (assessment.outcome === "policy_failure") {
      this.invalidateIntegration(integration, assessment.reasonCode, now);
      return;
    }
    if (assessment.outcome === "dead_letter") {
      this.invalidateIntegration(integration, assessment.reasonCode, now);
      return;
    }
    if (attempt.kind === "implementation") {
      const implementationResult = navigatorImplementationResultSchema.parse(assessment.result);
      this.acceptImplementation(attempt, implementationResult.headSha, implementationResult.changedPaths, now);
      return;
    }
    if (assessment.outcome === "findings" && attempt.workOrder.verificationOf === undefined) {
      const reviewResult = navigatorCodeReviewResultSchema.parse(assessment.result);
      this.scheduleFindingVerification(attempt, reviewResult, navigatorJsonDigest(assessment.result), now);
      return;
    }
    if (assessment.outcome === "findings" && assessment.verifiedBlockingBurden !== null) {
      this.db.prepare(
        "UPDATE navigator_ticket_slices SET state = 'repair_pending', updated_at = ? WHERE id = ?",
      ).run(now, attempt.sliceId);
      return;
    }
    this.db.prepare(
      "UPDATE navigator_ticket_slices SET state = 'accepted', accepted_head_sha = ?, updated_at = ? WHERE id = ?",
    ).run(assessment.exactHeadSha, now, attempt.sliceId);
    this.db.prepare(
      `UPDATE navigator_integration_tickets
          SET state = 'accepted', accepted_head_sha = ?
        WHERE job_id = ? AND artifact_id = ?`,
    ).run(assessment.exactHeadSha, attempt.jobId, attempt.workOrder.ticket.artifactId);
  }

  private scheduleRetryAttempt(
    attempt: NavigatorTicketWorkerAttempt,
    integration: IntegrationRow,
    effect: StoredEffect,
    now: number,
  ): void {
    if (integration.state !== "implementing") throw new TypeError("navigator integration is not retryable");
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
      modelRoute: attempt.modelRoute,
      effectAttempts: effect.attempts,
      nextAttemptAt: now + retryDelay(attempt.stepContract, effect.attempts),
    });
    this.db.prepare(
      "UPDATE navigator_ticket_slices SET state = ?, updated_at = ? WHERE id = ?",
    ).run(attempt.kind === "implementation" ? "implementation_pending" : "review_pending", now, attempt.sliceId);
  }

  private retryEffect(
    effectKey: string,
    ownerId: string,
    generation: number,
    attempt: NavigatorTicketWorkerAttempt,
    now: number,
  ): void {
    const nextAttemptAt = now + retryDelay(attempt.stepContract, this.effect(effectKey)?.attempts ?? 1);
    const updated = this.db.prepare(
      `UPDATE effects SET status = 'failed', lease_owner = NULL, lease_generation = NULL,
          lease_expires_at = NULL, last_error = 'navigator ticket worker retryable failure',
          next_attempt_at = ?, updated_at = ?
        WHERE idempotency_key = ? AND status = 'leased' AND lease_owner = ?
          AND lease_generation = ? AND lease_expires_at > ?`,
    ).run(nextAttemptAt, now, effectKey, ownerId, generation, now);
    if (updated.changes !== 1) throw new Error("navigator ticket effect lease changed before retry");
  }

  private acceptImplementation(
    attempt: NavigatorTicketWorkerAttempt,
    headSha: string,
    changedPaths: readonly string[],
    now: number,
  ): void {
    const integration = this.integrationRow(attempt.jobId);
    if (!integration) throw new Error("navigator integration disappeared before implementation settlement");
    this.db.prepare(
      "UPDATE navigator_integrations SET current_head_sha = ?, updated_at = ? WHERE job_id = ?",
    ).run(headSha, now, attempt.jobId);
    this.db.prepare(
      "UPDATE navigator_ticket_slices SET state = 'review_pending', updated_at = ? WHERE id = ?",
    ).run(now, attempt.sliceId);
    const ticket = this.requireTicket(attempt.jobId, attempt.workOrder.ticket.artifactId);
    this.createAttempt({
      integration: this.integrationRow(attempt.jobId)!,
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
      modelRoute: this.reviewModelRoute(),
    });
  }

  private scheduleFindingVerification(
    attempt: NavigatorTicketWorkerAttempt,
    reviewResult: Readonly<{ findings: readonly NavigatorReviewFinding[] }>,
    resultDigest: string,
    now: number,
  ): void {
    const integration = this.integrationRow(attempt.jobId);
    if (!integration) throw new Error("navigator integration disappeared before review verification");
    this.db.prepare(
      "UPDATE navigator_ticket_slices SET state = 'review_pending', updated_at = ? WHERE id = ?",
    ).run(now, attempt.sliceId);
    this.createAttempt({
      integration,
      sliceId: attempt.sliceId,
      ticket: this.requireTicket(attempt.jobId, attempt.workOrder.ticket.artifactId),
      kind: "review",
      ordinal: this.nextAttemptOrdinal(attempt.sliceId, "review"),
      taskEvidence: attempt.workOrder.taskEvidence,
      evidenceRefs: mergeEvidenceRefs(
        attempt.workOrder.evidenceRefs,
        [`navigator-result:${attempt.id}`],
        [`navigator-verify:${attempt.id}`],
      ),
      changedPaths: attempt.workOrder.changedPaths,
      baseHeadSha: attempt.workOrder.baseHeadSha,
      comparisonBaseHeadSha: attempt.workOrder.comparisonBaseHeadSha,
      verificationOf: { attemptId: attempt.id, resultDigest, findings: reviewResult.findings },
      now,
      modelRoute: this.reviewModelRoute(),
    });
  }

  private reviewModelRoute(): ModelRoute {
    return parseNavigatorTicketModelRoute({
      pool: "strong",
      ...DEFAULT_MODEL_POOL_REGISTRY.worker.strong,
    }, "review");
  }

  private currentFindingRows(jobId: string, sliceId?: string): FindingEventRow[] {
    return this.db.prepare(
      `SELECT event.*
         FROM navigator_review_finding_events AS event
        WHERE event.job_id = ? AND (? IS NULL OR event.slice_id = ?)
          AND event.sequence = (
            SELECT MAX(newest.sequence) FROM navigator_review_finding_events AS newest
             WHERE newest.slice_id = event.slice_id AND newest.root_cause_id = event.root_cause_id
          )
        ORDER BY event.slice_id, event.root_cause_id`,
    ).all(jobId, sliceId ?? null, sliceId ?? null) as FindingEventRow[];
  }

  public currentFindingLedger(jobId: string): NavigatorFindingLedgerEntry[] {
    return this.currentFindingRows(jobId).map((row) => ({
      rootCauseId: row.root_cause_id,
      sliceId: row.slice_id,
      sourceReviewAttemptId: row.source_review_attempt_id,
      verificationAttemptId: row.verification_attempt_id,
      disposition: row.disposition,
      state: findingState(row.event),
      occurrence: row.occurrence,
      blockingBurden: row.blocking_burden,
      headSha: row.head_sha,
      finding: navigatorReviewFindingSchema.parse(JSON.parse(row.finding_json)),
    }));
  }

  private appendFindingEvent(input: Readonly<{
    attempt: NavigatorTicketWorkerAttempt;
    sourceReviewAttemptId: string;
    finding: NavigatorReviewFinding;
    disposition: "must_fix" | "advisory";
    event: FindingEventRow["event"];
    occurrence: number;
    blockingBurden: number;
    evidenceRefs: readonly string[];
    now: number;
  }>): void {
    const eventId = stableId("navfinding", input.attempt.id, input.finding.rootCauseId, input.event);
    this.db.prepare(
      `INSERT INTO navigator_review_finding_events (
         id, job_id, slice_id, source_review_attempt_id, verification_attempt_id,
         root_cause_id, capability_id, rule_id, disposition, event, head_sha,
         finding_json, evidence_refs_json, occurrence, blocking_burden, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      eventId,
      input.attempt.jobId,
      input.attempt.sliceId,
      input.sourceReviewAttemptId,
      input.attempt.id,
      input.finding.rootCauseId,
      input.finding.capabilityId,
      input.finding.ruleId,
      input.disposition,
      input.event,
      input.attempt.workOrder.baseHeadSha,
      JSON.stringify(input.finding),
      JSON.stringify(boundedRefs(input.evidenceRefs)),
      input.occurrence,
      input.blockingBurden,
      input.now,
    );
  }

  private recordPassingReview(
    attempt: NavigatorTicketWorkerAttempt,
    reviewResult: Readonly<{ axes: { requirements: { evidenceRefs: readonly string[] }; standards: { evidenceRefs: readonly string[] } } }>,
    now: number,
  ): string | null {
    const current = this.currentFindingRows(attempt.jobId, attempt.sliceId);
    const convergence = this.db.prepare("SELECT * FROM navigator_review_convergence WHERE slice_id = ?")
      .get(attempt.sliceId) as ConvergenceRow | undefined;
    const reviewCycles = (convergence?.review_cycles ?? 0) + 1;
    if (reviewCycles > attempt.workOrder.projectPolicy.maxReviewCycles) return "review_cycle_limit";
    for (const row of current) {
      if (findingState(row.event) !== "open") continue;
      this.appendFindingEvent({
        attempt,
        sourceReviewAttemptId: attempt.id,
        finding: navigatorReviewFindingSchema.parse(JSON.parse(row.finding_json)),
        disposition: row.disposition,
        event: "resolved",
        occurrence: row.occurrence,
        blockingBurden: 0,
        evidenceRefs: mergeEvidenceRefs(
          reviewResult.axes.requirements.evidenceRefs,
          reviewResult.axes.standards.evidenceRefs,
          [`navigator-result:${attempt.id}`],
        ),
        now,
      });
    }
    this.db.prepare(
      `INSERT INTO navigator_review_convergence (
         slice_id, last_blocking_burden, plateau_recoveries, review_cycles, updated_at
       ) VALUES (?, 0, ?, ?, ?)
       ON CONFLICT(slice_id) DO UPDATE SET last_blocking_burden = 0,
         review_cycles = excluded.review_cycles, updated_at = excluded.updated_at`,
    ).run(attempt.sliceId, convergence?.plateau_recoveries ?? 0, reviewCycles, now);
    return null;
  }

  private recordFindingVerification(
    attempt: NavigatorTicketWorkerAttempt,
    reviewResult: Readonly<{ findings: readonly NavigatorReviewFinding[] }>,
    now: number,
  ): Readonly<{ blockingBurden: number; policyFailureReason: string | null }> {
    const verification = attempt.workOrder.verificationOf;
    if (verification === undefined) return { blockingBurden: 0, policyFailureReason: "finding_verification_source_missing" };
    const source = new Map(verification.findings.map((finding) => [finding.rootCauseId, finding]));
    const selectedCapabilities = new Set(attempt.profile.assignments.map(({ capabilityId }) => capabilityId));
    const dispositions = new Map<string, "must_fix" | "advisory">();
    for (const finding of verification.findings) {
      const disposition = navigatorFindingDisposition(finding);
      if (disposition === null || !selectedCapabilities.has(finding.capabilityId)) {
        return { blockingBurden: 0, policyFailureReason: "finding_policy_unregistered" };
      }
      dispositions.set(finding.rootCauseId, disposition);
    }
    const confirmed = new Map<string, NavigatorReviewFinding>();
    for (const finding of reviewResult.findings) {
      const reported = source.get(finding.rootCauseId);
      if (reported === undefined || confirmed.has(finding.rootCauseId) || !sameRootCause(reported, finding)) {
        return { blockingBurden: 0, policyFailureReason: "finding_verification_mismatch" };
      }
      confirmed.set(finding.rootCauseId, finding);
    }
    return this.persistFindingVerification({ attempt, verification, reviewResult, source, confirmed, dispositions, now });
  }

  private persistFindingVerification(input: Readonly<{
    attempt: NavigatorTicketWorkerAttempt;
    verification: NonNullable<NavigatorTicketWorkerAttempt["workOrder"]["verificationOf"]>;
    reviewResult: Readonly<{ findings: readonly NavigatorReviewFinding[] }>;
    source: ReadonlyMap<string, NavigatorReviewFinding>;
    confirmed: ReadonlyMap<string, NavigatorReviewFinding>;
    dispositions: ReadonlyMap<string, "must_fix" | "advisory">;
    now: number;
  }>): Readonly<{ blockingBurden: number; policyFailureReason: string | null }> {
    const currentRows = this.currentFindingRows(input.attempt.jobId, input.attempt.sliceId);
    const current = new Map(currentRows.map((row) => [row.root_cause_id, row]));
    const next = new Map(currentRows.map((row) => [row.root_cause_id, {
      disposition: row.disposition,
      state: findingState(row.event),
      occurrence: row.occurrence,
    }]));
    for (const finding of input.verification.findings) {
      const prior = current.get(finding.rootCauseId);
      const isConfirmed = input.confirmed.has(finding.rootCauseId);
      next.set(finding.rootCauseId, {
        disposition: input.dispositions.get(finding.rootCauseId)!,
        state: isConfirmed ? "open" : "disputed",
        occurrence: isConfirmed ? Math.min(3, (prior?.occurrence ?? 0) + 1) : prior?.occurrence ?? 0,
      });
    }
    for (const row of currentRows) {
      if (findingState(row.event) === "open" && !input.source.has(row.root_cause_id)) {
        next.set(row.root_cause_id, { disposition: row.disposition, state: "resolved", occurrence: row.occurrence });
      }
    }
    const blockingBurden = [...next.values()].filter((entry) => entry.state === "open" && entry.disposition === "must_fix").length;
    const evidenceRefs = mergeEvidenceRefs(
      input.reviewResult.findings.flatMap((finding) => finding.evidenceRefs),
      [`navigator-result:${input.attempt.id}`],
      [`navigator-result:${input.verification.attemptId}`],
    );
    this.appendFindingVerificationEvents({ ...input, currentRows, current, next, evidenceRefs, blockingBurden });
    const convergence = this.db.prepare("SELECT * FROM navigator_review_convergence WHERE slice_id = ?")
      .get(input.attempt.sliceId) as ConvergenceRow | undefined;
    const reviewCycles = (convergence?.review_cycles ?? 0) + 1;
    let plateauRecoveries = convergence?.plateau_recoveries ?? 0;
    let policyFailureReason: string | null = null;
    if ([...next.values()].some((entry) => entry.state === "open" && entry.occurrence >= 3)) policyFailureReason = "finding_recurrence_limit";
    else if (reviewCycles > input.attempt.workOrder.projectPolicy.maxReviewCycles) policyFailureReason = "review_cycle_limit";
    else if (convergence !== undefined && convergence.last_blocking_burden > 0 && blockingBurden >= convergence.last_blocking_burden) {
      if (plateauRecoveries === 0) plateauRecoveries = 1;
      else policyFailureReason = "review_burden_plateau";
    }
    this.db.prepare(
      `INSERT INTO navigator_review_convergence (
         slice_id, last_blocking_burden, plateau_recoveries, review_cycles, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(slice_id) DO UPDATE SET last_blocking_burden = excluded.last_blocking_burden,
         plateau_recoveries = excluded.plateau_recoveries, review_cycles = excluded.review_cycles,
         updated_at = excluded.updated_at`,
    ).run(input.attempt.sliceId, blockingBurden, plateauRecoveries, reviewCycles, input.now);
    return { blockingBurden, policyFailureReason };
  }

  private appendFindingVerificationEvents(input: Readonly<{
    attempt: NavigatorTicketWorkerAttempt;
    verification: NonNullable<NavigatorTicketWorkerAttempt["workOrder"]["verificationOf"]>;
    currentRows: readonly FindingEventRow[];
    current: ReadonlyMap<string, FindingEventRow>;
    next: ReadonlyMap<string, Readonly<{ disposition: "must_fix" | "advisory"; state: string; occurrence: number }>>;
    confirmed: ReadonlyMap<string, NavigatorReviewFinding>;
    dispositions: ReadonlyMap<string, "must_fix" | "advisory">;
    evidenceRefs: readonly string[];
    blockingBurden: number;
    now: number;
    reviewResult: Readonly<{ findings: readonly NavigatorReviewFinding[] }>;
    source: ReadonlyMap<string, NavigatorReviewFinding>;
  }>): void {
    for (const finding of input.verification.findings) {
      const prior = input.current.get(finding.rootCauseId);
      const isConfirmed = input.confirmed.has(finding.rootCauseId);
      this.appendFindingEvent({
        attempt: input.attempt,
        sourceReviewAttemptId: input.verification.attemptId,
        finding: isConfirmed ? input.confirmed.get(finding.rootCauseId)! : finding,
        disposition: input.dispositions.get(finding.rootCauseId)!,
        event: isConfirmed ? (prior && findingState(prior.event) === "open" ? "reobserved" : "opened") : "disputed",
        occurrence: input.next.get(finding.rootCauseId)!.occurrence,
        blockingBurden: input.blockingBurden,
        evidenceRefs: input.evidenceRefs,
        now: input.now,
      });
    }
    for (const row of input.currentRows) {
      if (findingState(row.event) !== "open" || input.source.has(row.root_cause_id)) continue;
      this.appendFindingEvent({
        attempt: input.attempt,
        sourceReviewAttemptId: input.verification.attemptId,
        finding: navigatorReviewFindingSchema.parse(JSON.parse(row.finding_json)),
        disposition: row.disposition,
        event: "resolved",
        occurrence: row.occurrence,
        blockingBurden: input.blockingBurden,
        evidenceRefs: input.evidenceRefs,
        now: input.now,
      });
    }
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

  private requireSlice(sliceId: string): SliceRow {
    const slice = this.db.prepare("SELECT * FROM navigator_ticket_slices WHERE id = ?").get(sliceId) as SliceRow | undefined;
    if (!slice) throw new Error(`navigator ticket slice ${sliceId} was not found`);
    return slice;
  }

  private nextAttemptOrdinal(sliceId: string, kind: "implementation" | "review"): number {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM navigator_ticket_worker_attempts WHERE slice_id = ? AND kind = ?",
    ).get(sliceId, kind) as { ordinal: number };
    return row.ordinal + 1;
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
    modelRoute: ModelRoute;
    verificationOf?: Readonly<{
      attemptId: string;
      resultDigest: string;
      findings: readonly NavigatorReviewFinding[];
    }>;
    effectAttempts?: number;
    nextAttemptAt?: number;
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
      ...(input.verificationOf === undefined ? {} : { verificationOf: input.verificationOf }),
    });
    const workerProfile = navigatorTicketWorkerProfile({
      kind: input.kind,
      taskEvidence: input.taskEvidence,
      changedPaths: input.changedPaths,
    });
    const stepContract = NAVIGATOR_TICKET_STEP_CONTRACTS[input.kind];
    const route = parseNavigatorTicketModelRoute(modelRouteSchema.parse(input.modelRoute), input.kind);
    const attemptId = stableId("navworker", input.sliceId, input.kind, String(input.ordinal));
    const effectKey = `${input.integration.job_id}:navigator-ticket:${attemptId}`;
    const capabilityProfile = this.createCapabilityProfile(attemptId, route, workerProfile, input.now);
    this.insertAttemptEffect({
      effectKey,
      jobId: input.integration.job_id,
      attemptId,
      sliceId: input.sliceId,
      effectAttempts: input.effectAttempts,
      nextAttemptAt: input.nextAttemptAt,
      now: input.now,
    });
    this.db.prepare(
      `INSERT INTO navigator_ticket_worker_attempts (
         id, job_id, slice_id, kind, ordinal, effect_idempotency_key,
         work_order_json, work_order_digest, step_contract_id, step_contract_revision,
         step_contract_digest, step_contract_json, profile_json, profile_digest, model_route_json,
         capability_profile_id, capability_profile_revision, resource_kind, resource_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
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
      JSON.stringify(stepContract),
      JSON.stringify(workerProfile),
      workerProfile.digest,
      JSON.stringify(route),
      capabilityProfile.id,
      capabilityProfile.revision,
      input.now,
      input.now,
    );
    this.recordCapabilityEvidence({
      effectIdempotencyKey: effectKey,
      jobId: input.integration.job_id,
      projectId: (JSON.parse(input.integration.project_policy_json) as { projectId: string }).projectId,
      profileId: capabilityProfile.id,
      profileRevision: capabilityProfile.revision,
      assignments: workerProfile.assignments.map((assignment) => ({
        capabilityId: assignment.capabilityId,
        capabilityKind: "skill",
        descriptorDigest: assignment.descriptorDigest,
      })),
      now: input.now,
    });
    return this.ticketAttempt(attemptId)!;
  }

  private createCapabilityProfile(
    attemptId: string,
    route: ModelRoute,
    workerProfile: NavigatorTicketWorkerProfile,
    now: number,
  ) {
    return this.capabilities.createProfile({
      subjectKind: "worker_attempt",
      subjectId: attemptId,
      threadId: null,
      recipeId: "navigator-v1",
      recipeVersion: 1,
      registryDigest: CAPABILITY_REGISTRY_DIGEST,
      graphDigest: CAPABILITY_GRAPH_DIGEST,
      mode: "active",
      model: route,
      assignments: workerProfile.assignments.map((assignment) => ({
        capabilityId: assignment.capabilityId,
        capabilityKind: "skill" as const,
        descriptorDigest: assignment.descriptorDigest,
        mandatory: true,
      })),
      reasonCodes: ["navigator_effect_admission"],
      traits: [],
      now,
    });
  }

  private insertAttemptEffect(input: Readonly<{
    effectKey: string;
    jobId: string;
    attemptId: string;
    sliceId: string;
    effectAttempts?: number;
    nextAttemptAt?: number;
    now: number;
  }>): void {
    this.db.prepare(
      `INSERT INTO effects (
         idempotency_key, job_id, kind, payload_json, status, attempts,
         next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, 'run_navigator_ticket_worker', ?, 'pending', ?, ?, ?, ?)`,
    ).run(
      input.effectKey,
      input.jobId,
      JSON.stringify({ attemptId: input.attemptId, sliceId: input.sliceId }),
      input.effectAttempts ?? 0,
      input.nextAttemptAt ?? input.now,
      input.now,
      input.now,
    );
  }

  private recordCapabilityEvidence(input: Readonly<{
    effectIdempotencyKey: string;
    jobId: string;
    projectId: string;
    profileId: string;
    profileRevision: number;
    assignments: readonly Readonly<{ capabilityId: string; capabilityKind: string; descriptorDigest: string }>[];
    now: number;
  }>): void {
    const selectedReceipt = this.db.prepare(
      `SELECT id, capability_kind, descriptor_digest FROM capability_receipts
        WHERE profile_id = ? AND capability_id = ? AND event_type = 'selected'`,
    );
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO navigator_effect_capability_evidence (
         effect_idempotency_key, job_id, project_id, operation,
         profile_id, profile_revision, capability_id, capability_kind,
         descriptor_digest, receipt_id, owner_id, generation, admitted_at, created_at
       ) VALUES (?, ?, ?, 'worktree_write', ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    );
    for (const assignment of input.assignments) {
      const selected = selectedReceipt.get(input.profileId, assignment.capabilityId) as {
        id: string;
        capability_kind: string;
        descriptor_digest: string;
      } | undefined;
      if (!selected || selected.capability_kind !== assignment.capabilityKind || selected.descriptor_digest !== assignment.descriptorDigest) {
        throw new TypeError("navigator capability selection receipt is not exact");
      }
      insert.run(
        input.effectIdempotencyKey,
        input.jobId,
        input.projectId,
        input.profileId,
        input.profileRevision,
        assignment.capabilityId,
        assignment.capabilityKind,
        assignment.descriptorDigest,
        selected.id,
        input.now,
      );
    }
  }

  private claimFenceIsCurrent(
    attempt: NavigatorTicketWorkerAttempt,
    ownerId: string,
    generation: number,
    now: number,
  ): boolean {
    const slice = this.requireSlice(attempt.sliceId);
    const claim = this.artifacts.getClaim(slice.claim_id);
    const projectClaim = this.db.prepare(
      `SELECT 1 FROM job_resource_claims
        WHERE job_id = ? AND resource_key = ? AND resource_kind = 'project' AND state = 'held'
          AND owner_id = ? AND generation = ? AND lease_expires_at > ?`,
    ).get(
      attempt.jobId,
      projectResourceKey(attempt.workOrder.projectPolicy.projectId),
      ownerId,
      generation,
      now,
    );
    return claim !== null && claim.state === "held" && claim.jobId === attempt.jobId &&
      claim.artifactId === attempt.workOrder.ticket.artifactId && claim.snapshotId === attempt.workOrder.ticket.snapshotId &&
      claim.ownerId === ownerId && claim.generation === generation && claim.leaseExpiresAt > now &&
      projectClaim !== undefined && this.bindingIsCurrent(attempt.workOrder.ticket) &&
      this.executorFenceIsCurrent(ownerId, generation, now);
  }

  private executorFenceIsCurrent(ownerId: string, generation: number, now: number): boolean {
    return this.db.prepare(
      `SELECT 1 FROM executor_lease WHERE singleton = 1 AND owner_id = ?
        AND generation = ? AND lease_expires_at > ?`,
    ).get(ownerId, generation, now) !== undefined;
  }

  private effectLeaseCurrent(effectKey: string, ownerId: string, generation: number, now: number): boolean {
    return this.executorFenceIsCurrent(ownerId, generation, now) && this.db.prepare(
      `SELECT 1 FROM effects WHERE idempotency_key = ? AND status = 'leased'
        AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?`,
    ).get(effectKey, ownerId, generation, now) !== undefined;
  }

  private finishEffect(effectKey: string, ownerId: string, generation: number, now: number): void {
    const updated = this.db.prepare(
      `UPDATE effects SET status = 'done', lease_owner = NULL, lease_generation = NULL,
          lease_expires_at = NULL, last_error = NULL, updated_at = ?
        WHERE idempotency_key = ? AND status = 'leased' AND lease_owner = ?
          AND lease_generation = ? AND lease_expires_at > ?`,
    ).run(now, effectKey, ownerId, generation, now);
    if (updated.changes !== 1) throw new Error("navigator ticket effect lease changed before settlement");
  }

  private invalidateIntegration(integration: IntegrationRow, reasonCode: string, now: number): void {
    this.db.prepare(
      "UPDATE navigator_integrations SET state = 'invalidated', updated_at = ? WHERE job_id = ?",
    ).run(now, integration.job_id);
    if (integration.active_slice_id !== null) {
      this.db.prepare(
        "UPDATE navigator_ticket_slices SET state = 'invalidated', updated_at = ? WHERE id = ?",
      ).run(now, integration.active_slice_id);
      this.db.prepare(
        `UPDATE navigator_integration_tickets SET state = 'invalidated'
          WHERE job_id = ? AND artifact_id = (SELECT ticket_artifact_id FROM navigator_ticket_slices WHERE id = ?)`,
      ).run(integration.job_id, integration.active_slice_id);
    }
    this.db.prepare("UPDATE jobs SET last_error = ?, updated_at = ? WHERE id = ?")
      .run(`Navigator implementation invalidated: ${reasonCode}`, now, integration.job_id);
  }

  private requireSliceForTicket(jobId: string, ticketArtifactId: string): SliceRow {
    const slice = this.db.prepare(
      "SELECT * FROM navigator_ticket_slices WHERE job_id = ? AND ticket_artifact_id = ?",
    ).get(jobId, ticketArtifactId) as SliceRow | undefined;
    if (!slice) throw new Error(`navigator ticket slice ${ticketArtifactId} was not found`);
    return slice;
  }
}
