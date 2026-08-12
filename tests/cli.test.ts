import { readFile } from "node:fs/promises";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "../server";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";
import type { ProjectPolicy } from "../src/domain/models";
import { activeWorkerFixture, admitConfirmedJob, policyFixture, productionPolicyFixture } from "./helpers";

let pluginNumber = 0;

async function loadPlugin() {
  const { bb, harness } = createFakePluginHost({
    pluginId: `telegram-agent-task11-cli-${pluginNumber++}`,
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
    expect.objectContaining({ name: "project" }),
    expect.objectContaining({ name: "job" }),
    expect.objectContaining({ name: "doctor" }),
  ]));
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

it("unpairs the owner and revokes approvals through the operator command", async () => {
  const { bb, harness } = await loadPlugin();
  const db = bb.storage.database();
  db.prepare(
    "INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at) VALUES (1, '7', '70', 1, NULL)",
  ).run();

  const result = await harness.behavior.runCli(["unpair", "--json"]);
  expect(result.exitCode).toBe(0);
  expect(parseJson(result.stdout)).toMatchObject({ revoked: true });
  expect(openStore(bb.storage).getOwner()).toBeNull();
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
  store.applyJobEvent(active.id, cancellationRequested.version, { type: "CANCEL_CONFIRMED" }, 6);
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
