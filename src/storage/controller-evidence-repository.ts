import type Database from "better-sqlite3";
import {
  CONTROLLER_PROOF_KINDS,
  type ControllerLeaseFence,
  type ControllerProofKind,
} from "../controller/models";

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

export interface ControllerNativeEvidenceWriter {
  recordNativeBatch(
    input: ControllerNativeEvidenceInput,
  ): "recorded" | "stale" | "cursor_changed" | "limit_exceeded";
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
  ): "recorded" | "stale" | "cursor_changed" | "limit_exceeded" {
    const validated = validatedNativeInput(input);
    return this.db.transaction(() => {
      const turn = this.fencedTurn(validated);
      if (!turn) return "stale" as const;
      if (turn.evidence_event_seq !== validated.fromSeq) return "cursor_changed" as const;
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

  private executorLeaseIsCurrent(input: ControllerLeaseFence): boolean {
    return this.db.prepare(
      `SELECT 1 FROM executor_lease
        WHERE singleton = 1 AND owner_id = ? AND generation = ?
          AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
    ).get(input.ownerId, input.generation, input.now) !== undefined;
  }

  private fencedTurn(
    input: ControllerLeaseFence & Readonly<{ turnId: string; controllerKey: string }>,
  ): FencedTurnRow | undefined {
    if (!this.executorLeaseIsCurrent(input)) return undefined;
    return this.db.prepare(
      `SELECT evidence_event_seq FROM controller_turns
        WHERE id = ? AND controller_key = ? AND state = 'submitted'
          AND lease_owner = ? AND lease_generation = ?
          AND accepted_finalization_id IS NULL`,
    ).get(
      input.turnId,
      input.controllerKey,
      input.ownerId,
      input.generation,
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
          AND lease_owner = ? AND lease_generation = ? AND accepted_finalization_id IS NULL`,
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
          AND accepted_finalization_id IS NULL AND evidence_event_seq = ?`,
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
