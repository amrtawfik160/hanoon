export type AnswerClauseAnchor = Readonly<{
  definition: string;
  positive: string;
  negative: string;
}>;

/**
 * These are rubric anchors, not golden cases. They are deliberately separate
 * examples so the judge cannot learn the answer-evaluation corpus by prompt
 * exposure.
 */
export const ANSWER_CLAUSE_ANCHORS: Readonly<Record<string, AnswerClauseAnchor>> = Object.freeze({
  "outcome-first": Object.freeze({
    definition: "The first sentence states the concrete result or current state before setup or intent.",
    positive: "The release is blocked on a dependency check.",
    negative: "I'll review the release details and tell you what I find.",
  }),
  "no-tool-narration": Object.freeze({
    definition: "The reply reports the outcome without naming tools, system mechanisms, unavailable capabilities, or evidence plumbing.",
    positive: "The deployment is waiting on an approval.",
    negative: "I called the thread reader, but the platform cannot expose a completion estimate.",
  }),
  "no-invented-progress": Object.freeze({
    definition: "This clause fails only for unsupported completion percentages and forecasts of time-to-completion. Observed timestamps, elapsed durations, retry counts, attempt counts, event counts, error text, and ordinary status facts are outside this clause; do not turn factual uncertainty into a progress violation.",
    positive: "The check has remained red since breakfast after three attempts; the latest error is unchanged.",
    negative: "The batch is 72% complete and is forecast to finish in 11 minutes.",
  }),
  "bounded-uncertainty": Object.freeze({
    definition: "Any uncertainty is a short, relevant qualification rather than a disclaimer that overwhelms the answer.",
    positive: "It looks stable so far, though only one region has reported.",
    negative: "I cannot be certain, and there are many reasons I may be wrong, so please treat every part of this answer as unknowable.",
  }),
  "no-dead-end-referral": Object.freeze({
    definition: "This clause fails only when the reply is explicitly delegating a routine BB app/UI/tool operation to the owner: open/click/navigate/stop/restart/run themselves. It holds when the reply recommends what the worker should do, recommends a next step, or suggests telling the worker what to do; do not infer owner delegation without an explicit owner-directed app operation.",
    positive: "Have the worker inspect its diagnostic view before retrying.",
    negative: "Please open the workspace panel and click Stop yourself.",
  }),
  "not-process-only": Object.freeze({
    definition: "The reply gives a concrete result, diagnosis, or bounded next step instead of only promising future investigation.",
    positive: "The issue is a failed dependency check, so retrying will not change it.",
    negative: "I will investigate and return with an update.",
  }),
});
