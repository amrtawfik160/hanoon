import { expect, it } from "vitest";
import {
  MAX_SECTION_DEPTH,
  MIN_PASSAGE_CHARACTERS,
  buildReferenceMap,
  buildReferencePassages,
  parseReferenceSections,
  renderReferenceMap,
} from "../src/reference/document";

const SPEC = `Overview text before any heading.

# Billing

Invoices are immutable once issued.

## Refunds

A refund is a new document, never an edit.

### Partial refunds

Allowed down to one cent.

# Access

Only an owner may delete an account.`;

it("keeps the text that comes before the first heading", () => {
  const sections = parseReferenceSections(SPEC);

  expect(sections[0]).toEqual({
    path: [],
    level: 0,
    body: "Overview text before any heading.",
  });
});

it("gives every section its heading trail, not just its own heading", () => {
  const sections = parseReferenceSections(SPEC);

  expect(sections.map((section) => section.path)).toEqual([
    [],
    ["Billing"],
    ["Billing", "Refunds"],
    ["Billing", "Refunds", "Partial refunds"],
    ["Access"],
  ]);
  expect(sections[3].body).toBe("Allowed down to one cent.");
});

it("treats a hash inside a fenced block as code rather than a heading", () => {
  const sections = parseReferenceSections([
    "# Config",
    "",
    "```sh",
    "# not a heading",
    "export X=1",
    "```",
    "",
    "Trailing prose.",
  ].join("\n"));

  expect(sections).toHaveLength(1);
  expect(sections[0].path).toEqual(["Config"]);
  expect(sections[0].body).toContain("# not a heading");
});

it("returns nothing for an empty document rather than an empty section", () => {
  expect(parseReferenceSections("")).toEqual([]);
  expect(parseReferenceSections("   \n  ")).toEqual([]);
});

it("keeps the complete Markdown heading trail through level six", () => {
  const deep = ["# a", "## b", "### c", "#### d", "##### e", "###### f", "", "body"].join("\n");
  const sections = parseReferenceSections(deep);
  const last = sections[sections.length - 1];

  expect(last.path).toHaveLength(MAX_SECTION_DEPTH);
  expect(last.path).toEqual(["a", "b", "c", "d", "e", "f"]);
});

it("does not let an unmatched code fence hide every later heading", () => {
  const sections = parseReferenceSections([
    "# Before",
    "",
    "```sh",
    "unfinished example",
    "",
    "# After",
    "",
    "Still part of the document.",
  ].join("\n"));

  expect(sections.map((section) => section.path)).toEqual([["Before"], ["After"]]);
  expect(sections[1].body).toBe("Still part of the document.");
});

it("numbers passages in document order and carries the section path", () => {
  const passages = buildReferencePassages(parseReferenceSections(SPEC));

  expect(passages.map((passage) => passage.ordinal)).toEqual(["1", "2", "3"]);
  expect(passages[0].body).toContain("Overview text");
  // Refunds and Partial refunds sit under Billing, so they fold into it.
  expect(passages[1].path).toEqual(["Billing"]);
  expect(passages[1].body).toContain("Invoices are immutable");
  expect(passages[1].body).toContain("A refund is a new document");
  expect(passages[1].body).toContain("Allowed down to one cent");
  // Access is a sibling, so it keeps its own heading rather than being filed
  // under Billing.
  expect(passages[2].path).toEqual(["Access"]);
  expect(passages[2].body).toBe("Only an owner may delete an account.");
});

it("never folds a short sibling section under the previous heading", () => {
  const passages = buildReferencePassages(parseReferenceSections(
    "# Billing\n\nshort one\n\n# Access\n\nshort two",
  ));

  expect(passages.map((passage) => passage.path)).toEqual([["Billing"], ["Access"]]);
});

it("does not fold across sibling branches after folding a nested child", () => {
  const passages = buildReferencePassages(parseReferenceSections([
    "# Billing",
    "",
    "Billing rules are deliberately long enough to remain the parent passage on their own.",
    "",
    "## Refunds",
    "",
    "Refund rule.",
    "",
    "### Window",
    "",
    "Thirty days.",
    "",
    "## Invoices",
    "",
    "Immutable.",
  ].join("\n")));

  expect(passages.map((passage) => passage.path)).toEqual([
    ["Billing"],
    ["Billing", "Invoices"],
  ]);
  expect(passages[0].body).toContain("Refund rule.");
  expect(passages[0].body).toContain("Thirty days.");
  expect(passages[0].body).not.toContain("Immutable.");
});

it("splits a long section on blank lines, never mid-sentence", () => {
  const paragraph = "x".repeat(300);
  const sections = parseReferenceSections(`# Long\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}`);
  const passages = buildReferencePassages(sections, 700);

  expect(passages).toHaveLength(2);
  expect(passages[0].body).toBe(`${paragraph}\n\n${paragraph}`);
  expect(passages[1].body).toBe(paragraph);
});

it("still stores a single paragraph that is longer than one passage", () => {
  const huge = "y".repeat(500);
  const passages = buildReferencePassages(parseReferenceSections(`# Table\n\n${huge}`), 200);

  expect(passages).toHaveLength(3);
  expect(passages.map((passage) => passage.body.length)).toEqual([200, 200, 100]);
  expect(passages.map((passage) => passage.body).join("")).toBe(huge);
});

it("keeps a short section separate when the previous passage is already full", () => {
  const full = "z".repeat(190);
  const short = "s".repeat(MIN_PASSAGE_CHARACTERS - 1);
  const passages = buildReferencePassages(
    parseReferenceSections(`# One\n\n${full}\n\n# Two\n\n${short}`),
    200,
  );

  expect(passages).toHaveLength(2);
  expect(passages[1].path).toEqual(["Two"]);
});

it("maps what exists without what it says", () => {
  const map = buildReferenceMap(parseReferenceSections(SPEC));

  expect(map.map((entry) => entry.path.join(" > "))).toEqual([
    "",
    "Billing",
    "Billing > Refunds",
    "Billing > Refunds > Partial refunds",
    "Access",
  ]);
  expect(map[0]).toEqual({
    path: [],
    level: 0,
    characters: "Overview text before any heading.".length,
  });
  expect(map[1].characters).toBe("Invoices are immutable once issued.".length);
});

it("drops the deepest headings first so the document's shape survives a small budget", () => {
  const map = buildReferenceMap(parseReferenceSections(SPEC));

  const full = renderReferenceMap(map, 300);
  expect(full).toContain(`(document preface) (${"Overview text before any heading.".length} chars)`);
  expect(full).toContain(`Billing (${"Invoices are immutable once issued.".length} chars)`);
  expect(full).toContain("    Partial refunds (25 chars)");

  const shallower = renderReferenceMap(map, 100);
  expect(shallower).toContain("Billing (35 chars)");
  expect(shallower).toContain("Access (36 chars)");
  expect(shallower).not.toContain("Partial refunds");
  expect(shallower.length).toBeLessThanOrEqual(100);
});

it("renders level-five and level-six headings when the budget permits", () => {
  const deep = ["# a", "## b", "### c", "#### d", "##### e", "###### f", "", "body"].join("\n");
  const rendered = renderReferenceMap(buildReferenceMap(parseReferenceSections(deep)), 400);

  expect(rendered).toContain("        e (0 chars)");
  expect(rendered).toContain("          f (4 chars)");
});

it("says how many sections it dropped rather than appearing to end early", () => {
  const many = [
    "# Governing section\n\nbody",
    ...Array.from({ length: 40 }, (_, index) => `## Detail ${index}\n\nbody`),
  ].join("\n\n");
  const rendered = renderReferenceMap(buildReferenceMap(parseReferenceSections(many)), 120);

  expect(rendered).toMatch(/… and \d+ more sections$/);
  expect(rendered.length).toBeLessThanOrEqual(120);
});

it("keeps every top-level section discoverable instead of cutting off the tail", () => {
  const many = Array.from(
    { length: 18 },
    (_, index) => [
      `# Governing section ${String(index).padStart(2, "0")}`,
      "",
      "body",
      "",
      `## Detail ${index}`,
      "",
      "detail body",
    ].join("\n"),
  ).join("\n\n");
  const rendered = renderReferenceMap(buildReferenceMap(parseReferenceSections(many)), 260);

  for (let index = 0; index < 18; index += 1) {
    expect(rendered, `missing top-level section ${index}`).toContain(String(index).padStart(2, "0"));
  }
  expect(rendered).toMatch(/… and 18 more sections$/);
  expect(rendered.length).toBeLessThanOrEqual(260);
});

it("maps a document preface even when it has no headings", () => {
  expect(renderReferenceMap(buildReferenceMap(parseReferenceSections("just prose")), 100))
    .toBe("(document preface) (10 chars)");
});

it("never exceeds its budget, even when the budget cannot fit one label", () => {
  const map = buildReferenceMap(parseReferenceSections("# A very long title\n\nbody"));

  for (const budget of [0, 1, 8, 20, 40]) {
    expect(renderReferenceMap(map, budget).length).toBeLessThanOrEqual(budget);
  }
});
