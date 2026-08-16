/**
 * The fixed-origin mTLS client for the Hanoon side of the credential broker
 * protocol. It talks to exactly one endpoint with exactly one method and path,
 * never follows a redirect, and maps every transport failure to a secret-free
 * local outcome rather than letting a raw Node error (which can carry a
 * certificate or file path in its message) escape to a caller.
 */
import https from "node:https";
import type { IncomingMessage } from "node:http";
import {
  BROKER_MAX_RESPONSE_BYTES,
  parseBrokerResponse,
  type BrokerRequestEnvelope,
  type BrokerResponseEnvelope,
} from "./protocol";
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
  | "aborted";

export type CredentialBrokerCallOutcome =
  | { outcome: "succeeded"; response: BrokerResponseEnvelope }
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

  public constructor(
    config: IsolatedCredentialBrokerConfig,
    options: Readonly<{ clock?: () => number }> = {},
  ) {
    this.config = config;
    this.clock = options.clock ?? (() => Date.now());
    this.agent = buildAgent(config);
  }

  /** Destroys the current keep-alive agent and rebuilds it from fresh settings. */
  public rotate(config: IsolatedCredentialBrokerConfig): void {
    this.agent.destroy();
    this.config = config;
    this.agent = buildAgent(config);
  }

  public call(
    envelope: BrokerRequestEnvelope,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): Promise<CredentialBrokerCallOutcome> {
    return new Promise((resolve) => {
      const body = Buffer.from(JSON.stringify(envelope), "utf8");
      const origin = new URL(this.config.endpointOrigin);
      const timeoutMs = Math.max(1, envelope.deadlineAt - this.clock());

      let settled = false;
      let dispatched = false;
      let deadlineTimer: ReturnType<typeof setTimeout>;
      const finish = (outcome: CredentialBrokerCallOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        resolve(outcome);
      };

      const request = https.request({
        agent: this.agent,
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
        handleResponse(response, finish);
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
        const onAbort = () => {
          request.destroy();
          finish(dispatched ? { outcome: "ambiguous" } : { outcome: "failed", reason: "aborted" });
        };
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
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
  finish: (outcome: CredentialBrokerCallOutcome) => void,
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
    const parsed = parseBrokerResponse(parsedJson);
    if (!parsed.ok) {
      finish({ outcome: "failed", reason: "invalid_response" });
      return;
    }
    finish({ outcome: "succeeded", response: parsed.value });
  });
  response.on("error", () => {
    if (settledLocally) return;
    settledLocally = true;
    finish({ outcome: "ambiguous" });
  });
}
