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
 * The complete result, including titles and instructions, is bounded. Documents
 * that cannot fit are named as omitted rather than making every map uselessly
 * small or letting fixed prose overflow the caller's context allowance.
 */
export function referenceBriefingFor(
  source: ReferenceBriefingSource,
  projectId: string | null,
  budget = MAX_REFERENCE_MAP_CHARACTERS,
): string {
  const documents = source.listReferenceDocuments(projectId);
  if (documents.length === 0 || budget <= 0) return "";

  for (let included = documents.length; included >= 1; included -= 1) {
    const selected = documents.slice(0, included);
    const omitted = documents.length - selected.length;
    const shells: ReferenceBriefing[] = selected.map((document) => ({
      title: document.title,
      scope: document.scope,
      map: "",
    }));
    const overhead = buildReferenceBriefing(shells, omitted).length;
    const mapBudget = budget - overhead;
    if (mapBudget < included) continue;
    const share = Math.floor(mapBudget / included);
    const briefings = selected.map((document) => ({
      title: document.title,
      scope: document.scope,
      map: renderReferenceMap(document.map, share),
    }));
    if (briefings.some((briefing) => briefing.map.length === 0)) continue;
    const rendered = buildReferenceBriefing(briefings, omitted);
    if (rendered.length <= budget) return rendered;
  }
  return "";
}
