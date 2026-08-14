import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createPrivateKey, X509Certificate } from "node:crypto";

import { assertServerCertificateMatchesHostname } from "./config.js";

const SECRET_ENVIRONMENT_NAMES = [
  "OP_SERVICE_ACCOUNT_TOKEN",
  "HANOON_BROKER_SERVICE_TOKEN",
  "HANOON_BROKER_DATA_KEY",
  "HANOON_BROKER_AUDIT_KEY",
  "HANOON_BROKER_TLS_KEY",
] as const;

const CREDENTIAL_NAMES = [
  "onepassword_service_token",
  "broker_data_key",
  "broker_audit_key",
  "server_certificate",
  "server_private_key",
  "client_ca_certificate",
] as const;

export type BrokerCredentials = Readonly<{
  onepasswordServiceToken: string;
  brokerDataKey: Uint8Array;
  brokerAuditKey: Uint8Array;
  serverCertificatePem: string;
  serverPrivateKeyPem: string;
  clientCaCertificatePem: string;
}>;

export class BrokerCredentialError extends Error {
  constructor() {
    super("invalid_broker_credentials");
    this.name = "BrokerCredentialError";
  }
}

function fail(): never {
  throw new BrokerCredentialError();
}

function assertNoSecretEnvironment(): void {
  for (const name of SECRET_ENVIRONMENT_NAMES) {
    if (Object.prototype.hasOwnProperty.call(process.env, name)) fail();
  }
}

function readProtectedFile(directory: string, name: string): Buffer {
  if (!isAbsolute(directory) || directory.includes("\0")) fail();
  const path = join(directory, name);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail();
  }
  const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : stat.uid;
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail();
  if (stat.uid !== 0 && stat.uid !== effectiveUid) fail();
  try {
    return readFileSync(path);
  } catch {
    fail();
  }
}

function parseCertificate(pem: string): X509Certificate {
  try {
    return new X509Certificate(pem);
  } catch {
    fail();
  }
}

export function readSystemdCredentials(directory: string, expectedHostname?: string): BrokerCredentials {
  assertNoSecretEnvironment();
  const values = new Map<string, Buffer>();
  for (const name of CREDENTIAL_NAMES) values.set(name, readProtectedFile(directory, name));

  const serviceToken = values.get("onepassword_service_token");
  const dataKey = values.get("broker_data_key");
  const auditKey = values.get("broker_audit_key");
  const serverCertificate = values.get("server_certificate");
  const serverPrivateKey = values.get("server_private_key");
  const clientCaCertificate = values.get("client_ca_certificate");
  if (!serviceToken || !dataKey || !auditKey || !serverCertificate || !serverPrivateKey || !clientCaCertificate) fail();

  const trimmedToken = serviceToken.toString("utf8").trim();
  if (trimmedToken.length === 0 || dataKey.length !== 32 || auditKey.length !== 32) fail();

  const serverCertificatePem = serverCertificate.toString("utf8");
  const serverPrivateKeyPem = serverPrivateKey.toString("utf8");
  const clientCaCertificatePem = clientCaCertificate.toString("utf8");
  parseCertificate(serverCertificatePem);
  parseCertificate(clientCaCertificatePem);
  try {
    createPrivateKey(serverPrivateKeyPem);
  } catch {
    fail();
  }
  if (expectedHostname !== undefined) assertServerCertificateMatchesHostname(serverCertificatePem, expectedHostname);

  return Object.freeze({
    onepasswordServiceToken: trimmedToken,
    brokerDataKey: Uint8Array.from(dataKey),
    brokerAuditKey: Uint8Array.from(auditKey),
    serverCertificatePem,
    serverPrivateKeyPem,
    clientCaCertificatePem,
  });
}

export { CREDENTIAL_NAMES, SECRET_ENVIRONMENT_NAMES };
