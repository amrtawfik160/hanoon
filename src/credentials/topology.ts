/**
 * Pure readiness decisions for the credential broker foundation. Nothing here
 * performs I/O: every check is a function of the inputs the caller already
 * resolved (settings, trust-kernel state, controller permission mode, and — for
 * full readiness — one already-validated broker health response). The result
 * is the same secret-free projection a doctor command can print directly: a
 * check name and a boolean, never a certificate, digest source, or raw error.
 */
import {
  BROKER_MAX_TOPOLOGY_RECEIPT_AGE_MS,
  BROKER_SCHEMA_VERSION,
  type BrokerHealthSnapshot,
} from "./protocol";
import type { CredentialBrokerConfigResult } from "./config";

export const CREDENTIAL_READINESS_CHECKS = [
  "trust_kernel",
  "controller_permission",
  "isolated_configuration",
  "topology_receipt",
  "broker_tls",
  "broker_identity",
  "protocol_version",
  "installation_identity",
  "broker_audit",
  "onepassword_adapter",
] as const;

export type CredentialReadinessCheck = (typeof CREDENTIAL_READINESS_CHECKS)[number];
export type CredentialReadinessState = "disabled" | "unsafe_topology" | "unavailable" | "ready";

export type CredentialReadinessCheckResult = Readonly<{
  check: CredentialReadinessCheck;
  passed: boolean;
}>;

export type CredentialReadinessSnapshot = Readonly<{
  state: CredentialReadinessState;
  checks: readonly CredentialReadinessCheckResult[];
}>;

export type CredentialStaticReadinessInput = Readonly<{
  trustKernelReady: boolean;
  controllerPermissionMode: string;
  config: CredentialBrokerConfigResult;
  now: number;
}>;

export type CredentialFullReadinessInput = CredentialStaticReadinessInput & Readonly<{
  health: BrokerHealthSnapshot | null;
  healthResponseInstallationId: string | null;
}>;

function isFreshTopologyReceipt(expiresAt: number, now: number): boolean {
  if (now >= expiresAt) return false;
  if (expiresAt - now > BROKER_MAX_TOPOLOGY_RECEIPT_AGE_MS) return false;
  return true;
}

export function evaluateCredentialStaticReadiness(
  input: CredentialStaticReadinessInput,
): CredentialReadinessSnapshot {
  if (input.config.state === "disabled") return { state: "disabled", checks: [] };

  const trustKernel = input.trustKernelReady;
  const controllerPermission = input.controllerPermissionMode === "auto";
  const topologyReceipt = input.config.state === "isolated" &&
    isFreshTopologyReceipt(input.config.value.topologyReceiptExpiresAt, input.now);

  const checks: CredentialReadinessCheckResult[] = [
    { check: "trust_kernel", passed: trustKernel },
    { check: "controller_permission", passed: controllerPermission },
    { check: "isolated_configuration", passed: input.config.state === "isolated" },
    { check: "topology_receipt", passed: topologyReceipt },
  ];
  const allPassed = checks.every((result) => result.passed);
  return { state: allPassed ? "ready" : "unsafe_topology", checks: Object.freeze(checks) };
}

export function evaluateCredentialFullReadiness(input: CredentialFullReadinessInput): CredentialReadinessSnapshot {
  if (input.config.state === "disabled") return { state: "disabled", checks: [] };

  const trustKernel = input.trustKernelReady;
  const controllerPermission = input.controllerPermissionMode === "auto";

  if (input.config.state !== "isolated" || !trustKernel || !controllerPermission) {
    const checks: CredentialReadinessCheckResult[] = [
      { check: "trust_kernel", passed: trustKernel },
      { check: "controller_permission", passed: controllerPermission },
      { check: "isolated_configuration", passed: input.config.state === "isolated" },
    ];
    return { state: "unsafe_topology", checks: Object.freeze(checks) };
  }

  const isolated = input.config.value;
  const localTopologyFresh = isFreshTopologyReceipt(isolated.topologyReceiptExpiresAt, input.now);

  if (!localTopologyFresh) {
    const checks: CredentialReadinessCheckResult[] = [
      { check: "trust_kernel", passed: true },
      { check: "controller_permission", passed: true },
      { check: "isolated_configuration", passed: true },
      { check: "topology_receipt", passed: false },
    ];
    return { state: "unsafe_topology", checks: Object.freeze(checks) };
  }

  if (!input.health) {
    const checks: CredentialReadinessCheckResult[] = [
      { check: "trust_kernel", passed: true },
      { check: "controller_permission", passed: true },
      { check: "isolated_configuration", passed: true },
      { check: "topology_receipt", passed: true },
      { check: "broker_tls", passed: false },
      { check: "broker_identity", passed: false },
      { check: "protocol_version", passed: false },
      { check: "installation_identity", passed: false },
      { check: "broker_audit", passed: false },
      { check: "onepassword_adapter", passed: false },
    ];
    return { state: "unavailable", checks: Object.freeze(checks) };
  }

  const brokerTopologyMatches =
    input.health.topologyReceiptDigest === isolated.topologyReceiptDigest &&
    input.health.topologyReceiptExpiresAt === isolated.topologyReceiptExpiresAt &&
    input.now < input.health.topologyReceiptExpiresAt;

  const checks: CredentialReadinessCheckResult[] = [
    { check: "trust_kernel", passed: true },
    { check: "controller_permission", passed: true },
    { check: "isolated_configuration", passed: true },
    { check: "topology_receipt", passed: brokerTopologyMatches },
    { check: "broker_tls", passed: true },
    { check: "broker_identity", passed: true },
    { check: "protocol_version", passed: input.health.protocolVersion === BROKER_SCHEMA_VERSION },
    {
      check: "installation_identity",
      passed: input.healthResponseInstallationId === isolated.installationId,
    },
    { check: "broker_audit", passed: input.health.auditWritable },
    { check: "onepassword_adapter", passed: input.health.adapterState === "ready" },
  ];

  const allPassed = checks.every((result) => result.passed);
  if (allPassed) return { state: "ready", checks: Object.freeze(checks) };
  if (!brokerTopologyMatches) return { state: "unsafe_topology", checks: Object.freeze(checks) };
  return { state: "unavailable", checks: Object.freeze(checks) };
}
