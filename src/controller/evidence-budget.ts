/**
 * The per-turn evidence budget, and what to do as it runs out.
 *
 * A controller turn may record at most `CONTROLLER_EVIDENCE_LIMIT` pieces of
 * evidence. That cap exists so one runaway turn cannot write without bound, and
 * it is not the thing being changed here. What is being changed is what happens
 * when it is reached: the turn used to be retired, which threw away the owner's
 * question along with the work done answering it. A safety limit that destroys
 * the thing it was protecting has failed at its job.
 *
 * The shape:
 *
 *   - `evaluateEvidenceBudget` is PURE and SYNCHRONOUS. It reads two numbers
 *     and returns a verdict. It writes nothing, sends nothing, and cannot
 *     throw on absent data — unknown counts read as `ok`, so a missing figure
 *     never manufactures a degradation.
 *   - The CALLER actuates. Steering the controller, telling the owner, and
 *     letting a thinner finalization through are the caller's business, and
 *     each of those is separately reversible without touching this file.
 *
 * Two verdicts, deliberately: `degrade` fires while there is still room to land
 * an answer, and `spent` fires once there is not. Waiting for `spent` alone
 * would mean the only warning arrives after the evidence the answer needed was
 * already refused.
 *
 * These thresholds are exported, documented constants rather than environment
 * overrides: this plugin has no `process.env` reads anywhere in `src/`, and
 * `supervisor.ts` already uses the same idiom. Tuning is a one-line edit here
 * rather than a host restart.
 */

/**
 * Rows one turn may record. Mirrored by `MAX_EVIDENCE_ROWS` in the evidence
 * repository, which enforces it inside the write transaction; this module only
 * reasons about the same number.
 */
export const CONTROLLER_EVIDENCE_LIMIT = 128;

/**
 * Where "plenty left" becomes "land it now". Sixteen rows of headroom is enough
 * for a last look and the finalization itself, and small enough that the
 * warning is not spent on turns that were never going to reach the cap.
 */
export const EVIDENCE_BUDGET_DEGRADE_ROWS = 112;

export type EvidenceBudgetVerdict =
  | { kind: "ok" }
  | { kind: "degrade"; reason: string }
  | { kind: "spent"; reason: string };

export type EvidenceBudgetSignals = Readonly<{
  /** Evidence rows already recorded for this turn. */
  recorded: number;
  /** Whether a write has already been refused for want of room. */
  limitExceeded: boolean;
}>;

/**
 * The verdict for one turn. Pure: the caller decides what a `degrade` or a
 * `spent` is worth.
 *
 * Fail-safe on absent data. A `recorded` count that is not a real number is
 * treated as zero rather than as a full budget, because the cost of a missed
 * warning is a thinner answer and the cost of a false one is an answer cut
 * short for no reason.
 */
export function evaluateEvidenceBudget(signals: EvidenceBudgetSignals): EvidenceBudgetVerdict {
  const recorded = Number.isFinite(signals.recorded) ? Math.max(0, Math.trunc(signals.recorded)) : 0;
  if (signals.limitExceeded || recorded >= CONTROLLER_EVIDENCE_LIMIT) {
    return {
      kind: "spent",
      reason: `evidence budget spent (${Math.min(recorded, CONTROLLER_EVIDENCE_LIMIT)}/${CONTROLLER_EVIDENCE_LIMIT})`,
    };
  }
  if (recorded >= EVIDENCE_BUDGET_DEGRADE_ROWS) {
    return {
      kind: "degrade",
      reason: `evidence budget nearly spent (${recorded}/${CONTROLLER_EVIDENCE_LIMIT})`,
    };
  }
  return { kind: "ok" };
}

/**
 * Sent while there is still room. Asks for the answer now, in the ordinary
 * evidence-backed form, because nothing has been refused yet.
 */
export const EVIDENCE_DEGRADE_STEER =
  "You are close to the limit of what you can record on this message. Stop looking at anything new and finalize now with the evidence you already have. If something is still unresolved, say so in one clause rather than checking it.";

/**
 * Sent once the cap has refused a write. Asks for a plain-text answer, because
 * a claim needs evidence and no further evidence can be recorded on this turn.
 */
export const EVIDENCE_SPENT_STEER =
  "You have used up everything you can record on this message, so no further checks can be counted. Finalize right now in plain text, with no claim segments: say what you found, and say plainly that you ran out of room to verify the rest. Do not keep working.";

/**
 * Appended to the owner's reply when a turn finalized on a spent budget. Fixed
 * text on the delivery path rather than something the controller is asked to
 * remember, so the owner is told even when the model does not mention it.
 */
export const EVIDENCE_SPENT_OWNER_NOTICE =
  "(I hit my limit for checking things on this one, so there is more I did not verify. Ask again if you want me to go further.)";
