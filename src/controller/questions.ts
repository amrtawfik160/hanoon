import { createHash } from "node:crypto";
import { isSensitiveApprovalPathName, isUnsafeProviderText } from "./credential-policy";

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
const MAX_INTERACTION_ID = 200;
const MAX_QUESTION_ID = 120;
const MAX_OPTION_VALUE = 120;

/**
 * Every bounded string in this module comes from the provider, so the credential
 * screen belongs here rather than at each call site: a field that cannot be
 * shown safely is simply absent, and the callers already know what to do with an
 * absent field.
 */
function boundedString(rawText: unknown, limit: number, byteLimit = limit * 4): string | null {
  if (typeof rawText !== "string") return null;
  const text = rawText.trim();
  if (text.length === 0) return null;
  if (isUnsafeProviderText(text)) return null;
  const characters = [...text];
  if (characters.length <= limit && Buffer.byteLength(text, "utf8") <= byteLimit) return text;
  const kept: string[] = [];
  for (const character of characters) {
    if (kept.length >= limit - 1 || Buffer.byteLength(`${kept.join("")}${character}…`, "utf8") > byteLimit) break;
    kept.push(character);
  }
  return kept.length > 0 ? `${kept.join("")}…` : null;
}

function boundedIdentifier(rawIdentifier: unknown, characterLimit: number): rawIdentifier is string {
  return typeof rawIdentifier === "string" && rawIdentifier.length > 0 &&
    [...rawIdentifier].length <= characterLimit && Buffer.byteLength(rawIdentifier, "utf8") <= characterLimit * 4;
}

export function isSafeControllerInteractionId(rawIdentifier: unknown): rawIdentifier is string {
  return boundedIdentifier(rawIdentifier, MAX_INTERACTION_ID);
}

function parseOption(raw: unknown): ControllerQuestionOption | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  const value = typeof candidate.value === "string" && [...candidate.value].length > 0 &&
    [...candidate.value].length <= MAX_OPTION_VALUE && Buffer.byteLength(candidate.value, "utf8") <= MAX_OPTION_VALUE * 4 &&
    !isUnsafeProviderText(candidate.value) ? candidate.value : null;
  const label = boundedString(candidate.label, MAX_LABEL, 64);
  if (!value || !label) return null;
  return { value, label, description: boundedString(candidate.description, MAX_DESCRIPTION) };
}

function unsafeRawString(value: unknown): boolean {
  return typeof value === "string" && isUnsafeProviderText(value);
}

/**
 * True when any field of a question payload carries credential or callback
 * material. A provider emitting a secret in one field is not a provider whose
 * other fields should be rendered anyway, so this screens the whole payload and
 * the callers downgrade all of it rather than quietly dropping the bad field.
 */
function questionPayloadIsUnsafe(candidate: Record<string, unknown>): boolean {
  const questions = Array.isArray(candidate.questions) ? candidate.questions : [];
  return questions.some((rawQuestion) => {
    if (typeof rawQuestion !== "object" || rawQuestion === null) return false;
    const question = rawQuestion as Record<string, unknown>;
    if ([question.id, question.prompt, question.shortLabel].some(unsafeRawString)) return true;
    const options = Array.isArray(question.options) ? question.options : [];
    return options.some((rawOption) => {
      if (typeof rawOption !== "object" || rawOption === null) return false;
      const option = rawOption as Record<string, unknown>;
      return [option.value, option.label, option.description].some(unsafeRawString);
    });
  });
}

function parseQuestion(raw: unknown): ControllerQuestion | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  const id = boundedIdentifier(candidate.id, MAX_QUESTION_ID) ? candidate.id : null;
  const prompt = boundedString(candidate.prompt, MAX_PROMPT);
  if (!id || !prompt) return null;
  const options = Array.isArray(candidate.options)
    ? candidate.options.slice(0, MAX_OPTIONS).map(parseOption).filter((option): option is ControllerQuestionOption => option !== null)
    : [];
  return {
    id,
    prompt,
    shortLabel: boundedString(candidate.shortLabel, MAX_LABEL, 64),
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
  if (!isSafeControllerInteractionId(interactionId)) return null;
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

const TELEGRAM_TEXT_BYTES = 4_096;

function boundedTelegramText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= TELEGRAM_TEXT_BYTES) return text;
  const ellipsis = "…";
  const kept: string[] = [];
  let usedBytes = Buffer.byteLength(ellipsis, "utf8");
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + characterBytes > TELEGRAM_TEXT_BYTES) break;
    kept.push(character);
    usedBytes += characterBytes;
  }
  return `${kept.join("")}${ellipsis}`;
}

function interactionCallback(prefix: string, interactionId: string, questionId: string, optionValue: string): string {
  const safePrefix = /^[A-Za-z0-9_-]{1,30}$/.test(prefix) ? prefix : "q";
  return `${safePrefix}:${questionOptionToken(interactionId, questionId, optionValue)}`;
}

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
    text: boundedTelegramText(lines.join("\n\n")),
    reply_markup: {
      inline_keyboard: question.options.map((option) => [{
        text: boundedString(option.label, MAX_LABEL, 64) ?? "Option",
        callback_data: interactionCallback(callbackPrefix, interactionId, question.id, option.value),
      }]),
    },
  };
}

/** The callback prefix every hidden-controller interaction button carries. */
export const CONTROLLER_INTERACTION_CALLBACK_PREFIX = "i";

/** What a worker thread is blocked on: a question, or a permission request. */
export type ThreadApprovalDecision = "allow_once" | "allow_for_session" | "deny";
export type ThreadInteraction =
  | { kind: "user_question"; interactionId: string; questions: ControllerQuestion[] }
  | { kind: "approval"; interactionId: string; summary: string; decisions: ThreadApprovalDecision[] }
  /** A block the plugin can name but not answer, so the owner still hears about it. */
  | { kind: "unsupported"; interactionId: string };

/** The safe, durable projection of an interaction from a hidden controller. */
export type ControllerInteraction =
  | { kind: "user_question"; interactionId: string; questions: ControllerQuestion[] }
  | { kind: "approval"; interactionId: string; summary: string; decisions: Extract<ThreadApprovalDecision, "allow_once" | "deny">[] }
  | { kind: "unsupported"; interactionId: string; metadata: { sourceKind: string | null } };

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

function containsApprovalSecret(commandText: string): boolean {
  if (isUnsafeProviderText(commandText)) return true;
  let decoded = commandText;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!decoded.includes("%")) break;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return true;
    }
  }
  if (decoded.includes("%")) return true;
  if (isUnsafeProviderText(decoded)) return true;
  return /\b(?:bearer|authorization|token|secret|password|api[_-]?key|callback(?:[-_ ]?(?:url|nonce|code))?)\b/i.test(decoded) ||
    /[?&](?:token|secret|key|callback|nonce|code)=[^&\s]+/i.test(decoded) ||
    /\b[a-z_][a-z0-9_]*=[^\s]+/i.test(decoded) ||
    /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%/.test(decoded) ||
    /(?:env|environment)\b/i.test(decoded);
}

export function isSafeControllerApprovalSummary(summary: unknown): summary is string {
  if (typeof summary !== "string" || Buffer.byteLength(summary, "utf8") > 4_000) return false;
  // The projection no longer produces a redacted placeholder — an approval it
  // cannot state becomes unsupported — so a stored row carrying one is a row
  // this build could not have written and is not accepted back.
  if (summary === "wants to run:\n\n`a redacted command`" || summary === "wants to write a protected path") {
    return false;
  }
  const command = /^wants to run:\n\n`([^`]*)`$/.exec(summary)?.[1];
  if (command !== undefined) return command.length > 0 && [...command].length <= MAX_PROMPT && !containsApprovalSecret(command);
  const basename = /^wants to write ([A-Za-z0-9][A-Za-z0-9._-]{0,119})$/.exec(summary)?.[1];
  return basename !== undefined && !isSensitiveApprovalPathName(basename) && !isUnsafeProviderText(basename);
}

function safeApprovalPath(rawPath: unknown): string | null {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.length > 240 || rawPath.startsWith("/") ||
    /^[A-Za-z]:/.test(rawPath) || rawPath === "~" || rawPath.startsWith("~/") || rawPath.includes("\\") ||
    rawPath.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  const basename = rawPath.split("/").at(-1)!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(basename)) return null;
  // A file whose name is a secret by convention, or whose name is itself shaped
  // like a token, is not made safe by being a well-formed name. The token shape
  // comes from the same central screen the command path uses, so the two cannot
  // drift apart.
  return isSensitiveApprovalPathName(basename) || isUnsafeProviderText(basename) ? null : basename;
}

/**
 * The bounded approval the owner may act on, or null when there is no safe way
 * to describe it. Null is deliberate rather than a redacted placeholder: a
 * button that says "Allow once" beside text the owner cannot read is a decision
 * made blind, so an approval the plugin cannot state becomes an unsupported
 * interaction with no provider text and no buttons at all.
 */
function controllerApprovalSummary(subject: unknown): string | null {
  if (typeof subject !== "object" || subject === null) return null;
  const candidate = subject as Record<string, unknown>;
  if (candidate.kind === "command" && typeof candidate.command === "string") {
    if (containsApprovalSecret(candidate.command) || candidate.command.includes("`") ||
      candidate.command.length === 0 || candidate.command.length > MAX_PROMPT) return null;
    return `wants to run:\n\n\`${candidate.command}\``;
  }
  if (candidate.kind === "file_change") {
    const path = safeApprovalPath(candidate.writeScope);
    return path === null ? null : `wants to write ${path}`;
  }
  return null;
}

/**
 * Projects an exact BB interaction into the bounded data the hidden Telegram
 * controller may retain. Lifecycle payloads are deliberately not accepted here.
 */
export function parseControllerInteraction(interactionId: unknown, payload: unknown): ControllerInteraction | null {
  if (!isSafeControllerInteractionId(interactionId) ||
    typeof payload !== "object" || payload === null) return null;
  const candidate = payload as Record<string, unknown>;
  if (candidate.kind === "user_question") {
    if (questionPayloadIsUnsafe(candidate)) {
      return { kind: "unsupported", interactionId, metadata: { sourceKind: "user_question" } };
    }
    if (!Array.isArray(candidate.questions) || candidate.questions.length === 0 || candidate.questions.length > MAX_QUESTIONS ||
      candidate.questions.some((rawQuestion) => {
        if (typeof rawQuestion !== "object" || rawQuestion === null) return true;
        const rawCandidate = rawQuestion as Record<string, unknown>;
        const options = rawCandidate.options;
        return typeof rawCandidate.multiSelect !== "boolean" || typeof rawCandidate.allowFreeText !== "boolean" ||
          options !== undefined && (!Array.isArray(options) || options.length > MAX_OPTIONS || options.some((option) => parseOption(option) === null));
      })) return { kind: "unsupported", interactionId, metadata: { sourceKind: "user_question" } };
    const pending = parsePendingQuestion(interactionId, payload);
    // A question with no option and no free text cannot be answered from a
    // phone. Saying so is the honest projection; keeping it as a question would
    // park the turn on a message the owner can never settle.
    return pending && new Set(pending.questions.map((question) => question.id)).size === pending.questions.length &&
      pending.questions.every((question) => question.allowFreeText || question.options.length > 0)
      ? { kind: "user_question", interactionId, questions: pending.questions }
      : { kind: "unsupported", interactionId, metadata: { sourceKind: "user_question" } };
  }
  if (candidate.kind === "approval") {
    const summary = controllerApprovalSummary(candidate.subject);
    const availableDecisions = Array.isArray(candidate.availableDecisions) ? candidate.availableDecisions : null;
    if (availableDecisions === null || availableDecisions.some((decision) =>
      decision !== "allow_once" && decision !== "allow_for_session" && decision !== "deny")) {
      return { kind: "unsupported", interactionId, metadata: { sourceKind: "approval" } };
    }
    const decisions = availableDecisions !== null
      ? (["allow_once", "deny"] as const).filter((decision) => availableDecisions.includes(decision))
      : [];
    return summary && decisions.length > 0
      ? { kind: "approval", interactionId, summary, decisions: [...decisions] }
      : { kind: "unsupported", interactionId, metadata: { sourceKind: "approval" } };
  }
  const sourceKind = typeof candidate.kind === "string" && /^[a-z_]{1,40}$/.test(candidate.kind)
    ? candidate.kind
    : null;
  return { kind: "unsupported", interactionId, metadata: { sourceKind } };
}

/**
 * The hidden controller offers a one-off decision only. A session-wide grant
 * would outlive the turn the owner actually looked at, so it is not rendered
 * here even when BB offers it.
 */
const CONTROLLER_APPROVAL_LABELS: Record<Extract<ThreadApprovalDecision, "allow_once" | "deny">, string> = {
  allow_once: "Allow once",
  deny: "Deny",
};

const UNSUPPORTED_CONTROLLER_INTERACTION_TEXT =
  "Hanoon is waiting on something I can't answer from here. It needs you in BB.";

export type RenderedControllerInteraction = {
  /** Which question of a sequence this message asks; 0 for a single message. */
  step: number;
  text: string;
  reply_markup?: RenderedQuestion["reply_markup"];
};

/**
 * The one Telegram message a durable controller interaction is currently
 * waiting on, or null once a question sequence has been answered through.
 */
export function renderControllerInteraction(
  interaction: ControllerInteraction,
  answers: ControllerQuestionAnswers = {},
): RenderedControllerInteraction | null {
  if (interaction.kind === "user_question") {
    const next = nextUnansweredQuestion(interaction.questions, answers);
    if (!next) return null;
    return {
      step: next.index,
      ...renderQuestion(interaction.interactionId, next.question, CONTROLLER_INTERACTION_CALLBACK_PREFIX),
    };
  }
  if (interaction.kind === "approval") {
    return {
      step: 0,
      text: boundedTelegramText(`Hanoon ${interaction.summary}`),
      reply_markup: {
        inline_keyboard: interaction.decisions.map((decision) => [{
          text: CONTROLLER_APPROVAL_LABELS[decision],
          callback_data: `${CONTROLLER_INTERACTION_CALLBACK_PREFIX}:${threadDecisionToken(interaction.interactionId, decision)}`,
        }]),
      },
    };
  }
  return { step: 0, text: UNSUPPORTED_CONTROLLER_INTERACTION_TEXT };
}

/**
 * Reads whatever a thread is waiting on into something answerable from a phone.
 * A block the plugin cannot represent still comes back as `unsupported` rather
 * than null: guessing at buttons would resolve it wrongly, but saying nothing
 * leaves the thread waiting on an owner who was never told.
 */
export function parseThreadInteraction(interactionId: unknown, payload: unknown): ThreadInteraction | null {
  if (typeof interactionId !== "string" || interactionId.length === 0) return null;
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as Record<string, unknown>;
  if (candidate.kind === "user_question") {
    if (questionPayloadIsUnsafe(candidate)) return { kind: "unsupported", interactionId };
    const question = parsePendingQuestion(interactionId, payload);
    return question
      ? { kind: "user_question", interactionId, questions: question.questions }
      : { kind: "unsupported", interactionId };
  }
  if (candidate.kind !== "approval") return { kind: "unsupported", interactionId };
  const subject = candidate.subject;
  const summary = typeof subject === "object" && subject !== null
    ? approvalSummary(subject as Record<string, unknown>)
    : null;
  const offered = Array.isArray(candidate.decisions) ? candidate.decisions : Object.keys(APPROVAL_LABELS);
  const decisions = (Object.keys(APPROVAL_LABELS) as ThreadApprovalDecision[])
    .filter((decision) => offered.includes(decision));
  if (!summary || decisions.length === 0) return { kind: "unsupported", interactionId };
  return { kind: "approval", interactionId, summary, decisions };
}

export function threadDecisionToken(interactionId: string, decision: string): string {
  return createHash("sha256")
    .update(`thread-interaction:${interactionId}:${decision}`, "utf8")
    .digest("base64url")
    .slice(0, 32);
}

/** The message that asks the owner to unblock a thread, with its buttons. */
export function renderThreadInteraction(
  title: string,
  interaction: ThreadInteraction,
): RenderedQuestion | { text: string } {
  if (interaction.kind === "unsupported") {
    return { text: `*${title}* is waiting on something I can't answer from here. It needs you in BB.` };
  }
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
