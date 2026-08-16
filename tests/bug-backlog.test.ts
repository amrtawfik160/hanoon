import { expect, it } from "vitest";
import {
  BACKLOG_STALE_AFTER_MS,
  analyseBugBacklog,
  type BacklogIssue,
} from "../src/autonomy/audits/bug-backlog";

const NOW = 1_786_850_000_000;
const day = (n: number) => NOW - n * 24 * 60 * 60_000;

function issue(over: Partial<BacklogIssue> = {}): BacklogIssue {
  return { number: 1, title: "something broken", createdAt: day(60), updatedAt: day(60), ...over };
}

const analyse = (issues: readonly BacklogIssue[]) => analyseBugBacklog({ issues, now: NOW });

it("reports a bug that has been open past the stale window", () => {
  const found = analyse([issue({ number: 12, createdAt: day(90), updatedAt: day(90) })]);
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ auditId: "bug-backlog", subject: "#12" });
  expect(found[0]?.detail).toContain("something broken");
});

it("leaves a recently opened bug alone", () => {
  expect(analyse([issue({ createdAt: day(1), updatedAt: day(1) })])).toEqual([]);
});

it("leaves an old bug alone while someone is still working it", () => {
  // Age is not neglect. A long-running bug touched yesterday is being handled.
  expect(analyse([issue({ createdAt: day(200), updatedAt: day(1) })])).toEqual([]);
});

it("reports the most neglected bug first", () => {
  const found = analyse([
    issue({ number: 2, updatedAt: day(40) }),
    issue({ number: 3, updatedAt: day(120) }),
    issue({ number: 4, updatedAt: day(80) }),
  ]);
  expect(found.map((f) => f.subject)).toEqual(["#3", "#4", "#2"]);
});

it("says how long a bug has gone untouched", () => {
  const found = analyse([issue({ updatedAt: day(90) })]);
  expect(found[0]?.detail).toMatch(/\b90\b|\bdays\b/);
});

it("finds nothing in an empty backlog", () => {
  expect(analyse([])).toEqual([]);
});

it("treats an unreadable timestamp as not stale rather than as ancient", () => {
  // A missing date must not manufacture a finding out of nothing.
  expect(analyse([issue({ updatedAt: Number.NaN })])).toEqual([]);
});

it("pins the window so widening it is a deliberate change", () => {
  expect(BACKLOG_STALE_AFTER_MS).toBe(30 * 24 * 60 * 60_000);
});
