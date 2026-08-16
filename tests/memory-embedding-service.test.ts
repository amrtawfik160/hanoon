import { expect, it, vi } from "vitest";
import { MEMORY_EMBEDDING_MODEL, MemoryEmbeddingService } from "../src/services/memory-embedding-service";

function fakeStore() {
  const saved: { memoryId: string; model: string; dims: number }[] = [];
  let pending: { id: string; subject: string; body: string }[] = [];
  return {
    saved,
    setPending(rows: typeof pending) { pending = rows; },
    store: {
      saveMemoryEmbedding: (i: { memoryId: string; model: string; vector: Float32Array }) =>
        void saved.push({ memoryId: i.memoryId, model: i.model, dims: i.vector.length }),
      listMemoriesNeedingEmbedding: () => pending,
    } as never,
  };
}

const extractor = async (_t: string, _o: unknown) => ({ data: [0.1, 0.2, 0.3] });

it("embeds a memory and tags it with the model that produced it", async () => {
  const f = fakeStore();
  const service = new MemoryEmbeddingService({
    store: f.store, clock: { now: () => 1_000 }, loadExtractor: async () => extractor,
  });
  await expect(service.embedMemory({ id: "m1", subject: "s", body: "b" })).resolves.toBe(true);
  expect(f.saved).toEqual([{ memoryId: "m1", model: MEMORY_EMBEDDING_MODEL, dims: 3 }]);
});

it("costs the semantic signal and nothing else when the model cannot load", async () => {
  // The property that lets this ship as an optional dependency: no model means
  // word-based recall, exactly as before, never a crash.
  const f = fakeStore();
  const warn = vi.fn();
  const service = new MemoryEmbeddingService({
    store: f.store, clock: { now: () => 1_000 }, warn,
    loadExtractor: async () => { throw new Error("module not installed"); },
  });
  await expect(service.embed("anything")).resolves.toBeNull();
  await expect(service.embedMemory({ id: "m1", subject: "s", body: "b" })).resolves.toBe(false);
  expect(f.saved).toEqual([]);
  expect(warn).toHaveBeenCalledTimes(1);
});

it("gives up on loading once rather than retrying per memory", async () => {
  const load = vi.fn(async () => { throw new Error("no"); });
  const service = new MemoryEmbeddingService({
    store: fakeStore().store, clock: { now: () => 1_000 }, loadExtractor: load,
  });
  await service.embed("one");
  await service.embed("two");
  await service.embed("three");
  expect(load).toHaveBeenCalledTimes(1);
});

it("survives a model that loads but then throws", async () => {
  const f = fakeStore();
  const service = new MemoryEmbeddingService({
    store: f.store, clock: { now: () => 1_000 },
    loadExtractor: async () => async () => { throw new Error("tokenizer blew up"); },
  });
  await expect(service.embed("anything")).resolves.toBeNull();
  expect(f.saved).toEqual([]);
});

it("refuses empty text without loading a model at all", async () => {
  const load = vi.fn(async () => extractor);
  const service = new MemoryEmbeddingService({
    store: fakeStore().store, clock: { now: () => 1_000 }, loadExtractor: load,
  });
  await expect(service.embed("   ")).resolves.toBeNull();
  expect(load).not.toHaveBeenCalled();
});

it("backfills memories written before the model existed", async () => {
  const f = fakeStore();
  f.setPending([
    { id: "old1", subject: "a", body: "b" },
    { id: "old2", subject: "c", body: "d" },
  ]);
  let now = 1_000_000;
  const service = new MemoryEmbeddingService({
    store: f.store, clock: { now: () => now }, loadExtractor: async () => extractor,
  });

  await expect(service.processDue()).resolves.toBe(true);
  expect(f.saved.map((s) => s.memoryId)).toEqual(["old1", "old2"]);

  // Paced: embedding must never compete with answering the owner.
  f.setPending([{ id: "old3", subject: "e", body: "f" }]);
  await expect(service.processDue()).resolves.toBe(false);
  now += 61_000;
  await expect(service.processDue()).resolves.toBe(true);
  expect(f.saved.map((s) => s.memoryId)).toEqual(["old1", "old2", "old3"]);
});

it("does not sweep when there is nothing to embed or no model", async () => {
  const f = fakeStore();
  const service = new MemoryEmbeddingService({
    store: f.store, clock: { now: () => 1_000_000 }, loadExtractor: async () => extractor,
  });
  await expect(service.processDue()).resolves.toBe(false);

  const broken = new MemoryEmbeddingService({
    store: f.store, clock: { now: () => 1_000_000 },
    loadExtractor: async () => { throw new Error("no"); },
  });
  await broken.embed("prime the failure");
  await expect(broken.processDue()).resolves.toBe(false);
});
