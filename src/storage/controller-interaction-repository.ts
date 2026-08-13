import type Database from "better-sqlite3";
import {
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

function isSafeIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 200;
}

function parseRow(row: InteractionRow): ControllerInteractionRecord {
  const interaction = JSON.parse(row.payload_json) as ControllerInteraction;
  const answer = row.answer_json === null ? null : JSON.parse(row.answer_json) as ControllerInteractionResolution;
  return {
    interactionId: row.interaction_id,
    turnId: row.turn_id,
    controllerKey: row.controller_key,
    bbThreadId: row.bb_thread_id,
    controllerGenerationId: row.controller_generation_id,
    interaction,
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
      !isSafeIdentifier(input.interaction.interactionId)) return false;
    return this.db.transaction((): boolean => {
      if (!this.currentLease(input)) return false;
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
      if (!this.currentLease(input) || !this.activeInteraction(input)) return false;
      const changed = this.db.prepare(
        `UPDATE controller_interactions SET state = 'delivered', delivered_at = ?
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
    if (record.bbThreadId === null || record.controllerGenerationId === null || record.answer === null) return null;
    return record as ControllerInteractionDelivery;
  }

  public markDelivered(input: ControllerLeaseFence & { interactionId: string; turnId: string; bbThreadId: string }): boolean {
    if (!this.validFence(input) || !isSafeIdentifier(input.interactionId) || !isSafeIdentifier(input.turnId) || !isSafeIdentifier(input.bbThreadId)) return false;
    return this.db.transaction(() => {
      if (!this.currentLease(input) || !this.activeInteraction(input)) return false;
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
       WHERE lease.singleton = 1 AND lease.owner_id = ? AND lease.generation = ? AND lease.lease_expires_at > ?`,
    ).get(input.interactionId, input.turnId, input.bbThreadId, input.ownerId, input.generation, input.now) !== undefined).immediate();
  }

  /** Read-only fence for a lifecycle ref before it has a durable interaction row. */
  public sourceCanRecord(input: ControllerLeaseFence & { turnId: string; controllerKey: string; bbThreadId: string; controllerGenerationId: string }): boolean {
    if (!this.validFence(input)) return false;
    return this.db.transaction(() => this.activeSource(input) && this.currentLease(input)).immediate();
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
      `SELECT 1 FROM controller_turns AS turn
        JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key AND controller.bb_thread_id = ?
        JOIN controller_generations AS generation ON generation.id = ? AND generation.controller_key = turn.controller_key
          AND generation.thread_id = controller.bb_thread_id AND generation.ended_at IS NULL
       WHERE turn.id = ? AND turn.controller_key = ? AND turn.state = 'submitted'
         AND turn.lease_owner = ? AND turn.lease_generation = ?`,
    ).get(input.bbThreadId, input.controllerGenerationId, input.turnId, input.controllerKey, input.ownerId, input.generation) !== undefined;
  }

  private activeInteraction(input: ControllerLeaseFence & { interactionId: string; turnId: string; bbThreadId: string }): boolean {
    return this.db.prepare(
      `SELECT 1 FROM controller_interactions AS interaction
        JOIN controller_turns AS turn ON turn.id = interaction.turn_id AND turn.state = 'submitted'
        JOIN controller_threads AS controller ON controller.controller_key = interaction.controller_key AND controller.bb_thread_id = interaction.bb_thread_id
        JOIN controller_generations AS generation ON generation.id = interaction.controller_generation_id
          AND generation.controller_key = interaction.controller_key AND generation.thread_id = interaction.bb_thread_id AND generation.ended_at IS NULL
       WHERE interaction.interaction_id = ? AND interaction.turn_id = ? AND interaction.bb_thread_id = ?
         AND turn.lease_owner = ? AND turn.lease_generation = ?`,
    ).get(input.interactionId, input.turnId, input.bbThreadId, input.ownerId, input.generation) !== undefined;
  }
}
