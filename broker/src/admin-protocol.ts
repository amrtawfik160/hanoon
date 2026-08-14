import {
  BROKER_APPROVAL_MODES,
  BROKER_BINDING_RISKS,
  BROKER_MAX_BINDINGS,
  BROKER_MFA_MODES,
  OPAQUE_ID_PATTERN,
  SHA256_PATTERN,
  type BrokerBindingState,
} from "../../src/credentials/protocol.js";

export const ADMIN_MAX_LINE_BYTES = 16_384;
export const ADMIN_OPERATIONS = [
  "installation.add",
  "installation.attest",
  "installation.revoke",
  "binding.add",
  "binding.revoke",
  "installation.doctor",
  "broker.status",
] as const;

export type AdminOperation = (typeof ADMIN_OPERATIONS)[number];
export type AdminMutationOperation = Exclude<AdminOperation, "installation.doctor" | "broker.status">;

export type AdminRequest =
  | Readonly<{
      operation: "installation.add";
      clientCertificatePem: string;
      topologyReceiptDigest: string;
      topologyReceiptExpiresAt: number;
      expectedVaultId: string;
    }>
  | Readonly<{
      operation: "installation.attest";
      installationId: string;
      topologyReceiptDigest: string;
      topologyReceiptExpiresAt: number;
    }>
  | Readonly<{ operation: "installation.revoke"; installationId: string }>
  | Readonly<{
      operation: "binding.add";
      installationId: string;
      reference: string;
      label: string;
      capabilityIds: readonly string[];
      risk: (typeof BROKER_BINDING_RISKS)[number];
      mfaMode: (typeof BROKER_MFA_MODES)[number];
      approvalMode: (typeof BROKER_APPROVAL_MODES)[number];
    }>
  | Readonly<{ operation: "binding.revoke"; installationId: string; bindingId: string }>
  | Readonly<{ operation: "installation.doctor"; installationId: string }>
  | Readonly<{ operation: "broker.status" }>;

export type AdminFailureCode =
  | "invalid_request"
  | "line_too_large"
  | "invalid_certificate"
  | "invalid_reference"
  | "vault_mismatch"
  | "attestation_expired"
  | "attestation_too_long"
  | "installation_missing"
  | "installation_unavailable"
  | "binding_missing"
  | "binding_inactive"
  | "binding_limit"
  | "store_failure";

const ADMIN_FAILURE_CODES = [
  "invalid_request",
  "line_too_large",
  "invalid_certificate",
  "invalid_reference",
  "vault_mismatch",
  "attestation_expired",
  "attestation_too_long",
  "installation_missing",
  "installation_unavailable",
  "binding_missing",
  "binding_inactive",
  "binding_limit",
  "store_failure",
] as const;

export type AdminResponse =
  | Readonly<{ ok: false; operation: AdminOperation | null; code: AdminFailureCode }>
  | Readonly<{ ok: true; operation: "installation.add"; installationId: string; state: "active" }>
  | Readonly<{ ok: true; operation: "installation.attest"; installationId: string; state: "active" }>
  | Readonly<{ ok: true; operation: "installation.revoke"; installationId: string; state: "revoked" }>
  | Readonly<{
      ok: true;
      operation: "binding.add";
      installationId: string;
      bindingId: string;
      state: "pending";
      generation: 1;
    }>
  | Readonly<{
      ok: true;
      operation: "binding.revoke";
      installationId: string;
      bindingId: string;
      state: "revoked";
      generation: number;
    }>
  | Readonly<{
      ok: true;
      operation: "installation.doctor";
      installationId: string;
      state: Extract<BrokerBindingState, "active" | "revoked" | "compromised">;
      bindingCount: number;
      adapterState: "ready" | "degraded" | "unavailable";
      topologyReceiptState: "valid" | "expired";
    }>
  | Readonly<{
      ok: true;
      operation: "broker.status";
      schemaVersion: 1;
      brokerVersion: string;
      installationCount: number;
      bindingCount: number;
    }>;

export type AdminParseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: "invalid_json" | "unknown_operation" | "unknown_field" | "invalid_field" }>;

const INSTALLATION_ID_KEYS = ["operation", "installationId"] as const;
const ATTESTATION_KEYS = ["operation", "installationId", "topologyReceiptDigest", "topologyReceiptExpiresAt"] as const;
const INSTALLATION_ADD_KEYS = [
  "operation", "clientCertificatePem", "topologyReceiptDigest", "topologyReceiptExpiresAt", "expectedVaultId",
] as const;
const BINDING_ADD_KEYS = [
  "operation", "installationId", "reference", "label", "capabilityIds", "risk", "mfaMode", "approvalMode",
] as const;
const BINDING_REVOKE_KEYS = ["operation", "installationId", "bindingId"] as const;
const OPERATION_ONLY_KEYS = ["operation"] as const;

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function hasExactKeys(input: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(input);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isOpaqueId(input: unknown): input is string {
  return typeof input === "string" && OPAQUE_ID_PATTERN.test(input);
}

function isDigest(input: unknown): input is string {
  return typeof input === "string" && SHA256_PATTERN.test(input);
}

function isEpoch(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0;
}

function isCapabilityList(input: unknown): input is readonly string[] {
  if (!Array.isArray(input) || input.length > 8) return false;
  if (!input.every(isOpaqueId)) return false;
  return new Set(input).size === input.length;
}

function isExpectedVaultId(input: unknown): input is string {
  return typeof input === "string" && /^[A-Za-z0-9]{26}$/.test(input);
}

function isBoundedText(input: unknown, maximum: number): input is string {
  return typeof input === "string" && input.length >= 1 && input.length <= maximum;
}

function isKnownOperation(input: unknown): input is AdminOperation {
  return ADMIN_OPERATIONS.includes(input as AdminOperation);
}

export function knownAdminOperation(input: unknown): AdminOperation | null {
  return isKnownOperation(input) ? input : null;
}

export function isAdminMutationOperation(input: unknown): input is AdminMutationOperation {
  return isKnownOperation(input) && input !== "installation.doctor" && input !== "broker.status";
}

export function parseAdminRequest(input: unknown): AdminParseResult<AdminRequest> {
  if (!isPlainObject(input)) return { ok: false, code: "invalid_json" };
  if (!isKnownOperation(input.operation)) return { ok: false, code: "unknown_operation" };

  if (input.operation === "installation.add") {
    if (!hasExactKeys(input, INSTALLATION_ADD_KEYS)) return { ok: false, code: "unknown_field" };
    if (!isBoundedText(input.clientCertificatePem, ADMIN_MAX_LINE_BYTES) || !isDigest(input.topologyReceiptDigest) ||
        !isEpoch(input.topologyReceiptExpiresAt) || !isExpectedVaultId(input.expectedVaultId)) {
      return { ok: false, code: "invalid_field" };
    }
    return { ok: true, value: Object.freeze({ ...input }) as AdminRequest };
  }

  if (input.operation === "installation.attest") {
    if (!hasExactKeys(input, ATTESTATION_KEYS)) return { ok: false, code: "unknown_field" };
    if (!isOpaqueId(input.installationId) || !isDigest(input.topologyReceiptDigest) || !isEpoch(input.topologyReceiptExpiresAt)) {
      return { ok: false, code: "invalid_field" };
    }
    return { ok: true, value: Object.freeze({ ...input }) as AdminRequest };
  }

  if (input.operation === "installation.revoke" || input.operation === "installation.doctor") {
    if (!hasExactKeys(input, INSTALLATION_ID_KEYS) || !isOpaqueId(input.installationId)) {
      return { ok: false, code: "invalid_field" };
    }
    return { ok: true, value: Object.freeze({ ...input }) as AdminRequest };
  }

  if (input.operation === "binding.add") {
    if (!hasExactKeys(input, BINDING_ADD_KEYS) || !isOpaqueId(input.installationId) ||
        !isBoundedText(input.reference, 512) || !isBoundedText(input.label, 120) || input.label.trim().length === 0 ||
        !isCapabilityList(input.capabilityIds) || !BROKER_BINDING_RISKS.includes(input.risk as typeof BROKER_BINDING_RISKS[number]) ||
        !BROKER_MFA_MODES.includes(input.mfaMode as typeof BROKER_MFA_MODES[number]) ||
        !BROKER_APPROVAL_MODES.includes(input.approvalMode as typeof BROKER_APPROVAL_MODES[number])) {
      return { ok: false, code: "invalid_field" };
    }
    return { ok: true, value: Object.freeze({ ...input }) as AdminRequest };
  }

  if (input.operation === "binding.revoke") {
    if (!hasExactKeys(input, BINDING_REVOKE_KEYS) || !isOpaqueId(input.installationId) || !isOpaqueId(input.bindingId)) {
      return { ok: false, code: "invalid_field" };
    }
    return { ok: true, value: Object.freeze({ ...input }) as AdminRequest };
  }

  if (!hasExactKeys(input, OPERATION_ONLY_KEYS)) return { ok: false, code: "unknown_field" };
  return { ok: true, value: Object.freeze({ operation: "broker.status" }) };
}

function isAdminFailureCode(input: unknown): input is AdminFailureCode {
  return ADMIN_FAILURE_CODES.includes(input as AdminFailureCode);
}

export function parseAdminResponse(input: unknown): AdminParseResult<AdminResponse> {
  if (!isPlainObject(input) || typeof input.ok !== "boolean") return { ok: false, code: "invalid_json" };
  if (input.ok === false) {
    if (!hasExactKeys(input, ["ok", "operation", "code"]) ||
        (input.operation !== null && !isKnownOperation(input.operation)) || !isAdminFailureCode(input.code)) {
      return { ok: false, code: "invalid_field" };
    }
    return { ok: true, value: input as AdminResponse };
  }

  if (input.operation === "installation.add" || input.operation === "installation.attest") {
    if (!hasExactKeys(input, ["ok", "operation", "installationId", "state"]) ||
        !isOpaqueId(input.installationId) || input.state !== "active") return { ok: false, code: "invalid_field" };
    return { ok: true, value: input as AdminResponse };
  }
  if (input.operation === "installation.revoke") {
    if (!hasExactKeys(input, ["ok", "operation", "installationId", "state"]) ||
        !isOpaqueId(input.installationId) || input.state !== "revoked") return { ok: false, code: "invalid_field" };
    return { ok: true, value: input as AdminResponse };
  }
  if (input.operation === "binding.add") {
    if (!hasExactKeys(input, ["ok", "operation", "installationId", "bindingId", "state", "generation"]) ||
        !isOpaqueId(input.installationId) || !isOpaqueId(input.bindingId) || input.state !== "pending" || input.generation !== 1) {
      return { ok: false, code: "invalid_field" };
    }
    return { ok: true, value: input as AdminResponse };
  }
  if (input.operation === "binding.revoke") {
    if (!hasExactKeys(input, ["ok", "operation", "installationId", "bindingId", "state", "generation"]) ||
        !isOpaqueId(input.installationId) || !isOpaqueId(input.bindingId) || input.state !== "revoked" ||
        !Number.isSafeInteger(input.generation) || (input.generation as number) < 1) {
      return { ok: false, code: "invalid_field" };
    }
    return { ok: true, value: input as AdminResponse };
  }
  if (input.operation === "installation.doctor") {
    if (!hasExactKeys(input, ["ok", "operation", "installationId", "state", "bindingCount", "adapterState", "topologyReceiptState"]) ||
        !isOpaqueId(input.installationId) || !["active", "revoked", "compromised"].includes(input.state as string) ||
        !Number.isSafeInteger(input.bindingCount) || (input.bindingCount as number) < 0 || (input.bindingCount as number) > BROKER_MAX_BINDINGS ||
        !["ready", "degraded", "unavailable"].includes(input.adapterState as string) ||
        !["valid", "expired"].includes(input.topologyReceiptState as string)) {
      return { ok: false, code: "invalid_field" };
    }
    return { ok: true, value: input as AdminResponse };
  }
  if (!hasExactKeys(input, ["ok", "operation", "schemaVersion", "brokerVersion", "installationCount", "bindingCount"]) ||
      input.operation !== "broker.status" || input.schemaVersion !== 1 ||
      !isBoundedText(input.brokerVersion, 32) || !Number.isSafeInteger(input.installationCount) ||
      !Number.isSafeInteger(input.bindingCount) || (input.installationCount as number) < 0 || (input.bindingCount as number) < 0) {
    return { ok: false, code: "invalid_field" };
  }
  return { ok: true, value: input as AdminResponse };
}

export function encodeAdminResponse(response: AdminResponse): string {
  const parsed = parseAdminResponse(response);
  if (!parsed.ok) throw new Error("invalid_admin_response");
  const line = `${JSON.stringify(parsed.value)}\n`;
  if (Buffer.byteLength(line, "utf8") > ADMIN_MAX_LINE_BYTES) throw new Error("admin_response_too_large");
  return line;
}
