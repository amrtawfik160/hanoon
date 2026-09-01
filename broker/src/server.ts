import { createHash } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { TLSSocket } from "node:tls";

import {
  BROKER_MAX_REQUEST_BYTES,
  BROKER_MAX_RESPONSE_BYTES,
  OPAQUE_ID_PATTERN,
} from "../../src/credentials/protocol.js";
import {
  parseCredentialProtocolRequest,
  parseCredentialProtocolResponse,
  type CredentialProtocolRequestEnvelope,
  type CredentialProtocolResponseEnvelope,
  type ProtectedConnectorRequestEnvelope,
  type ProtectedConnectorResponseEnvelope,
} from "../../src/credentials/connector-protocol.js";

export type BrokerRequestService = Readonly<{
  execute(input: {
    certificateFingerprint: string;
    now: number;
    request: CredentialProtocolRequestEnvelope;
  }): Promise<CredentialProtocolResponseEnvelope>;
  attestExecutorFence?(input: {
    certificateFingerprint: string;
    now: number;
    attestation: BrokerFenceAttestation;
  }): boolean;
}>;

export type BrokerFenceAttestation = Readonly<{
  installationId: string;
  taskId: string;
  projectId: string;
  fenceOwner: string;
  fenceGeneration: number;
  expiresAt: number;
}>;

export type ProtectedBrokerRequestService = Readonly<{
  execute(input: {
    certificateFingerprint: string;
    now: number;
    request: ProtectedConnectorRequestEnvelope;
  }): Promise<ProtectedConnectorResponseEnvelope>;
}>;

export type BrokerServerDependencies = Readonly<{
  serverCertificatePem: string;
  serverPrivateKeyPem: string;
  clientCaCertificatePem: string;
  service: BrokerRequestService;
  protectedService?: ProtectedBrokerRequestService;
  clock?: () => number;
  requestBodyLimitBytes?: number;
  responseBodyLimitBytes?: number;
}>;

type BodyReadResult =
  | { outcome: "read"; body: Buffer }
  | { outcome: "oversized" }
  | { outcome: "aborted" };

function assertLimit(value: number | undefined, maximum: number): number {
  const limit = value ?? maximum;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error("invalid_server_limit");
  }
  return limit;
}

function sendHttpError(response: ServerResponse, statusCode: number, errorCode: "invalid_request" | "not_found"): void {
  const body = JSON.stringify({ error: errorCode });
  response.statusCode = statusCode;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.removeHeader("Server");
  response.end(body);
}

function certificateFingerprint(request: IncomingMessage): string | null {
  const socket = request.socket as TLSSocket;
  if (!socket.authorized) return null;
  const certificate = socket.getPeerCertificate(true);
  if (!certificate.raw || certificate.raw.length === 0) return null;
  return createHash("sha256").update(certificate.raw).digest("hex");
}

function declaredLengthIsOversized(request: IncomingMessage, limit: number): boolean {
  const header = request.headers["content-length"];
  if (header === undefined) return false;
  if (Array.isArray(header) || !/^\d+$/.test(header)) return true;
  const length = Number(header);
  return !Number.isSafeInteger(length) || length > limit;
}

function readRequestBody(request: IncomingMessage, limit: number): Promise<BodyReadResult> {
  if (declaredLengthIsOversized(request, limit)) {
    request.resume();
    return Promise.resolve({ outcome: "oversized" });
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let byteCount = 0;
    let settled = false;
    const finish = (result: BodyReadResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    request.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteCount += bytes.length;
      if (byteCount > limit) {
        request.destroy();
        finish({ outcome: "oversized" });
        return;
      }
      chunks.push(bytes);
    });
    request.once("end", () => finish({ outcome: "read", body: Buffer.concat(chunks) }));
    request.once("aborted", () => finish({ outcome: "aborted" }));
    request.once("error", () => finish({ outcome: "aborted" }));
  });
}

function sendBrokerResponse(
  response: ServerResponse,
  brokerResponse: CredentialProtocolResponseEnvelope,
  responseLimit: number,
): void {
  const parsed = parseCredentialProtocolResponse(brokerResponse);
  if (!parsed.ok) {
    sendHttpError(response, 500, "invalid_request");
    return;
  }
  const body = JSON.stringify(parsed.value);
  if (Buffer.byteLength(body, "utf8") > responseLimit) {
    sendHttpError(response, 500, "invalid_request");
    return;
  }
  response.statusCode = 200;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.removeHeader("Server");
  response.end(body);
}

function parseRequestEnvelope(body: Buffer): CredentialProtocolRequestEnvelope | null {
  try {
    const parsedJson: unknown = JSON.parse(body.toString("utf8"));
    const parsedRequest = parseCredentialProtocolRequest(parsedJson);
    return parsedRequest.ok ? parsedRequest.value : null;
  } catch {
    return null;
  }
}

function isFenceAttestation(value: unknown): value is BrokerFenceAttestation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (keys.join(",") !== "expiresAt,fenceGeneration,fenceOwner,installationId,projectId,taskId") return false;
  return typeof input.installationId === "string" && OPAQUE_ID_PATTERN.test(input.installationId) &&
    typeof input.taskId === "string" && OPAQUE_ID_PATTERN.test(input.taskId) &&
    typeof input.projectId === "string" && OPAQUE_ID_PATTERN.test(input.projectId) &&
    typeof input.fenceOwner === "string" && OPAQUE_ID_PATTERN.test(input.fenceOwner) &&
    typeof input.fenceGeneration === "number" && Number.isSafeInteger(input.fenceGeneration) && input.fenceGeneration >= 1 &&
    typeof input.expiresAt === "number" && Number.isSafeInteger(input.expiresAt) && input.expiresAt >= 1;
}

function parseFenceAttestation(body: Buffer): BrokerFenceAttestation | null {
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    return isFenceAttestation(value) ? value : null;
  } catch {
    return null;
  }
}

function sendFenceResult(response: ServerResponse, accepted: boolean): void {
  response.statusCode = accepted ? 204 : 403;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.removeHeader("Server");
  response.end();
}

async function executeFenceAttestation(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: BrokerServerDependencies,
  body: Buffer,
): Promise<void> {
  const fingerprint = certificateFingerprint(request);
  const attestation = parseFenceAttestation(body);
  if (!fingerprint || !attestation || !dependencies.service.attestExecutorFence) {
    sendFenceResult(response, false);
    return;
  }
  const accepted = dependencies.service.attestExecutorFence({
    certificateFingerprint: fingerprint,
    now: dependencies.clock?.() ?? Date.now(),
    attestation,
  });
  sendFenceResult(response, accepted);
}

async function executeBrokerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: BrokerServerDependencies,
  parsedRequest: CredentialProtocolRequestEnvelope,
  responseLimit: number,
): Promise<void> {
  const fingerprint = certificateFingerprint(request);
  if (!fingerprint) {
    sendHttpError(response, 401, "invalid_request");
    return;
  }
  try {
    const now = dependencies.clock?.() ?? Date.now();
    const brokerResponse = parsedRequest.schemaVersion === 2
      ? dependencies.protectedService
        ? await dependencies.protectedService.execute({
            certificateFingerprint: fingerprint,
            now,
            request: parsedRequest,
          })
        : null
      : await dependencies.service.execute({
          certificateFingerprint: fingerprint,
          now,
          request: parsedRequest,
        });
    if (!brokerResponse) {
      sendHttpError(response, 404, "not_found");
      return;
    }
    sendBrokerResponse(response, brokerResponse, responseLimit);
  } catch {
    sendHttpError(response, 500, "invalid_request");
  }
}

async function handleBrokerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: BrokerServerDependencies,
  requestLimit: number,
  responseLimit: number,
): Promise<void> {
  if (request.method !== "POST" ||
      (request.url !== "/v1/operations" && request.url !== "/v1/fences") ||
      request.headers["content-type"] !== "application/json") {
    if (request.method !== "POST") sendHttpError(response, 400, "invalid_request");
    else if (request.url === "/v1/fences" && request.headers["content-type"] !== "application/json") sendHttpError(response, 400, "invalid_request");
    else if (request.url !== "/v1/operations" && request.url !== "/v1/fences") sendHttpError(response, 404, "not_found");
    else sendHttpError(response, 400, "invalid_request");
    return;
  }

  const body = await readRequestBody(request, requestLimit);
  if (body.outcome === "aborted") return;
  if (body.outcome === "oversized") {
    sendHttpError(response, 413, "invalid_request");
    return;
  }
  if (request.url === "/v1/fences") {
    await executeFenceAttestation(request, response, dependencies, body.body);
    return;
  }
  const parsedRequest = parseRequestEnvelope(body.body);
  if (!parsedRequest) {
    sendHttpError(response, 400, "invalid_request");
    return;
  }
  await executeBrokerRequest(request, response, dependencies, parsedRequest, responseLimit);
}

export function createBrokerServer(dependencies: BrokerServerDependencies): Server {
  const requestLimit = assertLimit(dependencies.requestBodyLimitBytes, BROKER_MAX_REQUEST_BYTES);
  const responseLimit = assertLimit(dependencies.responseBodyLimitBytes, BROKER_MAX_RESPONSE_BYTES);
  const server = createServer({
    cert: dependencies.serverCertificatePem,
    key: dependencies.serverPrivateKeyPem,
    ca: dependencies.clientCaCertificatePem,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
  }, (request, response) => {
    void handleBrokerRequest(request, response, dependencies, requestLimit, responseLimit);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("tlsClientError", (_error, socket) => socket.destroy());
  return server;
}
