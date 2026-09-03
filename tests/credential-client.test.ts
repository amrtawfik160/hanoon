import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { afterAll, afterEach, expect, it } from "vitest";
import { CredentialBrokerClient } from "../src/credentials/broker-client";
import { FOUNDATION_BROKER_POLICY_DIGEST, type BrokerRequestEnvelope, type BrokerResponseEnvelope } from "../src/credentials/protocol";
import type { IsolatedCredentialBrokerConfig } from "../src/credentials/config";

type Pki = Readonly<{
  caCert: string;
  serverCert: string;
  serverKey: string;
  serverWrongHostCert: string;
  serverWrongHostKey: string;
  clientCert: string;
  clientKey: string;
  untrustedCaCert: string;
  wrongClientCert: string;
  wrongClientKey: string;
}>;

function generateTestPki(): { pki: Pki; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "credential-client-pki-"));
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  const read = (name: string) => readFileSync(path.join(dir, name), "utf8");

  run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key"]);
  run(["req", "-x509", "-new", "-key", "ca.key", "-days", "2", "-out", "ca.crt", "-subj", "/CN=Credential Client Test CA"]);

  run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "server.key"]);
  run(["req", "-new", "-key", "server.key", "-out", "server.csr", "-subj", "/CN=127.0.0.1"]);
  writeFileSync(path.join(dir, "server.ext"), "subjectAltName=IP:127.0.0.1\n");
  run([
    "x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
    "-out", "server.crt", "-days", "2", "-extfile", "server.ext",
  ]);

  run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "server-wrong-host.key"]);
  run(["req", "-new", "-key", "server-wrong-host.key", "-out", "server-wrong-host.csr", "-subj", "/CN=not-broker.test"]);
  writeFileSync(path.join(dir, "server-wrong-host.ext"), "subjectAltName=DNS:not-broker.test\n");
  run([
    "x509", "-req", "-in", "server-wrong-host.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
    "-out", "server-wrong-host.crt", "-days", "2", "-extfile", "server-wrong-host.ext",
  ]);

  run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "client.key"]);
  run(["req", "-new", "-key", "client.key", "-out", "client.csr", "-subj", "/CN=install_1"]);
  run([
    "x509", "-req", "-in", "client.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
    "-out", "client.crt", "-days", "2",
  ]);

  run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "wrong-ca.key"]);
  run(["req", "-x509", "-new", "-key", "wrong-ca.key", "-days", "2", "-out", "wrong-ca.crt", "-subj", "/CN=Untrusted CA"]);
  run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "wrong-client.key"]);
  run(["req", "-new", "-key", "wrong-client.key", "-out", "wrong-client.csr", "-subj", "/CN=wrong-install"]);
  run([
    "x509", "-req", "-in", "wrong-client.csr", "-CA", "wrong-ca.crt", "-CAkey", "wrong-ca.key", "-CAcreateserial",
    "-out", "wrong-client.crt", "-days", "2",
  ]);

  const pki: Pki = {
    caCert: read("ca.crt"),
    serverCert: read("server.crt"),
    serverKey: read("server.key"),
    serverWrongHostCert: read("server-wrong-host.crt"),
    serverWrongHostKey: read("server-wrong-host.key"),
    clientCert: read("client.crt"),
    clientKey: read("client.key"),
    untrustedCaCert: read("wrong-ca.crt"),
    wrongClientCert: read("wrong-client.crt"),
    wrongClientKey: read("wrong-client.key"),
  };
  return { pki, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const { pki, cleanup: cleanupPki } = generateTestPki();
afterAll(() => cleanupPki());

const openServers: https.Server[] = [];
afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

type ServerHandler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, body: Buffer) => void;

function startServer(options: Readonly<{ cert?: string; key?: string; handler: ServerHandler }>): Promise<{ server: https.Server; port: number }> {
  return new Promise((resolve) => {
    const server = https.createServer({
      cert: options.cert ?? pki.serverCert,
      key: options.key ?? pki.serverKey,
      ca: pki.caCert,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
    }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => options.handler(req, res, Buffer.concat(chunks)));
    });
    openServers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server address missing");
      resolve({ server, port: address.port });
    });
  });
}

function buildConfig(port: number, overrides: Partial<IsolatedCredentialBrokerConfig> = {}): IsolatedCredentialBrokerConfig {
  return {
    mode: "isolated",
    endpointOrigin: `https://127.0.0.1:${port}`,
    installationId: "install_1",
    topologyReceiptDigest: "a".repeat(64),
    topologyReceiptExpiresAt: 9_999_999_999_999,
    clientCertificatePem: pki.clientCert,
    clientKeyPem: pki.clientKey,
    caCertificatePem: pki.caCert,
    ...overrides,
  };
}

function healthEnvelope(overrides: Partial<BrokerRequestEnvelope> = {}): BrokerRequestEnvelope {
  const issuedAt = Date.now();
  return {
    schemaVersion: 1,
    installationId: "install_1",
    requestId: `req_${Math.random().toString(36).slice(2)}`,
    idempotencyKey: `idem_${Math.random().toString(36).slice(2)}`,
    operation: "broker.health",
    bindingId: null,
    bindingGeneration: null,
    turnId: null,
    capabilityId: "system.broker.health",
    policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
    fenceOwner: null,
    fenceGeneration: null,
    issuedAt,
    deadlineAt: issuedAt + 5_000,
    nonce: `nonce_${Math.random().toString(36).slice(2)}`,
    ...overrides,
  } as BrokerRequestEnvelope;
}

function healthResponseBody(envelope: BrokerRequestEnvelope): BrokerResponseEnvelope {
  return {
    schemaVersion: 1,
    installationId: envelope.installationId,
    requestId: envelope.requestId,
    operation: "broker.health",
    outcome: "succeeded",
    result: "ready",
    failureClass: null,
    retryable: false,
    retryAfterMs: null,
    receiptId: `receipt_${envelope.requestId}`,
    health: {
      protocolVersion: 1,
      brokerVersion: "0.1.0",
      adapter: "onepassword",
      adapterState: "ready",
      auditWritable: true,
      bindingCount: 0,
      topologyReceiptDigest: "a".repeat(64),
      topologyReceiptExpiresAt: 9_999_999_999_999,
    },
    bindings: [],
    completedAt: Date.now(),
  } as BrokerResponseEnvelope;
}

const healthHandler: ServerHandler = (_req, res, body) => {
  const envelope = JSON.parse(body.toString("utf8")) as BrokerRequestEnvelope;
  const payload = JSON.stringify(healthResponseBody(envelope));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(payload);
};

function waitForClose(socket: Duplex, timeoutMs = 2_000): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket did not close in time")), timeoutMs);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") throw new Error("probe address missing");
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

// --- correct call -----------------------------------------------------------

it("completes a correct call against a trusted server with a valid client certificate", async () => {
  const { port } = await startServer({ handler: healthHandler });
  const client = new CredentialBrokerClient(buildConfig(port));

  const outcome = await client.call(healthEnvelope());

  expect(outcome.outcome).toBe("succeeded");
  if (outcome.outcome !== "succeeded") throw new Error("expected succeeded");
  expect(outcome.response.outcome).toBe("succeeded");
});

it("attests the current executor fence over the authenticated fence endpoint", async () => {
  const fenceNow = 1_800_000_000_000;
  const { port } = await startServer({
    handler: (request, response, body) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/fences");
      expect(JSON.parse(body.toString("utf8"))).toEqual({
        installationId: "install_1",
        taskId: "turn_1",
        projectId: "project_1",
        fenceOwner: "executor_1",
        fenceGeneration: 1,
        expiresAt: fenceNow + 5_000,
      });
      response.writeHead(204);
      response.end();
    },
  });
  const client = new CredentialBrokerClient(buildConfig(port), { clock: () => fenceNow });

  await expect(client.attestExecutorFence({
    installationId: "install_1",
    taskId: "turn_1",
    projectId: "project_1",
    fenceOwner: "executor_1",
    fenceGeneration: 1,
    expiresAt: fenceNow + 5_000,
  })).resolves.toBe(true);
});

// --- untrusted server ---------------------------------------------------------

it("fails closed against a server certificate signed by an untrusted CA", async () => {
  const { port } = await startServer({ handler: healthHandler, cert: pki.serverCert, key: pki.serverKey });
  const client = new CredentialBrokerClient(buildConfig(port, { caCertificatePem: pki.untrustedCaCert }));

  const outcome = await client.call(healthEnvelope());

  expect(outcome).toEqual({ outcome: "failed", reason: "tls_failed" });
});

// --- wrong hostname -------------------------------------------------------------

it("fails closed when the server certificate does not cover the connected hostname", async () => {
  const { port } = await startServer({
    handler: healthHandler,
    cert: pki.serverWrongHostCert,
    key: pki.serverWrongHostKey,
  });
  const client = new CredentialBrokerClient(buildConfig(port));

  const outcome = await client.call(healthEnvelope());

  expect(outcome).toEqual({ outcome: "failed", reason: "tls_failed" });
});

// --- rejected client --------------------------------------------------------------

it("fails closed when the broker rejects the client certificate, never claiming success", async () => {
  const { port } = await startServer({ handler: healthHandler });
  const client = new CredentialBrokerClient(
    buildConfig(port, { clientCertificatePem: pki.wrongClientCert, clientKeyPem: pki.wrongClientKey }),
  );

  const outcome = await client.call(healthEnvelope());

  // Under TLS 1.3 mutual auth, the client's own handshake view can complete
  // before it learns the server rejected its certificate: Node delivers a
  // generic ECONNRESET with no signal that distinguishes "never authenticated"
  // from "authenticated, then the connection broke". Either safe classification
  // is acceptable here; "succeeded" is the only outcome that would be unsafe.
  expect(outcome.outcome).not.toBe("succeeded");
  expect(["failed", "ambiguous"]).toContain(outcome.outcome);
});

// --- zero redirects ------------------------------------------------------------

it("refuses to follow a redirect response", async () => {
  const { port } = await startServer({
    handler: (_req, res) => {
      res.writeHead(302, { location: "https://example.com/elsewhere" });
      res.end();
    },
  });
  const client = new CredentialBrokerClient(buildConfig(port));

  const outcome = await client.call(healthEnvelope());

  expect(outcome).toEqual({ outcome: "failed", reason: "redirect_rejected" });
});

// --- response body overflow -----------------------------------------------------

it("fails closed on a response body larger than the bounded maximum", async () => {
  const { port } = await startServer({
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const oversized = "a".repeat(1_048_577);
      res.end(oversized);
    },
  });
  const client = new CredentialBrokerClient(buildConfig(port));

  const outcome = await client.call(healthEnvelope());

  expect(outcome).toEqual({ outcome: "failed", reason: "response_too_large" });
});

// --- invalid content type / JSON / schema ---------------------------------------

it("rejects a response with a non-JSON content type", async () => {
  const { port } = await startServer({
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    },
  });
  const client = new CredentialBrokerClient(buildConfig(port));

  const outcome = await client.call(healthEnvelope());

  expect(outcome).toEqual({ outcome: "failed", reason: "invalid_response" });
});

it("rejects a response body that is not valid JSON", async () => {
  const { port } = await startServer({
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not valid json");
    },
  });
  const client = new CredentialBrokerClient(buildConfig(port));

  const outcome = await client.call(healthEnvelope());

  expect(outcome).toEqual({ outcome: "failed", reason: "invalid_response" });
});

it("rejects a response that does not satisfy the protocol schema", async () => {
  const { port } = await startServer({
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ unexpected: "shape" }));
    },
  });
  const client = new CredentialBrokerClient(buildConfig(port));

  const outcome = await client.call(healthEnvelope());

  expect(outcome).toEqual({ outcome: "failed", reason: "invalid_response" });
});

it("rejects a response whose fields form an invalid cross-field combination", async () => {
  const { port } = await startServer({
    handler: (_req, res, body) => {
      const envelope = JSON.parse(body.toString("utf8")) as BrokerRequestEnvelope;
      const bad = { ...healthResponseBody(envelope), result: "valid" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(bad));
    },
  });
  const client = new CredentialBrokerClient(buildConfig(port));

  const outcome = await client.call(healthEnvelope());

  expect(outcome).toEqual({ outcome: "failed", reason: "invalid_response" });
});

// --- timeouts ----------------------------------------------------------------------

it("fails closed with a pre-dispatch timeout when the connection cannot be established in time", async () => {
  const acceptedSockets: net.Socket[] = [];
  const hangingServer = net.createServer((socket) => {
    // Accept the TCP connection but never speak TLS back, so the handshake hangs.
    acceptedSockets.push(socket);
  });
  await new Promise<void>((resolve) => hangingServer.listen(0, "127.0.0.1", () => resolve()));
  const address = hangingServer.address();
  if (!address || typeof address === "string") throw new Error("hanging server address missing");

  const client = new CredentialBrokerClient(buildConfig(address.port));
  const issuedAt = Date.now();

  const outcome = await client.call(healthEnvelope({ issuedAt, deadlineAt: issuedAt + 200 }));

  expect(outcome).toEqual({ outcome: "failed", reason: "timeout_before_dispatch" });
  // The client destroying its side of a never-completed handshake does not
  // guarantee the server's accepted socket closes too, and `server.close()`'s
  // callback waits for every connection to end.
  acceptedSockets.forEach((socket) => socket.destroy());
  await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
});

it("marks a call ambiguous when it times out after the request was fully dispatched", async () => {
  const { port } = await startServer({
    handler: () => {
      // Deliberately never respond, holding the connection open past the deadline.
    },
  });
  const client = new CredentialBrokerClient(buildConfig(port));
  const issuedAt = Date.now();

  const outcome = await client.call(healthEnvelope({ issuedAt, deadlineAt: issuedAt + 200 }));

  expect(outcome).toEqual({ outcome: "ambiguous" });
});

// --- abort ---------------------------------------------------------------------------

it("marks a call ambiguous when the caller aborts it after dispatch", async () => {
  const { port } = await startServer({
    handler: () => {
      // Never respond; the test aborts before any response arrives.
    },
  });
  const client = new CredentialBrokerClient(buildConfig(port));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);

  const outcome = await client.call(healthEnvelope(), { signal: controller.signal });

  expect(outcome).toEqual({ outcome: "ambiguous" });
});

// --- connection refusal ---------------------------------------------------------------

it("fails closed when the broker port refuses the connection", async () => {
  const port = await freePort();
  const client = new CredentialBrokerClient(buildConfig(port));

  const outcome = await client.call(healthEnvelope());

  expect(outcome).toEqual({ outcome: "failed", reason: "connection_failed" });
});

// --- rotation -------------------------------------------------------------------------

it("destroys the old keep-alive agent on rotation instead of reusing a stale connection", async () => {
  const serverA = await startServer({ handler: healthHandler });
  const serverB = await startServer({ handler: healthHandler });
  const sockets: Duplex[] = [];
  serverA.server.on("connection", (socket) => sockets.push(socket));

  const client = new CredentialBrokerClient(buildConfig(serverA.port));
  const first = await client.call(healthEnvelope());
  expect(first.outcome).toBe("succeeded");
  expect(sockets.length).toBeGreaterThan(0);

  client.rotate(buildConfig(serverB.port));
  await waitForClose(sockets[0]!);
  expect(sockets[0]!.destroyed).toBe(true);

  const second = await client.call(healthEnvelope());
  expect(second.outcome).toBe("succeeded");
});
