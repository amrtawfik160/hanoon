import { describe, expect, it } from "vitest";
import {
  PROTECTED_CONNECTOR_DESCRIPTORS,
  PROTECTED_CONNECTOR_POLICY_DIGEST,
  VERCEL_BROWSER_ORIGIN,
  VERCEL_PROJECT_IDENTITY_JOURNEY_ID,
  finalizeProtectedConnectorEvidence,
  resolveProtectedConnectorRegistration,
  type ProtectedConnectorBindingProjection,
  type ProtectedConnectorDurableReceipt,
  type ProtectedConnectorRegistryContext,
} from "../src/credentials/connector-policy";
import {
  protectedConnectorCapabilityFor,
  protectedConnectorResponseDigest,
  type ProtectedConnectorOperation,
  type ProtectedConnectorRequestEnvelope,
  type ProtectedConnectorResponseEnvelope,
} from "../src/credentials/connector-protocol";
import type { BrokerResponseEnvelope } from "../src/credentials/protocol";

const NOW = 1_800_000_000_000;

function binding(operation: ProtectedConnectorOperation): ProtectedConnectorBindingProjection {
  const browser = operation === "browser.vercel_project.inspect.v1";
  return {
    schemaVersion: 2,
    bindingId: `binding-${operation}`,
    installationId: "installation-1",
    operation,
    bindingKind: browser ? "browser_session" : "workload_identity",
    authorityProvider: operation === "convex.project.inspect.v1" ? "convex" : browser ? "bb_browser" : "vercel",
    secretProvider: browser ? "broker_session" : "provider_native",
    principalLabel: "Hanoon employee",
    capabilityIds: [protectedConnectorCapabilityFor(operation)],
    audiences: browser ? [] : [operation === "convex.project.inspect.v1" ? "api.convex.dev" : "api.vercel.com"],
    origins: browser ? [VERCEL_BROWSER_ORIGIN] : [],
    scopes: browser ? [] : ["project:read"],
    riskClass: "low",
    mfaMode: browser ? "human_presence" : "workload_identity",
    approvalMode: "standing_policy",
    state: browser ? "active" : "vault_verified",
    generation: 1,
    verifiedAt: null,
    expiresAt: null,
  };
}

function context(
  operation: ProtectedConnectorOperation,
  overrides: Partial<ProtectedConnectorRegistryContext> = {},
): ProtectedConnectorRegistryContext {
  return {
    installationId: "installation-1",
    protocolVersion: 2,
    topologyReady: true,
    browserAdministrationIsolated: true,
    auditWritable: true,
    projectPolicyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
    currentPolicyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
    bindings: [binding(operation)],
    now: NOW,
    ...overrides,
  };
}

function request(operation: ProtectedConnectorOperation): ProtectedConnectorRequestEnvelope {
  return {
    schemaVersion: 2,
    installationId: "installation-1",
    requestId: "request-1",
    idempotencyKey: "idempotency-1",
    nonce: "nonce-1",
    operation,
    bindingId: `binding-${operation}`,
    bindingGeneration: 1,
    taskId: "task-1",
    projectId: "project-1",
    capabilityId: protectedConnectorCapabilityFor(operation),
    policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
    fenceOwner: "executor-1",
    fenceGeneration: 1,
    issuedAt: NOW,
    deadlineAt: NOW + 30_000,
  } as ProtectedConnectorRequestEnvelope;
}

function browserSuccess(): ProtectedConnectorResponseEnvelope {
  return {
    schemaVersion: 2,
    installationId: "installation-1",
    requestId: "request-1",
    operation: "browser.vercel_project.inspect.v1",
    outcome: "succeeded",
    result: {
      profileId: "profile-1",
      journeyId: VERCEL_PROJECT_IDENTITY_JOURNEY_ID,
      journeyVersion: 1,
      origin: VERCEL_BROWSER_ORIGIN,
      teamSlug: "team-1",
      projectName: "hanoon",
      sessionStatus: "authenticated",
      observedAt: NOW + 1_000,
    },
    failureClass: null,
    retryable: false,
    retryAfterMs: null,
    receiptId: "receipt-1",
    completedAt: NOW + 2_000,
  };
}

function durableReceipt(
  response: ProtectedConnectorResponseEnvelope = browserSuccess(),
): ProtectedConnectorDurableReceipt {
  return {
    receiptId: response.receiptId!,
    installationId: "installation-1",
    requestId: "request-1",
    idempotencyKey: "idempotency-1",
    operation: "browser.vercel_project.inspect.v1",
    bindingId: "binding-browser.vercel_project.inspect.v1",
    bindingGeneration: 1,
    taskId: "task-1",
    projectId: "project-1",
    capabilityId: "telegram_agent_browser_vercel_project_inspect",
    policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
    fenceOwner: "executor-1",
    fenceGeneration: 1,
    outcome: response.outcome,
    responseSha256: protectedConnectorResponseDigest(response),
  };
}

describe("protected connector capability registry", () => {
  it.each([
    "convex.project.inspect.v1",
    "vercel.project.inspect.v1",
    "browser.vercel_project.inspect.v1",
  ] as const)("registers the exact read-only %s descriptor when every gate is ready", (operation) => {
    expect(resolveProtectedConnectorRegistration(operation, context(operation))).toEqual({
      outcome: "registered",
      descriptor: PROTECTED_CONNECTOR_DESCRIPTORS[operation],
      binding: binding(operation),
    });
  });

  it("admits no unknown or generic operation", () => {
    expect(resolveProtectedConnectorRegistration("http.get", context("convex.project.inspect.v1")))
      .toEqual({ outcome: "denied", reason: "unsupported_operation" });
    expect(resolveProtectedConnectorRegistration("browser.javascript", context("browser.vercel_project.inspect.v1")))
      .toEqual({ outcome: "denied", reason: "unsupported_operation" });
  });

  it.each([
    ["protocol", { protocolVersion: 1 }, "protocol_not_ready"],
    ["topology", { topologyReady: false }, "unsafe_topology"],
    ["audit", { auditWritable: false }, "audit_unavailable"],
    ["policy", { currentPolicyDigest: "e".repeat(64) }, "policy_not_ready"],
    ["binding", { bindings: [] }, "binding_not_ready"],
  ] as const)("fails closed when %s is not ready", (_label, overrides, reason) => {
    expect(resolveProtectedConnectorRegistration(
      "convex.project.inspect.v1",
      context("convex.project.inspect.v1", overrides),
    )).toEqual({ outcome: "denied", reason });
  });

  it("requires mechanical browser-administration isolation", () => {
    expect(resolveProtectedConnectorRegistration(
      "browser.vercel_project.inspect.v1",
      context("browser.vercel_project.inspect.v1", { browserAdministrationIsolated: false }),
    )).toEqual({ outcome: "denied", reason: "unsafe_topology" });
  });

  it("rejects duplicate current bindings instead of selecting one", () => {
    const first = binding("vercel.project.inspect.v1");
    const second = { ...first, bindingId: "binding-vercel-2" };
    expect(resolveProtectedConnectorRegistration(
      "vercel.project.inspect.v1",
      context("vercel.project.inspect.v1", { bindings: [first, second] }),
    )).toEqual({ outcome: "denied", reason: "binding_not_ready" });
  });
});

describe("protected connector finalization", () => {
  it("accepts one current, receipted operation-specific identity proof", () => {
    const operation = "browser.vercel_project.inspect.v1" as const;
    expect(finalizeProtectedConnectorEvidence({
      request: request(operation),
      response: browserSuccess(),
      receipt: durableReceipt(),
      binding: binding(operation),
      currentPolicyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
      now: NOW + 10_000,
    })).toEqual({
      outcome: "succeeded",
      operation,
      bindingId: `binding-${operation}`,
      receiptId: "receipt-1",
      proofKind: "browser_session_identity",
    });
  });

  it("does not turn schema-v1 vault verification into provider identity", () => {
    const operation = "convex.project.inspect.v1" as const;
    const vaultVerification: BrokerResponseEnvelope = {
      schemaVersion: 1,
      installationId: "installation-1",
      requestId: "request-1",
      operation: "vault.binding.verify",
      outcome: "succeeded",
      result: "valid",
      failureClass: null,
      retryable: false,
      retryAfterMs: null,
      receiptId: "vault-receipt-1",
      health: null,
      bindings: [],
      completedAt: NOW,
    };
    expect(finalizeProtectedConnectorEvidence({
      request: request(operation),
      response: vaultVerification,
      receipt: null,
      binding: binding(operation),
      currentPolicyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
      now: NOW,
    })).toEqual({ outcome: "incomplete", reason: "not_connector_evidence" });
  });

  it("does not accept an unreceipted browser observation", () => {
    const operation = "browser.vercel_project.inspect.v1" as const;
    expect(finalizeProtectedConnectorEvidence({
      request: request(operation),
      response: browserSuccess(),
      receipt: null,
      binding: binding(operation),
      currentPolicyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
      now: NOW,
    })).toEqual({ outcome: "incomplete", reason: "invalid_evidence" });
    expect(finalizeProtectedConnectorEvidence({
      request: request(operation),
      response: browserSuccess(),
      receipt: { ...durableReceipt(), responseSha256: "e".repeat(64) },
      binding: binding(operation),
      currentPolicyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
      now: NOW,
    })).toEqual({ outcome: "incomplete", reason: "invalid_evidence" });
  });

  it("rejects changed policy, wrong binding generation, late completion, and stable failure", () => {
    const operation = "browser.vercel_project.inspect.v1" as const;
    const base = {
      request: request(operation),
      response: browserSuccess(),
      receipt: durableReceipt(),
      binding: binding(operation),
      currentPolicyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
      now: NOW,
    };
    expect(finalizeProtectedConnectorEvidence({ ...base, currentPolicyDigest: "e".repeat(64) }))
      .toEqual({ outcome: "incomplete", reason: "authority_changed" });
    expect(finalizeProtectedConnectorEvidence({ ...base, binding: { ...base.binding, generation: 2 } }))
      .toEqual({ outcome: "incomplete", reason: "identity_mismatch" });
    expect(finalizeProtectedConnectorEvidence({ ...base, binding: { ...base.binding, state: "revoked" } }))
      .toEqual({ outcome: "incomplete", reason: "authority_changed" });
    expect(finalizeProtectedConnectorEvidence({
      ...base,
      response: { ...browserSuccess(), completedAt: NOW + 30_001 },
    })).toEqual({ outcome: "incomplete", reason: "deadline_expired" });
    expect(finalizeProtectedConnectorEvidence({
      ...base,
      response: {
        ...browserSuccess(),
        outcome: "failed",
        result: null,
        failureClass: "human_presence_required",
        receiptId: "receipt-failed",
      },
    })).toEqual({ outcome: "incomplete", reason: "operation_failed" });
  });
});
