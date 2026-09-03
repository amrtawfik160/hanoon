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
    definition: "The clause fails for narration of the responding assistant's own observation mechanisms: tool/API/BB internals, evidence plumbing, or capability limitations (for example, 'I called X', 'the platform cannot expose Y', or 'based on available data'). It holds when the reply reports subject-work artifacts and observed state such as tests, assertions, retries, attempts, errors, migrations, jobs, deployments, approvals, monitors, or worker actions. Do not infer assistant tool narration merely because a noun names a mechanism in the subject domain. Do not grade factual correctness.",
    positive: "The migration assertion is still failing after three attempts; the deployment is waiting on approval.",
    negative: "I called the thread reader, but the platform cannot expose the job's retry history.",
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
  "plain-language": Object.freeze({
    definition: "The reply is easy to follow without specialist knowledge. It uses direct wording and explains a technical term when that term is necessary to understand the result. Familiar product names and a concise status label are allowed.",
    positive: "The release is blocked because the database check failed. That check makes sure old data still works with the new code.",
    negative: "The final_validating transition hit a non-monotonic ledger convergence invariant in the remediation submachine.",
  }),
});
