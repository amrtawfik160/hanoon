/**
 * Turning a specification into something an agent can work against.
 *
 * The shape here follows from one fact: a 300 page product requirements
 * document does not fit in any context window, and pretending otherwise
 * produces an agent that confidently misses whole sections. So a document
 * becomes two things. A *structural map*, small enough to carry whenever the
 * document is in scope, which says what exists. And *passages*, retrieved on
 * demand, which say what it actually reads.
 *
 * Retrieval alone is not enough, because retrieval only finds what someone
 * thought to search for. The map is what lets an agent know a section on
 * billing exists before it knows to ask about billing.
 */

/** Deep enough for a real specification, shallow enough to stay legible. */
export const MAX_SECTION_DEPTH = 4;

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
  /** Stable within one document version: `4.2` style ordinal path. */
  ordinal: string;
  path: readonly string[];
  body: string;
};

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
/** A fence toggles verbatim mode; a `#` inside one is code, not a heading. */
const FENCE = /^\s*(?:```|~~~)/;

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
  let fenced = false;

  const flush = () => {
    const body = current.lines.join("\n").trim();
    if (body.length > 0 || current.path.length > 0) {
      sections.push({ path: current.path, level: current.level, body });
    }
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? null : HEADING.exec(line);
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
      path: trail.slice(-MAX_SECTION_DEPTH).map((entry) => entry.title),
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
  for (const section of sections) {
    if (section.body.length === 0) continue;
    const previous = passages[passages.length - 1];
    if (
      previous !== undefined &&
      descendsFrom(previous.path, section.path) &&
      section.body.length < MIN_PASSAGE_CHARACTERS &&
      previous.body.length + section.body.length <= limit
    ) {
      passages[passages.length - 1] = {
        ...previous,
        body: `${previous.body}\n\n${section.body}`,
      };
      continue;
    }
    for (const body of splitBody(section.body, limit)) {
      passages.push({ ordinal: String(passages.length + 1), path: section.path, body });
    }
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
  return sections
    .filter((section) => section.path.length > 0)
    .map((section) => ({
      path: section.path,
      level: section.level,
      characters: section.body.length,
    }));
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
  if (entries.length === 0) return "";
  for (let depth = MAX_SECTION_DEPTH; depth >= 1; depth -= 1) {
    const lines = entries
      .filter((entry) => entry.level <= depth)
      .map((entry) => `${"  ".repeat(Math.max(0, entry.level - 1))}${entry.path[entry.path.length - 1]}`);
    const rendered = lines.join("\n");
    if (rendered.length <= budget) return rendered;
  }
  const topLevel = entries.filter((entry) => entry.level <= 1).map((entry) => entry.path[0]);
  // Even the top level can overflow on a document with hundreds of chapters.
  // Saying how many were dropped keeps the agent from reading the shortfall as
  // "the document ends here".
  const kept: string[] = [];
  let used = 0;
  for (const title of topLevel) {
    if (used + title.length + 1 > budget - 40) break;
    kept.push(title);
    used += title.length + 1;
  }
  const dropped = topLevel.length - kept.length;
  return dropped > 0 ? `${kept.join("\n")}\n… and ${dropped} more sections` : kept.join("\n");
}
