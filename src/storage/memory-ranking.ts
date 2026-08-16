// The base rank runs entirely in SQLite. Optional local vectors add one bounded
// semantic signal without an API key; when either side has no compatible
// vector, the exact word-based score remains authoritative.

export const MEMORY_HALF_LIFE_MS = 45 * 86_400_000;
const LEXICAL_WEIGHT = 0.45;
const RECENCY_WEIGHT = 0.25;
const IMPORTANCE_WEIGHT = 0.2;
const CONFIDENCE_WEIGHT = 0.1;
// Reciprocal rank keeps the lexical signal bounded, so one freakishly good BM25
// score cannot drown out recency and importance the way a raw score would.
const RECIPROCAL_RANK_K = 4;
/**
 * Meaning is worth about as much as words: a question rarely reuses the
 * phrasing of the answer, and the two signals disagree in useful ways.
 */
const SEMANTIC_WEIGHT = 0.3;
/**
 * Below this, two texts are unrelated. Cosine on sentence embeddings puts
 * genuinely unrelated pairs well under a third, and admitting them would let a
 * question with no real answer still return its nearest miss.
 */
export const MEMORY_SEMANTIC_FLOOR = 0.35;

export type MemoryCandidate = {
  lexicalRank: number | null;
  /**
   * Rank by meaning rather than words, when vectors are available. Null when
   * they are not, which is the ordinary case: no embedding provider, a memory
   * written before one existed, or a corpus embedded by a different model.
   */
  semanticRank?: number | null;
  importance: number;
  confidence: number;
  ageMs: number;
};

export function recencyScore(ageMs: number): number {
  return 0.5 ** (Math.max(0, ageMs) / MEMORY_HALF_LIFE_MS);
}

function reciprocalRank(rank: number | null | undefined): number {
  return rank === null || rank === undefined
    ? 0
    : RECIPROCAL_RANK_K / (RECIPROCAL_RANK_K + rank);
}

/**
 * Scores one memory against the question.
 *
 * The semantic term is what lets "what did I say about shipping on Fridays"
 * reach a memory phrased "never deploy at the end of the week". It is folded in
 * as another reciprocal rank rather than a raw cosine, for the same reason the
 * lexical signal is: one freakishly close vector should not be able to outvote
 * recency and importance together.
 *
 * When no vector is available the original score is returned unchanged. When
 * one is available, semantic rank receives a fixed share of that same unit
 * scale. That keeps embedded and unembedded rows comparable while preserving
 * the exact pre-embedding ranking for a word-only corpus.
 */
export function memoryScore(candidate: MemoryCandidate): number {
  const semanticAvailable = candidate.semanticRank !== null && candidate.semanticRank !== undefined;
  const base = LEXICAL_WEIGHT * reciprocalRank(candidate.lexicalRank) +
    RECENCY_WEIGHT * recencyScore(candidate.ageMs) +
    IMPORTANCE_WEIGHT * candidate.importance +
    CONFIDENCE_WEIGHT * candidate.confidence;
  if (!semanticAvailable) return base;
  return base * (1 - SEMANTIC_WEIGHT) + SEMANTIC_WEIGHT * reciprocalRank(candidate.semanticRank);
}

/**
 * Cosine similarity, and a refusal to compare vectors that cannot be compared.
 *
 * Different models produce different dimensions, and a corpus embedded by one
 * model against a query embedded by another yields a number that looks like a
 * score and means nothing. The reference system this follows lost its vector
 * recall exactly that way — a 768-dimension provider querying a 1536-dimension
 * corpus, degrading silently per query — so a mismatch here returns null and
 * the caller falls back to words rather than trusting a meaningless figure.
 */
export function cosineSimilarity(left: Float32Array, right: Float32Array): number | null {
  if (left.length === 0 || left.length !== right.length) return null;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return null;
  const similarity = dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
  return Number.isFinite(similarity) ? similarity : null;
}

/**
 * Ranks memories by similarity, strongest first, dropping anything too distant
 * to be worth surfacing. Without the floor an unrelated memory still earns a
 * rank purely by being the least unrelated one present.
 */
export function semanticRanks(
  scored: readonly { id: string; similarity: number | null }[],
): Map<string, number> {
  const ranks = new Map<string, number>();
  scored
    .filter((entry): entry is { id: string; similarity: number } =>
      entry.similarity !== null && entry.similarity >= MEMORY_SEMANTIC_FLOOR)
    .sort((left, right) => right.similarity - left.similarity)
    .forEach((entry, index) => ranks.set(entry.id, index));
  return ranks;
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
