import type Database from "better-sqlite3";
import {
  CONTROLLER_PROOF_KINDS,
  type ControllerLeaseFence,
  type ControllerProofKind,
} from "../controller/models";
import {
  controllerFinalizationCorrection,
  controllerFinalizationSchema,
  renderControllerFinalization,
  validateControllerFinalization,
  type ControllerFinalization,
  type ControllerFinalizationValidationContext,
  type PersistedFinalizationRejectionCode,
} from "../controller/finalization-contract";

type SqliteDatabase = Database.Database;

export type ControllerEvidenceOutcome =
  | "observed"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "denied";

export type ControllerEvidenceRecord = Readonly<{
  id: number;
  ref: `evidence:${number}`;
  turnId: string;
  controllerKey: string;
  sourceKind: "hanoon_tool" | "bb_item";
  sourceName: string;
  sourceItemId: string | null;
  outcome: ControllerEvidenceOutcome;
  argsSha256: string;
  resultSha256: string;
  proofKinds: readonly ControllerProofKind[];
  subjectRefs: readonly string[];
  observedAt: number;
}>;

export type ControllerEvidenceWrite =
  | { outcome: "recorded"; evidence: ControllerEvidenceRecord }
  | { outcome: "duplicate"; evidence: ControllerEvidenceRecord }
  | { outcome: "limit_exceeded" }
  | { outcome: "stale" };

export type AcceptedControllerFinalization = Readonly<{
  id: number;
  ref: `finalization:${number}`;
  turnId: string;
  revision: number;
  candidate: ControllerFinalization;
  renderedMessage: string;
  evidenceHighWaterId: number;
  /** The immutable BB-native event high-water captured for this acceptance. */
  bbEventHighWaterSeq: number | null;
  createdAt: number;
  validatedAt: number;
  consumedAt: number | null;
}>;

export type ControllerFinalizationProposalResult =
  | { outcome: "accepted"; finalization: AcceptedControllerFinalization }
  | {
      outcome: "rejected";
      revision: number;
      code: PersistedFinalizationRejectionCode;
      correction: string;
    }
  | {
      outcome: "rejected";
      code: "accepted_already" | "revision_limit";
      correction: string;
    }
  | { outcome: "stale" };

export type ControllerFinalizationProposalInput = ControllerLeaseFence & Readonly<{
  turnId: string;
  controllerKey: string;
  candidate: unknown;
  /** Optional only for pre-Task-9 direct callers; production acceptance supplies it. */
  bbEventHighWaterSeq?: number;
}>;

export type ControllerCompletionContinuationInput = ControllerLeaseFence & Readonly<{
  turnId: string;
  controllerKey: string;
  bbHighWaterSeq: number;
}>;

export type ControllerEvidenceInput = ControllerLeaseFence & Readonly<{
  turnId: string;
  controllerKey: string;
  sourceKind: "hanoon_tool";
  sourceName: string;
  sourceItemId: null;
  outcome: ControllerEvidenceOutcome;
  argsSha256: string;
  resultSha256: string;
  proofKinds: readonly ControllerProofKind[];
  subjectRefs: readonly string[];
}>;

export type ControllerNativeEvidenceCandidate = Readonly<{
  sourceName: string;
  sourceItemId: string;
  outcome: ControllerEvidenceOutcome;
  argsSha256: string;
  resultSha256: string;
  proofKinds: readonly ControllerProofKind[];
  subjectRefs: readonly string[];
}>;

export type ControllerNativeEvidenceInput = ControllerLeaseFence & Readonly<{
  turnId: string;
  controllerKey: string;
  fromSeq: number;
  throughSeq: number;
  items: readonly ControllerNativeEvidenceCandidate[];
}>;

export type ControllerNativeEvidenceWrite =
  | "recorded"
  | "stale"
  | "cursor_changed"
  | "limit_exceeded"
  | "native_identity_conflict";

export interface ControllerNativeEvidenceWriter {
  recordNativeBatch(input: ControllerNativeEvidenceInput): ControllerNativeEvidenceWrite;
}

type ControllerEvidenceRow = {
  id: number;
  turn_id: string;
  controller_key: string;
  source_kind: string;
  source_name: string;
  source_item_id: string | null;
  outcome: string;
  args_sha256: string;
  result_sha256: string;
  proof_kinds_json: string;
  subject_refs_json: string;
  observed_at: number;
};

type ControllerFinalizationRow = {
  id: number;
  turn_id: string;
  revision: number;
  payload_json: string;
  rendered_message: string;
  evidence_high_water_id: number;
  state: string;
  rejection_code: string | null;
  created_at: number;
  validated_at: number;
  consumed_at: number | null;
};

type FinalizationTurnRow = FencedTurnRow & {
  accepted_finalization_id: number | null;
  evidence_limit_exceeded_at: number | null;
  telegram_user_id: string;
  telegram_chat_id: string;
};

type FencedTurnRow = {
  evidence_event_seq: number;
};

type EvidenceInsertFields = Readonly<{
  turnId: string;
  controllerKey: string;
  sourceKind: "hanoon_tool" | "bb_item";
  sourceName: string;
  sourceItemId: string | null;
  outcome: ControllerEvidenceOutcome;
  argsSha256: string;
  resultSha256: string;
  proofKinds: readonly ControllerProofKind[];
  subjectRefs: readonly string[];
  observedAt: number;
}>;

const MAX_EVIDENCE_ROWS = 128;
const MAX_PROOF_KINDS = 8;
const MAX_SUBJECT_REFS = 16;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const PROOF_KINDS: ReadonlySet<string> = new Set(CONTROLLER_PROOF_KINDS);
const EVIDENCE_OUTCOMES: ReadonlySet<string> = new Set([
  "observed",
  "succeeded",
  "failed",
  "interrupted",
  "denied",
]);

export class ControllerEvidenceRepository implements ControllerNativeEvidenceWriter {
  public constructor(private readonly db: SqliteDatabase) {}

  public adoptSubmittedTurnFence(
    input: ControllerLeaseFence & Readonly<{ turnId: string }>,
  ): boolean {
    assertFence(input);
    return this.db.transaction((): boolean => {
      if (!this.executorLeaseIsCurrent(input)) return false;
      const turn = this.db.prepare(
        "SELECT lease_owner, lease_generation FROM controller_turns WHERE id = ? AND state = 'submitted'",
      ).get(input.turnId) as { lease_owner: string | null; lease_generation: number | null } | undefined;
      if (!turn) return false;
      if (turn.lease_owner === input.ownerId && turn.lease_generation === input.generation) return true;
      return this.db.prepare(
        `UPDATE controller_turns SET lease_owner = ?, lease_generation = ?, updated_at = ?
          WHERE id = ? AND state = 'submitted'`,
      ).run(input.ownerId, input.generation, input.now, input.turnId).changes === 1;
    }).immediate();
  }

  public record(input: ControllerEvidenceInput): ControllerEvidenceWrite {
    const validated = validatedDirectInput(input);
    return this.db.transaction((): ControllerEvidenceWrite => {
      if (!this.fencedTurn(validated)) return { outcome: "stale" };
      if (this.evidenceCount(validated.turnId) >= MAX_EVIDENCE_ROWS) {
        this.markLimitExceeded(validated);
        return { outcome: "limit_exceeded" };
      }
      const id = this.insertDirectEvidence({
        ...validated,
        sourceKind: "hanoon_tool",
        sourceItemId: null,
      });
      return { outcome: "recorded", evidence: this.requiredEvidence(validated.turnId, id) };
    }).immediate();
  }

  public recordNativeBatch(
    input: ControllerNativeEvidenceInput,
  ): ControllerNativeEvidenceWrite {
    const validated = validatedNativeInput(input);
    return this.db.transaction(() => {
      const turn = this.fencedTurn(validated, true);
      if (!turn) return "stale" as const;
      if (turn.evidence_event_seq !== validated.fromSeq) return "cursor_changed" as const;
      if (this.nativeBatchHasIdentityConflict(validated)) return "native_identity_conflict" as const;
      if (this.nativeBatchCrossesCap(validated)) {
        this.markLimitExceeded(validated);
        return "limit_exceeded" as const;
      }
      for (const candidate of validated.items) this.insertNativeEvidence(validated, candidate);
      this.advanceNativeCursor(validated);
      return "recorded" as const;
    }).immediate();
  }

  public list(turnId: string, limit: number): ControllerEvidenceRecord[] {
    assertBoundedString(turnId, "turnId");
    assertPositiveInteger(limit, "limit");
    const rows = this.db.prepare(
      `SELECT * FROM controller_evidence
        WHERE turn_id = ? ORDER BY id ASC LIMIT ?`,
    ).all(turnId, Math.min(limit, MAX_EVIDENCE_ROWS)) as ControllerEvidenceRow[];
    return rows.map(parseEvidenceRow);
  }

  public get(turnId: string, evidenceId: number): ControllerEvidenceRecord | null {
    assertBoundedString(turnId, "turnId");
    assertPositiveInteger(evidenceId, "evidenceId");
    const row = this.db.prepare(
      "SELECT * FROM controller_evidence WHERE turn_id = ? AND id = ?",
    ).get(turnId, evidenceId) as ControllerEvidenceRow | undefined;
    return row ? parseEvidenceRow(row) : null;
  }

  public proposeFinalization(
    input: ControllerFinalizationProposalInput,
  ): ControllerFinalizationProposalResult {
    assertFence(input);
    assertBoundedString(input.controllerKey, "controllerKey");
    return this.db.transaction((): ControllerFinalizationProposalResult => {
      const turn = this.finalizationTurn(input);
      if (!turn) return { outcome: "stale" };
      if (turn.accepted_finalization_id !== null) {
        const accepted = this.requiredAcceptedFinalization(input.turnId);
        if (accepted.id !== turn.accepted_finalization_id) {
          throw new Error("Accepted controller finalization pointer changed during retry");
        }
        return rejectedWithoutRevision("accepted_already");
      }
      const bbEventHighWaterSeq = input.bbEventHighWaterSeq ?? turn.evidence_event_seq;
      const nativeHighWaterMatches = Number.isSafeInteger(bbEventHighWaterSeq) &&
        bbEventHighWaterSeq >= 0 && bbEventHighWaterSeq === turn.evidence_event_seq;
      const revisionCount = this.finalizationRevisionCount(input.turnId);
      if (revisionCount >= 8) return rejectedWithoutRevision("revision_limit");
      const evidenceHighWaterId = this.evidenceHighWaterId(input.turnId);
      const context = this.finalizationValidationContext(input, turn, revisionCount);
      const validation = validateControllerFinalization(input.candidate, context);
      const revision = revisionCount + 1;
      if (validation.outcome === "rejected") {
        const code = persistedRejectionCode(validation.code);
        this.insertFinalizationRevision({
          input,
          revision,
          payload: validation.storedCandidate,
          renderedMessage: "",
          evidenceHighWaterId,
          bbEventHighWaterSeq: null,
          state: "rejected",
          rejectionCode: code,
        });
        return { outcome: "rejected", revision, code, correction: validation.correction };
      }
      if (!nativeHighWaterMatches) return { outcome: "stale" };
      const id = this.insertFinalizationRevision({
        input,
        revision,
        payload: validation.candidate,
        renderedMessage: validation.renderedMessage,
        evidenceHighWaterId,
        bbEventHighWaterSeq,
        state: "accepted",
        rejectionCode: null,
      });
      const pointed = this.db.prepare(
        `UPDATE controller_turns SET accepted_finalization_id = ?, updated_at = ?
          WHERE id = ? AND accepted_finalization_id IS NULL`,
      ).run(id, input.now, input.turnId);
      if (pointed.changes !== 1) throw new Error("Controller finalization pointer changed during acceptance");
      return { outcome: "accepted", finalization: this.requiredAcceptedFinalization(input.turnId) };
    }).immediate();
  }

  public getAcceptedFinalization(turnId: string): AcceptedControllerFinalization | null {
    assertBoundedString(turnId, "turnId");
    const pointer = this.db.prepare(
      "SELECT accepted_finalization_id FROM controller_turns WHERE id = ?",
    ).get(turnId) as { accepted_finalization_id: number | null } | undefined;
    if (!pointer || pointer.accepted_finalization_id === null) return null;
    assertPositiveInteger(pointer.accepted_finalization_id, "persisted accepted finalization pointer");
    const row = this.db.prepare(
      "SELECT * FROM controller_finalizations WHERE id = ?",
    ).get(pointer.accepted_finalization_id) as ControllerFinalizationRow | undefined;
    if (!row || row.turn_id !== turnId) throw new Error("Accepted controller finalization pointer is inconsistent");
    const accepted = parseAcceptedFinalization(row);
    if (accepted.evidenceHighWaterId > 0 && !this.db.prepare(
      "SELECT 1 FROM controller_evidence WHERE turn_id = ? AND id = ?",
    ).get(turnId, accepted.evidenceHighWaterId)) {
      throw new Error("Accepted controller finalization evidence high-water is inconsistent");
    }
    return accepted;
  }

  public claimCompletionContinuation(
    input: ControllerCompletionContinuationInput,
  ): "claimed" | "already_claimed" | "stale" {
    assertFence(input);
    assertBoundedString(input.controllerKey, "controllerKey");
    assertNonNegativeInteger(input.bbHighWaterSeq, "bbHighWaterSeq");
    return this.db.transaction(() => {
      if (!this.executorLeaseIsCurrent(input)) return "stale" as const;
      const turn = this.db.prepare(
        `SELECT completion_continuations FROM controller_turns
          WHERE id = ? AND controller_key = ? AND state = 'submitted'
            AND lease_owner = ? AND lease_generation = ?
            AND accepted_finalization_id IS NULL AND evidence_event_seq = ?`,
      ).get(
        input.turnId,
        input.controllerKey,
        input.ownerId,
        input.generation,
        input.bbHighWaterSeq,
      ) as { completion_continuations: number } | undefined;
      if (!turn) return "stale" as const;
      if (turn.completion_continuations !== 0) return "already_claimed" as const;
      const claimed = this.db.prepare(
        `UPDATE controller_turns
            SET completion_continuations = 1, dispatch_after_seq = ?, bb_event_seq = ?,
                evidence_event_seq = ?, stream_text = '', stream_phase = 'thinking', updated_at = ?
          WHERE id = ? AND controller_key = ? AND state = 'submitted'
            AND lease_owner = ? AND lease_generation = ?
            AND accepted_finalization_id IS NULL AND completion_continuations = 0
            AND evidence_event_seq = ?`,
      ).run(
        input.bbHighWaterSeq,
        input.bbHighWaterSeq,
        input.bbHighWaterSeq,
        input.now,
        input.turnId,
        input.controllerKey,
        input.ownerId,
        input.generation,
        input.bbHighWaterSeq,
      );
      return claimed.changes === 1 ? "claimed" as const : "stale" as const;
    }).immediate();
  }

  private executorLeaseIsCurrent(input: ControllerLeaseFence): boolean {
    return this.db.prepare(
      `SELECT 1 FROM executor_lease
        WHERE singleton = 1 AND owner_id = ? AND generation = ?
          AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
    ).get(input.ownerId, input.generation, input.now) !== undefined;
  }

  private finalizationTurn(input: ControllerFinalizationProposalInput): FinalizationTurnRow | undefined {
    if (!this.executorLeaseIsCurrent(input)) return undefined;
    return this.db.prepare(
      `SELECT turn.evidence_event_seq, turn.accepted_finalization_id,
              turn.evidence_limit_exceeded_at, controller.telegram_user_id,
              controller.telegram_chat_id
         FROM controller_turns AS turn
         JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
        WHERE turn.id = ? AND turn.controller_key = ? AND turn.state = 'submitted'
          AND turn.lease_owner = ? AND turn.lease_generation = ?`,
    ).get(
      input.turnId,
      input.controllerKey,
      input.ownerId,
      input.generation,
    ) as FinalizationTurnRow | undefined;
  }

  private finalizationRevisionCount(turnId: string): number {
    return (this.db.prepare(
      "SELECT COUNT(*) AS count FROM controller_finalizations WHERE turn_id = ?",
    ).get(turnId) as { count: number }).count;
  }

  private evidenceHighWaterId(turnId: string): number {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(id), 0) AS id FROM controller_evidence WHERE turn_id = ?",
    ).get(turnId) as { id: number };
    assertNonNegativeInteger(row.id, "controller evidence high-water id");
    return row.id;
  }

  private finalizationValidationContext(
    input: ControllerFinalizationProposalInput,
    turn: FinalizationTurnRow,
    revisionCount: number,
  ): ControllerFinalizationValidationContext {
    const evidence = this.list(input.turnId, MAX_EVIDENCE_ROWS);
    const evidenceByRef = new Map(evidence.map((row) => [row.ref, {
      ref: row.ref,
      outcome: row.outcome,
      proofKinds: row.proofKinds,
      subjectRefs: row.subjectRefs,
    }]));
    const ownerBoundaryPresent = this.ownerBoundaryPresent(input, turn);
    return {
      acceptedAlready: false,
      revisionCount,
      evidenceLimitExceeded: turn.evidence_limit_exceeded_at !== null,
      evidenceByRef,
      ownerBoundaryPresent,
      liveObligationRefs: this.liveObligationRefs(input.controllerKey),
    };
  }

  private ownerBoundaryPresent(
    input: ControllerFinalizationProposalInput,
    turn: FinalizationTurnRow,
  ): boolean {
    const question = this.db.prepare(
      `SELECT 1 FROM controller_interactions
        WHERE turn_id = ? AND controller_key = ? AND state IN ('pending', 'answered') LIMIT 1`,
    ).get(input.turnId, input.controllerKey);
    if (question) return true;
    const operation = this.db.prepare(
      `SELECT 1 FROM thread_operations
        WHERE owner_user_id = ? AND owner_chat_id = ?
          AND state = 'awaiting_confirmation' AND expires_at > ? LIMIT 1`,
    ).get(turn.telegram_user_id, turn.telegram_chat_id, input.now);
    if (operation) return true;
    const awaitingJob = this.db.prepare(
      `SELECT 1 FROM jobs AS job
        WHERE job.state = 'awaiting_confirmation'
          AND NOT EXISTS (
            SELECT 1 FROM job_admissions AS admission
             WHERE admission.job_id = job.id
          )
        LIMIT 1`,
    ).get();
    if (awaitingJob) return true;
    return this.db.prepare(
      `SELECT 1 FROM approvals AS approval
         JOIN jobs AS job ON job.id = approval.job_id
        WHERE job.state = 'awaiting_merge_approval'
          AND job.pr_head_sha = approval.head_sha
          AND approval.job_version = job.version
          AND approval.consumed_at IS NULL AND approval.expires_at > ?
          AND approval.owner_user_id = ? AND approval.owner_chat_id = ?
        LIMIT 1`,
    ).get(input.now, turn.telegram_user_id, turn.telegram_chat_id) !== undefined;
  }

  private liveObligationRefs(controllerKey: string): ReadonlySet<string> {
    const refs = new Set<string>();
    const jobs = this.db.prepare(
      `SELECT id FROM jobs
        WHERE state NOT IN ('merged', 'cancelled', 'blocked', 'complete', 'production_failed')`,
    ).all() as { id: string }[];
    for (const job of jobs) refs.add(`job:${job.id}`);
    const monitors = this.db.prepare(
      `SELECT id FROM monitors
        WHERE controller_key = ? AND state = 'armed' AND system_key IS NULL`,
    ).all(controllerKey) as { id: string }[];
    for (const monitor of monitors) refs.add(`monitor:${monitor.id}`);
    const delegations = this.db.prepare(
      `SELECT delegation.id FROM delegations AS delegation
        WHERE delegation.controller_key = ? AND delegation.state = 'open'
          AND delegation.sealed_at IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM delegation_threads AS member
             WHERE member.delegation_id = delegation.id AND member.state = 'running'
          )`,
    ).all(controllerKey) as { id: string }[];
    for (const delegation of delegations) refs.add(`delegation:${delegation.id}`);
    return refs;
  }

  private insertFinalizationRevision(input: Readonly<{
    input: ControllerFinalizationProposalInput;
    revision: number;
    payload: ControllerFinalization;
    renderedMessage: string;
    evidenceHighWaterId: number;
    state: "accepted" | "rejected";
    rejectionCode: PersistedFinalizationRejectionCode | null;
    bbEventHighWaterSeq: number | null;
  }>): number {
    const payload = input.state === "accepted"
      ? {
          _hanoonControllerFinalization: input.payload,
          bbEventHighWaterSeq: input.bbEventHighWaterSeq,
        }
      : input.payload;
    const inserted = this.db.prepare(
      `INSERT INTO controller_finalizations (
         turn_id, revision, payload_json, rendered_message, evidence_high_water_id,
         state, rejection_code, created_at, validated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.input.turnId,
      input.revision,
      JSON.stringify(payload),
      input.renderedMessage,
      input.evidenceHighWaterId,
      input.state,
      input.rejectionCode,
      input.input.now,
      input.input.now,
    );
    const id = Number(inserted.lastInsertRowid);
    assertPositiveInteger(id, "inserted finalization id");
    return id;
  }

  private requiredAcceptedFinalization(turnId: string): AcceptedControllerFinalization {
    const accepted = this.getAcceptedFinalization(turnId);
    if (!accepted) throw new Error("Accepted controller finalization disappeared after insert");
    return accepted;
  }

  private fencedTurn(
    input: ControllerLeaseFence & Readonly<{ turnId: string; controllerKey: string }>,
    allowAcceptedFinalization = false,
  ): FencedTurnRow | undefined {
    if (!this.executorLeaseIsCurrent(input)) return undefined;
    return this.db.prepare(
      `SELECT evidence_event_seq FROM controller_turns
        WHERE id = ? AND controller_key = ? AND state = 'submitted'
          AND lease_owner = ? AND lease_generation = ?
          AND (? = 1 OR accepted_finalization_id IS NULL)`,
    ).get(
      input.turnId,
      input.controllerKey,
      input.ownerId,
      input.generation,
      allowAcceptedFinalization ? 1 : 0,
    ) as FencedTurnRow | undefined;
  }

  private evidenceCount(turnId: string): number {
    return (this.db.prepare(
      "SELECT COUNT(*) AS count FROM controller_evidence WHERE turn_id = ?",
    ).get(turnId) as { count: number }).count;
  }

  private markLimitExceeded(
    input: ControllerLeaseFence & Readonly<{ turnId: string; controllerKey: string }>,
  ): void {
    const marked = this.db.prepare(
      `UPDATE controller_turns
          SET evidence_limit_exceeded_at = COALESCE(evidence_limit_exceeded_at, ?), updated_at = ?
        WHERE id = ? AND controller_key = ? AND state = 'submitted'
          AND lease_owner = ? AND lease_generation = ?`,
    ).run(
      input.now,
      input.now,
      input.turnId,
      input.controllerKey,
      input.ownerId,
      input.generation,
    );
    if (marked.changes !== 1) throw new Error("Controller evidence fence changed while marking its cap");
  }

  private nativeBatchCrossesCap(input: ControllerNativeEvidenceInput): boolean {
    let newRows = 0;
    const sourceItemIds = new Set<string>();
    const existing = this.db.prepare(
      `SELECT 1 FROM controller_evidence
        WHERE turn_id = ? AND source_kind = 'bb_item' AND source_item_id = ?`,
    );
    for (const candidate of input.items) {
      if (sourceItemIds.has(candidate.sourceItemId)) continue;
      sourceItemIds.add(candidate.sourceItemId);
      if (!existing.get(input.turnId, candidate.sourceItemId)) newRows += 1;
    }
    return this.evidenceCount(input.turnId) + newRows > MAX_EVIDENCE_ROWS;
  }

  private nativeBatchHasIdentityConflict(input: ControllerNativeEvidenceInput): boolean {
    const batchIdentities = new Map<string, ControllerNativeEvidenceCandidate>();
    const persistedIdentity = this.db.prepare(
      `SELECT * FROM controller_evidence
        WHERE turn_id = ? AND source_kind = 'bb_item' AND source_item_id = ?`,
    );
    for (const candidate of input.items) {
      const batchIdentity = batchIdentities.get(candidate.sourceItemId);
      if (batchIdentity && !sameNativeSemantics(batchIdentity, candidate)) return true;
      if (batchIdentity) continue;
      batchIdentities.set(candidate.sourceItemId, candidate);
      const persisted = persistedIdentity.get(input.turnId, candidate.sourceItemId) as
        ControllerEvidenceRow | undefined;
      if (persisted && !sameNativeSemantics(parseEvidenceRow(persisted), candidate)) return true;
    }
    return false;
  }

  private insertNativeEvidence(
    input: ControllerNativeEvidenceInput,
    candidate: ControllerNativeEvidenceCandidate,
  ): void {
    this.runEvidenceInsert("INSERT OR IGNORE", {
      ...candidate,
      turnId: input.turnId,
      controllerKey: input.controllerKey,
      sourceKind: "bb_item",
      observedAt: input.now,
    });
  }

  private insertDirectEvidence(input: EvidenceInsertFields): number {
    const evidenceId = this.runEvidenceInsert("INSERT", input);
    if (evidenceId === null) throw new Error("Direct controller evidence was not inserted");
    return evidenceId;
  }

  private runEvidenceInsert(
    insertVerb: "INSERT" | "INSERT OR IGNORE",
    input: EvidenceInsertFields,
  ): number | null {
    const inserted = this.db.prepare(
      `${insertVerb} INTO controller_evidence (
         turn_id, controller_key, source_kind, source_name, source_item_id,
         outcome, args_sha256, result_sha256, proof_kinds_json,
         subject_refs_json, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.turnId,
      input.controllerKey,
      input.sourceKind,
      input.sourceName,
      input.sourceItemId,
      input.outcome,
      input.argsSha256,
      input.resultSha256,
      JSON.stringify(input.proofKinds),
      JSON.stringify(input.subjectRefs),
      input.observedAt,
    );
    if (inserted.changes === 0) return null;
    const evidenceId = Number(inserted.lastInsertRowid);
    assertPositiveInteger(evidenceId, "inserted evidence id");
    return evidenceId;
  }

  private advanceNativeCursor(input: ControllerNativeEvidenceInput): void {
    const advanced = this.db.prepare(
      `UPDATE controller_turns SET evidence_event_seq = ?, updated_at = ?
        WHERE id = ? AND controller_key = ? AND state = 'submitted'
          AND lease_owner = ? AND lease_generation = ?
          AND evidence_event_seq = ?`,
    ).run(
      input.throughSeq,
      input.now,
      input.turnId,
      input.controllerKey,
      input.ownerId,
      input.generation,
      input.fromSeq,
    );
    if (advanced.changes !== 1) throw new Error("Controller evidence cursor changed during native batch");
  }

  private requiredEvidence(turnId: string, evidenceId: number): ControllerEvidenceRecord {
    const evidence = this.get(turnId, evidenceId);
    if (!evidence) throw new Error("Controller evidence disappeared after insert");
    return evidence;
  }
}

function validatedDirectInput(input: ControllerEvidenceInput): ControllerEvidenceInput & {
  observedAt: number;
} {
  assertFence(input);
  assertBoundedString(input.controllerKey, "controllerKey");
  if (input.sourceKind !== "hanoon_tool" || input.sourceItemId !== null) {
    throw new TypeError("direct controller evidence must be a Hanoon tool result");
  }
  const validatedFields = validatedEvidenceFields(input);
  return { ...input, ...validatedFields, observedAt: input.now };
}

function validatedNativeInput(input: ControllerNativeEvidenceInput): ControllerNativeEvidenceInput {
  assertFence(input);
  assertBoundedString(input.controllerKey, "controllerKey");
  assertNonNegativeInteger(input.fromSeq, "fromSeq");
  assertNonNegativeInteger(input.throughSeq, "throughSeq");
  if (input.throughSeq < input.fromSeq) throw new TypeError("throughSeq must not precede fromSeq");
  if (!Array.isArray(input.items)) throw new TypeError("items must be an array");
  const items = input.items.map((candidate) => ({
    ...candidate,
    ...validatedEvidenceFields(candidate),
    sourceItemId: validatedBoundedString(candidate.sourceItemId, "sourceItemId"),
  }));
  return { ...input, items };
}

function validatedEvidenceFields(input: {
  sourceName: string;
  outcome: ControllerEvidenceOutcome;
  argsSha256: string;
  resultSha256: string;
  proofKinds: readonly ControllerProofKind[];
  subjectRefs: readonly string[];
}) {
  const sourceName = validatedBoundedString(input.sourceName, "sourceName");
  if (!EVIDENCE_OUTCOMES.has(input.outcome)) throw new TypeError("outcome is invalid");
  assertSha256(input.argsSha256, "argsSha256");
  assertSha256(input.resultSha256, "resultSha256");
  const proofKinds = validatedProofKinds(input.proofKinds);
  const subjectRefs = validatedSubjectRefs(input.subjectRefs);
  return { sourceName, proofKinds, subjectRefs };
}

function validatedProofKinds(values: readonly ControllerProofKind[]): readonly ControllerProofKind[] {
  if (!Array.isArray(values) || values.length > MAX_PROOF_KINDS) {
    throw new TypeError("proofKinds must contain at most 8 values");
  }
  if (new Set(values).size !== values.length || values.some((proofKind) => !PROOF_KINDS.has(proofKind))) {
    throw new TypeError("proofKinds must contain unique known values");
  }
  return [...values];
}

function validatedSubjectRefs(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > MAX_SUBJECT_REFS) {
    throw new TypeError("subjectRefs must contain at most 16 values");
  }
  const subjectRefs = values.map((subjectRef) => validatedBoundedString(subjectRef, "subjectRef"));
  if (new Set(subjectRefs).size !== subjectRefs.length) {
    throw new TypeError("subjectRefs must contain unique values");
  }
  return subjectRefs;
}

function parseEvidenceRow(row: ControllerEvidenceRow): ControllerEvidenceRecord {
  assertPositiveInteger(row.id, "persisted evidence id");
  assertBoundedString(row.turn_id, "persisted turnId");
  assertBoundedString(row.controller_key, "persisted controllerKey");
  const sourceKind = parsedSourceKind(row.source_kind);
  const outcome = parsedOutcome(row.outcome);
  const validatedFields = validatedEvidenceFields({
    sourceName: row.source_name,
    outcome,
    argsSha256: row.args_sha256,
    resultSha256: row.result_sha256,
    proofKinds: JSON.parse(row.proof_kinds_json) as ControllerProofKind[],
    subjectRefs: JSON.parse(row.subject_refs_json) as string[],
  });
  const sourceItemId = parsedSourceItemId(sourceKind, row.source_item_id);
  assertNonNegativeInteger(row.observed_at, "persisted observedAt");
  return {
    id: row.id,
    ref: `evidence:${row.id}`,
    turnId: row.turn_id,
    controllerKey: row.controller_key,
    sourceKind,
    sourceName: validatedFields.sourceName,
    sourceItemId,
    outcome,
    argsSha256: row.args_sha256,
    resultSha256: row.result_sha256,
    proofKinds: validatedFields.proofKinds,
    subjectRefs: validatedFields.subjectRefs,
    observedAt: row.observed_at,
  };
}

function parseAcceptedFinalization(row: ControllerFinalizationRow): AcceptedControllerFinalization {
  assertPositiveInteger(row.id, "persisted finalization id");
  assertBoundedString(row.turn_id, "persisted finalization turnId");
  assertPositiveInteger(row.revision, "persisted finalization revision");
  assertNonNegativeInteger(row.evidence_high_water_id, "persisted finalization evidence high-water id");
  assertNonNegativeInteger(row.created_at, "persisted finalization createdAt");
  assertNonNegativeInteger(row.validated_at, "persisted finalization validatedAt");
  if (row.consumed_at !== null) assertNonNegativeInteger(row.consumed_at, "persisted finalization consumedAt");
  if (row.state !== "accepted" || row.rejection_code !== null) {
    throw new Error("Accepted controller finalization has an inconsistent state");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload_json);
  } catch {
    throw new Error("Accepted controller finalization payload is malformed");
  }
  let candidateValue: unknown = parsed;
  let bbEventHighWaterSeq: number | null = null;
  if (parsed !== null && typeof parsed === "object" &&
      Object.hasOwn(parsed, "_hanoonControllerFinalization")) {
    const envelope = parsed as {
      _hanoonControllerFinalization?: unknown;
      bbEventHighWaterSeq?: unknown;
    };
    candidateValue = envelope._hanoonControllerFinalization;
    const persistedHighWater = envelope.bbEventHighWaterSeq;
    if (typeof persistedHighWater !== "number" || !Number.isSafeInteger(persistedHighWater) || persistedHighWater < 0) {
      throw new Error("Accepted controller finalization BB event high-water is invalid");
    }
    bbEventHighWaterSeq = persistedHighWater;
  }
  const candidate = controllerFinalizationSchema.safeParse(candidateValue);
  if (!candidate.success) throw new Error("Accepted controller finalization payload is invalid");
  if (renderControllerFinalization(candidate.data) !== row.rendered_message) {
    throw new Error("Accepted controller finalization rendered text is inconsistent");
  }
  return {
    id: row.id,
    ref: `finalization:${row.id}`,
    turnId: row.turn_id,
    revision: row.revision,
    candidate: candidate.data,
    renderedMessage: row.rendered_message,
    evidenceHighWaterId: row.evidence_high_water_id,
    bbEventHighWaterSeq,
    createdAt: row.created_at,
    validatedAt: row.validated_at,
    consumedAt: row.consumed_at,
  };
}

function rejectedWithoutRevision(
  code: "accepted_already" | "revision_limit",
): ControllerFinalizationProposalResult {
  return { outcome: "rejected", code, correction: controllerFinalizationCorrection(code) };
}

function persistedRejectionCode(
  code: Parameters<typeof controllerFinalizationCorrection>[0],
): PersistedFinalizationRejectionCode {
  if (code === "accepted_already" || code === "revision_limit") {
    throw new Error("Non-persisted finalization rejection escaped repository prechecks");
  }
  return code;
}

function parsedSourceKind(value: string): ControllerEvidenceRecord["sourceKind"] {
  if (value !== "hanoon_tool" && value !== "bb_item") {
    throw new Error(`Unknown persisted controller evidence source kind: ${value}`);
  }
  return value;
}

function parsedOutcome(value: string): ControllerEvidenceOutcome {
  if (!EVIDENCE_OUTCOMES.has(value)) {
    throw new Error(`Unknown persisted controller evidence outcome: ${value}`);
  }
  return value as ControllerEvidenceOutcome;
}

function parsedSourceItemId(
  sourceKind: ControllerEvidenceRecord["sourceKind"],
  sourceItemId: string | null,
): string | null {
  if (sourceKind === "hanoon_tool" && sourceItemId !== null) {
    throw new Error("Persisted Hanoon evidence has a native item id");
  }
  if (sourceKind === "bb_item" && sourceItemId === null) {
    throw new Error("Persisted native evidence is missing its item id");
  }
  return sourceItemId === null
    ? null
    : validatedBoundedString(sourceItemId, "persisted sourceItemId");
}

function sameNativeSemantics(
  known: Pick<
    ControllerNativeEvidenceCandidate,
    "sourceName" | "outcome" | "argsSha256" | "resultSha256" | "proofKinds" | "subjectRefs"
  >,
  candidate: ControllerNativeEvidenceCandidate,
): boolean {
  return known.sourceName === candidate.sourceName && known.outcome === candidate.outcome &&
    known.argsSha256 === candidate.argsSha256 && known.resultSha256 === candidate.resultSha256 &&
    sameOrderedValues(known.proofKinds, candidate.proofKinds) &&
    sameOrderedValues(known.subjectRefs, candidate.subjectRefs);
}

function sameOrderedValues<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertFence(input: ControllerLeaseFence & Readonly<{ turnId: string }>): void {
  assertBoundedString(input.turnId, "turnId");
  assertBoundedString(input.ownerId, "ownerId");
  assertPositiveInteger(input.generation, "generation");
  assertNonNegativeInteger(input.now, "now");
}

function validatedBoundedString(value: string, field: string): string {
  assertBoundedString(value, field);
  return value;
}

function assertBoundedString(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new TypeError(`${field} must be between 1 and 256 characters`);
  }
}

function assertSha256(value: string, field: string): void {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new TypeError(`${field} must be a lowercase 64-character SHA-256 hex string`);
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}
