import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";

import {
  encodeAdminResponse,
  isAdminMutationOperation,
  knownAdminOperation,
  parseAdminRequest,
  type AdminFailureCode,
  type AdminMutationOperation,
  type AdminOperation,
  type AdminRequest,
  type AdminResponse,
} from "./admin-protocol.js";
import {
  BROKER_MAX_TOPOLOGY_RECEIPT_AGE_MS,
  FOUNDATION_BROKER_POLICY_DIGEST,
  OPAQUE_ID_PATTERN,
} from "../../src/credentials/protocol.js";
import type { VaultAdapter } from "./onepassword-adapter.js";
import type {
  BrokerInstallationRevocation,
  BrokerRejectedAdminMutation,
  BrokerStore,
} from "./store.js";

const ADMIN_SOCKET_MODE = 0o600;
const ADMIN_CONNECTION_TIMEOUT_MS = 10_000;
const REFERENCE_PATTERN = /^op:\/\/([A-Za-z0-9]{26})\/([A-Za-z0-9]{26})\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;

export type AdminServerDependencies = Readonly<{
  socketPath: string;
  store: BrokerStore;
  adapter: VaultAdapter;
  clock?: () => number;
  brokerVersion: string;
}>;

export type RunningAdminServer = Readonly<{
  server: Server;
  address(): ReturnType<Server["address"]>;
  start(): Promise<void>;
  close(): Promise<void>;
}>;

class AdminOperationError extends Error {
  constructor(readonly code: AdminFailureCode) {
    super(code);
    this.name = "AdminOperationError";
  }
}

function nowFrom(dependencies: AdminServerDependencies): number {
  return dependencies.clock?.() ?? Date.now();
}

function failure(operation: AdminOperation | null, code: AdminFailureCode): AdminResponse {
  return { ok: false, operation, code };
}

function assertAttestationWindow(expiresAt: number, now: number): void {
  if (expiresAt <= now) throw new AdminOperationError("attestation_expired");
  if (expiresAt - now > BROKER_MAX_TOPOLOGY_RECEIPT_AGE_MS) {
    throw new AdminOperationError("attestation_too_long");
  }
}

function certificateFingerprint(certificatePem: string): string {
  try {
    const certificate = new X509Certificate(certificatePem);
    if (!certificate.raw || certificate.raw.length === 0) throw new Error();
    return createHash("sha256").update(certificate.raw).digest("hex");
  } catch {
    throw new AdminOperationError("invalid_certificate");
  }
}

function parseReferenceVaultId(reference: string): string {
  const match = REFERENCE_PATTERN.exec(reference);
  if (!match) throw new AdminOperationError("invalid_reference");
  return match[1];
}

function mapStoreError(error: unknown): AdminOperationError {
  const storeCode = error instanceof Error ? error.message : "";
  const codeByStoreError: Record<string, AdminFailureCode> = {
    broker_installation_missing: "installation_missing",
    broker_installation_unavailable: "installation_unavailable",
    broker_binding_missing: "binding_missing",
    binding_limit: "binding_limit",
    invalid_binding: "invalid_reference",
  };
  return new AdminOperationError(codeByStoreError[storeCode] ?? "store_failure");
}

function adapterState(result: Awaited<ReturnType<VaultAdapter["health"]>>): "ready" | "degraded" | "unavailable" {
  if (result.outcome === "ready") return "ready";
  return result.failureClass === "provider_unavailable" ? "unavailable" : "degraded";
}

function handleInstallationAdd(
  request: Extract<AdminRequest, { operation: "installation.add" }>,
  dependencies: AdminServerDependencies,
  now: number,
): AdminResponse {
  assertAttestationWindow(request.topologyReceiptExpiresAt, now);
  const installationId = randomUUID();
  dependencies.store.addInstallation({
    installationId,
    clientCertificateFingerprint: certificateFingerprint(request.clientCertificatePem),
    policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
    topologyReceiptDigest: request.topologyReceiptDigest,
    topologyReceiptExpiresAt: request.topologyReceiptExpiresAt,
    expectedVaultId: request.expectedVaultId,
    now,
  });
  return { ok: true, operation: "installation.add", installationId, state: "active" };
}

function handleInstallationAttest(
  request: Extract<AdminRequest, { operation: "installation.attest" }>,
  dependencies: AdminServerDependencies,
  now: number,
): AdminResponse {
  const installation = dependencies.store.getInstallation(request.installationId);
  if (!installation) throw new AdminOperationError("installation_missing");
  if (installation.state !== "active") throw new AdminOperationError("installation_unavailable");
  assertAttestationWindow(request.topologyReceiptExpiresAt, now);
  dependencies.store.attestInstallation({
    installationId: request.installationId,
    topologyReceiptDigest: request.topologyReceiptDigest,
    topologyReceiptExpiresAt: request.topologyReceiptExpiresAt,
    now,
  });
  return { ok: true, operation: "installation.attest", installationId: request.installationId, state: "active" };
}

function handleInstallationRevoke(
  request: Extract<AdminRequest, { operation: "installation.revoke" }>,
  dependencies: AdminServerDependencies,
  now: number,
): AdminResponse {
  const input: BrokerInstallationRevocation = { installationId: request.installationId, now };
  const installation = dependencies.store.revokeInstallation(input);
  return { ok: true, operation: "installation.revoke", installationId: installation.installationId, state: "revoked" };
}

function handleBindingAdd(
  request: Extract<AdminRequest, { operation: "binding.add" }>,
  dependencies: AdminServerDependencies,
  now: number,
): AdminResponse {
  const installation = dependencies.store.getInstallation(request.installationId);
  if (!installation) throw new AdminOperationError("installation_missing");
  if (installation.state !== "active") throw new AdminOperationError("installation_unavailable");
  const referenceVaultId = parseReferenceVaultId(request.reference);
  const expectedVaultId = dependencies.store.decryptExpectedVaultId(request.installationId);
  if (referenceVaultId !== expectedVaultId) throw new AdminOperationError("vault_mismatch");
  try {
    const binding = dependencies.store.addBinding({
      installationId: request.installationId,
      reference: request.reference,
      label: request.label,
      capabilityIds: request.capabilityIds,
      risk: request.risk,
      mfaMode: request.mfaMode,
      approvalMode: request.approvalMode,
      now,
    });
    return {
      ok: true,
      operation: "binding.add",
      installationId: request.installationId,
      bindingId: binding.bindingId,
      state: "pending",
      generation: 1,
    };
  } catch (error) {
    throw mapStoreError(error);
  }
}

function handleBindingRevoke(
  request: Extract<AdminRequest, { operation: "binding.revoke" }>,
  dependencies: AdminServerDependencies,
  now: number,
): AdminResponse {
  const binding = dependencies.store.getBinding(request.installationId, request.bindingId);
  if (!binding) throw new AdminOperationError("binding_missing");
  if (["revoked", "compromised"].includes(binding.state)) throw new AdminOperationError("binding_inactive");
  try {
    const revoked = dependencies.store.revokeBinding({ ...request, now });
    return {
      ok: true,
      operation: "binding.revoke",
      installationId: request.installationId,
      bindingId: revoked.bindingId,
      state: "revoked",
      generation: revoked.generation,
    };
  } catch (error) {
    throw mapStoreError(error);
  }
}

async function handleInstallationDoctor(
  request: Extract<AdminRequest, { operation: "installation.doctor" }>,
  dependencies: AdminServerDependencies,
  now: number,
): Promise<AdminResponse> {
  const installation = dependencies.store.getInstallation(request.installationId);
  if (!installation) throw new AdminOperationError("installation_missing");
  let health: Awaited<ReturnType<VaultAdapter["health"]>>;
  try {
    health = await dependencies.adapter.health(dependencies.store.decryptExpectedVaultId(request.installationId));
  } catch {
    return {
      ok: true,
      operation: "installation.doctor",
      installationId: installation.installationId,
      state: installation.state,
      bindingCount: dependencies.store.listBindingMetadata(request.installationId).length,
      adapterState: "unavailable",
      topologyReceiptState: now < installation.topologyReceiptExpiresAt ? "valid" : "expired",
    };
  }
  return {
    ok: true,
    operation: "installation.doctor",
    installationId: installation.installationId,
    state: installation.state,
    bindingCount: dependencies.store.listBindingMetadata(request.installationId).length,
    adapterState: adapterState(health),
    topologyReceiptState: now < installation.topologyReceiptExpiresAt ? "valid" : "expired",
  };
}

function handleBrokerStatus(dependencies: AdminServerDependencies): AdminResponse {
  return {
    ok: true,
    operation: "broker.status",
    schemaVersion: 1,
    brokerVersion: dependencies.brokerVersion,
    installationCount: dependencies.store.getInstallationCount(),
    bindingCount: dependencies.store.getBindingCount(),
  };
}

async function dispatchAdminRequest(request: AdminRequest, dependencies: AdminServerDependencies): Promise<AdminResponse> {
  const now = nowFrom(dependencies);
  switch (request.operation) {
    case "installation.add": return handleInstallationAdd(request, dependencies, now);
    case "installation.attest": return handleInstallationAttest(request, dependencies, now);
    case "installation.revoke": return handleInstallationRevoke(request, dependencies, now);
    case "binding.add": return handleBindingAdd(request, dependencies, now);
    case "binding.revoke": return handleBindingRevoke(request, dependencies, now);
    case "installation.doctor": return handleInstallationDoctor(request, dependencies, now);
    case "broker.status": return handleBrokerStatus(dependencies);
  }
}

function safeOpaqueId(input: unknown, fallback: string): string {
  return typeof input === "string" && OPAQUE_ID_PATTERN.test(input) ? input : fallback;
}

function rejectionContext(input: unknown): Readonly<{
  operation: AdminMutationOperation;
  installationId: string;
  bindingId?: string;
}> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (!isAdminMutationOperation(raw.operation)) return null;
  const context: { operation: AdminMutationOperation; installationId: string; bindingId?: string } = {
    operation: raw.operation,
    installationId: safeOpaqueId(raw.installationId, "admin-rejected"),
  };
  if (raw.bindingId !== undefined) context.bindingId = safeOpaqueId(raw.bindingId, "admin-rejected-binding");
  return context;
}

function recordRejectedMutation(input: unknown, dependencies: AdminServerDependencies): boolean {
  const context = rejectionContext(input);
  if (!context) return true;
  const rejected: BrokerRejectedAdminMutation = { ...context, now: nowFrom(dependencies) };
  try {
    dependencies.store.recordRejectedAdminMutation(rejected);
    return true;
  } catch {
    return false;
  }
}

function responseCode(error: unknown): AdminFailureCode {
  return error instanceof AdminOperationError ? error.code : mapStoreError(error).code;
}

async function processAdminLine(line: Buffer, dependencies: AdminServerDependencies): Promise<AdminResponse> {
  let input: unknown;
  try {
    input = JSON.parse(line.toString("utf8"));
  } catch {
    return failure(null, "invalid_request");
  }
  const parsed = parseAdminRequest(input);
  if (!parsed.ok) {
    const operation = typeof input === "object" && input !== null && "operation" in input
      ? knownAdminOperation((input as Record<string, unknown>).operation)
      : null;
    if (!recordRejectedMutation(input, dependencies)) return failure(operation, "store_failure");
    return failure(operation, "invalid_request");
  }
  try {
    return await dispatchAdminRequest(parsed.value, dependencies);
  } catch (error) {
    if (!recordRejectedMutation(parsed.value, dependencies)) return failure(parsed.value.operation, "store_failure");
    return failure(parsed.value.operation, responseCode(error));
  }
}

function writeAdminResponse(socket: Socket, response: AdminResponse): void {
  try {
    socket.end(encodeAdminResponse(response));
  } catch {
    socket.end(encodeAdminResponse(failure(null, "store_failure")));
  }
}

function handleAdminConnection(socket: Socket, dependencies: AdminServerDependencies): void {
  let buffer = Buffer.alloc(0);
  let finished = false;
  const reject = (response: AdminResponse): void => {
    if (finished) return;
    finished = true;
    writeAdminResponse(socket, response);
  };
  socket.setTimeout(ADMIN_CONNECTION_TIMEOUT_MS, () => socket.destroy());
  socket.on("data", (chunk: Buffer) => {
    if (finished) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 16_384) {
      reject(failure(null, "line_too_large"));
      return;
    }
    const newline = buffer.indexOf(0x0a);
    if (newline < 0) return;
    const lineEnd = newline > 0 && buffer[newline - 1] === 0x0d ? newline - 1 : newline;
    const line = buffer.subarray(0, lineEnd);
    if (buffer.subarray(newline + 1).length > 0) {
      reject(failure(null, "invalid_request"));
      return;
    }
    finished = true;
    void processAdminLine(line, dependencies).then((response) => writeAdminResponse(socket, response));
  });
  socket.on("end", () => {
    if (!finished) reject(failure(null, "invalid_request"));
  });
  socket.on("error", () => undefined);
}

function assertSocketPath(socketPath: string): void {
  if (!isAbsolute(socketPath) || socketPath.includes("\0")) throw new Error("invalid_admin_socket");
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o750 });
  try {
    const stat = lstatSync(socketPath);
    if (stat.isSymbolicLink() || !stat.isSocket()) throw new Error("invalid_admin_socket");
    unlinkSync(socketPath);
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_admin_socket") throw error;
  }
}

function listenOnSocket(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      try {
        chmodSync(socketPath, ADMIN_SOCKET_MODE);
        const stat = lstatSync(socketPath);
        if (!stat.isSocket() || stat.isSymbolicLink()) throw new Error("invalid_admin_socket");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function createAdminServer(dependencies: AdminServerDependencies): RunningAdminServer {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handleAdminConnection(socket, dependencies);
  });
  let started = false;
  return {
    server,
    address: () => server.address(),
    start: async () => {
      if (started) return;
      assertSocketPath(dependencies.socketPath);
      await listenOnSocket(server, dependencies.socketPath);
      started = true;
    },
    close: async () => {
      if (!server.listening) return;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
