import { expect, it } from "vitest";
import {
  AUDIT_FINDINGS_PER_AUDIT_CAP,
  AUDIT_FINDINGS_TOTAL_CAP,
  auditDigest,
  type AuditResult,
} from "../src/autonomy/audit-contract";
import { DEBT_SCAN_SCOPE } from "../src/autonomy/audits/tech-debt";

function findings(auditId: string, count: number): AuditResult {
  return {
    auditId,
    status: "findings",
    findings: Array.from({ length: count }, (_, i) => ({
      auditId,
      subject: `subject-${i}`,
      detail: `detail ${i}`,
    })),
  };
}

const CLEAN_DEBT: AuditResult = { auditId: "tech-debt", status: "ok", findings: [], scope: DEBT_SCAN_SCOPE };
const CLEAN_DOCS: AuditResult = { auditId: "docs-staleness", status: "ok", findings: [] };

it("says nothing when every audit came back clean", () => {
  // A daily check that reports "all fine" every day is a daily interruption.
  expect(auditDigest({ project: "hanoon", results: [CLEAN_DEBT, CLEAN_DOCS] }))
    .toBeNull();
});

it("says nothing when there were no audits at all", () => {
  expect(auditDigest({ project: "hanoon", results: [] })).toBeNull();
});

it("names the project and each audit that found something", () => {
  const text = auditDigest({ project: "hanoon", results: [findings("docs-staleness", 2), CLEAN_DEBT] });
  expect(text).toContain("hanoon");
  expect(text).toMatch(/docs/i);
  expect(text).toMatch(/\b2\b/);
});

it("qualifies a clean bounded debt scan when another audit makes the digest visible", () => {
  const text = auditDigest({
    project: "hanoon",
    results: [CLEAN_DEBT, findings("bug-backlog", 1)],
  }) ?? "";

  expect(text).toContain(`tech-debt: no findings in ${DEBT_SCAN_SCOPE}.`);
});

it("caps how many findings one audit can put in the message", () => {
  const text = auditDigest({
    project: "hanoon",
    results: [findings("tech-debt", AUDIT_FINDINGS_PER_AUDIT_CAP + 20)],
  });
  const shown = [...(text ?? "").matchAll(/subject-\d+/g)].length;
  expect(shown).toBeLessThanOrEqual(AUDIT_FINDINGS_PER_AUDIT_CAP);
});

it("says how many it held back rather than silently truncating", () => {
  // Silent truncation reads as "that is all of them", which is a lie.
  const text = auditDigest({
    project: "hanoon",
    results: [findings("tech-debt", AUDIT_FINDINGS_PER_AUDIT_CAP + 7)],
  });
  expect(text).toMatch(/\b7\b|more/i);
});

it("caps the whole message even when many audits each found a little", () => {
  const many = Array.from({ length: 12 }, (_, i) => findings(`audit-${i}`, 10));
  const text = auditDigest({ project: "hanoon", results: many }) ?? "";
  const shown = [...text.matchAll(/subject-\d+/g)].length;
  expect(shown).toBeLessThanOrEqual(AUDIT_FINDINGS_TOTAL_CAP);
});

it("reports an audit that failed instead of dropping it", () => {
  // An audit that could not run is not an audit that found nothing.
  const text = auditDigest({
    project: "hanoon",
    results: [{ auditId: "bug-backlog", status: "error", findings: [], error: "gh not installed" }],
  });
  expect(text).not.toBeNull();
  expect(text).toMatch(/bug-backlog/);
  expect(text).toMatch(/could not run|failed|gh not installed/i);
});

it("still reports findings when a different audit failed", () => {
  const text = auditDigest({
    project: "hanoon",
    results: [
      findings("docs-staleness", 1),
      { auditId: "bug-backlog", status: "error", findings: [], error: "boom" },
    ],
  }) ?? "";
  expect(text).toMatch(/docs/i);
  expect(text).toMatch(/bug-backlog/);
});
