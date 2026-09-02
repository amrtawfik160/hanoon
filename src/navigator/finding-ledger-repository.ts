import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  navigatorTicketWorkOrderSchema,
  navigatorReviewFindingSchema,
  type NavigatorReviewFinding,
} from "./implementation-contracts";
import type {
  NavigatorFindingAssessmentFact,
  NavigatorFindingAssessmentFacts,
  NavigatorFindingAssessmentInput,
  NavigatorFindingCurrentDecisionInput,
  NavigatorFindingLedgerDecision,
  NavigatorFindingLedgerEntry,
  NavigatorFindingLedgerState,
  NavigatorFindingPassingReviewInput,
  NavigatorFindingDisposition,
  NavigatorFindingLedgerPersistence,
} from "./finding-ledger";

type SqliteDatabase = Database.Database;
type FindingEvent = "opened" | "reobserved" | "resolved" | "disputed" | "corrected";

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
  disposition: NavigatorFindingDisposition;
  event: FindingEvent;
  head_sha: string;
  finding_json: string;
  evidence_refs_json: string;
  occurrence: number;
  blocking_burden: number;
  created_at: number;
  severity?: NavigatorReviewFinding["severity"];
  requirement_id?: string | null;
  evidence_class?: string;
  normalized_subject?: string;
  fingerprint?: string;
  descriptor_digest?: string;
  descriptor_version?: string;
  policy_revision?: number;
  policy_digest?: string;
  requirement_ids_json?: string;
  artifact_snapshot_id?: string | null;
  artifact_snapshot_digest?: string | null;
  specification_snapshot_id?: string | null;
  specification_snapshot_digest?: string | null;
  source_attempt_digest?: string;
  verification_attempt_digest?: string;
  root_cause_confirmed?: number;
  supersedes_root_cause_id?: string | null;
}>;

type IntegrationHeadRow = Readonly<{ current_head_sha: string }>;
type CurrentEvidenceRow = Readonly<{
  current_head_sha: string;
  ticket_snapshot_id: string;
  ticket_snapshot_digest: string;
  specification_snapshot_id: string;
  specification_snapshot_digest: string;
}>;
type SourceEvidenceRow = Readonly<{
  job_id: string;
  slice_id: string;
  kind: string;
  work_order_json: string;
  outcome: string;
  exact_head_sha: string;
  result_digest: string;
  ticket_artifact_id: string;
  specification_artifact_id: string;
}>;
type ConvergenceRow = Readonly<{
  slice_id: string;
  last_blocking_burden: number;
  plateau_recoveries: number;
  review_cycles: number;
  updated_at: number;
  last_verification_attempt_id: string | null;
}>;

type ConvergenceWrite = Readonly<{
  sliceId: string;
  blockingBurden: number;
  plateauRecoveries: number;
  reviewCycles: number;
  verificationAttemptId: string;
  now: number;
}>;

type FindingEventInput = Readonly<{
  input: NavigatorFindingAssessmentInput | NavigatorFindingPassingReviewInput;
  sourceReviewAttemptId: string;
  verificationAttemptId: string;
  finding: NavigatorReviewFinding;
  fact: NavigatorFindingAssessmentFact;
  event: FindingEvent;
  occurrence: number;
  blockingBurden: number;
  rootCauseConfirmed: boolean;
  supersedesRootCauseId?: string | null;
}>;

const ZERO_DIGEST = "0".repeat(64);
const FINDING_EVENT_INSERT = `INSERT INTO navigator_review_finding_events (
  id, job_id, slice_id, source_review_attempt_id, verification_attempt_id,
  root_cause_id, capability_id, rule_id, disposition, event, head_sha,
  finding_json, evidence_refs_json, occurrence, blocking_burden, created_at,
  severity, requirement_id, evidence_class, normalized_subject, fingerprint,
  descriptor_digest, descriptor_version, policy_revision, policy_digest,
  requirement_ids_json, artifact_snapshot_id, artifact_snapshot_digest,
  specification_snapshot_id, specification_snapshot_digest,
  source_attempt_digest, verification_attempt_digest, root_cause_confirmed,
  supersedes_root_cause_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function findingEventId(...parts: readonly string[]): string {
  return `navfinding_${createHash("sha256").update(parts.join("\0"), "utf8").digest("base64url").slice(0, 24)}`;
}

function stateFor(event: FindingEvent, rootCauseConfirmed = true): NavigatorFindingLedgerState {
  if (event === "opened" || event === "reobserved") return "open";
  if (event === "corrected") return rootCauseConfirmed ? "open" : "disputed";
  return event === "resolved" ? "resolved" : "disputed";
}

function identityFor(row: FindingEventRow): string {
  return row.fingerprint && row.fingerprint.length === 64 ? row.fingerprint : `legacy:${row.root_cause_id}`;
}

function parseFinding(row: FindingEventRow): NavigatorReviewFinding {
  return navigatorReviewFindingSchema.parse(JSON.parse(row.finding_json));
}

function rowIsBlocking(row: NavigatorFindingLedgerEntry): boolean {
  return row.state === "open" && row.disposition === "must_fix";
}

function blockingRootCount(entries: readonly NavigatorFindingLedgerEntry[]): number {
  return new Set(entries.filter(rowIsBlocking).map((entry) => entry.rootCauseId)).size;
}

function artifactSnapshotFields(input: Readonly<{
  artifactSnapshotId: string | null;
  artifactSnapshotDigest: string | null;
  specificationSnapshotId: string | null;
  specificationSnapshotDigest: string | null;
}>): readonly (string | null)[] {
  return [
    input.artifactSnapshotId,
    input.artifactSnapshotDigest,
    input.specificationSnapshotId,
    input.specificationSnapshotDigest,
  ];
}

function findingEventIdentityFields(input: FindingEventInput, eventId: string): readonly unknown[] {
  const { input: assessment, finding, fact } = input;
  return [
    eventId, assessment.jobId, assessment.sliceId, input.sourceReviewAttemptId,
    input.verificationAttemptId, finding.rootCauseId, finding.capabilityId,
    finding.ruleId, fact.disposition, input.event, assessment.exactHeadSha,
    JSON.stringify(finding), JSON.stringify([...new Set(assessment.evidenceRefs)]),
    input.occurrence, input.blockingBurden, assessment.now,
  ];
}

function findingEventPolicyFields(input: FindingEventInput): readonly unknown[] {
  const { input: assessment, finding, fact } = input;
  const sourceAttemptDigest = "sourceAttemptDigest" in assessment
    ? assessment.sourceAttemptDigest
    : ZERO_DIGEST;
  return [
    finding.severity, finding.requirementId, finding.evidenceClass, fact.normalizedSubject,
    fact.fingerprint, fact.policy.descriptorDigest, fact.policy.descriptorVersion,
    fact.policy.policyRevision, fact.policy.policyDigest, JSON.stringify(fact.policy.requirementIds),
    ...artifactSnapshotFields(assessment), sourceAttemptDigest, assessment.verificationAttemptDigest,
    input.rootCauseConfirmed ? 1 : 0,
    input.supersedesRootCauseId ?? null,
  ];
}

function findingEventValues(input: FindingEventInput, eventId: string): readonly unknown[] {
  return [...findingEventIdentityFields(input, eventId), ...findingEventPolicyFields(input)];
}

function entryState(row: FindingEventRow, currentHeadSha: string): Readonly<{
  state: NavigatorFindingLedgerState;
  blockingBurden: number;
}> {
  const state = stateFor(row.event, row.root_cause_confirmed !== 0);
  const stale = currentHeadSha.length === 40 && row.head_sha !== currentHeadSha;
  return { state: stale ? "stale" : state, blockingBurden: stale ? 0 : row.blocking_burden };
}

function staleEvidenceFor(entries: readonly NavigatorFindingLedgerEntry[], currentHeadSha: string): readonly Readonly<{
  fingerprint: string;
  assessedHeadSha: string;
  currentHeadSha: string;
}>[] {
  return entries.filter((entry) => entry.state === "stale").map((entry) => ({
    fingerprint: entry.fingerprint,
    assessedHeadSha: entry.headSha,
    currentHeadSha,
  }));
}

function requirementClassForRow(row: FindingEventRow, finding: NavigatorReviewFinding): string {
  return row.requirement_id === null || row.requirement_id === undefined
    ? `evidence:${row.evidence_class || finding.evidenceClass}`
    : `requirement:${row.requirement_id}`;
}

function legacyPolicy(row: FindingEventRow) {
  return {
    capabilityId: row.capability_id,
    descriptorDigest: row.descriptor_digest || ZERO_DIGEST,
    descriptorVersion: row.descriptor_version || "legacy",
    policyRevision: row.policy_revision ?? 0,
    defaultDisposition: row.disposition,
    mustFixRuleIds: [],
    advisoryRuleIds: [],
    requirementIds: row.requirement_ids_json ? JSON.parse(row.requirement_ids_json) as string[] : [],
    policyDigest: row.policy_digest || ZERO_DIGEST,
  };
}

function entryIdentityFields(
  row: FindingEventRow,
  currentHeadSha: string,
): Pick<NavigatorFindingLedgerEntry, "rootCauseId" | "sliceId" | "sourceReviewAttemptId" | "verificationAttemptId" | "state" | "blockingBurden" | "headSha" | "fingerprint" | "occurrence" | "supersedesRootCauseId"> {
  const status = entryState(row, currentHeadSha);
  return {
    rootCauseId: row.root_cause_id,
    sliceId: row.slice_id,
    sourceReviewAttemptId: row.source_review_attempt_id,
    verificationAttemptId: row.verification_attempt_id,
    state: status.state,
    blockingBurden: status.blockingBurden,
    headSha: row.head_sha,
    fingerprint: identityFor(row),
    occurrence: row.occurrence,
    supersedesRootCauseId: row.supersedes_root_cause_id ?? null,
  };
}

function entryPolicyFields(
  row: FindingEventRow,
  finding: NavigatorReviewFinding,
): Pick<NavigatorFindingLedgerEntry, "disposition" | "normalizedSubject" | "requirementClass" | "descriptorDigest" | "descriptorVersion" | "policyRevision" | "policyDigest" | "artifactSnapshotId" | "artifactSnapshotDigest" | "specificationSnapshotId" | "specificationSnapshotDigest" | "sourceAttemptDigest" | "verificationAttemptDigest"> {
  return {
    disposition: row.disposition,
    normalizedSubject: row.normalized_subject || finding.subject,
    requirementClass: requirementClassForRow(row, finding),
    descriptorDigest: row.descriptor_digest || ZERO_DIGEST,
    descriptorVersion: row.descriptor_version || "legacy",
    policyRevision: row.policy_revision ?? 0,
    policyDigest: row.policy_digest || ZERO_DIGEST,
    artifactSnapshotId: row.artifact_snapshot_id ?? null,
    artifactSnapshotDigest: row.artifact_snapshot_digest ?? null,
    specificationSnapshotId: row.specification_snapshot_id ?? null,
    specificationSnapshotDigest: row.specification_snapshot_digest ?? null,
    sourceAttemptDigest: row.source_attempt_digest || ZERO_DIGEST,
    verificationAttemptDigest: row.verification_attempt_digest || ZERO_DIGEST,
  };
}

export class NavigatorFindingLedgerRepository implements NavigatorFindingLedgerPersistence {
  public constructor(private readonly db: SqliteDatabase) {}

  public assess(input: NavigatorFindingAssessmentFacts): NavigatorFindingLedgerDecision {
    return this.atomic(() => this.assessInTransaction(input));
  }

  public resolvePassingReview(input: NavigatorFindingPassingReviewInput): NavigatorFindingLedgerDecision {
    return this.atomic(() => this.resolvePassingReviewInTransaction(input));
  }

  public currentDecision(input: NavigatorFindingCurrentDecisionInput): NavigatorFindingLedgerDecision {
    const currentHeadSha = this.integrationHead(input.jobId);
    const rows = this.currentRows(input.jobId, input.sliceId);
    return this.decisionFromRows(rows, currentHeadSha ?? input.expectedHeadSha ?? "");
  }

  private atomic<T>(operation: () => T): T {
    return this.db.inTransaction ? operation() : this.db.transaction(operation).immediate();
  }

  private assessInTransaction(input: NavigatorFindingAssessmentFacts): NavigatorFindingLedgerDecision {
    const priorRows = this.currentRows(input.input.jobId, input.input.sliceId);
    const priorDecision = this.decisionFromRows(priorRows, input.input.exactHeadSha);
    const convergence = this.convergence(input.input.sliceId);
    const priorBurden = convergence?.last_blocking_burden ?? priorDecision.blockingBurden;
    const currentHeadSha = this.integrationHead(input.input.jobId);
    if (currentHeadSha !== null && currentHeadSha !== input.input.exactHeadSha) {
      return this.blockedDecision("stale_evidence", priorRows, currentHeadSha);
    }
    if (!this.snapshotsAreCurrent(input.input)) {
      return this.blockedDecision("stale_evidence", priorRows, currentHeadSha ?? input.input.exactHeadSha);
    }
    if (this.attemptAlreadyRecorded(input.input.verificationAttemptId)) return this.withDelta(priorDecision, 0);
    if (!this.sourceEvidenceIsCurrent(input.input)) {
      return this.blockedDecision("finding_verification_source_mismatch", priorRows, currentHeadSha ?? input.input.exactHeadSha);
    }
    const sourceKeys = new Set(input.findings.map(({ fingerprint }) => fingerprint));
    const priorByKey = new Map(priorRows.map((row) => [identityFor(row), row]));
    const burden = new Set(input.findings
      .filter(({ confirmed, disposition }) => confirmed && disposition === "must_fix")
      .map(({ proposed }) => proposed.rootCauseId)).size;
    this.writeAssessmentEvents(input, priorByKey, burden);
    this.resolveMissingRoots(input, priorRows, sourceKeys, burden);
    const reasonCode = this.updateConvergence(input.input, burden, convergence);
    return this.assessmentDecision(input, burden, reasonCode, burden - priorBurden);
  }

  private assessmentDecision(
    input: NavigatorFindingAssessmentFacts,
    burden: number,
    reasonCode: string | null,
    burdenDelta: number,
  ): NavigatorFindingLedgerDecision {
    const decision = this.decisionFromRows(this.currentRows(input.input.jobId, input.input.sliceId), input.input.exactHeadSha);
    const constrained = reasonCode === null ? decision : {
      ...decision,
      outcome: "blocked" as const,
      allowedNextAction: "stop" as const,
      reasonCode,
      reasons: [reasonCode],
    };
    return this.withDelta(constrained, burdenDelta);
  }

  private resolvePassingReviewInTransaction(input: NavigatorFindingPassingReviewInput): NavigatorFindingLedgerDecision {
    const current = this.currentRows(input.jobId, input.sliceId);
    const currentHeadSha = this.integrationHead(input.jobId);
    if (currentHeadSha !== null && currentHeadSha !== input.exactHeadSha) {
      return this.blockedDecision("stale_evidence", current, currentHeadSha);
    }
    if (!this.snapshotsAreCurrent(input)) {
      return this.blockedDecision("stale_evidence", current, currentHeadSha ?? input.exactHeadSha);
    }
    if (this.attemptAlreadyRecorded(input.verificationAttemptId)) {
      return this.decisionFromRows(current, input.exactHeadSha);
    }
    const convergence = this.convergence(input.sliceId);
    const priorDecision = this.decisionFromRows(current, input.exactHeadSha);
    const priorBurden = convergence?.last_blocking_burden ?? priorDecision.blockingBurden;
    const reviewCycles = (convergence?.review_cycles ?? 0) + 1;
    if (reviewCycles > input.maxReviewCycles) return this.blockedDecision("review_cycle_limit", current, input.exactHeadSha);
    this.resolveOpenRows(input, current);
    this.saveConvergence({
      sliceId: input.sliceId,
      blockingBurden: 0,
      plateauRecoveries: convergence?.plateau_recoveries ?? 0,
      reviewCycles,
      verificationAttemptId: input.verificationAttemptId,
      now: input.now,
    });
    return this.withDelta(
      this.decisionFromRows(this.currentRows(input.jobId, input.sliceId), input.exactHeadSha),
      -priorBurden,
    );
  }

  private resolveOpenRows(input: NavigatorFindingPassingReviewInput, rows: readonly FindingEventRow[]): void {
    for (const row of rows) {
      if (stateFor(row.event, row.root_cause_confirmed !== 0) !== "open") continue;
      this.insertEvent({
        input,
        sourceReviewAttemptId: input.verificationAttemptId,
        verificationAttemptId: input.verificationAttemptId,
        finding: parseFinding(row),
        fact: this.legacyFact(row),
        event: "resolved",
        occurrence: row.occurrence,
        blockingBurden: 0,
        rootCauseConfirmed: true,
      });
    }
  }

  private attemptAlreadyRecorded(verificationAttemptId: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 AS present FROM navigator_review_finding_events WHERE verification_attempt_id = ?
       UNION ALL
       SELECT 1 AS present FROM navigator_review_convergence WHERE last_verification_attempt_id = ?
       LIMIT 1`,
    ).get(verificationAttemptId, verificationAttemptId) as { present: number } | undefined;
    return row !== undefined;
  }

  private writeAssessmentEvents(
    facts: NavigatorFindingAssessmentFacts,
    priorByKey: ReadonlyMap<string, FindingEventRow>,
    blockingBurden: number,
  ): void {
    for (const fact of facts.findings) {
      const prior = priorByKey.get(fact.fingerprint);
      const occurrence = fact.confirmed ? Math.min(3, (prior?.occurrence ?? 0) + 1) : (prior?.occurrence ?? 0);
      const corrected = prior !== undefined && prior.root_cause_id !== fact.proposed.rootCauseId;
      const priorState = prior === undefined ? null : stateFor(prior.event, prior.root_cause_confirmed !== 0);
      const event: FindingEvent = corrected
        ? "corrected"
        : fact.confirmed && priorState === "open" ? "reobserved"
        : fact.confirmed ? "opened" : "disputed";
      this.insertEvent({
        input: facts.input,
        sourceReviewAttemptId: facts.input.sourceReviewAttemptId,
        verificationAttemptId: facts.input.verificationAttemptId,
        finding: fact.confirmed ? fact.observed : fact.proposed,
        fact,
        event,
        occurrence,
        blockingBurden,
        rootCauseConfirmed: fact.confirmed,
        supersedesRootCauseId: corrected ? prior.root_cause_id : null,
      });
    }
  }

  private resolveMissingRoots(
    facts: NavigatorFindingAssessmentFacts,
    priorRows: readonly FindingEventRow[],
    sourceKeys: ReadonlySet<string>,
    blockingBurden: number,
  ): void {
    for (const row of priorRows) {
      if (stateFor(row.event, row.root_cause_confirmed !== 0) !== "open" || sourceKeys.has(identityFor(row))) continue;
      this.insertEvent({
        input: facts.input,
        sourceReviewAttemptId: facts.input.sourceReviewAttemptId,
        verificationAttemptId: facts.input.verificationAttemptId,
        finding: parseFinding(row),
        fact: this.legacyFact(row),
        event: "resolved",
        occurrence: row.occurrence,
        blockingBurden,
        rootCauseConfirmed: true,
      });
    }
  }

  private insertEvent(input: FindingEventInput): FindingEventRow {
    const eventId = findingEventId(input.verificationAttemptId, input.fact.fingerprint, input.event);
    this.db.prepare(FINDING_EVENT_INSERT).run(...findingEventValues(input, eventId));
    return this.db.prepare("SELECT * FROM navigator_review_finding_events WHERE id = ?").get(eventId) as FindingEventRow;
  }

  private legacyFact(row: FindingEventRow): NavigatorFindingAssessmentFact {
    const finding = parseFinding(row);
    return {
      proposed: finding,
      observed: finding,
      confirmed: row.root_cause_confirmed !== 0 || stateFor(row.event, row.root_cause_confirmed !== 0) === "open",
      fingerprint: identityFor(row),
      normalizedSubject: row.normalized_subject || finding.subject,
      requirementClass: requirementClassForRow(row, finding),
      disposition: row.disposition,
      policy: legacyPolicy(row),
    };
  }

  private updateConvergence(
    input: NavigatorFindingAssessmentInput,
    burden: number,
    previous: ConvergenceRow | undefined,
  ): string | null {
    const reviewCycles = (previous?.review_cycles ?? 0) + 1;
    let plateauRecoveries = previous?.plateau_recoveries ?? 0;
    let reasonCode: string | null = null;
    if (burden > 0 && previous?.last_blocking_burden !== undefined && burden >= previous.last_blocking_burden) {
      if (plateauRecoveries === 0) plateauRecoveries = 1;
      else reasonCode = "review_burden_plateau";
    }
    if (burden > 0 && this.hasRecurrence(input.sliceId)) reasonCode = "finding_recurrence_limit";
    else if (reviewCycles > input.maxReviewCycles) reasonCode = "review_cycle_limit";
    this.saveConvergence({
      sliceId: input.sliceId,
      blockingBurden: burden,
      plateauRecoveries,
      reviewCycles,
      verificationAttemptId: input.verificationAttemptId,
      now: input.now,
    });
    return reasonCode;
  }

  private hasRecurrence(sliceId: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 AS present FROM navigator_review_finding_events
        WHERE slice_id = ? AND event IN ('opened', 'reobserved', 'corrected') AND occurrence >= 3 LIMIT 1`,
    ).get(sliceId) as { present: number } | undefined;
    return row !== undefined;
  }

  private saveConvergence(input: ConvergenceWrite): void {
    this.db.prepare(
      `INSERT INTO navigator_review_convergence (
         slice_id, last_blocking_burden, plateau_recoveries, review_cycles, updated_at,
         last_verification_attempt_id
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(slice_id) DO UPDATE SET last_blocking_burden = excluded.last_blocking_burden,
         plateau_recoveries = excluded.plateau_recoveries, review_cycles = excluded.review_cycles,
         updated_at = excluded.updated_at, last_verification_attempt_id = excluded.last_verification_attempt_id`,
    ).run(
      input.sliceId,
      input.blockingBurden,
      input.plateauRecoveries,
      input.reviewCycles,
      input.now,
      input.verificationAttemptId,
    );
  }

  private convergence(sliceId: string): ConvergenceRow | undefined {
    return this.db.prepare("SELECT * FROM navigator_review_convergence WHERE slice_id = ?")
      .get(sliceId) as ConvergenceRow | undefined;
  }

  private currentRows(jobId: string, sliceId?: string): FindingEventRow[] {
    return this.db.prepare(
      `SELECT event.*
         FROM navigator_review_finding_events AS event
        WHERE event.job_id = ? AND (? IS NULL OR event.slice_id = ?)
          AND event.sequence = (
            SELECT MAX(newest.sequence) FROM navigator_review_finding_events AS newest
             WHERE newest.slice_id = event.slice_id
               AND COALESCE(NULLIF(newest.fingerprint, ''), 'legacy:' || newest.root_cause_id) =
                   COALESCE(NULLIF(event.fingerprint, ''), 'legacy:' || event.root_cause_id)
          )
        ORDER BY event.slice_id, COALESCE(NULLIF(event.fingerprint, ''), 'legacy:' || event.root_cause_id)`,
    ).all(jobId, sliceId ?? null, sliceId ?? null) as FindingEventRow[];
  }

  private integrationHead(jobId: string): string | null {
    const row = this.db.prepare("SELECT current_head_sha FROM navigator_integrations WHERE job_id = ?")
      .get(jobId) as IntegrationHeadRow | undefined;
    return row?.current_head_sha ?? null;
  }

  private snapshotsAreCurrent(
    input: NavigatorFindingAssessmentInput | NavigatorFindingPassingReviewInput,
  ): boolean {
    const row = this.db.prepare(
      `SELECT integration.current_head_sha, slice.ticket_snapshot_id, slice.ticket_snapshot_digest,
              integration.specification_snapshot_id, integration.specification_snapshot_digest
         FROM navigator_integrations AS integration
         JOIN navigator_ticket_slices AS slice ON slice.id = ? AND slice.job_id = integration.job_id
        WHERE integration.job_id = ?`,
    ).get(input.sliceId, input.jobId) as CurrentEvidenceRow | undefined;
    if (!row) return false;
    return this.snapshotMatches(input.artifactSnapshotId, input.artifactSnapshotDigest, row.ticket_snapshot_id, row.ticket_snapshot_digest) &&
      this.snapshotMatches(input.specificationSnapshotId, input.specificationSnapshotDigest, row.specification_snapshot_id, row.specification_snapshot_digest);
  }

  private snapshotMatches(
    suppliedId: string | null,
    suppliedDigest: string | null,
    currentId: string,
    currentDigest: string,
  ): boolean {
    return suppliedId === null && suppliedDigest === null ||
      (suppliedId === currentId && suppliedDigest === currentDigest);
  }

  private sourceEvidenceIsCurrent(input: NavigatorFindingAssessmentInput): boolean {
    const row = this.db.prepare(
      `SELECT attempt.job_id, attempt.slice_id, attempt.kind, attempt.work_order_json,
              outcome.outcome, outcome.exact_head_sha, outcome.result_digest,
              slice.ticket_artifact_id, integration.specification_artifact_id
         FROM navigator_ticket_worker_attempts AS attempt
         JOIN navigator_ticket_worker_outcomes AS outcome ON outcome.attempt_id = attempt.id
         JOIN navigator_ticket_slices AS slice ON slice.id = attempt.slice_id
         JOIN navigator_integrations AS integration ON integration.job_id = attempt.job_id
        WHERE attempt.id = ?`,
    ).get(input.sourceReviewAttemptId) as SourceEvidenceRow | undefined;
    if (!row || row.job_id !== input.jobId || row.slice_id !== input.sliceId || row.kind !== "review" ||
      row.outcome !== "findings" || row.result_digest !== input.sourceAttemptDigest ||
      row.exact_head_sha !== input.exactHeadSha) return false;
    let rawWorkOrder: unknown;
    try {
      rawWorkOrder = JSON.parse(row.work_order_json) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) return false;
      throw error;
    }
    const parsed = navigatorTicketWorkOrderSchema.safeParse(rawWorkOrder);
    if (!parsed.success || parsed.data.verificationOf !== undefined || parsed.data.jobId !== input.jobId ||
      parsed.data.baseHeadSha !== input.exactHeadSha || parsed.data.ticket.artifactId !== row.ticket_artifact_id ||
      parsed.data.specification.artifactId !== row.specification_artifact_id) return false;
    return this.exactSnapshotMatches(parsed.data.ticket.snapshotId, parsed.data.ticket.snapshotDigest,
      input.artifactSnapshotId, input.artifactSnapshotDigest) &&
      this.exactSnapshotMatches(parsed.data.specification.snapshotId, parsed.data.specification.snapshotDigest,
        input.specificationSnapshotId, input.specificationSnapshotDigest);
  }

  private exactSnapshotMatches(
    sourceId: string,
    sourceDigest: string,
    suppliedId: string | null,
    suppliedDigest: string | null,
  ): boolean {
    return suppliedId !== null && suppliedDigest !== null && sourceId === suppliedId && sourceDigest === suppliedDigest;
  }

  private decisionFromRows(rows: readonly FindingEventRow[], currentHeadSha: string): NavigatorFindingLedgerDecision {
    const entries = rows.map((row) => this.entryFromRow(row, currentHeadSha));
    const staleEvidence = staleEvidenceFor(entries, currentHeadSha);
    const blockingBurden = blockingRootCount(entries);
    const allowedNextAction = staleEvidence.length > 0 ? "recheck" : blockingBurden > 0 ? "repair" : "accept";
    return {
      outcome: "accepted",
      allowedNextAction,
      reasonCode: staleEvidence.length > 0 ? "stale_evidence" : blockingBurden > 0 ? "blocking_findings" : null,
      entries,
      currentRoots: entries.filter((entry) => entry.state !== "resolved"),
      blockingBurden,
      burdenDelta: 0,
      staleEvidence,
      reasons: [
        ...(blockingBurden > 0 ? ["blocking_findings"] : []),
        ...(staleEvidence.length > 0 ? ["stale_evidence"] : []),
      ],
    };
  }

  private entryFromRow(row: FindingEventRow, currentHeadSha: string): NavigatorFindingLedgerEntry {
    const finding = parseFinding(row);
    return {
      ...entryIdentityFields(row, currentHeadSha),
      ...entryPolicyFields(row, finding),
      finding,
    };
  }

  private blockedDecision(
    reasonCode: string,
    rows: readonly FindingEventRow[],
    currentHeadSha: string,
  ): NavigatorFindingLedgerDecision {
    return {
      ...this.decisionFromRows(rows, currentHeadSha),
      outcome: "blocked",
      allowedNextAction: "stop",
      reasonCode,
      reasons: [reasonCode],
    };
  }

  private withDelta(decision: NavigatorFindingLedgerDecision, burdenDelta: number): NavigatorFindingLedgerDecision {
    return { ...decision, burdenDelta };
  }
}
