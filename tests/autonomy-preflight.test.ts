import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "../server";
import { openStore } from "../src/storage/store";
import { projectPolicySchema } from "../src/domain/models";

/**
 * A project may only declare that it merges unattended if GitHub itself already
 * refuses a merge that has not passed something. These cover the boundary from
 * both sides: what the enable command refuses to store, and what the doctor
 * reports about a project that is already storing it.
 */

let pluginNumber = 0;

async function loadPlugin() {
  const { bb, harness } = createFakePluginHost({
    pluginId: `telegram-agent-autonomy-preflight-${pluginNumber++}`,
    sdk: { subscribe: () => () => undefined },
  });
  await plugin(bb);
  return { bb, harness, store: openStore(bb.storage) };
}

function projectFixture() {
  return {
    id: "proj_1",
    kind: "standard",
    name: "Cyndra",
    gitRemoteUrl: "git@github.com:acme/cyndra.git",
    createdAt: 1,
    updatedAt: 1,
    sources: [{
      id: "source_1",
      projectId: "proj_1",
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
      type: "local_path",
      hostId: "host_primary",
      path: "/work/cyndra",
    }],
  };
}

function branchesFixture() {
  return {
    branches: ["main"],
    branchesTruncated: false,
    checkout: { kind: "branch", branchName: "main", headSha: null },
    defaultBranch: "main",
    defaultBranchRelation: "equal",
    hasUncommittedChanges: false,
    operation: { kind: "none" },
    originDefaultBranch: "main",
    remoteBranches: ["main"],
    remoteBranchesTruncated: false,
    selectedBranch: null,
    defaultWorktreeBaseBranch: "main",
  };
}

type GhReply = { exitCode: number; output: string };

type Harness = { sdk: { stub: (path: string, implementation: (...args: never[]) => unknown) => void } };

/**
 * Drives the real terminal runner rather than stubbing around it, so the
 * commands under test are the exact strings a source host would receive. The
 * runner learns a command's exit code from a marker the shell prints, so the
 * stub echoes that marker back with the reply.
 */
function installGhStubs(harness: Harness, reply: (command: string) => GhReply) {
  const issued: string[] = [];
  const outputs = new Map<string, string>();
  let terminalNumber = 0;
  harness.sdk.stub("terminals.create", async ({ start }: { start: { command: string } }) => {
    const id = `preflight-terminal-${++terminalNumber}`;
    const marker = /__BB_TELEGRAM_AGENT_RESULT_[0-9a-f]+__/.exec(start.command)?.[0] ?? "";
    issued.push(start.command);
    const answer = reply(start.command);
    outputs.set(id, `${answer.output}\n${marker}:${answer.exitCode}\n`);
    return { id };
  });
  harness.sdk.stub("terminals.get", async () => ({ status: "running", exitCode: null }));
  harness.sdk.stub("terminals.output", async ({ terminalId }: { terminalId: string }) => ({
    chunks: [{
      seq: 0,
      dataBase64: Buffer.from(outputs.get(terminalId) ?? "", "utf8").toString("base64"),
    }],
    nextSeq: 1,
    truncated: false,
  }));
  harness.sdk.stub("terminals.close", async () => undefined);
  return issued;
}

function ghApiFor(commands: Readonly<Record<string, GhReply>>): (command: string) => GhReply {
  return (command) => {
    for (const [path, reply] of Object.entries(commands)) {
      if (command.includes(path)) return reply;
    }
    return { exitCode: 1, output: "gh: Not Found (HTTP 404)" };
  };
}

const PROTECTION_PATH = "repos/acme/cyndra/branches/main/protection";
const RULES_PATH = "repos/acme/cyndra/rules/branches/main";
const RULESET_PATH = "repos/acme/cyndra/rulesets/9";

function protectionReply(input: { contexts?: string[]; enforceAdmins?: boolean } = {}): GhReply {
  return {
    exitCode: 0,
    output: JSON.stringify({
      required_status_checks: { strict: true, contexts: input.contexts ?? ["unit"] },
      enforce_admins: { enabled: input.enforceAdmins ?? true },
    }),
  };
}

function rulesReply(contexts: string[], rulesetId = 9): GhReply {
  return {
    exitCode: 0,
    output: JSON.stringify(contexts.length === 0 ? [] : [{
      type: "required_status_checks",
      ruleset_id: rulesetId,
      ruleset_source_type: "Repository",
      parameters: { required_status_checks: contexts.map((context) => ({ context })) },
    }]),
  };
}

function policyJson(autonomy: Record<string, unknown> | undefined, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    projectId: "proj_1",
    alias: "cyndra",
    enabled: true,
    githubRepository: "acme/cyndra",
    baseBranch: "main",
    implementation: { model: "implementation-model" },
    review: { model: "review-model" },
    validationCommands: [{ name: "unit", command: "npm test", timeoutMs: 600_000 }],
    production: {
      deployCommands: [{ name: "deploy", command: "npm run deploy", timeoutMs: 60_000 }],
      canaryCommands: [{ name: "canary", command: "npm run canary", timeoutMs: 60_000 }],
      rollbackCommand: { name: "rollback", command: "npm run rollback", timeoutMs: 60_000 },
      convexDeployRequired: false,
    },
    requiredChecks: ["unit"],
    outputRedactionPatterns: [],
    mergeMethod: "squash",
    ...(autonomy === undefined ? {} : { autonomy }),
    ...overrides,
  });
}

function stubProject(harness: Harness) {
  harness.sdk.stub("projects.get", async () => projectFixture());
  harness.sdk.stub("projects.branches", async () => branchesFixture());
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("stores an unattended merge grant when the base branch requires a status check", async () => {
  const { harness, store } = await loadPlugin();
  stubProject(harness);
  const issued = installGhStubs(harness, ghApiFor({ [PROTECTION_PATH]: protectionReply() }));

  const result = await harness.behavior.runCli([
    "project", "enable", "proj_1",
    "--policy-json", policyJson({ unattendedMerge: true }),
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(store.getProjectPolicy("proj_1")?.policy.autonomy).toMatchObject({ unattendedMerge: true });
  expect(JSON.parse(result.stdout)).toMatchObject({ warnings: [] });
  expect(issued.some((command) => command.includes(PROTECTION_PATH))).toBe(true);
});

it("refuses an unattended merge grant on a branch with no protection at all", async () => {
  // The whole point of the grant is that nothing human is left in the path.
  // If GitHub will not refuse a bad merge either, this plugin's own gates are
  // the only thing between a broken change and the trunk.
  const { harness, store } = await loadPlugin();
  stubProject(harness);
  installGhStubs(harness, () => ({ exitCode: 1, output: "gh: Not Found (HTTP 404) token=must-not-print" }));

  const result = await harness.behavior.runCli([
    "project", "enable", "proj_1",
    "--policy-json", policyJson({ unattendedMerge: true }),
  ]);

  expect(result.exitCode).toBe(2);
  expect(store.getProjectPolicy("proj_1")).toBeNull();
  expect(result.stderr).toContain("acme/cyndra@main");
  expect(result.stderr).toContain("required status check");
  expect(result.stderr).not.toContain("HTTP 404");
  expect(result.stderr).not.toContain("must-not-print");
});

it("refuses an unattended merge grant when protection exists but requires no check", async () => {
  const { harness, store } = await loadPlugin();
  stubProject(harness);
  installGhStubs(harness, ghApiFor({
    [PROTECTION_PATH]: protectionReply({ contexts: [] }),
    [RULES_PATH]: rulesReply([]),
  }));

  const result = await harness.behavior.runCli([
    "project", "enable", "proj_1",
    "--policy-json", policyJson({ unattendedMerge: true }),
  ]);

  expect(result.exitCode).toBe(2);
  expect(store.getProjectPolicy("proj_1")).toBeNull();
  expect(result.stderr).toContain("at least one required status check");
});

it("refuses a merge-without-production grant the same way", async () => {
  const { harness, store } = await loadPlugin();
  stubProject(harness);
  installGhStubs(harness, () => ({ exitCode: 1, output: "gh: Not Found (HTTP 404)" }));

  const result = await harness.behavior.runCli([
    "project", "enable", "proj_1",
    "--policy-json", policyJson({ mergeWithoutProduction: true }, {
      production: undefined,
      regression: { commands: [{ name: "unit", command: "npm test", timeoutMs: 600_000 }] },
    }),
  ]);

  expect(result.exitCode).toBe(2);
  expect(store.getProjectPolicy("proj_1")).toBeNull();
});

it("accepts the grant with a warning when protection does not bind administrators", async () => {
  // This plugin merges with an owner-scoped token, and GitHub exempts admins
  // from rules that do not enforce against them. The protection is real, so
  // this is the operator's to close rather than a reason to refuse.
  const { harness, store } = await loadPlugin();
  stubProject(harness);
  installGhStubs(harness, ghApiFor({
    [PROTECTION_PATH]: protectionReply({ enforceAdmins: false }),
  }));

  const result = await harness.behavior.runCli([
    "project", "enable", "proj_1",
    "--policy-json", policyJson({ unattendedMerge: true }),
  ]);

  expect(result.exitCode).toBe(0);
  expect(store.getProjectPolicy("proj_1")?.policy.autonomy).toMatchObject({ unattendedMerge: true });
  expect(result.stdout).toContain("Warning:");
  expect(result.stdout).toContain("Admin enforcement is off");
});

it("accepts required checks carried by a ruleset instead of branch protection", async () => {
  const { harness, store } = await loadPlugin();
  stubProject(harness);
  const issued = installGhStubs(harness, ghApiFor({
    [RULES_PATH]: rulesReply(["unit"]),
    [RULESET_PATH]: { exitCode: 0, output: JSON.stringify({ id: 9, enforcement: "active", bypass_actors: [] }) },
  }));

  const result = await harness.behavior.runCli([
    "project", "enable", "proj_1",
    "--policy-json", policyJson({ unattendedMerge: true }),
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(store.getProjectPolicy("proj_1")?.policy.autonomy).toMatchObject({ unattendedMerge: true });
  expect(JSON.parse(result.stdout)).toMatchObject({ warnings: [] });
  expect(issued.some((command) => command.includes(RULESET_PATH))).toBe(true);
});

it("warns when a ruleset lets someone bypass the checks it requires", async () => {
  const { harness } = await loadPlugin();
  stubProject(harness);
  installGhStubs(harness, ghApiFor({
    [RULES_PATH]: rulesReply(["unit"]),
    [RULESET_PATH]: {
      exitCode: 0,
      output: JSON.stringify({ id: 9, enforcement: "active", bypass_actors: [{ actor_id: 5, actor_type: "Team" }] }),
    },
  }));

  const result = await harness.behavior.runCli([
    "project", "enable", "proj_1",
    "--policy-json", policyJson({ unattendedMerge: true }),
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Admin enforcement is off");
});

function stubDoctorEnvironment(harness: Harness) {
  stubProject(harness);
  harness.sdk.stub("projects.defaultExecutionOptions", async () => ({
    providerId: "codex",
    model: "gpt-5",
    serviceTier: "default",
    reasoningLevel: "medium",
    permissionMode: "auto",
  }));
  harness.sdk.stub("providers.list", async () => [{
    id: "codex",
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
    available: true,
  }]);
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
}

const DOCTOR_GH: Readonly<Record<string, GhReply>> = {
  "gh auth status": { exitCode: 0, output: "Logged in" },
  "gh repo view": { exitCode: 0, output: JSON.stringify({ nameWithOwner: "acme/cyndra" }) },
};

function doctorRows(stdout: string): Map<string, { status: string; summary: string }> {
  const parsed = JSON.parse(stdout) as { checks: Array<{ name: string; status: string; summary: string }> };
  return new Map(parsed.checks.map((check) => [check.name, { status: check.status, summary: check.summary }]));
}

function storeAutonomyPolicy(
  store: ReturnType<typeof openStore>,
  autonomy: Record<string, unknown> | undefined,
  overrides: Record<string, unknown> = {},
) {
  store.upsertProjectPolicy(projectPolicySchema.parse(JSON.parse(policyJson(autonomy, overrides))), 1);
}

it("reports what an unattended merge on this project is resting on", async () => {
  const { harness, store } = await loadPlugin();
  await harness.behavior.setSettings({ botToken: "123:secret-token" });
  storeAutonomyPolicy(store, { unattendedMerge: true }, {
    production: {
      deployCommands: [{ name: "deploy", command: "npm run deploy", timeoutMs: 60_000 }],
      canaryCommands: [{ name: "canary", command: "npm run canary", timeoutMs: 60_000 }],
      healthCommands: [{ name: "health", command: "npm run health", timeoutMs: 60_000 }],
      rollbackCommand: { name: "rollback", command: "npm run rollback", timeoutMs: 60_000 },
      convexDeployRequired: false,
    },
    regression: { commands: [{ name: "unit", command: "npm test", timeoutMs: 600_000 }] },
  });
  stubDoctorEnvironment(harness);
  installGhStubs(harness, ghApiFor({ ...DOCTOR_GH, [PROTECTION_PATH]: protectionReply() }));

  const result = await harness.behavior.runCli(["doctor", "proj_1", "--json"]);

  const rows = doctorRows(result.stdout);
  expect(rows.get("autonomy: branch protection")?.status).toBe("pass");
  expect(rows.get("autonomy: required checks")?.status).toBe("pass");
  expect(rows.get("autonomy: rollback command")?.status).toBe("pass");
  expect(rows.get("autonomy: production health checks")?.status).toBe("pass");
  expect(rows.get("autonomy: regression checks")?.status).toBe("pass");
  expect(result.stdout).not.toContain("secret-token");
});

it("fails the autonomy branch-protection row when GitHub enforces nothing", async () => {
  const { harness, store } = await loadPlugin();
  storeAutonomyPolicy(store, { unattendedMerge: true });
  stubDoctorEnvironment(harness);
  installGhStubs(harness, ghApiFor({ ...DOCTOR_GH }));

  const result = await harness.behavior.runCli(["doctor", "proj_1", "--json"]);

  expect(result.exitCode).toBe(1);
  const rows = doctorRows(result.stdout);
  expect(rows.get("autonomy: branch protection")?.status).toBe("fail");
  expect(rows.get("autonomy: branch protection")?.summary).not.toContain("HTTP");
});

it("warns rather than fails on the gaps an operator can still close", async () => {
  // Admin enforcement, health checks, and regression commands are all real
  // gaps, and none of them means the project cannot work. A doctor that failed
  // on advice would train an operator to ignore the rows that matter.
  const { bb, harness, store } = await loadPlugin();
  await harness.behavior.setSettings({ botToken: "123:secret-token" });
  bb.storage.database().prepare(
    "INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at) VALUES (1, '7', '70', 1, NULL)",
  ).run();
  storeAutonomyPolicy(store, { unattendedMerge: true });
  stubDoctorEnvironment(harness);
  installGhStubs(harness, ghApiFor({
    ...DOCTOR_GH,
    [PROTECTION_PATH]: protectionReply({ enforceAdmins: false }),
  }));

  const result = await harness.behavior.runCli(["doctor", "proj_1", "--json"]);

  const rows = doctorRows(result.stdout);
  expect(rows.get("autonomy: branch protection")?.status).toBe("warn");
  expect(rows.get("autonomy: production health checks")?.status).toBe("warn");
  expect(rows.get("autonomy: regression checks")?.status).toBe("warn");
  // Warnings alone must not be the reason an otherwise ready project reports
  // itself broken.
  expect(result.exitCode).toBe(0);
});

it("adds no autonomy rows to a project that declared no autonomy", async () => {
  const { harness, store } = await loadPlugin();
  storeAutonomyPolicy(store, undefined);
  stubDoctorEnvironment(harness);
  installGhStubs(harness, ghApiFor({ ...DOCTOR_GH }));

  const result = await harness.behavior.runCli(["doctor", "proj_1", "--json"]);

  const rows = [...doctorRows(result.stdout).keys()];
  expect(rows.some((name) => name.startsWith("autonomy:"))).toBe(false);
});

it("marks the branch-protection row not applicable when autonomy merges nothing", async () => {
  const { harness, store } = await loadPlugin();
  storeAutonomyPolicy(store, { intake: { maxJobsPerDay: 2 } });
  stubDoctorEnvironment(harness);
  const issued = installGhStubs(harness, ghApiFor({ ...DOCTOR_GH }));

  const result = await harness.behavior.runCli(["doctor", "proj_1", "--json"]);

  const rows = doctorRows(result.stdout);
  expect(rows.get("autonomy: branch protection")?.status).toBe("disabled");
  expect(rows.get("autonomy: required checks")?.status).toBe("pass");
  expect(issued.some((command) => command.includes("/protection"))).toBe(false);
});

it("asks GitHub nothing for a policy that does not merge on its own authority", async () => {
  const { harness, store } = await loadPlugin();
  stubProject(harness);
  const issued = installGhStubs(harness, () => ({ exitCode: 1, output: "" }));

  const result = await harness.behavior.runCli([
    "project", "enable", "proj_1",
    "--policy-json", policyJson({ intake: { maxJobsPerDay: 1 } }),
  ]);

  expect(result.exitCode).toBe(0);
  expect(store.getProjectPolicy("proj_1")?.policy.autonomy).toMatchObject({ intake: { maxJobsPerDay: 1 } });
  expect(issued).toEqual([]);
});
