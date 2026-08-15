import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "../server";
import { openStore } from "../src/storage/store";
import { policyFixture } from "./helpers";

let pluginNumber = 0;

async function loadPlugin() {
  const { bb, harness } = createFakePluginHost({
    pluginId: `telegram-agent-task11-doctor-${pluginNumber++}`,
    sdk: { subscribe: () => () => undefined },
  });
  await plugin(bb);
  return { bb, harness, store: openStore(bb.storage) };
}

function standardProject() {
  return {
    id: "proj_1",
    kind: "standard",
    name: "Cyndra",
    gitRemoteUrl: "https://github.com/acme/cyndra",
    createdAt: 1,
    updatedAt: 1,
    sources: [
      {
        id: "source_1",
        projectId: "proj_1",
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
        type: "local_path",
        hostId: "host_primary",
        path: "/work/cyndra",
      },
    ],
  };
}

function provider(id = "codex", available = true) {
  return {
    id,
    displayName: "Codex",
    logoUrl: null,
    capabilities: {
      supportsArchive: true,
      supportsRename: true,
      supportsServiceTier: true,
      supportsUserQuestion: true,
      supportsFork: true,
      supportedPermissionModes: ["accept-edits", "auto", "full"],
    },
    composerActions: [],
    available,
  };
}

function installTerminalStubs(
  harness: { sdk: { stub: (path: string, implementation: (...args: never[]) => unknown) => void } },
  outputForCommand: (command: string) => string,
) {
  const commands = new Map<string, string>();
  let terminalNumber = 0;
  harness.sdk.stub("terminals.create", async ({ start }: { start: { command: string } }) => {
    const id = `doctor-terminal-${++terminalNumber}`;
    commands.set(id, start.command);
    return { id };
  });
  harness.sdk.stub("terminals.get", async () => ({ status: "exited", exitCode: 0 }));
  harness.sdk.stub("terminals.output", async ({ terminalId }: { terminalId: string }) => ({
    chunks: [{ seq: 0, dataBase64: Buffer.from(outputForCommand(commands.get(terminalId) ?? ""), "utf8").toString("base64") }],
    nextSeq: 1,
    truncated: false,
  }));
  harness.sdk.stub("terminals.close", async () => undefined);
  return commands;
}

function parseDoctor(stdout: string): { checks: Array<{ name: string; status: string; summary?: string }> } {
  const value: unknown = JSON.parse(stdout);
  expect(value).toMatchObject({ checks: expect.any(Array) });
  return value as { checks: Array<{ name: string; status: string; summary?: string }> };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("reports individual readiness rows for every Telegram, BB, host, provider, and GitHub check", async () => {
  const { bb, harness, store } = await loadPlugin();
  await harness.behavior.setSettings({ botToken: "123:secret-token" });
  store.upsertProjectPolicy(policyFixture(), 1);
  bb.storage.database().prepare(
    "INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at) VALUES (1, '7', '70', 1, NULL)",
  ).run();

  harness.sdk.stub("projects.get", async () => standardProject());
  harness.sdk.stub("projects.defaultExecutionOptions", async () => ({
    providerId: "codex",
    model: "gpt-5",
    serviceTier: "default",
    reasoningLevel: "medium",
    permissionMode: "auto",
  }));
  harness.sdk.stub("providers.list", async () => [provider()]);
  harness.sdk.stub("hosts.get", async () => ({
    id: "host_primary",
    name: "Primary",
    type: "persistent",
    status: "connected",
    maxPermissionMode: "full",
    lastSeenAt: 1,
    lastRejectedProtocolVersion: null,
    createdAt: 1,
    updatedAt: 1,
  }));
  const commands = installTerminalStubs(harness, (command) => {
    if (command.startsWith("gh auth status")) return "Logged in to github.com as operator";
    if (command.startsWith("gh repo view")) return JSON.stringify({ nameWithOwner: "acme/cyndra" });
    return "";
  });

  const result = await harness.behavior.runCli(["doctor", "proj_1", "--json"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const output = parseDoctor(result.stdout);
  expect(output.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
    "plugin activation",
    "token presence",
    "owner pairing",
    "enabled project",
    "production deployment and canary",
    "standard Git project/source",
    "default execution options",
    "provider availability",
    "source host/path",
    "gh auth status",
    "gh repo view",
    "PR merge SDK availability",
  ]));
  expect(output.checks.find((check) => check.name === "plugin activation")?.summary).toMatch(/source=.*build=.*schema=/u);
  expect(output.checks.every((check) => check.status === "pass")).toBe(true);
  expect(commands.size).toBe(2);
  expect([...commands.values()]).toEqual(expect.arrayContaining([
    expect.stringContaining("gh auth status"),
    expect.stringContaining("gh repo view acme/cyndra"),
  ]));
  for (const command of commands.values()) {
    const terminalId = [...commands.entries()].find(([, value]) => value === command)?.[0];
    expect(harness.inspection.sdk.callsTo("terminals.create").find((args) => args[0] && typeof args[0] === "object" && (args[0] as { start?: { command?: string } }).start?.command === command)?.[0]).toMatchObject({
      scope: { kind: "host_path", hostId: "host_primary", cwd: "/work/cyndra" },
    });
    expect(terminalId).toBeTruthy();
  }
  expect(result.stdout).not.toContain("secret-token");
  expect(result.stdout).not.toContain("Logged in to github.com");
});

it("returns bounded pass/fail rows when doctor dependencies are missing or unhealthy", async () => {
  const { harness, store } = await loadPlugin();
  store.upsertProjectPolicy(policyFixture({ production: undefined }), 1);
  harness.sdk.stub("projects.get", async () => ({
    ...standardProject(),
    kind: "personal",
    gitRemoteUrl: null,
    sources: [],
  }));
  harness.sdk.stub("projects.defaultExecutionOptions", async () => null);
  harness.sdk.stub("providers.list", async () => []);
  harness.sdk.stub("hosts.get", async () => {
    throw new Error("host unavailable token=must-not-print");
  });
  installTerminalStubs(harness, () => "gh auth failed bearer super-secret");
  harness.sdk.stub("terminals.get", async () => ({ status: "exited", exitCode: 1 }));

  const result = await harness.behavior.runCli(["doctor", "proj_1", "--json"]);
  expect(result.exitCode).toBe(1);
  const output = parseDoctor(result.stdout);
  expect(output.checks.some((check) => check.name === "token presence" && check.status === "fail")).toBe(true);
  expect(output.checks.some((check) => check.name === "owner pairing" && check.status === "fail")).toBe(true);
  expect(output.checks.some((check) => check.name === "provider availability" && check.status === "fail")).toBe(true);
  expect(output.checks.some((check) => check.name === "production deployment and canary" && check.status === "fail")).toBe(true);
  expect(output.checks.some((check) => check.name === "gh auth status" && check.status === "fail")).toBe(true);
  expect(output.checks.every((check) => (check.summary ?? "").length <= 200)).toBe(true);
  expect(result.stdout).not.toContain("must-not-print");
  expect(result.stdout).not.toContain("super-secret");
  expect(result.stderr).toBe("");
});

it("runs a project-less doctor with only global checks and keeps JSON strict", async () => {
  const { harness } = await loadPlugin();
  const result = await harness.behavior.runCli(["doctor", "--json"]);
  expect(result.exitCode).toBe(1);
  const output = parseDoctor(result.stdout);
  expect(output.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
    "token presence",
    "owner pairing",
    "enabled projects",
  ]));
  expect(output.checks.map((check) => check.name)).not.toContain("gh repo view");
  expect(result.stderr).toBe("");
  expect(() => JSON.parse(result.stdout)).not.toThrow();
  // The credential broker defaults to disabled and must never be the reason
  // an otherwise-unconfigured install fails doctor differently than before
  // this section existed (tests/credential-cli.test.ts covers the isolated,
  // invalid, and secret-handling cases in depth).
  expect(output.checks.find((check) => check.name === "credential broker")).toEqual({
    name: "credential broker",
    status: "disabled",
    summary: "disabled",
  });
});
