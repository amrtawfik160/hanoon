import { expect, it } from "vitest";
import {
  MEMORY_SEMANTIC_FLOOR,
  cosineSimilarity,
  memoryScore,
  semanticRanks,
} from "../src/storage/memory-ranking";

const BASE = { importance: 0.5, confidence: 0.5, ageMs: 0 };

it("ranks a corpus with no vectors exactly as it did before they existed", () => {
  // The property that makes this safe to ship before a provider is wired:
  // absent vectors are not a degraded ranking, they are the previous one.
  const withoutField = memoryScore({ ...BASE, lexicalRank: 3 });
  const explicitlyNull = memoryScore({ ...BASE, lexicalRank: 3, semanticRank: null });
  expect(explicitlyNull).toBe(withoutField);

  // And the ordering it produces is unchanged across the whole range.
  const ranks = [0, 1, 2, 5, 20, null] as const;
  const order = (semantic: boolean) => [...ranks]
    .map((r) => ({ r, s: memoryScore({ ...BASE, lexicalRank: r, ...(semantic ? { semanticRank: null } : {}) }) }))
    .sort((a, b) => b.s - a.s).map((e) => e.r);
  expect(order(true)).toEqual(order(false));
});

it("lifts a memory that matches by meaning when the words miss entirely", () => {
  const wordsMissed = memoryScore({ ...BASE, lexicalRank: null, semanticRank: 0 });
  const wordsMissedNoVector = memoryScore({ ...BASE, lexicalRank: null, semanticRank: null });
  expect(wordsMissed).toBeGreaterThan(wordsMissedNoVector);
});

it("never rewards a missing vector over an otherwise identical semantic hit", () => {
  const embedded = memoryScore({ ...BASE, lexicalRank: 0, semanticRank: 0 });
  const notYetEmbedded = memoryScore({ ...BASE, lexicalRank: 0, semanticRank: null });

  expect(embedded).toBeGreaterThan(notYetEmbedded);
});

it("still puts a memory matching both above one matching only by meaning", () => {
  const both = memoryScore({ ...BASE, lexicalRank: 0, semanticRank: 0 });
  const meaningOnly = memoryScore({ ...BASE, lexicalRank: null, semanticRank: 0 });
  expect(both).toBeGreaterThan(meaningOnly);
});

it("cannot be dominated by one freakishly close vector", () => {
  // A perfect semantic hit that is old, unimportant and doubted must not
  // outrank a good hit that is recent, important and trusted.
  const perfectButStale = memoryScore({
    lexicalRank: null, semanticRank: 0, importance: 0, confidence: 0, ageMs: 400 * 86_400_000,
  });
  const goodAndTrusted = memoryScore({
    lexicalRank: 1, semanticRank: 2, importance: 1, confidence: 1, ageMs: 0,
  });
  expect(goodAndTrusted).toBeGreaterThan(perfectButStale);
});

it("refuses to compare vectors that cannot be compared", () => {
  // The reference system lost its vector recall exactly here: a 768-dimension
  // provider querying a 1536-dimension corpus, degrading silently per query.
  expect(cosineSimilarity(new Float32Array([1, 0, 0]), new Float32Array([1, 0]))).toBeNull();
  expect(cosineSimilarity(new Float32Array([]), new Float32Array([]))).toBeNull();
  expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBeNull();
});

it("scores identical vectors as identical and opposites as opposite", () => {
  expect(cosineSimilarity(new Float32Array([1, 2, 3]), new Float32Array([1, 2, 3]))).toBeCloseTo(1, 6);
  expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-1, 0]))).toBeCloseTo(-1, 6);
  expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0, 6);
});

it("drops matches too distant to mean anything, rather than returning a nearest miss", () => {
  const ranks = semanticRanks([
    { id: "close", similarity: 0.9 },
    { id: "related", similarity: 0.5 },
    { id: "unrelated", similarity: MEMORY_SEMANTIC_FLOOR - 0.01 },
    { id: "unreadable", similarity: null },
  ]);
  expect([...ranks.entries()]).toEqual([["close", 0], ["related", 1]]);
});

it("returns nothing when nothing was comparable", () => {
  expect(semanticRanks([]).size).toBe(0);
  expect(semanticRanks([{ id: "a", similarity: null }]).size).toBe(0);
});
