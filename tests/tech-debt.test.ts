import { expect, it } from "vitest";
import { DEBT_MARKERS, analyseTechDebt, type DebtMarker } from "../src/autonomy/audits/tech-debt";

function marker(path: string, kind = "TODO", line = 1): DebtMarker {
  return { path, line, kind, text: `${kind}: something` };
}

it("reports one finding per file rather than one per marker", () => {
  // A file with forty markers is one problem, not forty lines of message.
  const found = analyseTechDebt({
    markers: [marker("src/a.ts"), marker("src/a.ts", "FIXME", 9), marker("src/b.ts")],
  });
  expect(found.map((f) => f.subject).sort()).toEqual(["src/a.ts", "src/b.ts"]);
});

it("counts the markers in each file", () => {
  const found = analyseTechDebt({
    markers: [marker("src/a.ts"), marker("src/a.ts", "TODO", 4), marker("src/a.ts", "HACK", 7)],
  });
  expect(found[0]?.detail).toMatch(/\b3\b/);
});

it("names which kinds a file carries", () => {
  const found = analyseTechDebt({
    markers: [marker("src/a.ts", "TODO"), marker("src/a.ts", "HACK", 3)],
  });
  expect(found[0]?.detail).toContain("TODO");
  expect(found[0]?.detail).toContain("HACK");
});

it("states the bounded scan scope in its findings", () => {
  const found = analyseTechDebt({ markers: [marker("src/a.ts")] });
  expect(found[0]?.detail).toContain("tracked source files only");
  expect(found[0]?.detail).toContain("prose");
  expect(found[0]?.detail).toContain("generated");
});

it("puts the worst file first, because the digest only shows the first few", () => {
  const found = analyseTechDebt({
    markers: [
      marker("src/small.ts"),
      marker("src/big.ts"), marker("src/big.ts", "TODO", 2), marker("src/big.ts", "TODO", 3),
      marker("src/mid.ts"), marker("src/mid.ts", "TODO", 2),
    ],
  });
  expect(found.map((f) => f.subject)).toEqual(["src/big.ts", "src/mid.ts", "src/small.ts"]);
});

it("orders files with equal counts by name so a run is repeatable", () => {
  const found = analyseTechDebt({ markers: [marker("src/b.ts"), marker("src/a.ts")] });
  expect(found.map((f) => f.subject)).toEqual(["src/a.ts", "src/b.ts"]);
});

it("ignores vendored code this repository did not write", () => {
  expect(analyseTechDebt({ markers: [marker("skills/workflow-kit/x/SKILL.md")] })).toEqual([]);
});

it("ignores markers under node_modules", () => {
  expect(analyseTechDebt({ markers: [marker("node_modules/pkg/index.js")] })).toEqual([]);
});

it("finds nothing when there are no markers", () => {
  expect(analyseTechDebt({ markers: [] })).toEqual([]);
});

it("knows which markers it looks for", () => {
  // Pinned so widening the vocabulary is a deliberate change with a test.
  expect([...DEBT_MARKERS]).toEqual(["TODO", "FIXME", "HACK", "XXX"]);
});
