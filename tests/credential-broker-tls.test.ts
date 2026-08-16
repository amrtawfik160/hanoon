import { createHash } from "node:crypto";
import { request as httpsRequest, type Agent } from "node:https";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  FOUNDATION_BROKER_POLICY_DIGEST,
  parseBrokerResponse,
  type BrokerRequestEnvelope,
  type BrokerResponseEnvelope,
} from "../src/credentials/protocol";
import { BrokerOperationService } from "../broker/src/operation-service";
import { BrokerStore } from "../broker/src/store";
import type { VaultAdapter } from "../broker/src/onepassword-adapter";
import { createBrokerServer } from "../broker/src/server";
import { temporaryBrokerDatabase } from "./support/credential-broker-fixtures";
import {
  certificateFingerprint,
  createMtlsFixture,
  type MtlsFixture,
} from "./support/mtls-fixtures";

const NOW = 1_800_000_000_000;
const CLIENT_CERTIFICATE_FINGERPRINT = "a".repeat(64);

type HttpResult = Readonly<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}>;

type TestHarness = Readonly<{
  fixture: MtlsFixture;
  database: ReturnType<typeof temporaryBrokerDatabase>;
  server: ReturnType<typeof createBrokerServer>;
  port: number;
  adapterCalls: { health: number; verify: number };
  close(): Promise<void>;
}>;

type ClientRequestOptions = Readonly<{
  certificatePem?: string | null;
  privateKeyPem?: string | null;
  caCertificatePem?: string;
  serverName?: string;
  method?: string;
  path?: string;
  contentType?: string;
  body?: string;
  contentLength?: string;
  minVersion?: "TLSv1.2" | "TLSv1.3";
  maxVersion?: "TLSv1.2" | "TLSv1.3";
  agent?: Agent;
}>;

function requestEnvelope(overrides: Partial<BrokerRequestEnvelope> = {}): BrokerRequestEnvelope {
  return {
    schemaVersion: 1,
    installationId: "installation-1",
    requestId: "request-1",
    idempotencyKey: "idempotency-1",
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
    nonce: "nonce-1",
    ...overrides,
  };
}

function responseFor(request: BrokerRequestEnvelope): BrokerResponseEnvelope {
  return {
    schemaVersion: 1,
    installationId: request.installationId,
    requestId: request.requestId,
    operation: request.operation,
    outcome: "failed",
    result: null,
    failureClass: "request_rejected",
    retryable: false,
    retryAfterMs: null,
    receiptId: null,
    health: null,
    bindings: [],
    completedAt: NOW,
  };
}

function waitForListen(server: ReturnType<typeof createBrokerServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

function closeServer(server: ReturnType<typeof createBrokerServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}

function sendHttpsRequest(
  port: number,
  fixture: MtlsFixture,
  options: ClientRequestOptions = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      host: "127.0.0.1",
      port,
      method: options.method ?? "POST",
      path: options.path ?? "/v1/operations",
      servername: options.serverName ?? "broker.test",
      ca: options.caCertificatePem ?? fixture.caCertificatePem,
      cert: options.certificatePem === null ? undefined : options.certificatePem ?? fixture.clientCertificatePem,
      key: options.privateKeyPem === null ? undefined : options.privateKeyPem ?? fixture.clientPrivateKeyPem,
      rejectUnauthorized: true,
      minVersion: options.minVersion,
      maxVersion: options.maxVersion,
      agent: options.agent,
      headers: {
        "content-type": options.contentType ?? "application/json",
        ...(options.contentLength ? { "content-length": options.contentLength } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end(options.body ?? JSON.stringify(requestEnvelope()));
  });
}

function createHarness(responseBodyLimitBytes = 1_048_576): Promise<TestHarness> {
  return (async () => {
    const fixture = createMtlsFixture();
    const database = temporaryBrokerDatabase();
    const adapterCalls = { health: 0, verify: 0 };
    const adapter: VaultAdapter = {
      health: async () => {
        adapterCalls.health += 1;
        return { outcome: "ready" };
      },
      verify: async () => {
        adapterCalls.verify += 1;
        return { outcome: "valid", versionHmac: "d".repeat(64) };
      },
    };
    const store = new BrokerStore(database.db, {
      dataKey: new Uint8Array(32).fill(0x11),
      auditKey: new Uint8Array(32).fill(0x22),
      clock: () => NOW,
    });
    store.addInstallation({
      installationId: "installation-1",
      clientCertificateFingerprint: certificateFingerprint(fixture.clientCertificatePem),
      policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
      topologyReceiptDigest: "b".repeat(64),
      topologyReceiptExpiresAt: NOW + 1_000_000,
      expectedVaultId: "vault-canary",
      now: NOW,
    });
    const service = new BrokerOperationService({
      store,
      adapter,
      dataKey: new Uint8Array(32).fill(0x11),
      auditKey: new Uint8Array(32).fill(0x22),
      clock: () => NOW,
      brokerVersion: "0.1.0",
    });
    const server = createBrokerServer({
      serverCertificatePem: fixture.serverCertificatePem,
      serverPrivateKeyPem: fixture.serverPrivateKeyPem,
      clientCaCertificatePem: fixture.caCertificatePem,
      service,
      clock: () => NOW,
      requestBodyLimitBytes: 16_384,
      responseBodyLimitBytes,
    });
    const port = await waitForListen(server);
    return {
      fixture,
      database,
      server,
      port,
      adapterCalls,
      close: async () => {
        await closeServer(server);
        database.close();
        fixture.cleanup();
      },
    };
  })();
}

describe("credential broker mTLS boundary", () => {
  it("accepts one trusted operation and emits bounded security headers", async () => {
    const harness = await createHarness();
    try {
      const result = await sendHttpsRequest(harness.port, harness.fixture);
      const parsed = parseBrokerResponse(JSON.parse(result.body));
      expect(result.statusCode).toBe(200);
      expect(parsed).toMatchObject({ ok: true, value: { result: "ready" } });
      expect(result.headers["cache-control"]).toBe("no-store");
      expect(result.headers["x-content-type-options"]).toBe("nosniff");
      expect(result.headers.server).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it("refuses a client certificate for an unregistered installation", async () => {
    const harness = await createHarness();
    try {
      const result = await sendHttpsRequest(harness.port, harness.fixture, {
        certificatePem: harness.fixture.wrongInstallationCertificatePem,
        privateKeyPem: harness.fixture.wrongInstallationPrivateKeyPem,
      });
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).failureClass).toBe("broker_auth_failed");
      expect(harness.adapterCalls.health).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it.each([
    ["untrusted client CA", { certificatePem: "untrusted", privateKeyPem: "untrusted" }],
    ["missing client certificate", { certificatePem: null, privateKeyPem: null }],
  ])("ends TLS for %s", async (_label, options) => {
    const harness = await createHarness();
    try {
      const certificatePem = options.certificatePem === "untrusted" ? harness.fixture.untrustedClientCertificatePem : null;
      const privateKeyPem = options.privateKeyPem === "untrusted" ? harness.fixture.untrustedClientPrivateKeyPem : null;
      await expect(sendHttpsRequest(harness.port, harness.fixture, { certificatePem, privateKeyPem })).rejects.toBeTruthy();
      expect(harness.adapterCalls.health).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it.each([
    ["wrong hostname", { serverName: "not-broker.test" }],
    ["untrusted server CA", { caCertificatePem: "untrusted-ca" }],
    ["TLS below 1.3", { minVersion: "TLSv1.2", maxVersion: "TLSv1.2" }],
  ])("refuses %s", async (_label, options) => {
    const harness = await createHarness();
    try {
      const requestOptions = options as ClientRequestOptions;
      const caCertificatePem = requestOptions.caCertificatePem === "untrusted-ca"
        ? harness.fixture.untrustedCaCertificatePem
        : undefined;
      await expect(sendHttpsRequest(harness.port, harness.fixture, { ...requestOptions, caCertificatePem })).rejects.toBeTruthy();
    } finally {
      await harness.close();
    }
  });

  it.each([
    ["non-POST method", { method: "GET" }, 400],
    ["wrong path", { path: "/v1/other" }, 404],
    ["redirect attempt", { path: "/v1/operations?next=https://outside.test" }, 404],
    ["incorrect content type", { contentType: "text/plain" }, 400],
  ])("rejects %s without a provider call", async (_label, options, expectedStatus) => {
    const harness = await createHarness();
    try {
      const result = await sendHttpsRequest(harness.port, harness.fixture, options);
      expect(result.statusCode).toBe(expectedStatus);
      expect(result.body).not.toContain("outside.test");
      expect(harness.adapterCalls.health).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it.each([
    ["declared oversized body", "x".repeat(16_385), String(16_385)],
    ["invalid JSON", "{", undefined],
  ])("rejects %s", async (_label, body, contentLength) => {
    const harness = await createHarness();
    try {
      const result = await sendHttpsRequest(harness.port, harness.fixture, {
        body,
        contentLength,
      });
      expect(result.statusCode).toBeGreaterThanOrEqual(400);
      expect(result.body).toBe(JSON.stringify({ error: "invalid_request" }));
      expect(harness.adapterCalls.health).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("rejects a chunked body after crossing the request limit", async () => {
    const harness = await createHarness();
    try {
      const result = await sendHttpsRequest(harness.port, harness.fixture, {
        body: "x".repeat(16_385),
      }).catch(() => null);
      expect(result === null || result.statusCode >= 400).toBe(true);
      expect(harness.adapterCalls.health).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("rejects an unknown protocol schema before the operation service", async () => {
    const harness = await createHarness();
    try {
      const body = JSON.stringify({ ...requestEnvelope(), schemaVersion: 2 });
      const result = await sendHttpsRequest(harness.port, harness.fixture, { body });
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body)).toEqual({ error: "invalid_request" });
      expect(harness.adapterCalls.health).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("refuses a request whose deadline has passed", async () => {
    const harness = await createHarness();
    try {
      const body = JSON.stringify(requestEnvelope({ deadlineAt: NOW - 1 }));
      const result = await sendHttpsRequest(harness.port, harness.fixture, { body });
      expect(JSON.parse(result.body).failureClass).toBe("request_rejected");
      expect(harness.adapterCalls.health).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("returns a fixed error when the response exceeds its configured bound", async () => {
    const harness = await createHarness(100);
    try {
      const result = await sendHttpsRequest(harness.port, harness.fixture);
      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual({ error: "invalid_request" });
    } finally {
      await harness.close();
    }
  });

  it("closes keep-alive connections without reopening the listener", async () => {
    const harness = await createHarness();
    const agent = new (await import("node:https")).Agent({
      keepAlive: true,
      maxSockets: 1,
      ca: harness.fixture.caCertificatePem,
      cert: harness.fixture.clientCertificatePem,
      key: harness.fixture.clientPrivateKeyPem,
      servername: "broker.test",
    });
    try {
      const result = await sendHttpsRequest(harness.port, harness.fixture, { agent });
      expect(result.statusCode).toBe(200);
      await closeServer(harness.server);
      await expect(sendHttpsRequest(harness.port, harness.fixture, { agent })).rejects.toBeTruthy();
    } finally {
      agent.destroy();
      harness.database.close();
      harness.fixture.cleanup();
    }
  });
});
