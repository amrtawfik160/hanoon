import Database from "better-sqlite3";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:https";

import {
  BROKER_MAX_TOPOLOGY_RECEIPT_AGE_MS,
  BROKER_SCHEMA_VERSION,
  type BrokerRequestEnvelope,
  type BrokerResponseEnvelope,
} from "../../src/credentials/protocol.js";
import type {
  CredentialProtocolRequestEnvelope,
  CredentialProtocolResponseEnvelope,
} from "../../src/credentials/connector-protocol.js";
import { loadBrokerConfig } from "./config.js";
import { readSystemdCredentials } from "./credentials.js";
import { createOnePasswordAdapter } from "./onepassword-adapter.js";
import { BrokerOperationService } from "./operation-service.js";
import { BrokerStore } from "./store.js";
import { createBrokerServer, type BrokerFenceAttestation } from "./server.js";
import { createAdminServer } from "./admin-server.js";
import {
  attestBrowserTopologyEvidence,
  createBbBrowserJourneyBrowserPort,
  createVercelBrowserJourneyExecutor,
  type BrowserCliInvoker,
  type BrowserTopologyEvidence,
} from "./browser-journey.js";
import { BrokerProtectedConnectorStore } from "./connector-store.js";
import {
  ProtectedConnectorAuthorityService,
  type ProtectedConnectorAuthorityPort,
  type ProtectedConnectorExecutionFailure,
  type ProtectedConnectorExecutor,
} from "./connector-authority-service.js";
import {
  createProtectedConnectorExecutor,
  createProtectedConnectorProviderHttpPort,
} from "./provider-connectors.js";

const BROKER_VERSION = "0.1.0";
const SHUTDOWN_TIMEOUT_MS = 10_000;

export type BrokerAdminLifecycle = Readonly<{
  start(): Promise<void>;
  close(): Promise<void>;
}>;

export type RunningBroker = Readonly<{
  server: Server;
  store: BrokerStore;
  address(): ReturnType<Server["address"]>;
  close(): Promise<void>;
}>;

export type BrokerStartupOptions = Readonly<{
  adminServer?: BrokerAdminLifecycle;
  protectedAuthority?: ProtectedConnectorAuthorityPort;
  protectedBrowser?: Readonly<{
    topology?: () => BrowserTopologyEvidence;
    authority?: ProtectedConnectorAuthorityPort;
    invoke?: BrowserCliInvoker;
  }>;
}>;

export type ProtectedBrowserConnectorServiceDependencies = Readonly<{
  foundationStore: BrokerStore;
  connectorStore: BrokerProtectedConnectorStore;
  topology: () => BrowserTopologyEvidence;
  topologyKey: Uint8Array;
  authority: ProtectedConnectorAuthorityPort;
  clock: () => number;
  invoke?: BrowserCliInvoker;
  providerExecutor?: Pick<ProtectedConnectorExecutor, "inspectConvex" | "inspectVercel">;
}>;

function unsupportedProtectedConnectorFailure(): ProtectedConnectorExecutionFailure {
  return {
    outcome: "failed",
    failureClass: "reconciliation_required",
    retryable: false,
    retryAfterMs: null,
    connectorVersion: "protected-runtime-1",
  };
}

/** Composes the protected authority with the fixed browser journey at startup. */
export function createProtectedBrowserConnectorService(
  dependencies: ProtectedBrowserConnectorServiceDependencies,
): ProtectedConnectorAuthorityService {
  const browser = createBbBrowserJourneyBrowserPort({ invoke: dependencies.invoke });
  const browserExecutor = createVercelBrowserJourneyExecutor({
    browser,
    topology: dependencies.topology,
    topologyKey: dependencies.topologyKey,
    lease: {
      isCurrent: (input) => dependencies.connectorStore.isBrowserProfileLeaseCurrentForTarget({
        leaseId: input.leaseId,
        hostId: input.hostId,
        profileId: input.profileId,
        now: dependencies.clock(),
      }),
    },
    clock: dependencies.clock,
  });
  const executor: ProtectedConnectorExecutor = {
    inspectConvex: dependencies.providerExecutor?.inspectConvex ?? (async () => unsupportedProtectedConnectorFailure()),
    inspectVercel: dependencies.providerExecutor?.inspectVercel ?? (async () => unsupportedProtectedConnectorFailure()),
    inspectBrowserVercel: browserExecutor.inspectBrowserVercel,
  };
  return new ProtectedConnectorAuthorityService({
    foundationStore: dependencies.foundationStore,
    connectorStore: dependencies.connectorStore,
    executor,
    authority: dependencies.authority,
    clock: dependencies.clock,
  });
}

export function createDurableProtectedConnectorAuthority(
  foundationStore: BrokerStore,
  _connectorStore: BrokerProtectedConnectorStore,
  clock: () => number,
): ProtectedConnectorAuthorityPort {
  return {
    topologyReady: (operation, context) => {
      if (!context) return false;
      const installation = foundationStore.getInstallation(context.installationId);
      const policy = _connectorStore.getPolicy(context.installationId, context.projectId);
      const now = clock();
      return installation?.state === "active" &&
        installation.topologyReceiptExpiresAt > now &&
        installation.topologyReceiptExpiresAt - now <= BROKER_MAX_TOPOLOGY_RECEIPT_AGE_MS &&
        policy?.enabledOperations.includes(operation) === true;
    },
    auditWritable: () => foundationStore.auditWritable(),
    fenceCurrent: (input) => foundationStore.isExecutorFenceCurrent({ ...input, now: clock() }),
  };
}

function parseConfigPath(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== "--config" || !isAbsolute(argv[1])) {
    throw new Error("invalid_broker_arguments");
  }
  return argv[1];
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}

function closeWithTimeout(running: RunningBroker): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("broker_shutdown_timeout")), SHUTDOWN_TIMEOUT_MS);
    running.close().then(() => {
      clearTimeout(timer);
      resolve();
    }, (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function startBroker(
  configPath: string,
  options: BrokerStartupOptions = {},
): Promise<RunningBroker> {
  const config = loadBrokerConfig(configPath);
  const credentialsDirectory = process.env.CREDENTIALS_DIRECTORY;
  if (!credentialsDirectory) throw new Error("missing_credentials_directory");
  const credentials = readSystemdCredentials(credentialsDirectory, config.publicHostname);
  const database = new Database(config.databasePath);
  let server: Server | null = null;
  let adminServer: BrokerAdminLifecycle | null = null;
  let adapter: Awaited<ReturnType<typeof createOnePasswordAdapter>> | null = null;
  try {
    const store = new BrokerStore(database, {
      dataKey: credentials.brokerDataKey,
      auditKey: credentials.brokerAuditKey,
      clock: Date.now,
      retentionDays: config.retentionDays,
    });
    adapter = await createOnePasswordAdapter({ serviceToken: credentials.onepasswordServiceToken });
    const connectorStore = new BrokerProtectedConnectorStore(database, {
      dataKey: credentials.brokerDataKey,
      clock: Date.now,
    });
    const defaultTopology = attestBrowserTopologyEvidence({
      schemaVersion: 1,
      evidenceId: "unconfigured-browser-topology",
      observedAt: 0,
      expiresAt: 0,
      controllerMayAdminProfiles: true,
      controllerMayAdminGrants: true,
      workerMayAdminProfiles: true,
      workerMayAdminGrants: true,
    }, credentials.brokerAuditKey);
    const topology = options.protectedBrowser?.topology ?? (() => defaultTopology);
    const providerExecutor = createProtectedConnectorExecutor({
      http: createProtectedConnectorProviderHttpPort(),
      credentials: { resolve: adapter.resolveCredential },
    });
    const authority = options.protectedBrowser?.authority ??
      options.protectedAuthority ??
      createDurableProtectedConnectorAuthority(store, connectorStore, Date.now);
    const protectedService = createProtectedBrowserConnectorService({
      foundationStore: store,
      connectorStore,
      topology,
      topologyKey: credentials.brokerAuditKey,
      authority,
      clock: Date.now,
      invoke: options.protectedBrowser?.invoke,
      providerExecutor,
    });
    const legacyService = new BrokerOperationService({
      store,
      adapter,
      dataKey: credentials.brokerDataKey,
      auditKey: credentials.brokerAuditKey,
      clock: Date.now,
      brokerVersion: BROKER_VERSION,
    });
    const service = {
      execute: (input: {
        certificateFingerprint: string;
        now: number;
        request: CredentialProtocolRequestEnvelope;
      }): Promise<CredentialProtocolResponseEnvelope> => input.request.schemaVersion === 1
        ? legacyService.execute({
            ...input,
            request: input.request as BrokerRequestEnvelope,
          }) as Promise<BrokerResponseEnvelope>
        : protectedService.execute({
            certificateFingerprint: input.certificateFingerprint,
            now: input.now,
            request: input.request,
          }),
      attestExecutorFence: (input: {
        certificateFingerprint: string;
        now: number;
        attestation: BrokerFenceAttestation;
      }) => {
        const { certificateFingerprint, now, attestation } = input;
        const installation = store.getInstallationByCertificate(certificateFingerprint);
        return installation?.installationId === attestation.installationId &&
          store.attestExecutorFence({ ...attestation, now });
      },
    };
    const httpsServer = createBrokerServer({
      serverCertificatePem: credentials.serverCertificatePem,
      serverPrivateKeyPem: credentials.serverPrivateKeyPem,
      clientCaCertificatePem: credentials.clientCaCertificatePem,
      service,
      protectedService,
      clock: Date.now,
      requestBodyLimitBytes: config.requestBodyLimitBytes,
      responseBodyLimitBytes: config.responseBodyLimitBytes,
    });
    server = httpsServer;
    adminServer = options.adminServer ?? createAdminServer({
      socketPath: config.adminSocketPath,
      store,
      adapter,
      connectorStore,
      clock: Date.now,
      brokerVersion: BROKER_VERSION,
    });
    const running: RunningBroker = {
      server: httpsServer,
      store,
      address: () => httpsServer.address(),
      close: async () => {
        try {
          await adminServer?.close();
        } finally {
          try {
            await closeServer(httpsServer);
          } finally {
            try {
              await adapter?.close();
            } finally {
              database.close();
            }
          }
        }
      },
    };
    await adminServer.start();
    await listen(server, config.listenHost, config.listenPort);
    return running;
  } catch (error) {
    await adminServer?.close().catch(() => undefined);
    if (server) await closeServer(server).catch(() => undefined);
    await adapter?.close().catch(() => undefined);
    database.close();
    throw error;
  }
}

export async function runBrokerMain(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const configPath = parseConfigPath(argv);
  const running = await startBroker(configPath);
  console.log(JSON.stringify({
    event: "broker_ready",
    brokerVersion: BROKER_VERSION,
    listener: running.address(),
    schemaVersion: BROKER_SCHEMA_VERSION,
  }));

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void closeWithTimeout(running).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

const isMainModule = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  runBrokerMain().catch(() => {
    console.error("broker_start_failed");
    process.exitCode = 1;
  });
}
