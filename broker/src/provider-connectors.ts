import https from "node:https";
import type { IncomingMessage } from "node:http";
import type { LookupFunction } from "node:net";
import type {
  ConvexProjectIdentity,
  VercelProjectIdentity,
} from "../../src/credentials/connector-protocol.js";
import type { ConvexProjectTarget, VercelProjectTarget } from "../../src/credentials/connector-policy.js";

export const PROTECTED_PROVIDER_TIMEOUT_MS = 10_000;
export const PROTECTED_PROVIDER_MAX_BODY_BYTES = 64 * 1024;

export type ProtectedConnectorCredentialResolver = Readonly<{
  resolve(reference: string): Promise<
    | Readonly<{ outcome: "resolved"; token: string }>
    | Readonly<{
        outcome: "failed";
        failureClass: "credential_invalid" | "credential_expired" | "provider_rate_limited" | "provider_unavailable";
        retryable: boolean;
        retryAfterMs: number | null;
      }>
  >;
}>;

export type ProtectedConnectorProviderResponse = Readonly<{
  statusCode: number;
  contentType: string;
  body: string;
}>;

export type ProtectedConnectorProviderHttpPort = Readonly<{
  getConvexProject(input: Readonly<{
    path: string;
    authorization: string;
    signal?: AbortSignal;
  }>): Promise<ProtectedConnectorProviderResponse>;
  getVercelProject(input: Readonly<{
    path: string;
    authorization: string;
    signal?: AbortSignal;
  }>): Promise<ProtectedConnectorProviderResponse>;
}>;

export type ProtectedConnectorProviderHttpOptions = Readonly<{
  port?: number;
  timeoutMs?: number;
  caCertificatePem?: string;
  lookup?: LookupFunction;
  servername?: string;
}>;

type ConnectorFailure = Readonly<{
  outcome: "failed";
  failureClass:
    | "credential_invalid"
    | "credential_expired"
    | "scope_insufficient"
    | "destination_denied"
    | "provider_rate_limited"
    | "provider_unavailable"
    | "result_ambiguous";
  retryable: boolean;
  retryAfterMs: number | null;
  connectorVersion: string;
}>;

type ConnectorSuccess<Identity> = Readonly<{
  outcome: "succeeded";
  identity: Identity;
  connectorVersion: string;
}>;

type ProviderResult<Identity> = ConnectorSuccess<Identity> | ConnectorFailure;

type ProviderObject = Readonly<Record<string, unknown>>;

function failure(
  failureClass: ConnectorFailure["failureClass"],
  connectorVersion: string,
  retryable = false,
  retryAfterMs: number | null = null,
): ConnectorFailure {
  return { outcome: "failed", failureClass, retryable, retryAfterMs, connectorVersion };
}

function retryableProviderFailure(connectorVersion: string): ConnectorFailure {
  return failure("provider_unavailable", connectorVersion, true, 30_000);
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value) &&
    !/[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) && !/^[\\/]/u.test(value);
}

function objectValue(value: unknown): ProviderObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as ProviderObject
    : null;
}

function nestedText(object: ProviderObject, key: string, nestedKey: string): string | null {
  const nested = objectValue(object[key]);
  return nested && boundedText(nested[nestedKey]) ? nested[nestedKey] : null;
}

function responseJson(response: ProtectedConnectorProviderResponse): ProviderObject | null {
  if (response.statusCode !== 200 || !response.contentType.toLowerCase().startsWith("application/json")) return null;
  if (Buffer.byteLength(response.body, "utf8") > PROTECTED_PROVIDER_MAX_BODY_BYTES) return null;
  try {
    return objectValue(JSON.parse(response.body));
  } catch {
    return null;
  }
}

function mapHttpFailure(response: ProtectedConnectorProviderResponse, connectorVersion: string): ConnectorFailure {
  if (response.statusCode === 401) return failure("credential_invalid", connectorVersion);
  if (response.statusCode === 403) return failure("scope_insufficient", connectorVersion);
  if (response.statusCode === 404 || (response.statusCode >= 300 && response.statusCode < 400)) {
    return failure("destination_denied", connectorVersion);
  }
  if (response.statusCode === 429) return failure("provider_rate_limited", connectorVersion, true, 60_000);
  return retryableProviderFailure(connectorVersion);
}

function convexStatus(value: unknown): ConvexProjectIdentity["status"] {
  if (value === "active" || value === "ready") return "active";
  if (value === "paused") return "paused";
  return "unknown";
}

function vercelFramework(value: unknown): VercelProjectIdentity["framework"] {
  if (value === "nextjs") return "nextjs";
  if (typeof value === "string") return "other";
  return "unknown";
}

function vercelStatus(value: unknown): VercelProjectIdentity["status"] {
  if (value === "READY" || value === "ready") return "ready";
  if (value === "BUILDING" || value === "building") return "building";
  if (value === "ERROR" || value === "error" || value === "CANCELED") return "error";
  return "unknown";
}

function latestDeploymentState(body: ProviderObject): unknown {
  const deployments = body.latestDeployments;
  if (!Array.isArray(deployments) || deployments.length === 0) return body.status;
  return objectValue(deployments[0])?.readyState;
}

function convexIdentity(body: ProviderObject, version: string, observedAt: number): ConvexProjectIdentity | null {
  const projectId = boundedText(body.id) ? body.id : boundedText(body.projectId) ? body.projectId : null;
  const projectSlug = boundedText(body.slug) ? body.slug : boundedText(body.projectSlug) ? body.projectSlug : null;
  const teamId = boundedText(body.teamId) ? body.teamId : nestedText(body, "team", "id");
  const teamSlug = boundedText(body.teamSlug) ? body.teamSlug : nestedText(body, "team", "slug");
  if (!projectId || !projectSlug || !teamId || !teamSlug) return null;
  return {
    projectId,
    projectSlug,
    teamId,
    teamSlug,
    status: convexStatus(body.status ?? body.deploymentStatus),
    connectorVersion: version,
    observedAt,
  };
}

function vercelIdentity(body: ProviderObject, version: string, observedAt: number): VercelProjectIdentity | null {
  const projectId = boundedText(body.id) ? body.id : boundedText(body.projectId) ? body.projectId : null;
  const projectName = boundedText(body.name) ? body.name : boundedText(body.projectName) ? body.projectName : null;
  const teamId = boundedText(body.accountId) ? body.accountId : null;
  if (!projectId || !projectName || !teamId) return null;
  return {
    projectId,
    projectName,
    teamId,
    framework: vercelFramework(body.framework),
    status: vercelStatus(latestDeploymentState(body)),
    connectorVersion: version,
    observedAt,
  };
}

async function resolveToken(
  credentials: ProtectedConnectorCredentialResolver,
  reference: string,
): Promise<Readonly<{ token: string }> | ConnectorFailure> {
  try {
    const resolved = await credentials.resolve(reference);
    if (resolved.outcome === "failed") return {
      outcome: "failed",
      failureClass: resolved.failureClass,
      retryable: resolved.retryable,
      retryAfterMs: resolved.retryAfterMs,
      connectorVersion: "resolver-1",
    };
    if (resolved.token.length === 0) return failure("credential_invalid", "resolver-1");
    return { token: resolved.token };
  } catch {
    return retryableProviderFailure("resolver-1");
  }
}

async function inspectWithToken<Identity>(input: Readonly<{
  credentials: ProtectedConnectorCredentialResolver;
  reference: string;
  request: (authorization: string) => Promise<ProtectedConnectorProviderResponse>;
  map: (body: ProviderObject) => Identity | null;
  connectorVersion: string;
  signal?: AbortSignal;
  clock: () => number;
}>): Promise<ProviderResult<Identity>> {
  const resolved = await resolveToken(input.credentials, input.reference);
  if ("failureClass" in resolved) return { ...resolved, connectorVersion: input.connectorVersion };
  let token: string | undefined = resolved.token;
  try {
    const response = await input.request(`Bearer ${token}`);
    const body = responseJson(response);
    if (!body) return response.statusCode === 200
      ? failure("result_ambiguous", input.connectorVersion)
      : mapHttpFailure(response, input.connectorVersion);
    const identity = input.map(body);
    return identity ? { outcome: "succeeded", identity, connectorVersion: input.connectorVersion } :
      failure("result_ambiguous", input.connectorVersion);
  } catch {
    return retryableProviderFailure(input.connectorVersion);
  } finally {
    token = undefined;
  }
}

function pathSegment(value: string): string {
  return encodeURIComponent(value);
}

export function createProtectedConnectorExecutor(input: Readonly<{
  http: ProtectedConnectorProviderHttpPort;
  credentials: ProtectedConnectorCredentialResolver;
  connectorVersion?: string;
  clock?: () => number;
}>): {
  inspectConvex(input: Readonly<{ target: ConvexProjectTarget; credentialReference: string; signal?: AbortSignal }>): Promise<ProviderResult<ConvexProjectIdentity>>;
  inspectVercel(input: Readonly<{ target: VercelProjectTarget; credentialReference: string; signal?: AbortSignal }>): Promise<ProviderResult<VercelProjectIdentity>>;
} {
  const connectorVersion = input.connectorVersion ?? "provider-1";
  const clock = input.clock ?? (() => Date.now());
  return {
    inspectConvex: (request) => inspectWithToken({
      credentials: input.credentials,
      reference: request.credentialReference,
      connectorVersion,
      signal: request.signal,
      clock,
      request: (authorization) => input.http.getConvexProject({
        path: `/v1/teams/${pathSegment(request.target.teamIdOrSlug)}/projects/${pathSegment(request.target.projectSlug)}`,
        authorization,
        signal: request.signal,
      }),
      map: (body) => convexIdentity(body, connectorVersion, clock()),
    }),
    inspectVercel: (request) => inspectWithToken({
      credentials: input.credentials,
      reference: request.credentialReference,
      connectorVersion,
      signal: request.signal,
      clock,
      request: (authorization) => input.http.getVercelProject({
        path: `/v9/projects/${pathSegment(request.target.projectIdOrName)}?teamId=${pathSegment(request.target.teamId)}`,
        authorization,
        signal: request.signal,
      }),
      map: (body) => vercelIdentity(body, connectorVersion, clock()),
    }),
  };
}

function readProviderResponse(response: IncomingMessage): Promise<ProtectedConnectorProviderResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > PROTECTED_PROVIDER_MAX_BODY_BYTES) {
        response.destroy();
        reject(new Error("provider_body_limit"));
        return;
      }
      chunks.push(bytes);
    });
    response.once("end", () => resolve({
      statusCode: response.statusCode ?? 0,
      contentType: String(response.headers["content-type"] ?? ""),
      body: Buffer.concat(chunks).toString("utf8"),
    }));
    response.once("error", () => reject(new Error("provider_response_error")));
  });
}

function fixedGet(hostname: "api.convex.dev" | "api.vercel.com", input: Readonly<{
  path: string;
  authorization: string;
  signal?: AbortSignal;
}>, options: ProtectedConnectorProviderHttpOptions): Promise<ProtectedConnectorProviderResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, response?: ProtectedConnectorProviderResponse): void => {
      if (settled) return;
      settled = true;
      if (input.signal) input.signal.removeEventListener("abort", abort);
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(response!);
    };
    const request = https.request({
      hostname,
      port: options.port,
      ca: options.caCertificatePem,
      lookup: options.lookup,
      servername: options.servername ?? hostname,
      method: "GET",
      path: input.path,
      headers: { Accept: "application/json", Authorization: input.authorization, "Cache-Control": "no-store" },
      rejectUnauthorized: true,
      minVersion: "TLSv1.3",
      timeout: options.timeoutMs ?? PROTECTED_PROVIDER_TIMEOUT_MS,
    }, (response) => {
      void readProviderResponse(response).then(
        (value) => finish(null, value),
        (error: unknown) => finish(error instanceof Error ? error : new Error("provider_response_error")),
      );
    });
    const abort = () => request.destroy(new Error("provider_aborted"));
    const timer = setTimeout(
      () => request.destroy(new Error("provider_timeout")),
      options.timeoutMs ?? PROTECTED_PROVIDER_TIMEOUT_MS,
    );
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener("abort", abort, { once: true });
    request.once("timeout", () => request.destroy(new Error("provider_timeout")));
    request.once("error", (error) => finish(error));
    request.end();
  });
}

export function createProtectedConnectorProviderHttpPort(
  options: ProtectedConnectorProviderHttpOptions = {},
): ProtectedConnectorProviderHttpPort {
  return {
    getConvexProject: (input) => fixedGet("api.convex.dev", input, options),
    getVercelProject: (input) => fixedGet("api.vercel.com", input, options),
  };
}
