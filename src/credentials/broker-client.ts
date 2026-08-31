/**
 * The fixed-origin mTLS client for the Hanoon side of the credential broker
 * protocol. It talks to exactly one endpoint with exactly one method and path,
 * never follows a redirect, and maps every transport failure to a secret-free
 * local outcome rather than letting a raw Node error (which can carry a
 * certificate or file path in its message) escape to a caller.
 */
import https from "node:https";
import type { IncomingMessage } from "node:http";
import type { LookupFunction } from "node:net";
import {
  BROKER_MAX_RESPONSE_BYTES,
  type BrokerRequestEnvelope,
  type BrokerResponseEnvelope,
} from "./protocol";
import {
  parseCredentialProtocolRequest,
  parseCredentialProtocolResponse,
  type CredentialProtocolRequestEnvelope,
  type CredentialProtocolResponseEnvelope,
  type ProtectedConnectorRequestEnvelope,
  type ProtectedConnectorResponseEnvelope,
} from "./connector-protocol";
import type { IsolatedCredentialBrokerConfig } from "./config";

const OPERATIONS_PATH = "/v1/operations";

export type CredentialBrokerClientFailureReason =
  | "connection_failed"
  | "tls_failed"
  | "timeout_before_dispatch"
  | "response_too_large"
  | "unexpected_status"
  | "redirect_rejected"
  | "invalid_response"
  | "invalid_request"
  | "aborted";

export type CredentialBrokerCallOutcome =
  | { outcome: "succeeded"; response: BrokerResponseEnvelope }
  | { outcome: "ambiguous" }
  | { outcome: "failed"; reason: CredentialBrokerClientFailureReason };

export type ProtectedConnectorCallOutcome =
  | { outcome: "succeeded"; response: ProtectedConnectorResponseEnvelope }
  | { outcome: "ambiguous" }
  | { outcome: "failed"; reason: CredentialBrokerClientFailureReason };

const TLS_ERROR_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_UNTRUSTED",
  "CERT_HAS_EXPIRED",
  "CERT_CHAIN_TOO_LONG",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
]);

export class CredentialBrokerClient {
  private agent: https.Agent;
  private config: IsolatedCredentialBrokerConfig;
  private readonly clock: () => number;
  private readonly lookup?: LookupFunction;

  public constructor(
    config: IsolatedCredentialBrokerConfig,
    options: Readonly<{ clock?: () => number; lookup?: LookupFunction }> = {},
  ) {
    this.config = config;
    this.clock = options.clock ?? (() => Date.now());
    this.lookup = options.lookup;
    this.agent = buildAgent(config);
  }

  /** Destroys the current keep-alive agent and rebuilds it from fresh settings. */
  public rotate(config: IsolatedCredentialBrokerConfig): void {
    this.agent.destroy();
    this.config = config;
    this.agent = buildAgent(config);
  }

  /** Closes idle keep-alive sockets when the owning composition is disposed. */
  public close(): void {
    this.agent.destroy();
  }

  public call(
    envelope: BrokerRequestEnvelope,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<CredentialBrokerCallOutcome>;
  public call(
    envelope: ProtectedConnectorRequestEnvelope,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ProtectedConnectorCallOutcome>;
  public call(
    envelope: CredentialProtocolRequestEnvelope,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<CredentialBrokerCallOutcome | ProtectedConnectorCallOutcome> {
    const parsedRequest = parseCredentialProtocolRequest(envelope);
    if (!parsedRequest.ok) return Promise.resolve({ outcome: "failed", reason: "invalid_request" });
    const protectedRequest = parsedRequest.value.schemaVersion === 2;
    return new Promise((resolve) => {
      const body = Buffer.from(JSON.stringify(envelope), "utf8");
      const origin = new URL(this.config.endpointOrigin);
      const timeoutMs = Math.max(1, envelope.deadlineAt - this.clock());

      let settled = false;
      let dispatched = false;
      let deadlineTimer: ReturnType<typeof setTimeout>;
      let abortListener: (() => void) | undefined;
      const finish = (outcome: CredentialBrokerCallOutcome | ProtectedConnectorCallOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        if (abortListener && options.signal) options.signal.removeEventListener("abort", abortListener);
        resolve(outcome);
      };

      const request = https.request({
        agent: this.agent,
        lookup: this.lookup,
        servername: origin.hostname,
        method: "POST",
        hostname: origin.hostname,
        port: origin.port ? Number(origin.port) : 443,
        path: OPERATIONS_PATH,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Cache-Control": "no-store",
          "Content-Length": body.byteLength,
        },
      }, (response) => {
        handleResponse(response, finish, protectedRequest);
      });

      // A completed TLS handshake is the real "the broker may have seen this
      // request" boundary — unlike the request's own `finish` event, which
      // fires once Node has buffered the write internally, before the
      // handshake is known to have succeeded. A reused keep-alive socket
      // already cleared that boundary in an earlier call.
      request.on("socket", (socket) => {
        if (request.reusedSocket) {
          dispatched = true;
        } else {
          socket.once("secureConnect", () => {
            dispatched = true;
          });
        }
      });

      deadlineTimer = setTimeout(() => {
        request.destroy();
        finish(dispatched ? { outcome: "ambiguous" } : { outcome: "failed", reason: "timeout_before_dispatch" });
      }, timeoutMs);

      request.on("error", (error: NodeJS.ErrnoException) => {
        if (dispatched) {
          finish({ outcome: "ambiguous" });
          return;
        }
        finish({ outcome: "failed", reason: classifyPreDispatchError(error) });
      });

      if (options.signal) {
        abortListener = () => {
          request.destroy();
          finish(dispatched ? { outcome: "ambiguous" } : { outcome: "failed", reason: "aborted" });
        };
        if (options.signal.aborted) abortListener();
        else options.signal.addEventListener("abort", abortListener, { once: true });
      }

      request.end(body);
    });
  }
}

function buildAgent(config: IsolatedCredentialBrokerConfig): https.Agent {
  return new https.Agent({
    keepAlive: true,
    maxSockets: 2,
    ca: config.caCertificatePem,
    cert: config.clientCertificatePem,
    key: config.clientKeyPem,
    rejectUnauthorized: true,
    minVersion: "TLSv1.3",
  });
}

function classifyPreDispatchError(error: NodeJS.ErrnoException): CredentialBrokerClientFailureReason {
  const code = error.code ?? "";
  if (TLS_ERROR_CODES.has(code) || code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_")) return "tls_failed";
  return "connection_failed";
}

function handleResponse(
  response: IncomingMessage,
  finish: (outcome: CredentialBrokerCallOutcome | ProtectedConnectorCallOutcome) => void,
  protectedRequest: boolean,
): void {
  const status = response.statusCode ?? 0;
  if (status >= 300 && status < 400) {
    response.resume();
    finish({ outcome: "failed", reason: "redirect_rejected" });
    return;
  }
  if (status !== 200) {
    response.resume();
    finish({ outcome: "failed", reason: "unexpected_status" });
    return;
  }
  const contentType = String(response.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    response.resume();
    finish({ outcome: "failed", reason: "invalid_response" });
    return;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let settledLocally = false;
  response.on("data", (chunk: Buffer) => {
    if (settledLocally) return;
    total += chunk.byteLength;
    if (total > BROKER_MAX_RESPONSE_BYTES) {
      settledLocally = true;
      response.destroy();
      finish({ outcome: "failed", reason: "response_too_large" });
      return;
    }
    chunks.push(chunk);
  });
  response.on("end", () => {
    if (settledLocally) return;
    settledLocally = true;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      finish({ outcome: "failed", reason: "invalid_response" });
      return;
    }
    const parsed = parseCredentialProtocolResponse(parsedJson);
    if (!parsed.ok) {
      finish({ outcome: "failed", reason: "invalid_response" });
      return;
    }
    if (protectedRequest !== (parsed.value.schemaVersion === 2)) {
      finish({ outcome: "failed", reason: "invalid_response" });
      return;
    }
    finish({ outcome: "succeeded", response: parsed.value } as CredentialBrokerCallOutcome | ProtectedConnectorCallOutcome);
  });
  response.on("error", () => {
    if (settledLocally) return;
    settledLocally = true;
    finish({ outcome: "ambiguous" });
  });
}
