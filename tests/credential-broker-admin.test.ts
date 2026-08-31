import { createConnection } from "node:net";
import { statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FOUNDATION_BROKER_POLICY_DIGEST } from "../src/credentials/protocol";
import { PROTECTED_CONNECTOR_POLICY_DIGEST } from "../src/credentials/connector-policy";
import { protectedConnectorCapabilityFor } from "../src/credentials/connector-protocol";
import { createAdminServer, type RunningAdminServer } from "../broker/src/admin-server";
import { runAdminCli } from "../broker/src/admin-cli";
import { BrokerStore } from "../broker/src/store";
import { BrokerProtectedConnectorStore } from "../broker/src/connector-store";
import type { VaultAdapter } from "../broker/src/onepassword-adapter";
import { temporaryBrokerDatabase } from "./support/credential-broker-fixtures";
import { certificateFingerprint, createMtlsFixture, type MtlsFixture } from "./support/mtls-fixtures";

const NOW = 1_800_000_000_000;
const VAULT_ID = "A".repeat(26);
const ITEM_ID = "B".repeat(26);
const TOPOLOGY_DIGEST = "c".repeat(64);
const REFERENCE = `op://${VAULT_ID}/${ITEM_ID}/password`;
const CLIENT_FINGERPRINT = "a".repeat(64);

type AdminResponse = Record<string, unknown>;

type AdminHarness = Readonly<{
  fixture: MtlsFixture;
  database: ReturnType<typeof temporaryBrokerDatabase>;
  store: BrokerStore;
  connectorStore: BrokerProtectedConnectorStore;
  socketPath: string;
  server: RunningAdminServer;
  close(): Promise<void>;
}>;

function installationAddRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: "installation.add",
    clientCertificatePem: "unused-in-test-helper",
    topologyReceiptDigest: TOPOLOGY_DIGEST,
    topologyReceiptExpiresAt: NOW + 60_000,
    expectedVaultId: VAULT_ID,
    ...overrides,
  };
}

async function sendAdminRequest(socketPath: string, request: unknown): Promise<AdminResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.on("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("error", reject);
    socket.on("close", () => {
      const line = Buffer.concat(chunks).toString("utf8").split("\n")[0];
      try {
        resolve(JSON.parse(line) as AdminResponse);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function firstResponseRejectsSecondRequest(socketPath: string, firstRequest: unknown, secondRequest: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.on("connect", () => socket.write(`${JSON.stringify(firstRequest)}\n`));
    socket.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      if (Buffer.concat(chunks).includes(0x0a)) socket.write(`${JSON.stringify(secondRequest)}\n`);
    });
    socket.on("error", () => resolve(Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean).length));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean).length));
    socket.setTimeout(2_000, () => reject(new Error("admin_second_request_timeout")));
  });
}

async function createAdminHarness(): Promise<AdminHarness> {
  const fixture = createMtlsFixture();
  const database = temporaryBrokerDatabase();
  const store = new BrokerStore(database.db, {
    dataKey: new Uint8Array(32).fill(0x11),
    auditKey: new Uint8Array(32).fill(0x22),
    clock: () => NOW,
  });
  const connectorStore = new BrokerProtectedConnectorStore(database.db, {
    dataKey: new Uint8Array(32).fill(0x11),
    clock: () => NOW,
  });
  const adapter: VaultAdapter = {
    health: async () => ({ outcome: "ready" }),
    verify: async () => ({ outcome: "valid", versionHmac: "d".repeat(64) }),
  };
  const socketPath = join(fixture.directory, "admin.sock");
  const server = createAdminServer({
    socketPath,
    store,
    connectorStore,
    adapter,
    clock: () => NOW,
    brokerVersion: "0.1.0",
  });
  await server.start();
  return {
    fixture,
    database,
    store,
    connectorStore,
    socketPath,
    server,
    close: async () => {
      await server.close();
      database.close();
      fixture.cleanup();
    },
  };
}

async function enrollInstallation(harness: AdminHarness): Promise<string> {
  const response = await sendAdminRequest(harness.socketPath, installationAddRequest({
    clientCertificatePem: harness.fixture.clientCertificatePem,
  }));
  expect(response.ok).toBe(true);
  return response.installationId as string;
}

describe("credential broker local administration", () => {
  it("serves only a 0600 Unix socket and completes safe enrollment flows", async () => {
    const harness = await createAdminHarness();
    try {
      expect(typeof harness.server.address()).toBe("string");
      const installationId = await enrollInstallation(harness);
      const binding = await sendAdminRequest(harness.socketPath, {
        operation: "binding.add",
        installationId,
        reference: REFERENCE,
        label: "test binding",
        capabilityIds: ["telegram_agent_access_verify"],
        risk: "high",
        mfaMode: "none",
        approvalMode: "none",
      });
      expect(binding).toMatchObject({ ok: true, state: "pending", generation: 1 });
      const bindingId = binding.bindingId as string;
      const doctor = await sendAdminRequest(harness.socketPath, {
        operation: "installation.doctor",
        installationId,
      });
      expect(doctor).toMatchObject({ ok: true, installationId, bindingCount: 1, adapterState: "ready" });
      const status = await sendAdminRequest(harness.socketPath, { operation: "broker.status" });
      expect(status).toMatchObject({ ok: true, installationCount: 1, bindingCount: 1, schemaVersion: 1 });
      const revokedBinding = await sendAdminRequest(harness.socketPath, {
        operation: "binding.revoke",
        installationId,
        bindingId,
      });
      expect(revokedBinding).toMatchObject({ ok: true, state: "revoked", generation: 2 });
      expect(harness.store.getBinding(installationId, bindingId)?.tombstoneAt).not.toBeNull();
      const revokedInstallation = await sendAdminRequest(harness.socketPath, {
        operation: "installation.revoke",
        installationId,
      });
      expect(revokedInstallation).toMatchObject({ ok: true, state: "revoked" });
      expect(harness.store.getInstallationByCertificate(certificateFingerprint(harness.fixture.clientCertificatePem))).toBeNull();

      const socketMode = statSync(harness.socketPath).mode & 0o777;
      expect(socketMode).toBe(0o600);
      const events = harness.database.db.prepare(
        "SELECT operation, outcome FROM broker_admin_events ORDER BY rowid",
      ).all();
      expect(events).toEqual(expect.arrayContaining([
        { operation: "installation.add", outcome: "succeeded" },
        { operation: "binding.add", outcome: "succeeded" },
        { operation: "binding.revoke", outcome: "succeeded" },
        { operation: "installation.revoke", outcome: "succeeded" },
      ]));
    } finally {
      await harness.close();
    }
  });

  it("atomically enrolls a typed connector and returns only its projection", async () => {
    const harness = await createAdminHarness();
    try {
      const installationId = await enrollInstallation(harness);
      const response = await sendAdminRequest(harness.socketPath, {
        operation: "connector.binding.enroll",
        installationId,
        projectId: "project-1",
        policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
        enabledOperations: ["convex.project.inspect.v1"],
        credentialReference: REFERENCE,
        projection: {
          schemaVersion: 2,
          installationId,
          bindingId: "connector-binding-1",
          operation: "convex.project.inspect.v1",
          bindingKind: "workload_identity",
          authorityProvider: "convex",
          secretProvider: "provider_native",
          principalLabel: "test workload",
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
        },
        target: {
          operation: "convex.project.inspect.v1",
          teamIdOrSlug: "team-1",
          projectSlug: "project-1",
        },
      });
      expect(response).toMatchObject({ ok: true, operation: "connector.binding.enroll", projectId: "project-1", state: "vault_verified" });
      expect(JSON.stringify(response)).not.toContain(REFERENCE);
      expect(harness.connectorStore.getPolicy(installationId, "project-1")).toMatchObject({
        policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
      });
      expect(harness.connectorStore.getBinding(installationId, "connector-binding-1")?.hasCredentialReference).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("rejects malformed and unsafe mutations without leaking input and records failures", async () => {
    const harness = await createAdminHarness();
    try {
      const malformed = await sendAdminRequest(harness.socketPath, installationAddRequest({
        clientCertificatePem: "-----BEGIN PRIVATE KEY----- secret-canary -----END PRIVATE KEY-----",
      }));
      expect(malformed).toMatchObject({ ok: false, operation: "installation.add" });
      const installationId = await enrollInstallation(harness);
      const expired = await sendAdminRequest(harness.socketPath, {
        operation: "installation.attest",
        installationId,
        topologyReceiptDigest: TOPOLOGY_DIGEST,
        topologyReceiptExpiresAt: NOW - 1,
      });
      const overlong = await sendAdminRequest(harness.socketPath, {
        operation: "installation.attest",
        installationId,
        topologyReceiptDigest: TOPOLOGY_DIGEST,
        topologyReceiptExpiresAt: NOW + 2_592_000_001,
      });
      const wrongInstallation = await sendAdminRequest(harness.socketPath, {
        operation: "binding.add",
        installationId: "missing-installation",
        reference: REFERENCE,
        label: "test binding",
        capabilityIds: [],
        risk: "low",
        mfaMode: "none",
        approvalMode: "none",
      });
      const activeAttempt = await sendAdminRequest(harness.socketPath, {
        operation: "binding.add",
        installationId,
        reference: REFERENCE,
        label: "test binding",
        capabilityIds: [],
        risk: "low",
        mfaMode: "none",
        approvalMode: "none",
        state: "active",
      });
      const unknown = await sendAdminRequest(harness.socketPath, { operation: "debug", secret: "canary" });
      for (const response of [malformed, expired, overlong, wrongInstallation, activeAttempt, unknown]) {
        expect(response.ok).toBe(false);
        expect(JSON.stringify(response)).not.toContain("secret-canary");
        expect(JSON.stringify(response)).not.toContain("canary");
      }
      const failedEvents = harness.database.db.prepare(
        "SELECT operation, outcome FROM broker_admin_events WHERE outcome = 'failed'",
      ).all() as Array<{ operation: string; outcome: string }>;
      expect(failedEvents.length).toBeGreaterThanOrEqual(5);
      expect(failedEvents.every((event) => event.outcome === "failed")).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("enforces one request per connection and the 16,384-byte line limit", async () => {
    const harness = await createAdminHarness();
    try {
      const responseCount = await firstResponseRejectsSecondRequest(
        harness.socketPath,
        { operation: "broker.status" },
        { operation: "broker.status" },
      );
      expect(responseCount).toBe(1);
      const oversized = await sendAdminRequest(harness.socketPath, { operation: "broker.status", padding: "x".repeat(16_384) });
      expect(oversized).toMatchObject({ ok: false, code: "line_too_large" });
    } finally {
      await harness.close();
    }
  });

  it("rejects a symlink socket path before binding it", async () => {
    const harness = await createAdminHarness();
    try {
      const symlinkPath = join(harness.fixture.directory, "admin-symlink.sock");
      symlinkSync(harness.socketPath, symlinkPath);
      const server = createAdminServer({
        socketPath: symlinkPath,
        store: harness.store,
        adapter: { health: async () => ({ outcome: "ready" }), verify: async () => ({ outcome: "invalid" }) },
        clock: () => NOW,
        brokerVersion: "0.1.0",
      });
      await expect(server.start()).rejects.toBeTruthy();
    } finally {
      await harness.close();
    }
  });

  it("refuses the 101st binding", async () => {
    const harness = await createAdminHarness();
    try {
      const installationId = await enrollInstallation(harness);
      for (let index = 0; index < 100; index += 1) {
        const itemId = String(index).padStart(26, "0");
        const response = await sendAdminRequest(harness.socketPath, {
          operation: "binding.add",
          installationId,
          reference: `op://${VAULT_ID}/${itemId}/password`,
          label: `binding ${index}`,
          capabilityIds: [],
          risk: "low",
          mfaMode: "none",
          approvalMode: "none",
        });
        expect(response.ok).toBe(true);
      }
      const rejected = await sendAdminRequest(harness.socketPath, {
        operation: "binding.add",
        installationId,
        reference: `op://${VAULT_ID}/${"9".repeat(26)}/password`,
        label: "overflow",
        capabilityIds: [],
        risk: "low",
        mfaMode: "none",
        approvalMode: "none",
      });
      expect(rejected).toMatchObject({ ok: false, code: "binding_limit" });
    } finally {
      await harness.close();
    }
  });

  it("keeps CLI output secret-free", async () => {
    const harness = await createAdminHarness();
    try {
      const output: string[] = [];
      const exitCode = await runAdminCli(["installation", "add", "--stdin"], {
        socketPath: harness.socketPath,
        stdin: JSON.stringify({
          clientCertificatePem: harness.fixture.clientCertificatePem,
          topologyReceiptDigest: TOPOLOGY_DIGEST,
          topologyReceiptExpiresAt: NOW + 60_000,
          expectedVaultId: VAULT_ID,
        }),
        writeStdout: (text) => output.push(text),
        writeStderr: () => undefined,
      });
      expect(exitCode).toBe(0);
      const stdout = output.join("");
      expect(stdout).not.toContain(REFERENCE);
      expect(stdout).not.toContain(VAULT_ID);
      expect(stdout).not.toContain(harness.fixture.clientCertificatePem);
      expect(stdout).not.toContain(certificateFingerprint(harness.fixture.clientCertificatePem));
      expect(stdout).not.toContain(TOPOLOGY_DIGEST);
      expect(stdout).not.toContain("/credstore.encrypted/");
      expect(stdout).not.toContain("SDK");
    } finally {
      await harness.close();
    }
  });
});
