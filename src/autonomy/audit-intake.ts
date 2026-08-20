import { createHash } from "node:crypto";
import { isUnsafeProviderText } from "../controller/credential-policy";
import type { AuditFinding, AuditFindingIntake, AuditResult } from "./audit-contract";

/**
 * Turning what the morning audit noticed into work the pipeline can actually do.
 *
 * The audits already report findings; nothing has ever started from one. The gap
 * between "documentation names a file that is gone" and a job that fixes it is a
 * person reading the message and typing a request, which is exactly the person
 * this is meant to stop needing.
 *
 * Two rules shape what crosses that gap.
 *
 * **A finding is only work if it can be stated as an order.** "Twelve markers in
 * this file" is an observation; "resolve these twelve markers" is a job. Where
 * the audit cannot say concretely what to do — because it only counted something,
 * or because the evidence is prose — nothing starts. That is why selection reads
 * the structured evidence beside a finding rather than parsing its sentence.
 *
 * **Small and well-evidenced goes first.** The daily cap is one to four jobs, so
 * what fills it matters more than how much of it is filled. A stale documentation
 * reference names one file and one line to fix; a file full of debt markers names
 * a direction. The first is worth a whole day's budget before the second is worth
 * any of it.
 */

/**
 * How long a finding stays quiet after the job it started finished. Long enough
 * that a fix which did not fully land is not immediately re-attempted, short
 * enough that genuinely unfinished work comes back rather than being forgotten.
 */
export const INTAKE_SUPPRESSION_MS = 14 * 24 * 60 * 60_000;

/**
 * A file carrying more markers than this is a direction rather than a task. The
 * audit reports it and the owner decides; nothing starts it unattended.
 */
export const MAX_INTAKE_DEBT_MARKERS = 3;

/** Bounded, because a work order is a prompt and an issue title is external text. */
const MAX_WORK_ORDER = 1_200;

/**
 * Most concrete first. This is the order the daily cap is spent in, so it is the
 * only place that decides which kind of finding is worth a job today.
 */
const AUDIT_PRIORITY: readonly AuditFindingIntake["kind"][] = ["docs", "bug", "review", "debt"];

export type IntakeWorkOrder = Readonly<{
  auditId: string;
  subject: string;
  /**
   * Identifies the finding across days. Built from what the finding is *about*
   * and never from how the audit phrased it, so a bug that has been stale for
   * one more day, or a file that grew one more marker, is still the same finding.
   */
  fingerprint: string;
  task: string;
}>;

function fingerprintOf(evidence: AuditFindingIntake): string {
  const canonical = evidence.kind === "bug"
    ? `bug-backlog\nissue:${evidence.issue}`
    : evidence.kind === "docs"
      ? `docs-staleness\ndocument:${evidence.document}\nreference:${evidence.reference}`
      : evidence.kind === "review"
        ? `pr-review-findings\npr:${evidence.pr}`
        : `tech-debt\npath:${evidence.path}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32);
}

function flatten(value: string, limit: number): string {
  // Control characters and newlines both come from text this repository did not
  // write, and both would let an issue title restructure the prompt around it.
  const collapsed = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

function workOrderFor(evidence: AuditFindingIntake): string | null {
  switch (evidence.kind) {
    case "docs":
      return [
        `Update the documentation file ${flatten(evidence.document, 200)}.`,
        `It names ${flatten(evidence.reference, 200)}, which this repository no longer tracks.`,
        "Correct the reference to the file that replaced it, or remove it when nothing did,",
        "and check the rest of that document for the same drift. Change nothing else.",
      ].join(" ");
    case "bug":
      return [
        `Fix the bug reported in issue #${evidence.issue}: "${flatten(evidence.title, 300)}".`,
        "Reproduce it first and cover it with a test that fails before the fix.",
        "If it cannot be reproduced, or the code already handles it, stop and say so",
        "instead of changing anything.",
      ].join(" ");
    case "review":
      return [
        `Address the ${evidence.unanswered} review ${evidence.unanswered === 1 ? "comment" : "comments"}`,
        `left unanswered on pull request #${evidence.pr}. The first says:`,
        `"${flatten(evidence.excerpt, 300)}".`,
        "Apply what the comments ask for where it still applies to the current code,",
        "and say plainly in the change which ones no longer do.",
      ].join(" ");
    case "debt":
      // A file with a handful of markers is a task; one with a pile of them is a
      // decision, and this must not make decisions.
      if (evidence.markers > MAX_INTAKE_DEBT_MARKERS) return null;
      return [
        `Resolve the ${evidence.markers} debt ${evidence.markers === 1 ? "marker" : "markers"}`,
        `(${flatten(evidence.kinds.join(", "), 80)}) in ${flatten(evidence.path, 200)}.`,
        "Do the work each marker describes, or delete the marker and say in the change why",
        "it no longer applies. Keep the change to that file unless a marker names another.",
      ].join(" ");
  }
}

function candidate(finding: AuditFinding): IntakeWorkOrder | null {
  const evidence = finding.intake;
  if (evidence === undefined) return null;
  const task = workOrderFor(evidence);
  if (task === null) return null;
  const bounded = flatten(task, MAX_WORK_ORDER);
  // An issue title and a review excerpt are text from outside this repository.
  // A work order carrying credential-shaped material would put it in a job
  // record, a status card, and a worker prompt, so the finding is dropped
  // instead — the digest still reports it to the owner.
  if (bounded.length === 0 || isUnsafeProviderText(bounded)) return null;
  return {
    auditId: finding.auditId,
    subject: finding.subject,
    fingerprint: fingerprintOf(evidence),
    task: bounded,
  };
}

/**
 * Every finding in one sweep that could be started, most concrete first.
 *
 * Nothing here decides whether a job *is* started: the caps, the failure brake,
 * and the ledger all live with the durable state that can answer them. This
 * answers only "what could be worked on", which is a question about the findings
 * alone.
 */
export function intakeWorkOrders(input: Readonly<{
  results: readonly AuditResult[];
}>): readonly IntakeWorkOrder[] {
  const byKind = new Map<AuditFindingIntake["kind"], IntakeWorkOrder[]>();
  const seen = new Set<string>();
  for (const result of input.results) {
    // An audit that could not run found nothing, and must never look like it did.
    if (result.status !== "findings") continue;
    for (const finding of result.findings) {
      const order = candidate(finding);
      if (order === null || finding.intake === undefined || seen.has(order.fingerprint)) continue;
      seen.add(order.fingerprint);
      byKind.set(finding.intake.kind, [...(byKind.get(finding.intake.kind) ?? []), order]);
    }
  }
  // Each audit already sorted its own findings worst-first; that order is kept
  // inside a kind, and the kinds themselves go in priority order.
  return AUDIT_PRIORITY.flatMap((kind) => byKind.get(kind) ?? []);
}
