/**
 * Whether the owner just told the agent to land the work.
 *
 * The merge approval is a one-use Telegram button whose nonce the agent never
 * sees, which is what stops it approving its own work. But the owner types
 * "merge it" far more often than they hunt for a button, and answering that
 * with "please tap the thing I sent you" is the friction they asked to lose.
 *
 * So the instruction itself becomes the approval — read here, from the owner's
 * own words, by the plugin rather than by the model. The agent cannot
 * manufacture this: it relays an intent the plugin independently saw. That is
 * the whole reason this is a deterministic matcher and not a judgement call.
 *
 * Deliberately narrow, in the same spirit as the standing-instruction matcher
 * next door. A false positive here merges something the owner did not ask to
 * merge, so anything hedged, negated, or merely *about* merging must not match.
 */

/** Only repository integration verbs belong here; deployment is separate authority. */
const LAND_VERB = "(?:merge|land)";

/**
 * An imperative aimed at the work in hand. The object is required: "merge it",
 * "ship this", "deploy the PR" — never a bare "merge", which is as likely to be
 * a topic as a command.
 */
const JOB_ID = "[A-Za-z0-9][A-Za-z0-9_-]{2,255}";
const OBJECT =
  `(?:the\\s+job\\s+${JOB_ID}|${JOB_ID}|it|this|that|them|the\\s+(?:pr|pull\\s+request|change|changes|fix|job|work|branch|thing))`;

const APPROVE_LEAD =
  "(?:(?:please|now|just)\\s+|go\\s+ahead\\s+and\\s+|(?:yes|ok(?:ay)?|sure)[,!\\s]+)*";
const POSITIVE_PREFIX = "(?:(?:looks\\s+good|nice\\s+work|all\\s+good|approved)[.!]\\s+)?";

const MERGE_INSTRUCTION = new RegExp(
  `^${POSITIVE_PREFIX}${APPROVE_LEAD}${LAND_VERB}\\s+${OBJECT}[.!]?$`,
  "iu",
);

/**
 * Anything that makes the sentence not an instruction to land now. Checked
 * across the whole message rather than the matched clause: "merge it once CI
 * passes" and "don't merge it" both have a clean imperative inside them.
 */
const NOT_NOW = [
  /\b(?:do\s*n[o']?t|dont|never|no\s+need\s+to|hold\s+off|wait|not\s+yet|before\s+you|instead\s+of)\b/iu,
  /\b(?:if|once|when|after|unless|until|should\s+i|shall\s+i|can\s+you\s+ask|let\s+me\s+know)\b/iu,
  /\?\s*$/u,
];

/**
 * True only for a plain, present-tense instruction to land the work. Everything
 * else — a question, a condition, a refusal, a plan for later — is not an
 * approval, and the owner still gets the button.
 */
export function isMergeInstruction(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const message = text.trim();
  if (message.length === 0 || message.length > 2_000) return false;
  if (NOT_NOW.some((pattern) => pattern.test(message))) return false;
  return MERGE_INSTRUCTION.test(message);
}
