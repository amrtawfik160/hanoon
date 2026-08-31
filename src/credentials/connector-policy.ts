/** Exact, secret-free binding policy for the protected connector slice. */
import { createHash } from "node:crypto";
import { capabilityDescriptorById } from "../capabilities/catalog";
import type { CapabilityDescriptor } from "../capabilities/contracts";
import {
  OPAQUE_ID_PATTERN,
  SHA256_PATTERN,
  canonicalBrokerJson,
  type ProtocolParseResult,
} from "./protocol";
import {
  PROTECTED_CONNECTOR_MAX_REQUEST_BYTES,
  PROTECTED_CONNECTOR_MAX_RESPONSE_BYTES,
  PROTECTED_CONNECTOR_OPERATIONS,
  PROTECTED_CONNECTOR_SCHEMA_VERSION,
  parseCredentialProtocolResponse,
  protectedConnectorCapabilityFor,
  protectedConnectorResponseDigest,
  type BrowserVercelProjectIdentity,
  type ConvexProjectIdentity,
  type ProtectedConnectorCapabilityId,
  type ProtectedConnectorIdentity,
  type ProtectedConnectorOperation,
  type ProtectedConnectorRequestEnvelope,
  type ProtectedConnectorResponseEnvelope,
  type VercelProjectIdentity,
} from "./connector-protocol";

export const VERCEL_BROWSER_ORIGIN = "https://vercel.com" as const;
export const VERCEL_PROJECT_IDENTITY_JOURNEY_ID = "vercel-project-identity" as const;
export const VERCEL_PROJECT_IDENTITY_JOURNEY_VERSION = 1 as const;

export const CONNECTOR_BINDING_KINDS = [
  "vault_item",
  "oauth_grant",
  "workload_identity",
  "browser_session",
] as const;
export const CONNECTOR_SECRET_PROVIDERS = ["onepassword", "provider_native", "broker_session"] as const;
export const CONNECTOR_BINDING_STATES = [
  "pending",
  "vault_verified",
  "active",
  "degraded",
  "expired",
  "revoked",
  "compromised",
] as const;
export const CONNECTOR_RISK_CLASSES = ["low", "medium", "high", "critical"] as const;
export const CONNECTOR_MFA_MODES = ["none", "workload_identity", "totp_broker", "human_presence"] as const;
export const CONNECTOR_APPROVAL_MODES = ["standing_policy", "telegram_once", "strong_once", "human_only"] as const;

export type ConnectorBindingKind = (typeof CONNECTOR_BINDING_KINDS)[number];
export type ConnectorSecretProvider = (typeof CONNECTOR_SECRET_PROVIDERS)[number];
export type ConnectorBindingState = (typeof CONNECTOR_BINDING_STATES)[number];

export type ProtectedConnectorBindingProjection = Readonly<{
  schemaVersion: 2;
  bindingId: string;
  installationId: string;
  operation: ProtectedConnectorOperation;
  bindingKind: ConnectorBindingKind;
  authorityProvider: "convex" | "vercel" | "bb_browser";
  secretProvider: ConnectorSecretProvider;
  principalLabel: string;
  capabilityIds: readonly ProtectedConnectorCapabilityId[];
  audiences: readonly string[];
  origins: readonly string[];
  scopes: readonly string[];
  riskClass: (typeof CONNECTOR_RISK_CLASSES)[number];
  mfaMode: (typeof CONNECTOR_MFA_MODES)[number];
  approvalMode: (typeof CONNECTOR_APPROVAL_MODES)[number];
  state: ConnectorBindingState;
  generation: number;
  verifiedAt: number | null;
  expiresAt: number | null;
}>;

export type ConvexProjectTarget = Readonly<{
  operation: "convex.project.inspect.v1";
  teamIdOrSlug: string;
  projectSlug: string;
}>;

export type VercelProjectTarget = Readonly<{
  operation: "vercel.project.inspect.v1";
  teamId: string;
  projectIdOrName: string;
}>;

export type BrowserVercelProjectTarget = Readonly<{
  operation: "browser.vercel_project.inspect.v1";
  hostId: string;
  profileId: string;
  origin: "https://vercel.com";
  journeyId: "vercel-project-identity";
  journeyVersion: 1;
  teamSlug: string;
  projectName: string;
}>;

/** Broker-private target metadata. This type is intentionally absent from the wire protocol. */
export type ProtectedConnectorTarget =
  | ConvexProjectTarget
  | VercelProjectTarget
  | BrowserVercelProjectTarget;

export type ProtectedConnectorDescriptor = Readonly<{
  schemaVersion: 2;
  operation: ProtectedConnectorOperation;
  capabilityId: ProtectedConnectorCapabilityId;
  effectClass: "read";
  riskClass: "low";
  proofKind: "provider_identity" | "browser_session_identity";
  authorityProvider: ProtectedConnectorBindingProjection["authorityProvider"];
  audience: string | null;
  origin: "https://vercel.com" | null;
  maxRequestBytes: number;
  maxResponseBytes: number;
}>;

export const PROTECTED_CONNECTOR_DESCRIPTORS = Object.freeze({
  "convex.project.inspect.v1": Object.freeze({
    schemaVersion: 2,
    operation: "convex.project.inspect.v1",
    capabilityId: "telegram_agent_convex_project_inspect",
    effectClass: "read",
    riskClass: "low",
    proofKind: "provider_identity",
    authorityProvider: "convex",
    audience: "api.convex.dev",
    origin: null,
    maxRequestBytes: PROTECTED_CONNECTOR_MAX_REQUEST_BYTES,
    maxResponseBytes: PROTECTED_CONNECTOR_MAX_RESPONSE_BYTES,
  }),
  "vercel.project.inspect.v1": Object.freeze({
    schemaVersion: 2,
    operation: "vercel.project.inspect.v1",
    capabilityId: "telegram_agent_vercel_project_inspect",
    effectClass: "read",
    riskClass: "low",
    proofKind: "provider_identity",
    authorityProvider: "vercel",
    audience: "api.vercel.com",
    origin: null,
    maxRequestBytes: PROTECTED_CONNECTOR_MAX_REQUEST_BYTES,
    maxResponseBytes: PROTECTED_CONNECTOR_MAX_RESPONSE_BYTES,
  }),
  "browser.vercel_project.inspect.v1": Object.freeze({
    schemaVersion: 2,
    operation: "browser.vercel_project.inspect.v1",
    capabilityId: "telegram_agent_browser_vercel_project_inspect",
    effectClass: "read",
    riskClass: "low",
    proofKind: "browser_session_identity",
    authorityProvider: "bb_browser",
    audience: null,
    origin: VERCEL_BROWSER_ORIGIN,
    maxRequestBytes: PROTECTED_CONNECTOR_MAX_REQUEST_BYTES,
    maxResponseBytes: PROTECTED_CONNECTOR_MAX_RESPONSE_BYTES,
  }),
} satisfies Record<ProtectedConnectorOperation, ProtectedConnectorDescriptor>);

export const PROTECTED_CONNECTOR_POLICY = Object.freeze({
  schemaVersion: 2,
  operations: PROTECTED_CONNECTOR_OPERATIONS,
  capabilities: Object.freeze(PROTECTED_CONNECTOR_OPERATIONS.map(protectedConnectorCapabilityFor)),
  descriptors: PROTECTED_CONNECTOR_DESCRIPTORS,
  browser: Object.freeze({
    origin: VERCEL_BROWSER_ORIGIN,
    journeyId: VERCEL_PROJECT_IDENTITY_JOURNEY_ID,
    journeyVersion: VERCEL_PROJECT_IDENTITY_JOURNEY_VERSION,
  }),
});

export const PROTECTED_CONNECTOR_POLICY_DIGEST = createHash("sha256")
  .update(canonicalBrokerJson(PROTECTED_CONNECTOR_POLICY), "utf8")
  .digest("hex");

const PROJECTION_KEYS = [
  "schemaVersion",
  "bindingId",
  "installationId",
  "operation",
  "bindingKind",
  "authorityProvider",
  "secretProvider",
  "principalLabel",
  "capabilityIds",
  "audiences",
  "origins",
  "scopes",
  "riskClass",
  "mfaMode",
  "approvalMode",
  "state",
  "generation",
  "verifiedAt",
  "expiresAt",
] as const;

const CONVEX_TARGET_KEYS = ["operation", "teamIdOrSlug", "projectSlug"] as const;
const VERCEL_TARGET_KEYS = ["operation", "teamId", "projectIdOrName"] as const;
const BROWSER_TARGET_KEYS = [
  "operation",
  "hostId",
  "profileId",
  "origin",
  "journeyId",
  "journeyVersion",
  "teamSlug",
  "projectName",
] as const;

const TARGET_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const URL_SHAPED_TARGET_PATTERN = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|\/\/)/u;
const METADATA_VALUE_PATTERN = /^[\x20-\x7e]{1,128}$/;
const MAX_METADATA_VALUES = 8;

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

function isEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableEpochMs(value: unknown): value is number | null {
  return value === null || isEpochMs(value);
}

function isGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isTargetValue(value: unknown): value is string {
  return typeof value === "string" && TARGET_VALUE_PATTERN.test(value) &&
    !URL_SHAPED_TARGET_PATTERN.test(value);
}

function parseMetadataValues(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_METADATA_VALUES) return null;
  if (!value.every((item) => typeof item === "string" && METADATA_VALUE_PATTERN.test(item))) return null;
  if (new Set(value).size !== value.length) return null;
  return Object.freeze([...value]);
}

function expectedBindingPolicy(operation: ProtectedConnectorOperation): Readonly<{
  authorityProvider: ProtectedConnectorBindingProjection["authorityProvider"];
  bindingKinds: readonly ConnectorBindingKind[];
  secretProviders: readonly ConnectorSecretProvider[];
  audiences: readonly string[];
  origins: readonly string[];
}> {
  if (operation === "convex.project.inspect.v1") return {
    authorityProvider: "convex",
    bindingKinds: ["vault_item", "oauth_grant", "workload_identity"],
    secretProviders: ["onepassword", "provider_native"],
    audiences: ["api.convex.dev"],
    origins: [],
  };
  if (operation === "vercel.project.inspect.v1") return {
    authorityProvider: "vercel",
    bindingKinds: ["vault_item", "oauth_grant", "workload_identity"],
    secretProviders: ["onepassword", "provider_native"],
    audiences: ["api.vercel.com"],
    origins: [],
  };
  return {
    authorityProvider: "bb_browser",
    bindingKinds: ["browser_session"],
    secretProviders: ["broker_session"],
    audiences: [],
    origins: [VERCEL_BROWSER_ORIGIN],
  };
}

export function parseProtectedConnectorBindingProjection(
  value: unknown,
): ProtocolParseResult<ProtectedConnectorBindingProjection> {
  if (!isPlainObject(value)) return invalid("invalid_json_value");
  if (!hasExactKeys(value, PROJECTION_KEYS)) return invalid("unknown_field");
  if (value.schemaVersion !== PROTECTED_CONNECTOR_SCHEMA_VERSION) return invalid("invalid_field");
  if (!isOpaqueId(value.bindingId) || !isOpaqueId(value.installationId)) return invalid("invalid_field");
  if (!PROTECTED_CONNECTOR_OPERATIONS.includes(value.operation as ProtectedConnectorOperation)) {
    return invalid("invalid_field");
  }
  const operation = value.operation as ProtectedConnectorOperation;
  if (!CONNECTOR_BINDING_KINDS.includes(value.bindingKind as ConnectorBindingKind)) return invalid("invalid_field");
  if (!CONNECTOR_SECRET_PROVIDERS.includes(value.secretProvider as ConnectorSecretProvider)) return invalid("invalid_field");
  if (typeof value.principalLabel !== "string" || !/^[\x20-\x7e]{1,120}$/.test(value.principalLabel)) {
    return invalid("invalid_field");
  }
  if (!CONNECTOR_RISK_CLASSES.includes(value.riskClass as ProtectedConnectorBindingProjection["riskClass"])) {
    return invalid("invalid_field");
  }
  if (!CONNECTOR_MFA_MODES.includes(value.mfaMode as ProtectedConnectorBindingProjection["mfaMode"])) {
    return invalid("invalid_field");
  }
  if (!CONNECTOR_APPROVAL_MODES.includes(value.approvalMode as ProtectedConnectorBindingProjection["approvalMode"])) {
    return invalid("invalid_field");
  }
  if (!CONNECTOR_BINDING_STATES.includes(value.state as ConnectorBindingState)) return invalid("invalid_field");
  if (!isGeneration(value.generation) || !isNullableEpochMs(value.verifiedAt) || !isNullableEpochMs(value.expiresAt)) {
    return invalid("invalid_field");
  }
  if (value.state === "active" && value.verifiedAt === null) return invalid("invalid_combination");
  const capabilityIds = parseMetadataValues(value.capabilityIds);
  const audiences = parseMetadataValues(value.audiences);
  const origins = parseMetadataValues(value.origins);
  const scopes = parseMetadataValues(value.scopes);
  if (!capabilityIds || !audiences || !origins || !scopes) return invalid("invalid_field");

  const expected = expectedBindingPolicy(operation);
  const expectedCapability = protectedConnectorCapabilityFor(operation);
  if (
    value.authorityProvider !== expected.authorityProvider ||
    !expected.bindingKinds.includes(value.bindingKind as ConnectorBindingKind) ||
    !expected.secretProviders.includes(value.secretProvider as ConnectorSecretProvider) ||
    capabilityIds.length !== 1 ||
    capabilityIds[0] !== expectedCapability ||
    canonicalBrokerJson(audiences) !== canonicalBrokerJson(expected.audiences) ||
    canonicalBrokerJson(origins) !== canonicalBrokerJson(expected.origins) ||
    value.riskClass !== "low" ||
    value.approvalMode !== "standing_policy"
  ) return invalid("invalid_combination");
  if (operation === "browser.vercel_project.inspect.v1" ? scopes.length !== 0 : scopes.length === 0) {
    return invalid("invalid_combination");
  }

  return {
    ok: true,
    value: Object.freeze({
      ...value,
      capabilityIds,
      audiences,
      origins,
      scopes,
    }) as ProtectedConnectorBindingProjection,
  };
}

export function parseProtectedConnectorTarget(value: unknown): ProtocolParseResult<ProtectedConnectorTarget> {
  if (!isPlainObject(value)) return invalid("invalid_json_value");
  if (value.operation === "convex.project.inspect.v1") {
    if (!hasExactKeys(value, CONVEX_TARGET_KEYS)) return invalid("unknown_field");
    if (!isTargetValue(value.teamIdOrSlug) || !isTargetValue(value.projectSlug)) return invalid("invalid_field");
    return { ok: true, value: Object.freeze({ ...value }) as ConvexProjectTarget };
  }
  if (value.operation === "vercel.project.inspect.v1") {
    if (!hasExactKeys(value, VERCEL_TARGET_KEYS)) return invalid("unknown_field");
    if (!isTargetValue(value.teamId) || !isTargetValue(value.projectIdOrName)) return invalid("invalid_field");
    return { ok: true, value: Object.freeze({ ...value }) as VercelProjectTarget };
  }
  if (value.operation !== "browser.vercel_project.inspect.v1") return invalid("invalid_field");
  if (!hasExactKeys(value, BROWSER_TARGET_KEYS)) return invalid("unknown_field");
  if (
    !isOpaqueId(value.hostId) ||
    !isOpaqueId(value.profileId) ||
    value.origin !== VERCEL_BROWSER_ORIGIN ||
    value.journeyId !== VERCEL_PROJECT_IDENTITY_JOURNEY_ID ||
    value.journeyVersion !== VERCEL_PROJECT_IDENTITY_JOURNEY_VERSION ||
    !isTargetValue(value.teamSlug) ||
    !isTargetValue(value.projectName)
  ) return invalid("invalid_field");
  return { ok: true, value: Object.freeze({ ...value }) as BrowserVercelProjectTarget };
}

export function protectedConnectorTargetDigest(target: ProtectedConnectorTarget): string {
  return createHash("sha256").update(canonicalBrokerJson(target), "utf8").digest("hex");
}

export function protectedConnectorIdentityMatchesTarget(
  target: ProtectedConnectorTarget,
  identity: ProtectedConnectorIdentity,
): boolean {
  if (target.operation === "convex.project.inspect.v1") {
    const convexIdentity = identity as ConvexProjectIdentity;
    return target.projectSlug === convexIdentity.projectSlug &&
      (target.teamIdOrSlug === convexIdentity.teamId || target.teamIdOrSlug === convexIdentity.teamSlug);
  }
  if (target.operation === "vercel.project.inspect.v1") {
    const vercelIdentity = identity as VercelProjectIdentity;
    return target.teamId === vercelIdentity.teamId &&
      (target.projectIdOrName === vercelIdentity.projectId || target.projectIdOrName === vercelIdentity.projectName);
  }
  const browserIdentity = identity as BrowserVercelProjectIdentity;
  return target.profileId === browserIdentity.profileId &&
    target.origin === browserIdentity.origin &&
    target.journeyId === browserIdentity.journeyId &&
    target.journeyVersion === browserIdentity.journeyVersion &&
    target.teamSlug === browserIdentity.teamSlug &&
    target.projectName === browserIdentity.projectName;
}

export type ProtectedConnectorRegistryContext = Readonly<{
  installationId: string;
  protocolVersion: number;
  topologyReady: boolean;
  browserAdministrationIsolated: boolean;
  auditWritable: boolean;
  projectPolicyDigest: string;
  currentPolicyDigest: string;
  bindings: readonly ProtectedConnectorBindingProjection[];
  now: number;
}>;

export type ProtectedConnectorRegistryDenial =
  | "unsupported_operation"
  | "protocol_not_ready"
  | "unsafe_topology"
  | "audit_unavailable"
  | "policy_not_ready"
  | "binding_not_ready";

export type ProtectedConnectorRegistration =
  | Readonly<{
      outcome: "registered";
      descriptor: CapabilityDescriptor;
      binding: ProtectedConnectorBindingProjection;
    }>
  | Readonly<{ outcome: "denied"; reason: ProtectedConnectorRegistryDenial }>;

/**
 * Resolves one connector from the single registry. Discovery is not enough:
 * the protocol, protected topology, current project policy, audit sink, and
 * exactly one current operation binding must all agree.
 */
export function resolveProtectedConnectorRegistration(
  operation: unknown,
  context: ProtectedConnectorRegistryContext,
): ProtectedConnectorRegistration {
  if (!PROTECTED_CONNECTOR_OPERATIONS.includes(operation as ProtectedConnectorOperation)) {
    return { outcome: "denied", reason: "unsupported_operation" };
  }
  const connectorOperation = operation as ProtectedConnectorOperation;
  if (context.protocolVersion !== PROTECTED_CONNECTOR_SCHEMA_VERSION) {
    return { outcome: "denied", reason: "protocol_not_ready" };
  }
  if (!context.topologyReady) return { outcome: "denied", reason: "unsafe_topology" };
  if (connectorOperation === "browser.vercel_project.inspect.v1" && !context.browserAdministrationIsolated) {
    return { outcome: "denied", reason: "unsafe_topology" };
  }
  if (!context.auditWritable) return { outcome: "denied", reason: "audit_unavailable" };
  if (
    !SHA256_PATTERN.test(context.projectPolicyDigest) ||
    context.projectPolicyDigest !== context.currentPolicyDigest
  ) return { outcome: "denied", reason: "policy_not_ready" };

  const bindings = context.bindings.flatMap((candidate) => {
    const parsed = parseProtectedConnectorBindingProjection(candidate);
    return parsed.ok ? [parsed.value] : [];
  }).filter((binding) =>
    binding.installationId === context.installationId &&
    binding.operation === connectorOperation &&
    binding.capabilityIds.includes(protectedConnectorCapabilityFor(connectorOperation)) &&
    binding.generation >= 1 &&
    protectedConnectorBindingCanRun(binding, context.now));
  if (bindings.length !== 1) return { outcome: "denied", reason: "binding_not_ready" };
  const capabilityDescriptor = capabilityDescriptorById(protectedConnectorCapabilityFor(connectorOperation));
  if (!capabilityDescriptor || capabilityDescriptor.kind !== "connector") {
    return { outcome: "denied", reason: "policy_not_ready" };
  }
  return {
    outcome: "registered",
    descriptor: capabilityDescriptor,
    binding: bindings[0]!,
  };
}

export type ProtectedConnectorFinalization =
  | Readonly<{
      outcome: "succeeded";
      operation: ProtectedConnectorOperation;
      bindingId: string;
      receiptId: string;
      proofKind: ProtectedConnectorDescriptor["proofKind"];
    }>
  | Readonly<{
      outcome: "incomplete";
      reason:
        | "invalid_evidence"
        | "not_connector_evidence"
        | "identity_mismatch"
        | "authority_changed"
        | "deadline_expired"
        | "operation_failed";
    }>;

/** Minimal durable receipt identity required by the finalization boundary. */
export type ProtectedConnectorDurableReceipt = Readonly<{
  receiptId: string;
  installationId: string;
  requestId: string;
  idempotencyKey: string;
  operation: ProtectedConnectorOperation;
  bindingId: string;
  bindingGeneration: number;
  taskId: string;
  projectId: string;
  capabilityId: ProtectedConnectorCapabilityId;
  policyDigest: string;
  fenceOwner: string;
  fenceGeneration: number;
  outcome: "succeeded" | "failed";
  responseSha256: string;
}>;

export type ProtectedConnectorAuthoritySnapshot = Readonly<{
  installationId: string;
  taskId: string;
  projectId: string;
  capabilityId: ProtectedConnectorCapabilityId;
  bindingId: string;
  bindingGeneration: number;
  policyDigest: string;
  fenceOwner: string;
  fenceGeneration: number;
}>;

export function protectedConnectorAuthorityMatchesRequest(
  authority: ProtectedConnectorAuthoritySnapshot | null | undefined,
  request: ProtectedConnectorRequestEnvelope,
): boolean {
  return authority !== null && authority !== undefined &&
    authority.installationId === request.installationId &&
    authority.taskId === request.taskId &&
    authority.projectId === request.projectId &&
    authority.capabilityId === request.capabilityId &&
    authority.bindingId === request.bindingId &&
    authority.bindingGeneration === request.bindingGeneration &&
    authority.policyDigest === request.policyDigest &&
    authority.fenceOwner === request.fenceOwner &&
    authority.fenceGeneration === request.fenceGeneration;
}

/** Only a current, receipted schema-v2 identity proof may support success. */
export function finalizeProtectedConnectorEvidence(input: Readonly<{
  request: ProtectedConnectorRequestEnvelope;
  response: unknown;
  receipt: ProtectedConnectorDurableReceipt | null;
  binding: ProtectedConnectorBindingProjection;
  currentPolicyDigest: string;
  currentAuthority: ProtectedConnectorAuthoritySnapshot | null;
  now: number;
}>): ProtectedConnectorFinalization {
  const parsedBinding = parseProtectedConnectorBindingProjection(input.binding);
  if (!parsedBinding.ok) return { outcome: "incomplete", reason: "invalid_evidence" };
  const binding = parsedBinding.value;
  const parsed = parseCredentialProtocolResponse(input.response);
  if (!parsed.ok) return { outcome: "incomplete", reason: "invalid_evidence" };
  if (parsed.value.schemaVersion !== PROTECTED_CONNECTOR_SCHEMA_VERSION) {
    return { outcome: "incomplete", reason: "not_connector_evidence" };
  }
  const response = parsed.value as ProtectedConnectorResponseEnvelope;
  if (
    response.installationId !== input.request.installationId ||
    response.requestId !== input.request.requestId ||
    response.operation !== input.request.operation ||
    binding.installationId !== input.request.installationId ||
    binding.bindingId !== input.request.bindingId ||
    binding.generation !== input.request.bindingGeneration ||
    binding.operation !== input.request.operation
  ) return { outcome: "incomplete", reason: "identity_mismatch" };
  if (response.completedAt > input.request.deadlineAt) {
    return { outcome: "incomplete", reason: "deadline_expired" };
  }
  if (response.outcome !== "succeeded") return { outcome: "incomplete", reason: "operation_failed" };
  if (!input.receipt) return { outcome: "incomplete", reason: "invalid_evidence" };
  const receipt = input.receipt;
  if (
    !receipt ||
    receipt.receiptId !== response.receiptId ||
    receipt.installationId !== input.request.installationId ||
    receipt.requestId !== input.request.requestId ||
    receipt.idempotencyKey !== input.request.idempotencyKey ||
    receipt.operation !== input.request.operation ||
    receipt.bindingId !== input.request.bindingId ||
    receipt.bindingGeneration !== input.request.bindingGeneration ||
    receipt.taskId !== input.request.taskId ||
    receipt.projectId !== input.request.projectId ||
    receipt.capabilityId !== input.request.capabilityId ||
    receipt.policyDigest !== input.request.policyDigest ||
    receipt.fenceOwner !== input.request.fenceOwner ||
    receipt.fenceGeneration !== input.request.fenceGeneration ||
    receipt.outcome !== "succeeded" ||
    receipt.responseSha256 !== protectedConnectorResponseDigest(response)
  ) return { outcome: "incomplete", reason: "invalid_evidence" };
  if (
    input.currentPolicyDigest !== input.request.policyDigest ||
    !protectedConnectorAuthorityMatchesRequest(input.currentAuthority, input.request) ||
    !protectedConnectorBindingCanRun(binding, input.now)
  ) {
    return { outcome: "incomplete", reason: "authority_changed" };
  }
  return {
    outcome: "succeeded",
    operation: response.operation,
    bindingId: binding.bindingId,
    receiptId: response.receiptId,
    proofKind: PROTECTED_CONNECTOR_DESCRIPTORS[response.operation].proofKind,
  };
}

export function protectedConnectorBindingCanRun(binding: ProtectedConnectorBindingProjection, now: number): boolean {
  if (binding.expiresAt !== null && now >= binding.expiresAt) return false;
  return binding.operation === "browser.vercel_project.inspect.v1"
    ? binding.state === "pending" || binding.state === "active"
    : binding.state === "vault_verified" || binding.state === "active";
}
