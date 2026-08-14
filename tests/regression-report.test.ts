import { describe, expect, it } from "vitest";
import { regressionNotice, regressionTransition } from "../src/services/regression-report";

describe("regression alerting", () => {
  it("stays silent when everything passes", () => {
    expect(regressionTransition({ confirmed: [], reported: [] })).toEqual({ kind: "silent" });
  });

  it("speaks up the first time something breaks", () => {
    expect(regressionTransition({ confirmed: ["unit"], reported: [] }))
      .toEqual({ kind: "regressed", newlyFailing: ["unit"] });
  });

  it("stays silent while the same thing keeps failing", () => {
    expect(regressionTransition({ confirmed: ["unit"], reported: ["unit"] })).toEqual({ kind: "silent" });
  });

  it("speaks up when a second thing breaks on top of a known failure", () => {
    expect(regressionTransition({ confirmed: ["unit", "lint"], reported: ["unit"] }))
      .toEqual({ kind: "regressed", newlyFailing: ["lint"] });
  });

  it("distinguishes a new failure from a different one replacing it", () => {
    // A count-based check would call this "still 1 failure" and stay silent.
    expect(regressionTransition({ confirmed: ["lint"], reported: ["unit"] }))
      .toEqual({ kind: "regressed", newlyFailing: ["lint"] });
  });

  it("reports recovery once everything passes again", () => {
    expect(regressionTransition({ confirmed: [], reported: ["unit"] })).toEqual({ kind: "recovered" });
  });

  it("does not announce recovery for a failure the owner was never told about", () => {
    expect(regressionTransition({ confirmed: [], reported: [] })).toEqual({ kind: "silent" });
  });

  it("ignores ordering and duplicates when comparing", () => {
    expect(regressionTransition({ confirmed: ["lint", "unit", "unit"], reported: ["unit", "lint"] }))
      .toEqual({ kind: "silent" });
  });

  it("writes no message at all when nothing changed", () => {
    expect(regressionNotice({
      alias: "cyndra",
      transition: { kind: "silent" },
      summary: "all checks passed",
    })).toBeNull();
  });

  it("names the newly failing checks in the message", () => {
    const notice = regressionNotice({
      alias: "cyndra",
      transition: { kind: "regressed", newlyFailing: ["unit", "lint"] },
      summary: "unit: 3 failed",
    });

    expect(notice).toContain("cyndra");
    expect(notice).toContain("unit, lint");
    expect(notice).toContain("3 failed");
    expect(notice).toContain("without asking");
  });
});
