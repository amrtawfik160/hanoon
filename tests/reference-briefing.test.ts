import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { MAX_REFERENCE_MAP_CHARACTERS } from "../src/bb/prompts";
import { referenceBriefingFor } from "../src/reference/briefing";
import { openStore, type TelegramAgentStore } from "../src/storage/store";

let fixtureNumber = 0;

const SPEC = `# Billing

Invoices are immutable once issued.

## Refunds

A refund is a new document.

# Access

Only an owner may delete an account.`;

function store(): TelegramAgentStore {
  const { bb } = createFakePluginHost({ pluginId: `telegram-briefing-${fixtureNumber++}` });
  return openStore(bb.storage, bb.storage.kv, () => 2_000);
}

it("costs a project with no specification nothing at all", () => {
  expect(referenceBriefingFor(store(), "proj_1")).toBe("");
});

it("tells a stage what exists, how to read it, and what to do with a conflict", () => {
  const target = store();
  target.saveReferenceDocument({
    scope: "project",
    projectId: "proj_1",
    title: "Product spec",
    source: "telegram:doc_1",
    markdown: SPEC,
    now: 2_000,
  });

  const briefing = referenceBriefingFor(target, "proj_1");

  expect(briefing).toContain("Product spec (this project)");
  expect(briefing).toContain("Billing");
  expect(briefing).toContain("Refunds");
  expect(briefing).toContain("bb telegram-agent reference search");
  expect(briefing).toContain("bb telegram-agent reference show");
  // The section text itself is never in the prompt, only its shape.
  expect(briefing).not.toContain("Invoices are immutable once issued.");
  // The conflict rule, stated as the what-versus-how line it actually is.
  expect(briefing).toMatch(/what to build or what rule holds/);
  expect(briefing).toMatch(/disagrees only about how to build it/);
});

it("marks a global document as applying everywhere", () => {
  const target = store();
  target.saveReferenceDocument({
    scope: "global",
    projectId: null,
    title: "Company guide",
    source: "telegram:doc_2",
    markdown: SPEC,
    now: 2_000,
  });

  expect(referenceBriefingFor(target, "proj_1")).toContain("Company guide (applies to every project)");
});

it("shares one budget across documents rather than granting it to each", () => {
  const target = store();
  const many = Array.from({ length: 30 }, (_, index) => `# Section ${index}\n\nbody text here`).join("\n\n");
  for (const title of ["Spec one", "Spec two", "Spec three"]) {
    target.saveReferenceDocument({
      scope: "project",
      projectId: "proj_1",
      title,
      source: `telegram:${title}`,
      markdown: many,
      now: 2_000,
    });
  }

  const briefing = referenceBriefingFor(target, "proj_1");

  expect(briefing).toContain("Spec one");
  expect(briefing).toContain("Spec three");
  // Three documents share the map budget; the fixed instructions around it are
  // what the rest of the length is.
  const mapPortion = briefing.split("\n").filter((line) => line.startsWith("Section")).join("\n");
  expect(mapPortion.length).toBeLessThanOrEqual(MAX_REFERENCE_MAP_CHARACTERS);
});

it("leaves out a document that has no headings to show", () => {
  const target = store();
  target.saveReferenceDocument({
    scope: "project",
    projectId: "proj_1",
    title: "Loose notes",
    source: "telegram:doc_3",
    markdown: "just a paragraph with no headings at all",
    now: 2_000,
  });

  expect(referenceBriefingFor(target, "proj_1")).toBe("");
});

it("never shows one project the specification of another", () => {
  const target = store();
  target.saveReferenceDocument({
    scope: "project",
    projectId: "proj_1",
    title: "Product spec",
    source: "telegram:doc_1",
    markdown: SPEC,
    now: 2_000,
  });

  expect(referenceBriefingFor(target, "proj_2")).toBe("");
});
