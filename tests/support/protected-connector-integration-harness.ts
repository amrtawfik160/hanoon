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
import type { ProtectedConnectorAccessStore } from "../../src/credentials/protected-connector-service";
import {
  protectedConnectorCapabilityFor,
  type ProtectedConnectorOperation,
} from "../../src/credentials/connector-protocol";
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
import {
  BROWSER_REQUIRED_CAPABILITIES,
  attestBrowserTopologyEvidence,
  buildVercelBrowserJourney,
  createBbBrowserJourneyBrowserPort,
  createVercelBrowserJourneyExecutor,
  VERCEL_BROWSER_JOURNEY_PURPOSE,
  VERCEL_BROWSER_JOURNEY_TIMEOUT_MS,
  type BrowserTopologyEvidence,
} from "../../broker/src/browser-journey";
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

export function integrationBindingIdFor(operation: ProtectedConnectorOperation): string {
  if (operation === "convex.project.inspect.v1") return "binding-convex";
  if (operation === "vercel.project.inspect.v1") return "binding-vercel";
  return "binding-browser";
}

export function integrationProjectionFor(operation: ProtectedConnectorOperation): ProtectedConnectorBindingProjection {
  if (operation === "convex.project.inspect.v1") return {
    schemaVersion: 2,
    installationId: INTEGRATION_INSTALLATION_ID,
    bindingId: integrationBindingIdFor(operation),
    operation,
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
  if (operation === "vercel.project.inspect.v1") return {
    schemaVersion: 2,
    installationId: INTEGRATION_INSTALLATION_ID,
    bindingId: integrationBindingIdFor(operation),
    operation,
    bindingKind: "workload_identity",
    authorityProvider: "vercel",
    secretProvider: "provider_native",
    principalLabel: "controlled integration workload",
    capabilityIds: ["telegram_agent_vercel_project_inspect"],
    audiences: ["api.vercel.com"],
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
  return {
    schemaVersion: 2,
    installationId: INTEGRATION_INSTALLATION_ID,
    bindingId: integrationBindingIdFor(operation),
    operation,
    bindingKind: "browser_session",
    authorityProvider: "bb_browser",
    secretProvider: "broker_session",
    principalLabel: "controlled integration browser session",
    capabilityIds: ["telegram_agent_browser_vercel_project_inspect"],
    audiences: [],
    origins: ["https://vercel.com"],
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

export function integrationTargetFor(operation: ProtectedConnectorOperation): ProtectedConnectorTarget {
  if (operation === "convex.project.inspect.v1") return {
    operation,
    teamIdOrSlug: "team-slug",
    projectSlug: "hanoon",
  };
  if (operation === "vercel.project.inspect.v1") return {
    operation,
    teamId: "team-id",
    projectIdOrName: "hanoon",
  };
  return {
    operation,
    hostId: "host-integration",
    profileId: "profile-integration",
    origin: "https://vercel.com",
    journeyId: "vercel-project-identity",
    journeyVersion: 1,
    teamSlug: "team-slug",
    projectName: "hanoon",
  };
}

export function integrationInputFor(operation: ProtectedConnectorOperation): string {
  if (operation === "convex.project.inspect.v1") return "Inspect the current Convex project identity.";
  if (operation === "vercel.project.inspect.v1") return "Inspect the current Vercel project identity.";
  return "Inspect the current Vercel project identity in the browser session.";
}

export const integrationProjection = integrationProjectionFor("convex.project.inspect.v1");
export const integrationTarget = integrationTargetFor("convex.project.inspect.v1");

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
  operation: ProtectedConnectorOperation;
  bindingId: string;
  providerCalls: string[];
  browserCalls: string[][];
  browserInstanceIds: number[];
  browserProfileIds: string[];
  browserInstanceLifecycle: string[];
  browserRawResponseKinds: string[];
  browserThrownErrorKinds: string[];
  invokeBrowser(argv: readonly string[]): Promise<unknown>;
  releaseStalledProvider(): void;
  restartBrokerAuthority(): Promise<void>;
  restartHanoon(): Promise<void>;
  restartBrowserInstance(): Promise<void>;
  inspectFreshBrowserJourney(): Promise<unknown>;
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
  operation?: ProtectedConnectorOperation;
  capabilityEvidence?: "current" | "missing" | "stale";
  browserAdministrationIsolated?: boolean;
  browserCanary?: string;
  browserCanaryMode?: "success" | "raw-response" | "thrown-error";
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
  const operation = options.operation ?? "convex.project.inspect.v1";
  const bindingId = integrationBindingIdFor(operation);
  const projection = integrationProjectionFor(operation);
  const target = integrationTargetFor(operation);
  const brokerDatabase = temporaryBrokerDatabase();
  const initialHost = createFakePluginHost({
    pluginId: "protected-connector-production-composition",
    agentSkillIds: [...BUNDLED_SKILL_IDS],
  });
  let bb = initialHost.bb;
  let hostHarness = initialHost.harness;
  let hanoon = openStore(bb.storage, bb.storage.kv, () => INTEGRATION_NOW);
  const pairingSecret = `integration-pairing-${INTEGRATION_NOW}`;
  hanoon.createPairingCode(hashSecret(pairingSecret), INTEGRATION_NOW - 1_000, INTEGRATION_NOW + 60_000);
  if (hanoon.pairOwnerWithCode(hashSecret(pairingSecret), "7", "7", INTEGRATION_NOW).ok !== true) {
    throw new Error("integration_owner_pairing_failed");
  }
  const providerCalls: string[] = [];
  const browserCalls: string[][] = [];
  const browserInstanceIds: number[] = [];
  const browserProfileIds: string[] = [];
  const browserInstanceLifecycle: string[] = [];
  const browserRawResponseKinds: string[] = [];
  const browserThrownErrorKinds: string[] = [];
  let nextBrowserInstanceId = 1;
  const browserTopologyKey = new Uint8Array(32).fill(0x33);
  const browserTopology: BrowserTopologyEvidence = attestBrowserTopologyEvidence({
    schemaVersion: 1,
    evidenceId: "integration-browser-topology",
    observedAt: INTEGRATION_NOW - 1_000,
    expiresAt: INTEGRATION_NOW + 60_000,
    controllerMayAdminProfiles: false,
    controllerMayAdminGrants: false,
    workerMayAdminProfiles: false,
    workerMayAdminGrants: false,
  }, browserTopologyKey);
  let brokerServer: RunningServer | undefined;
  let provider: https.Server | undefined;
  let adminServer: RunningAdminServer | undefined;
  let stalledProviderResponse: import("node:http").ServerResponse | undefined;
  let authority: ProtectedConnectorAuthorityService | undefined;
  try {
    provider = https.createServer({ key: fixture.serverPrivateKeyPem, cert: fixture.serverCertificatePem }, (request, response) => {
      providerCalls.push(`${request.method ?? ""} ${request.url ?? ""}`);
      const expectedPath = operation === "convex.project.inspect.v1"
        ? "/v1/teams/team-slug/projects/hanoon"
        : operation === "vercel.project.inspect.v1"
          ? "/v9/projects/hanoon?teamId=team-id"
          : null;
      if (request.url !== expectedPath) {
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
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(
        operation === "convex.project.inspect.v1"
          ? {
              id: "convex-project-id",
              slug: "hanoon",
              teamId: "team-id",
              teamSlug: "team-slug",
              status: "active",
            }
          : {
              id: "vercel-project-id",
              name: "hanoon",
              accountId: "team-id",
              framework: "nextjs",
              status: "ready",
            },
      ));
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
      enabledOperations: [operation],
      projection,
      target,
      credentialReference: operation === "browser.vercel_project.inspect.v1"
        ? null
        : "op://vault-integration/item-integration/token",
    });
    if (enrollment.ok !== true || enrollment.bindingId !== bindingId) {
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
    // Synthetic BB Browser boundary: each instance owns one fixed profile and
    // records the exact argv. It never launches a browser or contacts Vercel,
    // but it rejects every command outside the enrolled journey contract.
    const browserTarget = integrationTargetFor("browser.vercel_project.inspect.v1") as Extract<
      ProtectedConnectorTarget,
      { operation: "browser.vercel_project.inspect.v1" }
    >;
    const journey = buildVercelBrowserJourney(browserTarget);
    const createBrowserInstance = () => {
      const instanceId = nextBrowserInstanceId++;
      const profileId = "profile-integration";
      browserInstanceLifecycle.push(`created:${instanceId}:${profileId}`);
      let closed = false;
      const invoke = async (argv: readonly string[]): Promise<unknown> => {
        browserCalls.push([...argv]);
        browserInstanceIds.push(instanceId);
        browserProfileIds.push(profileId);
        if (closed) throw new Error("browser_instance_closed");
        const expected = (command: readonly string[]): void => {
          if (argv.length !== command.length || argv.some((value, index) => value !== command[index])) {
            throw new Error("browser_invocation_rejected");
          }
        };
        if (argv[1] === "status") {
          expected(["browser", "status", "--host", browserTarget.hostId, "--profile", profileId, "--json"]);
          return {
            ...(options.browserCanary === undefined ? {} : {
              cookie: options.browserCanary,
              storage: { session: options.browserCanary },
              dom: options.browserCanary,
              screenshot: options.browserCanary,
              rawBody: options.browserCanary,
            }),
            hostId: browserTarget.hostId,
            profileId,
            state: "ready",
            capabilities: BROWSER_REQUIRED_CAPABILITIES.map((id) => ({ id, status: "ready" })),
          };
        }
        if (argv[1] === "grants") {
          expected(["browser", "grants", "--host", browserTarget.hostId, "--profile", profileId, "--json"]);
          return { grants: [{
            id: "grant-integration",
            hostId: browserTarget.hostId,
            profileId,
            origin: browserTarget.origin,
            state: "active",
            expiresAt: INTEGRATION_NOW + 60_000,
          }] };
        }
        if (argv[1] === "open") {
          expected([
            "browser", "open", journey.url,
            "--host", browserTarget.hostId, "--profile", profileId,
            "--timeout", String(VERCEL_BROWSER_JOURNEY_TIMEOUT_MS), "--json",
          ]);
          return { tabId: "tab-integration", url: journey.url };
        }
        if (argv[1] !== "script") throw new Error("browser_invocation_rejected");
        expected([
          "browser", "script", "--purpose", VERCEL_BROWSER_JOURNEY_PURPOSE,
          "--code", journey.script, "--origin", browserTarget.origin,
          "--host", browserTarget.hostId, "--profile", profileId,
          "--tab", "tab-integration", "--timeout", String(VERCEL_BROWSER_JOURNEY_TIMEOUT_MS), "--json",
        ]);
        const canaryFields = options.browserCanary === undefined ? {} : {
          cookie: options.browserCanary,
          storage: { session: options.browserCanary },
          dom: options.browserCanary,
          screenshot: options.browserCanary,
          rawBody: options.browserCanary,
        };
        if (options.browserCanaryMode === "raw-response") {
          browserRawResponseKinds.push("secret-bearing-raw-response");
          return { rawBody: options.browserCanary, headers: { "x-browser-canary": options.browserCanary } };
        }
        if (options.browserCanaryMode === "thrown-error") {
          browserThrownErrorKinds.push("secret-bearing-browser-error");
          throw new Error(options.browserCanary);
        }
        return { result: {
          ...canaryFields,
          ok: true,
          origin: browserTarget.origin,
          frameOrigins: [browserTarget.origin],
          teamSlug: browserTarget.teamSlug,
          projectName: browserTarget.projectName,
          sessionStatus: "authenticated",
          observedAt: INTEGRATION_NOW,
        } };
      };
      return {
        instanceId,
        profileId,
        close: () => {
          if (closed) return;
          closed = true;
          browserInstanceLifecycle.push(`closed:${instanceId}:${profileId}`);
        },
        invoke,
      };
    };
    let browserInstance = createBrowserInstance();
    const createBrowserExecutor = () => {
      const instance = browserInstance;
      return createVercelBrowserJourneyExecutor({
        browser: createBbBrowserJourneyBrowserPort({ invoke: instance.invoke }),
        topology: () => browserTopology,
        topologyKey: browserTopologyKey,
        lease: {
          isCurrent: (input) => connectors.isBrowserProfileLeaseCurrentForTarget({
            leaseId: input.leaseId,
            hostId: input.hostId,
            profileId: input.profileId,
            now: INTEGRATION_NOW,
          }),
        },
        clock: () => INTEGRATION_NOW,
      });
    };
    let browserExecutor = createBrowserExecutor();
    const createAuthority = (): void => {
      const durableAuthority = createDurableProtectedConnectorAuthority(broker, connectors, () => INTEGRATION_NOW);
      authority = new ProtectedConnectorAuthorityService({
        foundationStore: broker,
        connectorStore: connectors,
        executor: {
          ...providerExecutor,
          inspectBrowserVercel: browserExecutor.inspectBrowserVercel,
        },
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
          throw new Error("integration_protected_service_required");
        },
      attestExecutorFence: ({ certificateFingerprint, now, attestation }) => {
        const installation = broker.getInstallationByCertificate(certificateFingerprint);
        return installation?.installationId === attestation.installationId &&
          broker.attestExecutorFence({ ...attestation, now });
      },
      },
      protectedService: {
        execute: (input) => authority!.execute({
          certificateFingerprint: input.certificateFingerprint,
          request: input.request,
          now: input.now,
        }),
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
    const createCredentialAccess = (store: TelegramAgentStore): CredentialAccessService => new CredentialAccessService({
      store,
      client,
      config: () => ({ state: "isolated", value: clientConfig }),
      trustKernelReady: () => true,
      controllerPermissionMode: () => "auto",
      now: () => INTEGRATION_NOW,
    });
    let credentialAccess = createCredentialAccess(hanoon);

    hanoon.upsertProjectPolicy(policyFixture({ projectId: INTEGRATION_PROJECT_ID }), INTEGRATION_NOW);
    const turn = hanoon.enqueueControllerTurn({
      controllerKey: "owner-7-controller",
      telegramUserId: "7",
      telegramChatId: "7",
      updateId: 68001,
      inputText: integrationInputFor(operation),
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
    const brokerBinding = connectors.getBinding(INTEGRATION_INSTALLATION_ID, bindingId);
    if (!brokerBinding) throw new Error("integration_broker_binding_missing");
    const createProtectedAccess = (store: TelegramAgentStore): ProtectedConnectorAccessService => {
      const protectedAccessStore = new Proxy(store, {
        get(target, property) {
          if (property === "listCapabilityReceipts" && options.capabilityEvidence !== undefined && options.capabilityEvidence !== "current") {
            return (profileId: string, limit: number): ReturnType<TelegramAgentStore["listCapabilityReceipts"]> => {
              const receipts = target.listCapabilityReceipts(profileId, limit);
              const capabilityId = protectedConnectorCapabilityFor(operation);
              if (options.capabilityEvidence === "missing") {
                return receipts.filter((receipt) => receipt.capabilityId !== capabilityId || receipt.eventType !== "selected");
              }
              return receipts.map((receipt) => receipt.capabilityId === capabilityId && receipt.eventType === "selected"
                ? { ...receipt, profileRevision: receipt.profileRevision + 1 }
                : receipt);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as unknown as ProtectedConnectorAccessStore;
      return new ProtectedConnectorAccessService({
        store: protectedAccessStore,
        client: () => client,
        config: () => ({ state: "isolated", value: clientConfig }),
        trustKernelReady: () => true,
        topologyReady: () => true,
        browserAdministrationIsolated: () => options.browserAdministrationIsolated === true,
        auditWritable: () => true,
        fullReadiness: async () => (await credentialAccess.status({})).readiness,
        projectPolicyDigest: () => PROTECTED_CONNECTOR_POLICY_DIGEST,
        now: () => INTEGRATION_NOW,
      });
    };
    let protectedAccess = createProtectedAccess(hanoon);
    const imported = protectedAccess.reconcileEnrollment({
      projectId: INTEGRATION_PROJECT_ID,
      projection: brokerBinding.projection,
      authorized,
    });
    if (imported.outcome !== "reconciled") throw new Error(`integration_projection_reconciliation_failed:${imported.outcome}`);

    const registerHanoonSurface = (
      pluginApi: typeof bb,
      store: TelegramAgentStore,
      access: ProtectedConnectorAccessService,
    ): void => {
      registerControllerTools(pluginApi, {
        store,
        sdk: pluginApi.sdk,
        threadOperations: { request: async () => { throw new Error("unused"); } },
        health: () => ({ ok: true }),
        notify: () => undefined,
        now: () => INTEGRATION_NOW,
        protectedConnectorAccess: access,
        controllerProviderId: () => "codex",
      });
    };
    registerHanoonSurface(bb, hanoon, protectedAccess);

    return {
      get bb() { return bb; },
      get hostHarness() { return hostHarness; },
      get hanoon() { return hanoon; },
      get broker() { return broker; },
      get connectors() { return connectors; },
      get protectedAccess() { return protectedAccess; },
      controllerThreadId: "thread-integration",
      controllerProjectId: INTEGRATION_PROJECT_ID,
      turnId: turn.id,
      operation,
      bindingId,
      providerCalls,
      browserCalls,
      browserInstanceIds,
      browserProfileIds,
      browserInstanceLifecycle,
      browserRawResponseKinds,
      browserThrownErrorKinds,
      invokeBrowser: (argv) => browserInstance.invoke(argv),
      provider,
      get brokerServer() { return brokerServer!; },
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
      restartHanoon: async () => {
        let reopenedStore: TelegramAgentStore | undefined;
        let reopenedCredentialAccess: CredentialAccessService | undefined;
        let reopenedProtectedAccess: ProtectedConnectorAccessService | undefined;
        const reloadedHost = await hostHarness.lifecycle.reload(async (restartedBb) => {
          const store = openStore(restartedBb.storage, restartedBb.storage.kv, () => INTEGRATION_NOW);
          const access = createCredentialAccess(store);
          const protectedAccessForReload = createProtectedAccess(store);
          registerHanoonSurface(restartedBb, store, protectedAccessForReload);
          reopenedStore = store;
          reopenedCredentialAccess = access;
          reopenedProtectedAccess = protectedAccessForReload;
        });
        if (!reopenedStore || !reopenedCredentialAccess || !reopenedProtectedAccess) {
          throw new Error("integration_hanoon_restart_failed");
        }
        bb = reloadedHost.bb;
        hostHarness = reloadedHost.harness;
        hanoon = reopenedStore;
        credentialAccess = reopenedCredentialAccess;
        protectedAccess = reopenedProtectedAccess;
      },
      restartBrowserInstance: async () => {
        browserInstance.close();
        browserInstance = createBrowserInstance();
        browserExecutor = createBrowserExecutor();
        createAuthority();
      },
      inspectFreshBrowserJourney: async () => {
        if (operation !== "browser.vercel_project.inspect.v1") throw new Error("integration_browser_journey_required");
        const freshControllerKey = "owner-7-browser-restart";
        const freshThreadId = "thread-browser-restart";
        const freshTurn = hanoon.enqueueControllerTurn({
          controllerKey: freshControllerKey,
          telegramUserId: "7",
          telegramChatId: "7",
          updateId: 68002,
          inputText: integrationInputFor(operation),
          now: INTEGRATION_NOW,
        });
        if (!hanoon.claimNextControllerTurn(fence) || !hanoon.reserveControllerSpawn({
          controllerKey: freshControllerKey,
          turnId: freshTurn.id,
          projectId: INTEGRATION_PROJECT_ID,
          hostId: "host-integration",
          now: INTEGRATION_NOW,
        }) || !hanoon.markControllerSpawned({
          ...fence,
          turnId: freshTurn.id,
          projectId: INTEGRATION_PROJECT_ID,
          hostId: "host-integration",
          threadId: freshThreadId,
          spawnToken: freshTurn.id,
        }) || !hanoon.markControllerTurnSubmitted({ ...fence, turnId: freshTurn.id })) {
          throw new Error("integration_fresh_controller_submission_failed");
        }
        return hostHarness.behavior.callAgentTool(
          "telegram_agent_connector_inspect",
          {
            projectId: INTEGRATION_PROJECT_ID,
            operation,
            bindingId,
          },
          { threadId: freshThreadId, projectId: INTEGRATION_PROJECT_ID, signal: new AbortController().signal },
        );
      },
      close: async () => {
        stalledProviderResponse?.destroy();
        stalledProviderResponse = undefined;
        client.close();
        browserInstance.close();
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
