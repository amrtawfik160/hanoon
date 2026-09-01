import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_REQUIRED_CAPABILITIES,
  attestBrowserTopologyEvidence,
  type BrowserTopologyEvidence,
} from "../broker/src/browser-journey";
import { createProtectedBrowserConnectorService } from "../broker/src/main";
import {
  PROTECTED_CONNECTOR_POLICY_DIGEST,
  VERCEL_BROWSER_ORIGIN,
  VERCEL_PROJECT_IDENTITY_JOURNEY_ID,
  type ProtectedConnectorBindingProjection,
} from "../src/credentials/connector-policy";
import {
  protectedConnectorCapabilityFor,
  type ProtectedConnectorRequestEnvelope,
} from "../src/credentials/connector-protocol";
import { FOUNDATION_BROKER_POLICY_DIGEST } from "../src/credentials/protocol";
import { BrokerProtectedConnectorStore } from "../broker/src/connector-store";
import { BrokerStore } from "../broker/src/store";
import { temporaryBrokerDatabase } from "./support/credential-broker-fixtures";

const NOW = Date.now() + 30_000;
const DATA_KEY = new Uint8Array(32).fill(0x11);
const TOPOLOGY_KEY = new Uint8Array(32).fill(0x33);
const CERTIFICATE = "a".repeat(64);

const topology: BrowserTopologyEvidence = attestBrowserTopologyEvidence({
  schemaVersion: 1,
  evidenceId: "topology-runtime-1",
  observedAt: NOW - 10_000,
  expiresAt: NOW + 10_000,
  controllerMayAdminProfiles: false,
  controllerMayAdminGrants: false,
  workerMayAdminProfiles: false,
  workerMayAdminGrants: false,
}, TOPOLOGY_KEY);

function browserProjection(): ProtectedConnectorBindingProjection {
  return {
    schemaVersion: 2,
    installationId: "installation-1",
    bindingId: "binding-browser",
    operation: "browser.vercel_project.inspect.v1",
    bindingKind: "browser_session",
    authorityProvider: "bb_browser",
    secretProvider: "broker_session",
    principalLabel: "Hanoon employee",
    capabilityIds: [protectedConnectorCapabilityFor("browser.vercel_project.inspect.v1")],
    audiences: [],
    origins: [VERCEL_BROWSER_ORIGIN],
    scopes: [],
    riskClass: "low",
    mfaMode: "human_presence",
    approvalMode: "standing_policy",
    state: "pending",
    generation: 1,
    verifiedAt: null,
    expiresAt: null,
  };
}

const browserTarget = {
  operation: "browser.vercel_project.inspect.v1" as const,
  hostId: "host-runtime",
  profileId: "profile-runtime",
  origin: VERCEL_BROWSER_ORIGIN,
  journeyId: VERCEL_PROJECT_IDENTITY_JOURNEY_ID,
  journeyVersion: 1 as const,
  teamSlug: "vercel-team",
  projectName: "hanoon",
};

const browserRequest: ProtectedConnectorRequestEnvelope = {
  schemaVersion: 2,
  installationId: "installation-1",
  requestId: "request-browser-runtime",
  idempotencyKey: "idempotency-browser-runtime",
  nonce: "nonce-browser-runtime",
  operation: "browser.vercel_project.inspect.v1",
  bindingId: "binding-browser",
  bindingGeneration: 1,
  taskId: "task-runtime",
  projectId: "project-runtime",
  capabilityId: "telegram_agent_browser_vercel_project_inspect",
  policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
  fenceOwner: "executor-runtime",
  fenceGeneration: 1,
  issuedAt: NOW - 1_000,
  deadlineAt: NOW + 10_000,
};

describe("protected browser production wiring", () => {
  it("routes an enrolled browser request through the startup composition", async () => {
    const fixture = temporaryBrokerDatabase();
    const calls: (readonly string[])[] = [];
    const invoke = vi.fn(async (argv: readonly string[]) => {
      calls.push(argv);
      if (argv[1] === "status") return {
        hostId: browserTarget.hostId,
        profileId: browserTarget.profileId,
        state: "ready",
        capabilities: BROWSER_REQUIRED_CAPABILITIES.map((id) => ({ id, status: "ready" })),
      };
      if (argv[1] === "grants") return { grants: [{
        id: "grant-runtime",
        hostId: browserTarget.hostId,
        profileId: browserTarget.profileId,
        origin: VERCEL_BROWSER_ORIGIN,
        state: "active",
        expiresAt: NOW + 10_000,
      }] };
      if (argv[1] === "open") return { tabId: "tab-runtime", url: argv[2] };
      return { result: {
        ok: true,
        origin: VERCEL_BROWSER_ORIGIN,
        frameOrigins: [VERCEL_BROWSER_ORIGIN],
        teamSlug: browserTarget.teamSlug,
        projectName: browserTarget.projectName,
        sessionStatus: "authenticated",
        observedAt: NOW,
      } };
    });
    const foundationStore = new BrokerStore(fixture.db, {
      dataKey: DATA_KEY,
      auditKey: TOPOLOGY_KEY,
      clock: () => NOW,
    });
    foundationStore.addInstallation({
      installationId: "installation-1",
      clientCertificateFingerprint: CERTIFICATE,
      policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
      topologyReceiptDigest: "b".repeat(64),
      topologyReceiptExpiresAt: NOW + 100_000,
      expectedVaultId: "vault-runtime",
      now: NOW,
    });
    const connectorStore = new BrokerProtectedConnectorStore(fixture.db, { dataKey: DATA_KEY, clock: () => NOW });
    connectorStore.setPolicy({
      installationId: "installation-1",
      projectId: browserRequest.projectId,
      policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
      enabledOperations: ["browser.vercel_project.inspect.v1"],
      now: NOW,
    });
    connectorStore.enrollBinding({
      projection: browserProjection(),
      target: browserTarget,
      now: NOW,
    });

    try {
      const service = createProtectedBrowserConnectorService({
        foundationStore,
        connectorStore,
        topology: () => topology,
        topologyKey: TOPOLOGY_KEY,
        authority: {
          topologyReady: () => true,
          auditWritable: () => true,
          fenceCurrent: () => true,
        },
        clock: () => NOW,
        invoke,
      });

      const response = await service.execute({
        certificateFingerprint: CERTIFICATE,
        request: browserRequest,
        now: NOW,
      });

      expect(response).toMatchObject({ outcome: "succeeded", operation: browserRequest.operation });
      expect(calls.find((argv) => argv[1] === "open")).toContain(browserTarget.hostId);
      expect(calls.find((argv) => argv[1] === "script")).toContain(browserTarget.hostId);
    } finally {
      fixture.close();
    }
  });
});
