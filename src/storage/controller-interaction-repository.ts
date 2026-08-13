import type Database from "better-sqlite3";
import {
  isSafeControllerApprovalSummary,
  nextUnansweredQuestion,
  questionOptionToken,
  threadDecisionToken,
  type ControllerInteraction,
  type ControllerQuestionAnswers,
} from "../controller/questions";
import type { ControllerLeaseFence } from "../controller/models";

type SqliteDatabase = Database.Database;

export type ControllerInteractionState = "pending" | "answered" | "delivered";

export type ControllerInteractionRecord = Readonly<{
  interactionId: string;
  turnId: string;
  controllerKey: string;
  bbThreadId: string | null;
  controllerGenerationId: string | null;
  interaction: ControllerInteraction;
  state: ControllerInteractionState;
  answer: ControllerInteractionResolution | null;
  askedAt: number;
  answeredAt: number | null;
  deliveredAt: number | null;
}>;

export type ControllerInteractionResolution =
  | { kind: "user_answer"; answers: ControllerQuestionAnswers }
  | { decision: "allow_once"; grantedPermissions: null }
  | { decision: "deny" };

export type ControllerInteractionDelivery = ControllerInteractionRecord & {
  bbThreadId: string;
  controllerGenerationId: string;
  answer: ControllerInteractionResolution;
};

export type ControllerInteractionAnswer =
  | { ok: true; interactionId: string; turnId: string; resolution: ControllerInteractionResolution }
  | { ok: false; reason: "stale" };

export interface ControllerInteractionStore {
  record(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    bbThreadId: string;
    controllerGenerationId: string;
    interaction: ControllerInteraction;
  }): boolean;
  markResolved(input: ControllerLeaseFence & {
    interactionId: string;
    turnId: string;
    bbThreadId: string;
  }): boolean;
  answerByToken(input: { token: string; userId: string; chatId: string; now: number }): ControllerInteractionAnswer;
  answerWithText(input: {
    controllerKey: string; userId: string; chatId: string; text: string; now: number;
  }): ControllerInteractionAnswer;
  getPending(controllerKey: string): ControllerInteractionRecord | null;
  getAnswered(controllerKey: string): ControllerInteractionDelivery | null;
  sourceCanRecord(input: ControllerLeaseFence & { turnId: string; controllerKey: string; bbThreadId: string; controllerGenerationId: string }): boolean;
  sourceIsActive(input: ControllerLeaseFence & { interactionId: string; turnId: string; bbThreadId: string }): boolean;
  markDelivered(input: ControllerLeaseFence & {
    interactionId: string;
    turnId: string;
    bbThreadId: string;
  }): boolean;
}

type InteractionRow = {
  interaction_id: string;
  turn_id: string;
  controller_key: string;
  bb_thread_id: string | null;
  controller_generation_id: string | null;
  kind: ControllerInteraction["kind"];
  payload_json: string;
  state: ControllerInteractionState;
  answer_json: string | null;
  asked_at: number;
  answered_at: number | null;
  delivered_at: number | null;
};

const interactionStates = "'pending', 'answered'";

function isSafeIdentifier(identifier: string): boolean {
  return identifier.length > 0 && identifier.length <= 200;
}

function plainRecord(rawValue: unknown): rawValue is Record<string, unknown> {
  return typeof rawValue === "object" && rawValue !== null && !Array.isArray(rawValue);
}

function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(record);
  return required.every((key) => key in record) && keys.every((key) => required.includes(key) || optional.includes(key));
}

function boundedText(rawText: unknown, maxCharacters: number, maxBytes = maxCharacters): rawText is string {
  return typeof rawText === "string" && rawText.length > 0 && [...rawText].length <= maxCharacters &&
    Buffer.byteLength(rawText, "utf8") <= maxBytes;
}

function validQuestionOption(rawOption: unknown): rawOption is { value: string; label: string; description: string | null } {
  if (!plainRecord(rawOption) || !exactKeys(rawOption, ["value", "label", "description"])) return false;
  return boundedText(rawOption.value, 120, 480) && boundedText(rawOption.label, 60, 64) &&
    (rawOption.description === null || boundedText(rawOption.description, 200, 800));
}

function validQuestion(rawQuestion: unknown): boolean {
  if (!plainRecord(rawQuestion) || !exactKeys(rawQuestion, ["id", "prompt", "shortLabel", "multiSelect", "allowFreeText", "options"])) return false;
  if (!boundedText(rawQuestion.id, 120, 480) || !boundedText(rawQuestion.prompt, 400, 1_600) ||
    !(rawQuestion.shortLabel === null || boundedText(rawQuestion.shortLabel, 60, 64)) ||
    typeof rawQuestion.multiSelect !== "boolean" || typeof rawQuestion.allowFreeText !== "boolean" ||
    !Array.isArray(rawQuestion.options) || rawQuestion.options.length > 6 || !rawQuestion.options.every(validQuestionOption)) return false;
  const optionValues = rawQuestion.options.map((option) => (option as { value: string }).value);
  return new Set(optionValues).size === optionValues.length && (rawQuestion.allowFreeText || rawQuestion.options.length > 0);
}

function validInteraction(rawInteraction: unknown, row: InteractionRow): rawInteraction is ControllerInteraction {
  if (!plainRecord(rawInteraction) || !boundedText(rawInteraction.interactionId, 200, 800) ||
    rawInteraction.interactionId !== row.interaction_id || rawInteraction.kind !== row.kind) return false;
  if (rawInteraction.kind === "user_question") {
    if (!exactKeys(rawInteraction, ["kind", "interactionId", "questions"]) || !Array.isArray(rawInteraction.questions) ||
      rawInteraction.questions.length === 0 || rawInteraction.questions.length > 4 || !rawInteraction.questions.every(validQuestion)) return false;
    const questionIds = rawInteraction.questions.map((question) => (question as { id: string }).id);
    return new Set(questionIds).size === questionIds.length;
  }
  if (rawInteraction.kind === "approval") {
    return exactKeys(rawInteraction, ["kind", "interactionId", "summary", "decisions"]) &&
      isSafeControllerApprovalSummary(rawInteraction.summary) && Array.isArray(rawInteraction.decisions) && rawInteraction.decisions.length > 0 &&
      rawInteraction.decisions.length <= 2 && new Set(rawInteraction.decisions).size === rawInteraction.decisions.length &&
      rawInteraction.decisions.every((decision) => decision === "allow_once" || decision === "deny");
  }
  return rawInteraction.kind === "unsupported" && exactKeys(rawInteraction, ["kind", "interactionId", "metadata"]) &&
    plainRecord(rawInteraction.metadata) && exactKeys(rawInteraction.metadata, ["sourceKind"]) &&
    (rawInteraction.metadata.sourceKind === null ||
      (typeof rawInteraction.metadata.sourceKind === "string" && /^[a-z_]{1,40}$/.test(rawInteraction.metadata.sourceKind)));
}

function validUserAnswers(rawAnswers: unknown, interaction: Extract<ControllerInteraction, { kind: "user_question" }>): rawAnswers is ControllerQuestionAnswers {
  if (!plainRecord(rawAnswers)) return false;
  const questions = new Map(interaction.questions.map((question) => [question.id, question]));
  return Object.entries(rawAnswers).every(([questionId, rawAnswer]) => {
    const question = questions.get(questionId);
    if (!question || !plainRecord(rawAnswer) || !exactKeys(rawAnswer, ["selected"], ["freeText"]) || !Array.isArray(rawAnswer.selected)) return false;
    const selected = rawAnswer.selected;
    if (!selected.every((entry) => typeof entry === "string") || new Set(selected).size !== selected.length ||
      (!question.multiSelect && selected.length > 1) || selected.some((entry) => !question.options.some((option) => option.value === entry))) return false;
    const freeText = rawAnswer.freeText;
    if (freeText !== undefined && !boundedText(freeText, 2_000, 4_000)) return false;
    return selected.length > 0 || freeText !== undefined;
  });
}

function validResolution(rawResolution: unknown, interaction: ControllerInteraction): rawResolution is ControllerInteractionResolution {
  if (!plainRecord(rawResolution)) return false;
  if (interaction.kind === "user_question") {
    return exactKeys(rawResolution, ["kind", "answers"]) && rawResolution.kind === "user_answer" && validUserAnswers(rawResolution.answers, interaction);
  }
  if (interaction.kind !== "approval" || !exactKeys(rawResolution, ["decision"], ["grantedPermissions"])) return false;
  if (rawResolution.decision === "allow_once") {
    return interaction.decisions.includes("allow_once") && rawResolution.grantedPermissions === null && "grantedPermissions" in rawResolution;
  }
  return rawResolution.decision === "deny" && interaction.decisions.includes("deny") && !("grantedPermissions" in rawResolution);
}

function safeJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function safeTimestamp(rawTimestamp: number | null): boolean {
  return rawTimestamp === null || (Number.isSafeInteger(rawTimestamp) && rawTimestamp >= 0);
}

function completeUserResolution(interaction: ControllerInteraction, answer: ControllerInteractionResolution | null): boolean {
  return interaction.kind === "user_question" && answer !== null && "kind" in answer && answer.kind === "user_answer" &&
    interaction.questions.every((question) => question.id in answer.answers);
}

function partialUserResolution(interaction: ControllerInteraction, answer: ControllerInteractionResolution | null): boolean {
  return interaction.kind === "user_question" && answer !== null && "kind" in answer && answer.kind === "user_answer" &&
    Object.keys(answer.answers).length > 0 && !completeUserResolution(interaction, answer);
}

function validLifecycle(row: InteractionRow, interaction: ControllerInteraction, answer: ControllerInteractionResolution | null): boolean {
  const hasSourcePair = (row.bb_thread_id === null) === (row.controller_generation_id === null);
  const answerIsComplete = completeUserResolution(interaction, answer);
  const stateIsValid = row.state === "pending"
    ? row.answered_at === null && row.delivered_at === null && (answer === null || partialUserResolution(interaction, answer))
    : row.state === "answered"
      ? answer !== null && row.answered_at !== null && row.answered_at >= row.asked_at && row.delivered_at === null &&
        (interaction.kind !== "user_question" || answerIsComplete)
      : row.delivered_at !== null && (answer === null) === (row.answered_at === null);
  return hasSourcePair && (row.state === "delivered" || row.bb_thread_id !== null) && stateIsValid &&
    !(row.delivered_at !== null && row.delivered_at < row.asked_at) &&
    !(row.answered_at !== null && row.delivered_at !== null && row.delivered_at < row.answered_at);
}

function parseRow(row: InteractionRow): ControllerInteractionRecord | null {
  const rawInteraction = safeJson(row.payload_json);
  if (!isSafeIdentifier(row.turn_id) || !isSafeIdentifier(row.controller_key) ||
    (row.bb_thread_id !== null && !isSafeIdentifier(row.bb_thread_id)) ||
    (row.controller_generation_id !== null && !isSafeIdentifier(row.controller_generation_id)) ||
    !validInteraction(rawInteraction, row) || !safeTimestamp(row.asked_at) || !safeTimestamp(row.answered_at) || !safeTimestamp(row.delivered_at)) return null;
  const rawAnswer = row.answer_json === null ? null : safeJson(row.answer_json);
  if (row.answer_json !== null && (rawAnswer === null || !validResolution(rawAnswer, rawInteraction))) return null;
  const answer = rawAnswer as ControllerInteractionResolution | null;
  if (!validLifecycle(row, rawInteraction, answer)) return null;
  return {
    interactionId: row.interaction_id,
    turnId: row.turn_id,
    controllerKey: row.controller_key,
    bbThreadId: row.bb_thread_id,
    controllerGenerationId: row.controller_generation_id,
    interaction: rawInteraction,
    state: row.state,
    answer,
    askedAt: row.asked_at,
    answeredAt: row.answered_at,
    deliveredAt: row.delivered_at,
  };
}

/** Durable controller interaction state. It deliberately does not call BB. */
export class ControllerInteractionRepository implements ControllerInteractionStore {
  public constructor(private readonly db: SqliteDatabase) {}

  public record(input: ControllerLeaseFence & {
    turnId: string; controllerKey: string; bbThreadId: string; controllerGenerationId: string; interaction: ControllerInteraction;
  }): boolean {
    if (!this.validFence(input) || !isSafeIdentifier(input.turnId) || !isSafeIdentifier(input.controllerKey) ||
      !isSafeIdentifier(input.bbThreadId) || !isSafeIdentifier(input.controllerGenerationId) ||
      !isSafeIdentifier(input.interaction.interactionId) || !validInteraction(input.interaction, {
        interaction_id: input.interaction.interactionId,
        kind: input.interaction.kind,
      } as InteractionRow)) return false;
    return this.db.transaction((): boolean => {
      if (!this.activeSource(input)) return false;
      const serialized = JSON.stringify(input.interaction);
      const known = this.db.prepare("SELECT turn_id, controller_key, bb_thread_id, controller_generation_id, payload_json FROM controller_interactions WHERE interaction_id = ?")
        .get(input.interaction.interactionId) as { turn_id: string; controller_key: string; bb_thread_id: string; controller_generation_id: string; payload_json: string } | undefined;
      if (known) return known.turn_id === input.turnId && known.controller_key === input.controllerKey &&
        known.bb_thread_id === input.bbThreadId && known.controller_generation_id === input.controllerGenerationId && known.payload_json === serialized;
      const inserted = this.db.prepare(
        `INSERT OR IGNORE INTO controller_interactions
           (interaction_id, turn_id, controller_key, bb_thread_id, controller_generation_id, kind, payload_json, state, answer_json, asked_at, answered_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, NULL)`,
      ).run(
        input.interaction.interactionId, input.turnId, input.controllerKey, input.bbThreadId,
        input.controllerGenerationId, input.interaction.kind, serialized, input.now,
      );
      if (inserted.changes !== 1) return false;
      this.promote(input.turnId, input.now);
      return true;
    }).immediate();
  }

  public markResolved(input: ControllerLeaseFence & { interactionId: string; turnId: string; bbThreadId: string }): boolean {
    if (!this.validFence(input) || !isSafeIdentifier(input.interactionId) || !isSafeIdentifier(input.turnId) || !isSafeIdentifier(input.bbThreadId)) return false;
    return this.db.transaction((): boolean => {
      if (!this.currentLease(input) || !this.activeInteraction(input) || !this.validStoredRow(input.interactionId)) return false;
      const changed = this.db.prepare(
        `UPDATE controller_interactions SET state = 'delivered',
          answer_json = CASE WHEN state = 'pending' THEN NULL ELSE answer_json END,
          answered_at = CASE WHEN state = 'pending' THEN NULL ELSE answered_at END,
          delivered_at = ?
          WHERE interaction_id = ? AND turn_id = ? AND bb_thread_id = ? AND state IN (${interactionStates})`,
      ).run(input.now, input.interactionId, input.turnId, input.bbThreadId).changes === 1;
      if (changed) this.promote(input.turnId, input.now);
      return changed;
    }).immediate();
  }

  public answerByToken(input: { token: string; userId: string; chatId: string; now: number }): ControllerInteractionAnswer {
    if (!isSafeIdentifier(input.token) || !isSafeIdentifier(input.userId) || !isSafeIdentifier(input.chatId) || !Number.isSafeInteger(input.now) || input.now < 0) return { ok: false, reason: "stale" };
    return this.db.transaction((): ControllerInteractionAnswer => {
      const row = this.ownedPending(input.userId, input.chatId)[0];
      if (row) {
        const record = parseRow(row);
        if (!record) return { ok: false, reason: "stale" };
        if (record.interaction.kind === "approval") {
          for (const decision of record.interaction.decisions) {
            if (threadDecisionToken(record.interactionId, decision) !== input.token) continue;
            return this.answer(record, decision === "allow_once"
              ? { decision, grantedPermissions: null }
              : { decision }, input.now);
          }
        }
        if (record.interaction.kind !== "user_question") return { ok: false, reason: "stale" };
        const previous = this.userAnswers(record);
        for (const question of record.interaction.questions) {
          if (question.id in previous) continue;
          for (const option of question.options) {
            if (questionOptionToken(record.interactionId, question.id, option.value) === input.token) {
              return this.answerQuestion(record, { ...previous, [question.id]: { selected: [option.value] } }, input.now);
            }
          }
        }
      }
      return { ok: false, reason: "stale" };
    }).immediate();
  }

  public answerWithText(input: { controllerKey: string; userId: string; chatId: string; text: string; now: number }): ControllerInteractionAnswer {
    if (!isSafeIdentifier(input.controllerKey) || !isSafeIdentifier(input.userId) || !isSafeIdentifier(input.chatId) ||
      typeof input.text !== "string" || input.text.trim().length === 0 || input.text.length > 2_000 ||
      !Number.isSafeInteger(input.now) || input.now < 0) return { ok: false, reason: "stale" };
    return this.db.transaction((): ControllerInteractionAnswer => {
      const row = this.ownedPending(input.userId, input.chatId, input.controllerKey)[0];
      if (!row) return { ok: false, reason: "stale" };
      const record = parseRow(row);
      if (!record) return { ok: false, reason: "stale" };
      if (record.interaction.kind !== "user_question") return { ok: false, reason: "stale" };
      const answers = this.userAnswers(record);
      const next = nextUnansweredQuestion(record.interaction.questions, answers);
      if (!next) return { ok: false, reason: "stale" };
      return this.answerQuestion(record, { ...answers, [next.question.id]: { selected: [], freeText: input.text.trim() } }, input.now);
    }).immediate();
  }

  public getPending(controllerKey: string): ControllerInteractionRecord | null {
    if (!isSafeIdentifier(controllerKey)) return null;
    const row = this.db.prepare(
      `SELECT interaction.* FROM controller_interactions AS interaction
        JOIN controller_turns AS turn ON turn.id = interaction.turn_id AND turn.state = 'submitted'
       WHERE interaction.controller_key = ? AND interaction.state = 'pending'
       ORDER BY interaction.asked_at ASC, interaction.interaction_id ASC LIMIT 1`,
    ).get(controllerKey) as InteractionRow | undefined;
    return row ? parseRow(row) : null;
  }

  public getAnswered(controllerKey: string): ControllerInteractionDelivery | null {
    if (!isSafeIdentifier(controllerKey)) return null;
    const row = this.db.prepare(
      `SELECT interaction.* FROM controller_interactions AS interaction
        JOIN controller_turns AS turn ON turn.id = interaction.turn_id AND turn.state = 'submitted'
       WHERE interaction.controller_key = ? AND interaction.state = 'answered'
       ORDER BY interaction.asked_at ASC, interaction.interaction_id ASC LIMIT 1`,
    ).get(controllerKey) as InteractionRow | undefined;
    if (!row) return null;
    const record = parseRow(row);
    if (!record || record.bbThreadId === null || record.controllerGenerationId === null || record.answer === null) return null;
    return record as ControllerInteractionDelivery;
  }

  public markDelivered(input: ControllerLeaseFence & { interactionId: string; turnId: string; bbThreadId: string }): boolean {
    if (!this.validFence(input) || !isSafeIdentifier(input.interactionId) || !isSafeIdentifier(input.turnId) || !isSafeIdentifier(input.bbThreadId)) return false;
    return this.db.transaction(() => {
      if (!this.currentLease(input) || !this.activeInteraction(input) || !this.validStoredRow(input.interactionId)) return false;
      const changed = this.db.prepare(
        `UPDATE controller_interactions SET state = 'delivered', delivered_at = ?
          WHERE interaction_id = ? AND turn_id = ? AND bb_thread_id = ? AND state = 'answered'`,
      ).run(input.now, input.interactionId, input.turnId, input.bbThreadId).changes === 1;
      if (changed) this.promote(input.turnId, input.now);
      return changed;
    }).immediate();
  }

  /** Read-only fence used immediately before external BB effects. */
  public sourceIsActive(input: ControllerLeaseFence & { interactionId: string; turnId: string; bbThreadId: string }): boolean {
    if (!this.validFence(input)) return false;
    return this.db.transaction(() => this.db.prepare(
      `SELECT 1 FROM executor_lease AS lease
        JOIN controller_interactions AS interaction ON interaction.interaction_id = ? AND interaction.turn_id = ? AND interaction.bb_thread_id = ?
        JOIN controller_turns AS turn ON turn.id = interaction.turn_id AND turn.state = 'submitted'
          AND turn.lease_owner = lease.owner_id AND turn.lease_generation = lease.generation
        JOIN controller_threads AS controller ON controller.controller_key = interaction.controller_key
          AND controller.state = 'active' AND controller.bb_thread_id = interaction.bb_thread_id
        JOIN controller_generations AS generation ON generation.id = interaction.controller_generation_id
          AND generation.controller_key = interaction.controller_key AND generation.thread_id = interaction.bb_thread_id
          AND generation.ended_at IS NULL
       WHERE lease.singleton = 1 AND lease.owner_id = ? AND lease.generation = ? AND lease.lease_expires_at > ?
         AND (SELECT COUNT(*) FROM controller_generations AS open_generation
               WHERE open_generation.controller_key = interaction.controller_key
                 AND open_generation.thread_id = interaction.bb_thread_id
                 AND open_generation.ended_at IS NULL) = 1`,
    ).get(input.interactionId, input.turnId, input.bbThreadId, input.ownerId, input.generation, input.now) !== undefined).immediate();
  }

  /** Read-only fence for a lifecycle ref before it has a durable interaction row. */
  public sourceCanRecord(input: ControllerLeaseFence & { turnId: string; controllerKey: string; bbThreadId: string; controllerGenerationId: string }): boolean {
    if (!this.validFence(input)) return false;
    return this.db.transaction(() => this.activeSource(input)).immediate();
  }

  private answerQuestion(record: ControllerInteractionRecord, answers: ControllerQuestionAnswers, now: number): ControllerInteractionAnswer {
    if (record.interaction.kind !== "user_question") return { ok: false, reason: "stale" };
    const complete = nextUnansweredQuestion(record.interaction.questions, answers) === null;
    if (!complete) {
      const resolution = { kind: "user_answer" as const, answers };
      const changed = this.db.prepare(
        `UPDATE controller_interactions SET answer_json = ? WHERE interaction_id = ? AND state = 'pending'`,
      ).run(JSON.stringify(resolution), record.interactionId).changes === 1;
      return changed
        ? { ok: true, interactionId: record.interactionId, turnId: record.turnId, resolution }
        : { ok: false, reason: "stale" };
    }
    return this.answer(record, { kind: "user_answer", answers }, now);
  }

  private answer(record: ControllerInteractionRecord, resolution: ControllerInteractionResolution, now: number): ControllerInteractionAnswer {
    const changed = this.db.prepare(
      `UPDATE controller_interactions SET state = 'answered', answer_json = ?, answered_at = ?
        WHERE interaction_id = ? AND state = 'pending'`,
    ).run(JSON.stringify(resolution), now, record.interactionId).changes === 1;
    return changed
      ? { ok: true, interactionId: record.interactionId, turnId: record.turnId, resolution }
      : { ok: false, reason: "stale" };
  }

  private userAnswers(record: ControllerInteractionRecord): ControllerQuestionAnswers {
    if (record.answer !== null && "kind" in record.answer && record.answer.kind === "user_answer") return record.answer.answers;
    return {};
  }

  private ownedPending(userId: string, chatId: string, controllerKey?: string): InteractionRow[] {
    return this.db.prepare(
      `SELECT interaction.* FROM controller_interactions AS interaction
        JOIN controller_turns AS turn ON turn.id = interaction.turn_id AND turn.state = 'submitted'
        JOIN controller_threads AS controller ON controller.controller_key = interaction.controller_key
          AND controller.state = 'active' AND controller.bb_thread_id = interaction.bb_thread_id
        JOIN controller_generations AS generation ON generation.id = interaction.controller_generation_id
          AND generation.controller_key = interaction.controller_key AND generation.thread_id = interaction.bb_thread_id
          AND generation.ended_at IS NULL
        JOIN owners ON owners.singleton = 1 AND owners.revoked_at IS NULL
          AND owners.telegram_user_id = controller.telegram_user_id AND owners.telegram_chat_id = controller.telegram_chat_id
       WHERE interaction.state = 'pending' AND controller.telegram_user_id = ? AND controller.telegram_chat_id = ?
         AND (? IS NULL OR interaction.controller_key = ?)
       ORDER BY interaction.asked_at ASC, interaction.interaction_id ASC`,
    ).all(userId, chatId, controllerKey ?? null, controllerKey ?? null) as InteractionRow[];
  }

  private promote(turnId: string, now: number): void {
    this.db.prepare(
      `UPDATE controller_turns SET awaiting_interaction_id = (
         SELECT interaction_id FROM controller_interactions
          WHERE turn_id = ? AND state IN (${interactionStates})
          ORDER BY asked_at ASC, interaction_id ASC LIMIT 1
       ), updated_at = ? WHERE id = ?`,
    ).run(turnId, now, turnId);
  }

  private validFence(input: ControllerLeaseFence): boolean {
    return isSafeIdentifier(input.ownerId) && Number.isSafeInteger(input.generation) && input.generation > 0 &&
      Number.isSafeInteger(input.now) && input.now >= 0;
  }

  private currentLease(input: ControllerLeaseFence): boolean {
    return this.db.prepare(
      "SELECT 1 FROM executor_lease WHERE singleton = 1 AND owner_id = ? AND generation = ? AND lease_expires_at > ?",
    ).get(input.ownerId, input.generation, input.now) !== undefined;
  }

  private activeSource(input: ControllerLeaseFence & { turnId: string; controllerKey: string; bbThreadId: string; controllerGenerationId: string }): boolean {
    return this.db.prepare(
      `SELECT 1 FROM executor_lease AS lease
        JOIN controller_turns AS turn ON turn.id = ? AND turn.controller_key = ? AND turn.state = 'submitted'
          AND turn.lease_owner = lease.owner_id AND turn.lease_generation = lease.generation
        JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
          AND controller.state = 'active' AND controller.bb_thread_id = ?
        JOIN controller_generations AS generation ON generation.id = ? AND generation.controller_key = turn.controller_key
          AND generation.thread_id = controller.bb_thread_id AND generation.ended_at IS NULL
       WHERE lease.singleton = 1 AND lease.owner_id = ? AND lease.generation = ? AND lease.lease_expires_at > ?
         AND (SELECT COUNT(*) FROM controller_generations AS open_generation
               WHERE open_generation.controller_key = turn.controller_key
                 AND open_generation.thread_id = controller.bb_thread_id
                 AND open_generation.ended_at IS NULL) = 1`,
    ).get(input.turnId, input.controllerKey, input.bbThreadId, input.controllerGenerationId,
      input.ownerId, input.generation, input.now) !== undefined;
  }

  private activeInteraction(input: ControllerLeaseFence & { interactionId: string; turnId: string; bbThreadId: string }): boolean {
    return this.db.prepare(
      `SELECT 1 FROM controller_interactions AS interaction
        JOIN controller_turns AS turn ON turn.id = interaction.turn_id AND turn.state = 'submitted'
        JOIN controller_threads AS controller ON controller.controller_key = interaction.controller_key
          AND controller.state = 'active' AND controller.bb_thread_id = interaction.bb_thread_id
        JOIN controller_generations AS generation ON generation.id = interaction.controller_generation_id
          AND generation.controller_key = interaction.controller_key AND generation.thread_id = interaction.bb_thread_id AND generation.ended_at IS NULL
       WHERE interaction.interaction_id = ? AND interaction.turn_id = ? AND interaction.bb_thread_id = ?
         AND turn.lease_owner = ? AND turn.lease_generation = ?
         AND (SELECT COUNT(*) FROM controller_generations AS open_generation
               WHERE open_generation.controller_key = interaction.controller_key
                 AND open_generation.thread_id = interaction.bb_thread_id
                 AND open_generation.ended_at IS NULL) = 1`,
    ).get(input.interactionId, input.turnId, input.bbThreadId, input.ownerId, input.generation) !== undefined;
  }

  private validStoredRow(interactionId: string): boolean {
    const row = this.db.prepare("SELECT * FROM controller_interactions WHERE interaction_id = ?").get(interactionId) as InteractionRow | undefined;
    return row !== undefined && parseRow(row) !== null;
  }
}
