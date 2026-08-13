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
