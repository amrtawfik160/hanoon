import { createHash } from "node:crypto";

/** One selectable answer to a question the controller thread asked. */
export type ControllerQuestionOption = {
  value: string;
  label: string;
  description: string | null;
};

export type ControllerQuestion = {
  id: string;
  prompt: string;
  shortLabel: string | null;
  multiSelect: boolean;
  allowFreeText: boolean;
  options: ControllerQuestionOption[];
};

/**
 * A BB interaction the controller thread is blocked on. BB renders these in its
 * own app; the owner only has Telegram, so the plugin has to carry both halves.
 */
export type ControllerPendingQuestion = {
  interactionId: string;
  questions: ControllerQuestion[];
};

export type ControllerQuestionAnswers = Record<string, { selected: string[]; freeText?: string }>;

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;
const MAX_PROMPT = 400;
const MAX_LABEL = 60;
const MAX_DESCRIPTION = 200;

function boundedString(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0) return null;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function parseOption(raw: unknown): ControllerQuestionOption | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  const value = typeof candidate.value === "string" ? candidate.value : null;
  const label = boundedString(candidate.label, MAX_LABEL);
  if (!value || !label) return null;
  return { value, label, description: boundedString(candidate.description, MAX_DESCRIPTION) };
}

function parseQuestion(raw: unknown): ControllerQuestion | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  const id = typeof candidate.id === "string" && candidate.id.length > 0 ? candidate.id : null;
  const prompt = boundedString(candidate.prompt, MAX_PROMPT);
  if (!id || !prompt) return null;
  const options = Array.isArray(candidate.options)
    ? candidate.options.slice(0, MAX_OPTIONS).map(parseOption).filter((option): option is ControllerQuestionOption => option !== null)
    : [];
  return {
    id,
    prompt,
    shortLabel: boundedString(candidate.shortLabel, MAX_LABEL),
    multiSelect: candidate.multiSelect === true,
    allowFreeText: candidate.allowFreeText !== false,
    options,
  };
}

/**
 * Reads the question out of a `system/userQuestion/lifecycle` payload. A
 * question with nothing answerable in it is not a question the owner can help
 * with, so it is treated as absent rather than parked on.
 */
export function parsePendingQuestion(interactionId: unknown, payload: unknown): ControllerPendingQuestion | null {
  if (typeof interactionId !== "string" || interactionId.length === 0) return null;
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as Record<string, unknown>;
  if (candidate.kind !== "user_question" || !Array.isArray(candidate.questions)) return null;
  const questions = candidate.questions
    .slice(0, MAX_QUESTIONS)
    .map(parseQuestion)
    .filter((question): question is ControllerQuestion => question !== null);
  if (questions.length === 0) return null;
  return { interactionId, questions };
}

/**
 * Telegram callback data is capped at 64 bytes, and BB option values alone run
 * past that, so buttons carry a digest of the option they stand for and the
 * option itself is recovered from the parked question.
 */
export function questionOptionToken(
  interactionId: string,
  questionId: string,
  optionValue: string,
): string {
  return createHash("sha256")
    .update(`controller-question:${interactionId}:${questionId}:${optionValue}`, "utf8")
    .digest("base64url")
    .slice(0, 32);
}

export type RenderedQuestion = {
  text: string;
  reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
};

/**
 * One question per message. Telegram gives a button no room to say which
 * question it belongs to, so asking them in sequence is what keeps a tap
 * unambiguous.
 */
export function renderQuestion(interactionId: string, question: ControllerQuestion): RenderedQuestion {
  const lines = [question.prompt];
  for (const option of question.options) {
    lines.push(option.description === null ? `• ${option.label}` : `• ${option.label} — ${option.description}`);
  }
  if (question.allowFreeText) lines.push("Or just reply with your own answer.");
  return {
    text: lines.join("\n\n"),
    reply_markup: {
      inline_keyboard: question.options.map((option) => [{
        text: option.label,
        callback_data: `q:${questionOptionToken(interactionId, question.id, option.value)}`,
      }]),
    },
  };
}

/** The next question still waiting on the owner, or null once all are settled. */
export function nextUnansweredQuestion(
  questions: readonly ControllerQuestion[],
  answers: ControllerQuestionAnswers,
): { question: ControllerQuestion; index: number } | null {
  const index = questions.findIndex((question) => !(question.id in answers));
  const question = questions[index];
  return question ? { question, index } : null;
}
