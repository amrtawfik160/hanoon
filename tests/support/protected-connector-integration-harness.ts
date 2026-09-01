import https from "node:https";
import type { AddressInfo, LookupFunction } from "node:net";
import { createConnection } from "node:net";
import { join } from "node:path";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { BUNDLED_SKILL_IDS } from "../../src/agent-skills/role-resolver";
import {
  PROTECTED_CONNECTOR_POLICY_DIGEST,
  type ProtectedConnectorBindingProjection,
  type ProtectedConnectorTarget,
} from "../../src/credentials/connector-policy";
import { CredentialBrokerClient } from "../../src/credentials/broker-client";
import type { IsolatedCredentialBrokerConfig } from "../../src/credentials/config";
import { CredentialAccessService } from "../../src/credentials/service";
import { ProtectedConnectorAccessService } from "../../src/credentials/protected-connector-service";
import type { BrokerResponseEnvelope } from "../../src/credentials/protocol";
import { openStore, type TelegramAgentStore } from "../../src/storage/store";
import { hashSecret } from "../../src/crypto";
import { registerControllerTools } from "../../src/controller/tools";
import { policyFixture } from "../helpers";
import { BrokerStore } from "../../broker/src/store";
import { BrokerProtectedConnectorStore } from "../../broker/src/connector-store";
import { ProtectedConnectorAuthorityService } from "../../broker/src/connector-authority-service";
import { createAdminServer, type RunningAdminServer } from "../../broker/src/admin-server";
import { createDurableProtectedConnectorAuthority } from "../../broker/src/main";
import { createOnePasswordAdapter, type VaultAdapter } from "../../broker/src/onepassword-adapter";
import {
  createProtectedConnectorExecutor,
  createProtectedConnectorProviderHttpPort,
} from "../../broker/src/provider-connectors";
import { createBrokerServer } from "../../broker/src/server";
import { certificateFingerprint, createMtlsFixture, type MtlsFixture } from "./mtls-fixtures";
import { temporaryBrokerDatabase } from "./credential-broker-fixtures";

const SHARED_FIXTURE = createMtlsFixture();

export const INTEGRATION_NOW = 1_800_000_000_000;
export const INTEGRATION_INSTALLATION_ID = "installation-integration";
export const INTEGRATION_PROJECT_ID = "proj_1";
export const INTEGRATION_BINDING_ID = "binding-convex";
export const INTEGRATION_TOKEN = "synthetic-provider-token";

export const integrationProjection: ProtectedConnectorBindingProjection = {
  schemaVersion: 2,
  installationId: INTEGRATION_INSTALLATION_ID,
  bindingId: INTEGRATION_BINDING_ID,
  operation: "convex.project.inspect.v1",
  bindingKind: "workload_identity",
  authorityProvider: "convex",
  secretProvider: "provider_native",
  principalLabel: "controlled integration workload",
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

export const integrationTarget: ProtectedConnectorTarget = {
  operation: "convex.project.inspect.v1",
  teamIdOrSlug: "team-slug",
  projectSlug: "hanoon",
};

type RunningServer = ReturnType<typeof createBrokerServer>;

function listen(server: RunningServer | https.Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

function closeServer(server: RunningServer | https.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections?.();
  });
}

function sendAdminRequest(socketPath: string, request: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.once("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("error", reject);
    socket.once("close", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8").split("\n")[0]) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}

const loopbackLookup: LookupFunction = (_hostname, _options, callback) => {
  callback(null, [{ address: "127.0.0.1", family: 4 }]);
};

export type ProtectedConnectorIntegrationHarness = Readonly<{
  bb: ReturnType<typeof createFakePluginHost>["bb"];
  hostHarness: ReturnType<typeof createFakePluginHost>["harness"];
  hanoon: TelegramAgentStore;
  broker: BrokerStore;
  connectors: BrokerProtectedConnectorStore;
  protectedAccess: ProtectedConnectorAccessService;
  controllerThreadId: string;
  controllerProjectId: string;
  turnId: string;
  providerCalls: string[];
  releaseStalledProvider(): void;
  restartBrokerAuthority(): Promise<void>;
  provider: https.Server;
  brokerServer: RunningServer;
  client: CredentialBrokerClient;
  fixture: MtlsFixture;
  brokerDatabase: ReturnType<typeof temporaryBrokerDatabase>;
  close(): Promise<void>;
}>;

export type ProtectedConnectorIntegrationHarnessOptions = Readonly<{
  credentialToken?: string;
  credentialError?: string;
  providerMode?: "success" | "failure" | "stall";
  auditWritable?: boolean;
}>;

export function cleanupProtectedConnectorIntegrationFixtures(): void {
  SHARED_FIXTURE.cleanup();
}

/**
 * One local-only composition used by the recovery proofs. It deliberately
 * crosses the controller profile/selected receipt, Hanoon repository and
 * authenticated projection channel, broker mTLS server/client, independent
 * durable executor fence, fixed provider TLS transport, receipts, and restart
 * state. No generic HTTP, CLI, browser, or live provider boundary is present.
 */
export async function createProtectedConnectorIntegrationHarness(
  options: ProtectedConnectorIntegrationHarnessOptions = {},
): Promise<ProtectedConnectorIntegrationHarness> {
  const fixture = SHARED_FIXTURE;
  const brokerDatabase = temporaryBrokerDatabase();
  const { bb, harness: hostHarness } = createFakePluginHost({
    pluginId: "protected-connector-production-composition",
    agentSkillIds: [...BUNDLED_SKILL_IDS],
  });
  const hanoon = openStore(bb.storage, bb.storage.kv, () => INTEGRATION_NOW);
  const pairingSecret = `integration-pairing-${INTEGRATION_NOW}`;
  hanoon.createPairingCode(hashSecret(pairingSecret), INTEGRATION_NOW - 1_000, INTEGRATION_NOW + 60_000);
  if (hanoon.pairOwnerWithCode(hashSecret(pairingSecret), "7", "7", INTEGRATION_NOW).ok !== true) {
    throw new Error("integration_owner_pairing_failed");
  }
  const providerCalls: string[] = [];
  let brokerServer: RunningServer | undefined;
  let provider: https.Server | undefined;
  let adminServer: RunningAdminServer | undefined;
  let stalledProviderResponse: import("node:http").ServerResponse | undefined;
  let authority: ProtectedConnectorAuthorityService | undefined;
  try {
    provider = https.createServer({ key: fixture.serverPrivateKeyPem, cert: fixture.serverCertificatePem }, (request, response) => {
      providerCalls.push(`${request.method ?? ""} ${request.url ?? ""}`);
      if (request.url !== "/v1/teams/team-slug/projects/hanoon") {
        response.writeHead(404).end();
        return;
      }
      if (options.providerMode === "stall") {
        stalledProviderResponse = response;
        return;
      }
      if (options.providerMode === "failure") {
        response.writeHead(503, { "content-type": "application/json" }).end("{}");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        id: "convex-project-id",
        slug: "hanoon",
        teamId: "team-id",
        teamSlug: "team-slug",
        status: "active",
      }));
    });
    const providerPort = await listen(provider);

    let broker = new BrokerStore(brokerDatabase.db, {
      dataKey: new Uint8Array(32).fill(0x11),
      auditKey: new Uint8Array(32).fill(0x22),
      clock: () => INTEGRATION_NOW,
    });
    broker.addInstallation({
      installationId: INTEGRATION_INSTALLATION_ID,
      clientCertificateFingerprint: certificateFingerprint(fixture.clientCertificatePem),
      policyDigest: "b".repeat(64),
      topologyReceiptDigest: "c".repeat(64),
      topologyReceiptExpiresAt: INTEGRATION_NOW + 60_000,
      expectedVaultId: "vault-integration",
      now: INTEGRATION_NOW,
    });
    let connectors = new BrokerProtectedConnectorStore(brokerDatabase.db, {
      dataKey: new Uint8Array(32).fill(0x11),
      clock: () => INTEGRATION_NOW,
    });
    const adminAdapter: VaultAdapter = {
      health: async () => ({ outcome: "ready" }),
      verify: async () => ({ outcome: "valid", versionHmac: "d".repeat(64) }),
    };
    const adminSocketPath = join(fixture.directory, "integration-admin.sock");
    adminServer = createAdminServer({
      socketPath: adminSocketPath,
      store: broker,
      connectorStore: connectors,
      adapter: adminAdapter,
      clock: () => INTEGRATION_NOW,
      brokerVersion: "0.1.0",
    });
    await adminServer.start();
    const enrollment = await sendAdminRequest(adminSocketPath, {
      operation: "connector.binding.enroll",
      installationId: INTEGRATION_INSTALLATION_ID,
      projectId: INTEGRATION_PROJECT_ID,
      policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
      enabledOperations: ["convex.project.inspect.v1"],
      projection: integrationProjection,
      target: integrationTarget,
      credentialReference: "op://vault-integration/item-integration/token",
    });
    if (enrollment.ok !== true || enrollment.bindingId !== INTEGRATION_BINDING_ID) {
      throw new Error("integration_admin_enrollment_failed");
    }

    const adapter = await createOnePasswordAdapter({
      serviceToken: "synthetic-onepassword-service-token",
      port: {
        listVaults: async () => [{ id: "vault-integration" }],
        resolveOne: async () => {
          if (options.credentialError) throw new Error(options.credentialError);
          return {
            outcome: "resolved" as const,
            secret: options.credentialToken ?? INTEGRATION_TOKEN,
            vaultId: "vault-integration",
            itemId: "item-integration",
          };
        },
      },
    });
    const providerExecutor = createProtectedConnectorExecutor({
      http: createProtectedConnectorProviderHttpPort({
        port: providerPort,
        caCertificatePem: fixture.caCertificatePem,
        servername: "broker.test",
        lookup: loopbackLookup,
      }),
      credentials: { resolve: adapter.resolveCredential },
      clock: () => INTEGRATION_NOW,
    });
    const createAuthority = (): void => {
      const durableAuthority = createDurableProtectedConnectorAuthority(broker, connectors, () => INTEGRATION_NOW);
      authority = new ProtectedConnectorAuthorityService({
        foundationStore: broker,
        connectorStore: connectors,
        executor: providerExecutor,
        authority: options.auditWritable === undefined
          ? durableAuthority
          : { ...durableAuthority, auditWritable: () => options.auditWritable === true },
        clock: () => INTEGRATION_NOW,
      });
    };
    const createBrokerHttpServer = (): RunningServer => createBrokerServer({
      serverCertificatePem: fixture.serverCertificatePem,
      serverPrivateKeyPem: fixture.serverPrivateKeyPem,
      clientCaCertificatePem: fixture.caCertificatePem,
      service: {
        execute: (input) => {
          if (input.request.schemaVersion === 1) {
            if (input.request.operation !== "broker.health") throw new Error("integration_health_operation_mismatch");
            return Promise.resolve({
              schemaVersion: 1,
              installationId: input.request.installationId,
              requestId: input.request.requestId,
              operation: "broker.health",
              outcome: "succeeded",
              result: "ready",
              failureClass: null,
              retryable: false,
              retryAfterMs: null,
              receiptId: `receipt_${input.request.requestId}`,
              health: {
                protocolVersion: 1,
                brokerVersion: "0.1.0",
                adapter: "onepassword",
                adapterState: "ready",
                auditWritable: true,
                bindingCount: 0,
                topologyReceiptDigest: "c".repeat(64),
                topologyReceiptExpiresAt: INTEGRATION_NOW + 60_000,
              },
              bindings: [],
              completedAt: INTEGRATION_NOW,
            } satisfies BrokerResponseEnvelope);
          }
          if (input.request.schemaVersion !== 2) throw new Error("integration_protocol_version_mismatch");
          return authority!.execute({
            certificateFingerprint: input.certificateFingerprint,
            request: input.request,
            now: input.now,
          });
        },
        attestExecutorFence: ({ certificateFingerprint, now, attestation }) => {
          const installation = broker.getInstallationByCertificate(certificateFingerprint);
          return installation?.installationId === attestation.installationId &&
            broker.attestExecutorFence({ ...attestation, now });
        },
      },
      clock: () => INTEGRATION_NOW,
    });
    createAuthority();
    brokerServer = createBrokerHttpServer();
    const brokerPort = await listen(brokerServer);
    const clientConfig: IsolatedCredentialBrokerConfig = {
      mode: "isolated",
      endpointOrigin: `https://broker.test:${brokerPort}`,
      installationId: INTEGRATION_INSTALLATION_ID,
      topologyReceiptDigest: "c".repeat(64),
      topologyReceiptExpiresAt: INTEGRATION_NOW + 60_000,
      clientCertificatePem: fixture.clientCertificatePem,
      clientKeyPem: fixture.clientPrivateKeyPem,
      caCertificatePem: fixture.caCertificatePem,
    };
    const client = new CredentialBrokerClient(clientConfig, {
      clock: () => INTEGRATION_NOW,
      lookup: loopbackLookup,
    });
    const credentialAccess = new CredentialAccessService({
      store: hanoon,
      client,
      config: () => ({ state: "isolated", value: clientConfig }),
      trustKernelReady: () => true,
      controllerPermissionMode: () => "auto",
      now: () => INTEGRATION_NOW,
    });

    hanoon.upsertProjectPolicy(policyFixture({ projectId: INTEGRATION_PROJECT_ID }), INTEGRATION_NOW);
    const turn = hanoon.enqueueControllerTurn({
      controllerKey: "owner-7-controller",
      telegramUserId: "7",
      telegramChatId: "7",
      updateId: 68001,
      inputText: "Inspect the current Convex project identity.",
      now: INTEGRATION_NOW,
    });
    const lease = hanoon.acquireExecutorLease("executor-integration", INTEGRATION_NOW, 60_000);
    if (!lease.acquired) throw new Error("integration_executor_lease_missing");
    const fence = { ownerId: "executor-integration", generation: lease.generation, now: INTEGRATION_NOW };
    if (!hanoon.claimNextControllerTurn(fence) || !hanoon.reserveControllerSpawn({
      controllerKey: turn.controllerKey,
      turnId: turn.id,
      projectId: INTEGRATION_PROJECT_ID,
      hostId: "host-integration",
      now: INTEGRATION_NOW,
    }) || !hanoon.markControllerSpawned({
      ...fence,
      turnId: turn.id,
      projectId: INTEGRATION_PROJECT_ID,
      hostId: "host-integration",
      threadId: "thread-integration",
      spawnToken: turn.id,
    }) || !hanoon.markControllerTurnSubmitted({ ...fence, turnId: turn.id })) {
      throw new Error("integration_controller_submission_failed");
    }
    const controller = hanoon.getControllerByThreadId("thread-integration");
    const submittedTurn = hanoon.getPendingControllerTurn(turn.controllerKey);
    if (!controller || !submittedTurn) throw new Error("integration_authorized_controller_missing");
    const authorized = { controller, turn: submittedTurn, fence };
    const brokerBinding = connectors.getBinding(INTEGRATION_INSTALLATION_ID, INTEGRATION_BINDING_ID);
    if (!brokerBinding) throw new Error("integration_broker_binding_missing");
    const protectedAccess = new ProtectedConnectorAccessService({
      store: hanoon,
      client: () => client,
      config: () => ({ state: "isolated", value: clientConfig }),
      trustKernelReady: () => true,
      topologyReady: () => true,
      browserAdministrationIsolated: () => false,
      auditWritable: () => true,
      fullReadiness: async () => (await credentialAccess.status({})).readiness,
      projectPolicyDigest: () => PROTECTED_CONNECTOR_POLICY_DIGEST,
      now: () => INTEGRATION_NOW,
    });
    const imported = protectedAccess.reconcileEnrollment({
      projectId: INTEGRATION_PROJECT_ID,
      projection: brokerBinding.projection,
      authorized,
    });
    if (imported.outcome !== "reconciled") throw new Error(`integration_projection_reconciliation_failed:${imported.outcome}`);

    registerControllerTools(bb, {
      store: hanoon,
      sdk: bb.sdk,
      threadOperations: { request: async () => { throw new Error("unused"); } },
      health: () => ({ ok: true }),
      notify: () => undefined,
      now: () => INTEGRATION_NOW,
      protectedConnectorAccess: protectedAccess,
      controllerProviderId: () => "codex",
    });

    return {
      bb,
      hostHarness,
      hanoon,
      broker,
      connectors,
      protectedAccess,
      controllerThreadId: "thread-integration",
      controllerProjectId: INTEGRATION_PROJECT_ID,
      turnId: turn.id,
      providerCalls,
      provider,
      brokerServer,
      client,
      fixture,
      brokerDatabase,
      releaseStalledProvider: () => {
        stalledProviderResponse?.writeHead(503, { "content-type": "application/json" }).end("{}");
        stalledProviderResponse = undefined;
      },
      restartBrokerAuthority: async () => {
        await closeServer(brokerServer!);
        await adminServer?.close();
        brokerDatabase.reopen();
        broker = new BrokerStore(brokerDatabase.db, {
          dataKey: new Uint8Array(32).fill(0x11),
          auditKey: new Uint8Array(32).fill(0x22),
          clock: () => INTEGRATION_NOW,
        });
        connectors = new BrokerProtectedConnectorStore(brokerDatabase.db, {
          dataKey: new Uint8Array(32).fill(0x11),
          clock: () => INTEGRATION_NOW,
        });
        createAuthority();
        brokerServer = createBrokerHttpServer();
        await listen(brokerServer, brokerPort);
        adminServer = createAdminServer({
          socketPath: adminSocketPath,
          store: broker,
          connectorStore: connectors,
          adapter: adminAdapter,
          clock: () => INTEGRATION_NOW,
          brokerVersion: "0.1.0",
        });
        await adminServer.start();
      },
      close: async () => {
        stalledProviderResponse?.destroy();
        stalledProviderResponse = undefined;
        client.close();
        await closeServer(brokerServer!);
        await closeServer(provider!);
        await adminServer?.close();
        await hostHarness.lifecycle.dispose();
        brokerDatabase.close();
      },
    };
  } catch (error) {
    if (brokerServer) await closeServer(brokerServer);
    if (provider) await closeServer(provider);
    await adminServer?.close();
    await hostHarness.lifecycle.dispose();
    brokerDatabase.close();
    throw error;
  }
}
