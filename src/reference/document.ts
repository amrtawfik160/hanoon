/**
 * Turning a specification into something an agent can work against.
 *
 * The shape here follows from one fact: a 300 page product requirements
 * document does not fit in any context window, and pretending otherwise
 * produces an agent that confidently misses whole sections. So a document
 * becomes two things. A bounded *structural map* that says what exists, and
 * *passages*, retrieved on demand, which say what it actually reads.
 *
 * Retrieval alone is not enough, because retrieval only finds what someone
 * thought to search for. The map is what lets an agent know a section on
 * billing exists before it knows to ask about billing.
 */

/** Markdown defines six heading levels, and the root must survive in every path. */
export const MAX_SECTION_DEPTH = 6;

/**
 * Passages are retrieved and pasted into a worker's context, so this is a
 * context-budget decision rather than a storage one. Large enough to keep a
 * requirement with its rationale, small enough that three hits still fit.
 */
export const MAX_PASSAGE_CHARACTERS = 2_000;

/** A passage under this is folded into its neighbour rather than stored alone. */
export const MIN_PASSAGE_CHARACTERS = 80;

export type ReferenceSection = {
  /** Heading trail from the document root, e.g. `["Billing", "Refunds"]`. */
  path: readonly string[];
  /** Heading level, 1-6, as written. */
  level: number;
  /** Body text under this heading, excluding nested subsections. */
  body: string;
};

export type ReferencePassage = {
  /** Stable within one document version: a one-based passage number. */
  ordinal: string;
  path: readonly string[];
  body: string;
};

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;

type Fence = Readonly<{ marker: "`" | "~"; length: number }>;

function closesFence(line: string, fence: Fence): boolean {
  const trimmed = line.trim();
  if (trimmed.length < fence.length) return false;
  if ([...trimmed].some((character) => character !== fence.marker)) return false;
  return trimmed.length >= fence.length;
}

function closedFenceAt(lines: readonly string[], index: number): Fence | null {
  const opening = FENCE_OPEN.exec(lines[index]);
  if (opening === null) return null;
  const marker = opening[1][0] as "`" | "~";
  const fence = { marker, length: opening[1].length } as const;
  return lines.slice(index + 1).some((line) => closesFence(line, fence)) ? fence : null;
}

function normalizeHeading(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Split Markdown into sections by heading. Text before the first heading is a
 * section with an empty path rather than an error: a specification that opens
 * with two paragraphs of context before its first heading is normal, and
 * dropping that text would lose the part that says what the document is.
 */
export function parseReferenceSections(markdown: string): readonly ReferenceSection[] {
  if (typeof markdown !== "string" || markdown.trim().length === 0) return [];
  const sections: ReferenceSection[] = [];
  const trail: Array<{ level: number; title: string }> = [];
  let current: { path: readonly string[]; level: number; lines: string[] } = {
    path: [],
    level: 0,
    lines: [],
  };
  let fence: Fence | null = null;
  const lines = markdown.split(/\r?\n/);

  const flush = () => {
    const body = current.lines.join("\n").trim();
    if (body.length > 0 || current.path.length > 0) {
      sections.push({ path: current.path, level: current.level, body });
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence !== null) {
      current.lines.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const openingFence = closedFenceAt(lines, index);
    if (openingFence !== null) {
      fence = openingFence;
      current.lines.push(line);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading === null) {
      current.lines.push(line);
      continue;
    }
    flush();
    const level = heading[1].length;
    const title = normalizeHeading(heading[2]);
    while (trail.length > 0 && trail[trail.length - 1].level >= level) trail.pop();
    trail.push({ level, title });
    current = {
      path: trail.map((entry) => entry.title),
      level,
      lines: [],
    };
  }
  flush();
  return sections;
}

/** Break on blank lines so a split never lands mid-sentence. */
function splitBody(body: string, limit: number): readonly string[] {
  if (body.length <= limit) return body.length === 0 ? [] : [body];
  const chunks: string[] = [];
  let pending = "";
  for (const paragraph of body.split(/\n\s*\n/)) {
    const candidate = pending.length === 0 ? paragraph : `${pending}\n\n${paragraph}`;
    if (candidate.length <= limit) {
      pending = candidate;
      continue;
    }
    if (pending.length > 0) chunks.push(pending);
    // A single paragraph over the limit still has to land somewhere, so it is
    // cut on width. Prose this long is a table or a code block, where a hard
    // cut costs less than dropping it.
    pending = "";
    for (let index = 0; index < paragraph.length; index += limit) {
      const slice = paragraph.slice(index, index + limit);
      if (slice.length === limit) chunks.push(slice);
      else pending = slice;
    }
  }
  if (pending.length > 0) chunks.push(pending);
  return chunks;
}

/** Only a subsection may be folded upward; a sibling would lose its heading. */
function descendsFrom(ancestor: readonly string[], candidate: readonly string[]): boolean {
  if (ancestor.length === 0 || candidate.length <= ancestor.length) return false;
  return ancestor.every((title, index) => candidate[index] === title);
}

/**
 * Passages in document order, numbered so a citation survives being quoted
 * somewhere else. A section shorter than the floor joins the previous passage
 * rather than becoming a passage of its own, because a lone heading with one
 * line under it retrieves badly and reads worse.
 *
 * It joins only when it sits *under* that passage's heading. Folding a sibling
 * upward would file its text beneath a heading it does not belong to, and a
 * citation pointing at the wrong section is worse than one extra passage: it
 * is the failure the section path exists to prevent.
 */
export function buildReferencePassages(
  sections: readonly ReferenceSection[],
  limit = MAX_PASSAGE_CHARACTERS,
): readonly ReferencePassage[] {
  const passages: ReferencePassage[] = [];
  let previousSectionPath: readonly string[] | null = null;
  for (const section of sections) {
    if (section.body.length === 0) {
      previousSectionPath = section.path;
      continue;
    }
    const previous = passages[passages.length - 1];
    if (
      previous !== undefined &&
      previousSectionPath !== null &&
      descendsFrom(previous.path, section.path) &&
      descendsFrom(previousSectionPath, section.path) &&
      section.body.length < MIN_PASSAGE_CHARACTERS &&
      previous.body.length + section.body.length <= limit
    ) {
      passages[passages.length - 1] = {
        ...previous,
        body: `${previous.body}\n\n${section.body}`,
      };
      previousSectionPath = section.path;
      continue;
    }
    for (const body of splitBody(section.body, limit)) {
      passages.push({ ordinal: String(passages.length + 1), path: section.path, body });
    }
    previousSectionPath = section.path;
  }
  return passages;
}

export type ReferenceMapEntry = {
  path: readonly string[];
  level: number;
  /** How much sits under this heading, so an agent can judge before fetching. */
  characters: number;
};

/**
 * What exists in the document, without what it says. This is the half that is
 * always affordable to carry.
 */
export function buildReferenceMap(sections: readonly ReferenceSection[]): readonly ReferenceMapEntry[] {
  return sections.map((section) => ({
    path: section.path,
    level: section.level,
    characters: section.body.length,
  }));
}

function renderMapEntry(entry: ReferenceMapEntry): string {
  const label = entry.path.length === 0
    ? "(document preface)"
    : `${"  ".repeat(Math.max(0, entry.level - 1))}${entry.path[entry.path.length - 1]}`;
  return `${label} (${entry.characters} chars)`;
}

function omissionLine(count: number): string {
  return `… and ${count} more ${count === 1 ? "section" : "sections"}`;
}

function tinyOmission(count: number, budget: number): string {
  if (budget <= 0) return "";
  const full = omissionLine(count);
  if (full.length <= budget) return full;
  const compact = `… +${count}`;
  if (compact.length <= budget) return compact;
  return "…".slice(0, budget);
}

function compactIdentity(label: string, width: number): string {
  if (label.length <= width) return label;
  if (width <= 0) return "";
  if (width === 1) return "…";
  const suffixWidth = Math.min(5, Math.max(1, Math.floor((width - 1) / 3)));
  const prefixWidth = width - suffixWidth - 1;
  return `${label.slice(0, prefixWidth)}…${label.slice(-suffixWidth)}`;
}

/** Fairly compresses every top-level identity instead of preserving only a prefix. */
function renderCompactTopLevel(
  entries: readonly ReferenceMapEntry[],
  omitted: number,
  budget: number,
): string {
  if (entries.length === 0 || budget <= 0) return "";
  const omission = omitted > 0 ? tinyOmission(omitted, budget) : "";
  const omissionCharacters = omission.length > 0 ? omission.length + 1 : 0;
  const available = budget - omissionCharacters;
  if (available <= 0) return tinyOmission(entries.length + omitted, budget);
  const labels = entries.map((entry) =>
    entry.path.length === 0 ? "(document preface)" : entry.path.at(-1)!);
  const complete = labels.join("\n");
  if (complete.length <= available) {
    return omission.length > 0 ? `${complete}\n${omission}` : complete;
  }
  const separatorCharacters = entries.length - 1;
  const labelCharacters = available - separatorCharacters;
  if (labelCharacters < entries.length) return tinyOmission(entries.length + omitted, budget);
  const baseWidth = Math.floor(labelCharacters / entries.length);
  let remainder = labelCharacters % entries.length;
  const compact = entries.map((entry, index) => {
    const width = baseWidth + (remainder-- > 0 ? 1 : 0);
    return compactIdentity(labels[index]!, width);
  }).join("\n");
  return omission.length > 0 ? `${compact}\n${omission}` : compact;
}

function renderSelection(
  selected: readonly ReferenceMapEntry[],
  omitted: number,
): string {
  const lines = selected.map(renderMapEntry);
  if (omitted > 0) lines.push(omissionLine(omitted));
  return lines.join("\n");
}

/**
 * The map as text for a prompt, deepest levels dropped first when it will not
 * fit. Truncating by depth rather than by tail keeps the document's shape
 * intact: an agent that can see every top-level heading and no detail is far
 * better off than one that sees the first third in full and does not know the
 * rest exists.
 */
export function renderReferenceMap(
  entries: readonly ReferenceMapEntry[],
  budget: number,
): string {
  if (entries.length === 0 || budget <= 0) return "";
  for (let depth = MAX_SECTION_DEPTH; depth >= 1; depth -= 1) {
    const selected = entries.filter((entry) => entry.level === 0 || entry.level <= depth);
    const rendered = renderSelection(selected, entries.length - selected.length);
    if (rendered.length <= budget) return rendered;
  }
  const topLevel = entries.filter((entry) => entry.level <= 1);
  return renderCompactTopLevel(topLevel, entries.length - topLevel.length, budget);
}
