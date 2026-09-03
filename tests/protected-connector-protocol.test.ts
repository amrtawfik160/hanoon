import { describe, expect, it } from "vitest";
import {
  PROTECTED_CONNECTOR_MAX_REQUEST_BYTES,
  PROTECTED_CONNECTOR_MAX_RESPONSE_BYTES,
  parseCredentialProtocolRequest,
  parseCredentialProtocolResponse,
  parseProtectedConnectorRequest,
  parseProtectedConnectorRequestJson,
  parseProtectedConnectorResponse,
  parseProtectedConnectorResponseJson,
  protectedConnectorCapabilityFor,
  type ProtectedConnectorOperation,
  type ProtectedConnectorRequestEnvelope,
  type ProtectedConnectorResponseEnvelope,
} from "../src/credentials/connector-protocol";
import {
  PROTECTED_CONNECTOR_POLICY_DIGEST,
  VERCEL_BROWSER_ORIGIN,
  VERCEL_PROJECT_IDENTITY_JOURNEY_ID,
  parseProtectedConnectorBindingProjection,
  parseProtectedConnectorTarget,
  type ProtectedConnectorBindingProjection,
  type ProtectedConnectorTarget,
} from "../src/credentials/connector-policy";
import {
  FOUNDATION_BROKER_POLICY_DIGEST,
  parseBrokerRequest,
  parseBrokerResponse,
  type BrokerRequestEnvelope,
  type BrokerResponseEnvelope,
} from "../src/credentials/protocol";

const NOW = 1_800_000_000_000;

function request(operation: ProtectedConnectorOperation): ProtectedConnectorRequestEnvelope {
  return {
    schemaVersion: 2,
    operation,
    installationId: "installation-1",
    requestId: `request-${operation}`,
    idempotencyKey: `idempotency-${operation}`,
    nonce: `nonce-${operation}`,
    bindingId: `binding-${operation}`,
    bindingGeneration: 3,
    taskId: "task-1",
    projectId: "project-1",
    capabilityId: protectedConnectorCapabilityFor(operation),
    policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
    fenceOwner: "executor-1",
    fenceGeneration: 4,
    issuedAt: NOW,
    deadlineAt: NOW + 30_000,
  } as ProtectedConnectorRequestEnvelope;
}

function success(operation: ProtectedConnectorOperation): ProtectedConnectorResponseEnvelope {
  const base = {
    schemaVersion: 2,
    installationId: "installation-1",
    requestId: `request-${operation}`,
    operation,
    outcome: "succeeded",
    failureClass: null,
    retryable: false,
    retryAfterMs: null,
    receiptId: `receipt-${operation}`,
    completedAt: NOW + 1_000,
  } as const;
  if (operation === "convex.project.inspect.v1") return {
    ...base,
    operation,
    result: {
      projectId: "convex-project-id",
      projectSlug: "hanoon",
      teamId: "convex-team-id",
      teamSlug: "hanoon-team",
      status: "active",
      connectorVersion: "convex-1",
      observedAt: NOW + 900,
    },
  };
  if (operation === "vercel.project.inspect.v1") return {
    ...base,
    operation,
    result: {
      projectId: "vercel-project-id",
      projectName: "hanoon",
      teamId: "vercel-team-id",
      framework: "nextjs",
      status: "ready",
      connectorVersion: "vercel-1",
      observedAt: NOW + 900,
    },
  };
  return {
    ...base,
    operation,
    result: {
      profileId: "profile-1",
      journeyId: VERCEL_PROJECT_IDENTITY_JOURNEY_ID,
      journeyVersion: 1,
      origin: VERCEL_BROWSER_ORIGIN,
      teamSlug: "hanoon-team",
      projectName: "hanoon",
      sessionStatus: "authenticated",
      observedAt: NOW + 900,
    },
  };
}

function v1Request(): BrokerRequestEnvelope {
  return {
    schemaVersion: 1,
    installationId: "installation-1",
    requestId: "request-v1",
    idempotencyKey: "idempotency-v1",
    operation: "broker.health",
    bindingId: null,
    bindingGeneration: null,
    turnId: null,
    capabilityId: "system.broker.health",
    policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
    fenceOwner: null,
    fenceGeneration: null,
    issuedAt: NOW,
    deadlineAt: NOW + 30_000,
    nonce: "nonce-v1",
  };
}

function v1Response(): BrokerResponseEnvelope {
  return {
    schemaVersion: 1,
    installationId: "installation-1",
    requestId: "request-v1",
    operation: "vault.binding.verify",
    outcome: "succeeded",
    result: "valid",
    failureClass: null,
    retryable: false,
    retryAfterMs: null,
    receiptId: "receipt-v1",
    health: null,
    bindings: [],
    completedAt: NOW,
  };
}

describe("protected connector request protocol", () => {
  it.each([
    "convex.project.inspect.v1",
    "vercel.project.inspect.v1",
    "browser.vercel_project.inspect.v1",
  ] as const)("accepts the exact %s discriminant", (operation) => {
    const envelope = request(operation);
    expect(parseProtectedConnectorRequest(envelope)).toEqual({ ok: true, value: envelope });
    expect(parseProtectedConnectorRequestJson(JSON.stringify(envelope))).toMatchObject({ ok: true });
  });

  it.each([
    "prompt",
    "url",
    "command",
    "javascript",
    "credential",
    "cookie",
    "providerPayload",
    "target",
  ])("rejects forbidden or arbitrary request field %s", (field) => {
    expect(parseProtectedConnectorRequest({ ...request("convex.project.inspect.v1"), [field]: "canary" }))
      .toEqual({ ok: false, code: "unknown_field" });
  });

  it("rejects unknown operations, capability mismatches, loose objects, and caller-selected targets", () => {
    expect(parseProtectedConnectorRequest({ ...request("convex.project.inspect.v1"), operation: "http.get.v1" }))
      .toMatchObject({ ok: false });
    expect(parseProtectedConnectorRequest({
      ...request("convex.project.inspect.v1"),
      capabilityId: "telegram_agent_vercel_project_inspect",
    })).toEqual({ ok: false, code: "invalid_combination" });
    expect(parseProtectedConnectorRequest({})).toMatchObject({ ok: false });
    expect(parseProtectedConnectorRequest("run this"))
      .toEqual({ ok: false, code: "invalid_json_value" });
  });

  it("enforces the raw request byte bound before parsing JSON", () => {
    const oversized = `{"padding":"${"x".repeat(PROTECTED_CONNECTOR_MAX_REQUEST_BYTES)}"}`;
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(PROTECTED_CONNECTOR_MAX_REQUEST_BYTES);
    expect(parseProtectedConnectorRequestJson(oversized)).toEqual({ ok: false, code: "limit_exceeded" });
    expect(parseProtectedConnectorRequest(request("convex.project.inspect.v1"), PROTECTED_CONNECTOR_MAX_REQUEST_BYTES + 1))
      .toEqual({ ok: false, code: "limit_exceeded" });
  });
});

describe("protected connector response protocol", () => {
  it.each([
    "convex.project.inspect.v1",
    "vercel.project.inspect.v1",
    "browser.vercel_project.inspect.v1",
  ] as const)("accepts only the bounded %s identity proof", (operation) => {
    const envelope = success(operation);
    expect(parseProtectedConnectorResponse(envelope)).toEqual({ ok: true, value: envelope });
    expect(parseProtectedConnectorResponseJson(JSON.stringify(envelope))).toMatchObject({ ok: true });
  });

  it.each(["rawBody", "headers", "providerError", "dom", "screenshot", "pageText", "cookies", "storage"])(
    "rejects forbidden public response field %s",
    (field) => {
      expect(parseProtectedConnectorResponse({ ...success("vercel.project.inspect.v1"), [field]: "canary" }))
        .toEqual({ ok: false, code: "unknown_field" });
    },
  );

  it("rejects invented Vercel team slugs from the authoritative result shape", () => {
    expect(parseProtectedConnectorResponse({
      ...success("vercel.project.inspect.v1"),
      result: { ...success("vercel.project.inspect.v1").result!, teamSlug: "invented-slug" },
    })).toEqual({ ok: false, code: "unknown_field" });
  });

  it("rejects unreceipted success, operation/result confusion, and nested provider fields", () => {
    expect(parseProtectedConnectorResponse({ ...success("convex.project.inspect.v1"), receiptId: null }))
      .toMatchObject({ ok: false });
    expect(parseProtectedConnectorResponse({
      ...success("convex.project.inspect.v1"),
      result: success("vercel.project.inspect.v1").result,
    })).toMatchObject({ ok: false });
    const convex = success("convex.project.inspect.v1");
    expect(parseProtectedConnectorResponse({
      ...convex,
      result: { ...convex.result!, token: "canary" },
    })).toEqual({ ok: false, code: "unknown_field" });
    expect(parseProtectedConnectorResponse({
      ...convex,
      result: { ...convex.result!, observedAt: convex.completedAt + 1 },
    })).toEqual({ ok: false, code: "invalid_combination" });
  });

  it("validates stable failure retry rules and the response byte bound", () => {
    const failure = {
      schemaVersion: 2,
      installationId: "installation-1",
      requestId: "request-1",
      operation: "vercel.project.inspect.v1",
      outcome: "failed",
      result: null,
      failureClass: "provider_rate_limited",
      retryable: true,
      retryAfterMs: 30_000,
      receiptId: "receipt-1",
      completedAt: NOW,
    } as const;
    expect(parseProtectedConnectorResponse(failure)).toMatchObject({ ok: true });
    expect(parseProtectedConnectorResponse({ ...failure, retryable: false, retryAfterMs: null }))
      .toEqual({ ok: false, code: "invalid_combination" });
    expect(parseProtectedConnectorResponse({
      ...failure,
      failureClass: "receipt_persistence_failed",
      retryable: false,
      retryAfterMs: null,
    })).toEqual({ ok: false, code: "invalid_combination" });
    const oversized = `{"padding":"${"x".repeat(PROTECTED_CONNECTOR_MAX_RESPONSE_BYTES)}"}`;
    expect(parseProtectedConnectorResponseJson(oversized)).toEqual({ ok: false, code: "limit_exceeded" });
  });
});

describe("binding projections and broker-private targets", () => {
  function projection(operation: ProtectedConnectorOperation): ProtectedConnectorBindingProjection {
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
      state: browser ? "pending" : "vault_verified",
      generation: 1,
      verifiedAt: null,
      expiresAt: null,
    };
  }

  it.each([
    "convex.project.inspect.v1",
    "vercel.project.inspect.v1",
    "browser.vercel_project.inspect.v1",
  ] as const)("accepts the exact secret-free %s projection", (operation) => {
    expect(parseProtectedConnectorBindingProjection(projection(operation))).toMatchObject({ ok: true });
  });

  it("rejects projection broadening, unknown fields, and invalid operation/provider combinations", () => {
    const convex = projection("convex.project.inspect.v1");
    expect(parseProtectedConnectorBindingProjection({ ...convex, externalReference: "op://canary" }))
      .toEqual({ ok: false, code: "unknown_field" });
    expect(parseProtectedConnectorBindingProjection({ ...convex, authorityProvider: "vercel" }))
      .toEqual({ ok: false, code: "invalid_combination" });
    expect(parseProtectedConnectorBindingProjection({ ...convex, origins: ["https://evil.example"] }))
      .toEqual({ ok: false, code: "invalid_combination" });
    expect(parseProtectedConnectorBindingProjection({
      ...convex,
      scopes: Array.from({ length: 9 }, (_, index) => `scope-${index}`),
    })).toEqual({ ok: false, code: "invalid_field" });
  });

  it("accepts only exact enrolled target shapes and the fixed browser journey", () => {
    const targets: readonly ProtectedConnectorTarget[] = [
      { operation: "convex.project.inspect.v1", teamIdOrSlug: "team-1", projectSlug: "hanoon" },
      { operation: "vercel.project.inspect.v1", teamId: "team-1", projectIdOrName: "hanoon" },
      {
        operation: "browser.vercel_project.inspect.v1",
        hostId: "host-1",
        profileId: "profile-1",
        origin: VERCEL_BROWSER_ORIGIN,
        journeyId: VERCEL_PROJECT_IDENTITY_JOURNEY_ID,
        journeyVersion: 1,
        teamSlug: "team-1",
        projectName: "hanoon",
      },
    ];
    for (const target of targets) expect(parseProtectedConnectorTarget(target)).toMatchObject({ ok: true });
    expect(parseProtectedConnectorTarget({ ...targets[2], origin: "https://evil.example" })).toMatchObject({ ok: false });
    expect(parseProtectedConnectorTarget({ ...targets[2], journeyId: "model-supplied" })).toMatchObject({ ok: false });
    expect(parseProtectedConnectorTarget({ ...targets[0], url: "https://api.convex.dev" }))
      .toEqual({ ok: false, code: "unknown_field" });
    expect(parseProtectedConnectorTarget({ ...targets[0], teamIdOrSlug: "https://evil.example" }))
      .toEqual({ ok: false, code: "invalid_field" });
    expect(parseProtectedConnectorTarget({ ...targets[1], projectIdOrName: "https://evil.example" }))
      .toEqual({ ok: false, code: "invalid_field" });
    expect(parseProtectedConnectorTarget({ ...targets[2], projectName: "https://evil.example" }))
      .toEqual({ ok: false, code: "invalid_field" });
  });

  it("rejects URL-shaped public identity values in every operation result", () => {
    expect(parseProtectedConnectorResponse({
      ...success("convex.project.inspect.v1"),
      result: { ...success("convex.project.inspect.v1").result!, teamSlug: "https://evil.example" },
    })).toEqual({ ok: false, code: "invalid_field" });
    expect(parseProtectedConnectorResponse({
      ...success("vercel.project.inspect.v1"),
      result: { ...success("vercel.project.inspect.v1").result!, projectName: "https://evil.example" },
    })).toEqual({ ok: false, code: "invalid_field" });
    expect(parseProtectedConnectorResponse({
      ...success("browser.vercel_project.inspect.v1"),
      result: { ...success("browser.vercel_project.inspect.v1").result!, teamSlug: "https://evil.example" },
    })).toEqual({ ok: false, code: "invalid_field" });
  });

  it.each([
    "https:/evil.example",
    "HTTPS://evil.example",
    "https:\\evil.example",
    "\\\\evil.example",
    "/evil.example",
    "https:evil.example",
    "prefix:https://evil.example",
  ])("rejects URL normalization variant %s in every caller-controlled target field", (value) => {
    const targets: readonly ProtectedConnectorTarget[] = [
      { operation: "convex.project.inspect.v1", teamIdOrSlug: "team-1", projectSlug: "hanoon" },
      { operation: "vercel.project.inspect.v1", teamId: "team-1", projectIdOrName: "hanoon" },
      {
        operation: "browser.vercel_project.inspect.v1",
        hostId: "host-1",
        profileId: "profile-1",
        origin: VERCEL_BROWSER_ORIGIN,
        journeyId: VERCEL_PROJECT_IDENTITY_JOURNEY_ID,
        journeyVersion: 1,
        teamSlug: "team-1",
        projectName: "hanoon",
      },
    ];
    expect(parseProtectedConnectorTarget({ ...targets[0], teamIdOrSlug: value })).toMatchObject({ ok: false });
    expect(parseProtectedConnectorTarget({ ...targets[0], projectSlug: value })).toMatchObject({ ok: false });
    expect(parseProtectedConnectorTarget({ ...targets[1], teamId: value })).toMatchObject({ ok: false });
    expect(parseProtectedConnectorTarget({ ...targets[1], projectIdOrName: value })).toMatchObject({ ok: false });
    expect(parseProtectedConnectorTarget({ ...targets[2], teamSlug: value })).toMatchObject({ ok: false });
    expect(parseProtectedConnectorTarget({ ...targets[2], projectName: value })).toMatchObject({ ok: false });
  });

  it.each([
    "https:/evil.example",
    "HTTPS://evil.example",
    "https:\\evil.example",
    "\\\\evil.example",
    "/evil.example",
    "https:evil.example",
    "prefix:https://evil.example",
  ])("rejects URL normalization variant %s in every public identity field", (value) => {
    expect(parseProtectedConnectorResponse({
      ...success("convex.project.inspect.v1"),
      result: { ...success("convex.project.inspect.v1").result!, projectId: value },
    })).toMatchObject({ ok: false });
    expect(parseProtectedConnectorResponse({
      ...success("convex.project.inspect.v1"),
      result: { ...success("convex.project.inspect.v1").result!, projectSlug: value },
    })).toMatchObject({ ok: false });
    expect(parseProtectedConnectorResponse({
      ...success("convex.project.inspect.v1"),
      result: { ...success("convex.project.inspect.v1").result!, teamId: value },
    })).toMatchObject({ ok: false });
    expect(parseProtectedConnectorResponse({
      ...success("convex.project.inspect.v1"),
      result: { ...success("convex.project.inspect.v1").result!, teamSlug: value },
    })).toMatchObject({ ok: false });
    expect(parseProtectedConnectorResponse({
      ...success("vercel.project.inspect.v1"),
      result: { ...success("vercel.project.inspect.v1").result!, projectId: value },
    })).toMatchObject({ ok: false });
    expect(parseProtectedConnectorResponse({
      ...success("vercel.project.inspect.v1"),
      result: { ...success("vercel.project.inspect.v1").result!, projectName: value },
    })).toMatchObject({ ok: false });
    expect(parseProtectedConnectorResponse({
      ...success("vercel.project.inspect.v1"),
      result: { ...success("vercel.project.inspect.v1").result!, teamId: value },
    })).toMatchObject({ ok: false });
    expect(parseProtectedConnectorResponse({
      ...success("vercel.project.inspect.v1"),
      result: { ...success("vercel.project.inspect.v1").result!, teamSlug: value },
    })).toMatchObject({ ok: false });
    expect(parseProtectedConnectorResponse({
      ...success("browser.vercel_project.inspect.v1"),
      result: { ...success("browser.vercel_project.inspect.v1").result!, profileId: value },
    })).toMatchObject({ ok: false });
    expect(parseProtectedConnectorResponse({
      ...success("browser.vercel_project.inspect.v1"),
      result: { ...success("browser.vercel_project.inspect.v1").result!, teamSlug: value },
    })).toMatchObject({ ok: false });
    expect(parseProtectedConnectorResponse({
      ...success("browser.vercel_project.inspect.v1"),
      result: { ...success("browser.vercel_project.inspect.v1").result!, projectName: value },
    })).toMatchObject({ ok: false });
  });
});

describe("protocol generation compatibility", () => {
  it("preserves the exact shipped schema-version-1 parsers in the combined union", () => {
    expect(parseCredentialProtocolRequest(v1Request())).toEqual(parseBrokerRequest(v1Request()));
    expect(parseCredentialProtocolResponse(v1Response())).toEqual(parseBrokerResponse(v1Response()));
  });

  it("rejects unknown generations rather than treating them as either contract", () => {
    expect(parseCredentialProtocolRequest({ ...v1Request(), schemaVersion: 3 })).toMatchObject({ ok: false });
    expect(parseCredentialProtocolResponse({ ...v1Response(), schemaVersion: 3 })).toMatchObject({ ok: false });
  });
});
