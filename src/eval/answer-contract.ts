/**
 * The controller's instructions make specific, checkable promises about what an
 * answer looks like. Nothing in the deterministic suite tests them, so the
 * 39-line instruction string cannot be changed with any confidence — every
 * edit is a guess. These clauses restate those promises as a rubric a judge can
 * apply to one answer, so a prompt change can be measured rather than hoped at.
 *
 * Each clause is deliberately about the *answer*, never about whether the agent
 * was factually right: correctness depends on a world this harness does not
 * have, and a rubric that quietly grades it would be measuring noise.
 */
export type AnswerClause = Readonly<{
  id: string;
  question: string;
}>;

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
    question: "Does the answer avoid inventing a completion percentage or an ETA that no tool could have reported?",
  }),
  Object.freeze({
    id: "bounded-uncertainty",
    question: "Is any uncertainty confined to a short clause rather than a disclaimer paragraph?",
  }),
  Object.freeze({
    id: "no-dead-end-referral",
    question: "Does the answer avoid telling the owner to go and do something in the BB app themselves?",
  }),
  Object.freeze({
    id: "not-process-only",
    question: "Is this a finished answer rather than only a statement of intent to go and investigate?",
  }),
]);

export const ANSWER_CLAUSE_IDS: readonly string[] = Object.freeze(
  ANSWER_CLAUSES.map((clause) => clause.id),
);

export type AnswerJudgeSpawnInput = Readonly<{
  project: string;
  title: string;
  prompt: string;
  model?: string;
}>;

export function buildAnswerJudgeSpawnArgs(input: AnswerJudgeSpawnInput): string[] {
  const spawnArgs = [
    "thread", "spawn",
    "--project", input.project,
    "--title", input.title,
    "--prompt", input.prompt,
    "--json",
  ];
  if (input.model) spawnArgs.push("--model", input.model);
  return spawnArgs;
}

export type ClauseVerdict = Readonly<{ id: string; holds: boolean; why: string }>;
export type AnswerVerdict = Readonly<{ clauses: readonly ClauseVerdict[]; passed: boolean }>;

export function buildJudgePrompt(input: { ownerMessage: string; answer: string }): string {
  const clauses = ANSWER_CLAUSES
    .map((clause, index) => `${index + 1}. id "${clause.id}": ${clause.question}`)
    .join("\n");
  return `You are grading one reply that an assistant sent to its owner over Telegram. Grade only the reply's form against the rules below. You cannot see the systems it describes, so never grade whether it is factually correct, and never reward or punish it for the news being good or bad.

Owner asked:
"""
${input.ownerMessage}
"""

Assistant replied:
"""
${input.answer}
"""

For each rule, answer whether it holds:
${clauses}

Reply with strict JSON and nothing else — no prose, no Markdown fence:

{"clauses":[{"id":"outcome-first","holds":true,"why":"one short reason"}]}

Include every rule id exactly once. "holds" is true when the reply satisfies the rule.`;
}

/**
 * The judge is a model, so its output is untrusted: a fence or preamble is
 * tolerated, but a missing or duplicated clause is a failed grading rather than
 * a silent pass — a rubric that scores an unparseable answer as fine is worse
 * than no rubric.
 */
export function parseAnswerVerdict(output: string): AnswerVerdict | null {
  const fenced = output.replace(/```(?:json)?/gi, " ");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return null;
  }
  const entries = (parsed as { clauses?: unknown })?.clauses;
  if (!Array.isArray(entries)) return null;
  const byId = new Map<string, ClauseVerdict>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, holds, why } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof holds !== "boolean") continue;
    if (!ANSWER_CLAUSE_IDS.includes(id) || byId.has(id)) continue;
    byId.set(id, { id, holds, why: typeof why === "string" ? why.slice(0, 300) : "" });
  }
  if (byId.size !== ANSWER_CLAUSES.length) return null;
  const clauses = ANSWER_CLAUSES.map((clause) => byId.get(clause.id) as ClauseVerdict);
  return { clauses, passed: clauses.every((clause) => clause.holds) };
}
