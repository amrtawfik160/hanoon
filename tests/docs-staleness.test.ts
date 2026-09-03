import { expect, it } from "vitest";
import { analyseDocsStaleness, type DocObservation } from "../src/autonomy/audits/docs-staleness";

const TRACKED = new Set([
  "src/plugin.ts",
  "src/controller/service.ts",
  "docs/repository-history.md",
  "scripts/verify-skill-bundle.mjs",
]);

function doc(text: string, path = "docs/guide.md"): DocObservation {
  return { path, text };
}

function analyse(text: string, path?: string) {
  return analyseDocsStaleness({ docs: [doc(text, path)], trackedPaths: TRACKED });
}

it("flags a markdown link to a file that no longer exists", () => {
  const found = analyse("See [the old note](gone.md) for background.");
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ auditId: "docs-staleness", subject: "docs/guide.md" });
  expect(found[0]?.detail).toContain("gone.md");
});

it("leaves a markdown link to a file that exists alone", () => {
  expect(analyse("See [history](repository-history.md).")).toEqual([]);
});

it("flags a backticked path that no longer exists", () => {
  const found = analyse("The guard lives in `src/controller/removed.ts` today.");
  expect(found).toHaveLength(1);
  expect(found[0]?.detail).toContain("src/controller/removed.ts");
});

it("leaves a backticked path that exists alone", () => {
  expect(analyse("The plugin entry is `src/plugin.ts`.")).toEqual([]);
});

it.each([
  "Read [the docs](https://example.test/guide.md).",
  "Jump to [the section](#what-is-still-open).",
  "Mail [us](mailto:someone@example.test).",
])("ignores a link that does not point at a repository file: %s", (text) => {
  expect(analyse(text)).toEqual([]);
});

it("ignores paths inside a fenced code block", () => {
  // Fenced blocks hold examples and command lines, where a path that does not
  // exist here is usually the point rather than a mistake.
  const text = [
    "Run it like this:",
    "```",
    "node scripts/example-that-does-not-exist.mjs",
    "```",
  ].join("\n");
  expect(analyse(text)).toEqual([]);
});

it.each([
  "Run `npm run check` before pushing.",
  "Pass `--base-branch trunk` explicitly.",
  "It returns `null` when unknown.",
  "Set `BB_INFERENCE` to override.",
])("ignores backticked text that is not a path: %s", (text) => {
  expect(analyse(text)).toEqual([]);
});

it("reports each missing reference once even when a doc repeats it", () => {
  const found = analyse("`src/gone.ts` is old. See also `src/gone.ts` again.");
  expect(found).toHaveLength(1);
});

it("reports findings per document", () => {
  const found = analyseDocsStaleness({
    docs: [doc("`src/gone.ts`", "docs/a.md"), doc("`src/also-gone.ts`", "docs/b.md")],
    trackedPaths: TRACKED,
  });
  expect(found.map((f) => f.subject).sort()).toEqual(["docs/a.md", "docs/b.md"]);
});

it("finds nothing in a document that references nothing", () => {
  expect(analyse("This note explains the reasoning and names no files.")).toEqual([]);
});

it("resolves a reference relative to the document that makes it", () => {
  // docs/README.md naming ../CONTRIBUTING.md means CONTRIBUTING.md at the root.
  // Comparing the text literally reported every such link as missing.
  const tracked = new Set(["CONTRIBUTING.md", "docs/designs/plan.md"]);
  expect(analyseDocsStaleness({
    docs: [{ path: "docs/README.md", text: "See [how to help](../CONTRIBUTING.md)." }],
    trackedPaths: tracked,
  })).toEqual([]);
});

it("resolves a sibling reference inside the document's own directory", () => {
  const tracked = new Set(["docs/designs/plan.md"]);
  expect(analyseDocsStaleness({
    docs: [{ path: "docs/README.md", text: "See [the plan](designs/plan.md)." }],
    trackedPaths: tracked,
  })).toEqual([]);
});

it("still flags a relative reference that resolves to nothing", () => {
  const tracked = new Set(["CONTRIBUTING.md"]);
  const found = analyseDocsStaleness({
    docs: [{ path: "docs/README.md", text: "See [gone](../MISSING.md)." }],
    trackedPaths: tracked,
  });
  expect(found).toHaveLength(1);
  expect(found[0]?.detail).toContain("MISSING.md");
});

it("does not audit a document that proposes work rather than describing it", () => {
  // A plan or design names files it wants to exist. Reporting those as drift
  // turns every proposal into a permanent complaint.
  expect(analyseDocsStaleness({
    docs: [{ path: "docs/plans/2026-01-01-thing.md", text: "Add `src/domain/order.ts`." }],
    trackedPaths: TRACKED,
  })).toEqual([]);
});

it("does not audit vendored third-party documentation", () => {
  // The skill bundle carries other people's docs, whose example paths describe
  // their own repositories. Auditing them reports drift this repo cannot fix.
  expect(analyseDocsStaleness({
    docs: [{ path: "skills/guards/clean-code-guard/SKILL.md", text: "See `docs/file1.md`." }],
    trackedPaths: TRACKED,
  })).toEqual([]);
});

it("still audits Hanoon's own skill documentation", () => {
  const found = analyseDocsStaleness({
    docs: [{ path: "skills/hanoon/durable-boundary-audit/SKILL.md", text: "See `src/gone.ts`." }],
    trackedPaths: TRACKED,
  });
  expect(found).toHaveLength(1);
});

it("ignores a reference to something outside the tracked tree", () => {
  // dist/server.js is a build artifact: absent from git by design, not drift.
  expect(analyse("The bundle is `dist/server.js`.")).toEqual([]);
});
