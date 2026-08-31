import * as onePassword from "@1password/sdk";

import { fingerprintResolvedVersion } from "./crypto.js";

type ResolvedSecret = Readonly<{
  outcome: "resolved";
  secret: string;
  vaultId: string;
  itemId: string;
}>;

export type OnePasswordPort = Readonly<{
  listVaults(): Promise<readonly { id: string }[]>;
  resolveOne(reference: string, signal?: AbortSignal): Promise<ResolvedSecret | { outcome: "invalid" }>;
}>;

type AdapterFailureClass = "vault_auth_failed" | "provider_rate_limited" | "provider_unavailable";

type AdapterFailure = Readonly<{
  outcome: "failed";
  failureClass: AdapterFailureClass;
  retryable: boolean;
  retryAfterMs: number | null;
}>;

const INVALID_REFERENCE_ERROR_TYPES = new Set([
  "fieldNotFound",
  "vaultNotFound",
  "itemNotFound",
  "tooManyVaults",
  "tooManyItems",
  "tooManyMatchingFields",
  "noMatchingSections",
  "parsing",
]);

export type VaultVerification =
  | { outcome: "valid"; versionHmac: string }
  | { outcome: "invalid" }
  | AdapterFailure;

export interface VaultAdapter {
  health(expectedVaultId: string): Promise<{ outcome: "ready" } | AdapterFailure>;
  verify(input: { reference: string; expectedVaultId: string; auditHmacKey: Uint8Array }): Promise<VaultVerification>;
}

export type ProviderCredentialResolution = Readonly<{
  outcome: "resolved";
  token: string;
}> | Readonly<{
  outcome: "failed";
  failureClass: "credential_invalid" | "credential_expired" | "provider_rate_limited" | "provider_unavailable";
  retryable: boolean;
  retryAfterMs: number | null;
}>;

export type ProviderCredentialResolver = Readonly<{
  resolve(reference: string, signal?: AbortSignal): Promise<ProviderCredentialResolution>;
}>;

export type OnePasswordAdapterOptions = Readonly<{
  serviceToken: string;
  port?: OnePasswordPort;
}>;

function failure(
  failureClass: AdapterFailureClass,
  retryable: boolean,
  retryAfterMs: number | null,
): AdapterFailure {
  return Object.freeze({ outcome: "failed", failureClass, retryable, retryAfterMs });
}

function mapProviderError(error: unknown): AdapterFailure {
  if (error instanceof onePassword.AuthExpiredError) {
    return failure("vault_auth_failed", false, null);
  }
  if (error instanceof onePassword.RateLimitExceededError) {
    return failure("provider_rate_limited", true, 60_000);
  }
  return failure("provider_unavailable", true, 30_000);
}

function parseReference(reference: string): { vaultId: string; itemId: string } | null {
  const match = /^op:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(reference);
  if (!match || match.some((part) => part.length === 0)) return null;
  return { vaultId: match[1], itemId: match[2] };
}

function hasExactVault(vaults: readonly { id: string }[], expectedVaultId: string): boolean {
  return vaults.length === 1 && vaults[0].id === expectedVaultId;
}

async function createSdkPort(serviceToken: string): Promise<OnePasswordPort> {
  const client = await onePassword.createClient({
    auth: serviceToken,
    integrationName: "Hanoon Credential Broker",
    integrationVersion: "0.1.0",
  });
  return {
    listVaults: async () => {
      const vaults = await client.vaults.list({ decryptDetails: false });
      return vaults.map((vault) => ({ id: vault.id }));
    },
    resolveOne: async (reference) => resolveSdkReference(client, reference),
  };
}

async function resolveSdkReference(
  client: Awaited<ReturnType<typeof onePassword.createClient>>,
  reference: string,
): Promise<ResolvedSecret | { outcome: "invalid" }> {
  const response = await client.secrets.resolveAll([reference]);
  const keys = Object.keys(response.individualResponses);
  if (keys.length !== 1 || keys[0] !== reference) return { outcome: "invalid" };
  const entry = response.individualResponses[reference];
  if (entry.content !== undefined) {
    if (typeof entry.content.secret !== "string" || typeof entry.content.vaultId !== "string" ||
        typeof entry.content.itemId !== "string") return { outcome: "invalid" };
    return {
      outcome: "resolved",
      secret: entry.content.secret,
      vaultId: entry.content.vaultId,
      itemId: entry.content.itemId,
    };
  }
  if (entry.error && isInvalidReferenceError(entry.error.type)) return { outcome: "invalid" };
  throw new Error("unsupported_onepassword_response");
}

async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) throw new Error("credential_resolution_aborted");
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error("credential_resolution_aborted"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function isInvalidReferenceError(errorType: string): boolean {
  return INVALID_REFERENCE_ERROR_TYPES.has(errorType);
}

async function checkHealth(port: OnePasswordPort, expectedVaultId: string): Promise<{ outcome: "ready" } | AdapterFailure> {
  try {
    const vaults = await port.listVaults();
    return hasExactVault(vaults, expectedVaultId)
      ? { outcome: "ready" }
      : failure("vault_auth_failed", false, null);
  } catch (error) {
    return mapProviderError(error);
  }
}

async function verifyReference(
  port: OnePasswordPort,
  reference: string,
  expectedVaultId: string,
  auditHmacKey: Uint8Array,
): Promise<VaultVerification> {
  const parsed = parseReference(reference);
  if (!parsed || parsed.vaultId !== expectedVaultId) return { outcome: "invalid" };

  let resolved: ResolvedSecret | { outcome: "invalid" };
  try {
    resolved = await port.resolveOne(reference);
  } catch (error) {
    return mapProviderError(error);
  }
  if (resolved.outcome !== "resolved" || typeof resolved.secret !== "string" ||
      resolved.vaultId !== parsed.vaultId || resolved.itemId !== parsed.itemId) {
    return { outcome: "invalid" };
  }

  let secretBytes: Buffer | undefined;
  let resolvedSecret: string | undefined;
  try {
    resolvedSecret = resolved.secret;
    secretBytes = Buffer.from(resolvedSecret, "utf8");
    if (secretBytes.length < 1 || secretBytes.length > 65_536) return { outcome: "invalid" };
    return { outcome: "valid", versionHmac: fingerprintResolvedVersion(secretBytes, auditHmacKey) };
  } finally {
    secretBytes?.fill(0);
    resolvedSecret = undefined;
  }
}

async function resolveProviderCredential(
  port: OnePasswordPort,
  reference: string,
  signal?: AbortSignal,
): Promise<ProviderCredentialResolution> {
  try {
    const resolved = await abortable(port.resolveOne(reference, signal), signal);
    if (resolved.outcome !== "resolved" || resolved.secret.length === 0) {
      return { outcome: "failed", failureClass: "credential_invalid", retryable: false, retryAfterMs: null };
    }
    return { outcome: "resolved", token: resolved.secret };
  } catch (error) {
    const mapped = mapProviderError(error);
    if (mapped.failureClass === "vault_auth_failed") {
      return { outcome: "failed", failureClass: "credential_invalid", retryable: false, retryAfterMs: null };
    }
    if (mapped.failureClass === "provider_rate_limited" || mapped.failureClass === "provider_unavailable") {
      return {
        outcome: "failed",
        failureClass: mapped.failureClass,
        retryable: mapped.retryable,
        retryAfterMs: mapped.retryAfterMs,
      };
    }
    return { outcome: "failed", failureClass: "credential_invalid", retryable: false, retryAfterMs: null };
  }
}

export async function createOnePasswordAdapter(
  options: OnePasswordAdapterOptions,
): Promise<VaultAdapter & { resolveCredential: ProviderCredentialResolver["resolve"] }> {
  let port = options.port;
  let initializationFailure: AdapterFailure | null = null;
  if (!port) {
    try {
      port = await createSdkPort(options.serviceToken);
    } catch (error) {
      initializationFailure = mapProviderError(error);
    }
  }

  return {
    health: async (expectedVaultId) => initializationFailure ?? checkHealth(port!, expectedVaultId),
    verify: async ({ reference, expectedVaultId, auditHmacKey }) =>
      initializationFailure ?? verifyReference(port!, reference, expectedVaultId, auditHmacKey),
    resolveCredential: async (reference, signal) => initializationFailure
      ? {
          outcome: "failed",
          failureClass: initializationFailure.failureClass === "vault_auth_failed"
            ? "credential_invalid"
            : initializationFailure.failureClass,
          retryable: initializationFailure.retryable,
          retryAfterMs: initializationFailure.retryAfterMs,
        }
      : resolveProviderCredential(port!, reference, signal),
  };
}
