import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import plugin from "../server";
import { openStore } from "../src/storage/store";

let pluginNumber = 0;

const SPEC = `# Billing

Invoices are immutable once issued and a refund is always a new document.

# Access

Only an account owner may delete an account.`;

async function loadPlugin() {
  const { bb, harness } = createFakePluginHost({
    pluginId: `telegram-reference-cli-${pluginNumber++}`,
    sdk: { subscribe: () => () => undefined },
  });
  await plugin(bb);
  const store = openStore(bb.storage);
  store.saveReferenceDocument({
    scope: "project",
    projectId: "proj_1",
    title: "Product spec",
    source: "telegram:doc_1",
    markdown: SPEC,
    now: 2_000,
  });
  return { harness, store };
}

function parseJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

it("offers reference as a documented operator command", async () => {
  const { harness } = await loadPlugin();

  expect(harness.registrations.cli?.commands).toEqual(expect.arrayContaining([
    expect.objectContaining({
      name: "reference",
      usage: "bb telegram-agent reference <search|show|list> ... [--project <project-id>] [--json]",
    }),
  ]));
});

it("finds a passage for the project a worker names", async () => {
  const { harness } = await loadPlugin();

  const result = await harness.behavior.runCli(["reference", "search", "refund", "--project", "proj_1", "--json"]);

  expect(result.exitCode).toBe(0);
  const passages = parseJson(result.stdout).passages as Array<Record<string, string>>;
  expect(passages).toHaveLength(1);
  expect(passages[0].sectionPath).toBe("Billing");
  expect(passages[0].body).toContain("a refund is always a new document");
});

it("gives another project nothing, rather than another project's specification", async () => {
  const { harness } = await loadPlugin();

  const result = await harness.behavior.runCli(["reference", "search", "refund", "--project", "proj_2", "--json"]);

  expect(result.exitCode).toBe(0);
  expect(parseJson(result.stdout).passages).toEqual([]);
});

it("shows one passage in full by id and refuses an unknown one", async () => {
  const { harness } = await loadPlugin();
  const found = parseJson(
    (await harness.behavior.runCli(["reference", "search", "refund", "--project", "proj_1", "--json"])).stdout,
  ).passages as Array<Record<string, string>>;

  const shown = await harness.behavior.runCli(["reference", "show", found[0].id, "--json"]);
  expect(shown.exitCode).toBe(0);
  expect(parseJson(shown.stdout).body).toBe(found[0].body);

  const missing = await harness.behavior.runCli(["reference", "show", "nope", "--json"]);
  expect(missing.exitCode).toBe(1);
});

it("lists what governs a project", async () => {
  const { harness } = await loadPlugin();

  const result = await harness.behavior.runCli(["reference", "list", "--project", "proj_1", "--json"]);

  expect(result.exitCode).toBe(0);
  const documents = parseJson(result.stdout).documents as Array<Record<string, unknown>>;
  expect(documents).toHaveLength(1);
  expect(documents[0].title).toBe("Product spec");
  expect(documents[0].version).toBe(1);
});

it("rejects an unknown subcommand rather than doing something else", async () => {
  const { harness } = await loadPlugin();

  const result = await harness.behavior.runCli(["reference", "delete", "--json"]);

  // Two is the input-error exit, so a worker that guesses at a write command
  // gets a refusal rather than a partially applied one.
  expect(result.exitCode).toBe(2);
});
