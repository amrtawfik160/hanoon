import { ANSWER_CLAUSE_ANCHORS } from "./answer-anchors.js";

export type AnswerClauseId =
  | "outcome-first"
  | "no-tool-narration"
  | "no-invented-progress"
  | "bounded-uncertainty"
  | "no-dead-end-referral"
  | "not-process-only";

export type AnswerClause = Readonly<{
  id: AnswerClauseId;
  question: string;
}>;

export const ANSWER_RUBRIC_VERSION = "answer-contract-hybrid-v1" as const;

export const ANSWER_JUDGE_PROFILE = Object.freeze({
  provider: "codex",
  model: "gpt-5.6-sol",
  reasoningLevel: "max",
  serviceTier: "fast",
  permissionMode: "auto",
  visibility: "hidden",
} as const);

export const ANSWER_CLAUSES: readonly AnswerClause[] = Object.freeze([
  Object.freeze({
    id: "outcome-first",
    question: "Does the answer lead with the outcome in its first sentence, rather than preamble, restating the question, or describing what it is about to do?",
  }),
  Object.freeze({
    id: "no-tool-narration",
    question: "Is the answer free of tool and mechanism narration — no mention of which tools were called, of BB internals, of what the agent 'can' or 'cannot' determine, and no 'based on the available data' hedging?",
  }),
  Object.freeze({
    id: "no-invented-progress",
    question: "Does the answer avoid unsupported completion percentages and forecasts of time-to-completion? Observed timestamps, elapsed durations, retry counts, attempt counts, event counts, error text, and ordinary status facts are outside this clause and must not be failed merely because they cannot be verified.",
  }),
  Object.freeze({
    id: "bounded-uncertainty",
    question: "Is any uncertainty confined to a short clause rather than a disclaimer paragraph?",
  }),
  Object.freeze({
    id: "no-dead-end-referral",
    question: "Does the answer avoid explicitly delegating a routine BB app/UI/tool operation to the owner (open/click/navigate/stop/restart/run it themselves)? It holds when the reply says the worker should take an action, recommends a next step, or suggests telling the worker what to do.",
  }),
  Object.freeze({
    id: "not-process-only",
    question: "Is this a finished answer rather than only a statement of intent to go and investigate?",
  }),
]);

export const ANSWER_CLAUSE_IDS: readonly AnswerClauseId[] = Object.freeze(
  ANSWER_CLAUSES.map((clause) => clause.id),
);

export type AnswerJudgeSpawnInput = Readonly<{
  project: string;
  title: string;
  prompt: string;
}>;

export function buildAnswerJudgeSpawnArgs(input: AnswerJudgeSpawnInput): string[] {
  return [
    "thread", "spawn",
    "--project", input.project,
    "--provider", ANSWER_JUDGE_PROFILE.provider,
    "--model", ANSWER_JUDGE_PROFILE.model,
    "--reasoning-level", ANSWER_JUDGE_PROFILE.reasoningLevel,
    "--service-tier", ANSWER_JUDGE_PROFILE.serviceTier,
    "--permission-mode", ANSWER_JUDGE_PROFILE.permissionMode,
    "--visibility", ANSWER_JUDGE_PROFILE.visibility,
    "--title", input.title,
    "--prompt", input.prompt,
    "--json",
  ];
}

export type ClauseVerdict = Readonly<{
  id: AnswerClauseId;
  holds: boolean;
  why: string;
}>;

export type ClauseAssessment = Readonly<{
  id: AnswerClauseId;
  holds: boolean;
  source: "deterministic" | "model";
  reason: string;
  judgeThreadId: string | null;
  rubricVersion: typeof ANSWER_RUBRIC_VERSION;
  judgeProfile: typeof ANSWER_JUDGE_PROFILE;
}>;

export function buildClauseAssessment(input: {
  clauseId: AnswerClauseId;
  holds: boolean;
  source: "deterministic" | "model";
  reason: string;
  judgeThreadId: string | null;
}): ClauseAssessment {
  return {
    id: input.clauseId,
    holds: input.holds,
    source: input.source,
    reason: input.reason,
    judgeThreadId: input.judgeThreadId,
    rubricVersion: ANSWER_RUBRIC_VERSION,
    judgeProfile: ANSWER_JUDGE_PROFILE,
  };
}

export function buildClauseJudgePrompt(input: {
  clauseId: AnswerClauseId;
  ownerMessage: string;
  answer: string;
}): string {
  const clause = ANSWER_CLAUSES.find((candidate) => candidate.id === input.clauseId);
  const anchors = ANSWER_CLAUSE_ANCHORS[input.clauseId];
  if (!clause || !anchors) throw new Error(`missing answer rubric clause ${input.clauseId}`);

  return `You are grading one assistant reply over Telegram. Rubric version ${ANSWER_RUBRIC_VERSION}. Judge only clause id "${clause.id}". You cannot see the systems described, so never grade factual correctness or whether the news is good or bad.

Operational definition:
${anchors.definition}

Positive anchor (holds):
"""
${anchors.positive}
"""

Negative anchor (fails):
"""
${anchors.negative}
"""

Owner asked:
"""
${input.ownerMessage}
"""

Assistant replied:
"""
${input.answer}
"""

Compare the reply only with this clause and its operational definition. Do not infer a failure from any other answer-quality rule. The anchors are illustrative examples, not facts about the reply.

Reply with exactly one strict JSON object and nothing else — no prose, no Markdown fence:

{"id":"${clause.id}","holds":true,"why":"one short reason"}

"holds" is true when the reply satisfies this one clause.`;
}

export function detectExplicitClauseViolation(
  clauseId: AnswerClauseId,
  answer: string,
): string | null {
  const normalized = answer.replace(/\s+/g, " ").trim();
  switch (clauseId) {
    case "no-dead-end-referral":
      if (
        /\b(?:you(?:'ll| will| need to| have to| should| must)|please)\b[^.!?]{0,220}\b(?:open|use|go to|navigate|click|stop|restart|run|perform)\b[^.!?]{0,220}\b(?:bb app|thread panel|yourself|manually|on your own)\b/i.test(normalized)
      ) return "Explicitly transfers a routine BB action to the owner.";
      return null;
    case "no-tool-narration":
      if (
        /\b(?:called|used|invoked)\s+[a-z0-9_.-]+/i.test(normalized)
        || /\b(?:tool|tools|bb internals|based on (?:the )?(?:available )?data|(?:bb|platform|system) (?:doesn't|does not) expose|can(?:not|'t) determine)\b/i.test(normalized)
      ) return "Explicitly narrates tools, mechanisms, or unavailable capabilities.";
      return null;
    case "no-invented-progress":
      if (
        /\b\d+(?:\.\d+)?\s*%/i.test(normalized)
        || /\bETA\b/i.test(normalized)
        || /\b(?:should|expected to|will) finish\b/i.test(normalized)
        || /\b(?:in|within)\s+\d+\s+(?:seconds?|minutes?|hours?|days?)\b/i.test(normalized)
      ) return "Explicitly invents progress or a completion time.";
      return null;
    case "not-process-only":
      if (/^\s*(?:let me|i(?:'ll| will)|give me)\b[^.!?]{0,180}\b(?:look|check|investigate|review|find out|get back|report back)\b/i.test(normalized)) {
        return "Only promises future investigation instead of giving an answer.";
      }
      return null;
    case "outcome-first":
    case "bounded-uncertainty":
      return null;
  }
}

export function parseClauseVerdict(
  output: string,
  expectedClauseId: AnswerClauseId,
): ClauseVerdict | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed).sort();
  if (keys.join(",") !== "holds,id,why") return null;
  const { id, holds, why } = parsed as Record<string, unknown>;
  if (id !== expectedClauseId || typeof holds !== "boolean" || typeof why !== "string" || !why.trim()) return null;
  return { id: expectedClauseId, holds, why: why.slice(0, 300) };
}

export function sanitizeInfrastructureDetail(
  detail: string,
  sensitiveValues: readonly string[] = [],
): string {
  let sanitized = detail;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue) sanitized = sanitized.replaceAll(sensitiveValue, "[redacted]");
  }
  return sanitized.replace(/\s+/g, " ").slice(0, 400);
}
