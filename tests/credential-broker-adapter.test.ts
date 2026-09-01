import * as onePassword from "@1password/sdk";
import { AuthExpiredError, RateLimitExceededError } from "@1password/sdk";
import { describe, expect, it, vi } from "vitest";
import { ProtectedConnectorAuthorityService } from "../broker/src/connector-authority-service";
import { BrokerProtectedConnectorStore } from "../broker/src/connector-store";
import { createProtectedConnectorExecutor } from "../broker/src/provider-connectors";
import { BrokerStore } from "../broker/src/store";
import { createOnePasswordAdapter, type VaultAdapter } from "../broker/src/onepassword-adapter";
import {
  PROTECTED_CONNECTOR_POLICY_DIGEST,
  type ProtectedConnectorBindingProjection,
  type ProtectedConnectorTarget,
} from "../src/credentials/connector-policy";
import type { ProtectedConnectorRequestEnvelope } from "../src/credentials/connector-protocol";
import { fakeOnePasswordPort, temporaryBrokerDatabase, type FakeResolveResult } from "./support/credential-broker-fixtures";
import { certificateFingerprint, createMtlsFixture } from "./support/mtls-fixtures";

vi.mock("@1password/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@1password/sdk")>();
  return { ...actual, createClient: vi.fn() };
});

const EXPECTED_VAULT_ID = "vault-canary-id";
const ITEM_ID = "item-canary-id";
const FIELD_ID = "field-canary-id";
const REFERENCE = `op://${EXPECTED_VAULT_ID}/${ITEM_ID}/${FIELD_ID}`;
const SECRET = "resolved-secret-canary-value-7f31a2";
const SDK_MESSAGE = "provider diagnostic canary must not escape";
const AUDIT_KEY = new Uint8Array(32).fill(0x44);
const DEADLINE_INSTALLATION_ID = "installation-sdk-deadline";
const DEADLINE_PROJECT_ID = "project-sdk-deadline";
const deadlineProjection: ProtectedConnectorBindingProjection = {
  schemaVersion: 2,
  installationId: DEADLINE_INSTALLATION_ID,
  bindingId: "binding-sdk-deadline",
  operation: "convex.project.inspect.v1",
  bindingKind: "workload_identity",
  authorityProvider: "convex",
  secretProvider: "provider_native",
  principalLabel: "SDK deadline test workload",
  capabilityIds: ["telegram_agent_convex_project_inspect"],
  audiences: ["api.convex.dev"],
  origins: [],
  scopes: ["project:read"],
  riskClass: "low",
  mfaMode: "workload_identity",
  approvalMode: "standing_policy",
  state: "vault_verified",
  generation: 1,
  verifiedAt: null,
  expiresAt: null,
};
const deadlineTarget: ProtectedConnectorTarget = {
  operation: "convex.project.inspect.v1",
  teamIdOrSlug: "team-sdk-deadline",
  projectSlug: "hanoon",
};

async function adapterFor(
  vaults: readonly { id: string }[],
  resolve: (reference: string) => Promise<FakeResolveResult>,
): Promise<VaultAdapter> {
  return createOnePasswordAdapter({
    serviceToken: "service-token-is-test-only",
    port: fakeOnePasswordPort(vaults, resolve),
  });
}

function resolved(secret = SECRET, overrides: Partial<Extract<FakeResolveResult, { outcome: "resolved" }>> = {}): FakeResolveResult {
  return {
    outcome: "resolved",
    secret,
    vaultId: EXPECTED_VAULT_ID,
    itemId: ITEM_ID,
    ...overrides,
  };
}

function assertNoCanary(output: unknown): void {
  const serialized = typeof output === "string" ? output : JSON.stringify(output);
  for (const forbidden of [
    REFERENCE,
    SECRET,
    String(SECRET.length),
    SECRET.slice(0, 8),
    SECRET.slice(-8),
    SDK_MESSAGE,
    EXPECTED_VAULT_ID,
    ITEM_ID,
  ]) expect(serialized).not.toContain(forbidden);
}

describe("isolated onepassword adapter", () => {
  it("reports ready only when exactly the expected vault is visible", async () => {
    const adapter = await adapterFor([{ id: EXPECTED_VAULT_ID }], async () => resolved());
    await expect(adapter.health(EXPECTED_VAULT_ID)).resolves.toEqual({ outcome: "ready" });

    for (const vaults of [[], [{ id: "other-vault" }], [{ id: EXPECTED_VAULT_ID }, { id: "other-vault" }]]) {
      const unhealthy = await (await adapterFor(vaults, async () => resolved())).health(EXPECTED_VAULT_ID);
      expect(unhealthy).toMatchObject({ outcome: "failed" });
      assertNoCanary(unhealthy);
    }
  });

  it("verifies one exact reference and returns only a keyed fingerprint", async () => {
    const adapter = await adapterFor([{ id: EXPECTED_VAULT_ID }], async (reference) => {
      expect(reference).toBe(REFERENCE);
      return resolved();
    });
    const result = await adapter.verify({
      reference: REFERENCE,
      expectedVaultId: EXPECTED_VAULT_ID,
      auditHmacKey: AUDIT_KEY,
    });
    expect(result).toMatchObject({ outcome: "valid" });
    expect(result).not.toHaveProperty("secret");
    if (result.outcome === "valid") expect(result.versionHmac).toMatch(/^[a-f0-9]{64}$/);
    assertNoCanary(result);
  });

  it.each([
    ["missing vault", `op://${EXPECTED_VAULT_ID}/missing-item/${FIELD_ID}`],
    ["missing field", `op://${EXPECTED_VAULT_ID}/${ITEM_ID}/missing-field`],
    ["ambiguous reference", "op://vault/item/field/extra"],
    ["wrong vault", `op://outside-vault/${ITEM_ID}/${FIELD_ID}`],
  ])("returns invalid for a %s", async (_label, reference) => {
    const adapter = await adapterFor([{ id: EXPECTED_VAULT_ID }], async () => ({ outcome: "invalid" }));
    const result = await adapter.verify({ reference, expectedVaultId: EXPECTED_VAULT_ID, auditHmacKey: AUDIT_KEY });
    expect(result).toEqual({ outcome: "invalid" });
    assertNoCanary(result);
  });

  it.each([
    ["an empty value", ""],
    ["a value over the byte bound", "x".repeat(65_537)],
  ])("returns invalid for %s without exposing value metadata", async (_label, secret) => {
    const adapter = await adapterFor([{ id: EXPECTED_VAULT_ID }], async () => resolved(secret));
    const result = await adapter.verify({ reference: REFERENCE, expectedVaultId: EXPECTED_VAULT_ID, auditHmacKey: AUDIT_KEY });
    expect(result).toEqual({ outcome: "invalid" });
    assertNoCanary(result);
  });

  it("counts UTF-8 bytes rather than JavaScript code units", async () => {
    const validUnicode = "😀".repeat(16_384);
    const validAdapter = await adapterFor([{ id: EXPECTED_VAULT_ID }], async () => resolved(validUnicode));
    await expect(validAdapter.verify({ reference: REFERENCE, expectedVaultId: EXPECTED_VAULT_ID, auditHmacKey: AUDIT_KEY }))
      .resolves.toMatchObject({ outcome: "valid" });

    const invalidUnicode = "😀".repeat(16_385);
    const invalidAdapter = await adapterFor([{ id: EXPECTED_VAULT_ID }], async () => resolved(invalidUnicode));
    await expect(invalidAdapter.verify({ reference: REFERENCE, expectedVaultId: EXPECTED_VAULT_ID, auditHmacKey: AUDIT_KEY }))
      .resolves.toEqual({ outcome: "invalid" });
  });

  it.each([
    ["rate limit", new RateLimitExceededError(SDK_MESSAGE), { failureClass: "provider_rate_limited", retryable: true, retryAfterMs: 60_000 }],
    ["expired authentication", new AuthExpiredError(SDK_MESSAGE), { failureClass: "vault_auth_failed", retryable: false, retryAfterMs: null }],
    ["generic outage", new Error(SDK_MESSAGE), { failureClass: "provider_unavailable", retryable: true, retryAfterMs: 30_000 }],
  ])("maps %s to a stable failure", async (_label, error, expected) => {
    const adapter = await adapterFor([{ id: EXPECTED_VAULT_ID }], async () => { throw error; });
    const result = await adapter.verify({ reference: REFERENCE, expectedVaultId: EXPECTED_VAULT_ID, auditHmacKey: AUDIT_KEY });
    expect(result).toEqual({ outcome: "failed", ...expected });
    assertNoCanary(result);
  });

  it("does not invoke verification during health and disposes its canary result", async () => {
    let verifyCalls = 0;
    const adapter = await createOnePasswordAdapter({
      serviceToken: "service-token-is-test-only",
      port: {
        listVaults: async () => [{ id: EXPECTED_VAULT_ID }],
        resolveOne: async () => {
          verifyCalls += 1;
          return resolved();
        },
      },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await adapter.health(EXPECTED_VAULT_ID);
      expect(verifyCalls).toBe(0);
      const result = await adapter.verify({ reference: REFERENCE, expectedVaultId: EXPECTED_VAULT_ID, auditHmacKey: AUDIT_KEY });
      expect(result).not.toHaveProperty("secret");
      expect(consoleError).not.toHaveBeenCalled();
      assertNoCanary(result);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("stops waiting on an aborted injected credential port and exposes lifecycle cleanup", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    let closeCalls = 0;
    const adapter = await createOnePasswordAdapter({
      serviceToken: "service-token-is-test-only",
      port: {
        listVaults: async () => [{ id: EXPECTED_VAULT_ID }],
        resolveOne: async (_reference, signal) => {
          receivedSignal = signal;
          return new Promise<never>(() => undefined);
        },
        close: () => { closeCalls += 1; },
      },
    });

    const pending = adapter.resolveCredential(REFERENCE, controller.signal);
    await vi.waitFor(() => expect(receivedSignal).toBe(controller.signal));
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      outcome: "failed",
      failureClass: "provider_unavailable",
      retryable: true,
    });
    await adapter.close();
    expect(closeCalls).toBe(1);
  });

  it("fails closed before starting installed SDK credential resolution", async () => {
    const resolveAll = vi.fn(() => new Promise<never>(() => undefined));
    vi.mocked(onePassword.createClient).mockResolvedValue({
      vaults: { list: vi.fn() },
      secrets: { resolveAll },
    } as unknown as Awaited<ReturnType<typeof onePassword.createClient>>);
    try {
      const adapter = await createOnePasswordAdapter({ serviceToken: "service-token-is-test-only" });
      const deadline = new AbortController();
      const persistedDeadline = setTimeout(() => deadline.abort(), 1);
      const result = await adapter.resolveCredential(REFERENCE, deadline.signal);
      clearTimeout(persistedDeadline);

      expect(result).toEqual({
        outcome: "failed",
        failureClass: "provider_unavailable",
        retryable: true,
        retryAfterMs: 30_000,
      });
      expect(resolveAll).not.toHaveBeenCalled();
      await adapter.close();
    } finally {
      vi.mocked(onePassword.createClient).mockReset();
    }
  });

  it("does not leave an in-flight installed SDK effect after the persisted deadline", async () => {
    const now = 1_800_000_000_000;
    const fixture = createMtlsFixture();
    const brokerDatabase = temporaryBrokerDatabase();
    const dataKey = new Uint8Array(32).fill(0x11);
    const broker = new BrokerStore(brokerDatabase.db, { dataKey, auditKey: new Uint8Array(32).fill(0x22), clock: () => now });
    const certificate = certificateFingerprint(fixture.clientCertificatePem);
    broker.addInstallation({
      installationId: DEADLINE_INSTALLATION_ID,
      clientCertificateFingerprint: certificate,
      policyDigest: "b".repeat(64),
      topologyReceiptDigest: "c".repeat(64),
      topologyReceiptExpiresAt: now + 60_000,
      expectedVaultId: EXPECTED_VAULT_ID,
      now,
    });
    const connectors = new BrokerProtectedConnectorStore(brokerDatabase.db, { dataKey, clock: () => now });
    connectors.enrollProtectedBinding({
      projectId: DEADLINE_PROJECT_ID,
      policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
      enabledOperations: ["convex.project.inspect.v1"],
      projection: deadlineProjection,
      target: deadlineTarget,
      credentialReference: REFERENCE,
      now,
    });
    expect(broker.attestExecutorFence({
      installationId: DEADLINE_INSTALLATION_ID,
      taskId: "task-sdk-deadline",
      projectId: DEADLINE_PROJECT_ID,
      fenceOwner: "executor-sdk-deadline",
      fenceGeneration: 1,
      expiresAt: now + 60_000,
      now,
    })).toBe(true);

    let inFlight = 0;
    const resolveAll = vi.fn(() => {
      inFlight += 1;
      return new Promise<never>(() => undefined);
    });
    vi.mocked(onePassword.createClient).mockResolvedValue({
      vaults: { list: vi.fn() },
      secrets: { resolveAll },
    } as unknown as Awaited<ReturnType<typeof onePassword.createClient>>);
    try {
      const adapter = await createOnePasswordAdapter({ serviceToken: "service-token-is-test-only" });
      const getConvexProject = vi.fn();
      const authority = new ProtectedConnectorAuthorityService({
        foundationStore: broker,
        connectorStore: connectors,
        executor: createProtectedConnectorExecutor({
          http: {
            getConvexProject,
            getVercelProject: vi.fn(),
          },
          credentials: { resolve: adapter.resolveCredential },
          clock: () => now,
        }),
        authority: {
          topologyReady: () => true,
          auditWritable: () => true,
          fenceCurrent: (input) => broker.isExecutorFenceCurrent({ ...input, now }),
        },
        clock: () => now,
      });
      const request = {
        schemaVersion: 2,
        operation: "convex.project.inspect.v1",
        installationId: DEADLINE_INSTALLATION_ID,
        requestId: "request-sdk-deadline",
        idempotencyKey: "idempotency-sdk-deadline",
        nonce: "nonce-sdk-deadline",
        bindingId: deadlineProjection.bindingId,
        bindingGeneration: 1,
        taskId: "task-sdk-deadline",
        projectId: DEADLINE_PROJECT_ID,
        capabilityId: "telegram_agent_convex_project_inspect",
        policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
        fenceOwner: "executor-sdk-deadline",
        fenceGeneration: 1,
        issuedAt: now,
        deadlineAt: now + 1,
      } satisfies ProtectedConnectorRequestEnvelope;

      const response = await authority.execute({ certificateFingerprint: certificate, request, now });
      expect(response).toMatchObject({ outcome: "failed", failureClass: "provider_unavailable" });
      expect(brokerDatabase.db.prepare(
        "SELECT state FROM broker_connector_requests WHERE request_id = ?",
      ).get(request.requestId)).toEqual({ state: "completed" });
      expect(resolveAll).not.toHaveBeenCalled();
      expect(getConvexProject).not.toHaveBeenCalled();
      expect(inFlight).toBe(0);
      await adapter.close();
    } finally {
      vi.mocked(onePassword.createClient).mockReset();
      fixture.cleanup();
      brokerDatabase.close();
    }
  });
});
