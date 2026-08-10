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
export function renderQuestion(
  interactionId: string,
  question: ControllerQuestion,
  callbackPrefix = "q",
): RenderedQuestion {
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
        callback_data: `${callbackPrefix}:${questionOptionToken(interactionId, question.id, option.value)}`,
      }]),
    },
  };
}

/** What a worker thread is blocked on: a question, or a permission request. */
export type ThreadApprovalDecision = "allow_once" | "allow_for_session" | "deny";
export type ThreadInteraction =
  | { kind: "user_question"; interactionId: string; questions: ControllerQuestion[] }
  | { kind: "approval"; interactionId: string; summary: string; decisions: ThreadApprovalDecision[] };

const APPROVAL_LABELS: Record<ThreadApprovalDecision, string> = {
  allow_once: "Allow once",
  allow_for_session: "Allow all session",
  deny: "Deny",
};

function approvalSummary(subject: Record<string, unknown>): string | null {
  if (subject.kind === "command") {
    const command = boundedString(subject.command, MAX_PROMPT);
    if (!command) return null;
    const cwd = boundedString(subject.cwd, 120);
    return cwd ? `wants to run:\n\n\`${command}\`\n\nin ${cwd}` : `wants to run:\n\n\`${command}\``;
  }
  if (subject.kind === "file_change") {
    const scope = boundedString(subject.writeScope, 200);
    return scope ? `wants to write files under ${scope}` : "wants to write files";
  }
  return null;
}

/**
 * Reads whatever a thread is waiting on into something answerable from a phone.
 * An interaction the plugin cannot represent returns null: the owner is told the
 * thread is blocked rather than shown buttons that would resolve it wrongly.
 */
export function parseThreadInteraction(interactionId: unknown, payload: unknown): ThreadInteraction | null {
  if (typeof interactionId !== "string" || interactionId.length === 0) return null;
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as Record<string, unknown>;
  if (candidate.kind === "user_question") {
    const question = parsePendingQuestion(interactionId, payload);
    return question ? { kind: "user_question", interactionId, questions: question.questions } : null;
  }
  if (candidate.kind !== "approval") return null;
  const subject = candidate.subject;
  if (typeof subject !== "object" || subject === null) return null;
  const summary = approvalSummary(subject as Record<string, unknown>);
  if (!summary) return null;
  const offered = Array.isArray(candidate.decisions) ? candidate.decisions : Object.keys(APPROVAL_LABELS);
  const decisions = (Object.keys(APPROVAL_LABELS) as ThreadApprovalDecision[])
    .filter((decision) => offered.includes(decision));
  if (decisions.length === 0) return null;
  return { kind: "approval", interactionId, summary, decisions };
}

export function threadDecisionToken(interactionId: string, decision: string): string {
  return createHash("sha256")
    .update(`thread-interaction:${interactionId}:${decision}`, "utf8")
    .digest("base64url")
    .slice(0, 32);
}

/** The message that asks the owner to unblock a thread, with its buttons. */
export function renderThreadInteraction(title: string, interaction: ThreadInteraction): RenderedQuestion {
  if (interaction.kind === "user_question") {
    const first = interaction.questions[0];
    if (!first) throw new TypeError("a thread question must have a question");
    const rendered = renderQuestion(interaction.interactionId, first, "w");
    return { ...rendered, text: `*${title}* needs your answer.\n\n${rendered.text}` };
  }
  return {
    text: `*${title}* ${interaction.summary}`,
    reply_markup: {
      inline_keyboard: interaction.decisions.map((decision) => [{
        text: APPROVAL_LABELS[decision],
        callback_data: `w:${threadDecisionToken(interaction.interactionId, decision)}`,
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
