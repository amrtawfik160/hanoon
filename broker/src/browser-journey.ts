import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  parseProtectedConnectorTarget,
  VERCEL_BROWSER_ORIGIN,
  VERCEL_PROJECT_IDENTITY_JOURNEY_ID,
  VERCEL_PROJECT_IDENTITY_JOURNEY_VERSION,
  type BrowserVercelProjectTarget,
} from "../../src/credentials/connector-policy.js";
import type { BrowserVercelProjectIdentity } from "../../src/credentials/connector-protocol.js";
import type {
  ProtectedConnectorExecutionFailure,
  ProtectedConnectorExecutionSuccess,
} from "./connector-authority-service.js";

const execFileAsync = promisify(execFile);

export const VERCEL_BROWSER_JOURNEY_CONNECTOR_VERSION = "browser-journey-1" as const;
export const VERCEL_BROWSER_JOURNEY_PURPOSE = "Protected Vercel project identity journey v1" as const;
export const VERCEL_BROWSER_JOURNEY_TIMEOUT_MS = 15_000;

/** The BB Browser capabilities required by this journey's protected host. */
export const BROWSER_REQUIRED_CAPABILITIES = Object.freeze([
  "bb-connect",
  "browser",
  "dedicated-user",
  "protected-storage",
  "sandbox",
] as const);

const SAFE_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export type BrowserCapabilityObservation = Readonly<{
  id: string;
  status: "ready" | "unavailable";
}>;

export type BrowserStatusObservation = Readonly<{
  hostId: string;
  profileId: string;
  state: "ready" | "sleeping";
  capabilities: readonly BrowserCapabilityObservation[];
  observedAt: number;
}>;

export type BrowserGrantObservation = Readonly<{
  grantId: string;
  hostId: string;
  profileId: string;
  origin: string;
  state: "active" | "expired" | "revoked";
  expiresAt: number | null;
}>;

export type BrowserJourneyObservation = Readonly<{
  tabId: string;
  origin: string;
  frameOrigins: readonly string[];
  teamSlug: string;
  projectName: string;
  sessionStatus: "authenticated" | "login";
  observedAt: number;
}>;

export type BrowserJourneyDeniedObservation = Readonly<{
  deniedReason: "stale_tab" | "login_redirect" | "wrong_project" | "wrong_team" | "cross_origin_frame" | "ambiguous";
}>;

export type BrowserJourneyRun = BrowserJourneyObservation | BrowserJourneyDeniedObservation;

export type BrowserTopologyEvidence = Readonly<{
  schemaVersion: 1;
  evidenceId: string;
  observedAt: number;
  expiresAt: number;
  controllerMayAdminProfiles: boolean;
  controllerMayAdminGrants: boolean;
  workerMayAdminProfiles: boolean;
  workerMayAdminGrants: boolean;
}>;

export type BrowserProfileLeasePort = Readonly<{
  isCurrent(input: Readonly<{
    leaseId: string;
    hostId: string;
    profileId: string;
  }>): boolean;
}>;

export type BrowserJourneyBrowserPort = Readonly<{
  readStatus(input: Readonly<{ hostId: string; profileId: string }>): Promise<BrowserStatusObservation>;
  readGrants(input: Readonly<{ hostId: string; profileId: string }>): Promise<readonly BrowserGrantObservation[]>;
  runVercelProjectJourney(target: BrowserVercelProjectTarget): Promise<BrowserJourneyRun>;
}>;

export type VercelBrowserJourney = Readonly<{
  journeyId: typeof VERCEL_PROJECT_IDENTITY_JOURNEY_ID;
  journeyVersion: typeof VERCEL_PROJECT_IDENTITY_JOURNEY_VERSION;
  origin: typeof VERCEL_BROWSER_ORIGIN;
  url: string;
  script: string;
}>;

export type ProtectedVercelBrowserExecutor = Readonly<{
  inspectBrowserVercel(input: Readonly<{
    target: BrowserVercelProjectTarget;
    leaseId: string;
    signal?: AbortSignal;
  }>): Promise<
    ProtectedConnectorExecutionSuccess<BrowserVercelProjectIdentity> |
    ProtectedConnectorExecutionFailure
  >;
}>;

export type BrowserJourneyDependencies = Readonly<{
  browser: BrowserJourneyBrowserPort;
  topology: () => BrowserTopologyEvidence;
  lease: BrowserProfileLeasePort;
  clock: () => number;
}>;

export type BrowserCliInvoker = (argv: readonly string[]) => Promise<unknown>;

function safeId(candidateId: unknown): candidateId is string {
  return typeof candidateId === "string" && SAFE_OPAQUE_ID.test(candidateId);
}

function safeTimestamp(candidateTimestamp: unknown): candidateTimestamp is number {
  return typeof candidateTimestamp === "number" && Number.isSafeInteger(candidateTimestamp) && candidateTimestamp >= 0;
}

function safeBoundedLabel(candidateLabel: unknown): candidateLabel is string {
  return typeof candidateLabel === "string" && candidateLabel.length >= 1 && candidateLabel.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(candidateLabel);
}

function browserJourneyFailure(
  failureClass: ProtectedConnectorExecutionFailure["failureClass"],
  retryable = false,
): ProtectedConnectorExecutionFailure {
  return {
    outcome: "failed",
    failureClass,
    retryable,
    retryAfterMs: retryable ? 30_000 : null,
    connectorVersion: VERCEL_BROWSER_JOURNEY_CONNECTOR_VERSION,
  };
}

function browserTarget(candidateTarget: unknown): BrowserVercelProjectTarget | null {
  const parsed = parseProtectedConnectorTarget(candidateTarget);
  return parsed.ok && parsed.value.operation === "browser.vercel_project.inspect.v1" ? parsed.value : null;
}

export function browserTopologyIsProtected(evidence: BrowserTopologyEvidence, now: number): boolean {
  return evidence.schemaVersion === 1 &&
    safeId(evidence.evidenceId) &&
    safeTimestamp(evidence.observedAt) &&
    safeTimestamp(evidence.expiresAt) &&
    evidence.observedAt <= now &&
    now < evidence.expiresAt &&
    evidence.controllerMayAdminProfiles === false &&
    evidence.controllerMayAdminGrants === false &&
    evidence.workerMayAdminProfiles === false &&
    evidence.workerMayAdminGrants === false;
}

function journeyPath(target: BrowserVercelProjectTarget): string {
  return `/${encodeURIComponent(target.teamSlug)}/${encodeURIComponent(target.projectName)}`;
}

/**
 * The only JavaScript admitted to BB Browser. Target labels are enrolled
 * broker data, quoted as JSON; callers cannot provide URL, selector, or code.
 */
export function buildVercelBrowserJourney(target: BrowserVercelProjectTarget): VercelBrowserJourney {
  const parsed = browserTarget(target);
  if (!parsed) throw new Error("browser_journey_target_invalid");
  const path = journeyPath(parsed);
  const team = JSON.stringify(parsed.teamSlug);
  const project = JSON.stringify(parsed.projectName);
  const url = `${VERCEL_BROWSER_ORIGIN}${path}`;
  const script = `
const EXPECTED_ORIGIN = ${JSON.stringify(VERCEL_BROWSER_ORIGIN)};
const EXPECTED_PATH = ${JSON.stringify(path)};
const EXPECTED_TEAM = ${team};
const EXPECTED_PROJECT = ${project};
const deny = (reason) => ({ ok: false, reason });
try {
  const initial = new URL(page.url());
  if (initial.origin !== EXPECTED_ORIGIN) return deny("stale_tab");
  await page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded" });
  const finalUrl = new URL(page.url());
  if (finalUrl.origin !== EXPECTED_ORIGIN) return deny("login_redirect");
  if (finalUrl.pathname !== EXPECTED_PATH) return deny("wrong_project");
  const frameOrigins = page.frames().map((frame) => new URL(frame.url()).origin);
  if (frameOrigins.some((frameOrigin) => frameOrigin !== EXPECTED_ORIGIN)) return deny("cross_origin_frame");
  if (await page.locator('input[type="password"]').count() > 0) return deny("login_redirect");
  const projectHeading = page.getByRole("heading", { name: EXPECTED_PROJECT, exact: true });
  if (await projectHeading.count() !== 1) return deny("wrong_project");
  const teamLinks = page.locator('a[href^="/"]');
  let teamMatches = false;
  for (let index = 0; index < await teamLinks.count(); index += 1) {
    if (await teamLinks.nth(index).getAttribute("href") === "/" + EXPECTED_TEAM) teamMatches = true;
  }
  if (!teamMatches) return deny("wrong_team");
  return {
    ok: true,
    origin: EXPECTED_ORIGIN,
    frameOrigins,
    teamSlug: EXPECTED_TEAM,
    projectName: EXPECTED_PROJECT,
    sessionStatus: "authenticated",
    observedAt: Date.now()
  };
} catch {
  return deny("ambiguous");
}`.trim();
  return Object.freeze({
    journeyId: VERCEL_PROJECT_IDENTITY_JOURNEY_ID,
    journeyVersion: VERCEL_PROJECT_IDENTITY_JOURNEY_VERSION,
    origin: VERCEL_BROWSER_ORIGIN,
    url,
    script,
  });
}

function hasReadyCapabilities(status: BrowserStatusObservation): boolean {
  return BROWSER_REQUIRED_CAPABILITIES.every((id) =>
    status.capabilities.some((capability) => capability.id === id && capability.status === "ready"));
}

function currentLease(lease: BrowserProfileLeasePort, target: BrowserVercelProjectTarget, leaseId: string): boolean {
  try {
    return lease.isCurrent({ leaseId, hostId: target.hostId, profileId: target.profileId });
  } catch {
    return false;
  }
}

function exactGrant(
  grants: readonly BrowserGrantObservation[],
  target: BrowserVercelProjectTarget,
  now: number,
): ProtectedConnectorExecutionFailure | BrowserGrantObservation {
  const targetGrants = grants.filter((grant) => grant.hostId === target.hostId && grant.profileId === target.profileId);
  if (targetGrants.some((grant) => grant.origin !== target.origin && grant.state === "active")) {
    return browserJourneyFailure("destination_denied");
  }
  const matching = targetGrants.filter((grant) => grant.origin === target.origin);
  if (matching.length !== 1) return browserJourneyFailure(matching.length === 0 ? "scope_insufficient" : "result_ambiguous");
  const grant = matching[0]!;
  if (grant.state !== "active") return browserJourneyFailure(grant.state === "expired" ? "credential_expired" : "scope_insufficient");
  if (grant.expiresAt !== null && grant.expiresAt <= now) return browserJourneyFailure("credential_expired");
  return grant;
}

function deniedJourneyFailure(reason: BrowserJourneyDeniedObservation["deniedReason"]): ProtectedConnectorExecutionFailure {
  if (reason === "login_redirect") return browserJourneyFailure("credential_expired");
  if (reason === "ambiguous") return browserJourneyFailure("result_ambiguous");
  if (reason === "stale_tab") return browserJourneyFailure("reconciliation_required");
  return browserJourneyFailure("destination_denied");
}

export function createVercelBrowserJourneyExecutor(
  dependencies: BrowserJourneyDependencies,
): ProtectedVercelBrowserExecutor {
  return {
    async inspectBrowserVercel(input) {
      const target = browserTarget(input.target);
      if (!target || !safeId(input.leaseId)) return browserJourneyFailure("destination_denied");
      const now = dependencies.clock();
      let topology: BrowserTopologyEvidence;
      try {
        topology = dependencies.topology();
      } catch {
        return browserJourneyFailure("unsafe_topology");
      }
      if (!browserTopologyIsProtected(topology, now)) return browserJourneyFailure("unsafe_topology");
      if (input.signal?.aborted || !currentLease(dependencies.lease, target, input.leaseId)) {
        return browserJourneyFailure("reconciliation_required");
      }

      let status: BrowserStatusObservation;
      try {
        status = await dependencies.browser.readStatus({ hostId: target.hostId, profileId: target.profileId });
      } catch {
        return browserJourneyFailure("provider_unavailable", true);
      }
      if (
        status.hostId !== target.hostId ||
        status.profileId !== target.profileId ||
        !["ready", "sleeping"].includes(status.state) ||
        !hasReadyCapabilities(status) ||
        !safeTimestamp(status.observedAt) ||
        status.observedAt > now
      ) return browserJourneyFailure("destination_denied");
      if (input.signal?.aborted || !currentLease(dependencies.lease, target, input.leaseId)) {
        return browserJourneyFailure("reconciliation_required");
      }

      let grants: readonly BrowserGrantObservation[];
      try {
        grants = await dependencies.browser.readGrants({ hostId: target.hostId, profileId: target.profileId });
      } catch {
        return browserJourneyFailure("provider_unavailable", true);
      }
      const grant = exactGrant(grants, target, now);
      if ("outcome" in grant) return grant;
      if (!currentLease(dependencies.lease, target, input.leaseId)) return browserJourneyFailure("reconciliation_required");

      let journeyObservation: BrowserJourneyRun;
      try {
        journeyObservation = await dependencies.browser.runVercelProjectJourney(target);
      } catch {
        return browserJourneyFailure("provider_unavailable", true);
      }
      let topologyAfter: BrowserTopologyEvidence;
      try {
        topologyAfter = dependencies.topology();
      } catch {
        return browserJourneyFailure("unsafe_topology");
      }
      if (!browserTopologyIsProtected(topologyAfter, dependencies.clock()) || topologyAfter.evidenceId !== topology.evidenceId) {
        return browserJourneyFailure("unsafe_topology");
      }
      if (
        input.signal?.aborted ||
        !currentLease(dependencies.lease, target, input.leaseId)
      ) return browserJourneyFailure("reconciliation_required");
      if ("deniedReason" in journeyObservation) return deniedJourneyFailure(journeyObservation.deniedReason);
      if (
        !safeId(journeyObservation.tabId) ||
        journeyObservation.origin !== target.origin ||
        journeyObservation.frameOrigins.length === 0 ||
        journeyObservation.frameOrigins.some((origin) => origin !== target.origin)
      ) return browserJourneyFailure("destination_denied");
      if (journeyObservation.sessionStatus !== "authenticated") return browserJourneyFailure("credential_expired");
      if (journeyObservation.teamSlug !== target.teamSlug || journeyObservation.projectName !== target.projectName) {
        return browserJourneyFailure("destination_denied");
      }
      if (!safeTimestamp(journeyObservation.observedAt) || journeyObservation.observedAt > dependencies.clock()) {
        return browserJourneyFailure("result_ambiguous");
      }
      return {
        outcome: "succeeded",
        connectorVersion: VERCEL_BROWSER_JOURNEY_CONNECTOR_VERSION,
        identity: {
          profileId: target.profileId,
          journeyId: target.journeyId,
          journeyVersion: target.journeyVersion,
          origin: target.origin,
          teamSlug: target.teamSlug,
          projectName: target.projectName,
          sessionStatus: "authenticated",
          observedAt: journeyObservation.observedAt,
        },
      };
    },
  };
}

function jsonObject(candidatePayload: unknown): Record<string, unknown> {
  if (!candidatePayload || typeof candidatePayload !== "object" || Array.isArray(candidatePayload)) throw new Error("browser_json_invalid");
  return candidatePayload as Record<string, unknown>;
}

function parseStatus(statusPayload: unknown, observedAt: number): BrowserStatusObservation {
  const statusRecord = jsonObject(statusPayload);
  const capabilities = statusRecord.capabilities;
  if (!Array.isArray(capabilities)) throw new Error("browser_status_invalid");
  const normalized = capabilities.map((entry) => {
    const capabilityRecord = jsonObject(entry);
    if (!safeBoundedLabel(capabilityRecord.id) || (capabilityRecord.status !== "ready" && capabilityRecord.status !== "unavailable")) {
      throw new Error("browser_status_invalid");
    }
    return { id: capabilityRecord.id, status: capabilityRecord.status } as const;
  });
  if (!safeId(statusRecord.hostId) || !safeId(statusRecord.profileId) || (statusRecord.state !== "ready" && statusRecord.state !== "sleeping")) {
    throw new Error("browser_status_invalid");
  }
  return { hostId: statusRecord.hostId, profileId: statusRecord.profileId, state: statusRecord.state, capabilities: normalized, observedAt };
}

function parseGrant(grantPayload: unknown): BrowserGrantObservation {
  const grantRecord = jsonObject(grantPayload);
  const grantId = grantRecord.grantId ?? grantRecord.id;
  const state = grantRecord.state ?? grantRecord.status;
  if (
    !safeId(grantId) ||
    !safeId(grantRecord.hostId) ||
    !safeId(grantRecord.profileId) ||
    typeof grantRecord.origin !== "string" ||
    !["active", "expired", "revoked"].includes(String(state)) ||
    !(grantRecord.expiresAt === null || safeTimestamp(grantRecord.expiresAt))
  ) throw new Error("browser_grant_invalid");
  return {
    grantId,
    hostId: grantRecord.hostId,
    profileId: grantRecord.profileId,
    origin: grantRecord.origin,
    state: state as BrowserGrantObservation["state"],
    expiresAt: grantRecord.expiresAt as number | null,
  };
}

function parseJourneyObservation(journeyPayload: unknown, tabId: string): BrowserJourneyRun {
  const wrapperRecord = jsonObject(journeyPayload);
  const journeyResult = "result" in wrapperRecord ? wrapperRecord.result : wrapperRecord;
  const journeyRecord = jsonObject(journeyResult);
  if (
    journeyRecord.ok === false &&
    ["stale_tab", "login_redirect", "wrong_project", "wrong_team", "cross_origin_frame", "ambiguous"].includes(String(journeyRecord.reason))
  ) {
    return { deniedReason: journeyRecord.reason as BrowserJourneyDeniedObservation["deniedReason"] };
  }
  if (
    journeyRecord.ok !== true ||
    journeyRecord.origin !== VERCEL_BROWSER_ORIGIN ||
    !Array.isArray(journeyRecord.frameOrigins) ||
    !journeyRecord.frameOrigins.every((origin) => origin === VERCEL_BROWSER_ORIGIN) ||
    !safeBoundedLabel(journeyRecord.teamSlug) ||
    !safeBoundedLabel(journeyRecord.projectName) ||
    journeyRecord.sessionStatus !== "authenticated" ||
    !safeTimestamp(journeyRecord.observedAt)
  ) throw new Error("browser_journey_observation_invalid");
  return {
    tabId,
    origin: VERCEL_BROWSER_ORIGIN,
    frameOrigins: Object.freeze([...journeyRecord.frameOrigins]),
    teamSlug: journeyRecord.teamSlug,
    projectName: journeyRecord.projectName,
    sessionStatus: "authenticated",
    observedAt: journeyRecord.observedAt,
  };
}

function parseOpenTab(openPayload: unknown): Readonly<{ tabId: string; origin: string }> {
  const openRecord = jsonObject(openPayload);
  const tabId = openRecord.tabId;
  const url = openRecord.url;
  if (!safeId(tabId) || typeof url !== "string") throw new Error("browser_tab_invalid");
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new Error("browser_tab_invalid");
  }
  return { tabId, origin };
}

async function defaultBrowserCliInvoker(argv: readonly string[]): Promise<unknown> {
  try {
    const childProcessResult = await execFileAsync("bb", [...argv], {
      shell: false,
      maxBuffer: 256 * 1024,
    });
    return JSON.parse(childProcessResult.stdout);
  } catch {
    throw new Error("browser_cli_failed");
  }
}

/**
 * Exact-argv BB Browser adapter. It exposes no generic command, URL, selector,
 * script, cookie, storage, screenshot, or credential operation.
 */
export function createBbBrowserJourneyBrowserPort(options: Readonly<{ invoke?: BrowserCliInvoker }> = {}): BrowserJourneyBrowserPort {
  const invoke = options.invoke ?? defaultBrowserCliInvoker;
  const run = async (argv: readonly string[]): Promise<unknown> => {
    try {
      return await invoke(argv);
    } catch {
      throw new Error("browser_cli_failed");
    }
  };
  return {
    async readStatus(input) {
      return parseStatus(await run([
        "browser", "status", "--host", input.hostId, "--profile", input.profileId, "--json",
      ]), Date.now());
    },
    async readGrants(input) {
      const grantsPayload = await run([
        "browser", "grants", "--host", input.hostId, "--profile", input.profileId, "--json",
      ]);
      const grants = Array.isArray(grantsPayload) ? grantsPayload : jsonObject(grantsPayload).grants;
      if (!Array.isArray(grants)) throw new Error("browser_grants_invalid");
      return Object.freeze(grants.map(parseGrant));
    },
    async runVercelProjectJourney(target) {
      const journey = buildVercelBrowserJourney(target);
      const opened = parseOpenTab(await run([
        "browser", "open", journey.url, "--profile", target.profileId,
        "--timeout", String(VERCEL_BROWSER_JOURNEY_TIMEOUT_MS), "--json",
      ]));
      if (opened.origin !== journey.origin) throw new Error("browser_origin_denied");
      const observation = parseJourneyObservation(await run([
        "browser", "script", "--purpose", VERCEL_BROWSER_JOURNEY_PURPOSE,
        "--code", journey.script, "--origin", journey.origin,
        "--profile", target.profileId, "--tab", opened.tabId,
        "--timeout", String(VERCEL_BROWSER_JOURNEY_TIMEOUT_MS), "--json",
      ]), opened.tabId);
      return observation;
    },
  };
}
