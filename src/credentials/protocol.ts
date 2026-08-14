/**
 * The one wire contract shared by the Hanoon plugin and the protected broker.
 *
 * It is deliberately dependency-free and free of any type that could carry a
 * secret: the broker resolves a credential in memory and returns a verdict, so
 * nothing here has a field for a resolved value, its length, or its prefix.
 * Both sides build against the same module, which is what stops the plugin and
 * the broker from drifting into two dialects of the same protocol.
 */
import { createHash } from "node:crypto";

export const BROKER_SCHEMA_VERSION = 1 as const;
export const BROKER_MAX_REQUEST_BYTES = 16_384;
export const BROKER_MAX_RESPONSE_BYTES = 1_048_576;
export const BROKER_MAX_DEADLINE_MS = 30_000;
export const BROKER_MAX_CLOCK_SKEW_MS = 60_000;
export const BROKER_MAX_BINDINGS = 100;
export const BROKER_MAX_SECRET_BYTES = 65_536;
export const BROKER_MAX_RETRY_AFTER_MS = 300_000;
export const BROKER_MIN_RETRY_AFTER_MS = 1_000;
export const BROKER_MAX_TOPOLOGY_RECEIPT_AGE_MS = 2_592_000_000;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const BROKER_OPERATIONS = ["broker.health", "vault.binding.verify"] as const;
export const BROKER_CAPABILITY_IDS = [
  "system.broker.health",
  "telegram_agent_access_status",
  "telegram_agent_access_verify",
] as const;

export const BROKER_FAILURE_CLASSES = [
  "broker_auth_failed",
  "vault_auth_failed",
  "request_rejected",
  "binding_missing",
  "binding_inactive",
  "binding_generation_stale",
  "credential_invalid",
  "provider_rate_limited",
  "provider_unavailable",
  "receipt_persistence_failed",
  "result_ambiguous",
] as const;

/** The only classes a caller may retry; everything else is settled. */
const RETRYABLE_FAILURE_CLASSES = new Set(["provider_rate_limited", "provider_unavailable"]);

export const BROKER_BINDING_STATES = ["pending", "vault_verified", "active", "revoked"] as const;
export const BROKER_ADAPTER_STATES = ["ready", "degraded", "unavailable"] as const;
export const BROKER_BINDING_RISKS = ["low", "medium", "high", "critical"] as const;
export const BROKER_MFA_MODES = ["none", "totp", "webauthn", "push"] as const;
export const BROKER_APPROVAL_MODES = ["none", "owner_confirmation"] as const;

const MAX_LABEL_CHARS = 120;
const MAX_CAPABILITY_IDS = 8;

export type BrokerOperation = (typeof BROKER_OPERATIONS)[number];
export type BrokerCapabilityId = (typeof BROKER_CAPABILITY_IDS)[number];
export type BrokerFailureClass = (typeof BROKER_FAILURE_CLASSES)[number];
export type BrokerBindingState = (typeof BROKER_BINDING_STATES)[number];
export type BrokerAdapterState = (typeof BROKER_ADAPTER_STATES)[number];

/**
 * The secret-free projection of one enrolled binding. The design enumerates
 * these fields in prose; they are declared here so the broker, the wire, and
 * Hanoon's projection cannot disagree about the shape.
 */
export type CredentialBindingMetadata = Readonly<{
  bindingId: string;
  label: string;
  provider: "onepassword";
  state: BrokerBindingState;
  generation: number;
  capabilityIds: readonly string[];
  risk: (typeof BROKER_BINDING_RISKS)[number];
  mfaMode: (typeof BROKER_MFA_MODES)[number];
  approvalMode: (typeof BROKER_APPROVAL_MODES)[number];
  lastVerifiedAt: number | null;
}>;

export type BrokerRequestEnvelope = Readonly<{
  schemaVersion: 1;
  installationId: string;
  requestId: string;
  idempotencyKey: string;
  operation: BrokerOperation;
  bindingId: string | null;
  bindingGeneration: number | null;
  turnId: string | null;
  capabilityId: BrokerCapabilityId;
  policyDigest: string;
  fenceOwner: string | null;
  fenceGeneration: number | null;
  issuedAt: number;
  deadlineAt: number;
  nonce: string;
}>;

export type BrokerHealthSnapshot = Readonly<{
  protocolVersion: 1;
  brokerVersion: string;
  adapter: "onepassword";
  adapterState: BrokerAdapterState;
  auditWritable: boolean;
  bindingCount: number;
  topologyReceiptDigest: string;
  topologyReceiptExpiresAt: number;
}>;

export type BrokerResponseEnvelope = Readonly<{
  schemaVersion: 1;
  installationId: string;
  requestId: string;
  operation: BrokerOperation;
  outcome: "succeeded" | "failed";
  result: "ready" | "valid" | "invalid" | null;
  failureClass: BrokerFailureClass | null;
  retryable: boolean;
  retryAfterMs: number | null;
  receiptId: string | null;
  health: BrokerHealthSnapshot | null;
  bindings: readonly CredentialBindingMetadata[];
  completedAt: number;
}>;

export type ProtocolParseResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: "invalid_json_value" | "unknown_field" | "invalid_field" | "invalid_combination" | "limit_exceeded";
    };

export const FOUNDATION_BROKER_POLICY = Object.freeze({
  schemaVersion: 1,
  operations: ["broker.health", "vault.binding.verify"],
  capabilities: [
    "system.broker.health",
    "telegram_agent_access_status",
    "telegram_agent_access_verify",
  ],
  maxBindings: 100,
  maxDeadlineMs: 30_000,
  maxClockSkewMs: 60_000,
  maxTopologyReceiptAgeMs: 2_592_000_000,
});

/**
 * Deterministic JSON: object keys sorted recursively, array order preserved.
 * It throws rather than emitting a lossy encoding, because a digest computed
 * over silently-dropped input would agree with a body nobody sent.
 */
export function canonicalBrokerJson(value: unknown): string {
  return encodeCanonical(value);
}

function encodeCanonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON requires finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encodeCanonical).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${encodeCanonical(value[key])}`).join(",")}}`;
  }
  throw new TypeError("canonical JSON accepts only JSON values");
}

export const FOUNDATION_BROKER_POLICY_DIGEST = sha256Hex(canonicalBrokerJson(FOUNDATION_BROKER_POLICY));

/** Binds a stored envelope to its retry: the same identity must hash the same. */
export function brokerRequestDigest(envelope: BrokerRequestEnvelope): string {
  return sha256Hex(canonicalBrokerJson(envelope));
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid<T>(code: Exclude<ProtocolParseResult<T>, { ok: true }>["code"]): ProtocolParseResult<T> {
  return { ok: false, code };
}

/** True when the body's keys are exactly the expected set — no more, no fewer. */
function hasExactKeys(body: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(body);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function isNullableOpaqueId(value: unknown): value is string | null {
  return value === null || isOpaqueId(value);
}

function isEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableCount(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

const REQUEST_KEYS = [
  "schemaVersion", "installationId", "requestId", "idempotencyKey", "operation",
  "bindingId", "bindingGeneration", "turnId", "capabilityId", "policyDigest",
  "fenceOwner", "fenceGeneration", "issuedAt", "deadlineAt", "nonce",
] as const;

export function parseBrokerRequest(body: unknown): ProtocolParseResult<BrokerRequestEnvelope> {
  if (!isPlainObject(body)) return invalid("invalid_json_value");
  if (!hasExactKeys(body, REQUEST_KEYS)) return invalid("unknown_field");

  if (body.schemaVersion !== BROKER_SCHEMA_VERSION) return invalid("invalid_field");
  if (!isOpaqueId(body.installationId) || !isOpaqueId(body.requestId)) return invalid("invalid_field");
  if (!isOpaqueId(body.idempotencyKey) || !isOpaqueId(body.nonce)) return invalid("invalid_field");
  if (!isBrokerOperation(body.operation)) return invalid("invalid_field");
  if (!isBrokerCapabilityId(body.capabilityId)) return invalid("invalid_field");
  if (typeof body.policyDigest !== "string" || !SHA256_PATTERN.test(body.policyDigest)) {
    return invalid("invalid_field");
  }
  if (!isNullableOpaqueId(body.bindingId) || !isNullableOpaqueId(body.turnId)) return invalid("invalid_field");
  if (!isNullableOpaqueId(body.fenceOwner)) return invalid("invalid_field");
  if (!isNullableCount(body.bindingGeneration) || !isNullableCount(body.fenceGeneration)) {
    return invalid("invalid_field");
  }
  if (!isEpochMs(body.issuedAt) || !isEpochMs(body.deadlineAt)) return invalid("invalid_field");

  if (body.deadlineAt <= body.issuedAt) return invalid("invalid_combination");
  if (body.deadlineAt - body.issuedAt > BROKER_MAX_DEADLINE_MS) return invalid("invalid_combination");

  // `broker.health` is diagnostic and cannot name a binding, turn, or fence;
  // `vault.binding.verify` resolves one exact item and requires all of them, so
  // a half-populated envelope is refused rather than interpreted.
  const bound = [body.bindingId, body.bindingGeneration, body.turnId, body.fenceOwner, body.fenceGeneration];
  if (body.operation === "broker.health") {
    if (bound.some((field) => field !== null)) return invalid("invalid_combination");
    if (body.capabilityId !== "system.broker.health") return invalid("invalid_combination");
  } else {
    if (bound.some((field) => field === null)) return invalid("invalid_combination");
    if (body.capabilityId === "system.broker.health") return invalid("invalid_combination");
  }

  return { ok: true, value: Object.freeze({ ...body }) as unknown as BrokerRequestEnvelope };
}

const RESPONSE_KEYS = [
  "schemaVersion", "installationId", "requestId", "operation", "outcome", "result",
  "failureClass", "retryable", "retryAfterMs", "receiptId", "health", "bindings", "completedAt",
] as const;

const HEALTH_KEYS = [
  "protocolVersion", "brokerVersion", "adapter", "adapterState",
  "auditWritable", "bindingCount", "topologyReceiptDigest", "topologyReceiptExpiresAt",
] as const;

const BINDING_KEYS = [
  "bindingId", "label", "provider", "state", "generation",
  "capabilityIds", "risk", "mfaMode", "approvalMode", "lastVerifiedAt",
] as const;

export function parseBrokerResponse(body: unknown): ProtocolParseResult<BrokerResponseEnvelope> {
  if (!isPlainObject(body)) return invalid("invalid_json_value");
  if (!hasExactKeys(body, RESPONSE_KEYS)) return invalid("unknown_field");

  if (body.schemaVersion !== BROKER_SCHEMA_VERSION) return invalid("invalid_field");
  if (!isOpaqueId(body.installationId) || !isOpaqueId(body.requestId)) return invalid("invalid_field");
  if (!isBrokerOperation(body.operation)) return invalid("invalid_field");
  if (body.outcome !== "succeeded" && body.outcome !== "failed") return invalid("invalid_field");
  if (body.result !== null && body.result !== "ready" && body.result !== "valid" && body.result !== "invalid") {
    return invalid("invalid_field");
  }
  if (body.failureClass !== null && !isBrokerFailureClass(body.failureClass)) return invalid("invalid_field");
  if (typeof body.retryable !== "boolean") return invalid("invalid_field");
  if (!isNullableOpaqueId(body.receiptId)) return invalid("invalid_field");
  if (!isEpochMs(body.completedAt)) return invalid("invalid_field");
  if (body.retryAfterMs !== null) {
    if (!Number.isSafeInteger(body.retryAfterMs)) return invalid("invalid_field");
    const delay = body.retryAfterMs as number;
    if (delay < BROKER_MIN_RETRY_AFTER_MS || delay > BROKER_MAX_RETRY_AFTER_MS) return invalid("invalid_field");
  }

  const bindings = parseBindings(body.bindings);
  if (!bindings.ok) return bindings;
  const health = parseHealth(body.health);
  if (!health.ok) return health;

  const combination = checkResponseCombination(body, health.value, bindings.value);
  if (combination !== null) return invalid(combination);

  return {
    ok: true,
    value: Object.freeze({
      ...body,
      health: health.value,
      bindings: Object.freeze(bindings.value),
    }) as unknown as BrokerResponseEnvelope,
  };
}

/**
 * The cross-field matrix. Each rule states which combinations the broker may
 * emit; anything else is an ambiguous response and is refused rather than
 * guessed at, because a caller cannot tell a missing receipt from a lost one.
 */
function checkResponseCombination(
  body: Record<string, unknown>,
  health: BrokerHealthSnapshot | null,
  bindings: readonly CredentialBindingMetadata[],
): "invalid_combination" | null {
  const succeeded = body.outcome === "succeeded";
  const isHealth = body.operation === "broker.health";
  const failureClass = body.failureClass as BrokerFailureClass | null;

  if (succeeded !== (failureClass === null)) return "invalid_combination";
  if (succeeded && body.result === null) return "invalid_combination";
  if (succeeded && body.receiptId === null) return "invalid_combination";

  if (body.result === "ready" && !isHealth) return "invalid_combination";
  if ((body.result === "valid" || body.result === "invalid") && isHealth) return "invalid_combination";
  if (succeeded && isHealth && body.result !== "ready") return "invalid_combination";
  if (succeeded && !isHealth && body.result !== "valid") return "invalid_combination";

  // `credential_invalid` is the one failure that still carries a verdict: the
  // broker reached the vault and proved the item unusable.
  if (failureClass === "credential_invalid" && body.result !== "invalid") return "invalid_combination";
  if (failureClass !== null && failureClass !== "credential_invalid" && body.result !== null) {
    return "invalid_combination";
  }

  const retryable = body.retryable === true;
  if (retryable !== RETRYABLE_FAILURE_CLASSES.has(String(failureClass))) return "invalid_combination";
  if (retryable !== (body.retryAfterMs !== null)) return "invalid_combination";

  // A receipt proves the broker audited the attempt. Only these two states are
  // allowed to lack one, and both mean "nothing was durably recorded".
  if (body.receiptId === null &&
      failureClass !== "receipt_persistence_failed" && failureClass !== "result_ambiguous" &&
      failureClass !== null) {
    // other failure classes may legitimately lack a receipt when unauthenticated
    if (failureClass !== "broker_auth_failed" && failureClass !== "request_rejected") {
      return "invalid_combination";
    }
  }
  if (failureClass === "receipt_persistence_failed" && body.receiptId !== null) return "invalid_combination";

  // Health belongs to a successful health read and nowhere else, so a failed
  // health response cannot smuggle a snapshot or a binding list.
  const expectsHealth = succeeded && isHealth;
  if (expectsHealth !== (health !== null)) return "invalid_combination";
  if (!expectsHealth && bindings.length > 0) return "invalid_combination";
  if (health !== null && health.bindingCount !== bindings.length) return "invalid_combination";

  return null;
}

function parseHealth(value: unknown): ProtocolParseResult<BrokerHealthSnapshot | null> {
  if (value === null) return { ok: true, value: null };
  if (!isPlainObject(value)) return invalid("invalid_json_value");
  if (!hasExactKeys(value, HEALTH_KEYS)) return invalid("unknown_field");
  if (value.protocolVersion !== BROKER_SCHEMA_VERSION) return invalid("invalid_field");
  if (typeof value.brokerVersion !== "string" || !/^[\x20-\x7e]{1,32}$/.test(value.brokerVersion)) {
    return invalid("invalid_field");
  }
  if (value.adapter !== "onepassword") return invalid("invalid_field");
  if (!BROKER_ADAPTER_STATES.includes(value.adapterState as BrokerAdapterState)) return invalid("invalid_field");
  if (typeof value.auditWritable !== "boolean") return invalid("invalid_field");
  if (!Number.isSafeInteger(value.bindingCount) || (value.bindingCount as number) < 0) {
    return invalid("invalid_field");
  }
  if ((value.bindingCount as number) > BROKER_MAX_BINDINGS) return invalid("limit_exceeded");
  if (typeof value.topologyReceiptDigest !== "string" || !SHA256_PATTERN.test(value.topologyReceiptDigest)) {
    return invalid("invalid_field");
  }
  if (!isEpochMs(value.topologyReceiptExpiresAt)) return invalid("invalid_field");
  return { ok: true, value: Object.freeze({ ...value }) as unknown as BrokerHealthSnapshot };
}

function parseBindings(value: unknown): ProtocolParseResult<readonly CredentialBindingMetadata[]> {
  if (!Array.isArray(value)) return invalid("invalid_json_value");
  if (value.length > BROKER_MAX_BINDINGS) return invalid("limit_exceeded");
  const parsed: CredentialBindingMetadata[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const binding = parseBinding(entry);
    if (!binding.ok) return binding;
    if (seen.has(binding.value.bindingId)) return invalid("invalid_field");
    seen.add(binding.value.bindingId);
    parsed.push(binding.value);
  }
  return { ok: true, value: parsed };
}

function parseBinding(value: unknown): ProtocolParseResult<CredentialBindingMetadata> {
  if (!isPlainObject(value)) return invalid("invalid_json_value");
  if (!hasExactKeys(value, BINDING_KEYS)) return invalid("unknown_field");
  if (!isOpaqueId(value.bindingId)) return invalid("invalid_field");
  if (typeof value.label !== "string" || value.label.trim().length === 0 || value.label.length > MAX_LABEL_CHARS) {
    return invalid("invalid_field");
  }
  if (value.provider !== "onepassword") return invalid("invalid_field");
  if (!BROKER_BINDING_STATES.includes(value.state as BrokerBindingState)) return invalid("invalid_field");
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0) return invalid("invalid_field");
  if (!BROKER_BINDING_RISKS.includes(value.risk as CredentialBindingMetadata["risk"])) return invalid("invalid_field");
  if (!BROKER_MFA_MODES.includes(value.mfaMode as CredentialBindingMetadata["mfaMode"])) return invalid("invalid_field");
  if (!BROKER_APPROVAL_MODES.includes(value.approvalMode as CredentialBindingMetadata["approvalMode"])) {
    return invalid("invalid_field");
  }
  if (value.lastVerifiedAt !== null && !isEpochMs(value.lastVerifiedAt)) return invalid("invalid_field");
  if (!Array.isArray(value.capabilityIds) || value.capabilityIds.length > MAX_CAPABILITY_IDS) {
    return invalid("invalid_field");
  }
  if (!value.capabilityIds.every(isOpaqueId)) return invalid("invalid_field");
  if (new Set(value.capabilityIds).size !== value.capabilityIds.length) return invalid("invalid_field");
  return { ok: true, value: Object.freeze({ ...value }) as unknown as CredentialBindingMetadata };
}

function isBrokerOperation(value: unknown): value is BrokerOperation {
  return BROKER_OPERATIONS.includes(value as BrokerOperation);
}

function isBrokerCapabilityId(value: unknown): value is BrokerCapabilityId {
  return BROKER_CAPABILITY_IDS.includes(value as BrokerCapabilityId);
}

function isBrokerFailureClass(value: unknown): value is BrokerFailureClass {
  return BROKER_FAILURE_CLASSES.includes(value as BrokerFailureClass);
}
