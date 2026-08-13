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

export type ControllerApprovalDecision = "allow_once" | "deny";
export type ControllerInteraction =
  | { kind: "user_question"; interactionId: string; questions: ControllerQuestion[] }
  | { kind: "approval"; interactionId: string; summary: string; decisions: ControllerApprovalDecision[] }
  | { kind: "unsupported"; interactionId: string };

export type ControllerQuestionAnswers = Record<string, { selected: string[]; freeText?: string }>;

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;
const MAX_PROMPT = 400;
const MAX_LABEL = 60;
const MAX_DESCRIPTION = 200;
const MAX_CONTROLLER_TEXT = 4_000;
const MAX_CANONICAL_SCAN = 16_384;
const MAX_PERCENT_DECODE_LAYERS = 3;

const CREDENTIAL_QUERY_KEY = [
  "access[_-]?token",
  "refresh[_-]?token",
  "id[_-]?token",
  "client[_-]?secret",
  "api[_-]?key",
  "authorization",
  "auth(?:[_-]?(?:token|key))?",
  "session(?:[_-]?token)?",
  "private(?:[_-]?key)?",
  "credentials?",
  "password",
  "passwd",
  "secret",
  "token",
  "key",
  "jwt",
  "signature",
  "sig",
].join("|");

const SENSITIVE_CONTROLLER_TEXT_PATTERNS = [
  /m:[A-Za-z0-9_-]{32}/u,
  /\bbearer\s+\S+/iu,
  new RegExp(`\\b(?:${CREDENTIAL_QUERY_KEY}|credential)\\s*[:=]\\s*(?:"[^"]*"|'[^']*'|\\S+)`, "iu"),
  /\b(?:access|refresh|id)\s+token|\bclient\s+secret|\bapi\s+key|\bauth(?:orization)?\s+(?:token|key)|\bsession\s+token|\bprivate\s+key/iu,
  /\b(?:authorization|auth|session|private\s+key|credentials?|password|passwd|secret|token|key|jwt|signature|sig)\b\s+(?:is\s+)?\S+/iu,
  /(?:^|[^A-Za-z0-9_])(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;|&]*)/u,
  /(?:^|[\s"'`])(?:export\s+)?[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|KEY|AUTH)[A-Z0-9_]*\s*=\s*\S+/iu,
  new RegExp(`(?:^|[\\s;|&"'])(?:export\\s+)?(?:${CREDENTIAL_QUERY_KEY})\\s*=\\s*(?:"[^"]*"|'[^']*'|\\S+)`, "iu"),
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
  /(?:gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|(?:sk|rk)-[A-Za-z0-9_-]{16,})/u,
  /\d{8,10}:[A-Za-z0-9_-]{35}/u,
  /(?:https?|wss?):\/\/[^\s/@]+:[^\s/@]+@/iu,
  new RegExp(`(?:https?|wss?):\\/\\/[^\\s]*[?&](?:${CREDENTIAL_QUERY_KEY})(?:=|%3d)`, "iu"),
  /(?:callback|webhook)/iu,
  /\b(?:curl|wget|httpie)\b[^\n]*(?:https?|wss?):\/\//iu,
];

const PROTECTED_BASENAME_MARKERS = [
  ".env",
  "credential",
  "secret",
  "private",
  "shadow",
  "passwd",
  "password",
  "token",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "id_x25519",
  "id_xmss",
  "ssh_host_",
  "known_hosts",
  "authorized_keys",
  "certificate",
  "cert",
  ".pem",
  ".p12",
  ".pfx",
  ".crt",
  ".cer",
  ".der",
  ".pub",
  ".key",
];

function decodeCanonicalForm(value: string): string | null {
  if (/%(?![0-9a-f]{2})/iu.test(value)) return null;
  try {
    const decoded = decodeURIComponent(value).normalize("NFKC").trim();
    return decoded.length > 0 && decoded.length <= MAX_CANONICAL_SCAN ? decoded : null;
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

function canonicalForms(value: string): string[] | null {
  let current = value.normalize("NFKC").trim();
  if (current.length === 0 || current.length > MAX_CANONICAL_SCAN) return null;
  const forms = [current];
  for (let layer = 0; layer < MAX_PERCENT_DECODE_LAYERS && current.includes("%"); layer += 1) {
    const decoded = decodeCanonicalForm(current);
    if (!decoded) return null;
    forms.push(decoded);
    if (decoded === current) break;
    current = decoded;
  }
  return current.includes("%") ? null : [...new Set(forms)];
}

function hasProtectedBasename(value: string): boolean {
  const basename = value.replaceAll("\\", "/").split("/").filter(Boolean).at(-1);
  if (!basename) return true;
  const normalized = basename.toLowerCase();
  return PROTECTED_BASENAME_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * Canonicalizes bounded controller text and scans every decoded form before
 * clipping. A null result is never safe to persist or present.
 */
export function canonicalControllerText(
  value: unknown,
  limit: number,
  mode: "text" | "path" = "text",
): string | null {
  if (typeof value !== "string") return null;
  const forms = canonicalForms(value);
  if (!forms) return null;
  if (mode === "path" && forms.some(hasProtectedBasename)) return null;
  if (forms.some((form) => SENSITIVE_CONTROLLER_TEXT_PATTERNS.some((pattern) => pattern.test(form)))) {
    return null;
  }
  const canonical = forms.at(-1);
  if (!canonical) return null;
  return canonical.length <= limit ? canonical : `${canonical.slice(0, limit - 1)}…`;
}

function boundedIdentity(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || normalized.length > limit) return null;
  return canonicalControllerText(normalized, limit);
}

function boundedString(value: unknown, limit: number): string | null {
  return canonicalControllerText(value, limit);
}

function parseOption(raw: unknown): ControllerQuestionOption | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (!Object.hasOwn(candidate, "value") || !Object.hasOwn(candidate, "label")) return null;
  const value = boundedIdentity(candidate.value, 256);
  const label = boundedString(candidate.label, MAX_LABEL);
  if (!value || !label) return null;
  const hasDescription = Object.hasOwn(candidate, "description");
  const description = !hasDescription || candidate.description === null
    ? null
    : boundedString(candidate.description, MAX_DESCRIPTION);
  if (hasDescription && candidate.description !== null && !description) return null;
  return { value, label, description };
}

function parseQuestionOptions(raw: unknown): ControllerQuestionOption[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_OPTIONS) return null;
  const options = raw.map(parseOption);
  if (options.some((option) => option === null)) return null;
  const parsedOptions = options.filter((option): option is ControllerQuestionOption => option !== null);
  return new Set(parsedOptions.map((option) => option.value)).size === parsedOptions.length ? parsedOptions : null;
}

function parseQuestionFlags(candidate: Record<string, unknown>): { multiSelect: boolean; allowFreeText: boolean } | null {
  const hasMultiSelect = Object.hasOwn(candidate, "multiSelect");
  const hasFreeText = Object.hasOwn(candidate, "allowFreeText");
  if (hasMultiSelect && typeof candidate.multiSelect !== "boolean") return null;
  if (hasFreeText && typeof candidate.allowFreeText !== "boolean") return null;
  return {
    multiSelect: hasMultiSelect && candidate.multiSelect === true,
    allowFreeText: !hasFreeText || candidate.allowFreeText !== false,
  };
}

function parseQuestionShortLabel(candidate: Record<string, unknown>): string | null {
  if (!Object.hasOwn(candidate, "shortLabel") || candidate.shortLabel === null) return null;
  return boundedString(candidate.shortLabel, MAX_LABEL);
}

function parseQuestion(raw: unknown): ControllerQuestion | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (!Object.hasOwn(candidate, "id") || !Object.hasOwn(candidate, "prompt") || !Object.hasOwn(candidate, "options")) return null;
  const id = boundedIdentity(candidate.id, 128);
  const prompt = boundedString(candidate.prompt, MAX_PROMPT);
  if (!id || RESERVED_QUESTION_IDS.has(id) || !prompt) return null;
  const flags = parseQuestionFlags(candidate);
  if (!flags) return null;
  const options = parseQuestionOptions(candidate.options);
  if (!options) return null;
  const shortLabel = parseQuestionShortLabel(candidate);
  if (Object.hasOwn(candidate, "shortLabel") && candidate.shortLabel !== null && !shortLabel) return null;
  return {
    id,
    prompt,
    shortLabel,
    multiSelect: flags.multiSelect,
    allowFreeText: flags.allowFreeText,
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
  if (!Object.hasOwn(candidate, "kind") || candidate.kind !== "user_question" ||
    !Object.hasOwn(candidate, "questions") || !Array.isArray(candidate.questions)) return null;
  if (candidate.questions.length > MAX_QUESTIONS) return null;
  const questions = candidate.questions.map(parseQuestion);
  if (questions.some((question) => question === null)) return null;
  const parsedQuestions = questions.filter((question): question is ControllerQuestion => question !== null);
  if (parsedQuestions.length === 0 || new Set(parsedQuestions.map((question) => question.id)).size !== parsedQuestions.length) {
    return null;
  }
  return { interactionId, questions: parsedQuestions };
}

const CONTROLLER_APPROVAL_DECISIONS: readonly ControllerApprovalDecision[] = ["allow_once", "deny"];
const MAX_CONTROLLER_INTERACTION_ID = 256;
const MAX_CONTROLLER_APPROVAL_SUMMARY = 400;
const MAX_CONTROLLER_QUESTION_ID = 128;
const MAX_CONTROLLER_OPTION_VALUE = 256;
const PROTECTED_PATH_TEXT = "a protected path";
const RESERVED_QUESTION_IDS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

function safePathBasename(value: unknown): string {
  const canonical = canonicalControllerText(value, 80, "path");
  if (!canonical) return PROTECTED_PATH_TEXT;
  const normalized = canonical.replaceAll("\\", "/").trim();
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  const basename = segments.at(-1);
  if (!basename || basename === "." || basename === ".." || segments.includes("..")) return PROTECTED_PATH_TEXT;
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(basename)) return PROTECTED_PATH_TEXT;
  return basename;
}

function boundedApprovalSummary(summary: string): string {
  return summary.length <= MAX_CONTROLLER_APPROVAL_SUMMARY
    ? summary
    : `${summary.slice(0, MAX_CONTROLLER_APPROVAL_SUMMARY - 1)}…`;
}

function controllerApprovalSummary(subject: Record<string, unknown>): string | null {
  if (subject.kind === "command") {
    const rawCommand = typeof subject.command === "string" ? subject.command.trim() : "";
    if (rawCommand.length === 0) return null;
    const command = canonicalControllerText(rawCommand, MAX_PROMPT) ?? "a redacted command";
    if (!command) return null;
    const cwd = typeof subject.cwd === "string" && subject.cwd.trim().length > 0
      ? safePathBasename(subject.cwd)
      : null;
    return boundedApprovalSummary(cwd
      ? `wants to run:\n\n\`${command}\`\n\nin ${cwd}`
      : `wants to run:\n\n\`${command}\``);
  }
  if (subject.kind === "file_change") {
    const rawScope = subject.writeScope;
    if (rawScope === null || rawScope === undefined || rawScope === "") return "wants to write files";
    return boundedApprovalSummary(`wants to write files under ${safePathBasename(rawScope)}`);
  }
  return null;
}

function controllerApprovalDecisions(candidate: Record<string, unknown>): ControllerApprovalDecision[] | null {
  const offered = Object.hasOwn(candidate, "availableDecisions") && Array.isArray(candidate.availableDecisions)
    ? candidate.availableDecisions
    : Object.hasOwn(candidate, "decisions") && Array.isArray(candidate.decisions) ? candidate.decisions : null;
  if (!offered) return null;
  const decisions = CONTROLLER_APPROVAL_DECISIONS.filter((decision) => offered.includes(decision));
  return decisions.length > 0 ? [...decisions] : null;
}

function parseControllerQuestionProjection(interactionId: string, payload: unknown): ControllerInteraction {
  const question = parsePendingQuestion(interactionId, payload);
  const bounded = question?.questions.every((item) =>
    item.id.length <= MAX_CONTROLLER_QUESTION_ID &&
    item.options.every((option) => option.value.length <= MAX_CONTROLLER_OPTION_VALUE),
  );
  return question && bounded
    ? { kind: "user_question", interactionId, questions: question.questions }
    : { kind: "unsupported", interactionId };
}

function parseControllerApprovalProjection(
  interactionId: string,
  candidate: Record<string, unknown>,
): ControllerInteraction {
  const subject = candidate.subject;
  const summary = typeof subject === "object" && subject !== null
    ? controllerApprovalSummary(subject as Record<string, unknown>)
    : null;
  const decisions = controllerApprovalDecisions(candidate);
  return summary && decisions
    ? { kind: "approval", interactionId, summary, decisions }
    : { kind: "unsupported", interactionId };
}

/**
 * Parses the exact BB interaction payload into the smaller projection that is
 * safe to persist and present outside BB.
 */
export function parseControllerInteraction(
  interactionId: unknown,
  payload: unknown,
): ControllerInteraction | null {
  if (
    typeof interactionId !== "string" ||
    interactionId.length === 0 ||
    interactionId.length > MAX_CONTROLLER_INTERACTION_ID
  ) return null;
  if (typeof payload !== "object" || payload === null) return { kind: "unsupported", interactionId };
  const candidate = payload as Record<string, unknown>;
  if (!Object.hasOwn(candidate, "kind")) return { kind: "unsupported", interactionId };
  if (candidate.kind === "user_question") return parseControllerQuestionProjection(interactionId, payload);
  if (candidate.kind !== "approval") return { kind: "unsupported", interactionId };
  return parseControllerApprovalProjection(interactionId, candidate);
}

function strictAnswerText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || normalized.length > MAX_CONTROLLER_TEXT) return null;
  return canonicalControllerText(normalized, MAX_CONTROLLER_TEXT);
}

function parseSelectedOptions(
  question: ControllerQuestion,
  selectedValue: unknown,
): string[] | null {
  if (!Array.isArray(selectedValue) || selectedValue.some((option) => typeof option !== "string")) return null;
  const selected = selectedValue as string[];
  if (!question.multiSelect && selected.length > 1) return null;
  if (new Set(selected).size !== selected.length) return null;
  return selected.every((option) => question.options.some((candidate) => candidate.value === option))
    ? [...selected]
    : null;
}

function parseQuestionAnswer(
  question: ControllerQuestion,
  rawAnswer: unknown,
): ControllerQuestionAnswers[string] | null {
  if (typeof rawAnswer !== "object" || rawAnswer === null || Array.isArray(rawAnswer)) return null;
  const candidate = rawAnswer as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.some((key) => key !== "selected" && key !== "freeText") || !Object.hasOwn(candidate, "selected")) return null;
  const selected = parseSelectedOptions(question, candidate.selected);
  if (!selected) return null;
  const parsed: ControllerQuestionAnswers[string] = { selected };
  if (!Object.hasOwn(candidate, "freeText")) return parsed;
  if (!question.allowFreeText) return null;
  const freeText = strictAnswerText(candidate.freeText);
  return freeText ? { ...parsed, freeText } : null;
}

function parseControllerQuestionAnswers(
  value: unknown,
  questions: readonly ControllerQuestion[],
  state: "pending" | "answered",
): ControllerQuestionAnswers | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const questionIds = questions.map((question) => question.id);
  if (new Set(questionIds).size !== questionIds.length ||
    questionIds.some((questionId) => RESERVED_QUESTION_IDS.has(questionId))) return null;
  const answerIds = Object.keys(candidate);
  if (state === "answered" && (answerIds.length !== questionIds.length ||
    questionIds.some((questionId) => !Object.hasOwn(candidate, questionId)))) return null;
  const byId = new Map(questions.map((question) => [question.id, question]));
  const answers: ControllerQuestionAnswers = {};
  for (const [questionId, rawAnswer] of Object.entries(candidate)) {
    const question = byId.get(questionId);
    const parsed = question ? parseQuestionAnswer(question, rawAnswer) : null;
    if (!parsed) return null;
    answers[questionId] = parsed;
  }
  return answers;
}

function parseApprovalResolution(
  interaction: Extract<ControllerInteraction, { kind: "approval" }>,
  value: unknown,
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.hasOwn(candidate, "decision") && candidate.decision === "allow_once" && Object.keys(candidate).length === 2 &&
    Object.hasOwn(candidate, "grantedPermissions") && candidate.grantedPermissions === null &&
    interaction.decisions.includes("allow_once")) {
    return { decision: "allow_once", grantedPermissions: null };
  }
  if (Object.hasOwn(candidate, "decision") && candidate.decision === "deny" && Object.keys(candidate).length === 1 &&
    interaction.decisions.includes("deny")) {
    return { decision: "deny" };
  }
  return null;
}

function parseQuestionResolution(
  interaction: Extract<ControllerInteraction, { kind: "user_question" }>,
  value: unknown,
  state: "pending" | "answered",
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const answerMap = Object.hasOwn(candidate, "kind") && candidate.kind === "user_answer"
    ? Object.keys(candidate).length === 2 && Object.hasOwn(candidate, "answers") ? candidate.answers : null
    : value;
  const answers = parseControllerQuestionAnswers(answerMap, interaction.questions, state);
  return answers ? { kind: "user_answer", answers } : null;
}

/** Validates the exact durable resolution envelope against one stored interaction. */
export function parseControllerInteractionResolution(
  interaction: ControllerInteraction,
  value: unknown,
  state: "pending" | "answered" = "pending",
): Record<string, unknown> | null {
  if (interaction.kind === "approval") return parseApprovalResolution(interaction, value);
  if (interaction.kind === "user_question") return parseQuestionResolution(interaction, value, state);
  return null;
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

/** A callback-sized token derived from one exact generic controller choice. */
export function controllerInteractionToken(interactionId: string, ...choice: string[]): string {
  return createHash("sha256")
    .update(`controller-interaction:${interactionId}:${choice.join(":")}`, "utf8")
    .digest("base64url")
    .slice(0, 32);
}

export type RenderedQuestion = {
  text: string;
  reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
};

export type ControllerQuestionCallbackPrefix = "i" | "w";

/**
 * One question per message. Telegram gives a button no room to say which
 * question it belongs to, so asking them in sequence is what keeps a tap
 * unambiguous.
 */
export function renderQuestion(
  interactionId: string,
  question: ControllerQuestion,
  callbackPrefix: ControllerQuestionCallbackPrefix,
): RenderedQuestion {
  if (callbackPrefix !== "i" && callbackPrefix !== "w") {
    throw new TypeError("controller question callback prefix is invalid");
  }
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

export type RenderedControllerInteraction = RenderedQuestion | { text: string };

const CONTROLLER_APPROVAL_LABELS: Record<ControllerApprovalDecision, string> = {
  allow_once: "Allow once",
  deny: "Deny",
};

function renderControllerQuestion(
  interaction: Extract<ControllerInteraction, { kind: "user_question" }>,
  answers: ControllerQuestionAnswers,
): RenderedQuestion {
  const next = nextUnansweredQuestion(interaction.questions, answers);
  if (!next) throw new TypeError("controller interaction has no unanswered question");
  const rendered = renderQuestion(interaction.interactionId, next.question, "i");
  return { ...rendered, text: `The controller needs your answer.\n\n${rendered.text}` };
}

function renderControllerApproval(
  interaction: Extract<ControllerInteraction, { kind: "approval" }>,
): RenderedQuestion {
  return {
    text: `The controller ${interaction.summary}`,
    reply_markup: {
      inline_keyboard: interaction.decisions.map((decision) => [{
        text: CONTROLLER_APPROVAL_LABELS[decision],
        callback_data: `i:${controllerInteractionToken(interaction.interactionId, decision)}`,
      }]),
    },
  };
}

export function renderControllerInteraction(
  interaction: ControllerInteraction,
  answers: ControllerQuestionAnswers = {},
): RenderedControllerInteraction {
  if (interaction.kind === "unsupported") {
    return { text: "The controller is waiting on an interaction this Telegram bridge cannot answer." };
  }
  return interaction.kind === "user_question"
    ? renderControllerQuestion(interaction, answers)
    : renderControllerApproval(interaction);
}

/** What a worker thread is blocked on: a question, or a permission request. */
export type ThreadApprovalDecision = "allow_once" | "allow_for_session" | "deny";
export type ThreadInteraction =
  | { kind: "user_question"; interactionId: string; questions: ControllerQuestion[] }
  | { kind: "approval"; interactionId: string; summary: string; decisions: ThreadApprovalDecision[] }
  /** A block the plugin can name but not answer, so the owner still hears about it. */
  | { kind: "unsupported"; interactionId: string };

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
 * A block the plugin cannot represent still comes back as `unsupported` rather
 * than null: guessing at buttons would resolve it wrongly, but saying nothing
 * leaves the thread waiting on an owner who was never told.
 */
export function parseThreadInteraction(interactionId: unknown, payload: unknown): ThreadInteraction | null {
  if (typeof interactionId !== "string" || interactionId.length === 0) return null;
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as Record<string, unknown>;
  if (candidate.kind === "user_question") {
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
  const index = questions.findIndex((question) => !Object.hasOwn(answers, question.id));
  const question = questions[index];
  return question ? { question, index } : null;
}
