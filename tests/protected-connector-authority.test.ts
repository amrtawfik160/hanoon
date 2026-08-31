import { describe, expect, it, vi } from "vitest";
import {
  PROTECTED_CONNECTOR_POLICY_DIGEST,
  VERCEL_BROWSER_ORIGIN,
  VERCEL_PROJECT_IDENTITY_JOURNEY_ID,
  type ProtectedConnectorBindingProjection,
  type ProtectedConnectorTarget,
} from "../src/credentials/connector-policy";
import {
  protectedConnectorCapabilityFor,
  type ProtectedConnectorOperation,
  type ProtectedConnectorRequestEnvelope,
} from "../src/credentials/connector-protocol";
import { FOUNDATION_BROKER_POLICY_DIGEST } from "../src/credentials/protocol";
import {
  ProtectedConnectorAuthorityService,
  type ProtectedConnectorAuthorityPort,
  type ProtectedConnectorExecutor,
} from "../broker/src/connector-authority-service";
import { BrokerProtectedConnectorStore } from "../broker/src/connector-store";
import { BrokerStore } from "../broker/src/store";
import { temporaryBrokerDatabase } from "./support/credential-broker-fixtures";

const NOW = 1_800_000_000_000;
const DATA_KEY = new Uint8Array(32).fill(0x11);
const AUDIT_KEY = new Uint8Array(32).fill(0x22);
const CERTIFICATE = "a".repeat(64);
const OTHER_CERTIFICATE = "b".repeat(64);

function projection(
  operation: ProtectedConnectorOperation,
  overrides: Partial<ProtectedConnectorBindingProjection> = {},
): ProtectedConnectorBindingProjection {
  const browser = operation === "browser.vercel_project.inspect.v1";
  return {
    schemaVersion: 2,
    installationId: "installation-1",
    bindingId: `binding-${operation}`,
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
    ...overrides,
  } as ProtectedConnectorBindingProjection;
}

function target(operation: ProtectedConnectorOperation): ProtectedConnectorTarget {
  if (operation === "convex.project.inspect.v1") {
    return { operation, teamIdOrSlug: "convex-team", projectSlug: "hanoon" };
  }
  if (operation === "vercel.project.inspect.v1") {
    return { operation, teamId: "vercel-team-id", projectIdOrName: "hanoon" };
  }
  return {
    operation,
    hostId: "host-1",
    profileId: "profile-1",
    origin: VERCEL_BROWSER_ORIGIN,
    journeyId: VERCEL_PROJECT_IDENTITY_JOURNEY_ID,
    journeyVersion: 1,
    teamSlug: "vercel-team",
    projectName: "hanoon",
  };
}

function request(
  operation: ProtectedConnectorOperation,
  overrides: Partial<ProtectedConnectorRequestEnvelope> = {},
): ProtectedConnectorRequestEnvelope {
  return {
    schemaVersion: 2,
    installationId: "installation-1",
    requestId: `request-${operation}`,
    idempotencyKey: `idempotency-${operation}`,
    nonce: `nonce-${operation}`,
    operation,
    bindingId: `binding-${operation}`,
    bindingGeneration: 1,
    taskId: "task-1",
    projectId: "project-1",
    capabilityId: protectedConnectorCapabilityFor(operation),
    policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
    fenceOwner: "executor-1",
    fenceGeneration: 1,
    issuedAt: NOW - 1_000,
    deadlineAt: NOW + 29_000,
    ...overrides,
  } as ProtectedConnectorRequestEnvelope;
}

type Harness = Readonly<{
  fixture: ReturnType<typeof temporaryBrokerDatabase>;
  foundationStore: BrokerStore;
  connectorStore: BrokerProtectedConnectorStore;
  executor: ProtectedConnectorExecutor;
  calls: { convex: number; vercel: number; browser: number };
  authorityState: { topologyReady: boolean; auditWritable: boolean; fenceCurrent: boolean };
  authority: ProtectedConnectorAuthorityPort;
  service: ProtectedConnectorAuthorityService;
  close(): void;
}>;

function createHarness(): Harness {
  const fixture = temporaryBrokerDatabase();
  const foundationStore = new BrokerStore(fixture.db, { dataKey: DATA_KEY, auditKey: AUDIT_KEY, clock: () => NOW });
  foundationStore.addInstallation({
    installationId: "installation-1",
    clientCertificateFingerprint: CERTIFICATE,
    policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
    topologyReceiptDigest: "c".repeat(64),
    topologyReceiptExpiresAt: NOW + 100_000,
    expectedVaultId: "vault-1",
  });
  const connectorStore = new BrokerProtectedConnectorStore(fixture.db, { dataKey: DATA_KEY, clock: () => NOW });
  connectorStore.setPolicy({
    installationId: "installation-1",
    projectId: "project-1",
    policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
    enabledOperations: [
      "convex.project.inspect.v1",
      "vercel.project.inspect.v1",
      "browser.vercel_project.inspect.v1",
    ],
    now: NOW,
  });
  for (const operation of [
    "convex.project.inspect.v1",
    "vercel.project.inspect.v1",
    "browser.vercel_project.inspect.v1",
  ] as const) {
    connectorStore.enrollBinding({
      projection: projection(operation),
      target: target(operation),
      credentialReference: operation === "browser.vercel_project.inspect.v1" ? null : `credential-reference-${operation}`,
      now: NOW,
    });
  }

  const calls = { convex: 0, vercel: 0, browser: 0 };
  const executor: ProtectedConnectorExecutor = {
    inspectConvex: vi.fn(async () => {
      calls.convex += 1;
      return {
        outcome: "succeeded",
        connectorVersion: "convex-1",
        identity: {
          projectId: "convex-project-id",
          projectSlug: "hanoon",
          teamId: "convex-team-id",
          teamSlug: "convex-team",
          status: "active",
          connectorVersion: "convex-1",
          observedAt: NOW,
        },
      } as const;
    }),
    inspectVercel: vi.fn(async () => {
      calls.vercel += 1;
      return {
        outcome: "succeeded",
        connectorVersion: "vercel-1",
        identity: {
          projectId: "vercel-project-id",
          projectName: "hanoon",
          teamId: "vercel-team-id",
          teamSlug: "vercel-team",
          framework: "nextjs",
          status: "ready",
          connectorVersion: "vercel-1",
          observedAt: NOW,
        },
      } as const;
    }),
    inspectBrowserVercel: vi.fn(async () => {
      calls.browser += 1;
      return {
        outcome: "succeeded",
        connectorVersion: "journey-1",
        identity: {
          profileId: "profile-1",
          journeyId: VERCEL_PROJECT_IDENTITY_JOURNEY_ID,
          journeyVersion: 1,
          origin: VERCEL_BROWSER_ORIGIN,
          teamSlug: "vercel-team",
          projectName: "hanoon",
          sessionStatus: "authenticated",
          observedAt: NOW,
        },
      } as const;
    }),
  };
  const authorityState = { topologyReady: true, auditWritable: true, fenceCurrent: true };
  const authority: ProtectedConnectorAuthorityPort = {
    topologyReady: () => authorityState.topologyReady,
    auditWritable: () => authorityState.auditWritable,
    fenceCurrent: () => authorityState.fenceCurrent,
  };
  const service = new ProtectedConnectorAuthorityService({
    foundationStore,
    connectorStore,
    executor,
    authority,
    clock: () => NOW,
  });
  return { fixture, foundationStore, connectorStore, executor, calls, authorityState, authority, service, close: fixture.close };
}

function totalCalls(harness: Harness): number {
  return harness.calls.convex + harness.calls.vercel + harness.calls.browser;
}

describe("protected connector success and exact targets", () => {
  it("does not enroll an active binding before an identity receipt exists", () => {
    const harness = createHarness();
    expect(() => harness.connectorStore.enrollBinding({
      projection: projection("convex.project.inspect.v1", { state: "active" }),
      target: target("convex.project.inspect.v1"),
      credentialReference: "provider-token",
    })).toThrow(/active.*receipt|receipt.*active|enroll/i);
    harness.close();
  });
  it.each([
    "convex.project.inspect.v1",
    "vercel.project.inspect.v1",
    "browser.vercel_project.inspect.v1",
  ] as const)("commits a receipt before releasing %s success", async (operation) => {
    const harness = createHarness();
    try {
      const response = await harness.service.execute({ certificateFingerprint: CERTIFICATE, request: request(operation), now: NOW });
      expect(response).toMatchObject({ outcome: "succeeded", operation });
      expect(response.receiptId).not.toBeNull();
      const receiptCount = harness.fixture.db.prepare(
        "SELECT count(*) AS count FROM broker_connector_receipts WHERE receipt_id = ?",
      ).get(response.receiptId) as { count: number };
      expect(receiptCount.count).toBe(1);
      expect(harness.connectorStore.getBinding("installation-1", `binding-${operation}`)?.projection.state).toBe("active");
    } finally {
      harness.close();
    }
  });

  it("turns an observation for the wrong enrolled target into destination_denied", async () => {
    const harness = createHarness();
    try {
      vi.mocked(harness.executor.inspectVercel).mockResolvedValueOnce({
        outcome: "succeeded",
        connectorVersion: "vercel-1",
        identity: {
          projectId: "wrong-project-id",
          projectName: "wrong-project",
          teamId: "vercel-team-id",
          teamSlug: "vercel-team",
          framework: "nextjs",
          status: "ready",
          connectorVersion: "vercel-1",
          observedAt: NOW,
        },
      });
      const response = await harness.service.execute({
        certificateFingerprint: CERTIFICATE,
        request: request("vercel.project.inspect.v1"),
        now: NOW,
      });
      expect(response).toMatchObject({ outcome: "failed", failureClass: "destination_denied" });
      expect(response.receiptId).not.toBeNull();
    } finally {
      harness.close();
    }
  });

  it("keeps exact targets and credential references encrypted behind the broker boundary", () => {
    const harness = createHarness();
    try {
      const row = harness.fixture.db.prepare(`
        SELECT projection_json, target_ciphertext, credential_reference_ciphertext
          FROM broker_connector_bindings
         WHERE installation_id = 'installation-1'
           AND binding_id = 'binding-convex.project.inspect.v1'
      `).get() as Record<string, string>;
      expect(JSON.stringify(row)).not.toContain("credential-reference-convex.project.inspect.v1");
      expect(row.projection_json).not.toContain("convex-team");
      expect(row.target_ciphertext).not.toContain("convex-team");
    } finally {
      harness.close();
    }
  });
});

describe("protected connector authority denials", () => {
  it("denies cross-installation binding access before executor dispatch", async () => {
    const harness = createHarness();
    try {
      harness.foundationStore.addInstallation({
        installationId: "installation-2",
        clientCertificateFingerprint: OTHER_CERTIFICATE,
        policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
        topologyReceiptDigest: "d".repeat(64),
        topologyReceiptExpiresAt: NOW + 100_000,
        expectedVaultId: "vault-2",
      });
      harness.connectorStore.setPolicy({
        installationId: "installation-2",
        projectId: "project-1",
        policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
        enabledOperations: ["convex.project.inspect.v1"],
        now: NOW,
      });
      harness.connectorStore.enrollBinding({
        projection: projection("convex.project.inspect.v1", {
          installationId: "installation-2",
          bindingId: "binding-other-installation",
        }),
        target: target("convex.project.inspect.v1"),
        credentialReference: "credential-reference-other",
        now: NOW,
      });
      const response = await harness.service.execute({
        certificateFingerprint: CERTIFICATE,
        request: request("convex.project.inspect.v1", { bindingId: "binding-other-installation" }),
        now: NOW,
      });
      expect(response).toMatchObject({ outcome: "failed", failureClass: "request_rejected" });
      expect(totalCalls(harness)).toBe(0);
    } finally {
      harness.close();
    }
  });

  it.each([
    ["wrong generation", { bindingGeneration: 99 }, "binding_generation_stale"],
    ["expired deadline", { deadlineAt: NOW - 1 }, "request_rejected"],
  ] as const)("denies %s before executor dispatch", async (_label, overrides, failureClass) => {
    const harness = createHarness();
    try {
      const response = await harness.service.execute({
        certificateFingerprint: CERTIFICATE,
        request: request("convex.project.inspect.v1", overrides),
        now: NOW,
      });
      expect(response).toMatchObject({ outcome: "failed", failureClass });
      expect(totalCalls(harness)).toBe(0);
    } finally {
      harness.close();
    }
  });

  it("denies a stale executor fence before executor dispatch", async () => {
    const harness = createHarness();
    try {
      harness.authorityState.fenceCurrent = false;
      const response = await harness.service.execute({
        certificateFingerprint: CERTIFICATE,
        request: request("convex.project.inspect.v1"),
        now: NOW,
      });
      expect(response).toMatchObject({ outcome: "failed", failureClass: "request_rejected" });
      expect(totalCalls(harness)).toBe(0);
    } finally {
      harness.close();
    }
  });

  it.each([
    ["unsafe topology", "topologyReady", "unsafe_topology", true],
    ["unwritable audit", "auditWritable", "receipt_persistence_failed", false],
  ] as const)("denies %s before executor dispatch", async (_label, state, failureClass, receipted) => {
    const harness = createHarness();
    try {
      harness.authorityState[state] = false;
      const response = await harness.service.execute({
        certificateFingerprint: CERTIFICATE,
        request: request("convex.project.inspect.v1"),
        now: NOW,
      });
      expect(response).toMatchObject({ outcome: "failed", failureClass });
      expect(response.receiptId === null).toBe(!receipted);
      expect(totalCalls(harness)).toBe(0);
    } finally {
      harness.close();
    }
  });

  it("denies a changed project policy before executor dispatch", async () => {
    const harness = createHarness();
    try {
      harness.connectorStore.setPolicy({
        installationId: "installation-1",
        projectId: "project-1",
        policyDigest: "e".repeat(64),
        enabledOperations: ["convex.project.inspect.v1"],
        now: NOW,
      });
      const response = await harness.service.execute({
        certificateFingerprint: CERTIFICATE,
        request: request("convex.project.inspect.v1"),
        now: NOW,
      });
      expect(response).toMatchObject({ outcome: "failed", failureClass: "request_rejected" });
      expect(totalCalls(harness)).toBe(0);
    } finally {
      harness.close();
    }
  });

  it("does not release success when policy changes during a read", async () => {
    const harness = createHarness();
    try {
      vi.mocked(harness.executor.inspectConvex).mockImplementationOnce(async () => {
        harness.connectorStore.setPolicy({
          installationId: "installation-1",
          projectId: "project-1",
          policyDigest: "e".repeat(64),
          enabledOperations: ["convex.project.inspect.v1"],
          now: NOW,
        });
        return {
          outcome: "succeeded",
          connectorVersion: "convex-1",
          identity: {
            projectId: "convex-project-id",
            projectSlug: "hanoon",
            teamId: "convex-team-id",
            teamSlug: "convex-team",
            status: "active",
            connectorVersion: "convex-1",
            observedAt: NOW,
          },
        };
      });
      const response = await harness.service.execute({
        certificateFingerprint: CERTIFICATE,
        request: request("convex.project.inspect.v1"),
        now: NOW,
      });
      expect(response).toMatchObject({ outcome: "failed", failureClass: "reconciliation_required" });
    } finally {
      harness.close();
    }
  });

  it("does not release success when the binding generation changes during a read", async () => {
    const harness = createHarness();
    try {
      vi.mocked(harness.executor.inspectConvex).mockImplementationOnce(async () => {
        const changed = projection("convex.project.inspect.v1", { generation: 2, state: "revoked" });
        harness.fixture.db.prepare(`
          UPDATE broker_connector_bindings
             SET generation = 2, state = 'revoked', projection_json = ?
           WHERE installation_id = 'installation-1'
             AND binding_id = 'binding-convex.project.inspect.v1'
        `).run(JSON.stringify(changed));
        return {
          outcome: "succeeded",
          connectorVersion: "convex-1",
          identity: {
            projectId: "convex-project-id",
            projectSlug: "hanoon",
            teamId: "convex-team-id",
            teamSlug: "convex-team",
            status: "active",
            connectorVersion: "convex-1",
            observedAt: NOW,
          },
        };
      });
      const response = await harness.service.execute({
        certificateFingerprint: CERTIFICATE,
        request: request("convex.project.inspect.v1"),
        now: NOW,
      });
      expect(response).toMatchObject({ outcome: "failed", failureClass: "reconciliation_required" });
    } finally {
      harness.close();
    }
  });
});

describe("protected connector audit and idempotency", () => {
  it("turns receipt persistence failure after an observation into unreceipted failure", async () => {
    const harness = createHarness();
    try {
      harness.fixture.db.exec(`
        CREATE TRIGGER fail_connector_audit BEFORE INSERT ON broker_connector_receipts
        BEGIN SELECT RAISE(ABORT, 'audit canary'); END
      `);
      const response = await harness.service.execute({
        certificateFingerprint: CERTIFICATE,
        request: request("convex.project.inspect.v1"),
        now: NOW,
      });
      expect(response).toMatchObject({
        outcome: "failed",
        failureClass: "receipt_persistence_failed",
        receiptId: null,
      });
      expect(harness.calls.convex).toBe(1);
    } finally {
      harness.close();
    }
  });

  it("rejects a changed digest under one idempotency key and preserves the original replay", async () => {
    const harness = createHarness();
    try {
      const originalRequest = request("convex.project.inspect.v1");
      const first = await harness.service.execute({ certificateFingerprint: CERTIFICATE, request: originalRequest, now: NOW });
      const changed = await harness.service.execute({
        certificateFingerprint: CERTIFICATE,
        request: request("convex.project.inspect.v1", {
          idempotencyKey: originalRequest.idempotencyKey,
          requestId: "changed-request",
          nonce: "changed-nonce",
        }),
        now: NOW,
      });
      expect(changed).toMatchObject({ outcome: "failed", failureClass: "request_rejected" });
      const replay = await harness.service.execute({ certificateFingerprint: CERTIFICATE, request: originalRequest, now: NOW });
      expect(replay).toEqual(first);
      expect(harness.calls.convex).toBe(1);
    } finally {
      harness.close();
    }
  });

  it("reconciles an interrupted claim after restart without a second connector observation", async () => {
    const harness = createHarness();
    try {
      const envelope = request("convex.project.inspect.v1");
      expect(harness.connectorStore.claimRequest({ request: envelope, certificateFingerprint: CERTIFICATE, now: NOW }))
        .toEqual({ outcome: "claimed" });
      const restarted = new ProtectedConnectorAuthorityService({
        foundationStore: harness.foundationStore,
        connectorStore: harness.connectorStore,
        executor: harness.executor,
        authority: harness.authority,
        clock: () => NOW + 1,
      });
      const response = await restarted.execute({ certificateFingerprint: CERTIFICATE, request: envelope, now: NOW + 1 });
      expect(response).toMatchObject({ outcome: "failed", failureClass: "result_ambiguous" });
      expect(response.receiptId).not.toBeNull();
      expect(totalCalls(harness)).toBe(0);
    } finally {
      harness.close();
    }
  });
});
