import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertServerCertificateMatchesHostname,
  loadBrokerConfig,
} from "../broker/src/config";
import { readSystemdCredentials } from "../broker/src/credentials";
import { writePrivateFile } from "./support/credential-broker-fixtures";

const VALID_CONFIG = {
  listenHost: "127.0.0.1",
  listenPort: 18_443,
  publicHostname: "broker.example.com",
  databasePath: "/var/lib/hanoon-credential-broker/broker.sqlite",
  adminSocketPath: "/run/hanoon-credential-broker/admin.sock",
  requestBodyLimitBytes: 16_384,
  responseBodyLimitBytes: 1_048_576,
  retentionDays: 30,
};

function configFile(contents: unknown): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "hanoon-config-test-"));
  const path = join(directory, "broker.json");
  writePrivateFile(path, JSON.stringify(contents));
  return { directory, path };
}

describe("protected broker configuration", () => {
  it("loads exactly the fixed non-secret configuration keys", () => {
    const file = configFile(VALID_CONFIG);
    expect(loadBrokerConfig(file.path)).toEqual(VALID_CONFIG);
  });

  it.each([
    ["missing file", "/no/such/broker.json"],
    ["relative path", "broker.json"],
  ])("rejects a %s without reading a secret", (_label, path) => {
    expect(() => loadBrokerConfig(path)).toThrow();
  });

  it("rejects a world-writable configuration file", () => {
    const file = configFile(VALID_CONFIG);
    chmodSync(file.path, 0o666);
    expect(() => loadBrokerConfig(file.path)).toThrow();
  });

  it("rejects a symlinked configuration file", () => {
    const directory = mkdtempSync(join(tmpdir(), "hanoon-config-link-test-"));
    const target = join(directory, "target.json");
    const link = join(directory, "broker.json");
    writeFileSync(target, JSON.stringify(VALID_CONFIG));
    symlinkSync(target, link);
    expect(() => loadBrokerConfig(link)).toThrow();
  });

  it("rejects unknown configuration keys", () => {
    const file = configFile({ ...VALID_CONFIG, serviceToken: "must-not-be-read" });
    expect(() => loadBrokerConfig(file.path)).toThrow();
  });

  it.each([
    ["relative database path", { databasePath: "broker.sqlite" }],
    ["relative admin socket", { adminSocketPath: "admin.sock" }],
    ["wildcard listener", { listenHost: "0.0.0.0" }],
    ["unspecified IPv6 listener", { listenHost: "::" }],
    ["invalid port", { listenPort: 1023 }],
    ["non-canonical public hostname", { publicHostname: "Broker.Example.com." }],
    ["oversized request limit", { requestBodyLimitBytes: 16_385 }],
    ["oversized response limit", { responseBodyLimitBytes: 1_048_577 }],
  ])("rejects %s", (_label, override) => {
    const file = configFile({ ...VALID_CONFIG, ...override });
    expect(() => loadBrokerConfig(file.path)).toThrow();
  });

  it("rejects a public hostname that cannot be used as a certificate name", () => {
    const file = configFile({ ...VALID_CONFIG, publicHostname: "-broker.example.com" });
    expect(() => loadBrokerConfig(file.path)).toThrow();
  });

  it("checks the server certificate SAN against the fixed public hostname", () => {
    expect(() => assertServerCertificateMatchesHostname("not a certificate", "broker.example.com"))
      .toThrow();
  });
});

describe("systemd credential loading", () => {
  it("refuses supported secret environment names without reading their values", () => {
    const canary = "environment-canary-that-must-not-appear";
    const previous = process.env.OP_SERVICE_ACCOUNT_TOKEN;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.OP_SERVICE_ACCOUNT_TOKEN = canary;
    try {
      expect(() => readSystemdCredentials("/no/such/credentials" as string)).toThrow();
      expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining(canary));
    } finally {
      consoleError.mockRestore();
      if (previous === undefined) delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
      else process.env.OP_SERVICE_ACCOUNT_TOKEN = previous;
    }
  });

  it("rejects symlinked, non-regular, or readable credential files", () => {
    const directory = mkdtempSync(join(tmpdir(), "hanoon-credentials-test-"));
    const target = join(directory, "target");
    const token = join(directory, "onepassword_service_token");
    writePrivateFile(target, "token");
    symlinkSync(target, token);
    expect(() => readSystemdCredentials(directory)).toThrow();
    mkdirSync(join(directory, "broker_data_key"));
    expect(() => readSystemdCredentials(directory)).toThrow();
  });

  it("rejects wrong key lengths before any credential can be used", () => {
    const directory = mkdtempSync(join(tmpdir(), "hanoon-credentials-key-test-"));
    for (const name of [
      "onepassword_service_token",
      "broker_data_key",
      "broker_audit_key",
      "server_certificate",
      "server_private_key",
      "client_ca_certificate",
    ]) writePrivateFile(join(directory, name), name === "broker_data_key" ? "short" : "x");
    expect(() => readSystemdCredentials(directory)).toThrow();
  });
});
