import {
  MAX_REFERENCE_MAP_CHARACTERS,
  buildReferenceBriefing,
  type ReferenceBriefing,
} from "../bb/prompts";
import { renderReferenceMap } from "./document";
import type { ReferenceDocumentRecord } from "../storage/reference-repository";

/** The store surface this needs, so a caller can pass a fake in a test. */
export type ReferenceBriefingSource = {
  listReferenceDocuments(projectId: string | null): readonly ReferenceDocumentRecord[];
};

/**
 * The specification briefing for one project's stage prompt, or an empty string
 * when nothing is filed. Empty is the common case and must stay free: a project
 * with no specification should not pay a single character for the feature.
 *
 * The per-document budget is shared out rather than granted in full to each,
 * so filing five documents does not quietly multiply what every stage carries.
 */
export function referenceBriefingFor(
  source: ReferenceBriefingSource,
  projectId: string | null,
  budget = MAX_REFERENCE_MAP_CHARACTERS,
): string {
  const documents = source.listReferenceDocuments(projectId);
  if (documents.length === 0) return "";
  const share = Math.max(80, Math.floor(budget / documents.length));
  const briefings: ReferenceBriefing[] = [];
  for (const document of documents) {
    const map = renderReferenceMap(document.map, share);
    if (map.length === 0) continue;
    briefings.push({ title: document.title, scope: document.scope, map });
  }
  return buildReferenceBriefing(briefings);
}
