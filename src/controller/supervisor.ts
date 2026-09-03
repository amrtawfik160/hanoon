import {
  EVIDENCE_BUDGET_DEGRADE_ROWS,
  EVIDENCE_DEGRADE_STEER,
  EVIDENCE_SPENT_STEER,
} from "./evidence-budget";

/**
 * A full-permission controller turn is bounded by wall-clock silence alone
 * (CONTROLLER_STALL_MS). A turn that keeps producing events while going nowhere
 * is invisible to that clock, so these budgets bound the work itself: one nudge
 * to land the answer, then a stop before it burns the owner's money on a loop
 * they cannot see.
 */

/** One nudge is a course correction; a second is nagging a model that is stuck. */
export const SUPERVISOR_MAX_STEERS_PER_TURN = 2;

// A phone answer is a handful of calls; a genuinely broad request ("what is
// running across every machine") lands near 40. 60 is past thorough and into
// searching, and 120 is not a question being answered.
export const SUPERVISOR_SOFT_TOOL_CALLS = 60;
export const SUPERVISOR_HARD_TOOL_CALLS = 120;

// Tokens bound cost rather than context, so the figure is what a turn spent:
// fresh input plus output, with the cached prefix the provider re-reads on
// every call left out. Counted with that prefix, a ten-call turn on a mature
// thread read as 660k and was stopped while delivering its answer; without
// it the same turn is ~20k. A long investigation lands under 300k; past 600k
// the turn is not converging.
export const SUPERVISOR_SOFT_TOKENS = 300_000;
export const SUPERVISOR_HARD_TOKENS = 600_000;

// Five non-zero exits is a model trying variations instead of reading the error.
export const SUPERVISOR_SOFT_COMMAND_FAILURES = 5;

export type SupervisorReason =
  | "tool_budget"
  | "token_budget"
  | "command_failures"
  | "evidence_budget"
  | "evidence_spent";

export const SUPERVISOR_REASONS: ReadonlySet<string> = new Set<SupervisorReason>([
  "tool_budget",
  "token_budget",
  "command_failures",
  "evidence_budget",
  "evidence_spent",
]);

export type SupervisorSignals = {
  toolCalls: number;
  totalTokens: number;
  commandFailures: number;
  /** Evidence rows recorded on this turn, against `CONTROLLER_EVIDENCE_LIMIT`. */
  evidenceRows: number;
  steersIssued: number;
  steeredReasons: readonly SupervisorReason[];
};

export type SupervisorDecision =
  | { kind: "continue" }
  | { kind: "steer"; reason: SupervisorReason; text: string }
  | { kind: "stop"; reason: SupervisorReason; ownerMessage: string };

const STEER_TEXT: Record<SupervisorReason, string> = {
  tool_budget:
    "You have spent a lot of tool calls on this one message. Stop looking and answer now with what you already have. If something is genuinely unresolved, say so in one clause.",
  token_budget:
    "This turn is running long. Land the answer now with what you already know, and name the one thing that would settle anything still open.",
  command_failures:
    "Several commands have failed. Stop trying variations: read the actual error, form one hypothesis, and either test that once or tell the owner what is blocking you.",
  evidence_budget: EVIDENCE_DEGRADE_STEER,
  evidence_spent: EVIDENCE_SPENT_STEER,
};

const STOP_MESSAGE =
  "That one ran past its budget, so I stopped it and started fresh. Ask me again — narrower helps.";

/**
 * Hard budgets stop the turn outright; soft budgets spend one of the two
 * available nudges, and never twice for the same reason — a tripped budget
 * stays tripped on every later poll, so without that guard one crossing would
 * nudge forever.
 *
 * `evidence_budget` leads the soft list because it is the only one of them
 * whose ceiling, once reached, costs the turn its ability to make claims at
 * all. A tool-call nudge that lands first is a nudge the evidence budget may
 * not get. `evidence_spent` is never returned from here: it fires after the
 * cap has already refused a write, which must not be starved by the two-steer
 * ration, so its caller claims it directly.
 */
export function evaluateSupervisor(signals: SupervisorSignals): SupervisorDecision {
  if (signals.toolCalls >= SUPERVISOR_HARD_TOOL_CALLS) {
    return { kind: "stop", reason: "tool_budget", ownerMessage: STOP_MESSAGE };
  }
  if (signals.totalTokens >= SUPERVISOR_HARD_TOKENS) {
    return { kind: "stop", reason: "token_budget", ownerMessage: STOP_MESSAGE };
  }
  if (signals.steersIssued >= SUPERVISOR_MAX_STEERS_PER_TURN) return { kind: "continue" };
  const used = new Set(signals.steeredReasons);
  const soft: readonly (readonly [SupervisorReason, boolean])[] = [
    ["evidence_budget", signals.evidenceRows >= EVIDENCE_BUDGET_DEGRADE_ROWS],
    ["tool_budget", signals.toolCalls >= SUPERVISOR_SOFT_TOOL_CALLS],
    ["token_budget", signals.totalTokens >= SUPERVISOR_SOFT_TOKENS],
    ["command_failures", signals.commandFailures >= SUPERVISOR_SOFT_COMMAND_FAILURES],
  ];
  for (const [reason, tripped] of soft) {
    if (tripped && !used.has(reason)) return { kind: "steer", reason, text: STEER_TEXT[reason] };
  }
  return { kind: "continue" };
}
