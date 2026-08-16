import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type AddressInfo } from "node:net";
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from "node:https";
import Database from "better-sqlite3";
import { AuthExpiredError, RateLimitExceededError } from "@1password/sdk";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../server";
import { hashSecret } from "../src/crypto";
import {
  FOUNDATION_BROKER_POLICY_DIGEST,
  brokerRequestDigest,
  parseBrokerRequest,
  type BrokerRequestEnvelope,
  type BrokerResponseEnvelope,
} from "../src/credentials/protocol";
import { CredentialBrokerClient, type CredentialBrokerCallOutcome } from "../src/credentials/broker-client";
import type { CredentialBrokerConfigResult } from "../src/credentials/config";
import { parseCredentialBrokerConfig } from "../src/credentials/config";
import { CredentialAccessService, type CredentialBrokerCaller } from "../src/credentials/service";
import { evaluateCredentialFullReadiness } from "../src/credentials/topology";
import { registerControllerTools } from "../src/controller/tools";
import { openStore } from "../src/storage/store";
import type { AuthorizedControllerCapability } from "../src/controller/capability-executor";
import { createOnePasswordAdapter, type VaultAdapter } from "../broker/src/onepassword-adapter";
import { BrokerOperationService } from "../broker/src/operation-service";
import { createAdminServer, type RunningAdminServer } from "../broker/src/admin-server";
import { runAdminCli } from "../broker/src/admin-cli";
import { readSystemdCredentials } from "../broker/src/credentials";
import { fingerprintResolvedVersion } from "../broker/src/crypto";
import { BrokerStore, type BrokerRequestClaimInput } from "../broker/src/store";
import { createBrokerServer } from "../broker/src/server";
import {
  assertCanaryAbsent,
  CREDENTIAL_SECRET_CANARIES,
  fakeOnePasswordPort,
  sqliteCanarySurfaces,
  temporaryBrokerDatabase,
  testClock,
  writePrivateFile,
  type SecretCanarySurface,
  type TemporaryBrokerDatabase,
} from "./support/credential-broker-fixtures";
import { certificateFingerprint, createMtlsFixture, type MtlsFixture } from "./support/mtls-fixtures";

const CANARIES = CREDENTIAL_SECRET_CANARIES;
const DATA_KEY = new Uint8Array(32).fill(0x11);
const AUDIT_KEY = new Uint8Array(32).fill(0x22);
const OTHER_AUDIT_KEY = new Uint8Array(32).fill(0x33);
const NOW = 1_800_000_000_000;
const INSTALLATION_ID = "installation-canary";
const BINDING_ID = "binding-canary";
const TOPOLOGY_DIGEST = "b".repeat(64);
const VAULT_ID = "vault-canary-reference-v11";
const ITEM_ID = "item-canary-reference-v11";
const WRONG_FINGERPRINT = "c".repeat(64);

type ProviderMode = "valid" | "invalid" | "rate" | "auth" | "error" | "timeout";

type SurfaceCollector = Readonly<{
  surfaces: SecretCanarySurface[];
  artifactParts: string[];
  add(name: string, value: unknown): void;
  addText(name: string, value: string): void;
  addFiles(surfaces: readonly SecretCanarySurface[]): void;
}>;

function collector(): SurfaceCollector {
  const surfaces: SecretCanarySurface[] = [];
  const artifactParts: string[] = [];
  return {
    surfaces,
    artifactParts,
    add: (name, value) => {
      const serialized = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
      surfaces.push({ name, value: serialized });
      artifactParts.push(`${name}\n${serialized}`);
    },
    addText: (name, value) => {
      surfaces.push({ name, value });
      artifactParts.push(`${name}\n${value}`);
    },
    addFiles: (files) => {
      for (const surface of files) {
        if (typeof surface === "object" && "path" in surface) {
          surfaces.push({ name: surface.name, value: readFileSync(surface.path) });
        } else {
          surfaces.push(surface);
        }
      }
    },
  };
}

function checkpointAndScanLater(
  database: Database.Database,
  databasePath: string,
  name: string,
  output: SurfaceCollector,
): void {
  database.pragma("wal_checkpoint(PASSIVE)");
  output.add(`${name}:tables`, database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all());
  output.addFiles(sqliteCanarySurfaces(databasePath, name));
}

let requestNumber = 0;

function healthRequest(overrides: Partial<BrokerRequestEnvelope> = {}): BrokerRequestEnvelope {
  const suffix = ++requestNumber;
  return {
    schemaVersion: 1,
    installationId: INSTALLATION_ID,
    requestId: `req_health_canary_${suffix}`,
    idempotencyKey: `idem_health_canary_${suffix}`,
    operation: "broker.health",
    bindingId: null,
    bindingGeneration: null,
    turnId: null,
    capabilityId: "system.broker.health",
    policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
    fenceOwner: null,
    fenceGeneration: null,
    issuedAt: NOW - 1_000,
    deadlineAt: NOW + 10_000,
    nonce: `nonce_health_canary_${suffix}`,
    ...overrides,
  };
}

function verifyRequest(overrides: Partial<BrokerRequestEnvelope> = {}): BrokerRequestEnvelope {
  const suffix = ++requestNumber;
  return {
    schemaVersion: 1,
    installationId: INSTALLATION_ID,
    requestId: `req_verify_canary_${suffix}`,
    idempotencyKey: `idem_verify_canary_${suffix}`,
    operation: "vault.binding.verify",
    bindingId: BINDING_ID,
    bindingGeneration: 1,
    turnId: `turn_canary_${suffix}`,
    capabilityId: "telegram_agent_access_verify",
    policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
    fenceOwner: "executor-canary",
    fenceGeneration: 1,
    issuedAt: NOW - 1_000,
    deadlineAt: NOW + 10_000,
    nonce: `nonce_verify_canary_${suffix}`,
    ...overrides,
  };
}

function claimInput(request: BrokerRequestEnvelope, certificate: string): BrokerRequestClaimInput {
  return {
    installationId: request.installationId,
    certificateFingerprint: certificate,
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    nonce: request.nonce,
    requestDigest: brokerRequestDigest(request),
    operation: request.operation,
    bindingId: request.bindingId,
    bindingGeneration: request.bindingGeneration,
    turnId: request.turnId,
    capabilityId: request.capabilityId,
    policyDigest: request.policyDigest,
    fenceOwner: request.fenceOwner,
    fenceGeneration: request.fenceGeneration,
    issuedAt: request.issuedAt,
    deadlineAt: request.deadlineAt,
    now: NOW,
  };
}

type BrokerCanaryHarness = Readonly<{
  database: TemporaryBrokerDatabase;
  store: BrokerStore;
  adapter: VaultAdapter;
  service: BrokerOperationService;
  mtls: MtlsFixture;
  certificateFingerprint: string;
  setProviderMode(mode: ProviderMode): void;
  setHealthMode(mode: Exclude<ProviderMode, "invalid" | "timeout"> | "valid"): void;
  releaseTimeout(): void;
  close(): void;
}>;

async function createBrokerCanaryHarness(): Promise<BrokerCanaryHarness> {
  const database = temporaryBrokerDatabase();
  const mtls = createMtlsFixture();
  const certificate = certificateFingerprint(mtls.clientCertificatePem);
  const clock = testClock(NOW);
  let providerMode: ProviderMode = "valid";
  let healthMode: "valid" | "rate" | "auth" | "error" = "valid";
  let releasePending: (() => void) | null = null;
  const resolved = {
    outcome: "resolved" as const,
    secret: CANARIES.resolvedSecret,
    vaultId: VAULT_ID,
    itemId: ITEM_ID,
  };
  const port = fakeOnePasswordPort(
    [{ id: VAULT_ID }],
    async (reference) => {
      if (reference !== CANARIES.externalVaultReference) throw new Error("unexpected_reference");
      if (providerMode === "invalid") return { outcome: "invalid" };
      if (providerMode === "rate") throw new RateLimitExceededError(CANARIES.rawSdkError);
      if (providerMode === "auth") throw new AuthExpiredError(CANARIES.rawSdkError);
      if (providerMode === "error") throw new Error(CANARIES.rawSdkError);
      if (providerMode === "timeout") {
        await new Promise<void>((resolve) => { releasePending = resolve; });
      }
      return resolved;
    },
  );
  const adapter = await createOnePasswordAdapter({ serviceToken: CANARIES.serviceAccountToken, port: {
    listVaults: async () => {
      if (healthMode === "rate") throw new RateLimitExceededError(CANARIES.rawSdkError);
      if (healthMode === "auth") throw new AuthExpiredError(CANARIES.rawSdkError);
      if (healthMode === "error") throw new Error(CANARIES.rawSdkError);
      return port.listVaults();
    },
    resolveOne: port.resolveOne,
  } });
  const store = new BrokerStore(database.db, {
    dataKey: DATA_KEY,
    auditKey: AUDIT_KEY,
    clock: clock.now,
  });
  store.addInstallation({
    installationId: INSTALLATION_ID,
    clientCertificateFingerprint: certificate,
    policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
    topologyReceiptDigest: TOPOLOGY_DIGEST,
    topologyReceiptExpiresAt: NOW + 60_000,
    expectedVaultId: VAULT_ID,
    now: NOW,
  });
  store.addBinding({
    installationId: INSTALLATION_ID,
    bindingId: BINDING_ID,
    reference: CANARIES.externalVaultReference,
    label: "Canary binding",
    capabilityIds: ["telegram_agent_access_verify"],
    risk: "high",
    mfaMode: "none",
    approvalMode: "none",
    now: NOW,
  });
  const service = new BrokerOperationService({
    store,
    adapter,
    dataKey: DATA_KEY,
    auditKey: AUDIT_KEY,
    clock: clock.now,
    brokerVersion: "0.1.0",
  });
  return {
    database,
    store,
    adapter,
    service,
    mtls,
    certificateFingerprint: certificate,
    setProviderMode: (mode) => { providerMode = mode; },
    setHealthMode: (mode) => { healthMode = mode; },
    releaseTimeout: () => {
      releasePending?.();
      releasePending = null;
    },
    close: () => {
      releasePending?.();
      database.close();
      mtls.cleanup();
    },
  };
}

type HanoonCanaryHarness = Readonly<{
  bb: ReturnType<typeof createFakePluginHost>["bb"];
  harness: ReturnType<typeof createFakePluginHost>["harness"];
  store: ReturnType<typeof openStore>;
  client: CredentialBrokerCaller & { call: ReturnType<typeof vi.fn> };
  service: CredentialAccessService;
  authorized(): AuthorizedControllerCapability;
  invalidateFence(): void;
  setTrustKernelReady(value: boolean): void;
}>;

let hanoonFixtureNumber = 0;

function createHanoonCanaryHarness(broker: BrokerCanaryHarness): HanoonCanaryHarness {
  hanoonFixtureNumber += 1;
  const { bb, harness } = createFakePluginHost({ pluginId: `credential-canary-hanoon-${hanoonFixtureNumber}` });
  const store = openStore(bb.storage, bb.storage.kv, () => NOW);
  const pairingCode = `canary-pair-${hanoonFixtureNumber}`;
  const pairingCodeHash = hashSecret(pairingCode);
  store.createPairingCode(pairingCodeHash, NOW - 1_000, NOW + 60_000);
  expect(store.pairOwnerWithCode(pairingCodeHash, "7", "7", NOW)).toEqual({ ok: true });
  const threadId = `thr_credential_canary_${hanoonFixtureNumber}`;
  const queued = store.enqueueControllerTurn({
    controllerKey: `owner-7-canary-${hanoonFixtureNumber}`,
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 70_000 + hanoonFixtureNumber,
    inputText: "Verify the canary binding.",
    now: NOW,
    origin: "owner",
  });
  const initialFence = store.acquireExecutorLease("executor-canary", NOW, 60_000);
  if (!initialFence.acquired) throw new Error("canary_executor_lease_missing");
  const fence = { ownerId: "executor-canary", generation: initialFence.generation, now: NOW };
  if (store.claimNextControllerTurn(fence)?.id !== queued.id) throw new Error("canary_turn_claim_missing");
  expect(store.markControllerSpawned({
    ...fence,
    turnId: queued.id,
    projectId: "project-canary",
    hostId: "host-canary",
    threadId,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, turnId: queued.id })).toBe(true);

  let trustKernelReady = true;
  const config: CredentialBrokerConfigResult = {
    state: "isolated",
    value: {
      mode: "isolated",
      endpointOrigin: "https://broker.canary.internal",
      installationId: INSTALLATION_ID,
      topologyReceiptDigest: TOPOLOGY_DIGEST,
      topologyReceiptExpiresAt: NOW + 60_000,
      clientCertificatePem: "public-canary-certificate",
      clientKeyPem: CANARIES.clientPrivateKey,
      caCertificatePem: "public-canary-ca",
    },
  };
  const client = {
    call: vi.fn(async (envelope: BrokerRequestEnvelope): Promise<CredentialBrokerCallOutcome> => ({
      outcome: "succeeded",
      response: await broker.service.execute({
        certificateFingerprint: broker.certificateFingerprint,
        now: NOW,
        request: envelope,
      }),
    })),
  } satisfies CredentialBrokerCaller & { call: ReturnType<typeof vi.fn> };
  const service = new CredentialAccessService({
    store,
    client,
    config: () => config,
    trustKernelReady: () => trustKernelReady,
    controllerPermissionMode: () => "auto",
    now: () => NOW,
  });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => NOW,
    credentialAccess: service,
  });

  return {
    bb,
    harness,
    store,
    client,
    service,
    authorized: () => {
      const controller = store.getControllerByThreadId(threadId);
      const turn = store.getPendingControllerTurn(`owner-7-canary-${hanoonFixtureNumber}`);
      if (!controller || !turn) throw new Error("canary_controller_turn_missing");
      return { controller, turn, fence } as AuthorizedControllerCapability;
    },
    invalidateFence: () => {
      const stolen = store.acquireExecutorLease("executor-canary-replacement", NOW + 61_000, 60_000);
      if (!stolen.acquired) throw new Error("canary_executor_fence_not_stolen");
    },
    setTrustKernelReady: (value) => { trustKernelReady = value; },
  };
}

function parseToolResult(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("canary_tool_result_not_text");
  return JSON.parse(value);
}

type LocalTlsMaterial = Readonly<{
  directory: string;
  certificatePem: string;
  privateKeyPem: string;
  cleanup(): void;
}>;

function createLocalTlsMaterial(): LocalTlsMaterial {
  const directory = mkdtempSync(join(tmpdir(), "credential-canary-client-"));
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key",
      "-out", "server.crt", "-days", "1", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1",
    ], { cwd: directory, stdio: "ignore" });
    let cleaned = false;
    return {
      directory,
      certificatePem: readFileSync(join(directory, "server.crt"), "utf8"),
      privateKeyPem: readFileSync(join(directory, "server.key"), "utf8"),
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function listenHttps(server: HttpsServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address === "string") {
        reject(new Error("canary_https_address_missing"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeHttps(server: HttpsServer): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function sendHttpsCanaryRequest(
  port: number,
  mtls: MtlsFixture,
  body: unknown,
  options: Readonly<{ certificatePem?: string; privateKeyPem?: string }> = {},
): Promise<Readonly<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }>> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/v1/operations",
      servername: "broker.test",
      ca: mtls.caCertificatePem,
      cert: options.certificatePem ?? mtls.clientCertificatePem,
      key: options.privateKeyPem ?? mtls.clientPrivateKeyPem,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      headers: { "content-type": "application/json" },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers as Record<string, string | string[] | undefined>,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end(JSON.stringify(body));
  });
}

async function sendUnixCanaryRequest(socketPath: string, body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("error", reject);
    socket.once("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("connect", () => socket.end(`${JSON.stringify(body)}\n`));
  });
}

function directHanoonConfigWithCanaryKey(): CredentialBrokerConfigResult {
  return {
    state: "isolated",
    value: {
      mode: "isolated",
      endpointOrigin: "https://broker.canary.internal",
      installationId: INSTALLATION_ID,
      topologyReceiptDigest: TOPOLOGY_DIGEST,
      topologyReceiptExpiresAt: NOW + 60_000,
      clientCertificatePem: "public-canary-certificate",
      clientKeyPem: CANARIES.clientPrivateKey,
      caCertificatePem: "public-canary-ca",
    },
  };
}

async function createCliCanaryHost(): Promise<ReturnType<typeof createFakePluginHost>> {
  const host = createFakePluginHost({
    pluginId: `credential-canary-cli-${++hanoonFixtureNumber}`,
    settings: {
      botToken: "123:synthetic-canary-bot-token",
      credentialBrokerMode: "isolated",
      credentialBrokerEndpoint: "https://broker.canary.internal",
      credentialBrokerInstallationId: INSTALLATION_ID,
      credentialBrokerTopologyReceiptDigest: TOPOLOGY_DIGEST,
      credentialBrokerTopologyReceiptExpiresAt: String(NOW + 60_000),
      credentialBrokerClientCertificate: "public-canary-certificate",
      credentialBrokerClientKey: CANARIES.clientPrivateKey,
      credentialBrokerCaCertificate: "public-canary-ca",
    },
    sdk: { subscribe: () => () => undefined },
  });
  await plugin(host.bb);
  return host;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("credential secret-canary proving", () => {
  it("proves the scanner is red before the synthetic leak is removed", () => {
    const directory = mkdtempSync(join(tmpdir(), "credential-canary-red-state-"));
    const path = join(directory, "synthetic-log.txt");
    try {
      const resolved = CANARIES.resolvedSecret;
      const deliberateLeaks: readonly SecretCanarySurface[] = [
        { name: "synthetic-full-log", value: `provider log: ${resolved}` },
        { name: "synthetic-first-fragment", value: resolved.slice(0, 8) },
        { name: "synthetic-last-fragment", value: resolved.slice(-8) },
        { name: "synthetic-base64", value: Buffer.from(resolved, "utf8").toString("base64") },
        { name: "synthetic-base64url", value: Buffer.from(resolved, "utf8").toString("base64url") },
        { name: "synthetic-url", value: encodeURIComponent(resolved) },
        { name: "synthetic-json", value: JSON.stringify(resolved) },
      ];

      for (const leak of deliberateLeaks) {
        expect(() => assertCanaryAbsent([leak], CANARIES)).toThrow(
          "secret_canary_found:resolvedSecret",
        );
      }

      writePrivateFile(path, JSON.stringify({ event: "synthetic", value: resolved }));
      expect(() => assertCanaryAbsent([{ name: "synthetic-file", path }], CANARIES)).toThrow(
        "secret_canary_found:resolvedSecret",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps every broker and Hanoon surface free after all deterministic flows", async () => {
    const output = collector();
    const hanoonReturned: unknown[] = [];
    const scanCollectedSurfaces = (): void => assertCanaryAbsent(output.surfaces, CANARIES);
    const broker = await createBrokerCanaryHarness();
    const hanoon = createHanoonCanaryHarness(broker);
    let adminServer: RunningAdminServer | null = null;
    let brokerHttpServer: ReturnType<typeof createBrokerServer> | null = null;
    let clientTlsMaterial: LocalTlsMaterial | null = null;
    let redirectServer: HttpsServer | null = null;
    let timeoutServer: HttpsServer | null = null;
    let cliHost: Awaited<ReturnType<typeof createCliCanaryHost>> | null = null;
    let artifactDirectory: string | null = null;
    let packageCacheDirectory: string | null = null;

    try {
      broker.setHealthMode("valid");
      broker.setProviderMode("valid");

      const healthEnvelope = healthRequest();
      const health = await broker.service.execute({
        certificateFingerprint: broker.certificateFingerprint,
        now: NOW,
        request: healthEnvelope,
      });
      expect(health).toMatchObject({ outcome: "succeeded", result: "ready" });
      output.add("broker-health-response", health);

      const hanoonStatus = await hanoon.service.status({ bindingId: BINDING_ID });
      expect(hanoonStatus.readiness.state).toBe("ready");
      output.add("hanoon-health-status", hanoonStatus);
      hanoonReturned.push(hanoonStatus);
      scanCollectedSurfaces();

      const validEnvelope = verifyRequest();
      const valid = await broker.service.execute({
        certificateFingerprint: broker.certificateFingerprint,
        now: NOW,
        request: validEnvelope,
      });
      expect(valid).toMatchObject({ outcome: "succeeded", result: "valid" });
      output.add("broker-valid-response", valid);

      const hanoonValid = await hanoon.service.verify({
        bindingId: BINDING_ID,
        authorized: hanoon.authorized(),
      });
      expect(hanoonValid).toMatchObject({ outcome: "verified", result: "valid" });
      output.add("hanoon-valid-result", hanoonValid);
      hanoonReturned.push(hanoonValid);
      scanCollectedSurfaces();

      broker.setProviderMode("invalid");
      const hanoonInvalid = await hanoon.service.verify({
        bindingId: BINDING_ID,
        authorized: hanoon.authorized(),
      });
      expect(hanoonInvalid).toMatchObject({ outcome: "verified", result: "invalid", state: "degraded" });
      output.add("hanoon-invalid-result", hanoonInvalid);
      hanoonReturned.push(hanoonInvalid);
      scanCollectedSurfaces();

      broker.setProviderMode("rate");
      const rateLimited = await broker.service.execute({
        certificateFingerprint: broker.certificateFingerprint,
        now: NOW,
        request: verifyRequest(),
      });
      expect(rateLimited).toMatchObject({ outcome: "failed", failureClass: "provider_rate_limited", retryable: true });
      output.add("broker-rate-limit-response", rateLimited);
      scanCollectedSurfaces();

      broker.setProviderMode("auth");
      const authFailed = await broker.service.execute({
        certificateFingerprint: broker.certificateFingerprint,
        now: NOW,
        request: verifyRequest(),
      });
      expect(authFailed).toMatchObject({ outcome: "failed", failureClass: "vault_auth_failed", retryable: false });
      output.add("broker-auth-failure-response", authFailed);
      scanCollectedSurfaces();

      broker.setProviderMode("error");
      const rawSdkErrorMapped = await broker.service.execute({
        certificateFingerprint: broker.certificateFingerprint,
        now: NOW,
        request: verifyRequest(),
      });
      expect(rawSdkErrorMapped).toMatchObject({ outcome: "failed", failureClass: "provider_unavailable" });
      output.add("broker-raw-sdk-error-response", rawSdkErrorMapped);

      broker.setHealthMode("auth");
      const healthAuthFailure = await broker.service.execute({
        certificateFingerprint: broker.certificateFingerprint,
        now: NOW,
        request: healthRequest(),
      });
      expect(healthAuthFailure).toMatchObject({ outcome: "failed", failureClass: "vault_auth_failed" });
      output.add("broker-health-auth-failure-response", healthAuthFailure);
      scanCollectedSurfaces();
      broker.setHealthMode("valid");
      broker.setProviderMode("valid");

      const timeoutEnvelope = verifyRequest();
      broker.setProviderMode("timeout");
      const activeCall = broker.service.execute({
        certificateFingerprint: broker.certificateFingerprint,
        now: NOW,
        request: timeoutEnvelope,
      });
      await Promise.resolve();
      const activeRetry = await broker.service.execute({
        certificateFingerprint: broker.certificateFingerprint,
        now: NOW + 1_000,
        request: timeoutEnvelope,
      });
      expect(activeRetry).toMatchObject({ outcome: "failed", failureClass: "result_ambiguous", receiptId: null });
      output.add("broker-timeout-retry-response", activeRetry);
      broker.releaseTimeout();
      const timeoutCompletion = await activeCall;
      expect(timeoutCompletion).toMatchObject({ outcome: "succeeded", result: "valid" });
      output.add("broker-timeout-completion", timeoutCompletion);

      hanoon.client.call.mockResolvedValueOnce({ outcome: "ambiguous" } satisfies CredentialBrokerCallOutcome);
      const hanoonTimeout = await hanoon.service.verify({
        bindingId: BINDING_ID,
        authorized: hanoon.authorized(),
      });
      expect(hanoonTimeout).toEqual({ outcome: "ambiguous" });
      output.add("hanoon-timeout-result", hanoonTimeout);
      hanoonReturned.push(hanoonTimeout);
      scanCollectedSurfaces();
      hanoon.client.call.mockImplementation(async (envelope: BrokerRequestEnvelope) => ({
        outcome: "succeeded",
        response: await broker.service.execute({
          certificateFingerprint: broker.certificateFingerprint,
          now: NOW,
          request: envelope,
        }),
      }));

      const interruptedEnvelope = verifyRequest();
      expect(broker.store.claimRequest(claimInput(interruptedEnvelope, broker.certificateFingerprint))).toEqual({ outcome: "claimed" });
      const restartedService = new BrokerOperationService({
        store: broker.store,
        adapter: broker.adapter,
        dataKey: DATA_KEY,
        auditKey: AUDIT_KEY,
        clock: () => NOW,
        brokerVersion: "0.1.0",
      });
      const restarted = await restartedService.execute({
        certificateFingerprint: broker.certificateFingerprint,
        now: NOW,
        request: interruptedEnvelope,
      });
      expect(restarted).toMatchObject({ outcome: "failed", failureClass: "result_ambiguous", receiptId: expect.any(String) });
      output.add("broker-restart-response", restarted);
      scanCollectedSurfaces();

      const agentRequest = {
        ...healthRequest(),
        endpoint: "https://attacker.example",
        reference: CANARIES.externalVaultReference,
        operationName: "provider.resolve",
        providerArgument: CANARIES.serviceAccountToken,
      };
      const agentRequestResult = parseBrokerRequest(agentRequest);
      expect(agentRequestResult).toEqual({ ok: false, code: "unknown_field" });
      output.add("agent-supplied-request-rejection", agentRequestResult);

      const agentConfigResult = parseCredentialBrokerConfig({
        credentialBrokerMode: "isolated",
        credentialBrokerEndpoint: "https://attacker.example",
        credentialBrokerInstallationId: INSTALLATION_ID,
        credentialBrokerTopologyReceiptDigest: TOPOLOGY_DIGEST,
        credentialBrokerTopologyReceiptExpiresAt: String(NOW + 1_000),
        credentialBrokerClientCertificate: "not-a-certificate",
        credentialBrokerClientKey: CANARIES.clientPrivateKey,
        credentialBrokerCaCertificate: "not-a-ca",
      });
      expect(agentConfigResult).toEqual({ state: "invalid", code: "invalid_pem" });
      output.add("agent-supplied-config-rejection", agentConfigResult);
      hanoonReturned.push(agentConfigResult);

      const verifyTool = hanoon.harness.registrations.agentTools.find((tool) => tool.name === "telegram_agent_access_verify");
      if (!verifyTool) throw new Error("canary_verify_tool_missing");
      const agentToolParse = verifyTool.parse({
        bindingId: BINDING_ID,
        endpoint: "https://attacker.example",
        reference: CANARIES.externalVaultReference,
        operation: "provider.resolve",
        providerArg: CANARIES.serviceAccountToken,
      });
      expect(agentToolParse.ok).toBe(false);
      output.add("agent-supplied-tool-rejection", agentToolParse);
      hanoonReturned.push(agentToolParse);

      broker.setProviderMode("valid");
      const toolList = parseToolResult(await hanoon.harness.behavior.callAgentTool(
        "telegram_agent_access_list",
        {},
        { threadId: `thr_credential_canary_${hanoonFixtureNumber}`, projectId: "project-canary" },
      ));
      const toolStatus = parseToolResult(await hanoon.harness.behavior.callAgentTool(
        "telegram_agent_access_status",
        {},
        { threadId: `thr_credential_canary_${hanoonFixtureNumber}`, projectId: "project-canary" },
      ));
      const toolVerify = parseToolResult(await hanoon.harness.behavior.callAgentTool(
        "telegram_agent_access_verify",
        { bindingId: BINDING_ID },
        { threadId: `thr_credential_canary_${hanoonFixtureNumber}`, projectId: "project-canary" },
      ));
      expect(toolList).toMatchObject({ available: true });
      expect(toolStatus).toMatchObject({ readiness: { state: "ready" } });
      expect(toolVerify).toMatchObject({ outcome: "verified", result: "valid" });
      output.add("hanoon-tool-list", toolList);
      output.add("hanoon-tool-status", toolStatus);
      output.add("hanoon-tool-verify", toolVerify);
      const toolVerifyEvidence = toolVerify && typeof toolVerify === "object"
        ? (toolVerify as { _hanoonEvidence?: unknown })._hanoonEvidence
        : undefined;
      expect(toolVerifyEvidence).toBeDefined();
      output.add("hanoon-tool-evidence", toolVerifyEvidence);
      hanoonReturned.push(toolList, toolStatus, toolVerify, toolVerifyEvidence);
      scanCollectedSurfaces();

      const staleFenceAuthorized = hanoon.authorized();
      hanoon.invalidateFence();
      const staleFence = await hanoon.service.verify({ bindingId: BINDING_ID, authorized: staleFenceAuthorized });
      expect(staleFence).toEqual({ outcome: "denied", reason: "stale_fence" });
      output.add("stale-executor-fence-result", staleFence);
      hanoonReturned.push(staleFence);
      scanCollectedSurfaces();

      const topologyMismatch = evaluateCredentialFullReadiness({
        trustKernelReady: true,
        controllerPermissionMode: "auto",
        config: directHanoonConfigWithCanaryKey(),
        now: NOW,
        health: {
          protocolVersion: 1,
          brokerVersion: "0.1.0",
          adapter: "onepassword",
          adapterState: "ready",
          auditWritable: true,
          bindingCount: 1,
          topologyReceiptDigest: "d".repeat(64),
          topologyReceiptExpiresAt: NOW + 60_000,
        },
        healthResponseInstallationId: INSTALLATION_ID,
      });
      expect(topologyMismatch.state).toBe("unsafe_topology");
      output.add("topology-digest-mismatch", topologyMismatch);
      hanoonReturned.push(topologyMismatch);

      const wrongCertificate = await broker.service.execute({
        certificateFingerprint: WRONG_FINGERPRINT,
        now: NOW,
        request: healthRequest(),
      });
      expect(wrongCertificate).toMatchObject({ outcome: "failed", failureClass: "broker_auth_failed" });
      output.add("wrong-installation-certificate-response", wrongCertificate);

      const staleBinding = await broker.service.execute({
        certificateFingerprint: broker.certificateFingerprint,
        now: NOW,
        request: verifyRequest({ bindingGeneration: 999 }),
      });
      expect(staleBinding).toMatchObject({ outcome: "failed", failureClass: "binding_generation_stale" });
      output.add("stale-binding-generation-response", staleBinding);

      const adminSocketPath = join(broker.mtls.directory, "admin.sock");
      adminServer = createAdminServer({
        socketPath: adminSocketPath,
        store: broker.store,
        adapter: broker.adapter,
        clock: () => NOW,
        brokerVersion: "0.1.0",
      });
      await adminServer.start();
      const adminStatusRaw = await sendUnixCanaryRequest(adminSocketPath, { operation: "broker.status" });
      output.addText("unix-broker-status-response", adminStatusRaw);
      const adminDoctorRaw = await sendUnixCanaryRequest(adminSocketPath, {
        operation: "installation.doctor",
        installationId: INSTALLATION_ID,
      });
      output.addText("unix-installation-doctor-response", adminDoctorRaw);
      const adminMalformedRaw = await sendUnixCanaryRequest(adminSocketPath, {
        operation: "debug",
        clientPrivateKey: CANARIES.clientPrivateKey,
        externalReference: CANARIES.externalVaultReference,
      });
      output.addText("unix-malformed-response", adminMalformedRaw);
      const adminCliStdout: string[] = [];
      const adminCliStderr: string[] = [];
      const adminCliExit = await runAdminCli(["status", "--json"], {
        socketPath: adminSocketPath,
        writeStdout: (text) => adminCliStdout.push(text),
        writeStderr: (text) => adminCliStderr.push(text),
      });
      expect(adminCliExit).toBe(0);
      output.add("unix-cli-stdout", adminCliStdout.join(""));
      output.add("unix-cli-stderr", adminCliStderr.join(""));

      const revokedBindingRaw = await sendUnixCanaryRequest(adminSocketPath, {
        operation: "binding.revoke",
        installationId: INSTALLATION_ID,
        bindingId: BINDING_ID,
      });
      output.addText("unix-revoke-response", revokedBindingRaw);
      const revoked = await broker.service.execute({
        certificateFingerprint: broker.certificateFingerprint,
        now: NOW,
        request: verifyRequest({ bindingGeneration: 1 }),
      });
      expect(revoked).toMatchObject({ outcome: "failed", failureClass: "binding_inactive" });
      output.add("broker-revoked-binding-response", revoked);
      scanCollectedSurfaces();

      brokerHttpServer = createBrokerServer({
        serverCertificatePem: broker.mtls.serverCertificatePem,
        serverPrivateKeyPem: broker.mtls.serverPrivateKeyPem,
        clientCaCertificatePem: broker.mtls.caCertificatePem,
        service: broker.service,
        clock: () => NOW,
      });
      const brokerPort = await listenHttps(brokerHttpServer);
      const httpHealth = await sendHttpsCanaryRequest(brokerPort, broker.mtls, healthRequest());
      expect(httpHealth.statusCode).toBe(200);
      output.add("http-health-response", httpHealth);
      const httpUnknown = await sendHttpsCanaryRequest(brokerPort, broker.mtls, {
        ...healthRequest(),
        unknownProtocolKey: CANARIES.rawSdkError,
      });
      expect(httpUnknown.statusCode).toBe(400);
      output.add("http-unknown-key-response", httpUnknown);
      const httpWrongCertificate = await sendHttpsCanaryRequest(brokerPort, broker.mtls, healthRequest(), {
        certificatePem: broker.mtls.wrongInstallationCertificatePem,
        privateKeyPem: broker.mtls.wrongInstallationPrivateKeyPem,
      });
      output.add("http-wrong-certificate-response", httpWrongCertificate);

      clientTlsMaterial = createLocalTlsMaterial();
      redirectServer = createHttpsServer({ cert: clientTlsMaterial.certificatePem, key: clientTlsMaterial.privateKeyPem }, (_request, response) => {
        response.writeHead(302, { Location: "https://outside.example/v1/operations" });
        response.end();
      });
      const redirectPort = await listenHttps(redirectServer);
      const clientConfig = {
        mode: "isolated" as const,
        endpointOrigin: `https://127.0.0.1:${redirectPort}`,
        installationId: INSTALLATION_ID,
        topologyReceiptDigest: TOPOLOGY_DIGEST,
        topologyReceiptExpiresAt: NOW + 60_000,
        clientCertificatePem: clientTlsMaterial.certificatePem,
        clientKeyPem: clientTlsMaterial.privateKeyPem,
        caCertificatePem: clientTlsMaterial.certificatePem,
      };
      const redirectOutcome = await new CredentialBrokerClient(clientConfig, { clock: () => NOW }).call(healthRequest({ issuedAt: NOW, deadlineAt: NOW + 5_000 }));
      expect(redirectOutcome).toEqual({ outcome: "failed", reason: "redirect_rejected" });
      output.add("client-redirect-outcome", redirectOutcome);

      timeoutServer = createHttpsServer({ cert: clientTlsMaterial.certificatePem, key: clientTlsMaterial.privateKeyPem }, () => undefined);
      const timeoutPort = await listenHttps(timeoutServer);
      const timeoutOutcome = await new CredentialBrokerClient({
        ...clientConfig,
        endpointOrigin: `https://127.0.0.1:${timeoutPort}`,
      }, { clock: () => NOW }).call(healthRequest({ issuedAt: NOW, deadlineAt: NOW + 25 }));
      expect(timeoutOutcome).toEqual({ outcome: "ambiguous" });
      output.add("client-timeout-outcome", timeoutOutcome);

      const environmentError = (() => {
        const previous = process.env.OP_SERVICE_ACCOUNT_TOKEN;
        process.env.OP_SERVICE_ACCOUNT_TOKEN = CANARIES.serviceAccountToken;
        try {
          expect(() => readSystemdCredentials("/no/such/credential-directory")).toThrow();
          try {
            readSystemdCredentials("/no/such/credential-directory");
          } catch (error) {
            return String(error);
          }
          return "no-error";
        } finally {
          if (previous === undefined) delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
          else process.env.OP_SERVICE_ACCOUNT_TOKEN = previous;
        }
      })();
      output.addText("environment-token-startup-error", environmentError);

      const auditDatabase = temporaryBrokerDatabase();
      try {
        const auditStore = new BrokerStore(auditDatabase.db, { dataKey: DATA_KEY, auditKey: AUDIT_KEY, clock: () => NOW });
        auditStore.addInstallation({
          installationId: INSTALLATION_ID,
          clientCertificateFingerprint: broker.certificateFingerprint,
          policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
          topologyReceiptDigest: TOPOLOGY_DIGEST,
          topologyReceiptExpiresAt: NOW + 60_000,
          expectedVaultId: VAULT_ID,
          now: NOW,
        });
        auditStore.addBinding({
          installationId: INSTALLATION_ID,
          bindingId: BINDING_ID,
          reference: CANARIES.externalVaultReference,
          label: "Canary audit binding",
          capabilityIds: ["telegram_agent_access_verify"],
          risk: "high",
          mfaMode: "none",
          approvalMode: "none",
          now: NOW,
        });
        const auditService = new BrokerOperationService({
          store: auditStore,
          adapter: {
            health: async () => ({ outcome: "ready" }),
            verify: async () => ({
              outcome: "valid",
              versionHmac: fingerprintResolvedVersion(CANARIES.resolvedSecret, AUDIT_KEY),
            }),
          },
          dataKey: DATA_KEY,
          auditKey: AUDIT_KEY,
          clock: () => NOW,
          brokerVersion: "0.1.0",
        });
        auditDatabase.db.exec("CREATE TRIGGER fail_canary_audit BEFORE INSERT ON broker_receipts BEGIN SELECT RAISE(ABORT, 'audit failure'); END");
        const auditFailure = await auditService.execute({
          certificateFingerprint: broker.certificateFingerprint,
          now: NOW,
          request: verifyRequest(),
        });
        expect(auditFailure).toMatchObject({ outcome: "failed", failureClass: "receipt_persistence_failed", receiptId: null });
        output.add("audit-failure-response", auditFailure);
        checkpointAndScanLater(auditDatabase.db, auditDatabase.databasePath, "audit-failure-broker", output);
      } finally {
        auditDatabase.close();
      }

      const reusedEnvelope = healthRequest();
      const reusedFirst = await broker.service.execute({
        certificateFingerprint: broker.certificateFingerprint,
        now: NOW,
        request: reusedEnvelope,
      });
      const changedIdentity = await broker.service.execute({
        certificateFingerprint: broker.certificateFingerprint,
        now: NOW,
        request: { ...reusedEnvelope, requestId: `req_changed_${requestNumber}`, nonce: `nonce_changed_${requestNumber}` },
      });
      expect(changedIdentity).toMatchObject({ outcome: "failed", failureClass: "request_rejected" });
      const reusedReplay = await broker.service.execute({
        certificateFingerprint: broker.certificateFingerprint,
        now: NOW,
        request: reusedEnvelope,
      });
      expect(JSON.stringify(reusedReplay)).toBe(JSON.stringify(reusedFirst));
      output.add("idempotency-original-response", reusedFirst);
      output.add("idempotency-changed-response", changedIdentity);
      output.add("idempotency-replay-response", reusedReplay);

      for (let index = 2; index <= 100; index += 1) {
        broker.store.addBinding({
          installationId: INSTALLATION_ID,
          bindingId: `binding-overflow-${index}`,
          reference: `op://${VAULT_ID}/item-overflow-${index}/field-overflow`,
          label: `Overflow binding ${index}`,
          capabilityIds: [],
          risk: "low",
          mfaMode: "none",
          approvalMode: "none",
          now: NOW,
        });
      }
      expect(broker.store.getBindingCount()).toBe(100);
      let overflowError = "no-error";
      try {
        broker.store.addBinding({
          installationId: INSTALLATION_ID,
          bindingId: "binding-overflow-101",
          reference: `op://${VAULT_ID}/item-overflow-101/field-overflow`,
          label: "Overflow binding 101",
          capabilityIds: [],
          risk: "low",
          mfaMode: "none",
          approvalMode: "none",
          now: NOW,
        });
      } catch (error) {
        overflowError = String(error);
      }
      expect(overflowError).toContain("binding_limit");
      output.addText("101st-binding-error", overflowError);

      cliHost = await createCliCanaryHost();
      const cliList = await cliHost.harness.behavior.runCli(["access", "list", "--json"]);
      const cliStatus = await cliHost.harness.behavior.runCli(["access", "status", "--json"]);
      const doctor = await cliHost.harness.behavior.runCli(["doctor", "--json"]);
      output.add("cli-access-list", cliList);
      output.add("cli-access-status", cliStatus);
      output.add("cli-doctor", doctor);
      hanoonReturned.push(cliList, cliStatus, doctor);
      output.add("bb-fake-host-events", cliHost.harness.inspection.realtimeSignals);
      output.add("bb-fake-host-sdk-calls", cliHost.harness.inspection.sdk.calls);
      output.add("bb-fake-host-log-entries", cliHost.harness.inspection.logEntries);
      output.add("bb-fake-host-needs-configuration", cliHost.harness.inspection.needsConfigurationMessages);

      const hanoonDatabase = hanoon.bb.storage.database();
      output.add("telegram-outbox", hanoonDatabase.prepare("SELECT * FROM outbox ORDER BY logical_key").all());
      checkpointAndScanLater(hanoonDatabase, hanoonDatabase.name, "hanoon", output);
      checkpointAndScanLater(broker.database.db, broker.database.databasePath, "broker", output);

      packageCacheDirectory = mkdtempSync(join(tmpdir(), "credential-canary-npm-cache-"));
      const packageListing = execFileSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, npm_config_cache: packageCacheDirectory },
      });
      output.addText("package-dry-run-listing", packageListing);

      artifactDirectory = mkdtempSync(join(tmpdir(), "credential-canary-artifact-"));
      const artifactPath = join(artifactDirectory, "canary-report.txt");
      writePrivateFile(artifactPath, output.artifactParts.join("\n"));
      output.addFiles([{ name: "test-artifact", path: artifactPath }]);

      const expectedAuditFingerprint = fingerprintResolvedVersion(CANARIES.resolvedSecret, AUDIT_KEY);
      const wrongKeyFingerprint = fingerprintResolvedVersion(CANARIES.resolvedSecret, OTHER_AUDIT_KEY);
      const brokerBytes = Buffer.concat([
        readFileSync(broker.database.databasePath),
        ...(broker.database.walPath ? [readFileSync(broker.database.walPath)] : []),
        ...(broker.database.shmPath ? [readFileSync(broker.database.shmPath)] : []),
      ]);
      expect(brokerBytes.includes(Buffer.from(expectedAuditFingerprint, "utf8"))).toBe(true);
      const hanoonBytes = Buffer.concat(sqliteCanarySurfaces(hanoonDatabase.name, "hanoon")
        .filter((surface): surface is Readonly<{ path: string }> => typeof surface === "object" && "path" in surface)
        .map((surface) => readFileSync(surface.path)));
      expect(hanoonBytes.includes(Buffer.from(expectedAuditFingerprint, "utf8"))).toBe(false);
      expect(hanoonBytes.includes(Buffer.from(wrongKeyFingerprint, "utf8"))).toBe(false);
      expect(JSON.stringify(hanoonReturned)).not.toContain(expectedAuditFingerprint);
      expect(JSON.stringify(hanoonReturned)).not.toContain(wrongKeyFingerprint);
      expect(output.artifactParts.join("\n")).not.toContain(expectedAuditFingerprint);

      assertCanaryAbsent(output.surfaces, CANARIES);
    } finally {
      if (adminServer) await adminServer.close();
      if (brokerHttpServer) await closeHttps(brokerHttpServer);
      if (redirectServer) await closeHttps(redirectServer);
      if (timeoutServer) await closeHttps(timeoutServer);
      clientTlsMaterial?.cleanup();
      if (cliHost) await cliHost.harness.lifecycle.dispose();
      artifactDirectory && rmSync(artifactDirectory, { recursive: true, force: true });
      packageCacheDirectory && rmSync(packageCacheDirectory, { recursive: true, force: true });
      broker.close();
    }
  });
});
