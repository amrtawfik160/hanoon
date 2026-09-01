import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { CONTROLLER_CAPABILITIES } from "../src/controller/capability-policy";
import { ALL_CONTROLLER_TOOL_NAMES, CONTROLLER_TOOL_NAMES, registerControllerTools } from "../src/controller/tools";
import {
  FOUNDATION_BROKER_POLICY_DIGEST,
  type BrokerHealthSnapshot,
  type BrokerRequestEnvelope,
  type BrokerResponseEnvelope,
  type CredentialBindingMetadata,
} from "../src/credentials/protocol";
import type { CredentialBrokerConfigResult } from "../src/credentials/config";
import type { CredentialBrokerCallOutcome } from "../src/credentials/broker-client";
import { CredentialAccessService, type CredentialBrokerCaller } from "../src/credentials/service";
import { openStore } from "../src/storage/store";

const INSTALLATION_ID = "install_1";
const TOPOLOGY_DIGEST = "b".repeat(64);
const TOPOLOGY_EXPIRES_AT = 999_999_999;
const CANARY_CLIENT_KEY_PEM = "-----BEGIN CANARY KEY-----\ndo-not-leak-this-value\n-----END CANARY KEY-----";
const CANARY_ENDPOINT = "https://canary-broker.internal.example";

function isolatedConfig(): CredentialBrokerConfigResult {
  return {
    state: "isolated",
    value: {
      mode: "isolated",
      endpointOrigin: CANARY_ENDPOINT,
      installationId: INSTALLATION_ID,
      topologyReceiptDigest: TOPOLOGY_DIGEST,
      topologyReceiptExpiresAt: TOPOLOGY_EXPIRES_AT,
      clientCertificatePem: "canary-client-cert",
      clientKeyPem: CANARY_CLIENT_KEY_PEM,
      caCertificatePem: "canary-ca-cert",
    },
  };
}

function healthSnapshot(overrides: Partial<BrokerHealthSnapshot> = {}): BrokerHealthSnapshot {
  return Object.freeze({
    protocolVersion: 1,
    brokerVersion: "0.1.0",
    adapter: "onepassword",
    adapterState: "ready",
    auditWritable: true,
    bindingCount: 1,
    topologyReceiptDigest: TOPOLOGY_DIGEST,
    topologyReceiptExpiresAt: TOPOLOGY_EXPIRES_AT,
    ...overrides,
  }) as BrokerHealthSnapshot;
}

function bindingMetadata(overrides: Partial<CredentialBindingMetadata> = {}): CredentialBindingMetadata {
  return Object.freeze({
    bindingId: "binding_1",
    label: "Primary vault item",
    provider: "onepassword",
    state: "pending",
    generation: 1,
    capabilityIds: [],
    risk: "low",
    mfaMode: "none",
    approvalMode: "none",
    lastVerifiedAt: null,
    ...overrides,
  }) as CredentialBindingMetadata;
}

function healthResponse(
  envelope: BrokerRequestEnvelope,
  bindings: readonly CredentialBindingMetadata[] = [bindingMetadata()],
): BrokerResponseEnvelope {
  return Object.freeze({
    schemaVersion: 1,
    installationId: envelope.installationId,
    requestId: envelope.requestId,
    operation: "broker.health",
    outcome: "succeeded",
    result: "ready",
    failureClass: null,
    retryable: false,
    retryAfterMs: null,
    receiptId: `receipt_${envelope.requestId}`,
    health: healthSnapshot({ bindingCount: bindings.length }),
    bindings,
    completedAt: 5_000,
  }) as BrokerResponseEnvelope;
}

function verifyResponse(envelope: BrokerRequestEnvelope, overrides: Partial<BrokerResponseEnvelope> = {}): BrokerResponseEnvelope {
  return Object.freeze({
    schemaVersion: 1,
    installationId: envelope.installationId,
    requestId: envelope.requestId,
    operation: "vault.binding.verify",
    outcome: "succeeded",
    result: "valid",
    failureClass: null,
    retryable: false,
    retryAfterMs: null,
    receiptId: `receipt_${envelope.requestId}`,
    health: null,
    bindings: [],
    completedAt: 5_000,
    ...overrides,
  }) as BrokerResponseEnvelope;
}

function fakeClient(): CredentialBrokerCaller & { call: ReturnType<typeof vi.fn> } {
  return { call: vi.fn() };
}

const controllerToolContext = { threadId: "thr_controller", projectId: "proj_personal" };

let fixtureNumber = 0;

/**
 * A ready-to-verify installation: isolated config, a fresh mocked client,
 * and a real `CredentialAccessService` wired the same way Task 10 will wire
 * it in `plugin.ts` — but constructed locally here since this task must not
 * touch `plugin.ts`.
 */
function toolFixture(options: Readonly<{ origin?: "owner" | "system"; wireCredentialAccess?: boolean }> = {}) {
  fixtureNumber += 1;
  const { bb, harness } = createFakePluginHost({ pluginId: `telegram-credential-tools-${fixtureNumber}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.createPairingCode(hashSecret(`pair-credential-tools-${fixtureNumber}`), 1_000, 20_000);
  expect(store.pairOwnerWithCode(hashSecret(`pair-credential-tools-${fixtureNumber}`), "7", "7", 1_001))
    .toEqual({ ok: true });
  store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 40_000 + fixtureNumber,
    inputText: "Check the credential broker.",
    now: 2_000,
    origin: options.origin,
  });
  const lease = store.acquireExecutorLease("executor", 2_000, 30_000);
  if (!lease.acquired) throw new Error("missing executor lease");
  const fence = { ownerId: "executor", generation: lease.generation, now: 2_000 };
  const turn = store.claimNextControllerTurn(fence);
  if (!turn) throw new Error("missing controller turn");
  expect(store.markControllerSpawned({
    ...fence, turnId: turn.id, projectId: "proj_personal", hostId: "host_personal", threadId: "thr_controller",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, turnId: turn.id })).toBe(true);

  const client = fakeClient();
  let config: CredentialBrokerConfigResult = isolatedConfig();
  const credentialAccess = new CredentialAccessService({
    store, client,
    config: () => config,
    trustKernelReady: () => true,
    controllerPermissionMode: () => "auto",
    now: () => 2_000,
  });

  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 2_000,
    ...(options.wireCredentialAccess === false ? {} : { credentialAccess }),
  });

  return {
    bb, harness, store, client, turn,
    call: (name: string, args: Record<string, unknown>) => harness.behavior.callAgentTool(name, args, controllerToolContext),
    setConfig: (next: CredentialBrokerConfigResult) => { config = next; },
  };
}

function parseToolJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("credential tool did not return JSON text");
  return JSON.parse(value) as Record<string, unknown>;
}

describe("credential access capability manifest", () => {
  it("adds exactly three credential tools at their fixed manifest positions", () => {
    const fixture = toolFixture();
    const registered = fixture.harness.registrations.agentTools.map((tool) => tool.name);
    expect(registered).toEqual(ALL_CONTROLLER_TOOL_NAMES);
    expect(CONTROLLER_TOOL_NAMES).toHaveLength(35);
    expect(CONTROLLER_TOOL_NAMES.slice(25, 28)).toEqual([
      "telegram_agent_access_list",
      "telegram_agent_access_status",
      "telegram_agent_access_verify",
    ]);
  });

  it("matches the fixed contract table for all three descriptors", () => {
    expect(CONTROLLER_CAPABILITIES.telegram_agent_access_list).toMatchObject({
      effect_class: "read",
      risk_class: "low",
      credential_scope: { credential: "none", audience: "none" },
      egress: ["none"],
      reversibility: "not_applicable",
      idempotency: "read",
      approval: "none",
      allowed_roles: ["controller"],
      receipt_kind: "observation",
      result_limit: 8_000,
    });
    expect(CONTROLLER_CAPABILITIES.telegram_agent_access_status).toMatchObject({
      effect_class: "read",
      risk_class: "low",
      credential_scope: { credential: "credential_broker", audience: "hanoon-credential-broker:v1" },
      egress: ["credential_broker"],
      reversibility: "not_applicable",
      idempotency: "read",
      approval: "none",
      allowed_roles: ["controller"],
      receipt_kind: "observation",
      result_limit: 4_000,
    });
    expect(CONTROLLER_CAPABILITIES.telegram_agent_access_verify).toMatchObject({
      effect_class: "read",
      risk_class: "medium",
      credential_scope: { credential: "credential_broker", audience: "hanoon-credential-broker:v1" },
      egress: ["credential_broker"],
      reversibility: "not_applicable",
      idempotency: "read",
      approval: "none",
      allowed_roles: ["controller"],
      receipt_kind: "observation",
      result_limit: 2_000,
    });
  });

  it("keeps every parameter schema to exactly its declared strict shape", () => {
    const fixture = toolFixture();
    const byName = new Map(fixture.harness.registrations.agentTools.map((tool) => [tool.name, tool]));

    const list = byName.get("telegram_agent_access_list")!;
    expect(list.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(Object.keys((list.inputSchema as { properties: object }).properties).sort())
      .toEqual(["afterBindingId", "limit", "state"]);
    expect(list.parse({ limit: 999 }).ok).toBe(false);
    expect(list.parse({ endpoint: "https://evil.example" }).ok).toBe(false);

    const status = byName.get("telegram_agent_access_status")!;
    expect(Object.keys((status.inputSchema as { properties: object }).properties).sort()).toEqual(["bindingId"]);
    expect(status.parse({ bindingId: "binding_1", installationId: "x" }).ok).toBe(false);

    const verifyTool = byName.get("telegram_agent_access_verify")!;
    expect(Object.keys((verifyTool.inputSchema as { properties: object }).properties).sort()).toEqual(["bindingId"]);
    expect(verifyTool.parse({}).ok).toBe(false);
    for (const forbidden of ["reference", "provider", "token", "credential", "origin", "scope", "generation", "installationId", "fenceOwner", "approval", "operation"]) {
      expect(verifyTool.parse({ bindingId: "binding_1", [forbidden]: "x" }).ok).toBe(false);
    }
  });
});

describe("credential access tools fail closed when the service is not wired", () => {
  it("reports every tool as unavailable rather than throwing or fabricating success", async () => {
    const fixture = toolFixture({ wireCredentialAccess: false });

    const list = parseToolJson(await fixture.call("telegram_agent_access_list", {}));
    expect(list).toMatchObject({ available: false, bindings: [], truncated: false });

    const status = parseToolJson(await fixture.call("telegram_agent_access_status", {}));
    expect(status).toMatchObject({ readiness: { state: "disabled", checks: [] }, health: null, binding: null });

    const verifyResult = parseToolJson(await fixture.call("telegram_agent_access_verify", { bindingId: "binding_1" }));
    expect(verifyResult).toMatchObject({ outcome: "denied", reason: "disabled" });
    expect(fixture.client.call).not.toHaveBeenCalled();
  });
});

describe("credential access tools end to end", () => {
  it("lists bounded local binding metadata with evidence", async () => {
    const fixture = toolFixture();
    fixture.store.reconcileCredentialHealth({
      installationId: INSTALLATION_ID,
      health: healthSnapshot(),
      bindings: [bindingMetadata()],
      responseSha256: "c".repeat(64),
      now: 2_000,
    });

    const result = parseToolJson(await fixture.call("telegram_agent_access_list", {}));
    expect(result).toMatchObject({ available: true, truncated: false });
    expect(result.bindings).toEqual([bindingMetadata()]);
    expect(result._hanoonEvidence).toMatchObject({ outcome: "observed", proofKinds: ["health_snapshot"] });
  });

  it("reports live status by dispatching one diagnostic health call", async () => {
    const fixture = toolFixture();
    fixture.client.call.mockImplementation(async (envelope: BrokerRequestEnvelope) => ({
      outcome: "succeeded",
      response: healthResponse(envelope),
    } satisfies CredentialBrokerCallOutcome));

    const result = parseToolJson(await fixture.call("telegram_agent_access_status", {}));
    expect((result.readiness as { state: string }).state).toBe("ready");
    expect(result.health).toMatchObject({ adapterState: "ready" });
    expect(result._hanoonEvidence).toMatchObject({ outcome: "observed", proofKinds: ["health_snapshot"] });
  });

  it("verifies an owner-originated request and records credential-scoped evidence", async () => {
    const fixture = toolFixture({ origin: "owner" });
    fixture.store.reconcileCredentialHealth({
      installationId: INSTALLATION_ID,
      health: healthSnapshot(),
      bindings: [bindingMetadata({ state: "pending" })],
      responseSha256: "d".repeat(64),
      now: 2_000,
    });
    fixture.client.call.mockImplementation(async (envelope: BrokerRequestEnvelope) => ({
      outcome: "succeeded",
      response: verifyResponse(envelope, { result: "valid" }),
    } satisfies CredentialBrokerCallOutcome));

    const result = parseToolJson(await fixture.call("telegram_agent_access_verify", { bindingId: "binding_1" }));

    expect(result).toMatchObject({ outcome: "verified", result: "valid", state: "vault_verified" });
    const evidence = result._hanoonEvidence as { proofKinds: string[]; subjectRefs: string[] };
    expect(evidence.proofKinds).toEqual(["health_snapshot"]);
    expect(evidence.subjectRefs).toContain("credential-binding:binding_1");
    expect(evidence.subjectRefs.some((ref) => ref.startsWith("credential-receipt:"))).toBe(true);
    expect(fixture.store.getCredentialBinding(INSTALLATION_ID, "binding_1")).toMatchObject({ state: "vault_verified" });
  });

  it("denies verification from a system-originated turn before any broker dispatch", async () => {
    const fixture = toolFixture({ origin: "system" });
    fixture.store.reconcileCredentialHealth({
      installationId: INSTALLATION_ID,
      health: healthSnapshot(),
      bindings: [bindingMetadata()],
      responseSha256: "f".repeat(64),
      now: 2_000,
    });

    const result = parseToolJson(await fixture.call("telegram_agent_access_verify", { bindingId: "binding_1" }));

    expect(result).toMatchObject({ outcome: "denied", reason: "not_owner_origin" });
    expect(fixture.client.call).not.toHaveBeenCalled();
  });

  it("never lets a client certificate, key, endpoint, or raw broker content reach a tool result", async () => {
    const fixture = toolFixture({ origin: "owner" });
    fixture.store.reconcileCredentialHealth({
      installationId: INSTALLATION_ID,
      health: healthSnapshot(),
      bindings: [bindingMetadata({ state: "pending" })],
      responseSha256: "9".repeat(64),
      now: 2_000,
    });
    fixture.client.call.mockImplementation(async (envelope: BrokerRequestEnvelope) => ({
      outcome: "succeeded",
      response: envelope.operation === "broker.health" ? healthResponse(envelope) : verifyResponse(envelope, { result: "valid" }),
    } satisfies CredentialBrokerCallOutcome));

    const results = await Promise.all([
      fixture.call("telegram_agent_access_list", {}),
      fixture.call("telegram_agent_access_status", {}),
      fixture.call("telegram_agent_access_verify", { bindingId: "binding_1" }),
    ]);

    for (const raw of results) {
      const text = JSON.stringify(raw);
      expect(text).not.toContain(CANARY_CLIENT_KEY_PEM);
      expect(text).not.toContain("canary-client-cert");
      expect(text).not.toContain("canary-ca-cert");
      expect(text).not.toContain(CANARY_ENDPOINT);
      expect(text).not.toContain(TOPOLOGY_DIGEST);
    }
  });

  it("keeps every result comfortably within its declared byte bound", async () => {
    const fixture = toolFixture({ origin: "owner" });
    const manyBindings = Array.from({ length: 10 }, (_, index) => bindingMetadata({
      bindingId: `binding_${index}`,
      label: "L".repeat(120),
      capabilityIds: ["future_capability_one", "future_capability_two"],
    }));
    for (const binding of manyBindings) {
      fixture.store.reconcileCredentialHealth({
        installationId: INSTALLATION_ID,
        health: healthSnapshot({ bindingCount: 1 }),
        bindings: [binding],
        responseSha256: "1".repeat(64),
        now: 2_000,
      });
    }

    const list = await fixture.call("telegram_agent_access_list", { limit: 10 });
    expect(Buffer.byteLength(list as string, "utf8")).toBeLessThan(CONTROLLER_CAPABILITIES.telegram_agent_access_list.result_limit);
  });
});
