// Ranking runs entirely in SQLite: no embedding service, no API key, no vector
// files to reconcile. A memory is worth surfacing when it matches the words the
// owner used, was written recently, matters, and has not been contradicted.

export const MEMORY_HALF_LIFE_MS = 45 * 86_400_000;
const LEXICAL_WEIGHT = 0.45;
const RECENCY_WEIGHT = 0.25;
const IMPORTANCE_WEIGHT = 0.2;
const CONFIDENCE_WEIGHT = 0.1;
// Reciprocal rank keeps the lexical signal bounded, so one freakishly good BM25
// score cannot drown out recency and importance the way a raw score would.
const RECIPROCAL_RANK_K = 4;

export type MemoryCandidate = {
  lexicalRank: number | null;
  importance: number;
  confidence: number;
  ageMs: number;
};

export function recencyScore(ageMs: number): number {
  return 0.5 ** (Math.max(0, ageMs) / MEMORY_HALF_LIFE_MS);
}

export function memoryScore(candidate: MemoryCandidate): number {
  const lexical = candidate.lexicalRank === null
    ? 0
    : RECIPROCAL_RANK_K / (RECIPROCAL_RANK_K + candidate.lexicalRank);
  return LEXICAL_WEIGHT * lexical +
    RECENCY_WEIGHT * recencyScore(candidate.ageMs) +
    IMPORTANCE_WEIGHT * candidate.importance +
    CONFIDENCE_WEIGHT * candidate.confidence;
}

// Ranking already down-weights an old memory through recencyScore. Decay is a
// different question — whether a memory has ever been *useful* — so it keys on
// idle time since last recall, and on a longer half-life than ranking, because
// a memory should never be discarded faster than it is merely down-ranked.
export const MEMORY_IDLE_HALF_LIFE_MS = 90 * 86_400_000;
export const MEMORY_CONFIDENCE_FLOOR = 0.05;
/** Below this, an agent-written memory has earned its way out of recall. */
export const MEMORY_TOMBSTONE_CONFIDENCE = 0.15;
export const MEMORY_REINFORCEMENT = 0.05;
// Demotion outweighs reinforcement: being wrong in front of the owner is much
// stronger evidence than going unchallenged.
export const MEMORY_DEMOTION = 0.25;

export function decayedConfidence(confidence: number, idleMs: number): number {
  const decayed = confidence * 0.5 ** (Math.max(0, idleMs) / MEMORY_IDLE_HALF_LIFE_MS);
  return Math.max(MEMORY_CONFIDENCE_FLOOR, decayed);
}

export function adjustedConfidence(confidence: number, delta: number): number {
  return Math.min(1, Math.max(MEMORY_CONFIDENCE_FLOOR, confidence + delta));
}

/**
 * Two subjects contradict when one's words wholly contain the other's — the
 * shape "deploy on fridays" versus "never deploy on fridays". Anything looser
 * starts superseding unrelated memories that merely share a common word.
 */
export function subjectTokens(subject: string): Set<string> {
  return new Set(
    subject.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1),
  );
}

export function subjectsContradict(left: string, right: string): boolean {
  const first = subjectTokens(left);
  const second = subjectTokens(right);
  if (first.size === 0 || second.size === 0) return false;
  const [smaller, larger] = first.size <= second.size ? [first, second] : [second, first];
  // A single shared word is a coincidence, not a contradiction.
  if (smaller.size < 2) return false;
  for (const token of smaller) if (!larger.has(token)) return false;
  return true;
}

/**
 * FTS5 treats quotes, `*`, `-`, and AND/OR/NEAR as syntax, so raw owner text is
 * a syntax error waiting to happen. Only word tokens survive, each quoted.
 */
export function ftsQuery(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1 && token.length <= 40)
    .slice(0, 24);
  return tokens.length === 0 ? null : tokens.map((token) => `"${token}"`).join(" OR ");
}
