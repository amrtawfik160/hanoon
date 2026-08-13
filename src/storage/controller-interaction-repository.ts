import type Database from "better-sqlite3";
import type { ControllerLeaseFence } from "../controller/models";
import {
  canonicalControllerText,
  controllerInteractionToken,
  parseControllerInteraction,
  parseControllerInteractionResolution,
  nextUnansweredQuestion,
  questionOptionToken,
  type ControllerInteraction,
  type ControllerQuestionAnswers,
} from "../controller/questions";

type SqliteDatabase = Database.Database;

export type { ControllerInteraction };

export type ControllerInteractionAnswer =
  | {
    ok: true;
    complete: boolean;
    interactionId: string;
    turnId: string;
    controllerKey: string;
    resolution: Record<string, unknown>;
  }
  | { ok: false; reason: "stale" };

export type ControllerInteractionRecord = Readonly<{
  interactionId: string;
  turnId: string;
  controllerKey: string;
  bbThreadId: string;
  controllerGenerationId: string;
  interaction: ControllerInteraction;
  answers: ControllerQuestionAnswers;
  askedAt: number;
}>;

export type ControllerInteractionDelivery = ControllerInteractionRecord & Readonly<{
  resolution: Record<string, unknown>;
  answeredAt: number;
}>;

export type ControllerInteractionDeliveryFence = ControllerLeaseFence & Readonly<{
  interactionId: string;
  turnId: string;
  controllerKey: string;
  bbThreadId: string;
  controllerGenerationId: string;
}>;

export interface ControllerInteractionStore {
  isControllerInteractionDeliveryFenceCurrent(input: ControllerInteractionDeliveryFence): boolean;
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
  answerByToken(input: {
    token: string;
    userId: string;
    chatId: string;
    now: number;
  }): ControllerInteractionAnswer;
  answerWithText(input: {
    controllerKey: string;
    userId: string;
    chatId: string;
    text: string;
    now: number;
  }): ControllerInteractionAnswer;
  getPending(controllerKey: string): ControllerInteractionRecord | null;
  getAnswered(controllerKey: string): ControllerInteractionDelivery | null;
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
  kind: "user_question" | "approval" | "unsupported";
  payload_json: string;
  state: "pending" | "answered" | "delivered";
  answer_json: string | null;
  asked_at: number;
  answered_at: number | null;
};

type FencedTurn = {
  controller_key: string;
  bb_thread_id: string;
  controller_generation_id: string;
};

type FencedTurnQuery = Readonly<{
  turnId: string;
  controllerKey: string;
  bbThreadId: string;
  generationId: string;
}>;

const MAX_IDENTIFIER = 256;
const MAX_TOKEN = 128;
const MAX_TEXT = 4_000;
const MAX_APPROVAL_SUMMARY = 400;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;

function assertIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_IDENTIFIER) {
    throw new TypeError(`${field} must be between 1 and ${MAX_IDENTIFIER} characters`);
  }
}

function assertControllerKey(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError("controllerKey is invalid");
  }
}

function assertCanonicalPositiveDecimal(value: string, field: string): void {
  if (typeof value !== "string" || !POSITIVE_DECIMAL.test(value)) {
    throw new TypeError(`${field} must be a canonical positive decimal string`);
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer`);
}

function assertFence(input: ControllerLeaseFence): void {
  assertIdentifier(input.ownerId, "ownerId");
  assertNonNegativeInteger(input.generation, "generation");
  assertNonNegativeInteger(input.now, "now");
}

function parsePersistedInteraction(
  interactionId: string,
  kind: InteractionRow["kind"],
  payloadJson: string,
): ControllerInteraction | null {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson) as unknown;
  } catch {
    // Corrupt persisted projections are not safe to present or resolve.
    return null;
  }
  if (kind === "user_question") {
    const parsed = parseControllerInteraction(interactionId, payload);
    return parsed?.kind === "user_question" || parsed?.kind === "unsupported" ? parsed : null;
  }
  if (kind === "unsupported") return { kind: "unsupported", interactionId };
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as Record<string, unknown>;
  const summary = canonicalControllerText(candidate.summary, MAX_APPROVAL_SUMMARY);
  if (candidate.kind !== "approval" || !summary || summary !== candidate.summary) return null;
  if (!Array.isArray(candidate.decisions)) return null;
  const decisions = candidate.decisions;
  if (decisions.length === 0 || decisions.some((decision) => decision !== "allow_once" && decision !== "deny") ||
    new Set(decisions).size !== decisions.length) return null;
  return {
    kind: "approval",
    interactionId,
    summary,
    decisions: decisions as ("allow_once" | "deny")[],
  };
}

function parseAnswer(
  interaction: ControllerInteraction,
  row: InteractionRow,
): Record<string, unknown> | null {
  if (row.answer_json === null) return null;
  try {
    const parsed = JSON.parse(row.answer_json) as unknown;
    return parseControllerInteractionResolution(interaction, parsed, row.state === "answered" ? "answered" : "pending");
  } catch {
    // A corrupt answer cannot be retried against BB safely.
    return null;
  }
}

function parseStoredRow(row: InteractionRow): ControllerInteractionRecord | null {
  if (row.bb_thread_id === null || row.controller_generation_id === null) return null;
  const interaction = parsePersistedInteraction(row.interaction_id, row.kind, row.payload_json);
  if (!interaction) return null;
  const resolution = row.answer_json === null ? null : parseAnswer(interaction, row);
  if (row.answer_json !== null && !resolution) return null;
  return {
    interactionId: row.interaction_id,
    turnId: row.turn_id,
    controllerKey: row.controller_key,
    bbThreadId: row.bb_thread_id,
    controllerGenerationId: row.controller_generation_id,
    interaction,
    answers: interaction.kind === "user_question" && resolution?.kind === "user_answer"
      ? resolution.answers as ControllerQuestionAnswers
      : {},
    askedAt: row.asked_at,
  };
}

type MatchedOwnerAnswer = Readonly<{
  resolution: Record<string, unknown>;
  questionId: string | null;
}>;

function answerForInteraction(
  interaction: ControllerInteraction,
  answers: ControllerQuestionAnswers,
  token: string,
): MatchedOwnerAnswer | null {
  if (interaction.kind === "unsupported") return null;
  if (interaction.kind === "approval") {
    for (const decision of interaction.decisions) {
      if (controllerInteractionToken(interaction.interactionId, decision) !== token) continue;
      return {
        questionId: null,
        resolution: decision === "allow_once"
          ? { decision, grantedPermissions: null }
          : { decision },
      };
    }
    return null;
  }
  for (const question of interaction.questions) {
    if (Object.hasOwn(answers, question.id)) continue;
    for (const option of question.options) {
      if (questionOptionToken(interaction.interactionId, question.id, option.value) !== token) continue;
      return {
        questionId: question.id,
        resolution: { kind: "user_answer", answers: { [question.id]: { selected: [option.value] } } },
      };
    }
  }
  return null;
}

function textAnswer(
  interaction: ControllerInteraction,
  answers: ControllerQuestionAnswers,
  text: string,
): MatchedOwnerAnswer | null {
  if (interaction.kind !== "user_question") return null;
  const next = nextUnansweredQuestion(interaction.questions, answers);
  if (!next || !next.question.allowFreeText) return null;
  const safeText = canonicalControllerText(text, MAX_TEXT);
  if (!safeText) return null;
  return {
    questionId: next.question.id,
    resolution: {
      kind: "user_answer",
      answers: { [next.question.id]: { selected: [], freeText: safeText } },
    },
  };
}

function mergedOwnerResolution(
  interaction: ControllerInteraction,
  existingAnswers: ControllerQuestionAnswers,
  matched: MatchedOwnerAnswer,
): { resolution: Record<string, unknown>; complete: boolean } {
  if (interaction.kind !== "user_question" || matched.questionId === null) {
    return { resolution: matched.resolution, complete: true };
  }
  const incoming = matched.resolution.answers;
  const answers = {
    ...existingAnswers,
    ...(typeof incoming === "object" && incoming !== null ? incoming : {}),
  } as ControllerQuestionAnswers;
  return {
    resolution: { kind: "user_answer", answers },
    complete: nextUnansweredQuestion(interaction.questions, answers) === null,
  };
}

export class ControllerInteractionRepository implements ControllerInteractionStore {
  public constructor(private readonly db: SqliteDatabase) {}

  public isExecutorLeaseCurrent(ownerId: string, generation: number, now: number): boolean {
    const input = { ownerId, generation, now };
    assertFence(input);
    return this.executorFenceIsCurrent(input);
  }

  public isControllerInteractionDeliveryFenceCurrent(input: ControllerInteractionDeliveryFence): boolean {
    assertFence(input);
    assertIdentifier(input.interactionId, "interactionId");
    assertIdentifier(input.turnId, "turnId");
    assertControllerKey(input.controllerKey);
    assertIdentifier(input.bbThreadId, "bbThreadId");
    assertIdentifier(input.controllerGenerationId, "controllerGenerationId");
    return this.db.prepare(
      `SELECT 1
         FROM controller_interactions AS interaction
         JOIN controller_turns AS turn
           ON turn.id = interaction.turn_id
          AND turn.id = ?
          AND turn.controller_key = ?
          AND turn.state = 'submitted'
          AND turn.awaiting_interaction_id = interaction.interaction_id
          AND turn.lease_owner = ?
          AND turn.lease_generation = ?
         JOIN executor_lease AS lease
           ON lease.singleton = 1
          AND lease.owner_id = ?
          AND lease.generation = ?
          AND lease.lease_expires_at IS NOT NULL
          AND lease.lease_expires_at > ?
         JOIN controller_threads AS controller
           ON controller.controller_key = interaction.controller_key
          AND controller.controller_key = ?
          AND controller.state = 'active'
          AND controller.bb_thread_id = ?
         JOIN controller_generations AS generation
           ON generation.id = interaction.controller_generation_id
          AND generation.id = ?
          AND generation.controller_key = controller.controller_key
          AND generation.thread_id = controller.bb_thread_id
          AND generation.ended_at IS NULL
        WHERE interaction.interaction_id = ?
          AND interaction.turn_id = ?
          AND interaction.controller_key = ?
          AND interaction.bb_thread_id = ?
          AND interaction.controller_generation_id = ?
          AND interaction.state = 'answered'
          AND interaction.answer_json IS NOT NULL
          AND interaction.answered_at IS NOT NULL
          AND (SELECT COUNT(*) FROM controller_generations AS open_generation
                 WHERE open_generation.controller_key = controller.controller_key
                   AND open_generation.ended_at IS NULL) = 1`,
    ).get(
      input.turnId,
      input.controllerKey,
      input.ownerId,
      input.generation,
      input.ownerId,
      input.generation,
      input.now,
      input.controllerKey,
      input.bbThreadId,
      input.controllerGenerationId,
      input.interactionId,
      input.turnId,
      input.controllerKey,
      input.bbThreadId,
      input.controllerGenerationId,
    ) !== undefined;
  }

  public record(input: ControllerLeaseFence & {
    turnId: string;
    controllerKey: string;
    bbThreadId: string;
    controllerGenerationId: string;
    interaction: ControllerInteraction;
  }): boolean {
    assertFence(input);
    assertIdentifier(input.turnId, "turnId");
    assertControllerKey(input.controllerKey);
    assertIdentifier(input.bbThreadId, "bbThreadId");
    assertIdentifier(input.controllerGenerationId, "controllerGenerationId");
    assertIdentifier(input.interaction.interactionId, "interactionId");
    const interaction = this.validateInteraction(input.interaction);
    return this.db.transaction((): boolean => {
      const turn = this.fencedTurn(input, {
        turnId: input.turnId,
        controllerKey: input.controllerKey,
        bbThreadId: input.bbThreadId,
        generationId: input.controllerGenerationId,
      });
      if (!turn) return false;
      const existing = this.db.prepare(
        "SELECT interaction_id FROM controller_interactions WHERE interaction_id = ?",
      ).get(interaction.interactionId);
      if (existing) return false;
      this.db.prepare(
        `INSERT INTO controller_interactions (
           interaction_id, turn_id, controller_key, bb_thread_id, controller_generation_id,
           kind, payload_json, state, answer_json, asked_at, answered_at, delivered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, NULL)`,
      ).run(
        interaction.interactionId,
        input.turnId,
        turn.controller_key,
        turn.bb_thread_id,
        turn.controller_generation_id,
        interaction.kind,
        JSON.stringify(interaction),
        input.now,
      );
      this.refreshAwaitingPointer(input.turnId, input.now);
      return true;
    }).immediate();
  }

  public markResolved(input: ControllerLeaseFence & {
    interactionId: string;
    turnId: string;
    bbThreadId: string;
  }): boolean {
    return this.settleExecutorInteraction(input, ["pending", "answered"]);
  }

  public markDelivered(input: ControllerLeaseFence & {
    interactionId: string;
    turnId: string;
    bbThreadId: string;
  }): boolean {
    return this.settleExecutorInteraction(input, ["answered"]);
  }

  public answerByToken(input: {
    token: string;
    userId: string;
    chatId: string;
    now: number;
  }): ControllerInteractionAnswer {
    assertIdentifier(input.token, "token");
    if (input.token.length > MAX_TOKEN) throw new TypeError("token is too long");
    assertCanonicalPositiveDecimal(input.userId, "userId");
    assertCanonicalPositiveDecimal(input.chatId, "chatId");
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): ControllerInteractionAnswer => {
      const row = this.pendingOwnerRow(input.userId, input.chatId);
      if (!row) return { ok: false, reason: "stale" };
      const stored = parseStoredRow(row);
      if (!stored) return { ok: false, reason: "stale" };
      const matched = answerForInteraction(stored.interaction, stored.answers, input.token);
      if (!matched) return { ok: false, reason: "stale" };
      return this.persistOwnerAnswer(row, stored, matched, input.now);
    }).immediate();
  }

  public answerWithText(input: {
    controllerKey: string;
    userId: string;
    chatId: string;
    text: string;
    now: number;
  }): ControllerInteractionAnswer {
    assertControllerKey(input.controllerKey);
    assertCanonicalPositiveDecimal(input.userId, "userId");
    assertCanonicalPositiveDecimal(input.chatId, "chatId");
    if (typeof input.text !== "string" || input.text.trim().length === 0 || input.text.length > MAX_TEXT) {
      throw new TypeError("text must be between 1 and 4000 characters");
    }
    if (!canonicalControllerText(input.text, MAX_TEXT)) return { ok: false, reason: "stale" };
    assertNonNegativeInteger(input.now, "now");
    return this.db.transaction((): ControllerInteractionAnswer => {
      const row = this.db.prepare(
        `SELECT interaction.*
           FROM controller_interactions AS interaction
           JOIN controller_turns AS turn ON turn.id = interaction.turn_id AND turn.state = 'submitted'
           JOIN controller_threads AS controller
             ON controller.controller_key = interaction.controller_key
            AND controller.state = 'active'
           JOIN owners
             ON owners.singleton = 1 AND owners.revoked_at IS NULL
            AND owners.telegram_user_id = controller.telegram_user_id
            AND owners.telegram_chat_id = controller.telegram_chat_id
        JOIN controller_generations AS generation
             ON generation.id = interaction.controller_generation_id
            AND generation.controller_key = controller.controller_key
            AND generation.thread_id = controller.bb_thread_id
            AND generation.ended_at IS NULL
          WHERE interaction.controller_key = ?
            AND turn.controller_key = interaction.controller_key
            AND interaction.state = 'pending'
            AND interaction.kind = 'user_question'
            AND controller.telegram_user_id = ?
            AND controller.telegram_chat_id = ?
            AND turn.awaiting_interaction_id = interaction.interaction_id
            AND interaction.bb_thread_id = controller.bb_thread_id
            AND (SELECT COUNT(*) FROM controller_generations AS open_generation
                  WHERE open_generation.controller_key = controller.controller_key
                    AND open_generation.ended_at IS NULL) = 1
          ORDER BY interaction.asked_at ASC, interaction.interaction_id ASC
          LIMIT 1`,
      ).get(input.controllerKey, input.userId, input.chatId) as InteractionRow | undefined;
      if (!row) return { ok: false, reason: "stale" };
      const stored = parseStoredRow(row);
      if (!stored) return { ok: false, reason: "stale" };
      const matched = textAnswer(stored.interaction, stored.answers, input.text);
      if (!matched) return { ok: false, reason: "stale" };
      return this.persistOwnerAnswer(row, stored, matched, input.now);
    }).immediate();
  }

  public getPending(controllerKey: string): ControllerInteractionRecord | null {
    assertControllerKey(controllerKey);
    const row = this.currentInteractionRow(controllerKey, "pending");
    return row ? parseStoredRow(row) : null;
  }

  public getAnswered(controllerKey: string): ControllerInteractionDelivery | null {
    assertControllerKey(controllerKey);
    const row = this.currentInteractionRow(controllerKey, "answered");
    if (!row || row.answer_json === null || row.answered_at === null) return null;
    const stored = parseStoredRow(row);
    const resolution = stored ? parseAnswer(stored.interaction, row) : null;
    if (!stored || !resolution) return null;
    return { ...stored, resolution, answeredAt: row.answered_at };
  }

  private validateInteraction(interaction: ControllerInteraction): ControllerInteraction {
    const payload = JSON.stringify(interaction);
    if (payload.length > 16_384) throw new TypeError("controller interaction is too large");
    const parsed = parsePersistedInteraction(interaction.interactionId, interaction.kind, payload);
    if (!parsed) throw new TypeError("controller interaction is not a safe projection");
    return parsed;
  }

  private executorFenceIsCurrent(input: ControllerLeaseFence): boolean {
    return this.db.prepare(
      `SELECT 1 FROM executor_lease
        WHERE singleton = 1 AND owner_id = ? AND generation = ?
          AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
    ).get(input.ownerId, input.generation, input.now) !== undefined;
  }

  private fencedTurn(
    input: ControllerLeaseFence,
    query: FencedTurnQuery,
  ): FencedTurn | undefined {
    return this.db.prepare(
      `SELECT controller.controller_key, controller.bb_thread_id,
              generation.id AS controller_generation_id
         FROM controller_turns AS turn
         JOIN executor_lease AS lease
           ON lease.singleton = 1
          AND lease.owner_id = ?
          AND lease.generation = ?
          AND lease.lease_expires_at IS NOT NULL
          AND lease.lease_expires_at > ?
         JOIN controller_threads AS controller
           ON controller.controller_key = turn.controller_key
          AND controller.state = 'active'
          AND controller.bb_thread_id = ?
         JOIN controller_generations AS generation
           ON generation.id = ?
          AND generation.controller_key = controller.controller_key
          AND generation.thread_id = controller.bb_thread_id
          AND generation.ended_at IS NULL
        WHERE turn.id = ? AND turn.controller_key = ? AND turn.state = 'submitted'
          AND turn.lease_owner = ? AND turn.lease_generation = ?
          AND (SELECT COUNT(*) FROM controller_generations AS open_generation
                WHERE open_generation.controller_key = controller.controller_key
                  AND open_generation.ended_at IS NULL) = 1`,
    ).get(
      input.ownerId,
      input.generation,
      input.now,
      query.bbThreadId,
      query.generationId,
      query.turnId,
      query.controllerKey,
      input.ownerId,
      input.generation,
    ) as FencedTurn | undefined;
  }

  private currentInteractionRow(
    controllerKey: string,
    state: "pending" | "answered",
  ): InteractionRow | undefined {
    return this.db.prepare(
      `SELECT interaction.*
         FROM controller_interactions AS interaction
         JOIN controller_turns AS turn
           ON turn.id = interaction.turn_id
          AND turn.state = 'submitted'
          AND turn.controller_key = interaction.controller_key
         JOIN controller_threads AS controller
           ON controller.controller_key = interaction.controller_key
          AND controller.state = 'active'
         JOIN controller_generations AS generation
           ON generation.id = interaction.controller_generation_id
          AND generation.controller_key = controller.controller_key
          AND generation.thread_id = controller.bb_thread_id
          AND generation.ended_at IS NULL
        WHERE interaction.controller_key = ? AND interaction.state = ?
          AND turn.awaiting_interaction_id = interaction.interaction_id
          AND interaction.bb_thread_id = controller.bb_thread_id
          AND (SELECT COUNT(*) FROM controller_generations AS open_generation
                WHERE open_generation.controller_key = controller.controller_key
                  AND open_generation.ended_at IS NULL) = 1
        ORDER BY interaction.asked_at ASC, interaction.interaction_id ASC
        LIMIT 1`,
    ).get(controllerKey, state) as InteractionRow | undefined;
  }

  private pendingOwnerRow(userId: string, chatId: string): InteractionRow | undefined {
    return this.db.prepare(
      `SELECT interaction.*
         FROM controller_interactions AS interaction
         JOIN controller_turns AS turn
           ON turn.id = interaction.turn_id
          AND turn.state = 'submitted'
          AND turn.controller_key = interaction.controller_key
         JOIN controller_threads AS controller
           ON controller.controller_key = interaction.controller_key
          AND controller.state = 'active'
         JOIN owners
           ON owners.singleton = 1 AND owners.revoked_at IS NULL
          AND owners.telegram_user_id = controller.telegram_user_id
          AND owners.telegram_chat_id = controller.telegram_chat_id
         JOIN controller_generations AS generation
           ON generation.id = interaction.controller_generation_id
          AND generation.controller_key = controller.controller_key
          AND generation.thread_id = controller.bb_thread_id
          AND generation.ended_at IS NULL
        WHERE interaction.state = 'pending'
          AND controller.telegram_user_id = ? AND controller.telegram_chat_id = ?
          AND turn.awaiting_interaction_id = interaction.interaction_id
          AND interaction.bb_thread_id = controller.bb_thread_id
          AND (SELECT COUNT(*) FROM controller_generations AS open_generation
                WHERE open_generation.controller_key = controller.controller_key
                  AND open_generation.ended_at IS NULL) = 1
        ORDER BY interaction.asked_at ASC, interaction.interaction_id ASC
        LIMIT 1`,
    ).get(userId, chatId) as InteractionRow | undefined;
  }

  private persistOwnerAnswer(
    row: InteractionRow,
    stored: ControllerInteractionRecord,
    matched: MatchedOwnerAnswer,
    now: number,
  ): ControllerInteractionAnswer {
    const settled = mergedOwnerResolution(stored.interaction, stored.answers, matched);
    const resolution = parseControllerInteractionResolution(stored.interaction, settled.resolution, "pending");
    if (!resolution) return { ok: false, reason: "stale" };
    const updated = this.db.prepare(
      `UPDATE controller_interactions
          SET state = ?, answer_json = ?, answered_at = ?
        WHERE interaction_id = ? AND turn_id = ? AND controller_key = ? AND state = 'pending'`,
    ).run(
      settled.complete ? "answered" : "pending",
      JSON.stringify(resolution),
      settled.complete ? now : null,
      row.interaction_id,
      stored.turnId,
      stored.controllerKey,
    );
    return updated.changes === 1
      ? {
        ok: true,
        complete: settled.complete,
        interactionId: stored.interactionId,
        turnId: stored.turnId,
        controllerKey: stored.controllerKey,
        resolution,
      }
      : { ok: false, reason: "stale" };
  }

  private settleExecutorInteraction(
    input: ControllerLeaseFence & { interactionId: string; turnId: string; bbThreadId: string },
    states: readonly ("pending" | "answered")[],
  ): boolean {
    assertFence(input);
    assertIdentifier(input.interactionId, "interactionId");
    assertIdentifier(input.turnId, "turnId");
    assertIdentifier(input.bbThreadId, "bbThreadId");
    const statePlaceholders = states.map(() => "?").join(", ");
    return this.db.transaction((): boolean => {
      const row = this.db.prepare(
        `SELECT interaction.* FROM controller_interactions AS interaction
          WHERE interaction.interaction_id = ? AND interaction.turn_id = ?
            AND interaction.bb_thread_id = ?
            AND interaction.state IN (${statePlaceholders})`,
      ).get(input.interactionId, input.turnId, input.bbThreadId, ...states) as InteractionRow | undefined;
      if (!row || row.controller_generation_id === null) return false;
      const turn = this.fencedTurn(input, {
        turnId: input.turnId,
        controllerKey: row.controller_key,
        bbThreadId: input.bbThreadId,
        generationId: row.controller_generation_id,
      });
      if (!turn) return false;
      this.beforeExecutorInteractionTransition();
      if (states.length === 1 && states[0] === "answered" && !this.isControllerInteractionDeliveryFenceCurrent({
        ...input,
        controllerKey: turn.controller_key,
        controllerGenerationId: turn.controller_generation_id,
      })) return false;
      const updated = this.db.prepare(
        `UPDATE controller_interactions
            SET state = 'delivered', delivered_at = ?
          WHERE interaction_id = ? AND turn_id = ? AND controller_key = ?
            AND bb_thread_id = ? AND controller_generation_id = ?
            AND state IN (${statePlaceholders})
            AND EXISTS (
              SELECT 1 FROM executor_lease AS lease
               WHERE lease.singleton = 1
                 AND lease.owner_id = ? AND lease.generation = ?
                 AND lease.lease_expires_at IS NOT NULL
                 AND lease.lease_expires_at > ?
            )
            AND EXISTS (
              SELECT 1 FROM controller_turns AS submitted_turn
               WHERE submitted_turn.id = ?
                 AND submitted_turn.controller_key = ?
                 AND submitted_turn.state = 'submitted'
                 AND submitted_turn.lease_owner = ?
                 AND submitted_turn.lease_generation = ?
            )`,
      ).run(
        input.now,
        input.interactionId,
        input.turnId,
        turn.controller_key,
        turn.bb_thread_id,
        turn.controller_generation_id,
        ...states,
        input.ownerId,
        input.generation,
        input.now,
        input.turnId,
        turn.controller_key,
        input.ownerId,
        input.generation,
      );
      if (updated.changes !== 1) return false;
      this.refreshAwaitingPointer(input.turnId, input.now, input.interactionId);
      return true;
    }).immediate();
  }

  protected beforeExecutorInteractionTransition(): void {}

  private refreshAwaitingPointer(turnId: string, now: number, deliveredInteractionId?: string): void {
    const pointer = this.db.prepare(
      "SELECT awaiting_interaction_id FROM controller_turns WHERE id = ?",
    ).get(turnId) as { awaiting_interaction_id: string | null } | undefined;
    if (!pointer) return;
    if (deliveredInteractionId !== undefined && pointer.awaiting_interaction_id !== deliveredInteractionId) return;
    const next = this.db.prepare(
      `SELECT interaction_id FROM controller_interactions
        WHERE turn_id = ? AND state IN ('pending', 'answered')
        ORDER BY asked_at ASC, interaction_id ASC LIMIT 1`,
    ).get(turnId) as { interaction_id: string } | undefined;
    this.db.prepare(
      "UPDATE controller_turns SET awaiting_interaction_id = ?, updated_at = ? WHERE id = ?",
    ).run(next?.interaction_id ?? null, now, turnId);
  }
}
