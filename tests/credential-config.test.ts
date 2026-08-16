import { expect, it } from "vitest";
import { parseCredentialBrokerConfig, type CredentialBrokerSettingsInput } from "../src/credentials/config";
import {
  evaluateCredentialFullReadiness,
  evaluateCredentialStaticReadiness,
  type CredentialFullReadinessInput,
  type CredentialStaticReadinessInput,
} from "../src/credentials/topology";
import { BROKER_SCHEMA_VERSION, type BrokerHealthSnapshot } from "../src/credentials/protocol";

const VALID_PEM_CERT = `-----BEGIN CERTIFICATE-----
MIIBgzCCASmgAwIBAgIUW1L4gC6MeV+Ud+wNnC7kU0bN+s0wCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMdGVzdC1maXh0dXJlMB4XDTI2MDgxNDEwMjgxM1oXDTM2MDgx
MTEwMjgxM1owFzEVMBMGA1UEAwwMdGVzdC1maXh0dXJlMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAE8lgFiCsSPUTzcud3u5as3wowffShCJSevZVfHPT+spDqbRZJ
fAzqwAu69fjGsYzIcwKZYzvJUDcZBC5qSgN+W6NTMFEwHQYDVR0OBBYEFF2WLMZE
SeS3kyKKUuEBBoycc7noMB8GA1UdIwQYMBaAFF2WLMZESeS3kyKKUuEBBoycc7no
MA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgYXNP228YLyxkgGok
1Xlri/3ef+vGvZVkHplqiULz634CIQCNkG7RoRpzRaKQVkMZiZ/E8PdOmJuzCLhx
ydSY0UJMrA==
-----END CERTIFICATE-----`;
const VALID_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgkiiRRwUsXJ7S1v9d
bcXTZYgtaanNlGvgyK86g4TddduhRANCAATyWAWIKxI9RPNy53e7lqzfCjB99KEI
lJ69lV8c9P6ykOptFkl8DOrAC7r1+MaxjMhzApljO8lQNxkELmpKA35b
-----END PRIVATE KEY-----`;
const INVALID_PEM = "not-a-real-pem-value";

function settings(overrides: Partial<CredentialBrokerSettingsInput> = {}): CredentialBrokerSettingsInput {
  return {
    credentialBrokerMode: "isolated",
    credentialBrokerEndpoint: "https://broker.example.com",
    credentialBrokerInstallationId: "install_1",
    credentialBrokerTopologyReceiptDigest: "a".repeat(64),
    credentialBrokerTopologyReceiptExpiresAt: "9999999999999",
    credentialBrokerClientCertificate: VALID_PEM_CERT,
    credentialBrokerClientKey: VALID_KEY_PEM,
    credentialBrokerCaCertificate: VALID_PEM_CERT,
    ...overrides,
  };
}

// --- disabled default / malformed mode ------------------------------------

it("defaults to disabled when no mode setting is present", () => {
  expect(parseCredentialBrokerConfig({})).toEqual({ state: "disabled" });
});

it("treats an explicit disabled mode as disabled and ignores absent broker fields", () => {
  expect(parseCredentialBrokerConfig({ credentialBrokerMode: "disabled" })).toEqual({ state: "disabled" });
});

it("rejects a malformed nonempty mode instead of silently treating it as disabled", () => {
  const result = parseCredentialBrokerConfig({ credentialBrokerMode: "Isolated" });
  expect(result.state).toBe("invalid");
});

// --- partial isolated config -----------------------------------------------

it.each([
  "credentialBrokerEndpoint",
  "credentialBrokerInstallationId",
  "credentialBrokerTopologyReceiptDigest",
  "credentialBrokerTopologyReceiptExpiresAt",
  "credentialBrokerClientCertificate",
  "credentialBrokerClientKey",
  "credentialBrokerCaCertificate",
] as const)("rejects isolated mode missing %s", (field) => {
  const result = parseCredentialBrokerConfig(settings({ [field]: undefined }));
  expect(result).toEqual({ state: "invalid", code: "missing_setting" });
});

// --- endpoint origin restrictions -------------------------------------------

it.each([
  ["http://broker.example.com", "non-https scheme"],
  ["https://user:pass@broker.example.com", "embedded credentials"],
  ["https://broker.example.com?x=1", "query string"],
  ["https://broker.example.com#frag", "fragment"],
  ["https://broker.example.com/admin", "non-root path"],
  ["not a url", "unparseable"],
] as const)("rejects an endpoint with %s", (endpoint, _label) => {
  const result = parseCredentialBrokerConfig(settings({ credentialBrokerEndpoint: endpoint }));
  expect(result).toEqual({ state: "invalid", code: "invalid_endpoint" });
});

it.each([
  ["https://127.0.0.1", "IPv4 loopback"],
  ["https://0.0.0.0", "IPv4 unspecified"],
  ["https://169.254.1.5", "IPv4 link-local"],
  ["https://224.0.0.1", "IPv4 multicast"],
  ["https://[::1]", "IPv6 loopback"],
  ["https://[::]", "IPv6 unspecified"],
  ["https://[fe80::1]", "IPv6 link-local"],
  ["https://[ff02::1]", "IPv6 multicast"],
] as const)("rejects endpoint %s as a %s literal", (endpoint, _label) => {
  const result = parseCredentialBrokerConfig(settings({ credentialBrokerEndpoint: endpoint }));
  expect(result).toEqual({ state: "invalid", code: "invalid_endpoint" });
});

it("accepts a normal public hostname and a normal public IP literal endpoint", () => {
  expect(parseCredentialBrokerConfig(settings({ credentialBrokerEndpoint: "https://broker.example.com" })).state)
    .toBe("isolated");
  expect(parseCredentialBrokerConfig(settings({ credentialBrokerEndpoint: "https://203.0.113.10" })).state)
    .toBe("isolated");
});

it("accepts a bare-root-path endpoint and stores the canonical origin without the trailing slash", () => {
  const result = parseCredentialBrokerConfig(settings({ credentialBrokerEndpoint: "https://broker.example.com/" }));
  expect(result.state).toBe("isolated");
  if (result.state !== "isolated") throw new Error("expected isolated");
  expect(result.value.endpointOrigin).toBe("https://broker.example.com");
});

// --- installation id --------------------------------------------------------

it("rejects an installation id with characters outside the opaque id pattern", () => {
  const result = parseCredentialBrokerConfig(settings({ credentialBrokerInstallationId: "bad id!" }));
  expect(result).toEqual({ state: "invalid", code: "invalid_installation" });
});

// --- topology digest / expiry -----------------------------------------------

it("rejects a topology receipt digest that is not 64 lowercase hex characters", () => {
  const result = parseCredentialBrokerConfig(settings({ credentialBrokerTopologyReceiptDigest: "not-hex" }));
  expect(result).toEqual({ state: "invalid", code: "invalid_topology_digest" });
});

it.each(["-5", "12.5", "abc", ""])("rejects a topology receipt expiry of %s", (value) => {
  const result = parseCredentialBrokerConfig(settings({ credentialBrokerTopologyReceiptExpiresAt: value }));
  expect(result.state).toBe("invalid");
});

it("parses a valid topology receipt expiry into the numeric field", () => {
  const result = parseCredentialBrokerConfig(settings({ credentialBrokerTopologyReceiptExpiresAt: "1234567890123" }));
  expect(result.state).toBe("isolated");
  if (result.state !== "isolated") throw new Error("expected isolated");
  expect(result.value.topologyReceiptExpiresAt).toBe(1234567890123);
});

// --- PEM parse failure -------------------------------------------------------

it.each([
  "credentialBrokerClientCertificate",
  "credentialBrokerClientKey",
  "credentialBrokerCaCertificate",
] as const)("rejects an unparseable PEM value in %s", (field) => {
  const result = parseCredentialBrokerConfig(settings({ [field]: INVALID_PEM }));
  expect(result).toEqual({ state: "invalid", code: "invalid_pem" });
});

it("never echoes a setting value anywhere in an invalid result", () => {
  const result = parseCredentialBrokerConfig(settings({ credentialBrokerEndpoint: "http://leak-me.example" }));
  expect(result.state).toBe("invalid");
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("leak-me");
  expect(Object.keys(result).sort()).toEqual(["code", "state"]);
});

it("accepts a fully valid isolated configuration", () => {
  const result = parseCredentialBrokerConfig(settings());
  expect(result.state).toBe("isolated");
  if (result.state !== "isolated") throw new Error("expected isolated");
  expect(result.value).toMatchObject({
    mode: "isolated",
    endpointOrigin: "https://broker.example.com",
    installationId: "install_1",
  });
});

// ============================================================================
// readiness / topology
// ============================================================================

const READINESS_NOW = 1_000;
// Well inside the 30-day maximum topology-receipt validity window, so the
// readiness happy path does not also trip the "implausibly long validity"
// defensive check that a real reviewed report could never satisfy.
const READINESS_EXPIRES_AT = READINESS_NOW + 1_000_000;

function staticInput(overrides: Partial<CredentialStaticReadinessInput> = {}): CredentialStaticReadinessInput {
  return {
    trustKernelReady: true,
    controllerPermissionMode: "auto",
    config: parseCredentialBrokerConfig(
      settings({ credentialBrokerTopologyReceiptExpiresAt: String(READINESS_EXPIRES_AT) }),
    ),
    now: READINESS_NOW,
    ...overrides,
  };
}

function healthSnapshot(overrides: Partial<BrokerHealthSnapshot> = {}): BrokerHealthSnapshot {
  return {
    protocolVersion: 1,
    brokerVersion: "0.1.0",
    adapter: "onepassword",
    adapterState: "ready",
    auditWritable: true,
    bindingCount: 0,
    topologyReceiptDigest: "a".repeat(64),
    topologyReceiptExpiresAt: READINESS_EXPIRES_AT,
    ...overrides,
  };
}

function fullInput(overrides: Partial<CredentialFullReadinessInput> = {}): CredentialFullReadinessInput {
  return {
    ...staticInput(),
    health: healthSnapshot(),
    healthResponseInstallationId: "install_1",
    ...overrides,
  };
}

it("reports disabled readiness with no checks when the broker mode is disabled", () => {
  const result = evaluateCredentialStaticReadiness(staticInput({ config: { state: "disabled" } }));
  expect(result).toEqual({ state: "disabled", checks: [] });
});

it("reports unsafe_topology when the trust kernel is not ready", () => {
  const result = evaluateCredentialStaticReadiness(staticInput({ trustKernelReady: false }));
  expect(result.state).toBe("unsafe_topology");
  expect(result.checks).toContainEqual({ check: "trust_kernel", passed: false });
});

it.each(["full", "accept-edits", "plan", ""])(
  "reports unsafe_topology when the controller permission mode is %s instead of auto",
  (mode) => {
    const result = evaluateCredentialStaticReadiness(staticInput({ controllerPermissionMode: mode }));
    expect(result.state).toBe("unsafe_topology");
    expect(result.checks).toContainEqual({ check: "controller_permission", passed: false });
  },
);

it("reports unsafe_topology when the isolated configuration itself is invalid", () => {
  const result = evaluateCredentialStaticReadiness(
    staticInput({ config: { state: "invalid", code: "invalid_endpoint" } }),
  );
  expect(result.state).toBe("unsafe_topology");
  expect(result.checks).toContainEqual({ check: "isolated_configuration", passed: false });
});

it("reports unsafe_topology once the configured topology receipt has expired", () => {
  const result = evaluateCredentialStaticReadiness(staticInput({ now: READINESS_EXPIRES_AT + 1 }));
  expect(result.state).toBe("unsafe_topology");
  expect(result.checks).toContainEqual({ check: "topology_receipt", passed: false });
});

it("reports unsafe_topology when the configured topology receipt claims more than 30 days of validity", () => {
  const config = parseCredentialBrokerConfig(settings({ credentialBrokerTopologyReceiptExpiresAt: "999999999999999" }));
  const result = evaluateCredentialStaticReadiness(staticInput({ config, now: 1_000 }));
  expect(result.state).toBe("unsafe_topology");
  expect(result.checks).toContainEqual({ check: "topology_receipt", passed: false });
});

it("reports static readiness ready once every static check passes, ahead of any live broker contact", () => {
  const result = evaluateCredentialStaticReadiness(staticInput());
  expect(result.state).toBe("ready");
  expect(result.checks.every((c) => c.passed)).toBe(true);
});

it("reports full readiness unavailable when the broker cannot be reached at all", () => {
  const result = evaluateCredentialFullReadiness(fullInput({ health: null, healthResponseInstallationId: null }));
  expect(result.state).toBe("unavailable");
});

it("reports full readiness unsafe_topology before ever contacting the broker when static checks fail", () => {
  const result = evaluateCredentialFullReadiness(fullInput({ trustKernelReady: false, health: null }));
  expect(result.state).toBe("unsafe_topology");
});

it.each([
  ["protocolVersion", { protocolVersion: (BROKER_SCHEMA_VERSION + 1) as 1 }, "protocol_version"],
  ["auditWritable", { auditWritable: false }, "broker_audit"],
  ["adapterState", { adapterState: "unavailable" as const }, "onepassword_adapter"],
] as const)("reports full readiness unavailable on a bad broker health field: %s", (_label, override, check) => {
  const result = evaluateCredentialFullReadiness(fullInput({ health: healthSnapshot(override) }));
  expect(result.state).toBe("unavailable");
  expect(result.checks).toContainEqual({ check, passed: false });
});

it("reports full readiness unavailable when the health response installation id does not match", () => {
  const result = evaluateCredentialFullReadiness(fullInput({ healthResponseInstallationId: "install_other" }));
  expect(result.state).toBe("unavailable");
  expect(result.checks).toContainEqual({ check: "installation_identity", passed: false });
});

it("reports full readiness unsafe_topology when the broker's reported topology digest disagrees with the configured one", () => {
  const result = evaluateCredentialFullReadiness(
    fullInput({ health: healthSnapshot({ topologyReceiptDigest: "b".repeat(64) }) }),
  );
  expect(result.state).toBe("unsafe_topology");
  expect(result.checks).toContainEqual({ check: "topology_receipt", passed: false });
});

it("reports full readiness unsafe_topology when the broker's reported topology expiry disagrees with the configured one", () => {
  const result = evaluateCredentialFullReadiness(
    fullInput({ health: healthSnapshot({ topologyReceiptExpiresAt: 1_234 }) }),
  );
  expect(result.state).toBe("unsafe_topology");
  expect(result.checks).toContainEqual({ check: "topology_receipt", passed: false });
});

it("reports full readiness ready only once every check, static and live, passes", () => {
  const result = evaluateCredentialFullReadiness(fullInput());
  expect(result.state).toBe("ready");
  expect(result.checks).toHaveLength(10);
  expect(result.checks.every((c) => c.passed)).toBe(true);
});
