import type { TelegramAgentStore } from "../storage/store";

/**
 * Turns memory text into vectors, on this machine, so recall can find a memory
 * by what it means rather than only by the words it happens to share.
 *
 * The model is loaded through a dynamic import inside a try/catch, and every
 * path here is fail-silent. That is deliberate and load-bearing: the plugin
 * ships as one bundle with no required runtime dependency, and recall already
 * ranks a corpus with no vectors exactly as it did before vectors existed. So
 * an absent model, a failed download, or a broken load costs the semantic
 * signal and nothing else — never a crash, never a worse ranking than before.
 */

/**
 * Named in every stored row. Recall compares only vectors carrying this exact
 * name, so changing it does not corrupt recall, it schedules a backfill.
 */
export const MEMORY_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

/** Embedding a memory must never delay answering the owner. */
const BACKFILL_BATCH = 16;
const BACKFILL_INTERVAL_MS = 60_000;

type Extractor = (text: string, options: Record<string, unknown>) => Promise<{ data: ArrayLike<number> }>;

export type MemoryEmbeddingDependencies = {
  store: Pick<TelegramAgentStore, "saveMemoryEmbedding" | "listMemoriesNeedingEmbedding">;
  clock: { now(): number };
  /** Overridable so tests never load a model or touch the network. */
  loadExtractor?: () => Promise<Extractor | null>;
  warn?: (message: string) => void;
};

async function defaultExtractor(): Promise<Extractor | null> {
  // Not a static import: the package is optional, and a missing or unbuildable
  // one has to read as "no semantic signal", not as a plugin that will not start.
  const moduleName = "@xenova/transformers";
  const transformers = await import(/* @vite-ignore */ moduleName) as {
    pipeline: (task: string, model: string) => Promise<Extractor>;
  };
  return transformers.pipeline("feature-extraction", MEMORY_EMBEDDING_MODEL);
}

export class MemoryEmbeddingService {
  private extractor: Extractor | null = null;
  private loaded = false;
  /** One failed load is enough; retrying it per memory would stall every turn. */
  private unavailable = false;
  private lastBackfillAt = Number.NEGATIVE_INFINITY;

  public constructor(private readonly dependencies: MemoryEmbeddingDependencies) {}

  public get model(): string {
    return MEMORY_EMBEDDING_MODEL;
  }

  private async extract(): Promise<Extractor | null> {
    if (this.loaded || this.unavailable) return this.extractor;
    try {
      const load = this.dependencies.loadExtractor ?? defaultExtractor;
      this.extractor = await load();
      this.loaded = this.extractor !== null;
      this.unavailable = this.extractor === null;
    } catch (error) {
      this.unavailable = true;
      this.dependencies.warn?.(
        `Memory embeddings are unavailable, so recall stays word-based: ${
          error instanceof Error ? error.message.slice(0, 160) : "unknown"
        }`,
      );
    }
    return this.extractor;
  }

  /**
   * One vector for one piece of text, or null when the model cannot produce
   * one. Null is an ordinary answer here, not an error to handle upstream.
   */
  public async embed(text: string): Promise<Float32Array | null> {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (trimmed.length === 0) return null;
    const extractor = await this.extract();
    if (!extractor) return null;
    try {
      const output = await extractor(trimmed.slice(0, 4_000), { pooling: "mean", normalize: true });
      const vector = Float32Array.from(output.data);
      return vector.length > 0 ? vector : null;
    } catch (error) {
      this.dependencies.warn?.(
        `One memory could not be embedded: ${error instanceof Error ? error.message.slice(0, 160) : "unknown"}`,
      );
      return null;
    }
  }

  /** What a memory is embedded as: subject and body carry different weight in words, not here. */
  public async embedMemory(input: { id: string; subject: string; body: string }): Promise<boolean> {
    const vector = await this.embed(`${input.subject}\n${input.body}`);
    if (!vector) return false;
    this.dependencies.store.saveMemoryEmbedding({
      memoryId: input.id,
      model: MEMORY_EMBEDDING_MODEL,
      vector,
      now: this.dependencies.clock.now(),
    });
    return true;
  }

  /**
   * Embeds memories written before the model existed, in bounded batches.
   *
   * This is what heals the corpus rather than stranding it: memories saved
   * while the model was missing, and every memory in the store on the day this
   * shipped, become findable without anyone re-entering them. It is also what
   * makes a future model change a backfill instead of silent recall loss.
   */
  public async processDue(): Promise<boolean> {
    const now = this.dependencies.clock.now();
    if (now - this.lastBackfillAt < BACKFILL_INTERVAL_MS) return false;
    this.lastBackfillAt = now;
    if (this.unavailable) return false;
    let pending: { id: string; subject: string; body: string }[];
    try {
      pending = this.dependencies.store.listMemoriesNeedingEmbedding(MEMORY_EMBEDDING_MODEL, BACKFILL_BATCH);
    } catch {
      return false;
    }
    if (pending.length === 0) return false;
    let embedded = 0;
    for (const memory of pending) {
      if (await this.embedMemory(memory)) embedded += 1;
      else break;
    }
    return embedded > 0;
  }
}
