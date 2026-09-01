import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import plugin from "../server";
import { protectedConnectorCapabilityFor } from "../src/credentials/connector-protocol";
import { openStore } from "../src/storage/store";

const VALID_PEM_CERT = `-----BEGIN CERTIFICATE-----
MIIBgzCCASmgAwIBAgIUW1L4gC6MeV+Ud+wNnC7kU0bN+s0wCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMdGVzdC1maXh0dXJlMB4XDTI2MDgxNDEwMjgxM1oXDTM2MDgx
MTEwMjgxM1owFzEVMBMGA1UEAwwMdGVzdC1maXh0dXJlMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAE8lgFiCsSPUTzcud3u5as3wowffShCJSevZVfHPT+spDqbRZJ
fAzqwAu69fjGsYzIcwKZYzvJUDcZBC5qSgN+W6NTMFEwHQYDVR0OBBYEFF2WLMZE
SeS3kyKKUuEBBoycc7noMB8GA1UdIwQYMBaAFF2WLMZESeS3kyKKUuEBBoycc7no
MA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgYXNP228YLyxkgGok
1Xlri/3ef+vGvZVkHplqiULz634CIQCNkG7RoRpzRaKQVkMZiZ/E8PdOmJuzCLhx
ydSY0UJMrA==
-----END CERTIFICATE-----`;
const VALID_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgkiiRRwUsXJ7S1v9d
bcXTZYgtaanNlGvgyK86g4TddduhRANCAATyWAWIKxI9RPNy53e7lqzfCjB99KEI
lJ69lV8c9P6ykOptFkl8DOrAC7r1+MaxjMhzApljO8lQNxkELmpKA35b
-----END PRIVATE KEY-----`;
const KEY_CANARY = "kiiRRwUsXJ7S1v9dbcXTZYg";

let pluginNumber = 0;

async function loadPlugin(settings: Record<string, string> = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: `telegram-agent-credential-cli-${pluginNumber++}`,
    sdk: { subscribe: () => () => undefined },
    settings,
  });
  await plugin(bb);
  return { bb, harness };
}

/** Complete, parseable isolated settings. Only the ones the caller cares about need overriding. */
function isolatedSettings(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    credentialBrokerMode: "isolated",
    credentialBrokerEndpoint: "https://broker.example.com",
    credentialBrokerInstallationId: "install_1",
    credentialBrokerTopologyReceiptDigest: "a".repeat(64),
    credentialBrokerTopologyReceiptExpiresAt: String(Date.now() + 10 * 24 * 60 * 60 * 1000),
    credentialBrokerClientCertificate: VALID_PEM_CERT,
    credentialBrokerClientKey: VALID_KEY_PEM,
    credentialBrokerCaCertificate: VALID_PEM_CERT,
    ...overrides,
  };
}

function parseJson<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

type DoctorOutput = { checks: Array<{ name: string; status: string; summary: string }> };

function credentialChecks(output: DoctorOutput) {
  return output.checks.filter((check) => check.name.startsWith("credential"));
}

// --- disabled default -------------------------------------------------

it("fails closed on access list/status/doctor with no broker configured", async () => {
  const { harness } = await loadPlugin();

  const listResult = await harness.behavior.runCli(["access", "list", "--json"]);
  expect(listResult.exitCode).toBe(0);
  expect(parseJson<{ available: boolean; bindings: unknown[]; truncated: boolean }>(listResult.stdout)).toEqual({
    available: false,
    bindings: [],
    truncated: false,
  });

  const statusResult = await harness.behavior.runCli(["access", "status", "--json"]);
  expect(statusResult.exitCode).toBe(0);
  expect(parseJson<{ readiness: { state: string; checks: unknown[] }; health: unknown; binding: unknown }>(statusResult.stdout)).toEqual({
    readiness: { state: "disabled", checks: [] },
    health: null,
    binding: null,
  });

  const doctorResult = await harness.behavior.runCli(["doctor", "--json"]);
  const doctorOutput = parseJson<DoctorOutput>(doctorResult.stdout);
  expect(credentialChecks(doctorOutput)).toEqual([
    { name: "credential broker", status: "disabled", summary: "disabled" },
  ]);
});

it("does not let disabled credentials fail an otherwise-passing project-less doctor", async () => {
  const { bb, harness } = await loadPlugin({ botToken: "123:test-token" });
  bb.storage.database().prepare(
    "INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at) VALUES (1, '7', '70', 1, NULL)",
  ).run();

  const doctorResult = await harness.behavior.runCli(["doctor", "--json"]);
  const doctorOutput = parseJson<DoctorOutput>(doctorResult.stdout);
  expect(doctorOutput.checks.find((check) => check.name === "token presence")?.status).toBe("pass");
  expect(doctorOutput.checks.find((check) => check.name === "owner pairing")?.status).toBe("pass");
  expect(credentialChecks(doctorOutput)).toEqual([
    { name: "credential broker", status: "disabled", summary: "disabled" },
  ]);
  // "enabled projects" still fails in this minimal fixture; only assert that
  // the credential row specifically never turns that into a failure.
  expect(doctorResult.exitCode).toBe(1);
  expect(doctorOutput.checks.some((check) => check.name === "enabled projects" && check.status === "fail")).toBe(true);
});

// --- misconfigured (invalid) -------------------------------------------

it("reports isolated configuration as failing — never disabled — when the saved settings are malformed", async () => {
  const { harness } = await loadPlugin(isolatedSettings({ credentialBrokerClientCertificate: "not-a-real-cert" }));

  const listResult = await harness.behavior.runCli(["access", "list", "--json"]);
  expect(parseJson<{ available: boolean }>(listResult.stdout).available).toBe(false);

  const doctorResult = await harness.behavior.runCli(["doctor", "--json"]);
  expect(doctorResult.exitCode).toBe(1);
  const rows = credentialChecks(parseJson<DoctorOutput>(doctorResult.stdout));
  expect(rows.find((row) => row.name === "credential: isolated configuration")?.status).toBe("fail");
  expect(rows.some((row) => row.status === "disabled")).toBe(false);
});

it("uses the auto controller-permission default when reporting credential readiness", async () => {
  const { harness } = await loadPlugin(isolatedSettings());

  const doctorResult = await harness.behavior.runCli(["doctor", "--json"]);
  const rows = credentialChecks(parseJson<DoctorOutput>(doctorResult.stdout));
  expect(rows.map((row) => row.name)).toEqual([
    "credential: trust kernel",
    "credential: controller permission",
    "credential: isolated configuration",
    "credential: topology receipt",
    "credential: broker tls",
    "credential: broker identity",
    "credential: protocol version",
    "credential: installation identity",
    "credential: broker audit",
    "credential: onepassword adapter",
  ]);
  expect(rows.find((row) => row.name === "credential: controller permission")?.status).toBe("pass");
  expect(rows.find((row) => row.name === "credential: isolated configuration")?.status).toBe("pass");
});

// --- settings lifecycle --------------------------------------------------

it("keeps a fresh activation with isolated settings from a live client — access list is immediately available", async () => {
  const { harness } = await loadPlugin({ botToken: "123:test-token", controllerPermissionMode: "auto", ...isolatedSettings() });

  const listResult = await harness.behavior.runCli(["access", "list", "--json"]);
  expect(parseJson<{ available: boolean; bindings: unknown[] }>(listResult.stdout)).toEqual({
    available: true,
    bindings: [],
    truncated: false,
  });
});

it("marks a disabled-to-isolated settings change unavailable (not disabled) until an explicit reload, without inventing a live client", async () => {
  const { harness } = await loadPlugin({ botToken: "123:test-token", controllerPermissionMode: "auto" });

  await harness.behavior.setSettings(isolatedSettings());

  const listResult = await harness.behavior.runCli(["access", "list", "--json"]);
  expect(parseJson<{ available: boolean; bindings: unknown[] }>(listResult.stdout)).toEqual({
    available: true,
    bindings: [],
    truncated: false,
  });

  const doctorResult = await harness.behavior.runCli(["doctor", "--json"]);
  expect(doctorResult.exitCode).toBe(1);
  const rows = credentialChecks(parseJson<DoctorOutput>(doctorResult.stdout));
  expect(rows.every((row) => row.status !== "disabled")).toBe(true);
  expect(rows.find((row) => row.name === "credential: isolated configuration")?.status).toBe("pass");
  expect(rows.find((row) => row.name === "credential: topology receipt")?.status).toBe("pass");
  // No live client was built for this mid-session activation, so the broker
  // checks fail closed rather than a fabricated "ready".
  expect(rows.find((row) => row.name === "credential: broker tls")?.status).toBe("fail");
});

it("retires the live client and republishes access as unavailable when settings move back to disabled", async () => {
  const { harness } = await loadPlugin({ botToken: "123:test-token", controllerPermissionMode: "auto", ...isolatedSettings() });
  expect(parseJson<{ available: boolean }>((await harness.behavior.runCli(["access", "list", "--json"])).stdout).available).toBe(true);

  await harness.behavior.setSettings({ credentialBrokerMode: "disabled" });

  const listResult = await harness.behavior.runCli(["access", "list", "--json"]);
  expect(parseJson<{ available: boolean; bindings: unknown[] }>(listResult.stdout)).toEqual({
    available: false,
    bindings: [],
    truncated: false,
  });
  const doctorOutput = parseJson<DoctorOutput>((await harness.behavior.runCli(["doctor", "--json"])).stdout);
  expect(credentialChecks(doctorOutput)).toEqual([
    { name: "credential broker", status: "disabled", summary: "disabled" },
  ]);
});

it("leaves access unaffected by unrelated settings changes (no unnecessary rebuild)", async () => {
  const { harness } = await loadPlugin({ botToken: "123:test-token", controllerPermissionMode: "auto", ...isolatedSettings() });

  await harness.behavior.setSettings({ systemUpkeep: "disabled" });

  const listResult = await harness.behavior.runCli(["access", "list", "--json"]);
  expect(parseJson<{ available: boolean }>(listResult.stdout).available).toBe(true);
});

it("survives a plugin reload with isolated settings persisted", async () => {
  const { harness } = await loadPlugin({ botToken: "123:test-token", controllerPermissionMode: "auto", ...isolatedSettings() });

  const reloaded = await harness.lifecycle.reload(plugin);

  const listResult = await reloaded.harness.behavior.runCli(["access", "list", "--json"]);
  expect(parseJson<{ available: boolean }>(listResult.stdout).available).toBe(true);
});

it("does not throw on dispose while a credential client is configured", async () => {
  const { harness } = await loadPlugin({ botToken: "123:test-token", controllerPermissionMode: "auto", ...isolatedSettings() });

  await expect(harness.lifecycle.dispose()).resolves.toBeUndefined();
});

// --- secret handling ------------------------------------------------------

it("never lets the client private key reach CLI output, JSON output, or logs", async () => {
  const { harness } = await loadPlugin({ botToken: "123:test-token", controllerPermissionMode: "auto", ...isolatedSettings() });

  const listJson = await harness.behavior.runCli(["access", "list", "--json"]);
  const listHuman = await harness.behavior.runCli(["access", "list"]);
  const statusJson = await harness.behavior.runCli(["access", "status", "--json"]);
  const statusHuman = await harness.behavior.runCli(["access", "status"]);
  const doctorJson = await harness.behavior.runCli(["doctor", "--json"]);
  const doctorHuman = await harness.behavior.runCli(["doctor"]);

  for (const result of [listJson, listHuman, statusJson, statusHuman, doctorJson, doctorHuman]) {
    expect(result.stdout).not.toContain(KEY_CANARY);
    expect(result.stdout).not.toContain("PRIVATE KEY");
    expect(result.stderr ?? "").not.toContain(KEY_CANARY);
  }
  expect(harness.inspection.logEntries.map((entry) => entry.message).join("\n")).not.toContain(KEY_CANARY);
  expect(harness.inspection.needsConfigurationMessages.join("\n")).not.toContain(KEY_CANARY);
});

// --- CLI validation ---------------------------------------------------

it("rejects an unknown access list state and an out-of-range limit", async () => {
  const { harness } = await loadPlugin();

  const badState = await harness.behavior.runCli(["access", "list", "--state", "bogus", "--json"]);
  expect(badState.exitCode).toBe(2);

  const badLimit = await harness.behavior.runCli(["access", "list", "--limit", "11", "--json"]);
  expect(badLimit.exitCode).toBe(2);
});

it("rejects more than one access status positional", async () => {
  const { harness } = await loadPlugin();

  const result = await harness.behavior.runCli(["access", "status", "binding_a", "binding_b", "--json"]);
  expect(result.exitCode).toBe(2);
});

it("reports an unknown binding id as not found rather than throwing", async () => {
  const { harness } = await loadPlugin({ botToken: "123:test-token", controllerPermissionMode: "auto", ...isolatedSettings() });

  const result = await harness.behavior.runCli(["access", "status", "binding_nonexistent", "--json"]);
  expect(result.exitCode).toBe(0);
  expect(parseJson<{ binding: unknown }>(result.stdout).binding).toBeNull();
});

it("reconciles a broker projection through the controller-fenced CLI path", async () => {
  const { bb, harness } = await loadPlugin({
    botToken: "123:test-token",
    controllerPermissionMode: "auto",
    ...isolatedSettings(),
  });
  const now = Date.now();
  const store = openStore(bb.storage, bb.storage.kv, () => now);
  const threadId = "thr_cli_reconcile";
  const projectId = "project_cli_reconcile";
  const controllerKey = "owner-7-cli-reconcile";
  bb.storage.database().prepare(
    "INSERT INTO owners (singleton, telegram_user_id, telegram_chat_id, paired_at, revoked_at) VALUES (1, '7', '70', ?, NULL)",
  ).run(now);
  const queued = store.enqueueControllerTurn({
    controllerKey,
    telegramUserId: "7",
    telegramChatId: "70",
    updateId: 701,
    inputText: "Reconcile the protected connector projection.",
    now,
    origin: "owner",
  });
  const lease = store.acquireExecutorLease("executor-cli-reconcile", now, 60_000);
  if (!lease.acquired) throw new Error("cli_reconcile_executor_lease_missing");
  expect(store.claimNextControllerTurn({ ownerId: "executor-cli-reconcile", generation: lease.generation, now: now + 1 })?.id)
    .toBe(queued.id);
  expect(store.markControllerSpawned({
    turnId: queued.id,
    ownerId: "executor-cli-reconcile",
    generation: lease.generation,
    now: now + 2,
    projectId,
    hostId: "host-cli-reconcile",
    threadId,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: queued.id,
    ownerId: "executor-cli-reconcile",
    generation: lease.generation,
    now: now + 3,
  })).toBe(true);

  const projection = {
    schemaVersion: 2,
    installationId: "install_1",
    bindingId: "binding_cli_reconcile",
    operation: "convex.project.inspect.v1",
    bindingKind: "workload_identity",
    authorityProvider: "convex",
    secretProvider: "provider_native",
    principalLabel: "CLI reconciliation workload",
    capabilityIds: [protectedConnectorCapabilityFor("convex.project.inspect.v1")],
    audiences: ["api.convex.dev"],
    origins: [],
    scopes: ["project:read"],
    riskClass: "low",
    mfaMode: "workload_identity",
    approvalMode: "standing_policy",
    state: "vault_verified",
    generation: 1,
    verifiedAt: null,
    expiresAt: null,
  } as const;
  const result = await harness.behavior.runCli([
    "access",
    "reconcile",
    projectId,
    "--projection-json",
    JSON.stringify(projection),
    "--json",
  ], { threadId, projectId });

  expect(result.exitCode).toBe(0);
  expect(parseJson<{ outcome: string; projection: typeof projection }>(result.stdout)).toMatchObject({
    outcome: "reconciled",
    projection,
  });
  expect(store.getProtectedConnectorBinding("install_1", "binding_cli_reconcile")).toEqual(projection);

  const reloaded = await harness.lifecycle.reload(plugin);
  const restartedStore = openStore(reloaded.bb.storage, reloaded.bb.storage.kv, () => now);
  expect(restartedStore.getProtectedConnectorBinding("install_1", "binding_cli_reconcile")).toEqual(projection);
});
