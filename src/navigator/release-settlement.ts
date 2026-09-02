import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { isReleaseCandidate } from "../autonomy/models";
import { AutonomyRepository } from "../storage/autonomy-repository";
import {
  assessGuardEnvelope,
  guardAssessmentPolicySchema,
  guardResultEnvelopeSchema,
  type GuardEnvelopeAssessment,
} from "../capabilities/guards";
import type { Job, JobEvent } from "../domain/models";
import { transition } from "../domain/state-machine";
import { renderJobFinishNote } from "../telegram/finish-note";
import {
  MAX_MERGE_RESULT_JSON,
  assertNoRawMergeCallback,
  assertSafeExternalHttpsUrl,
  parseStoredEffect,
  persistJobTransition,
  persistPendingEffects,
  readJobById,
  serializeBoundedJson,
  type EffectRow,
} from "../storage/job-persistence";
import { TaskAuthorityRepository } from "../storage/task-authority-repository";
import {
  navigatorReleaseReceiptSchema,
  type NavigatorReleaseReceipt,
} from "./effect-contracts";
import {
  NAVIGATOR_RELEASE_STATES,
} from "./release-contracts";

type SqliteDatabase = Database.Database;

export type NavigatorReleaseEffectSettlementInput = Readonly<{
  ownerId: string;
  generation: number;
  now: number;
  effectIdempotencyKey: string;
  number: number;
  url: string;
  environmentId: string;
  receipt?: NavigatorReleaseReceipt;
}>;

export type NavigatorReleaseTransitionInput = Readonly<{
  previous: Job;
  next: Job;
  event: JobEvent;
  now: number;
  reviewAttemptIds: readonly string[];
}>;

type ReleaseReviewAttempt = Readonly<{
  id: string;
  jobId: string;
  reviewStage: string | null;
  headSha: string | null;
  resultJson: string | null;
}>;

type NavigatorReleaseReviewFinding = Readonly<{
  sourceAttemptId: string;
  fingerprint: string;
  capabilityId: string;
  ruleId: string;
  disposition: "must_fix" | "advisory";
  findingJson: string;
}>;

type NavigatorReleaseReviewFindingRow = Readonly<{
  fingerprint: string;
  capability_id: string;
  rule_id: string;
  disposition: "must_fix" | "advisory";
  event: "opened" | "reobserved" | "resolved";
  finding_json: string;
  occurrence: number;
}>;

type ReviewFindingEventInput = Readonly<{
  job: Job;
  sourceAttemptId: string;
  fingerprint: string;
  capabilityId: string;
  ruleId: string;
  disposition: "must_fix" | "advisory";
  event: "opened" | "reobserved" | "resolved";
  findingJson: string;
  occurrence: number;
  blockingBurden: number;
  now: number;
}>;

type ReviewFindingRecordingContext = Readonly<{
  job: Job;
  current: ReadonlyMap<string, NavigatorReleaseReviewFindingRow>;
  observed: ReadonlyMap<string, NavigatorReleaseReviewFinding>;
  blockingBurden: number;
  now: number;
}>;

function assertIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
    throw new TypeError(`${field} must be a bounded non-empty string`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive safe integer`);
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
}

function navigatorReleaseStartedEvent(
  input: NavigatorReleaseEffectSettlementInput,
  url: string,
): Extract<JobEvent, { type: "RELEASE_STARTED" }> {
  return {
    type: "RELEASE_STARTED",
    number: input.number,
    url,
    environmentId: input.environmentId,
  };
}

export class NavigatorReleaseSettlementRepository {
  private readonly autonomy: AutonomyRepository;

  public constructor(
    private readonly db: SqliteDatabase,
    private readonly taskAuthorities: TaskAuthorityRepository,
  ) {
    this.autonomy = new AutonomyRepository(db);
  }

  public settleEffect(input: NavigatorReleaseEffectSettlementInput): boolean {
    this.assertSettlementInput(input);
    const url = assertSafeExternalHttpsUrl(input.url, "navigator release pull request URL");
    const receipt = this.parseReceipt(input.receipt);
    if (receipt === null) return false;
    return this.settleCurrentEffect({ input, url, receipt });
  }

  private settleCurrentEffect(input: Readonly<{
    input: NavigatorReleaseEffectSettlementInput;
    url: string;
    receipt: NavigatorReleaseReceipt;
  }>): boolean {
    const settle = this.db.transaction(() => this.settleCurrentEffectInTransaction(input));
    return settle.immediate();
  }

  private settleCurrentEffectInTransaction(input: Readonly<{
    input: NavigatorReleaseEffectSettlementInput;
    url: string;
    receipt: NavigatorReleaseReceipt;
  }>): boolean {
    const { input: settlement, receipt } = input;
    if (!this.executorLeaseCurrent(settlement.ownerId, settlement.generation, settlement.now)) return false;
    const effectRow = this.effectByKey(settlement.effectIdempotencyKey);
    if (!effectRow || !this.navigatorReleaseEffectIsCurrent(effectRow, settlement)) return false;
    if (!this.releaseReceiptMatches(receipt, effectRow, settlement, input.url)) return false;
    const current = readJobById(this.db, effectRow.job_id);
    if (!current || current.cancelRequestedAt !== null || current.state === "cancelled") return false;
    if (current.state === "implementing") this.startRelease(current, settlement, input.url);
    this.recordReceipt(receipt, effectRow.job_id, settlement);
    if (!this.completeEffect(effectRow, settlement)) {
      throw new Error("navigator release effect lease changed before receipt settlement");
    }
    return true;
  }

  private parseReceipt(receipt: NavigatorReleaseReceipt | undefined): NavigatorReleaseReceipt | null {
    const parsedReceipt = navigatorReleaseReceiptSchema.safeParse(receipt);
    return parsedReceipt.success ? parsedReceipt.data : null;
  }

  public recordReleaseTransition(input: NavigatorReleaseTransitionInput): void {
    if (!this.isNavigatorReleaseTransition(input.previous)) return;
    this.recordReviewFindings(input.previous, input.event, input.reviewAttemptIds, input.now);
    const returnedToNavigation = input.next.state === "implementing";
    const releaseFinished = input.next.state === "complete" ||
      input.next.state === "merged" || input.next.state === "production_failed";
    if (!returnedToNavigation && !releaseFinished) return;
    this.clearReleaseWorkflowStep(input.next);
    if (returnedToNavigation) this.recordReturnToNavigation(input);
  }

  private isNavigatorReleaseTransition(job: Job): boolean {
    return job.workflowEngine === "navigator-v1" &&
      (NAVIGATOR_RELEASE_STATES as readonly string[]).includes(job.state);
  }

  private clearReleaseWorkflowStep(next: Job): void {
    this.db.prepare(
      `UPDATE jobs SET current_workflow_step_id = NULL, workflow_revision = workflow_revision + 1
        WHERE id = ?`,
    ).run(next.id);
    next.currentWorkflowStepId = null;
    next.workflowRevision += 1;
  }

  private recordReturnToNavigation(input: NavigatorReleaseTransitionInput): void {
    const reasonCode = this.releaseReturnReason(input.event);
    this.insertReleaseFinding(input, reasonCode);
    if (input.event.type === "PRODUCTION_INCIDENT_RECOVERED") {
      this.recordProductionIncidentNotice(input.next.id, input.event.phase, input.now);
    }
  }

  private releaseReturnReason(event: JobEvent): string {
    return event.type === "VALIDATION_FAILED"
      ? "validation_failed"
      : event.type === "REVIEW_CHANGES_REQUESTED"
        ? "review_changes_requested"
        : event.type === "REVIEW_PASSED"
          ? "documentation_required"
          : event.type === "PRODUCTION_INCIDENT_RECOVERED"
            ? "production_incident_recovered"
            : "release_findings";
  }

  private insertReleaseFinding(input: NavigatorReleaseTransitionInput, reasonCode: string): void {
    this.db.prepare(
      `INSERT INTO navigator_release_findings (
         job_id, workflow_step_id, reason_code, previous_state, recorded_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      input.next.id,
      input.previous.currentWorkflowStepId,
      reasonCode,
      input.previous.state,
      input.now,
    );
  }

  private assertSettlementInput(input: NavigatorReleaseEffectSettlementInput): void {
    assertIdentifier(input.ownerId, "ownerId");
    assertPositiveInteger(input.generation, "generation");
    assertNonNegativeInteger(input.now, "now");
    assertIdentifier(input.effectIdempotencyKey, "effectIdempotencyKey");
    assertPositiveInteger(input.number, "release pull request number");
    assertIdentifier(input.environmentId, "navigator release environment identity");
  }

  private startRelease(
    current: Job,
    input: NavigatorReleaseEffectSettlementInput,
    url: string,
  ): void {
    const event = navigatorReleaseStartedEvent(input, url);
    const transitioned = transition(current, event, input.now);
    persistJobTransition(this.db, current.id, current.version, transitioned.job);
    persistPendingEffects(this.db, transitioned.effects, input.now);
    this.recordReleaseTransition({
      previous: current,
      next: transitioned.job,
      event,
      now: input.now,
      reviewAttemptIds: [],
    });
    this.enqueueFinishNote(current, transitioned.job, input.now);
    this.markAdmissionDraining(transitioned.job, input.now);
  }

  private recordReceipt(
    receipt: NavigatorReleaseReceipt,
    jobId: string,
    input: NavigatorReleaseEffectSettlementInput,
  ): void {
    const receiptJson = JSON.stringify(receipt);
    this.db.prepare(
      `INSERT INTO navigator_effect_receipts (
         effect_idempotency_key, job_id, kind, receipt_json, receipt_digest,
         owner_id, generation, recorded_at
       ) VALUES (?, ?, 'run_navigator_release', ?, ?, ?, ?, ?)`,
    ).run(...this.receiptValues(receipt, jobId, input, receiptJson));
  }

  private receiptValues(
    receipt: NavigatorReleaseReceipt,
    jobId: string,
    input: NavigatorReleaseEffectSettlementInput,
    receiptJson: string,
  ): readonly unknown[] {
    return [
      receipt.effectIdempotencyKey,
      jobId,
      receiptJson,
      createHash("sha256").update(receiptJson, "utf8").digest("hex"),
      input.ownerId,
      input.generation,
      input.now,
    ];
  }

  private navigatorReleaseEffectIsCurrent(
    effect: EffectRow,
    input: NavigatorReleaseEffectSettlementInput,
  ): boolean {
    if (effect.kind !== "run_navigator_release" || !this.effectLeaseCurrent(effect, input)) return false;
    return (["commit", "push", "pull_request"] as const).every((authorityEffect) =>
      this.taskAuthorities.effectAdmissionIsCurrent(
        effect.job_id,
        input.effectIdempotencyKey,
        authorityEffect,
      ));
  }

  private releaseReceiptMatches(
    receipt: NavigatorReleaseReceipt,
    effectRow: EffectRow,
    input: NavigatorReleaseEffectSettlementInput,
    url: string,
  ): boolean {
    const effect = parseStoredEffect(effectRow);
    const attemptId = typeof effect.payload.attemptId === "string" ? effect.payload.attemptId : null;
    return receipt.effectIdempotencyKey === input.effectIdempotencyKey && receipt.attemptId === attemptId &&
      receipt.number === input.number && receipt.url === url && receipt.environmentId === input.environmentId &&
      receipt.resource.id === input.environmentId;
  }

  private completeEffect(effect: EffectRow, input: NavigatorReleaseEffectSettlementInput): boolean {
    return this.db.prepare(
      `UPDATE effects SET status = 'done', lease_owner = NULL, lease_generation = NULL,
          lease_expires_at = NULL, last_error = NULL, updated_at = ?
        WHERE idempotency_key = ? AND status = 'leased' AND lease_owner = ?
          AND lease_generation = ? AND lease_expires_at > ?
          AND EXISTS (SELECT 1 FROM executor_lease WHERE singleton = 1 AND owner_id = ?
            AND generation = ? AND lease_expires_at > ?)`,
    ).run(
      input.now,
      effect.idempotency_key,
      input.ownerId,
      input.generation,
      input.now,
      input.ownerId,
      input.generation,
      input.now,
    ).changes === 1;
  }

  private recordReviewFindings(
    job: Job,
    event: JobEvent,
    reviewAttemptIds: readonly string[],
    now: number,
  ): void {
    if (!this.shouldRecordReviewFindings(job, event)) return;
    this.assertReviewEvidence(job, reviewAttemptIds);
    const observed = this.normalizedReviewFindings(job, reviewAttemptIds);
    this.assertReviewFindings(event, observed);
    const currentRows = this.currentReviewFindingRows(job.id);
    const current = new Map(currentRows.map((row) => [row.fingerprint, row]));
    const blockingBurden = [...observed.values()].filter((finding) => finding.disposition === "must_fix").length;
    this.recordObservedReviewFindings({ job, current, observed, blockingBurden, now });
    this.resolveClosedReviewFindings({
      job,
      currentRows,
      observed,
      sourceAttemptId: reviewAttemptIds[0]!,
      blockingBurden,
      now,
    });
  }

  private shouldRecordReviewFindings(job: Job, event: JobEvent): boolean {
    return job.state === "final_reviewing" &&
      (event.type === "REVIEW_CHANGES_REQUESTED" || event.type === "REVIEW_PASSED");
  }

  private assertReviewEvidence(job: Job, reviewAttemptIds: readonly string[]): void {
    if (!job.prHeadSha || reviewAttemptIds.length === 0) {
      throw new Error("final review convergence evidence is unavailable");
    }
  }

  private assertReviewFindings(event: JobEvent, observed: ReadonlyMap<string, NavigatorReleaseReviewFinding>): void {
    if (event.type === "REVIEW_CHANGES_REQUESTED" && observed.size === 0) {
      throw new Error("final review requested changes without normalized findings");
    }
  }

  private recordObservedReviewFindings(context: ReviewFindingRecordingContext): void {
    for (const finding of context.observed.values()) {
      this.recordObservedReviewFinding({ ...context, finding });
    }
  }

  private recordObservedReviewFinding(input: Readonly<{
    job: Job;
    current: ReadonlyMap<string, NavigatorReleaseReviewFindingRow>;
    finding: NavigatorReleaseReviewFinding;
    blockingBurden: number;
    now: number;
  }>): void {
    const prior = input.current.get(input.finding.fingerprint);
    this.appendReviewFindingEvent(this.observedFindingEvent(input, prior));
  }

  private observedFindingEvent(
    input: Readonly<{
      job: Job;
      finding: NavigatorReleaseReviewFinding;
      blockingBurden: number;
      now: number;
    }>,
    prior: NavigatorReleaseReviewFindingRow | undefined,
  ): ReviewFindingEventInput {
    return {
      job: input.job,
      sourceAttemptId: input.finding.sourceAttemptId,
      fingerprint: input.finding.fingerprint,
      capabilityId: input.finding.capabilityId,
      ruleId: input.finding.ruleId,
      disposition: input.finding.disposition,
      event: prior?.event === "opened" || prior?.event === "reobserved" ? "reobserved" : "opened",
      findingJson: input.finding.findingJson,
      occurrence: Math.min(3, (prior?.occurrence ?? 0) + 1),
      blockingBurden: input.blockingBurden,
      now: input.now,
    };
  }

  private normalizedReviewFindings(
    job: Job,
    reviewAttemptIds: readonly string[],
  ): Map<string, NavigatorReleaseReviewFinding> {
    const observed = new Map<string, NavigatorReleaseReviewFinding>();
    for (const attemptId of reviewAttemptIds) {
      for (const finding of this.normalizedFindingsFromAttempt(job, attemptId)) {
        if (observed.has(finding.fingerprint)) continue;
        observed.set(finding.fingerprint, finding);
      }
    }
    return observed;
  }

  private normalizedFindingsFromAttempt(
    job: Job,
    attemptId: string,
  ): readonly NavigatorReleaseReviewFinding[] {
    const attempt = this.reviewAttemptById(attemptId);
    if (!attempt || attempt.jobId !== job.id || attempt.reviewStage !== "final_review" ||
      attempt.headSha !== job.prHeadSha || attempt.resultJson === null) {
      throw new Error("final review convergence attempt is invalid");
    }
    const assessment = this.reviewGuardAssessment(attempt.resultJson);
    if (assessment === null) return [];
    return assessment.findings.map((finding) => ({
      sourceAttemptId: attempt.id,
      fingerprint: finding.fingerprint,
      capabilityId: finding.capabilityId,
      ruleId: finding.ruleId,
      disposition: finding.disposition,
      findingJson: JSON.stringify(finding),
    }));
  }

  private reviewGuardAssessment(resultJson: string): GuardEnvelopeAssessment | null {
    const parsedPayload: unknown = JSON.parse(resultJson);
    if (parsedPayload === null || typeof parsedPayload !== "object" || Array.isArray(parsedPayload)) return null;
    const reviewPayload = parsedPayload as Record<string, unknown>;
    const envelope = guardResultEnvelopeSchema.safeParse(reviewPayload.guardEnvelope);
    const policy = guardAssessmentPolicySchema.safeParse(reviewPayload.guardPolicy);
    if (!envelope.success || !policy.success) return null;
    const assessment = assessGuardEnvelope(envelope.data, policy.data);
    if (assessment.outcome === "blocked") throw new Error("final review guard assessment is blocked");
    return assessment;
  }

  private currentReviewFindingRows(jobId: string): NavigatorReleaseReviewFindingRow[] {
    return this.db.prepare(
      `SELECT finding.* FROM navigator_release_review_finding_events AS finding
        WHERE finding.job_id = ? AND finding.sequence = (
          SELECT MAX(latest.sequence) FROM navigator_release_review_finding_events AS latest
           WHERE latest.job_id = finding.job_id AND latest.fingerprint = finding.fingerprint
        )`,
    ).all(jobId) as NavigatorReleaseReviewFindingRow[];
  }

  private appendReviewFindingEvent(input: ReviewFindingEventInput): void {
    const eventValues = this.reviewFindingEventValues(input);
    this.db.prepare(
      `INSERT INTO navigator_release_review_finding_events (
         job_id, workflow_step_id, source_review_attempt_id, fingerprint,
         capability_id, rule_id, disposition, event, head_sha, finding_json,
         evidence_refs_json, occurrence, blocking_burden, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(...eventValues);
  }

  private reviewFindingEventValues(input: ReviewFindingEventInput): readonly unknown[] {
    return [
      input.job.id,
      input.job.currentWorkflowStepId,
      input.sourceAttemptId,
      input.fingerprint,
      input.capabilityId,
      input.ruleId,
      input.disposition,
      input.event,
      input.job.prHeadSha,
      input.findingJson,
      JSON.stringify([`review-attempt:${input.sourceAttemptId}`, `guard-finding:${input.fingerprint}`]),
      input.occurrence,
      input.blockingBurden,
      input.now,
    ];
  }

  private resolveClosedReviewFindings(input: Readonly<{
    job: Job;
    currentRows: readonly NavigatorReleaseReviewFindingRow[];
    observed: ReadonlyMap<string, NavigatorReleaseReviewFinding>;
    sourceAttemptId: string;
    blockingBurden: number;
    now: number;
  }>): void {
    for (const prior of input.currentRows) {
      if (!this.shouldResolveClosedFinding(input, prior)) continue;
      this.appendReviewFindingEvent(this.closedFindingEvent(input, prior));
    }
  }

  private shouldResolveClosedFinding(
    input: Readonly<{ observed: ReadonlyMap<string, NavigatorReleaseReviewFinding> }>,
    prior: NavigatorReleaseReviewFindingRow,
  ): boolean {
    return (prior.event === "opened" || prior.event === "reobserved") &&
      !input.observed.has(prior.fingerprint);
  }

  private closedFindingEvent(
    input: Readonly<{
      job: Job;
      sourceAttemptId: string;
      blockingBurden: number;
      now: number;
    }>,
    prior: NavigatorReleaseReviewFindingRow,
  ): ReviewFindingEventInput {
    return {
      job: input.job,
      sourceAttemptId: input.sourceAttemptId,
      fingerprint: prior.fingerprint,
      capabilityId: prior.capability_id,
      ruleId: prior.rule_id,
      disposition: prior.disposition,
      event: "resolved",
      findingJson: prior.finding_json,
      occurrence: prior.occurrence,
      blockingBurden: input.blockingBurden,
      now: input.now,
    };
  }

  private recordProductionIncidentNotice(
    jobId: string,
    phase: "deploy" | "canary",
    now: number,
  ): void {
    const owner = this.db.prepare(
      "SELECT telegram_chat_id FROM owners WHERE singleton = 1 AND revoked_at IS NULL",
    ).get() as { telegram_chat_id: string } | undefined;
    if (!owner) return;
    const text = phase === "canary"
      ? "Production canary failed. The configured rollback restored the previous release. No action is required."
      : "Production deploy failed. The configured rollback restored the previous release. No action is required.";
    this.insertOutboxNotice(
      `job:${jobId}:production-incident:${phase}`,
      owner.telegram_chat_id,
      text,
      now,
    );
  }

  private enqueueFinishNote(previous: Job, completed: Job, now: number): void {
    const delivered = completed.state === "complete" || completed.state === "merged";
    if (!delivered || previous.state === completed.state || completed.prUrl === null) return;
    const text = renderJobFinishNote(completed);
    const owner = this.db.prepare(
      "SELECT telegram_chat_id FROM owners WHERE singleton = 1 AND revoked_at IS NULL",
    ).get() as { telegram_chat_id: string } | undefined;
    if (text === null || !owner) return;
    assertSafeExternalHttpsUrl(completed.prUrl, "completed job PR URL");
    this.insertOutboxNotice(`job:${completed.id}:finish`, owner.telegram_chat_id, text, now);
  }

  private insertOutboxNotice(logicalKey: string, chatId: string, text: string, now: number): void {
    assertNoRawMergeCallback(logicalKey, "outbox logical key");
    assertNoRawMergeCallback(chatId, "outbox chat id");
    const payloadJson = serializeBoundedJson(
      { text, disable_web_page_preview: true },
      "outbox payload",
      MAX_MERGE_RESULT_JSON,
    );
    this.db.prepare(
      `INSERT OR IGNORE INTO outbox (
         logical_key, chat_id, message_id, payload_json, status, attempts,
         next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, NULL, ?, 'pending', 0, ?, ?, ?)`,
    ).run(logicalKey, chatId, payloadJson, now, now, now);
  }

  private markAdmissionDraining(job: Job, now: number): void {
    if (isReleaseCandidate(job.state)) this.autonomy.markDrainingInTransaction(job.id, now);
  }

  private reviewAttemptById(id: string): ReleaseReviewAttempt | null {
    const row = this.db.prepare(
      `SELECT id, job_id, review_stage, head_sha, result_json
         FROM attempts WHERE id = ?`,
    ).get(id) as {
      id: string;
      job_id: string;
      review_stage: string | null;
      head_sha: string | null;
      result_json: string | null;
    } | undefined;
    return row ? {
      id: row.id,
      jobId: row.job_id,
      reviewStage: row.review_stage,
      headSha: row.head_sha,
      resultJson: row.result_json,
    } : null;
  }

  private effectByKey(key: string): EffectRow | undefined {
    return this.db.prepare("SELECT * FROM effects WHERE idempotency_key = ?").get(key) as EffectRow | undefined;
  }

  private executorLeaseCurrent(ownerId: string, generation: number, now: number): boolean {
    return this.db.prepare(
      `SELECT 1 FROM executor_lease
        WHERE singleton = 1 AND owner_id = ? AND generation = ? AND lease_expires_at > ?`,
    ).get(ownerId, generation, now) !== undefined;
  }

  private effectLeaseCurrent(
    effect: EffectRow,
    input: NavigatorReleaseEffectSettlementInput,
  ): boolean {
    return effect.status === "leased" && effect.lease_owner === input.ownerId &&
      effect.lease_generation === input.generation && effect.lease_expires_at !== null &&
      effect.lease_expires_at > input.now && this.executorLeaseCurrent(
        input.ownerId,
        input.generation,
        input.now,
      );
  }
}
