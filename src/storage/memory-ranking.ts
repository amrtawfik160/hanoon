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
