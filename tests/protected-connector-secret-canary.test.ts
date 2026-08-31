import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PROTECTED_CONNECTOR_POLICY_DIGEST,
  type ProtectedConnectorBindingProjection,
  type ProtectedConnectorTarget,
} from "../src/credentials/connector-policy";
import {
  protectedConnectorCapabilityFor,
  type ProtectedConnectorRequestEnvelope,
} from "../src/credentials/connector-protocol";
import { FOUNDATION_BROKER_POLICY_DIGEST } from "../src/credentials/protocol";
import { openStore } from "../src/storage/store";
import {
  ProtectedConnectorAuthorityService,
  type ProtectedConnectorExecutor,
} from "../broker/src/connector-authority-service";
import { BrokerProtectedConnectorStore } from "../broker/src/connector-store";
import { BrokerStore } from "../broker/src/store";
import {
  assertCanaryAbsent,
  CREDENTIAL_SECRET_CANARIES,
  sqliteCanarySurfaces,
  temporaryBrokerDatabase,
} from "./support/credential-broker-fixtures";

const NOW = 1_800_000_000_000;
const DATA_KEY = new Uint8Array(32).fill(0x31);
const AUDIT_KEY = new Uint8Array(32).fill(0x32);

const projection: ProtectedConnectorBindingProjection = {
  schemaVersion: 2,
  installationId: "installation-canary",
  bindingId: "binding-canary",
  operation: "convex.project.inspect.v1",
  bindingKind: "workload_identity",
  authorityProvider: "convex",
  secretProvider: "provider_native",
  principalLabel: "canary workload",
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

const target: ProtectedConnectorTarget = {
  operation: "convex.project.inspect.v1",
  teamIdOrSlug: "team-canary",
  projectSlug: "project-canary",
};

const request: ProtectedConnectorRequestEnvelope = {
  schemaVersion: 2,
  installationId: "installation-canary",
  requestId: "request-canary",
  idempotencyKey: "idempotency-canary",
  nonce: "nonce-canary",
  operation: "convex.project.inspect.v1",
  bindingId: "binding-canary",
  bindingGeneration: 1,
  taskId: "task-canary",
  projectId: "project-canary",
  capabilityId: "telegram_agent_convex_project_inspect",
  policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
  fenceOwner: "executor-canary",
  fenceGeneration: 1,
  issuedAt: NOW - 1_000,
  deadlineAt: NOW + 29_000,
};

describe("protected connector secret canary", () => {
  it("keeps protected target resolution out of both SQLite stores and every returned surface", async () => {
    const broker = temporaryBrokerDatabase();
    const { bb } = createFakePluginHost({ pluginId: "protected-connector-canary" });
    const hanoon = openStore(bb.storage, bb.storage.kv, () => NOW);
    const artifactDirectory = mkdtempSync(join(broker.directory, "artifact-"));
    try {
      const foundation = new BrokerStore(broker.db, {
        dataKey: DATA_KEY,
        auditKey: AUDIT_KEY,
        clock: () => NOW,
      });
      foundation.addInstallation({
        installationId: projection.installationId,
        clientCertificateFingerprint: "a".repeat(64),
        policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
        topologyReceiptDigest: "b".repeat(64),
        topologyReceiptExpiresAt: NOW + 10_000,
        expectedVaultId: "vault-canary",
        now: NOW,
      });
      const connectors = new BrokerProtectedConnectorStore(broker.db, { dataKey: DATA_KEY, clock: () => NOW });
      connectors.setPolicy({
        installationId: projection.installationId,
        projectId: request.projectId,
        policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
        enabledOperations: [request.operation],
        now: NOW,
      });
      connectors.enrollBinding({
        projection,
        target,
        credentialReference: CREDENTIAL_SECRET_CANARIES.resolvedSecret,
        now: NOW,
      });

      const executor: ProtectedConnectorExecutor = {
        inspectConvex: async ({ credentialReference }) => {
          expect(credentialReference).toBe(CREDENTIAL_SECRET_CANARIES.resolvedSecret);
          return {
            outcome: "succeeded",
            connectorVersion: "canary-1",
            identity: {
              projectId: "project-canary",
              projectSlug: "project-canary",
              teamId: "team-canary",
              teamSlug: "team-canary",
              status: "active",
              connectorVersion: "canary-1",
              observedAt: NOW,
            },
          };
        },
        inspectVercel: async () => { throw new Error("unused"); },
      };
      const authority = new ProtectedConnectorAuthorityService({
        foundationStore: foundation,
        connectorStore: connectors,
        executor,
        authority: { topologyReady: () => true, auditWritable: () => true, fenceCurrent: () => true },
        clock: () => NOW,
      });
      const result = await authority.execute({
        certificateFingerprint: "a".repeat(64),
        request,
        now: NOW,
      });

      hanoon.reconcileProtectedConnectorBinding({ projection, now: NOW });
      const artifactPath = join(artifactDirectory, "connector-proof.txt");
      writeFileSync(artifactPath, JSON.stringify({ result, threadOutput: "connector proof recorded", logs: [], errors: [] }));
      assertCanaryAbsent([
        { name: "response", value: JSON.stringify(result) },
        { name: "argv", value: JSON.stringify(process.argv) },
        { name: "thread-output", value: "connector proof recorded" },
        { name: "artifact", path: artifactPath },
        ...sqliteCanarySurfaces(broker.databasePath, "broker"),
        ...sqliteCanarySurfaces(bb.storage.database().name, "hanoon"),
      ], CREDENTIAL_SECRET_CANARIES);
      expect(result).toMatchObject({ outcome: "succeeded" });
    } finally {
      rmSync(artifactDirectory, { recursive: true, force: true });
      broker.close();
    }
  });
});
