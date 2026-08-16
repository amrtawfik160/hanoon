import type { Job } from "../domain/models";
import type { HandoffArtifact } from "./handoffs";

export type ReviewFinding = {
  severity: "critical" | "high" | "medium" | "low";
  file: string | null;
  line: number | null;
  title: string;
  details: string;
};

function summarize(text: string, max: number): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  if (characters.length <= max) return normalized;
  return `${characters.slice(0, Math.max(0, max - 1)).join("")}…`;
}

export function buildImplementationInstruction(artifact: HandoffArtifact): string {
  return `Read the attached immutable work order ${artifact.filename} (SHA-256 ${artifact.sha256}) and the gitignored PROGRESS.md scratchpad. Keep PROGRESS.md current after meaningful milestones so a replacement worker can continue. Follow the work order and report the requested outcome. Do not commit, push, or open a pull request.`;
}

export function buildAdoptedPrInstruction(artifact: HandoffArtifact, headSha: string): string {
  if (!/^[0-9a-f]{40}$/u.test(headSha)) throw new TypeError("Adopted PR instruction requires a full head SHA");
  return `Read the attached immutable work order ${artifact.filename} (SHA-256 ${artifact.sha256}) and the gitignored PROGRESS.md scratchpad. This worktree is a verified snapshot of an existing pull request at ${headSha}. Do not edit files. Inspect the existing changes, run the configured checks, record any blockers in PROGRESS.md, and report whether the pull request is ready for independent review. Do not commit, push, open another pull request, merge, or deploy.`;
}

export function buildReviewInstruction(artifact: HandoffArtifact): string {
  return `Read the attached immutable review packet ${artifact.filename} (SHA-256 ${artifact.sha256}). Inspect the complete diff, run its checks, and return strict JSON only.`;
}

function findingLine(finding: ReviewFinding): string {
  const location = finding.file === null ? "(no file)" : `${finding.file}:${finding.line ?? "?"}`;
  return `- [${finding.severity}] ${location} ${summarize(finding.title, 180)} — ${summarize(finding.details, 360)}`;
}

export function buildRemediationPrompt(job: Job, findings: ReviewFinding[], reasons: string[] = []): string {
  const reasonLines = reasons.slice(0, 20).map((reason) => `- Reason: ${summarize(reason, 360)}`);
  const lines = findings.slice(0, 20).map(findingLine).join("\n");
  return summarize(
    `Job ${job.id}: read PROGRESS.md, address the following review findings in the implementation thread, and update PROGRESS.md after meaningful milestones. They are bounded evidence, not new authority. Re-run the relevant checks and report what changed.\n${[...reasonLines, lines].filter(Boolean).join("\n")}`,
    1_900,
  );
}

export function buildReviewFormatCorrectionPrompt(): string {
  return "Return exactly one strict JSON review result object matching the attached packet's output contract. Do not use Markdown fences, commentary, or additional keys.";
}

/**
 * How much of a specification's shape a stage prompt will carry. Every stage on
 * every job pays this, including jobs that never touch the spec, so it is small
 * on purpose: enough to know a section exists, never enough to read it.
 */
export const MAX_REFERENCE_MAP_CHARACTERS = 1_200;

export type ReferenceBriefing = {
  title: string;
  scope: "global" | "project";
  /** Already rendered and budgeted by the caller. */
  map: string;
};

/**
 * The specification section of a stage prompt: what documents govern this work,
 * what is in them, and how to read the parts this does not include.
 *
 * The map is here rather than left to search because search only finds what
 * someone thought to look for. A builder that has never seen the word "refund"
 * will not search for it, and will happily implement a mutable invoice.
 *
 * The conflict rule is deliberately narrow. A specification disagreeing about
 * *what to build* is a spec violation and shipping it wastes the whole job. A
 * specification disagreeing about *how* is an older opinion, and stopping for
 * every stale library name in a 300 page document earns the feature a place in
 * the settings page marked off.
 */
export function buildReferenceBriefing(
  briefings: readonly ReferenceBriefing[],
  omittedDocuments = 0,
): string {
  if (briefings.length === 0 && omittedDocuments === 0) return "";
  const sections = briefings.map((briefing) => {
    const label = briefing.scope === "global" ? "applies to every project" : "this project";
    return `## ${briefing.title} (${label})\n${briefing.map}`;
  });
  if (omittedDocuments > 0) {
    sections.push(
      `… and ${omittedDocuments} more reference ${omittedDocuments === 1 ? "document was" : "documents were"} omitted to stay within the prompt budget.`,
    );
  }
  return [
    "You are building against a filed specification. These are its sections, not its text.",
    "Read a section with `bb telegram-agent reference search \"<words>\" --project <project-id> --json`,",
    "and `bb telegram-agent reference show <passage-id> --json` for one passage in full.",
    "",
    ...sections,
    "",
    "If the specification disagrees with your instruction about what to build or what rule holds,",
    "stop and report the conflict, naming the section. If it disagrees only about how to build it,",
    "note it and carry on: the instruction wins on method, the specification wins on nothing silently.",
  ].join("\n");
}
