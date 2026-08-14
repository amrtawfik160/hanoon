/**
 * Parses Hanoon's isolated-broker settings independently of `GlobalConfig`.
 * The client private key never enters this module's return value in a form
 * broader than the caller already supplied it, and every rejection carries
 * only a stable code — never the setting value that failed — so a bad
 * endpoint or a malformed certificate can never round-trip into a log line.
 */
import { createPrivateKey, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { OPAQUE_ID_PATTERN, SHA256_PATTERN } from "./protocol";

export type CredentialBrokerMode = "disabled" | "isolated";

export type IsolatedCredentialBrokerConfig = Readonly<{
  mode: "isolated";
  endpointOrigin: string;
  installationId: string;
  topologyReceiptDigest: string;
  topologyReceiptExpiresAt: number;
  clientCertificatePem: string;
  clientKeyPem: string;
  caCertificatePem: string;
}>;

export type CredentialBrokerConfigInvalidCode =
  | "missing_setting"
  | "invalid_endpoint"
  | "invalid_installation"
  | "invalid_topology_digest"
  | "invalid_topology_expiry"
  | "invalid_pem";

export type CredentialBrokerConfigResult =
  | { state: "disabled" }
  | { state: "invalid"; code: CredentialBrokerConfigInvalidCode }
  | { state: "isolated"; value: IsolatedCredentialBrokerConfig };

export type CredentialBrokerSettingsInput = Readonly<{
  credentialBrokerMode?: string;
  credentialBrokerEndpoint?: string;
  credentialBrokerInstallationId?: string;
  credentialBrokerTopologyReceiptDigest?: string;
  credentialBrokerTopologyReceiptExpiresAt?: string;
  credentialBrokerClientCertificate?: string;
  credentialBrokerClientKey?: string;
  credentialBrokerCaCertificate?: string;
}>;

const MAX_ENDPOINT_LENGTH = 512;

export function parseCredentialBrokerConfig(values: CredentialBrokerSettingsInput): CredentialBrokerConfigResult {
  const mode = (values.credentialBrokerMode ?? "").trim();
  if (mode === "" || mode === "disabled") return { state: "disabled" };
  if (mode !== "isolated") return { state: "invalid", code: "missing_setting" };

  const endpoint = (values.credentialBrokerEndpoint ?? "").trim();
  const installationId = (values.credentialBrokerInstallationId ?? "").trim();
  const topologyReceiptDigest = (values.credentialBrokerTopologyReceiptDigest ?? "").trim();
  const topologyReceiptExpiresAtRaw = (values.credentialBrokerTopologyReceiptExpiresAt ?? "").trim();
  const clientCertificatePem = values.credentialBrokerClientCertificate ?? "";
  const clientKeyPem = values.credentialBrokerClientKey ?? "";
  const caCertificatePem = values.credentialBrokerCaCertificate ?? "";

  if (
    endpoint === "" || installationId === "" || topologyReceiptDigest === "" ||
    topologyReceiptExpiresAtRaw === "" || clientCertificatePem.trim() === "" ||
    clientKeyPem.trim() === "" || caCertificatePem.trim() === ""
  ) {
    return { state: "invalid", code: "missing_setting" };
  }

  const endpointOrigin = normalizeEndpointOrigin(endpoint);
  if (!endpointOrigin) return { state: "invalid", code: "invalid_endpoint" };

  if (!OPAQUE_ID_PATTERN.test(installationId)) return { state: "invalid", code: "invalid_installation" };

  if (!SHA256_PATTERN.test(topologyReceiptDigest)) return { state: "invalid", code: "invalid_topology_digest" };

  if (!/^[0-9]+$/.test(topologyReceiptExpiresAtRaw)) {
    return { state: "invalid", code: "invalid_topology_expiry" };
  }
  const topologyReceiptExpiresAt = Number(topologyReceiptExpiresAtRaw);
  if (!Number.isSafeInteger(topologyReceiptExpiresAt) || topologyReceiptExpiresAt < 0) {
    return { state: "invalid", code: "invalid_topology_expiry" };
  }

  if (!isParsableCertificatePem(clientCertificatePem)) return { state: "invalid", code: "invalid_pem" };
  if (!isParsablePrivateKeyPem(clientKeyPem)) return { state: "invalid", code: "invalid_pem" };
  if (!isParsableCertificatePem(caCertificatePem)) return { state: "invalid", code: "invalid_pem" };

  return {
    state: "isolated",
    value: Object.freeze({
      mode: "isolated",
      endpointOrigin,
      installationId,
      topologyReceiptDigest,
      topologyReceiptExpiresAt,
      clientCertificatePem,
      clientKeyPem,
      caCertificatePem,
    }),
  };
}

function normalizeEndpointOrigin(value: string): string | null {
  if (value.length === 0 || value.length > MAX_ENDPOINT_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  if (isRejectedHostLiteral(url.hostname)) return null;
  return url.origin;
}

function isRejectedHostLiteral(hostname: string): boolean {
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const version = isIP(host);
  if (version === 4) return isRejectedIPv4(host);
  if (version === 6) return isRejectedIPv6(host);
  return false;
}

function isRejectedIPv4(host: string): boolean {
  const octets = host.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((n) => Number.isNaN(n))) return true;
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 0) return true; // unspecified / "this network" 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
  if (a >= 224 && a <= 239) return true; // multicast 224.0.0.0/4
  return false;
}

function isRejectedIPv6(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "::1") return true; // loopback
  if (normalized === "::") return true; // unspecified
  const leadingHextetMatch = normalized.match(/^([0-9a-f]{1,4})/);
  if (leadingHextetMatch) {
    const firstHextet = parseInt(leadingHextetMatch[1]!, 16);
    if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true; // link-local fe80::/10
    if (firstHextet >= 0xff00 && firstHextet <= 0xffff) return true; // multicast ff00::/8
  }
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isRejectedIPv4(mapped[1]!);
  return false;
}

function isParsableCertificatePem(pem: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new X509Certificate(pem);
    return true;
  } catch {
    return false;
  }
}

function isParsablePrivateKeyPem(pem: string): boolean {
  try {
    createPrivateKey({ key: pem, format: "pem" });
    return true;
  } catch {
    return false;
  }
}
