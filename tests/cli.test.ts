import { readFile } from "node:fs/promises";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "../server";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";
import type { ProjectPolicy } from "../src/domain/models";
import { activeWorkerFixture, admitConfirmedJob, policyFixture, productionPolicyFixture } from "./helpers";
import { insertResolvedPromotionLedgerFixture } from "./promotion-evidence-fixture";
import { insertResolvedNavigatorPromotionLedger } from "./support/navigator-promotion-ledger";

let pluginNumber = 0;

async function loadPlugin() {
  const { bb, harness } = createFakePluginHost({
    pluginId: `telegram-agent-task11-cli-${pluginNumber++}`,
    sdk: { subscribe: () => () => undefined },
  });
  await plugin(bb);
  return { bb, harness, store: openStore(bb.storage) };
}

function projectFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "proj_1",
    kind: "standard",
    name: "Cyndra",
    gitRemoteUrl: "git@github.com:acme/cyndra.git",
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
    ...overrides,
  };
}

function branchesFixture(branches = ["main", "develop"]) {
  return {
    branches,
    branchesTruncated: false,
    checkout: { kind: "branch", branchName: "main", headSha: null },
    defaultBranch: "main",
    defaultBranchRelation: "equal",
    hasUncommittedChanges: false,
    operation: { kind: "none" },
    originDefaultBranch: "main",
    remoteBranches: branches,
    remoteBranchesTruncated: false,
    selectedBranch: null,
    defaultWorktreeBaseBranch: "main",
  };
}

function stubProject(harness: { sdk: { stub: (path: string, implementation: (...args: never[]) => unknown) => void } }) {
  harness.sdk.stub("projects.get", async () => projectFixture());
  harness.sdk.stub("projects.branches", async () => branchesFixture());
}

/**
 * Answers the enable-time branch-protection preflight with a protected base
 * branch. A policy that declares unattended merging cannot be stored unless
 * GitHub already requires a status check there; tests/autonomy-preflight.test.ts
 * owns that boundary, and this only keeps it out of the way here.
 */
function stubProtectedBaseBranch(harness: { sdk: { stub: (path: string, implementation: (...args: never[]) => unknown) => void } }) {
  const outputs = new Map<string, string>();
  let terminalNumber = 0;
  harness.sdk.stub("terminals.create", async ({ start }: { start: { command: string } }) => {
    const id = `cli-terminal-${++terminalNumber}`;
    const marker = /__BB_TELEGRAM_AGENT_RESULT_[0-9a-f]+__/.exec(start.command)?.[0] ?? "";
    const body = JSON.stringify({
      required_status_checks: { strict: true, contexts: ["unit"] },
      enforce_admins: { enabled: true },
    });
    outputs.set(id, `${body}\n${marker}:0\n`);
    return { id };
  });
  harness.sdk.stub("terminals.get", async () => ({ status: "running", exitCode: null }));
  harness.sdk.stub("terminals.output", async ({ terminalId }: { terminalId: string }) => ({
    chunks: [{ seq: 0, dataBase64: Buffer.from(outputs.get(terminalId) ?? "", "utf8").toString("base64") }],
    nextSeq: 1,
    truncated: false,
  }));
  harness.sdk.stub("terminals.close", async () => undefined);
}

function parseJson(stdout: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stdout);
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("registers one telegram-agent CLI with complete operator command metadata", async () => {
  const { harness } = await loadPlugin();

  expect(harness.registrations.cli).toMatchObject({
    name: "telegram-agent",
    summary: "Pair Telegram and manage reviewed BB implementation jobs",
  });
  expect(harness.registrations.cli?.commands).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "pair" }),
    expect.objectContaining({
      name: "unpair",
      usage: "bb telegram-agent unpair [--confirm <nonce>] [--json]",
    }),
    expect.objectContaining({ name: "project" }),
    expect.objectContaining({ name: "job" }),
    expect.objectContaining({ name: "doctor" }),
    expect.objectContaining({ name: "capability" }),
  ]));
});

it.each([["--help"], ["help"]])("prints actionable command help for %s", async (...argv) => {
  const { harness } = await loadPlugin();

  const result = await harness.behavior.runCli(argv);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("job show <job-id>");
  expect(result.stdout).toContain("job retry <job-id>");
  expect(result.stdout).toContain("project list");
  expect(result.stdout).toContain("doctor [project-id]");
  expect(result.stdout).toContain("capability status");
  expect(result.stdout).toContain("capability promote <recipe|navigator-v1>");
});

// The controller tool has always resumed a blocked review; the CLI threw
// "Job is not retryable" at the same job, which is how the Areliaa job looked
// permanently dead from the shell.
it("resumes a configuration-blocked job with an open PR from the CLI", async () => {
  const { bb, harness, store } = await loadPlugin();
  const created = store.createJob({ id: "job_cli_blocked", sourceUpdateId: 71, requestText: "blocked", now: 1_000 });
  const selected = store.applyJobEvent(created.id, created.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_1",
    policyVersion: 1,
    policy: policyFixture(),
  }, 1_050);
  store.queueAdmission({
    jobId: created.id,
    expectedVersion: selected.version,
    projectId: "proj_1",
    resumeEvent: "CONFIRMED",
    now: 1_050,
  });
  const db = bb.storage.database();
  db.prepare(
    `UPDATE jobs SET state = 'blocked', blocked_reason = 'configuration', pr_number = 42,
       pr_url = 'https://github.com/example/repo/pull/42',
       implementation_thread_id = 'thr_impl' WHERE id = ?`,
  ).run(created.id);
  db.prepare("UPDATE job_admissions SET state = 'released', released_at = 1_100, release_reason = 'review_blocked' WHERE job_id = ?").run(created.id);

  const result = await harness.behavior.runCli(["job", "retry", created.id]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Review continuation queued for job_cli_blocked");
  expect(store.getAdmission(created.id)).toMatchObject({ state: "queued", resumeEvent: "CONTINUE_REVIEW" });
});

it("reports what every stage of one job ran on and what it consumed", async () => {
  const { harness, store } = await loadPlugin();
  store.createJob({ id: "job_spend", sourceUpdateId: 1, requestText: "work", now: 1_000 });
  store.recordStageExecution({
    jobId: "job_spend",
    attemptId: "stage:job_spend:1:spawn_docs",
    stage: "docs",
    attemptOrdinal: 2,
    threadId: "thr_docs",
    baseTier: "fast",
    tier: "standard",
    escalationSteps: 1,
    source: "default",
    providerId: "codex",
    modelId: "gpt-5.6-terra",
    reasoningLevel: "high",
    serviceTier: "default",
    now: 1_000,
  });
  store.settleStageExecution({
    jobId: "job_spend",
    attemptId: "stage:job_spend:1:spawn_docs",
    stage: "docs",
    outcome: "succeeded",
    usage: {
      inputTokens: 400,
      cachedInputTokens: 100,
      outputTokens: 200,
      reasoningOutputTokens: 50,
      totalTokens: 600,
    },
    now: 3_000,
  });

  const result = await harness.behavior.runCli(["job", "spend", "job_spend", "--json"]);

  expect(result.exitCode).toBe(0);
  expect(parseJson(result.stdout)).toMatchObject({
    jobId: "job_spend",
    attempts: 1,
    escalatedAttempts: 1,
    totalTokens: 600,
    costMicroUsd: null,
    durationMs: 2_000,
    stages: [{
      stage: "docs",
      attempt: 2,
      tier: "standard",
      baseTier: "fast",
      escalated: true,
      model: "gpt-5.6-terra",
      serviceTier: "default",
      totalTokens: 600,
      outcome: "succeeded",
    }],
  });
});

it("refuses a spend report for a job it does not have", async () => {
  const { harness } = await loadPlugin();

  const result = await harness.behavior.runCli(["job", "spend", "job_missing", "--json"]);

  expect(result.exitCode).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain("Job was not found");
});

it("reports bounded capability rollout status without inventing live promotion evidence", async () => {
  const { harness, store } = await loadPlugin();

  const result = await harness.behavior.runCli(["capability", "status", "direct", "--json"]);

  expect(result.exitCode).toBe(0);
  expect(parseJson(result.stdout)).toMatchObject({
    settings: {
      jobGraph: "adaptive",
      controllerTools: "bundled",
      modelRouting: "adaptive",
    },
    recipes: [{
      recipe: "direct",
      routingMode: "shadow",
      promotion: { status: "incomplete", ready: false },
    }],
  });
  expect(store.listRecipeRolloutDecisions("direct", 10)).toEqual([]);
  expect(result.stdout).not.toMatch(/requestText|prompt|filesystem|\/root\//u);
});

it("refuses capability promotion without durable live evidence and supports append-only rollback", async () => {
  const { harness, store } = await loadPlugin();

  const refused = await harness.behavior.runCli(["capability", "promote", "direct", "--json"]);
  expect(refused.exitCode).toBe(1);
  expect(parseJson(refused.stdout)).toMatchObject({
    recipe: "direct",
    status: "incomplete",
    ready: false,
  });
  expect(store.listRecipeRolloutDecisions("direct", 10)).toEqual([]);

  store.appendRecipeRolloutDecision({
    recipe: "direct",
    action: "promote",
    reasonCode: "promotion_gates_passed",
    evidenceDigest: "a".repeat(64),
    now: 2_000,
  });
  const rolledBack = await harness.behavior.runCli(["capability", "rollback", "direct", "--json"]);
  expect(rolledBack.exitCode).toBe(0);
  expect(parseJson(rolledBack.stdout)).toMatchObject({ recipe: "direct", action: "rollback" });
  expect(store.getLatestRecipeRolloutDecision("direct")?.action).toBe("rollback");
});

it("promotes through the production CLI only after the durable reader resolves authoritative records", async () => {
  const { bb, harness, store } = await loadPlugin();
  insertResolvedPromotionLedgerFixture({
    db: bb.storage.database(),
    store,
    prefix: "cli-production-reader",
  });

  const promoted = await harness.behavior.runCli(["capability", "promote", "direct", "--json"]);

  expect(promoted.exitCode).toBe(0);
  expect(parseJson(promoted.stdout)).toMatchObject({
    recipe: "direct",
    action: "promote",
    reasonCode: "promotion_gates_passed",
    evidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
  });
  expect(store.getLatestRecipeRolloutDecision("direct")?.action).toBe("promote");
});

it("reports navigator-v1 engine status and refuses promotion without a reviewed evidence manifest", async () => {
  const { harness, store } = await loadPlugin();

  const status = await harness.behavior.runCli(["capability", "status", "navigator-v1", "--json"]);
  expect(status.exitCode).toBe(0);
  expect(parseJson(status.stdout)).toMatchObject({
    settings: {
      workflowEngineGraph: "adaptive",
    },
    engine: {
      engine: "navigator-v1",
      mode: "deterministic",
      promotion: { status: "incomplete", ready: false },
      decision: null,
    },
  });
  expect(store.listWorkflowEngineRolloutDecisions(10)).toEqual([]);

  const refused = await harness.behavior.runCli(["capability", "promote", "navigator-v1", "--json"]);
  expect(refused.exitCode).toBe(1);
  expect(parseJson(refused.stdout)).toMatchObject({
    engine: "navigator-v1",
    status: "incomplete",
    ready: false,
  });
  expect(store.getLatestWorkflowEngineRolloutDecision()).toBeNull();
});

it("promotes navigator-v1 through the CLI only after the durable engine reader resolves a reviewed ledger", async () => {
  const { bb, harness, store } = await loadPlugin();
  insertResolvedNavigatorPromotionLedger({
    db: bb.storage.database(),
    store,
    prefix: "cli-navigator-reader",
  });

  const promoted = await harness.behavior.runCli(["capability", "promote", "navigator-v1", "--json"]);
  expect(promoted.exitCode).toBe(0);
  expect(parseJson(promoted.stdout)).toMatchObject({
    engine: "navigator-v1",
    action: "promote",
    reasonCode: "promotion_gates_passed",
    evidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
  });
  expect(store.getLatestWorkflowEngineRolloutDecision()?.action).toBe("promote");

  const rolledBack = await harness.behavior.runCli(["capability", "rollback", "navigator-v1", "--json"]);
  expect(rolledBack.exitCode).toBe(0);
  expect(parseJson(rolledBack.stdout)).toMatchObject({
    engine: "navigator-v1",
    action: "rollback",
  });
  expect(store.getLatestWorkflowEngineRolloutDecision()?.action).toBe("rollback");
});

it("projects bounded inventory and receipt details without sources, subjects, or evidence payloads", async () => {
  const { harness, store } = await loadPlugin();
  store.replaceExternalCapabilityInventory({
    hostScope: "primary",
    now: 2_000,
    items: [{
      inventoryKey: "inventory:skill:bounded",
      capabilityId: "external-bounded-skill",
      capabilityKind: "skill",
      source: "/root/private/provider/location",
      version: "1.2.3",
      digest: "b".repeat(64),
      hostScope: "primary",
      status: "inventory-only",
      metadata: { credential: "token=should-not-print" },
      discoveredAt: 2_000,
    }],
  });
  const profile = store.createCapabilityProfile({
    subjectKind: "worker_attempt",
    subjectId: "attempt:private-subject",
    threadId: "thr_private",
    recipeId: "bounded",
    recipeVersion: 1,
    registryDigest: "c".repeat(64),
    graphDigest: "d".repeat(64),
    mode: "active",
    model: {
      pool: "standard",
      providerId: "codex",
      modelId: "gpt-5.6-terra",
      reasoning: "high",
      serviceTier: "fast",
    },
    assignments: [{
      capabilityId: "test-driven-development",
      capabilityKind: "skill",
      descriptorDigest: "e".repeat(64),
      mandatory: true,
    }],
    reasonCodes: ["private-reason"],
    traits: ["private-trait"],
    now: 2_000,
  });
  store.appendCapabilityTerminalOutcome({
    profileId: profile.id,
    capabilityId: "test-driven-development",
    descriptorDigest: "e".repeat(64),
    outcome: "passed",
    evidenceRefs: ["/root/private/evidence.txt", "token=should-not-print"],
    now: 2_001,
  });

  const inventory = await harness.behavior.runCli(["capability", "inventory", "--host", "primary", "--json"]);
  expect(inventory.exitCode).toBe(0);
  expect(parseJson(inventory.stdout)).toMatchObject({
    hostScope: "primary",
    items: [{ capabilityId: "external-bounded-skill", capabilityKind: "skill", version: "1.2.3" }],
  });
  expect(inventory.stdout).not.toMatch(/private|credential|should-not-print|source/u);

  const receipts = await harness.behavior.runCli(["capability", "receipts", profile.id, "--json"]);
  expect(receipts.exitCode).toBe(0);
  expect(parseJson(receipts.stdout)).toMatchObject({
    profile: {
      id: profile.id,
      revision: 1,
      recipeId: "bounded",
      model: {
        pool: "standard",
        providerId: "codex",
        modelId: "gpt-5.6-terra",
        reasoning: "high",
        serviceTier: "fast",
      },
    },
    receipts: expect.arrayContaining([
      expect.objectContaining({
        capabilityId: "test-driven-development",
        eventType: "outcome",
        outcome: "passed",
        evidenceCount: 2,
      }),
    ]),
  });
  expect(receipts.stdout).not.toMatch(/private-subject|thr_private|private-reason|private-trait|evidence\.txt|should-not-print/u);
});

it("pairs through Telegram getMe and marks the one-use link sensitive and expiring", async () => {
  const { bb, harness } = await loadPlugin();
  await harness.behavior.setSettings({ botToken: "123:bot-secret" });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    ok: true,
    result: { id: 123, is_bot: true, first_name: "Task Bot", username: "task_bot" },
  }), { status: 200, headers: { "content-type": "application/json" } })));

  const result = await harness.behavior.runCli(["pair", "--json"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const output = parseJson(result.stdout);
  expect(output).toMatchObject({
    sensitive: true,
    expiresInSeconds: 600,
    username: "task_bot",
  });
  expect(output.url).toEqual(expect.stringMatching(/^https:\/\/t\.me\/task_bot\?start=[A-Za-z0-9_-]+$/));
  expect(result.stdout).not.toContain("bot-secret");
  expect(harness.inspection.logEntries.map((entry) => entry.message).join("\n")).not.toContain("start=");

  const store = openStore(bb.storage);
  expect(store.getTelegramIdentity()).toMatchObject({ botId: "123", username: "task_bot" });
});

it("requires an identity-bound nonce before unpairing and records a content-free operator audit", async () => {
  const { bb, harness } = await loadPlugin();
  const db = bb.storage.database();
  db.prepare(
    "INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at) VALUES (1, '7', '70', 1, NULL)",
  ).run();
  db.prepare(
    "INSERT INTO jobs (id, source_update_id, request_text, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("job-unpair", 700, "private chat content must not enter the audit", "blocked", 1, 1);
  db.prepare(
    "INSERT INTO approvals (nonce_hash, job_id, head_sha, expires_at) VALUES (?, ?, ?, ?)",
  ).run(hashSecret("approval-to-revoke"), "job-unpair", "abc123", Date.now() + 60_000);

  const ownerBefore = db.prepare("SELECT * FROM owners").all();
  const approvalsBefore = db.prepare("SELECT * FROM approvals").all();
  const pairingCodesBefore = db.prepare("SELECT * FROM pairing_codes").all();

  const challenge = await harness.behavior.runCli(["unpair", "--json"]);
  expect(challenge.exitCode).toBe(0);
  const challengeOutput = parseJson(challenge.stdout);
  expect(challengeOutput).toMatchObject({
    confirmationRequired: true,
    expiresInSeconds: 600,
    sensitive: true,
    owner: { userId: "7", chatId: "70", pairedAt: 1 },
  });
  expect(challengeOutput.nonce).toEqual(expect.any(String));
  expect(db.prepare("SELECT * FROM owners").all()).toEqual(ownerBefore);
  expect(db.prepare("SELECT * FROM approvals").all()).toEqual(approvalsBefore);
  expect(db.prepare("SELECT * FROM pairing_codes").all()).toEqual(pairingCodesBefore);
  expect(await bb.storage.kv.list("operator-audit/unpair/")).toEqual([]);

  const nonce = String(challengeOutput.nonce);
  const refused = await harness.behavior.runCli(["unpair", "--confirm", `${nonce}x`, "--json"]);
  expect(refused.exitCode).toBe(1);
  expect(openStore(bb.storage).getOwner()).toEqual({ userId: "7", chatId: "70", pairedAt: 1 });
  expect(db.prepare("SELECT outcome FROM approvals").get()).toEqual({ outcome: null });

  const result = await harness.behavior.runCli(
    ["unpair", "--confirm", nonce, "--json"],
    { threadId: "thr_delegated", projectId: "proj_personal" },
  );
  expect(result.exitCode).toBe(0);
  expect(parseJson(result.stdout)).toMatchObject({ revoked: true, approvalsRevoked: 1 });
  expect(openStore(bb.storage).getOwner()).toBeNull();
  expect(db.prepare("SELECT outcome FROM approvals").get()).toEqual({ outcome: "revoked" });

  const auditKeys = await bb.storage.kv.list("operator-audit/unpair/");
  expect(auditKeys).toHaveLength(1);
  const audit = await bb.storage.kv.get(auditKeys[0]!);
  expect(audit).toEqual({
    schemaVersion: 1,
    operation: "unpair",
    outcome: "confirmed",
    occurredAt: expect.any(Number),
    affectedTelegramIdentity: { userId: "7", chatId: "70", pairedAt: 1 },
    operatorContext: { threadId: "thr_delegated", projectId: "proj_personal" },
  });
  expect(JSON.stringify(audit)).not.toContain(nonce);
  expect(JSON.stringify(audit)).not.toContain("private chat content");
});

it("refuses an expired unpair nonce without changing owner state", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const { bb, harness } = await loadPlugin();
  bb.storage.database().prepare(
    "INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at) VALUES (1, '7', '70', 1, NULL)",
  ).run();
  const challenge = parseJson((await harness.behavior.runCli(["unpair", "--json"])).stdout);

  now.mockReturnValue(1_600_000);
  const result = await harness.behavior.runCli(["unpair", "--confirm", String(challenge.nonce), "--json"]);

  expect(result.exitCode).toBe(1);
  expect(openStore(bb.storage).getOwner()).toEqual({ userId: "7", chatId: "70", pairedAt: 1 });
  expect(await bb.storage.kv.list("operator-audit/unpair/")).toEqual([]);
});

it("refuses an unpair nonce after the paired Telegram identity changes", async () => {
  const { bb, harness } = await loadPlugin();
  const db = bb.storage.database();
  db.prepare(
    "INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at) VALUES (1, '7', '70', 1, NULL)",
  ).run();
  const challenge = parseJson((await harness.behavior.runCli(["unpair", "--json"])).stdout);
  db.prepare(
    "UPDATE owners SET telegram_user_id = '8', telegram_chat_id = '80', paired_at = 2 WHERE singleton = 1",
  ).run();

  const result = await harness.behavior.runCli([
    "unpair", "--confirm", String(challenge.nonce), "--json",
  ]);

  expect(result.exitCode).toBe(1);
  expect(openStore(bb.storage).getOwner()).toEqual({ userId: "8", chatId: "80", pairedAt: 2 });
  expect(await bb.storage.kv.list("operator-audit/unpair/")).toEqual([]);
});

it("rejects unknown, missing, duplicate, and malformed flags with exit code 2", async () => {
  const { harness } = await loadPlugin();
  for (const argv of [
    ["wat"],
    ["project"],
    ["project", "list", "--json", "--json"],
    ["job", "list", "--limit", "0"],
    ["job", "list", "--limit", "101"],
    ["project", "enable", "proj_1", "--policy-json", "{}", "--policy-file", "/tmp/policy.json"],
  ]) {
    const result = await harness.behavior.runCli(argv);
    expect(result.exitCode, argv.join(" ")).toBe(2);
    if (argv.includes("--json")) {
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    } else {
      expect(result.stdout, argv.join(" ")).toBe("");
    }
  }
});

it("keeps human output concise and bounds project and job collections", async () => {
  const { bb, harness, store } = await loadPlugin();
  const db = bb.storage.database();
  for (let index = 0; index < 105; index += 1) {
    const policy: ProjectPolicy = policyFixture({
      projectId: `proj_${index + 1}`,
      alias: `project-${index}`,
    });
    store.upsertProjectPolicy(policy, index + 1);
  }
  for (let index = 0; index < 105; index += 1) {
    const job = store.createJob({
      id: `job_${index + 1}`,
      sourceUpdateId: index + 1,
      requestText: `request ${index} token=should-not-print`,
      now: index + 1,
    });
    if (index < 104) db.prepare("UPDATE jobs SET state = 'blocked' WHERE id = ?").run(job.id);
  }

  const projects = await harness.behavior.runCli(["project", "list"]);
  expect(projects.exitCode).toBe(0);
  expect(projects.stdout.trim().split("\n")).toHaveLength(100);
  expect(projects.stdout).not.toContain("should-not-print");

  const jobs = await harness.behavior.runCli(["job", "list", "--limit", "1"]);
  expect(jobs.exitCode).toBe(0);
  expect(jobs.stdout.trim().split("\n")).toHaveLength(1);
  expect(jobs.stdout).not.toContain("should-not-print");

  const show = await harness.behavior.runCli(["job", "show", "job_1"]);
  expect(show.exitCode).toBe(0);
  expect(show.stdout.length).toBeLessThan(500);
  expect(show.stdout).not.toContain("should-not-print");
});

it("enables a project from JSON only after live GitHub, source, and base-branch checks", async () => {
  const { harness, store } = await loadPlugin();
  stubProject(harness);
  const input = {
    ...policyFixture({ production: productionPolicyFixture({ targetKey: "shared.prod" }) }),
    githubRepository: undefined,
  };

  const result = await harness.behavior.runCli([
    "project",
    "enable",
    "proj_1",
    "--policy-json",
    JSON.stringify(input),
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(parseJson(result.stdout)).toMatchObject({ projectId: "proj_1", enabled: true });
  expect(store.getProjectPolicy("proj_1")?.policy).toMatchObject({
    githubRepository: "acme/cyndra",
    baseBranch: "main",
    production: { targetKey: "shared.prod" },
  });
});

it("rejects a policy JSON remote that differs from the live canonical remote", async () => {
  const { harness, store } = await loadPlugin();
  stubProject(harness);

  const result = await harness.behavior.runCli([
    "project",
    "enable",
    "proj_1",
    "--policy-json",
    JSON.stringify(policyFixture({ githubRepository: "other/repository" })),
  ]);

  expect(result.exitCode).toBe(1);
  expect(store.getProjectPolicy("proj_1")).toBeNull();
});

it("builds and validates individual policy fields including repeatable controls and profiles", async () => {
  const { harness, store } = await loadPlugin();
  stubProject(harness);

  const result = await harness.behavior.runCli([
    "project",
    "enable",
    "proj_1",
    "--alias",
    "operator-policy",
    "--base",
    "main",
    "--merge-method",
    "squash",
    "--validation-json",
    JSON.stringify({ name: "unit", command: "npm test", timeoutMs: 600_000 }),
    "--deploy-json",
    JSON.stringify({ name: "convex", command: "bunx convex deploy --yes", timeoutMs: 600_000 }),
    "--canary-json",
    JSON.stringify({ name: "health", command: "npm run canary", timeoutMs: 120_000 }),
    "--production-target-key",
    "shared.prod",
    "--rollback-json",
    JSON.stringify({ name: "rollback", command: "npm run rollback", timeoutMs: 120_000 }),
    "--convex-deploy-required",
    "--required-check",
    "unit",
    "--redact-pattern",
    "secret",
    "--worker-liveness-watchdog-ms",
    "60000",
    "--max-review-cycles",
    "4",
    "--implementation-provider",
    "codex",
    "--implementation-model",
    "gpt-5",
    "--implementation-reasoning",
    "high",
    "--implementation-service-tier",
    "fast",
    "--implementation-permission-mode",
    "accept-edits",
    "--review-provider",
    "codex",
    "--review-model",
    "gpt-5-mini",
    "--review-reasoning",
    "medium",
    "--review-service-tier",
    "default",
    "--review-permission-mode",
    "auto",
  ]);

  expect(result.exitCode).toBe(0);
  expect(store.getProjectPolicy("proj_1")?.policy).toMatchObject({
    alias: "operator-policy",
    githubRepository: "acme/cyndra",
    workerLivenessWatchdogMs: 60_000,
    maxReviewCycles: 4,
    implementation: {
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionMode: "accept-edits",
    },
    review: {
      providerId: "codex",
      model: "gpt-5-mini",
      reasoningLevel: "medium",
      serviceTier: "default",
      permissionMode: "auto",
    },
    requiredChecks: ["unit"],
    outputRedactionPatterns: ["secret"],
    production: {
      targetKey: "shared.prod",
      deployCommands: [{ name: "convex", command: "bunx convex deploy --yes", timeoutMs: 600_000 }],
      canaryCommands: [{ name: "health", command: "npm run canary", timeoutMs: 120_000 }],
      rollbackCommand: { name: "rollback", command: "npm run rollback", timeoutMs: 120_000 },
      convexDeployRequired: true,
    },
  });
});

it("grants unattended merging from a flag only when the project can roll back", async () => {
  const { harness, store } = await loadPlugin();
  stubProject(harness);
  stubProtectedBaseBranch(harness);
  const productionFlags = [
    "--deploy-json", JSON.stringify({ name: "deploy", command: "npm run deploy", timeoutMs: 60_000 }),
    "--canary-json", JSON.stringify({ name: "health", command: "npm run canary", timeoutMs: 60_000 }),
  ];

  const refused = await harness.behavior.runCli([
    "project", "enable", "proj_1",
    "--alias", "operator-policy",
    "--base", "main",
    "--merge-method", "squash",
    ...productionFlags,
    "--unattended-merge",
  ]);

  expect(refused.exitCode).toBe(1);
  expect(store.getProjectPolicy("proj_1")).toBeNull();

  const accepted = await harness.behavior.runCli([
    "project", "enable", "proj_1",
    "--alias", "operator-policy",
    "--base", "main",
    "--merge-method", "squash",
    ...productionFlags,
    "--rollback-json", JSON.stringify({ name: "rollback", command: "npm run rollback", timeoutMs: 60_000 }),
    "--unattended-merge",
  ]);

  expect(accepted.exitCode).toBe(0);
  expect(store.getProjectPolicy("proj_1")?.policy.autonomy).toMatchObject({ unattendedMerge: true });
});

it("leaves the autonomy block absent when no flag asks for it", async () => {
  const { harness, store } = await loadPlugin();
  stubProject(harness);

  const result = await harness.behavior.runCli([
    "project", "enable", "proj_1",
    "--alias", "operator-policy",
    "--base", "main",
    "--merge-method", "squash",
  ]);

  expect(result.exitCode).toBe(0);
  expect(store.getProjectPolicy("proj_1")?.policy.autonomy).toBeUndefined();
});

it("rejects a production target flag without complete deploy and canary configuration", async () => {
  const { harness, store } = await loadPlugin();
  stubProject(harness);

  const result = await harness.behavior.runCli([
    "project", "enable", "proj_1",
    "--alias", "operator-policy",
    "--base", "main",
    "--merge-method", "squash",
    "--production-target-key", "shared.prod",
  ]);

  expect(result.exitCode).toBe(2);
  expect(store.getProjectPolicy("proj_1")).toBeNull();
});

it("rejects Convex production policy flags that do not invoke the Convex CLI", async () => {
  const { harness, store } = await loadPlugin();
  stubProject(harness);

  const result = await harness.behavior.runCli([
    "project", "enable", "proj_1",
    "--alias", "operator-policy",
    "--base", "main",
    "--merge-method", "squash",
    "--deploy-json", JSON.stringify({ name: "deploy", command: "npm run deploy", timeoutMs: 60_000 }),
    "--canary-json", JSON.stringify({ name: "health", command: "npm run canary", timeoutMs: 60_000 }),
    "--convex-deploy-required",
  ]);

  expect(result.exitCode).toBe(1);
  expect(store.getProjectPolicy("proj_1")).toBeNull();
});

it("routes an absolute policy file through the primary BB host when context is absent", async () => {
  const { harness, store } = await loadPlugin();
  stubProject(harness);
  const path = "/operator/policy.json";
  harness.sdk.stub("files.read", async () => ({
    path,
    content: JSON.stringify(policyFixture()),
    contentEncoding: "utf8",
    mimeType: "application/json",
    sizeBytes: 10,
    modifiedAtMs: 1,
    sha256: "a".repeat(64),
  }));

  const result = await harness.behavior.runCli([
    "project",
    "enable",
    "proj_1",
    "--policy-file",
    path,
  ], {});

  expect(result.exitCode).toBe(0);
  expect(store.getProjectPolicy("proj_1")?.policy.githubRepository).toBe("acme/cyndra");
  expect(harness.inspection.sdk.callsTo("files.read")[0]?.[0]).toMatchObject({ path });
  expect(harness.inspection.sdk.callsTo("files.read")[0]?.[0]).not.toHaveProperty("hostId");
});

it("routes an absolute policy file to an explicit host without using local filesystem APIs", async () => {
  const { harness } = await loadPlugin();
  stubProject(harness);
  const path = "C:\\operator\\policy.json";
  harness.sdk.stub("files.read", async () => ({
    path,
    content: JSON.stringify(policyFixture()),
    contentEncoding: "utf8",
    mimeType: "application/json",
    sizeBytes: 10,
    modifiedAtMs: 1,
    sha256: "a".repeat(64),
  }));

  const result = await harness.behavior.runCli([
    "project",
    "enable",
    "proj_1",
    "--policy-file",
    path,
    "--host",
    "host_remote",
  ]);

  expect(result.exitCode).toBe(0);
  expect(harness.inspection.sdk.callsTo("files.read")[0]?.[0]).toMatchObject({ hostId: "host_remote", path });
});

it("resolves a policy file host from the invoking thread environment", async () => {
  const { harness } = await loadPlugin();
  stubProject(harness);
  harness.sdk.stub("threads.get", async () => ({ environmentId: "env_remote" }));
  harness.sdk.stub("environments.get", async () => ({ hostId: "host_from_environment" }));
  const path = "/operator/policy.json";
  harness.sdk.stub("files.read", async () => ({
    path,
    content: JSON.stringify(policyFixture()),
    contentEncoding: "utf8",
    mimeType: "application/json",
    sizeBytes: 10,
    modifiedAtMs: 1,
    sha256: "a".repeat(64),
  }));

  const result = await harness.behavior.runCli([
    "project",
    "enable",
    "proj_1",
    "--policy-file",
    path,
  ], { threadId: "thr_operator" });

  expect(result.exitCode).toBe(0);
  expect(harness.inspection.sdk.callsTo("files.read")[0]?.[0]).toMatchObject({
    hostId: "host_from_environment",
    path,
  });
});

it("refuses relative, unreadable, invalid-JSON, and schema-invalid policy files without storing a policy", async () => {
  const { harness, store } = await loadPlugin();
  stubProject(harness);
  const relative = await harness.behavior.runCli([
    "project",
    "enable",
    "proj_1",
    "--policy-file",
    "relative.json",
  ]);
  expect(relative.exitCode).toBe(1);
  expect(store.getProjectPolicy("proj_1")).toBeNull();

  harness.sdk.stub("files.read", async () => {
    throw new Error("remote read failed: token=should-not-print");
  });
  const unreadable = await harness.behavior.runCli([
    "project",
    "enable",
    "proj_1",
    "--policy-file",
    "/operator/policy.json",
  ]);
  expect(unreadable.exitCode).toBe(1);
  expect(unreadable.stdout).toBe("");
  expect(unreadable.stderr).not.toContain("should-not-print");

  harness.sdk.stub("files.read", async () => ({
    path: "/operator/policy.json",
    content: "not-json",
    contentEncoding: "utf8",
    mimeType: "application/json",
    sizeBytes: 8,
    modifiedAtMs: 1,
    sha256: "a".repeat(64),
  }));
  const invalidJson = await harness.behavior.runCli([
    "project",
    "enable",
    "proj_1",
    "--policy-file",
    "/operator/policy.json",
  ]);
  expect(invalidJson.exitCode).toBe(1);
  expect(store.getProjectPolicy("proj_1")).toBeNull();

  harness.sdk.stub("files.read", async () => ({
    path: "/operator/policy.json",
    content: JSON.stringify({ projectId: "proj_1", alias: "bad" }),
    contentEncoding: "utf8",
    mimeType: "application/json",
    sizeBytes: 40,
    modifiedAtMs: 1,
    sha256: "a".repeat(64),
  }));
  const invalidSchema = await harness.behavior.runCli([
    "project",
    "enable",
    "proj_1",
    "--policy-file",
    "/operator/policy.json",
  ]);
  expect(invalidSchema.exitCode).toBe(1);
  expect(store.getProjectPolicy("proj_1")).toBeNull();
});

it("shows, retries, cancels, and rejects illegal job state transitions through the state machine", async () => {
  const { bb, harness, store } = await loadPlugin();
  store.upsertProjectPolicy(policyFixture(), 1);
  const failed = store.createJob({ id: "job_retry", sourceUpdateId: 1, requestText: "retry me", now: 1 });
  const selected = store.applyJobEvent(failed.id, failed.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_1",
    policyVersion: 1,
    policy: policyFixture(),
  }, 2);
  const confirmed = admitConfirmedJob(store, store.getJob(selected.id)!, 3);
  const planned = store.applyJobEvent(confirmed.id, confirmed.version, { type: "PLAN_READY", attemptId: "stage_plan" }, 3);
  const critiqued = store.applyJobEvent(planned.id, planned.version, { type: "CRITIQUE_PASSED", attemptId: "stage_critique" }, 3);
  const implementing = store.applyJobEvent(critiqued.id, critiqued.version, {
    type: "IMPLEMENTATION_CREATED",
    threadId: "thr_retry",
    environmentId: "env_retry",
  }, 4);
  const failedJob = store.applyJobEvent(implementing.id, implementing.version, { type: "FAILED", error: "worker failed" }, 5);
  const retry = await harness.behavior.runCli(["job", "retry", failed.id, "--json"]);
  expect(retry.exitCode).toBe(0);
  expect(parseJson(retry.stdout)).toMatchObject({ id: failed.id, state: "implementing" });
  expect(store.getJob(failed.id)?.version).toBe(failedJob.version + 1);
  bb.storage.database().prepare("UPDATE jobs SET state = 'cancelled' WHERE id = ?").run(failed.id);

  const active = store.createJob({ id: "job_cancel", sourceUpdateId: 2, requestText: "cancel me", now: 3 });
  const cancel = await harness.behavior.runCli(["job", "cancel", active.id, "--json"]);
  expect(cancel.exitCode).toBe(0);
  expect(parseJson(cancel.stdout)).toMatchObject({ id: active.id, cancelRequested: true });
  expect(store.getJob(active.id)?.cancelRequestedAt).not.toBeNull();
  const cancellationRequested = store.getJob(active.id)!;
  // This job has no live worker, so the request already completed; confirming
  // again would be illegal.
  expect(cancellationRequested.state).toBe("cancelled");
  bb.storage.database().prepare("UPDATE jobs SET state = 'merged', cancel_requested_at = NULL WHERE id = ?").run(active.id);

  const illegal = await harness.behavior.runCli(["job", "retry", active.id]);
  expect(illegal.exitCode).toBe(1);
  expect(store.getJob(active.id)?.state).toBe("merged");
});

it("projects bounded admission and resource facts without lease ownership details", async () => {
  const { harness, store } = await loadPlugin();
  store.upsertProjectPolicy(policyFixture({ production: undefined }), 1);
  const draft = store.createJob({ id: "job_projection", sourceUpdateId: 41, requestText: "private task text", now: 1 });
  const selected = store.applyJobEvent(draft.id, draft.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_1",
    policyVersion: 1,
    policy: policyFixture({ production: undefined }),
  }, 2);
  admitConfirmedJob(store, selected, 3);

  const shown = await harness.behavior.runCli(["job", "show", draft.id, "--json"]);
  expect(shown.exitCode).toBe(0);
  const projection = parseJson(shown.stdout);
  expect(projection).toMatchObject({
    id: draft.id,
    projectId: "proj_1",
    recipe: { id: "architectural", version: 1, promotionCount: 0, routingMode: "legacy" },
    admission: {
      state: "admitted",
      queueSequence: expect.any(Number),
      queueAgeMs: expect.any(Number),
      releaseReason: null,
    },
    resources: {
      held: [{ kind: "project", key: "project:proj_1:pipeline" }],
      waiting: [],
    },
  });
  expect(JSON.stringify(projection)).not.toMatch(/"(?:ownerId|generation|leaseExpiresAt|requestText)"|private task text/i);

  const listed = await harness.behavior.runCli(["job", "list"]);
  expect(listed.stdout).toContain(`${draft.id}\tplanning\tadmitted\tproj_1`);
});

it("cancels through the CLI with an active worker and queues its stop effect", async () => {
  const { harness, store } = await loadPlugin();
  const active = store.createJob({ id: "job_cancel_worker", sourceUpdateId: 3, requestText: "cancel worker", now: 3 });
  store.upsertWorkerLiveness(activeWorkerFixture({
    jobId: active.id,
    resourceId: "thr_cli_active",
    generation: 2,
  }));

  const cancel = await harness.behavior.runCli(["job", "cancel", active.id, "--json"]);

  expect(cancel.exitCode).toBe(0);
  expect(store.getJob(active.id)?.cancelRequestedAt).not.toBeNull();
  expect(store.listEffectsForJob(active.id).filter((effect) => effect.kind === "stop_thread")).toHaveLength(1);
  expect(store.listEffectsForJob(active.id).find((effect) => effect.kind === "stop_thread")?.payload).toEqual({
    generation: 2,
    resourceId: "thr_cli_active",
    resourceKind: "bb_thread",
    workerKind: "implementation",
  });
});

it("emits strict JSON for machine output and never serializes secret-bearing job fields", async () => {
  const { harness, store } = await loadPlugin();
  store.createJob({
    id: "job_secret",
    sourceUpdateId: 9,
    requestText: "deploy with api_key=do-not-print",
    now: 1,
  });

  const result = await harness.behavior.runCli(["job", "show", "job_secret", "--json"]);
  expect(result.exitCode).toBe(0);
  expect(() => JSON.parse(result.stdout)).not.toThrow();
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain("do-not-print");
});

it("does not import node:fs in the CLI implementation", async () => {
  const source = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/from ["']node:fs["']/);
  expect(source).not.toMatch(/require\(["']node:fs["']\)/);
});

it("disables a project without deleting its job history", async () => {
  const { harness, store } = await loadPlugin();
  store.upsertProjectPolicy(policyFixture(), 1);
  const job = store.createJob({ id: "job_history", sourceUpdateId: 1, requestText: "keep", now: 1 });

  const result = await harness.behavior.runCli(["project", "disable", "proj_1", "--json"]);
  expect(result.exitCode).toBe(0);
  expect(parseJson(result.stdout)).toMatchObject({ projectId: "proj_1", enabled: false });
  expect(store.getProjectPolicy("proj_1")?.policy.enabled).toBe(false);
  expect(store.getJob(job.id)).not.toBeNull();
});

it("uses explicit project-id equality and live branch checks before storing JSON policies", async () => {
  const { harness, store } = await loadPlugin();
  stubProject(harness);

  const mismatch = await harness.behavior.runCli([
    "project",
    "enable",
    "proj_other",
    "--policy-json",
    JSON.stringify(policyFixture()),
  ]);
  expect(mismatch.exitCode).toBe(1);
  expect(store.getProjectPolicy("proj_other")).toBeNull();

  harness.sdk.stub("projects.branches", async () => branchesFixture(["develop"]));
  const missingBranch = await harness.behavior.runCli([
    "project",
    "enable",
    "proj_1",
    "--policy-json",
    JSON.stringify(policyFixture()),
  ]);
  expect(missingBranch.exitCode).toBe(1);
  expect(store.getProjectPolicy("proj_1")).toBeNull();
});

it("does not leak pairing secrets through JSON, human output, errors, or logs", async () => {
  const { bb, harness } = await loadPlugin();
  const db = bb.storage.database();
  db.prepare(
    "INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at) VALUES (1, '7', '70', 1, NULL)",
  ).run();
  const store = openStore(bb.storage);
  store.createPairingCode(hashSecret("do-not-print"), 1, 100);

  const result = await harness.behavior.runCli(["unpair"]);
  expect(result.exitCode).toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).not.toContain("do-not-print");
  expect(harness.inspection.logEntries.map((entry) => entry.message).join("\n")).not.toContain("do-not-print");
});

function stubMemoryFile(harness: Awaited<ReturnType<typeof loadPlugin>>["harness"], entries: unknown) {
  harness.sdk.stub("files.read", async () => ({
    path: "/operator/knowledge.json",
    content: JSON.stringify({ entries }),
    contentEncoding: "utf8",
    mimeType: "application/json",
    sizeBytes: 10,
    modifiedAtMs: 1,
    sha256: "a".repeat(64),
  }));
}

it("imports an owner knowledge file the agent could not have written itself", async () => {
  const { harness, store } = await loadPlugin();
  stubMemoryFile(harness, [
    { subject: "stripe key", body: "STRIPE_SECRET_KEY=sk-live-000111222333444555666" },
    { subject: "deploy window", body: "Only weekday mornings.", kind: "preference" },
  ]);

  const result = await harness.behavior.runCli([
    "memory", "import", "--file", "/operator/knowledge.json", "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ imported: 2 });
  const recalled = store.recallMemories({ scope: "owner", query: "stripe", limit: 10, now: 2 });
  expect(recalled.map((memory) => memory.subject)).toContain("stripe key");
});

it("reads the import through the BB host rather than the local filesystem", async () => {
  const { harness } = await loadPlugin();
  stubMemoryFile(harness, [{ subject: "one", body: "two" }]);

  await harness.behavior.runCli(["memory", "import", "--file", "/operator/knowledge.json"]);

  expect(harness.inspection.sdk.callsTo("files.read")[0]?.[0]).toMatchObject({ path: "/operator/knowledge.json" });
});

it("rejects a malformed or oversized import without storing a partial file", async () => {
  const { harness, store } = await loadPlugin();
  for (const entries of [[], [{ subject: "no body" }], Array.from({ length: 201 }, () => ({ subject: "s", body: "b" }))]) {
    stubMemoryFile(harness, entries);
    const result = await harness.behavior.runCli([
      "memory", "import", "--file", "/operator/knowledge.json", "--json",
    ]);
    expect(result.exitCode).toBe(1);
  }
  expect(store.recallMemories({ scope: "owner", limit: 10, now: 2 })).toEqual([]);
});

it("requires an absolute import path", async () => {
  const { harness } = await loadPlugin();
  const result = await harness.behavior.runCli(["memory", "import", "--file", "knowledge.json", "--json"]);
  expect(result.exitCode).toBe(1);
});
