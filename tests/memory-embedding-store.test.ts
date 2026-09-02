import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { openStore, OWNER_MEMORY_SCOPE, type TelegramAgentStore } from "../src/storage/store";

const NOW = 1_800_000_000_000;
let n = 0;
function fixture(): TelegramAgentStore {
  const { bb } = createFakePluginHost({ pluginId: `telegram-agent-embed-${n++}` });
  return openStore(bb.storage, bb.storage.kv, () => NOW);
}

/** Returns the id the store actually assigned, which is what vectors key on. */
function remember(store: TelegramAgentStore, subject: string, body: string): string {
  return store.rememberMemory({
    scope: OWNER_MEMORY_SCOPE, kind: "fact", subject, body,
    importance: 0.5, confidence: 0.5, source: "owner", now: NOW,
  }).id;
}

/** A unit vector pointing mostly along one axis, so similarity is predictable. */
function vector(...values: number[]): Float32Array {
  return Float32Array.from(values);
}

it("finds a memory by meaning when the words miss completely", () => {
  // The complaint this whole feature exists for: phrase it differently and the
  // keyword index never sees it.
  const store = fixture();
  const m_deploy = remember(store, "aubergine protocol", "prefer the purple variant");
  store.saveMemoryEmbedding({ memoryId: m_deploy, model: "test-model", vector: vector(1, 0, 0), now: NOW });

  const wordsOnly = store.recallMemories({
    scope: OWNER_MEMORY_SCOPE, query: "eggplant standard", limit: 5, now: NOW,
  });
  expect(wordsOnly).toHaveLength(0);

  const byMeaning = store.recallMemories({
    scope: OWNER_MEMORY_SCOPE,
    query: "eggplant standard",
    limit: 5,
    now: NOW,
    queryVector: { model: "test-model", vector: vector(1, 0, 0) },
  });
  expect(byMeaning.map((m) => m.id)).toEqual([m_deploy]);
});

it("ignores vectors written by a different model rather than comparing them", () => {
  // A cross-model similarity is a number that looks like a score and is not
  // one. The reference system lost its vector recall exactly this way.
  const store = fixture();
  const m_other = remember(store, "aubergine protocol", "prefer the purple variant");
  store.saveMemoryEmbedding({ memoryId: m_other, model: "old-model", vector: vector(1, 0, 0), now: NOW });

  expect(store.recallMemories({
    scope: OWNER_MEMORY_SCOPE, query: "eggplant standard", limit: 5, now: NOW,
    queryVector: { model: "new-model", vector: vector(1, 0, 0) },
  })).toHaveLength(0);
});

it("ignores a vector of a different length from the same model name", () => {
  const store = fixture();
  const m_dim = remember(store, "aubergine protocol", "prefer the purple variant");
  store.saveMemoryEmbedding({ memoryId: m_dim, model: "test-model", vector: vector(1, 0, 0, 0), now: NOW });

  expect(store.recallMemories({
    scope: OWNER_MEMORY_SCOPE, query: "eggplant standard", limit: 5, now: NOW,
    queryVector: { model: "test-model", vector: vector(1, 0, 0) },
  })).toHaveLength(0);
});

it("keeps a keyword match that no vector covers", () => {
  const store = fixture();
  const m_words = remember(store, "aubergine protocol", "prefer the purple variant");

  expect(store.recallMemories({
    scope: OWNER_MEMORY_SCOPE, query: "aubergine", limit: 5, now: NOW,
    queryVector: { model: "test-model", vector: vector(1, 0, 0) },
  }).map((m) => m.id)).toEqual([m_words]);
});

it("round-trips a vector and replaces it on re-embed", () => {
  const store = fixture();
  const m_rt = remember(store, "a subject", "a body");
  store.saveMemoryEmbedding({ memoryId: m_rt, model: "test-model", vector: vector(0, 1, 0), now: NOW });
  store.saveMemoryEmbedding({ memoryId: m_rt, model: "test-model", vector: vector(1, 0, 0), now: NOW + 1 });

  // The replacement is what recall now matches on, not the original.
  expect(store.recallMemories({
    scope: OWNER_MEMORY_SCOPE, query: "unrelated words entirely", limit: 5, now: NOW,
    queryVector: { model: "test-model", vector: vector(1, 0, 0) },
  }).map((m) => m.id)).toEqual([m_rt]);
});

it("lists what still needs embedding, per model, and stops listing it once done", () => {
  const store = fixture();
  const m_a = remember(store, "first", "first body");
  const m_b = remember(store, "second", "second body");
  expect(store.listMemoriesNeedingEmbedding("test-model", 10).map((r) => r.id).sort()).toEqual([m_a, m_b].sort());

  store.saveMemoryEmbedding({ memoryId: m_a, model: "test-model", vector: vector(1, 0), now: NOW });
  expect(store.listMemoriesNeedingEmbedding("test-model", 10).map((r) => r.id)).toEqual([m_b]);
  // A new model starts from nothing, which is what makes a model switch a
  // backfill rather than a silent loss of recall.
  expect(store.listMemoriesNeedingEmbedding("other-model", 10).map((r) => r.id).sort()).toEqual([m_a, m_b].sort());
});

it("recalls exactly as before when no vector is supplied", () => {
  const store = fixture();
  const m_plain = remember(store, "aubergine protocol", "prefer the purple variant");
  store.saveMemoryEmbedding({ memoryId: m_plain, model: "test-model", vector: vector(1, 0, 0), now: NOW });

  expect(store.recallMemories({
    scope: OWNER_MEMORY_SCOPE, query: "eggplant standard", limit: 5, now: NOW,
  })).toHaveLength(0);
});
