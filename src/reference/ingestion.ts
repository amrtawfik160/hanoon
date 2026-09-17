import type { IngestionSource } from "../domain/ingestion-source";
import {
  buildReferenceMap,
  buildReferencePassages,
  parseReferenceSections,
  type ReferenceMapEntry,
  type ReferencePassage,
} from "./document";

/** An outside reading projected from one ingestion source. */
export type IngestionReading = Readonly<{
  source: string;
  capturedAt: number;
  excerpt: string;
  map: readonly ReferenceMapEntry[];
  passages: readonly ReferencePassage[];
}>;

/**
 * Read one ingestion source as an outside reading with a reference-document
 * map and passages. Disabled sources, the default, yield nothing.
 */
export function readIngestionSource(source: IngestionSource): IngestionReading | null {
  if (source.status !== "enabled") return null;
  const sections = parseReferenceSections(source.excerpt);
  return {
    source: source.chatRef,
    capturedAt: source.capturedAt,
    excerpt: source.excerpt,
    map: buildReferenceMap(sections),
    passages: buildReferencePassages(sections),
  };
}

export function readIngestionRoute(
  sources: readonly IngestionSource[],
): readonly IngestionReading[] {
  const readings: IngestionReading[] = [];
  for (const source of sources) {
    const reading = readIngestionSource(source);
    if (reading !== null) readings.push(reading);
  }
  return readings;
}
