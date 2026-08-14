import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BROKER_FAILURE_CLASSES,
  BROKER_MAX_DEADLINE_MS,
  BROKER_MAX_BINDINGS,
  BROKER_SCHEMA_VERSION,
  FOUNDATION_BROKER_POLICY,
  FOUNDATION_BROKER_POLICY_DIGEST,
  brokerRequestDigest,
  canonicalBrokerJson,
  parseBrokerRequest,
  parseBrokerResponse,
  type BrokerRequestEnvelope,
  type BrokerResponseEnvelope,
  type CredentialBindingMetadata,
} from "../src/credentials/protocol";

const ISSUED_AT = 1_800_000_000_000;

function healthRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    installationId: "inst-1",
    requestId: "req-1",
    idempotencyKey: "idem-1",
    operation: "broker.health",
    bindingId: null,
    bindingGeneration: null,
    turnId: null,
    capabilityId: "system.broker.health",
    policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
    fenceOwner: null,
    fenceGeneration: null,
    issuedAt: ISSUED_AT,
    deadlineAt: ISSUED_AT + 10_000,
    nonce: "nonce-1",
    ...overrides,
  };
}

function verifyRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...healthRequest(),
    operation: "vault.binding.verify",
    capabilityId: "telegram_agent_access_verify",
    bindingId: "bind-1",
    bindingGeneration: 3,
    turnId: "turn-1",
    fenceOwner: "executor",
    fenceGeneration: 7,
    ...overrides,
  };
}

function binding(overrides: Partial<CredentialBindingMetadata> = {}): CredentialBindingMetadata {
  return {
    bindingId: "bind-1",
    label: "Stripe live key",
    provider: "onepassword",
    state: "pending",
    generation: 3,
    capabilityIds: ["telegram_agent_access_verify"],
    risk: "high",
    mfaMode: "none",
    approvalMode: "none",
    lastVerifiedAt: null,
    ...overrides,
  };
}

function healthSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    brokerVersion: "0.1.0",
    adapter: "onepassword",
    adapterState: "ready",
    auditWritable: true,
    bindingCount: 1,
    topologyReceiptDigest: "a".repeat(64),
    topologyReceiptExpiresAt: ISSUED_AT + 86_400_000,
    ...overrides,
  };
}

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    installationId: "inst-1",
    requestId: "req-1",
    operation: "vault.binding.verify",
    outcome: "succeeded",
    result: "valid",
    failureClass: null,
    retryable: false,
    retryAfterMs: null,
    receiptId: "rcpt-1",
    health: null,
    bindings: [],
    completedAt: ISSUED_AT + 500,
    ...overrides,
  };
}

function healthResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return response({
    operation: "broker.health",
    result: "ready",
    health: healthSnapshot(),
    bindings: [binding()],
    ...overrides,
  });
}

describe("foundation policy", () => {
  it("keeps the foundation policy digest stable", () => {
    expect(FOUNDATION_BROKER_POLICY_DIGEST).toBe(
      "ec85ff22cd278f05806b37ae7d27df36c2e6154a811c02816fb0b87c83e4b4aa",
    );
  });

  it("derives the digest from the canonical policy rather than a stored literal", () => {
    const recomputed = createHash("sha256")
      .update(canonicalBrokerJson(FOUNDATION_BROKER_POLICY), "utf8")
      .digest("hex");
    expect(recomputed).toBe(FOUNDATION_BROKER_POLICY_DIGEST);
  });
});

describe("canonicalBrokerJson", () => {
  it("sorts object keys recursively and preserves array order", () => {
    expect(canonicalBrokerJson({ b: 1, a: { d: 2, c: [3, 1, 2] } }))
      .toBe('{"a":{"c":[3,1,2],"d":2},"b":1}');
  });

  it.each([
    ["undefined", undefined],
    ["a function", () => undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a bigint", 10n],
    ["a symbol", Symbol("x")],
  ])("refuses %s rather than emitting a lossy encoding", (_label, value) => {
    expect(() => canonicalBrokerJson({ value })).toThrow(TypeError);
  });

  it("encodes unicode without escaping it into a different string", () => {
    expect(JSON.parse(canonicalBrokerJson({ k: "é😀" })).k).toBe("é😀");
  });
});

describe("brokerRequestDigest", () => {
  it("is stable across key order and changes with any field", () => {
    const parsed = parseBrokerRequest(healthRequest());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const reordered = parseBrokerRequest({ nonce: "nonce-1", ...healthRequest() });
    expect(reordered.ok).toBe(true);
    if (!reordered.ok) return;
    expect(brokerRequestDigest(parsed.value)).toBe(brokerRequestDigest(reordered.value));

    const changed = parseBrokerRequest(healthRequest({ requestId: "req-2" }));
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(brokerRequestDigest(changed.value)).not.toBe(brokerRequestDigest(parsed.value));
  });

  it("returns a sha256 hex digest", () => {
    const parsed = parseBrokerRequest(healthRequest());
    if (!parsed.ok) throw new Error("fixture must parse");
    expect(brokerRequestDigest(parsed.value)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("parseBrokerRequest", () => {
  it("accepts a canonical health request with null binding, turn, and fence fields", () => {
    const parsed = parseBrokerRequest(healthRequest());
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.value.operation).toBe("broker.health");
    expect(parsed.value.bindingId).toBeNull();
    expect(parsed.value.fenceOwner).toBeNull();
  });

  it("accepts a canonical verify request carrying binding, turn, and fence", () => {
    const parsed = parseBrokerRequest(verifyRequest());
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.value.bindingGeneration).toBe(3);
    expect(parsed.value.schemaVersion).toBe(BROKER_SCHEMA_VERSION);
  });

  it.each([
    ["an unknown field", healthRequest({ extra: 1 }), "unknown_field"],
    ["a stale schema version", healthRequest({ schemaVersion: 2 }), "invalid_field"],
    ["an unknown operation", healthRequest({ operation: "vault.list" }), "invalid_field"],
    ["an unknown capability", healthRequest({ capabilityId: "vault.read" }), "invalid_field"],
    ["a malformed policy digest", healthRequest({ policyDigest: "nope" }), "invalid_field"],
    ["an id breaking the opaque pattern", healthRequest({ installationId: "bad id" }), "invalid_field"],
    ["an over-long id", healthRequest({ requestId: "r".repeat(129) }), "invalid_field"],
    ["an empty id", healthRequest({ nonce: "" }), "invalid_field"],
    ["a non-integer timestamp", healthRequest({ issuedAt: 1.5 }), "invalid_field"],
    ["a negative timestamp", healthRequest({ issuedAt: -1 }), "invalid_field"],
    ["a deadline before issue", healthRequest({ deadlineAt: ISSUED_AT - 1 }), "invalid_combination"],
    [
      "a deadline beyond the maximum",
      healthRequest({ deadlineAt: ISSUED_AT + BROKER_MAX_DEADLINE_MS + 1 }),
      "invalid_combination",
    ],
    ["health carrying a binding", healthRequest({ bindingId: "bind-1" }), "invalid_combination"],
    ["health carrying a fence", healthRequest({ fenceOwner: "executor" }), "invalid_combination"],
    ["verify missing its binding", verifyRequest({ bindingId: null }), "invalid_combination"],
    ["verify missing its fence", verifyRequest({ fenceGeneration: null }), "invalid_combination"],
    ["verify missing its turn", verifyRequest({ turnId: null }), "invalid_combination"],
    [
      "verify using the health capability",
      verifyRequest({ capabilityId: "system.broker.health" }),
      "invalid_combination",
    ],
    ["a non-object body", "nope", "invalid_json_value"],
    ["a null body", null, "invalid_json_value"],
    ["an array body", [], "invalid_json_value"],
  ])("rejects %s", (_label, body, code) => {
    expect(parseBrokerRequest(body)).toEqual({ ok: false, code });
  });

  it("never echoes the rejected value in its error", () => {
    // Spaces make this fail the opaque-id rule, so the parser must reject it —
    // and the rejection carries a code and nothing of what was sent.
    const parsed = parseBrokerRequest(healthRequest({ installationId: "super secret value" }));
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("super secret value");
    expect(parsed).toEqual({ ok: false, code: "invalid_field" });
  });
});

describe("parseBrokerResponse cross-field matrix", () => {
  it("accepts a health success carrying a snapshot, receipt, and complete bindings", () => {
    const parsed = parseBrokerResponse(healthResponse());
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.value.bindings).toHaveLength(1);
    expect(parsed.value.health?.bindingCount).toBe(1);
  });

  it("accepts a verify success with no health and no bindings", () => {
    expect(parseBrokerResponse(response())).toMatchObject({ ok: true });
  });

  it("accepts a deterministic invalid verification", () => {
    expect(parseBrokerResponse(response({
      outcome: "failed", result: "invalid", failureClass: "credential_invalid",
    }))).toMatchObject({ ok: true });
  });

  it.each([
    ["provider_rate_limited"],
    ["provider_unavailable"],
  ])("accepts a retryable %s response inside the retry bounds", (failureClass) => {
    expect(parseBrokerResponse(response({
      outcome: "failed", result: null, failureClass, retryable: true, retryAfterMs: 1_000,
    }))).toMatchObject({ ok: true });
  });

  it("accepts an audit persistence failure with no receipt", () => {
    expect(parseBrokerResponse(response({
      outcome: "failed", result: null, failureClass: "receipt_persistence_failed", receiptId: null,
    }))).toMatchObject({ ok: true });
  });

  it("accepts an active duplicate ambiguity without a receipt and a reconciled one with it", () => {
    const transient = response({
      outcome: "failed", result: null, failureClass: "result_ambiguous", receiptId: null,
    });
    const reconciled = response({
      outcome: "failed", result: null, failureClass: "result_ambiguous", receiptId: "rcpt-9",
    });
    expect(parseBrokerResponse(transient)).toMatchObject({ ok: true });
    expect(parseBrokerResponse(reconciled)).toMatchObject({ ok: true });
  });

  it.each([
    ["an unknown field", response({ extra: 1 }), "unknown_field"],
    ["an unknown failure class", response({ outcome: "failed", result: null, failureClass: "nope" }), "invalid_field"],
    ["a stale schema version", response({ schemaVersion: 2 }), "invalid_field"],
    ["success carrying a failure class", response({ failureClass: "request_rejected" }), "invalid_combination"],
    ["failure carrying no failure class", response({ outcome: "failed", result: null }), "invalid_combination"],
    ["a success with no receipt", response({ receiptId: null }), "invalid_combination"],
    ["health on a verify response", response({ health: healthSnapshot() }), "invalid_combination"],
    ["bindings on a verify response", response({ bindings: [binding()] }), "invalid_combination"],
    ["bindings on a failed health response", healthResponse({
      outcome: "failed", result: null, failureClass: "vault_auth_failed", health: null,
    }), "invalid_combination"],
    ["a health success missing its snapshot", healthResponse({ health: null }), "invalid_combination"],
    ["a verify result on a health response", healthResponse({ result: "valid" }), "invalid_combination"],
    ["a health result on a verify response", response({ result: "ready" }), "invalid_combination"],
    ["retryAfterMs on a non-retryable response", response({ retryAfterMs: 1_000 }), "invalid_combination"],
    ["a retryable response with no delay", response({
      outcome: "failed", result: null, failureClass: "provider_unavailable", retryable: true, retryAfterMs: null,
    }), "invalid_combination"],
    ["a retry delay below the minimum", response({
      outcome: "failed", result: null, failureClass: "provider_rate_limited", retryable: true, retryAfterMs: 999,
    }), "invalid_field"],
    ["a retry delay above the maximum", response({
      outcome: "failed", result: null, failureClass: "provider_rate_limited", retryable: true, retryAfterMs: 300_001,
    }), "invalid_field"],
    ["a retryable non-provider failure", response({
      outcome: "failed", result: null, failureClass: "request_rejected", retryable: true, retryAfterMs: 1_000,
    }), "invalid_combination"],
    ["a binding count disagreeing with the bindings", healthResponse({
      health: healthSnapshot({ bindingCount: 2 }),
    }), "invalid_combination"],
    ["an unknown binding state", healthResponse({
      bindings: [binding({ state: "approved" as CredentialBindingMetadata["state"] })],
    }), "invalid_field"],
    ["a duplicate binding id", healthResponse({
      bindings: [binding(), binding()], health: healthSnapshot({ bindingCount: 2 }),
    }), "invalid_field"],
    ["a non-object body", "nope", "invalid_json_value"],
  ])("rejects %s", (_label, body, code) => {
    expect(parseBrokerResponse(body)).toEqual({ ok: false, code });
  });

  it(`rejects binding ${BROKER_MAX_BINDINGS + 1} rather than silently truncating`, () => {
    const bindings = Array.from({ length: BROKER_MAX_BINDINGS + 1 }, (_value, index) =>
      binding({ bindingId: `bind-${index}` }));
    expect(parseBrokerResponse(healthResponse({
      bindings, health: healthSnapshot({ bindingCount: bindings.length }),
    }))).toEqual({ ok: false, code: "limit_exceeded" });
  });

  it(`accepts exactly ${BROKER_MAX_BINDINGS} bindings`, () => {
    const bindings = Array.from({ length: BROKER_MAX_BINDINGS }, (_value, index) =>
      binding({ bindingId: `bind-${index}` }));
    expect(parseBrokerResponse(healthResponse({
      bindings, health: healthSnapshot({ bindingCount: bindings.length }),
    }))).toMatchObject({ ok: true });
  });
});

describe("protocol surface", () => {
  it("exposes every stable failure class exactly once", () => {
    expect(new Set(BROKER_FAILURE_CLASSES).size).toBe(BROKER_FAILURE_CLASSES.length);
    expect(BROKER_FAILURE_CLASSES).toContain("result_ambiguous");
  });

  it("names no field that would carry a secret", () => {
    const forbidden = /\b(secret|password|token|credentialValue|externalReference)\b/;
    const request: BrokerRequestEnvelope = (parseBrokerRequest(verifyRequest()) as { ok: true; value: BrokerRequestEnvelope }).value;
    const parsedResponse: BrokerResponseEnvelope = (parseBrokerResponse(healthResponse()) as { ok: true; value: BrokerResponseEnvelope }).value;
    for (const key of [...Object.keys(request), ...Object.keys(parsedResponse), ...Object.keys(binding())]) {
      expect(key).not.toMatch(forbidden);
    }
  });
});
