import { expect, it } from "vitest";
import {
  CONTROLLER_EVIDENCE_LIMIT,
  EVIDENCE_BUDGET_DEGRADE_ROWS,
  EVIDENCE_SPENT_OWNER_NOTICE,
  evaluateEvidenceBudget,
} from "../src/controller/evidence-budget";
import { composeOwnerReply, MAX_OWNER_REPLY_CHARS } from "../src/controller/thread-ask";
import {
  evaluateSupervisor,
  SUPERVISOR_SOFT_COMMAND_FAILURES,
  SUPERVISOR_SOFT_TOKENS,
  SUPERVISOR_SOFT_TOOL_CALLS,
  type SupervisorSignals,
} from "../src/controller/supervisor";

const quiet: SupervisorSignals = {
  toolCalls: 0,
  totalTokens: 0,
  commandFailures: 0,
  evidenceRows: 0,
  steersIssued: 0,
  steeredReasons: [],
};

it("leaves a turn with room to spare alone", () => {
  expect(evaluateEvidenceBudget({ recorded: 0, limitExceeded: false })).toEqual({ kind: "ok" });
  expect(evaluateEvidenceBudget({ recorded: EVIDENCE_BUDGET_DEGRADE_ROWS - 1, limitExceeded: false }))
    .toEqual({ kind: "ok" });
});

it("asks a turn to land its answer once it nears the cap", () => {
  expect(evaluateEvidenceBudget({ recorded: EVIDENCE_BUDGET_DEGRADE_ROWS, limitExceeded: false }))
    .toMatchObject({ kind: "degrade" });
});

it("calls the budget spent at the cap", () => {
  expect(evaluateEvidenceBudget({ recorded: CONTROLLER_EVIDENCE_LIMIT, limitExceeded: false }))
    .toMatchObject({ kind: "spent" });
});

it("calls the budget spent as soon as a write has been refused", () => {
  // A batch can be refused below the cap, because it is the batch crossing it
  // that gets turned away. The refusal is the fact, not the row count.
  expect(evaluateEvidenceBudget({ recorded: 3, limitExceeded: true })).toMatchObject({ kind: "spent" });
});

it("names the dimension and the numbers in its reason", () => {
  const verdict = evaluateEvidenceBudget({ recorded: CONTROLLER_EVIDENCE_LIMIT, limitExceeded: false });
  if (verdict.kind !== "spent") throw new Error("expected a spent verdict");
  expect(verdict.reason).toContain(`${CONTROLLER_EVIDENCE_LIMIT}`);
});

it("reads an unusable count as untouched rather than as full", () => {
  // A false degrade cuts an answer short for no reason; a missed one costs a
  // thinner answer. Absent data must never buy the expensive mistake.
  for (const recorded of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
    expect(evaluateEvidenceBudget({ recorded, limitExceeded: false })).toEqual({ kind: "ok" });
  }
});

it("is pure: the same signals always give the same verdict", () => {
  const signals = { recorded: EVIDENCE_BUDGET_DEGRADE_ROWS, limitExceeded: false } as const;
  expect(evaluateEvidenceBudget(signals)).toEqual(evaluateEvidenceBudget(signals));
});

it("nudges a turn approaching the evidence cap", () => {
  expect(evaluateSupervisor({ ...quiet, evidenceRows: EVIDENCE_BUDGET_DEGRADE_ROWS }))
    .toMatchObject({ kind: "steer", reason: "evidence_budget" });
});

it("prefers the evidence nudge over another soft budget crossed at the same time", () => {
  // Whichever nudge lands first may be the only one. The evidence cap is the
  // one whose ceiling costs the turn its claims, so it goes first.
  expect(evaluateSupervisor({
    ...quiet,
    evidenceRows: EVIDENCE_BUDGET_DEGRADE_ROWS,
    toolCalls: SUPERVISOR_SOFT_TOOL_CALLS,
    totalTokens: SUPERVISOR_SOFT_TOKENS,
    commandFailures: SUPERVISOR_SOFT_COMMAND_FAILURES,
  })).toMatchObject({ kind: "steer", reason: "evidence_budget" });
});

it("never stops a turn for the evidence budget alone", () => {
  // Stopping is what used to throw the owner's question away.
  expect(evaluateSupervisor({
    ...quiet,
    evidenceRows: CONTROLLER_EVIDENCE_LIMIT * 10,
    steersIssued: 2,
    steeredReasons: ["evidence_budget", "tool_budget"],
  })).toEqual({ kind: "continue" });
});

it("never issues the spent steer from the rationed nudges", () => {
  // `evidence_spent` fires after a refusal and must not be starved, so it is
  // claimed directly rather than drawn from the two-steer ration.
  expect(evaluateSupervisor({ ...quiet, evidenceRows: CONTROLLER_EVIDENCE_LIMIT }))
    .toMatchObject({ kind: "steer", reason: "evidence_budget" });
});

it("tells the owner when an answer came from a spent budget", () => {
  const reply = composeOwnerReply("Both machines are idle.", [], MAX_OWNER_REPLY_CHARS, {
    evidenceBudgetSpent: true,
  });

  expect(reply.text).toBe(`Both machines are idle.\n\n${EVIDENCE_SPENT_OWNER_NOTICE}`);
});

it("says nothing extra on an ordinary answer", () => {
  expect(composeOwnerReply("Both machines are idle.", [], MAX_OWNER_REPLY_CHARS).text)
    .toBe("Both machines are idle.");
  expect(composeOwnerReply("Both machines are idle.", [], MAX_OWNER_REPLY_CHARS, {
    evidenceBudgetSpent: false,
  }).text).toBe("Both machines are idle.");
});

it("keeps the answer whole when the note will not fit beside it", () => {
  const answer = "x".repeat(MAX_OWNER_REPLY_CHARS);

  const reply = composeOwnerReply(answer, [], MAX_OWNER_REPLY_CHARS, { evidenceBudgetSpent: true });

  expect(reply.text).toBe(answer);
});

it("reports the asks after the note when both fit", () => {
  const reply = composeOwnerReply("Done.", [
    { threadId: "thr_1", threadName: "invoices", ask: "rerun the failing test" },
  ], MAX_OWNER_REPLY_CHARS, { evidenceBudgetSpent: true });

  expect(reply.text).toContain(EVIDENCE_SPENT_OWNER_NOTICE);
  expect(reply.text).toContain("rerun the failing test");
  expect(reply.text.indexOf(EVIDENCE_SPENT_OWNER_NOTICE))
    .toBeLessThan(reply.text.indexOf("rerun the failing test"));
  expect(reply.reportedCount).toBe(1);
});
