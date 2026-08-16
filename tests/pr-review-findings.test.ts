import { expect, it } from "vitest";
import {
  analysePrReviewFindings,
  type ReviewThread,
} from "../src/autonomy/audits/pr-review-findings";

function thread(over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    pr: 6,
    prTitle: "Fold every branch into one",
    author: "reviewer",
    body: "This drops the fence check.",
    resolved: false,
    outdated: false,
    ...over,
  };
}

const analyse = (threads: readonly ReviewThread[]) => analysePrReviewFindings({ threads });

it("reports a review thread that was never resolved", () => {
  const found = analyse([thread()]);
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ auditId: "pr-review-findings", subject: "#6" });
  expect(found[0]?.detail).toContain("This drops the fence check.");
});

it("leaves a resolved thread alone", () => {
  expect(analyse([thread({ resolved: true })])).toEqual([]);
});

it("leaves an outdated thread alone", () => {
  // Outdated means the code it pointed at is gone, so the comment no longer
  // describes anything that shipped.
  expect(analyse([thread({ outdated: true })])).toEqual([]);
});

it("groups several unresolved threads on one pull request into one finding", () => {
  const found = analyse([
    thread({ body: "first" }),
    thread({ body: "second" }),
    thread({ body: "third" }),
  ]);
  expect(found).toHaveLength(1);
  expect(found[0]?.detail).toMatch(/\b3\b/);
});

it("keeps pull requests separate", () => {
  const found = analyse([thread({ pr: 6 }), thread({ pr: 7 })]);
  expect(found.map((f) => f.subject).sort()).toEqual(["#6", "#7"]);
});

it("puts the pull request with the most unaddressed findings first", () => {
  const found = analyse([
    thread({ pr: 8 }),
    thread({ pr: 9 }), thread({ pr: 9, body: "b" }),
  ]);
  expect(found.map((f) => f.subject)).toEqual(["#9", "#8"]);
});

it("shortens a long comment rather than putting it all in the message", () => {
  const found = analyse([thread({ body: "x".repeat(400) })]);
  expect((found[0]?.detail ?? "").length).toBeLessThan(200);
});

it("finds nothing when every thread was handled", () => {
  expect(analyse([thread({ resolved: true }), thread({ pr: 7, resolved: true })])).toEqual([]);
});
