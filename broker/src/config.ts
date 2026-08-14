import { lstatSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { X509Certificate } from "node:crypto";

import {
  BROKER_MAX_REQUEST_BYTES,
  BROKER_MAX_RESPONSE_BYTES,
} from "../../src/credentials/protocol.js";

const CONFIG_KEYS = [
  "listenHost",
  "listenPort",
  "publicHostname",
  "databasePath",
  "adminSocketPath",
  "requestBodyLimitBytes",
  "responseBodyLimitBytes",
  "retentionDays",
] as const;

const ADMIN_SOCKET_ROOT = "/run/hanoon-credential-broker/";
const WILDCARD_HOSTS = new Set(["*", "0", "0.0.0.0", "::", "::0", "0:0:0:0:0:0:0:0"]);

export type BrokerConfig = Readonly<{
  listenHost: string;
  listenPort: number;
  publicHostname: string;
  databasePath: string;
  adminSocketPath: string;
  requestBodyLimitBytes: number;
  responseBodyLimitBytes: number;
  retentionDays: number;
}>;

export class BrokerConfigError extends Error {
  readonly code: "invalid_config" | "invalid_certificate";

  constructor(code: "invalid_config" | "invalid_certificate") {
    super(code);
    this.name = "BrokerConfigError";
    this.code = code;
  }
}

function fail(code: "invalid_config" | "invalid_certificate" = "invalid_config"): never {
  throw new BrokerConfigError(code);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === CONFIG_KEYS.length && keys.every((key) => CONFIG_KEYS.includes(key as typeof CONFIG_KEYS[number]));
}

function assertProtectedConfigFile(path: string): void {
  if (!isAbsolute(path) || path.includes("\0")) fail();
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail();
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) fail();
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isCanonicalHostname(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 253) return false;
  if (value !== value.trim() || value !== value.toLowerCase() || value.endsWith(".")) return false;
  if (value === "localhost" || isIP(value) !== 0 || !value.includes(".")) return false;
  const labels = value.split(".");
  return labels.every((label) =>
    label.length > 0 && label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

function isSafeListenerHost(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) return false;
  if (WILDCARD_HOSTS.has(value.toLowerCase())) return false;
  if (isIP(value) !== 0) return true;
  return isCanonicalHostname(value);
}

function assertAbsolutePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) fail();
}

function assertLimit(value: unknown, maximum: number): asserts value is number {
  if (!isSafeInteger(value) || value < 1 || value > maximum) fail();
}

export function validateBrokerConfig(input: unknown): BrokerConfig {
  if (!isPlainObject(input) || !hasExactKeys(input)) fail();
  if (!isSafeListenerHost(input.listenHost)) fail();
  if (!isSafeInteger(input.listenPort) || input.listenPort < 1024 || input.listenPort > 65_535) fail();
  if (!isCanonicalHostname(input.publicHostname)) fail();
  assertAbsolutePath(input.databasePath);
  assertAbsolutePath(input.adminSocketPath);
  if (!input.adminSocketPath.startsWith(ADMIN_SOCKET_ROOT)) fail();
  if (input.adminSocketPath === ADMIN_SOCKET_ROOT.slice(0, -1)) fail();
  assertLimit(input.requestBodyLimitBytes, BROKER_MAX_REQUEST_BYTES);
  assertLimit(input.responseBodyLimitBytes, BROKER_MAX_RESPONSE_BYTES);
  if (!isSafeInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 3650) fail();

  return Object.freeze({
    listenHost: input.listenHost,
    listenPort: input.listenPort,
    publicHostname: input.publicHostname,
    databasePath: input.databasePath,
    adminSocketPath: input.adminSocketPath,
    requestBodyLimitBytes: input.requestBodyLimitBytes,
    responseBodyLimitBytes: input.responseBodyLimitBytes,
    retentionDays: input.retentionDays,
  });
}

export function loadBrokerConfig(path: string): BrokerConfig {
  assertProtectedConfigFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail();
  }
  return validateBrokerConfig(parsed);
}

function dnsNamesFromSubjectAltName(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("DNS:"))
    .map((entry) => entry.slice(4).toLowerCase());
}

export function assertServerCertificateMatchesHostname(
  certificatePem: string,
  publicHostname: string,
): void {
  if (!isCanonicalHostname(publicHostname) || typeof certificatePem !== "string") fail("invalid_certificate");
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch {
    fail("invalid_certificate");
  }
  const names = dnsNamesFromSubjectAltName(certificate.subjectAltName);
  if (!names.includes(publicHostname)) fail("invalid_certificate");
}

export { ADMIN_SOCKET_ROOT };
