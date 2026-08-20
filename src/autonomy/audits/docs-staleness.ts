import type { AuditFinding } from "../audit-contract";

/**
 * Documentation that names a file the repository no longer has.
 *
 * What it does: reads each document's markdown links and inline code spans,
 *   keeps the ones that look like repository paths, resolves them relative to
 *   the document that made them, and reports those the repository does not
 *   track. Read-only: it takes text and a file list and returns findings.
 * Cadence: daily. Docs drift over days, never over minutes.
 * Failure modes:
 *   - a document that cannot be read is the caller's problem; this sees only
 *     text that was read successfully
 *   - a path inside a fenced code block is skipped, because a block usually
 *     holds an example or a command line where a non-existent path is the point
 *   - a reference outside the tracked tree is skipped, so build output such as
 *     `dist/server.js` does not read as drift
 *
 * Scope, stated plainly: this catches a document naming a file that is gone.
 * It does not judge whether a document's prose is true. The stale note that
 * prompted these audits claimed two branches were outstanding after one had
 * landed, and no path in it was wrong, so this check would not have caught it.
 * Reading assertions out of prose is not something this can do without
 * guessing, and an audit that guesses is worse than one that stays quiet.
 *
 * Measured on 2026-08-16 against 108 documents at two different commits: zero
 * findings. That is the intended resting state. It earns its place by failing
 * the day a rename or a deletion leaves a reference behind, not by producing
 * something to read every morning.
 */

export type DocObservation = {
  /** Repository-relative path of the document itself. */
  path: string;
  text: string;
};

/**
 * Documents that describe work someone wants to exist rather than work that
 * does. Auditing a plan turns every proposal into a permanent complaint.
 */
export const PROPOSAL_DOC_PREFIXES: readonly string[] = Object.freeze([
  "docs/plans/",
  "docs/designs/",
  "docs/superpowers/plans/",
  "docs/superpowers/specs/",
  ".superpowers/",
]);

/**
 * Documentation this repository carries but did not write. The vendored skill
 * bundles describe their own projects, so their example paths are drift this
 * repository cannot fix and must not be asked to. `skills/hanoon/` is ours and
 * is audited normally.
 */
export const VENDORED_DOC_PREFIXES: readonly string[] = Object.freeze([
  "skills/workflow-kit/",
  "skills/discovery/",
  "skills/delivery/",
  "skills/guards/",
]);

/** A reference has to look like a path before it is worth checking. */
const PATH_SHAPE = /^[\w.@-]+(?:\/[\w.@-]+)*\.[A-Za-z0-9]{1,10}$/;

/** Links that point somewhere other than a file in this repository. */
const NON_REPOSITORY_LINK = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i;

const MARKDOWN_LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const INLINE_CODE = /`([^`\n]+)`/g;
const FENCED_BLOCK = /^```[\s\S]*?^```/gm;

function withoutFencedBlocks(text: string): string {
  return text.replace(FENCED_BLOCK, "");
}

/** Resolves a reference against the document's own directory, or null when it
 *  climbs past the repository root. */
function resolveReference(docPath: string, reference: Reference): string | null {
  const raw = reference.text;
  const segments = raw.startsWith("/")
    ? raw.slice(1).split("/")
    : reference.relativeToDoc
      ? [...docPath.split("/").slice(0, -1), ...raw.split("/")]
      : raw.split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0) return null;
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.length > 0 ? resolved.join("/") : null;
}

/** Every directory that holds at least one tracked file. */
function trackedDirectories(trackedPaths: ReadonlySet<string>): ReadonlySet<string> {
  const directories = new Set<string>();
  for (const path of trackedPaths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return directories;
}

/**
 * A reference and how it should be read.
 *
 * The two markdown syntaxes mean different things in practice. A link is
 * relative to the document that makes it, the way a reader's browser follows
 * it. A path in inline code is prose naming a file in the repository, written
 * from the root, and stays correct wherever the document is moved.
 */
type Reference = { text: string; relativeToDoc: boolean };

function candidateReferences(text: string): readonly Reference[] {
  const body = withoutFencedBlocks(text);
  const references = new Map<string, Reference>();

  for (const [, target] of body.matchAll(MARKDOWN_LINK)) {
    if (target === undefined || NON_REPOSITORY_LINK.test(target)) continue;
    // A link may carry an anchor; the file before it is what must exist.
    const path = target.split("#", 1)[0] ?? "";
    if (path !== "" && PATH_SHAPE.test(path)) {
      references.set(`link:${path}`, { text: path, relativeToDoc: true });
    }
  }

  for (const [, span] of body.matchAll(INLINE_CODE)) {
    const value = (span ?? "").trim();
    // Inline code carries flags, commands and identifiers too, so a path here
    // must have a directory in it before it counts as one.
    if (value.includes("/") && PATH_SHAPE.test(value)) {
      references.set(`code:${value}`, { text: value, relativeToDoc: false });
    }
  }

  return [...references.values()];
}

export function analyseDocsStaleness(input: Readonly<{
  docs: readonly DocObservation[];
  trackedPaths: ReadonlySet<string>;
  proposalPrefixes?: readonly string[];
}>): readonly AuditFinding[] {
  const skipPrefixes = input.proposalPrefixes
    ?? [...PROPOSAL_DOC_PREFIXES, ...VENDORED_DOC_PREFIXES];
  const directories = trackedDirectories(input.trackedPaths);
  const findings: AuditFinding[] = [];

  for (const doc of input.docs) {
    if (skipPrefixes.some((prefix) => doc.path.startsWith(prefix))) continue;
    const reported = new Set<string>();
    for (const reference of candidateReferences(doc.text)) {
      const resolved = resolveReference(doc.path, reference);
      if (resolved === null || input.trackedPaths.has(resolved)) continue;
      const directory = resolved.split("/").slice(0, -1).join("/");
      // Outside the tracked tree entirely: build output, or a path this
      // repository was never responsible for.
      if (directory !== "" && !directories.has(directory)) continue;
      if (reported.has(resolved)) continue;
      reported.add(resolved);
      findings.push({
        auditId: "docs-staleness",
        subject: doc.path,
        detail: `names ${reference.text}, which the repository no longer has`,
        intake: { kind: "docs", document: doc.path, reference: reference.text },
      });
    }
  }
  return findings;
}
