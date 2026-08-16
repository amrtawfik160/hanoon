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

/** The verbs that mean "land it", each requiring an explicit object. */
const LAND_VERB = "(?:merge|ship|deploy|land|release|push\\s+(?:it|this)\\s+live|go\\s+live)";

/**
 * An imperative aimed at the work in hand. The object is required: "merge it",
 * "ship this", "deploy the PR" — never a bare "merge", which is as likely to be
 * a topic as a command.
 */
const OBJECT = "(?:it|this|that|them|the\\s+(?:pr|pull\\s+request|change|changes|fix|job|work|branch|thing))";

const APPROVE_LEAD =
  "(?:please\\s+|now\\s+|just\\s+|go\\s+ahead\\s+and\\s+|yes[,\\s]+|ok(?:ay)?[,\\s]+|sure[,\\s]+)*";

/** "go live *with* it" reads as an instruction exactly as "ship it" does. */
const PREPOSITION = "(?:\\s+with)?";

/**
 * Where a fresh clause may begin. Dashes and colons are included because praise
 * before the instruction is how people actually write ("nice work — merge it").
 * A comma is not: a comma-led clause is far more often a condition's tail.
 */
const CLAUSE_START = "(?:^|[.!?;:\\n\\u2013\\u2014]\\s*|\\s+[-\\u2013\\u2014]\\s+)";

const MERGE_INSTRUCTION = new RegExp(
  `${CLAUSE_START}${APPROVE_LEAD}${LAND_VERB}(?:\\s+and\\s+${LAND_VERB})*${PREPOSITION}\\s+${OBJECT}\\b`,
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
