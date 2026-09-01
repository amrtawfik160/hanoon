import { AuthExpiredError, RateLimitExceededError } from "@1password/sdk";
import { describe, expect, it, vi } from "vitest";
import { createOnePasswordAdapter, type VaultAdapter } from "../broker/src/onepassword-adapter";
import { fakeOnePasswordPort, type FakeResolveResult } from "./support/credential-broker-fixtures";

const EXPECTED_VAULT_ID = "vault-canary-id";
const ITEM_ID = "item-canary-id";
const FIELD_ID = "field-canary-id";
const REFERENCE = `op://${EXPECTED_VAULT_ID}/${ITEM_ID}/${FIELD_ID}`;
const SECRET = "resolved-secret-canary-value-7f31a2";
const SDK_MESSAGE = "provider diagnostic canary must not escape";
const AUDIT_KEY = new Uint8Array(32).fill(0x44);

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

  it("stops waiting on an aborted credential resolution and exposes lifecycle cleanup", async () => {
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
});
