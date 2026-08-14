import Database from "better-sqlite3";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:https";

import { BROKER_SCHEMA_VERSION } from "../../src/credentials/protocol.js";
import { loadBrokerConfig } from "./config.js";
import { readSystemdCredentials } from "./credentials.js";
import { createOnePasswordAdapter } from "./onepassword-adapter.js";
import { BrokerOperationService } from "./operation-service.js";
import { BrokerStore } from "./store.js";
import { createBrokerServer } from "./server.js";
import { createAdminServer } from "./admin-server.js";

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
}>;

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
  try {
    const store = new BrokerStore(database, {
      dataKey: credentials.brokerDataKey,
      auditKey: credentials.brokerAuditKey,
      clock: Date.now,
      retentionDays: config.retentionDays,
    });
    const adapter = await createOnePasswordAdapter({ serviceToken: credentials.onepasswordServiceToken });
    const service = new BrokerOperationService({
      store,
      adapter,
      dataKey: credentials.brokerDataKey,
      auditKey: credentials.brokerAuditKey,
      clock: Date.now,
      brokerVersion: BROKER_VERSION,
    });
    const httpsServer = createBrokerServer({
      serverCertificatePem: credentials.serverCertificatePem,
      serverPrivateKeyPem: credentials.serverPrivateKeyPem,
      clientCaCertificatePem: credentials.clientCaCertificatePem,
      service,
      clock: Date.now,
      requestBodyLimitBytes: config.requestBodyLimitBytes,
      responseBodyLimitBytes: config.responseBodyLimitBytes,
    });
    server = httpsServer;
    adminServer = options.adminServer ?? createAdminServer({
      socketPath: config.adminSocketPath,
      store,
      adapter,
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
            database.close();
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
