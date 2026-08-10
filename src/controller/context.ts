import type { MemoryKind, MemoryRecord, TelegramAgentStore } from "../storage/store";
import { OWNER_MEMORY_SCOPE } from "../storage/store";

const MAX_RECALLED = 6;
const MAX_DIGEST_TURNS = 6;
const MAX_CONTEXT_CHARS = 2_000;

// Explicit standing instructions only. A looser rule fills the store with
// passing remarks, and a wrong memory is worse than a missing one.
const STANDING_INSTRUCTION =
  /^\s*(?:please\s+)?(remember(?:\s+that)?|note\s+that|from now on|always|never|don'?t ever|stop)\b[\s,:-]*(.+)$/is;

const RECALLED_VERBATIM = new Set(["remember", "remember that", "note that"]);
const CORRECTIONS = new Set(["never", "stop", "don't ever", "dont ever"]);

export function detectStandingInstruction(
  text: string,
): { kind: MemoryKind; subject: string; body: string } | null {
  const match = STANDING_INSTRUCTION.exec(text);
  const lead = match?.[1]?.toLowerCase();
  const rest = match?.[2]?.replace(/\s+/g, " ").trim();
  if (!lead || !rest || rest.length < 3) return null;
  // "Remember X" states a fact; "always X" sets a preference; "never X" corrects
  // behaviour. Keeping them distinct lets the agent weigh them differently.
  const verbatim = RECALLED_VERBATIM.has(lead);
  return {
    kind: verbatim ? "fact" : CORRECTIONS.has(lead) ? "correction" : "preference",
    subject: subjectOf(rest),
    body: (verbatim ? rest : `${lead} ${rest}`).slice(0, 1_000),
  };
}

function subjectOf(text: string): string {
  const words = text.split(/\s+/).filter((word) => word.length > 0).slice(0, 8);
  return words.join(" ").slice(0, 120) || "note";
}

function renderMemories(memories: readonly MemoryRecord[]): string | null {
  if (memories.length === 0) return null;
  const lines = memories.map((memory) => `- ${memory.subject}: ${memory.body}`);
  return `What you already know about this owner:\n${lines.join("\n")}`;
}

function renderDigest(turns: readonly { ownerText: string; agentText: string }[]): string | null {
  if (turns.length === 0) return null;
  const lines = turns.map((turn) => `Owner: ${turn.ownerText}\nYou: ${turn.agentText}`);
  return `Earlier in this conversation:\n${lines.join("\n\n")}`;
}

function bounded(sections: readonly (string | null)[]): string | null {
  const joined = sections.filter((section): section is string => section !== null).join("\n\n");
  if (joined.length === 0) return null;
  return joined.length <= MAX_CONTEXT_CHARS ? joined : `${joined.slice(0, MAX_CONTEXT_CHARS - 1)}…`;
}

/**
 * What the agent should know before answering: standing memories, plus — only
 * when the conversation is starting over on a fresh thread — what was already
 * said, so a retired thread does not read to the owner as amnesia.
 */
export function buildTurnContext(input: {
  store: Pick<TelegramAgentStore, "recallMemories" | "readControllerDigest" | "listToolReceipts">;
  controllerKey: string;
  inputText: string;
  scope?: string;
  includeDigest: boolean;
  turnId?: string;
  now: number;
}): string | null {
  const memories = input.store.recallMemories({
    scope: input.scope ?? OWNER_MEMORY_SCOPE,
    query: input.inputText,
    limit: MAX_RECALLED,
    now: input.now,
  });
  const digest = input.includeDigest
    ? input.store.readControllerDigest(input.controllerKey, MAX_DIGEST_TURNS)
    : [];
  const receipts = input.includeDigest && input.turnId
    ? input.store.listToolReceipts(input.turnId)
    : [];
  return bounded([renderDigest(digest), renderReceipts(receipts), renderMemories(memories)]);
}

// A replacement thread must know what its predecessor already did, or it will
// happily cancel the same job or open the same thread a second time.
function renderReceipts(receipts: readonly { toolName: string; state: string }[]): string | null {
  const done = receipts.filter((receipt) => receipt.state !== "failed");
  if (done.length === 0) return null;
  const lines = done.map((receipt) =>
    `- ${receipt.toolName}: ${receipt.state === "completed" ? "already done" : "started, outcome unknown — check before repeating"}`);
  return `Actions already taken for this message:\n${lines.join("\n")}`;
}

export function composeTurnInput(context: string | null, inputText: string): string {
  return context === null ? inputText : `${context}\n\n---\n\nOwner message:\n${inputText}`;
}
