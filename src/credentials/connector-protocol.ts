/**
 * Schema-version-2 protocol for the first protected identity connectors.
 *
 * Version 1 remains in `protocol.ts`. This module deliberately does not widen
 * that shipped contract: a version-2 request is one of three exact operations,
 * and every successful response is an operation-specific identity proof with
 * a durable receipt. Provider targets and credential references have no wire
 * representation here; the opaque binding selects them inside the broker.
 */
import {
  BROKER_MAX_DEADLINE_MS,
  OPAQUE_ID_PATTERN,
  SHA256_PATTERN,
  canonicalBrokerJson,
  parseBrokerRequest,
  parseBrokerResponse,
  type BrokerRequestEnvelope,
  type BrokerResponseEnvelope,
  type ProtocolParseResult,
} from "./protocol";
import { createHash } from "node:crypto";

export const PROTECTED_CONNECTOR_SCHEMA_VERSION = 2 as const;
export const PROTECTED_CONNECTOR_MAX_REQUEST_BYTES = 8_192;
export const PROTECTED_CONNECTOR_MAX_RESPONSE_BYTES = 32_768;
export const PROTECTED_CONNECTOR_MAX_RETRY_AFTER_MS = 300_000;
export const PROTECTED_CONNECTOR_MIN_RETRY_AFTER_MS = 1_000;

export const PROTECTED_CONNECTOR_OPERATIONS = [
  "convex.project.inspect.v1",
  "vercel.project.inspect.v1",
  "browser.vercel_project.inspect.v1",
] as const;

export const PROTECTED_CONNECTOR_CAPABILITY_IDS = [
  "telegram_agent_convex_project_inspect",
  "telegram_agent_vercel_project_inspect",
  "telegram_agent_browser_vercel_project_inspect",
] as const;

export const PROTECTED_CONNECTOR_FAILURE_CLASSES = [
  "unsafe_topology",
  "broker_unavailable",
  "broker_auth_failed",
  "request_rejected",
  "binding_missing",
  "binding_inactive",
  "binding_generation_stale",
  "scope_insufficient",
  "destination_denied",
  "approval_required",
  "strong_approval_required",
  "human_presence_required",
  "credential_invalid",
  "credential_expired",
  "credential_revoked",
  "provider_rate_limited",
  "provider_unavailable",
  "result_ambiguous",
  "receipt_persistence_failed",
  "reconciliation_required",
] as const;

export const CONVEX_PROJECT_STATUSES = ["active", "paused", "unknown"] as const;
export const VERCEL_PROJECT_FRAMEWORKS = ["nextjs", "other", "unknown"] as const;
export const VERCEL_PROJECT_STATUSES = ["ready", "building", "error", "unknown"] as const;
export const VERCEL_BROWSER_SESSION_STATUSES = ["authenticated"] as const;

export type ProtectedConnectorOperation = (typeof PROTECTED_CONNECTOR_OPERATIONS)[number];
export type ProtectedConnectorCapabilityId = (typeof PROTECTED_CONNECTOR_CAPABILITY_IDS)[number];
export type ProtectedConnectorFailureClass = (typeof PROTECTED_CONNECTOR_FAILURE_CLASSES)[number];

type ProtectedConnectorRequestBase<
  Operation extends ProtectedConnectorOperation,
  CapabilityId extends ProtectedConnectorCapabilityId,
> = Readonly<{
  schemaVersion: 2;
  operation: Operation;
  installationId: string;
  requestId: string;
  idempotencyKey: string;
  nonce: string;
  bindingId: string;
  bindingGeneration: number;
  taskId: string;
  projectId: string;
  capabilityId: CapabilityId;
  policyDigest: string;
  fenceOwner: string;
  fenceGeneration: number;
  issuedAt: number;
  deadlineAt: number;
}>;

export type ConvexProjectInspectRequest = ProtectedConnectorRequestBase<
  "convex.project.inspect.v1",
  "telegram_agent_convex_project_inspect"
>;
export type VercelProjectInspectRequest = ProtectedConnectorRequestBase<
  "vercel.project.inspect.v1",
  "telegram_agent_vercel_project_inspect"
>;
export type BrowserVercelProjectInspectRequest = ProtectedConnectorRequestBase<
  "browser.vercel_project.inspect.v1",
  "telegram_agent_browser_vercel_project_inspect"
>;

export type ProtectedConnectorRequestEnvelope =
  | ConvexProjectInspectRequest
  | VercelProjectInspectRequest
  | BrowserVercelProjectInspectRequest;

export type ConvexProjectIdentity = Readonly<{
  projectId: string;
  projectSlug: string;
  teamId: string;
  teamSlug: string;
  status: (typeof CONVEX_PROJECT_STATUSES)[number];
  connectorVersion: string;
  observedAt: number;
}>;

export type VercelProjectIdentity = Readonly<{
  projectId: string;
  projectName: string;
  teamId: string;
  teamSlug: string;
  framework: (typeof VERCEL_PROJECT_FRAMEWORKS)[number];
  status: (typeof VERCEL_PROJECT_STATUSES)[number];
  connectorVersion: string;
  observedAt: number;
}>;

export type BrowserVercelProjectIdentity = Readonly<{
  profileId: string;
  journeyId: string;
  journeyVersion: number;
  origin: "https://vercel.com";
  teamSlug: string;
  projectName: string;
  sessionStatus: "authenticated";
  observedAt: number;
}>;

export type ProtectedConnectorIdentity =
  | ConvexProjectIdentity
  | VercelProjectIdentity
  | BrowserVercelProjectIdentity;

type ProtectedConnectorSuccess<
  Operation extends ProtectedConnectorOperation,
  Result extends ProtectedConnectorIdentity,
> = Readonly<{
  schemaVersion: 2;
  installationId: string;
  requestId: string;
  operation: Operation;
  outcome: "succeeded";
  result: Result;
  failureClass: null;
  retryable: false;
  retryAfterMs: null;
  receiptId: string;
  completedAt: number;
}>;

export type ProtectedConnectorFailure = Readonly<{
  schemaVersion: 2;
  installationId: string;
  requestId: string;
  operation: ProtectedConnectorOperation;
  outcome: "failed";
  result: null;
  failureClass: ProtectedConnectorFailureClass;
  retryable: boolean;
  retryAfterMs: number | null;
  receiptId: string | null;
  completedAt: number;
}>;

export type ConvexProjectInspectSuccess = ProtectedConnectorSuccess<
  "convex.project.inspect.v1",
  ConvexProjectIdentity
>;
export type VercelProjectInspectSuccess = ProtectedConnectorSuccess<
  "vercel.project.inspect.v1",
  VercelProjectIdentity
>;
export type BrowserVercelProjectInspectSuccess = ProtectedConnectorSuccess<
  "browser.vercel_project.inspect.v1",
  BrowserVercelProjectIdentity
>;

export type ProtectedConnectorResponseEnvelope =
  | ConvexProjectInspectSuccess
  | VercelProjectInspectSuccess
  | BrowserVercelProjectInspectSuccess
  | ProtectedConnectorFailure;

export type CredentialProtocolRequestEnvelope = BrokerRequestEnvelope | ProtectedConnectorRequestEnvelope;
export type CredentialProtocolResponseEnvelope = BrokerResponseEnvelope | ProtectedConnectorResponseEnvelope;

const REQUEST_KEYS = [
  "schemaVersion",
  "operation",
  "installationId",
  "requestId",
  "idempotencyKey",
  "nonce",
  "bindingId",
  "bindingGeneration",
  "taskId",
  "projectId",
  "capabilityId",
  "policyDigest",
  "fenceOwner",
  "fenceGeneration",
  "issuedAt",
  "deadlineAt",
] as const;

const RESPONSE_KEYS = [
  "schemaVersion",
  "installationId",
  "requestId",
  "operation",
  "outcome",
  "result",
  "failureClass",
  "retryable",
  "retryAfterMs",
  "receiptId",
  "completedAt",
] as const;

const CONVEX_RESULT_KEYS = [
  "projectId",
  "projectSlug",
  "teamId",
  "teamSlug",
  "status",
  "connectorVersion",
  "observedAt",
] as const;

const VERCEL_RESULT_KEYS = [
  "projectId",
  "projectName",
  "teamId",
  "teamSlug",
  "framework",
  "status",
  "connectorVersion",
  "observedAt",
] as const;

const BROWSER_RESULT_KEYS = [
  "profileId",
  "journeyId",
  "journeyVersion",
  "origin",
  "teamSlug",
  "projectName",
  "sessionStatus",
  "observedAt",
] as const;

const OPERATION_CAPABILITY = Object.freeze({
  "convex.project.inspect.v1": "telegram_agent_convex_project_inspect",
  "vercel.project.inspect.v1": "telegram_agent_vercel_project_inspect",
  "browser.vercel_project.inspect.v1": "telegram_agent_browser_vercel_project_inspect",
} satisfies Record<ProtectedConnectorOperation, ProtectedConnectorCapabilityId>);

const RETRYABLE_FAILURES = new Set<ProtectedConnectorFailureClass>([
  "broker_unavailable",
  "provider_rate_limited",
  "provider_unavailable",
]);

const BOUNDED_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SCHEME_BEARING_IDENTITY_PATTERN = /[A-Za-z][A-Za-z0-9+.-]*:/u;
const URL_PATH_IDENTITY_PATTERN = /^[\\/]/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;

type ParseCode = Exclude<ProtocolParseResult<never>, { ok: true }>["code"];

function invalid<T>(code: ParseCode): ProtocolParseResult<T> {
  return { ok: false, code };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function isSafeOpaqueIdentity(value: unknown): value is string {
  return isOpaqueId(value) && !SCHEME_BEARING_IDENTITY_PATTERN.test(value) &&
    !URL_PATH_IDENTITY_PATTERN.test(value);
}

function isBoundedIdentity(value: unknown): value is string {
  return typeof value === "string" && BOUNDED_IDENTITY_PATTERN.test(value) &&
    !SCHEME_BEARING_IDENTITY_PATTERN.test(value) && !URL_PATH_IDENTITY_PATTERN.test(value);
}

function isEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isOperation(value: unknown): value is ProtectedConnectorOperation {
  return PROTECTED_CONNECTOR_OPERATIONS.includes(value as ProtectedConnectorOperation);
}

function isFailureClass(value: unknown): value is ProtectedConnectorFailureClass {
  return PROTECTED_CONNECTOR_FAILURE_CLASSES.includes(value as ProtectedConnectorFailureClass);
}

function serializedByteLength(value: unknown): number | null {
  try {
    return Buffer.byteLength(canonicalBrokerJson(value), "utf8");
  } catch {
    return null;
  }
}

export function protectedConnectorRequestDigest(request: ProtectedConnectorRequestEnvelope): string {
  return createHash("sha256").update(canonicalBrokerJson(request), "utf8").digest("hex");
}

export function protectedConnectorResponseDigest(response: ProtectedConnectorResponseEnvelope): string {
  return createHash("sha256").update(canonicalBrokerJson(response), "utf8").digest("hex");
}

export function parseProtectedConnectorRequest(
  body: unknown,
  byteLength = serializedByteLength(body),
): ProtocolParseResult<ProtectedConnectorRequestEnvelope> {
  if (byteLength === null) return invalid("invalid_json_value");
  if (byteLength > PROTECTED_CONNECTOR_MAX_REQUEST_BYTES) return invalid("limit_exceeded");
  if (!isPlainObject(body)) return invalid("invalid_json_value");
  if (!hasExactKeys(body, REQUEST_KEYS)) return invalid("unknown_field");
  if (body.schemaVersion !== PROTECTED_CONNECTOR_SCHEMA_VERSION) return invalid("invalid_field");
  if (!isOperation(body.operation)) return invalid("invalid_field");
  if (
    !isOpaqueId(body.installationId) ||
    !isOpaqueId(body.requestId) ||
    !isOpaqueId(body.idempotencyKey) ||
    !isOpaqueId(body.nonce) ||
    !isOpaqueId(body.bindingId) ||
    !isOpaqueId(body.taskId) ||
    !isOpaqueId(body.projectId) ||
    !isOpaqueId(body.fenceOwner)
  ) return invalid("invalid_field");
  if (!isGeneration(body.bindingGeneration) || !isGeneration(body.fenceGeneration)) {
    return invalid("invalid_field");
  }
  if (body.capabilityId !== OPERATION_CAPABILITY[body.operation]) return invalid("invalid_combination");
  if (typeof body.policyDigest !== "string" || !SHA256_PATTERN.test(body.policyDigest)) {
    return invalid("invalid_field");
  }
  if (!isEpochMs(body.issuedAt) || !isEpochMs(body.deadlineAt)) return invalid("invalid_field");
  if (body.deadlineAt <= body.issuedAt || body.deadlineAt - body.issuedAt > BROKER_MAX_DEADLINE_MS) {
    return invalid("invalid_combination");
  }
  return { ok: true, value: Object.freeze({ ...body }) as ProtectedConnectorRequestEnvelope };
}

export function parseProtectedConnectorRequestJson(
  bytes: string | Uint8Array,
): ProtocolParseResult<ProtectedConnectorRequestEnvelope> {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  if (buffer.byteLength > PROTECTED_CONNECTOR_MAX_REQUEST_BYTES) return invalid("limit_exceeded");
  try {
    return parseProtectedConnectorRequest(JSON.parse(buffer.toString("utf8")), buffer.byteLength);
  } catch {
    return invalid("invalid_json_value");
  }
}

export function parseProtectedConnectorResponse(
  body: unknown,
  byteLength = serializedByteLength(body),
): ProtocolParseResult<ProtectedConnectorResponseEnvelope> {
  if (byteLength === null) return invalid("invalid_json_value");
  if (byteLength > PROTECTED_CONNECTOR_MAX_RESPONSE_BYTES) return invalid("limit_exceeded");
  if (!isPlainObject(body)) return invalid("invalid_json_value");
  if (!hasExactKeys(body, RESPONSE_KEYS)) return invalid("unknown_field");
  if (body.schemaVersion !== PROTECTED_CONNECTOR_SCHEMA_VERSION) return invalid("invalid_field");
  if (!isOpaqueId(body.installationId) || !isOpaqueId(body.requestId) || !isOperation(body.operation)) {
    return invalid("invalid_field");
  }
  if (!isEpochMs(body.completedAt)) return invalid("invalid_field");

  if (body.outcome === "succeeded") {
    if (
      body.failureClass !== null ||
      body.retryable !== false ||
      body.retryAfterMs !== null ||
      !isOpaqueId(body.receiptId)
    ) return invalid("invalid_combination");
    const identityParse = parseIdentity(body.operation, body.result);
    if (!identityParse.ok) return identityParse;
    if (identityParse.value.observedAt > body.completedAt) return invalid("invalid_combination");
    return {
      ok: true,
      value: Object.freeze({ ...body, result: identityParse.value }) as ProtectedConnectorResponseEnvelope,
    };
  }

  if (body.outcome !== "failed") return invalid("invalid_field");
  if (body.result !== null || !isFailureClass(body.failureClass) || typeof body.retryable !== "boolean") {
    return invalid("invalid_combination");
  }
  if (body.receiptId !== null && !isOpaqueId(body.receiptId)) return invalid("invalid_field");
  const expectedRetryable = RETRYABLE_FAILURES.has(body.failureClass);
  if (body.retryable !== expectedRetryable) return invalid("invalid_combination");
  if (expectedRetryable) {
    if (
      !Number.isSafeInteger(body.retryAfterMs) ||
      (body.retryAfterMs as number) < PROTECTED_CONNECTOR_MIN_RETRY_AFTER_MS ||
      (body.retryAfterMs as number) > PROTECTED_CONNECTOR_MAX_RETRY_AFTER_MS
    ) return invalid("invalid_field");
  } else if (body.retryAfterMs !== null) {
    return invalid("invalid_combination");
  }
  if (body.failureClass === "receipt_persistence_failed" && body.receiptId !== null) {
    return invalid("invalid_combination");
  }
  return { ok: true, value: Object.freeze({ ...body }) as ProtectedConnectorFailure };
}

export function parseProtectedConnectorResponseJson(
  bytes: string | Uint8Array,
): ProtocolParseResult<ProtectedConnectorResponseEnvelope> {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  if (buffer.byteLength > PROTECTED_CONNECTOR_MAX_RESPONSE_BYTES) return invalid("limit_exceeded");
  try {
    return parseProtectedConnectorResponse(JSON.parse(buffer.toString("utf8")), buffer.byteLength);
  } catch {
    return invalid("invalid_json_value");
  }
}

function parseIdentity(
  operation: ProtectedConnectorOperation,
  value: unknown,
): ProtocolParseResult<ProtectedConnectorIdentity> {
  if (!isPlainObject(value)) return invalid("invalid_json_value");
  if (operation === "convex.project.inspect.v1") {
    if (!hasExactKeys(value, CONVEX_RESULT_KEYS)) return invalid("unknown_field");
    if (
      !isBoundedIdentity(value.projectId) ||
      !isBoundedIdentity(value.projectSlug) ||
      !isBoundedIdentity(value.teamId) ||
      !isBoundedIdentity(value.teamSlug) ||
      !CONVEX_PROJECT_STATUSES.includes(value.status as ConvexProjectIdentity["status"]) ||
      typeof value.connectorVersion !== "string" ||
      !VERSION_PATTERN.test(value.connectorVersion) ||
      !isEpochMs(value.observedAt)
    ) return invalid("invalid_field");
    return { ok: true, value: Object.freeze({ ...value }) as ConvexProjectIdentity };
  }
  if (operation === "vercel.project.inspect.v1") {
    if (!hasExactKeys(value, VERCEL_RESULT_KEYS)) return invalid("unknown_field");
    if (
      !isBoundedIdentity(value.projectId) ||
      !isBoundedIdentity(value.projectName) ||
      !isBoundedIdentity(value.teamId) ||
      !isBoundedIdentity(value.teamSlug) ||
      !VERCEL_PROJECT_FRAMEWORKS.includes(value.framework as VercelProjectIdentity["framework"]) ||
      !VERCEL_PROJECT_STATUSES.includes(value.status as VercelProjectIdentity["status"]) ||
      typeof value.connectorVersion !== "string" ||
      !VERSION_PATTERN.test(value.connectorVersion) ||
      !isEpochMs(value.observedAt)
    ) return invalid("invalid_field");
    return { ok: true, value: Object.freeze({ ...value }) as VercelProjectIdentity };
  }
  if (!hasExactKeys(value, BROWSER_RESULT_KEYS)) return invalid("unknown_field");
  if (
    !isSafeOpaqueIdentity(value.profileId) ||
    !isSafeOpaqueIdentity(value.journeyId) ||
    !isGeneration(value.journeyVersion) ||
    value.origin !== "https://vercel.com" ||
    !isBoundedIdentity(value.teamSlug) ||
    !isBoundedIdentity(value.projectName) ||
    value.sessionStatus !== "authenticated" ||
    !isEpochMs(value.observedAt)
  ) return invalid("invalid_field");
  return { ok: true, value: Object.freeze({ ...value }) as BrowserVercelProjectIdentity };
}

/** Parses both shipped protocol generations without widening version 1. */
export function parseCredentialProtocolRequest(body: unknown): ProtocolParseResult<CredentialProtocolRequestEnvelope> {
  if (!isPlainObject(body)) return invalid("invalid_json_value");
  if (body.schemaVersion === 1) return parseBrokerRequest(body);
  if (body.schemaVersion === 2) return parseProtectedConnectorRequest(body);
  return invalid("invalid_field");
}

/** Parses both shipped response generations without coercing either shape. */
export function parseCredentialProtocolResponse(body: unknown): ProtocolParseResult<CredentialProtocolResponseEnvelope> {
  if (!isPlainObject(body)) return invalid("invalid_json_value");
  if (body.schemaVersion === 1) return parseBrokerResponse(body);
  if (body.schemaVersion === 2) return parseProtectedConnectorResponse(body);
  return invalid("invalid_field");
}

export function protectedConnectorCapabilityFor(
  operation: ProtectedConnectorOperation,
): ProtectedConnectorCapabilityId {
  return OPERATION_CAPABILITY[operation];
}
