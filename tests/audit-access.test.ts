import { expect, it } from "vitest";
import type { CommandResult, TerminalRunInput } from "../src/bb/terminal-command";
import { createAuditAccess } from "../src/services/audit-access";
import type { AuditProject } from "../src/services/audit-service";

const PROJECT: AuditProject = { projectId: "project-1", label: "demo" };
const NUL_FILE_MARKER = `${String.fromCharCode(0)}FILE:`;

type CommandResponse = string | CommandResult;
type OutputByTitle = Readonly<Record<string, CommandResponse>>;

function makeAccess(outputs: OutputByTitle = {}) {
  const commands: TerminalRunInput[] = [];
  const access = createAuditAccess({
    sdk: {
      projects: {
        list: async () => [{
          id: PROJECT.projectId,
          kind: "standard",
          sources: [{ hostId: "host-1", path: "/workspace/project", isDefault: true }],
        }],
      },
    },
    store: {
      listEnabledProjectPolicies: () => [{ policy: { projectId: PROJECT.projectId, alias: PROJECT.label } }],
    } as never,
    terminal: {
      run: async (input) => {
        commands.push(input);
        const response = outputs[input.title] ?? "";
        return typeof response === "string"
          ? { outcome: "exited", exitCode: 0, output: response }
          : response;
      },
    },
  });
  return { access, commands };
}

async function readyAccess(outputs: OutputByTitle = {}) {
  const fixture = makeAccess(outputs);
  expect(await fixture.access.listProjects()).toEqual([PROJECT]);
  return fixture;
}

it("regression: keeps every audit command free of NUL bytes", async () => {
  const { access, commands } = await readyAccess({
    "audit: tracked files": "README.md\n",
    "audit: bug backlog": "[]",
    "audit: review threads": "[]",
  });

  await access.readDocs(PROJECT);
  await access.readDebtMarkers(PROJECT);
  await access.readBugBacklog(PROJECT);
  await access.readReviewThreads(PROJECT);

  expect(commands.map(({ command }) => command).every((command) => !command.includes("\0"))).toBe(true);
});

it("keeps the NUL file delimiter in output while preserving document content", async () => {
  const { access, commands } = await readyAccess({
    "audit: tracked files": "docs/guide.md\n",
    "audit: documents": `${NUL_FILE_MARKER}docs/guide.md\nA title with ; [brackets] and \\ escapes\n`,
  });

  const result = await access.readDocs(PROJECT);

  expect(result.docs).toEqual([{
    path: "docs/guide.md",
    text: "A title with ; [brackets] and \\ escapes\n",
  }]);
  const command = commands.find(({ title }) => title === "audit: documents")?.command ?? "";
  expect(command).toContain("\\0FILE:");
  expect(command).not.toContain("\0");
});

it("runs GitHub audits with gh's noninteractive output settings", async () => {
  const { access, commands } = await readyAccess({
    "audit: bug backlog": "[]",
    "audit: review threads": "[]",
  });

  await access.readBugBacklog(PROJECT);
  await access.readReviewThreads(PROJECT);

  for (const title of ["audit: bug backlog", "audit: review threads"]) {
    const command = commands.find((entry) => entry.title === title)?.command ?? "";
    expect(command).toContain("NO_COLOR=1");
    expect(command).toContain("CLICOLOR=0");
    expect(command).toContain("GH_PAGER=cat");
    expect(command).toContain("PAGER=cat");
    expect(command).toContain("GH_SPINNER_DISABLED=1");
    expect(command).toContain("GH_PROMPT_DISABLED=1");
    expect(command).toContain("GH_NO_UPDATE_NOTIFIER=1");
  }
});

it("parses noisy bug JSON without changing printable issue titles", async () => {
  const title = "Fix ; [brackets] \\ escapes and } braces";
  const { access } = await readyAccess({
    "audit: bug backlog": `\u001b[?25l;?\u001b[?25h${JSON.stringify([{
      number: 7,
      title,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    }])}`,
  });

  await expect(access.readBugBacklog(PROJECT)).resolves.toEqual([{
    number: 7,
    title,
    createdAt: Date.parse("2026-01-01T00:00:00Z"),
    updatedAt: Date.parse("2026-01-02T00:00:00Z"),
  }]);
});

it("parses noisy review JSON without changing printable review text", async () => {
  const body = "Please check ; [this] \\ escape and } brace";
  const { access } = await readyAccess({
    "audit: review threads": `\u001b[?25l;?\u001b[?25h${JSON.stringify([{
      number: 8,
      title: "Review ; [brackets]",
      reviews: [{ author: { login: "reviewer" }, body, state: "CHANGES_REQUESTED" }],
    }])}`,
  });

  await expect(access.readReviewThreads(PROJECT)).resolves.toEqual([{
    pr: 8,
    prTitle: "Review ; [brackets]",
    author: "reviewer",
    body,
    resolved: false,
    outdated: false,
  }]);
});

it("reports an actionable audit error when GitHub output has no JSON payload", async () => {
  const { access } = await readyAccess({
    "audit: bug backlog": "\u001b[?25l;? not JSON",
  });

  await expect(access.readBugBacklog(PROJECT)).rejects.toThrow(
    "audit: bug backlog: command output did not contain a valid JSON payload",
  );
});

it("does not treat an empty GitHub response as an empty audit result", async () => {
  const { access } = await readyAccess({ "audit: bug backlog": "" });

  await expect(access.readBugBacklog(PROJECT)).rejects.toThrow(
    "audit: bug backlog: command output did not contain a valid JSON payload",
  );
});

it("limits debt grep to tracked source files and excludes non-source trees", async () => {
  const { access, commands } = await readyAccess();

  await access.readDebtMarkers(PROJECT);

  const command = commands.find(({ title }) => title === "audit: debt markers")?.command ?? "";
  expect(command).toContain("git grep -n -I");
  expect(command).toContain("'*.ts'");
  expect(command).toContain("'*.tsx'");
  expect(command).not.toContain(" -- . ");
  expect(command).not.toContain("|| true");
  expect(command).toContain(":(exclude)node_modules/**");
  expect(command).toContain(":(exclude)dist/**");
  expect(command).toContain(":(exclude)types/**");
});

it("reports a failed tracked-file read instead of treating every document as clean", async () => {
  const { access } = await readyAccess({
    "audit: tracked files": { outcome: "exited", exitCode: 128, output: "fatal: repository unavailable" },
  });

  await expect(access.readDocs(PROJECT)).rejects.toThrow("audit: tracked files: exited 128");
});

it("reports oversized command output instead of treating the audit as clean", async () => {
  const { access } = await readyAccess({
    "audit: debt markers": "x".repeat(2_000_001),
  });

  await expect(access.readDebtMarkers(PROJECT)).rejects.toThrow(
    "audit: debt markers: output exceeded 2000000 bytes",
  );
});
