/**
 * Owner-facing copy for what the controller asked a worker thread to do.
 *
 * The owner works only from Telegram and cannot see the threads. When the
 * controller messages one it is acting with his authority, so he has no way to
 * know what was said in his name unless the reply that closes the turn says so.
 * A wrong instruction has to be visible at the time, not discoverable later.
 *
 * Two properties this file exists to hold:
 *
 *   1. The frame is a constant, the substance is not. Every send site imports
 *      these names and never inlines a literal, so changing the wording is one
 *      edit here. What the controller asked for and why cannot be a constant,
 *      so it is recorded per ask instead.
 *
 *   2. Nothing here reads the controller's reply. The report is composed from
 *      the recorded ask, so it does not depend on the controller remembering to
 *      mention it and it cannot be defeated by how the reply happens to be
 *      worded. Deriving owner-facing feedback by inspecting message content is
 *      the failure this design is avoiding.
 */

import { EVIDENCE_SPENT_OWNER_NOTICE } from "./evidence-budget";

/** Heading above the recorded asks. Plain words, because the owner reads it. */
export const THREAD_ASK_HEADING = "What I asked for:";

/** Prefix for one recorded ask. */
export const THREAD_ASK_BULLET = "- ";

/** Shown in place of an ask whose text could not be safely repeated. */
export const THREAD_ASK_REDACTED = "(instruction withheld, it could not be safely repeated)";

/** Shown when a thread has no title, so the line still names its target. */
export const THREAD_ASK_UNNAMED_THREAD = "a thread";

/** Longest ask the controller may record. One line, not the message it sent. */
export const MAX_THREAD_ASK_CHARS = 200;

/** Telegram's per-message ceiling, which the composed reply must stay under. */
export const MAX_OWNER_REPLY_CHARS = 4_096;

/** Longest thread name repeated back to the owner. */
const MAX_THREAD_NAME_CHARS = 60;

/**
 * Most asks listed in full. Beyond this the report counts the remainder rather
 * than growing without bound, because the owner reads this on a phone.
 */
export const MAX_LISTED_THREAD_ASKS = 6;

export type RecordedThreadAsk = Readonly<{
  threadId: string;
  threadName: string | null;
  ask: string;
}>;

function collapsedToOneLine(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return Array.from(collapsed).slice(0, maxChars).join("");
}

/**
 * Collapse an ask to the single line the owner will read. Applied when the ask
 * is recorded so that what is stored is what is shown.
 */
export function normalizeThreadAsk(ask: string): string {
  return collapsedToOneLine(ask, MAX_THREAD_ASK_CHARS);
}

/** Bound a thread's own title, which the controller does not choose. */
export function normalizeThreadName(threadName: string): string {
  return collapsedToOneLine(threadName, MAX_THREAD_NAME_CHARS);
}

function threadLabel(ask: RecordedThreadAsk): string {
  const name = ask.threadName ?? "";
  return name.length === 0 ? THREAD_ASK_UNNAMED_THREAD : name;
}

function askLine(ask: RecordedThreadAsk): string {
  const substance = ask.ask.trim().length === 0 ? THREAD_ASK_REDACTED : ask.ask.trim();
  return `${THREAD_ASK_BULLET}${threadLabel(ask)}: ${substance}`;
}

function remainderLine(remaining: number): string {
  return remaining === 1
    ? `${THREAD_ASK_BULLET}and 1 more`
    : `${THREAD_ASK_BULLET}and ${remaining} more`;
}

export type ThreadAskReport = Readonly<{
  /** Text appended to the owner's reply. */
  block: string;
  /** How many asks this block states in full, counted from the oldest. */
  reportedCount: number;
}>;

/**
 * Render the recorded asks as the block appended to the owner's reply, or null
 * when there is nothing to report.
 *
 * `budgetChars` is what remains of the owner-visible message. The block is
 * trimmed to fit rather than overflowing: listing fewer asks and counting the
 * rest is acceptable, silently exceeding the message limit is not. When even
 * one line will not fit the report is dropped, because a truncated sentence
 * tells the owner less than the next reply will.
 *
 * `reportedCount` covers only the asks stated in full. The ones behind "and N
 * more" are deliberately not counted, so they stay owed and are named on the
 * next reply rather than being written off as told.
 */
export function renderThreadAskReport(
  asks: readonly RecordedThreadAsk[],
  budgetChars: number,
): ThreadAskReport | null {
  if (asks.length === 0) return null;
  for (let listed = Math.min(asks.length, MAX_LISTED_THREAD_ASKS); listed >= 1; listed -= 1) {
    const remaining = asks.length - listed;
    const lines = [
      THREAD_ASK_HEADING,
      ...asks.slice(0, listed).map(askLine),
      ...(remaining > 0 ? [remainderLine(remaining)] : []),
    ];
    const block = `\n\n${lines.join("\n")}`;
    if (Array.from(block).length <= budgetChars) return { block, reportedCount: listed };
  }
  return null;
}

export type ComposedOwnerReply = Readonly<{
  text: string;
  reportedCount: number;
}>;

export type OwnerReplyConditions = Readonly<{
  /** Whether this turn answered on an evidence budget that had run out. */
  evidenceBudgetSpent?: boolean;
}>;

/**
 * Compose the message the owner actually receives: the finalization the
 * contract accepted, a note when the answer was thinner than usual, then what
 * the controller asked threads to do.
 *
 * The accepted text is never modified. Everything else is appended, so a reply
 * that passed the evidence gate still says exactly what it said.
 *
 * The degraded note is fixed text on the delivery path rather than something
 * the controller is asked to include. An answer given on a spent budget has
 * gaps in it, and whether the owner learns that cannot depend on the model
 * remembering to mention it.
 */
export function composeOwnerReply(
  acceptedMessage: string,
  asks: readonly RecordedThreadAsk[],
  maxChars: number,
  conditions: OwnerReplyConditions = {},
): ComposedOwnerReply {
  const note = conditions.evidenceBudgetSpent ? `\n\n${EVIDENCE_SPENT_OWNER_NOTICE}` : "";
  // The answer outranks the note: if both will not fit, the note is what goes.
  const head = Array.from(`${acceptedMessage}${note}`).length <= maxChars
    ? `${acceptedMessage}${note}`
    : acceptedMessage;
  const budget = maxChars - Array.from(head).length;
  const report = budget > 0 ? renderThreadAskReport(asks, budget) : null;
  if (report === null) return { text: head, reportedCount: 0 };
  return { text: `${head}${report.block}`, reportedCount: report.reportedCount };
}
