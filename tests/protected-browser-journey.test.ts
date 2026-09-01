import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_REQUIRED_CAPABILITIES,
  VERCEL_BROWSER_JOURNEY_CONNECTOR_VERSION,
  VERCEL_BROWSER_JOURNEY_PURPOSE,
  attestBrowserTopologyEvidence,
  buildVercelBrowserJourney,
  browserTopologyIsProtected,
  createBbBrowserJourneyBrowserPort,
  createVercelBrowserJourneyExecutor,
  type BrowserGrantObservation,
  type BrowserJourneyBrowserPort,
  type BrowserStatusObservation,
  type BrowserTopologyEvidence,
} from "../broker/src/browser-journey";
import {
  VERCEL_BROWSER_ORIGIN,
  VERCEL_PROJECT_IDENTITY_JOURNEY_ID,
  VERCEL_PROJECT_IDENTITY_JOURNEY_VERSION,
  type BrowserVercelProjectTarget,
} from "../src/credentials/connector-policy";
import { BrokerProtectedConnectorStore } from "../broker/src/connector-store";
import { BrokerStore } from "../broker/src/store";
import { FOUNDATION_BROKER_POLICY_DIGEST } from "../src/credentials/protocol";
import { assertCanaryAbsent, temporaryBrokerDatabase } from "./support/credential-broker-fixtures";

const NOW = 1_800_000_000_000;
const TOPOLOGY_KEY = new Uint8Array(32).fill(0x41);

const target: BrowserVercelProjectTarget = {
  operation: "browser.vercel_project.inspect.v1",
  hostId: "host-1",
  profileId: "profile-1",
  origin: VERCEL_BROWSER_ORIGIN,
  journeyId: VERCEL_PROJECT_IDENTITY_JOURNEY_ID,
  journeyVersion: VERCEL_PROJECT_IDENTITY_JOURNEY_VERSION,
  teamSlug: "vercel-team",
  projectName: "hanoon",
};

const topology = attestBrowserTopologyEvidence({
  schemaVersion: 1,
  evidenceId: "topology-1",
  observedAt: NOW,
  expiresAt: NOW + 60_000,
  controllerMayAdminProfiles: false,
  controllerMayAdminGrants: false,
  workerMayAdminProfiles: false,
  workerMayAdminGrants: false,
}, TOPOLOGY_KEY);

const status: BrowserStatusObservation = {
  hostId: target.hostId,
  profileId: target.profileId,
  state: "sleeping",
  observedAt: NOW,
  capabilities: BROWSER_REQUIRED_CAPABILITIES.map((id) => ({ id, status: "ready" as const })),
};

const grant: BrowserGrantObservation = {
  grantId: "grant-1",
  hostId: target.hostId,
  profileId: target.profileId,
  origin: target.origin,
  state: "active",
  expiresAt: NOW + 60_000,
};

function browserPort(overrides: Partial<BrowserJourneyBrowserPort> = {}): BrowserJourneyBrowserPort {
  return {
    readStatus: vi.fn(async () => status),
    readGrants: vi.fn(async () => [grant]),
    runVercelProjectJourney: vi.fn(async () => ({
      tabId: "tab-1",
      origin: target.origin,
      frameOrigins: [target.origin],
      teamSlug: target.teamSlug,
      projectName: target.projectName,
      sessionStatus: "authenticated" as const,
      observedAt: NOW,
    })),
    ...overrides,
  };
}

describe("protected Vercel browser journey contract", () => {
  it("builds one fixed versioned journey from the enrolled target only", () => {
    const journey = buildVercelBrowserJourney(target);

    expect(journey).toMatchObject({
      journeyId: VERCEL_PROJECT_IDENTITY_JOURNEY_ID,
      journeyVersion: VERCEL_PROJECT_IDENTITY_JOURNEY_VERSION,
      origin: VERCEL_BROWSER_ORIGIN,
      url: "https://vercel.com/vercel-team/hanoon",
    });
    expect(journey.script).toContain(VERCEL_BROWSER_ORIGIN);
    expect(journey.script).toContain("getByRole");
    expect(journey.script).toContain("redirectedFrom");
    expect(journey.script).toContain('page.on("request"');
    expect(journey.script).not.toContain("page.content");
    expect(journey.script).not.toContain("document.cookie");
    expect(journey.script).not.toContain("localStorage");
    expect(VERCEL_BROWSER_JOURNEY_PURPOSE).toBe("Protected Vercel project identity journey v1");
    expect(VERCEL_BROWSER_JOURNEY_CONNECTOR_VERSION).toBe("browser-journey-1");
  });

  it("rejects an intermediate cross-origin redirect even when navigation returns home", async () => {
    const journey = buildVercelBrowserJourney(target);
    type FakeRequest = {
      isNavigationRequest(): boolean;
      url(): string;
      redirectedFrom(): FakeRequest | null;
    };
    const listeners = new Map<string, (request: FakeRequest) => void>();
    let currentUrl = journey.url;
    const initialRequest: FakeRequest = {
      isNavigationRequest: () => true,
      url: () => journey.url,
      redirectedFrom: () => null,
    };
    const crossOriginRequest: FakeRequest = {
      isNavigationRequest: () => true,
      url: () => "https://evil.example/login",
      redirectedFrom: () => initialRequest,
    };
    const page = {
      url: () => currentUrl,
      on: (event: string, listener: (request: FakeRequest) => void) => listeners.set(event, listener),
      off: (event: string) => listeners.delete(event),
      goto: async () => {
        listeners.get("request")?.(initialRequest);
        listeners.get("request")?.(crossOriginRequest);
        currentUrl = journey.url;
      },
      frames: () => [{ url: () => journey.origin }],
      locator: (selector: string) => selector.includes("password")
        ? { count: async () => 0 }
        : { count: async () => 1, nth: () => ({ getAttribute: async () => "/" + target.teamSlug }) },
      getByRole: () => ({ count: async () => 1 }),
    };
    const execute = new Function("page", `return (async () => { ${journey.script} })();`) as (value: typeof page) => Promise<unknown>;

    await expect(execute(page)).resolves.toEqual({ ok: false, reason: "login_redirect" });
    expect(listeners.size).toBe(0);
  });

  it("admits only explicit protected-topology evidence", () => {
    expect(browserTopologyIsProtected(topology, NOW, TOPOLOGY_KEY)).toBe(true);
    expect(browserTopologyIsProtected({ ...topology, workerMayAdminGrants: true }, NOW, TOPOLOGY_KEY)).toBe(false);
    expect(browserTopologyIsProtected({ ...topology, expiresAt: NOW }, NOW, TOPOLOGY_KEY)).toBe(false);
    expect(browserTopologyIsProtected({ ...topology, attestation: "0".repeat(64) }, NOW, TOPOLOGY_KEY)).toBe(false);
  });

  it("rejects arbitrary journey controls instead of forwarding them", () => {
    expect(() => buildVercelBrowserJourney({
      ...target,
      url: "https://evil.example",
      selector: "input[type=password]",
      code: "return document.cookie",
    } as unknown as BrowserVercelProjectTarget)).toThrow("browser_journey_target_invalid");
  });

  it("preflights exact status and grant, then returns only bounded identity", async () => {
    const port = browserPort();
    const executor = createVercelBrowserJourneyExecutor({
      browser: port,
      topology: () => topology,
      topologyKey: TOPOLOGY_KEY,
      lease: { isCurrent: () => true },
      clock: () => NOW,
    });

    const result = await executor.inspectBrowserVercel({ target, leaseId: "lease-1" });

    expect(result).toEqual({
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
        observedAt: NOW,
      },
    });
    expect(port.readStatus).toHaveBeenCalledWith({ hostId: target.hostId, profileId: target.profileId });
    expect(port.readGrants).toHaveBeenCalledWith({ hostId: target.hostId, profileId: target.profileId });
    expect(port.runVercelProjectJourney).toHaveBeenCalledWith(target);
  });

  it.each([
    ["unsafe topology", { topology: () => ({ ...topology, workerMayAdminProfiles: true }) }, "unsafe_topology"],
    ["wrong profile status", {
      browser: browserPort({ readStatus: vi.fn(async () => ({ ...status, profileId: "other-profile" })) }),
    }, "destination_denied"],
    ["stale browser state", {
      browser: browserPort({ readStatus: vi.fn(async () => ({
        ...status,
        capabilities: status.capabilities.map((capability) => capability.id === "browser"
          ? { ...capability, status: "unavailable" as const }
          : capability),
      })) }),
    }, "destination_denied"],
    ["missing grant", { browser: browserPort({ readGrants: vi.fn(async () => []) }) }, "scope_insufficient"],
    ["wrong origin grant", {
      browser: browserPort({ readGrants: vi.fn(async () => [{ ...grant, origin: "https://evil.example" }]) }),
    }, "destination_denied"],
    ["expired grant", {
      browser: browserPort({ readGrants: vi.fn(async () => [{ ...grant, expiresAt: NOW }]) }),
    }, "credential_expired"],
    ["wrong project", {
      browser: browserPort({ runVercelProjectJourney: vi.fn(async () => ({
        tabId: "tab-1", origin: target.origin, frameOrigins: [target.origin], teamSlug: target.teamSlug,
        projectName: "other-project", sessionStatus: "authenticated" as const, observedAt: NOW,
      })) }),
    }, "destination_denied"],
    ["login redirect", {
      browser: browserPort({ runVercelProjectJourney: vi.fn(async () => ({
        tabId: "tab-1", origin: target.origin, frameOrigins: [target.origin], teamSlug: target.teamSlug,
        projectName: target.projectName, sessionStatus: "login" as const, observedAt: NOW,
      })) }),
    }, "credential_expired"],
    ["cross-origin frame", {
      browser: browserPort({ runVercelProjectJourney: vi.fn(async () => ({
        tabId: "tab-1", origin: target.origin, frameOrigins: [target.origin, "https://evil.example"],
        teamSlug: target.teamSlug, projectName: target.projectName, sessionStatus: "authenticated" as const, observedAt: NOW,
      })) }),
    }, "destination_denied"],
    ["stale tab", {
      browser: browserPort({ runVercelProjectJourney: vi.fn(async () => ({ deniedReason: "stale_tab" as const })) }),
    }, "reconciliation_required"],
  ] as const)("fails closed for %s", async (_label, overrides, failureClass) => {
    const port = "browser" in overrides ? overrides.browser : browserPort();
    const executor = createVercelBrowserJourneyExecutor({
      browser: port,
      topology: "topology" in overrides ? overrides.topology : (() => topology),
      topologyKey: TOPOLOGY_KEY,
      lease: { isCurrent: () => true },
      clock: () => NOW,
    });

    const result = await executor.inspectBrowserVercel({ target, leaseId: "lease-1" });

    expect(result).toMatchObject({ outcome: "failed", failureClass });
    const runCount = vi.mocked(port.runVercelProjectJourney).mock.calls.length;
    expect(runCount).toBe(["wrong project", "login redirect", "cross-origin frame", "stale tab"].includes(_label) ? 1 : 0);
  });

  it("stops before browser control when the lease fence is lost", async () => {
    const port = browserPort();
    let checks = 0;
    const executor = createVercelBrowserJourneyExecutor({
      browser: port,
      topology: () => topology,
      topologyKey: TOPOLOGY_KEY,
      lease: { isCurrent: () => {
        checks += 1;
        return checks === 1;
      } },
      clock: () => NOW,
    });

    const result = await executor.inspectBrowserVercel({ target, leaseId: "lease-1" });

    expect(result).toMatchObject({ outcome: "failed", failureClass: "reconciliation_required" });
    expect(port.readStatus).toHaveBeenCalledOnce();
    expect(port.readGrants).not.toHaveBeenCalled();
    expect(port.runVercelProjectJourney).not.toHaveBeenCalled();
  });

  it("does not expose raw browser output or thrown secrets", async () => {
    const canary = "Q9z7_CANARY_69!secret";
    const port = browserPort({
      readStatus: vi.fn(async () => { throw new Error(canary); }),
    });
    const executor = createVercelBrowserJourneyExecutor({
      browser: port,
      topology: () => topology,
      topologyKey: TOPOLOGY_KEY,
      lease: { isCurrent: () => true },
      clock: () => NOW,
    });

    const result = await executor.inspectBrowserVercel({ target, leaseId: "lease-1" });

    assertCanaryAbsent(JSON.stringify(result), [canary]);
  });

  it("uses exact BB Browser argv and never accepts caller-supplied script controls", async () => {
    const calls: (readonly string[])[] = [];
    const invoke = vi.fn(async (argv: readonly string[]) => {
      calls.push(argv);
      if (argv[1] === "status") return {
        hostId: target.hostId,
        profileId: target.profileId,
        state: "ready",
        capabilities: BROWSER_REQUIRED_CAPABILITIES.map((id) => ({ id, status: "ready" })),
      };
      if (argv[1] === "grants") return { grants: [{
        id: grant.grantId, hostId: grant.hostId, profileId: grant.profileId, origin: grant.origin,
        state: grant.state, expiresAt: grant.expiresAt,
      }] };
      if (argv[1] === "open") return { tabId: "tab-1", url: argv[2] };
      return { result: {
        ok: true, origin: target.origin, frameOrigins: [target.origin], teamSlug: target.teamSlug,
        projectName: target.projectName, sessionStatus: "authenticated", observedAt: NOW,
      } };
    });
    const browser = createBbBrowserJourneyBrowserPort({ invoke });

    await browser.readStatus({ hostId: target.hostId, profileId: target.profileId });
    await browser.readGrants({ hostId: target.hostId, profileId: target.profileId });
    await browser.runVercelProjectJourney(target);

    expect(calls[0]).toEqual(["browser", "status", "--host", target.hostId, "--profile", target.profileId, "--json"]);
    expect(calls[1]).toEqual(["browser", "grants", "--host", target.hostId, "--profile", target.profileId, "--json"]);
    expect(calls[2]).toEqual([
      "browser", "open", "https://vercel.com/vercel-team/hanoon", "--host", target.hostId,
      "--profile", target.profileId,
      "--timeout", "15000", "--json",
    ]);
    expect(calls[3]?.slice(0, 2)).toEqual(["browser", "script"]);
    expect(calls[3]).toContain("--origin");
    expect(calls[3]).toContain(target.origin);
    expect(calls[3]).toContain("--host");
    expect(calls[3]).toContain(target.hostId);
    expect(calls[3]).toContain("--profile");
    expect(calls[3]).toContain(target.profileId);
    expect(calls[3]).toContain("--tab");
    expect(calls[3]).not.toContain("--screenshot");
    expect(calls[3]).not.toContain("--file-transfer");
    expect(calls[3]?.[calls[3]!.indexOf("--code") + 1]).toContain("EXPECTED_ORIGIN");
    expect(calls[3]?.[calls[3]!.indexOf("--code") + 1]).not.toContain("document.cookie");
  });

  it("keeps fixed journey denials typed and secret-free at the CLI boundary", async () => {
    const canary = "raw-browser-result-secret-canary-69";
    const invoke = vi.fn(async (argv: readonly string[]) => {
      if (argv[1] === "open") return { tabId: "tab-1", url: "https://vercel.com/vercel-team/hanoon" };
      return { result: { ok: false, reason: "cross_origin_frame", details: canary } };
    });
    const browser = createBbBrowserJourneyBrowserPort({ invoke });

    const result = await browser.runVercelProjectJourney(target);

    expect(result).toEqual({ deniedReason: "cross_origin_frame" });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it("serializes a profile lease, preserves the same lease on retry, and reclaims only after expiry", () => {
    const fixture = temporaryBrokerDatabase();
    const dataKey = new Uint8Array(32).fill(0x31);
    try {
      const foundation = new BrokerStore(fixture.db, {
        dataKey,
        auditKey: new Uint8Array(32).fill(0x32),
        clock: () => NOW,
      });
      foundation.addInstallation({
        installationId: "installation-1",
        clientCertificateFingerprint: "a".repeat(64),
        policyDigest: FOUNDATION_BROKER_POLICY_DIGEST,
        topologyReceiptDigest: "b".repeat(64),
        topologyReceiptExpiresAt: NOW + 100_000,
        expectedVaultId: "vault-1",
      });
      const store = new BrokerProtectedConnectorStore(fixture.db, { dataKey, clock: () => NOW });
      const first = store.claimBrowserProfile({
        installationId: "installation-1", requestId: "request-1", idempotencyKey: "idempotency-1",
        hostId: target.hostId, profileId: target.profileId, bindingGeneration: 1,
        fenceOwner: "executor-1", fenceGeneration: 1, leaseId: "lease-1", leaseExpiresAt: NOW + 10,
        now: NOW,
      });
      expect(first).toEqual({ outcome: "claimed", leaseId: "lease-1", leaseExpiresAt: NOW + 10 });
      expect(store.claimBrowserProfile({
        installationId: "installation-1", requestId: "request-2", idempotencyKey: "idempotency-2",
        hostId: target.hostId, profileId: target.profileId, bindingGeneration: 1,
        fenceOwner: "executor-2", fenceGeneration: 1, leaseId: "lease-2", leaseExpiresAt: NOW + 10,
        now: NOW,
      })).toEqual({ outcome: "busy" });
      expect(store.claimBrowserProfile({
        installationId: "installation-1", requestId: "request-1", idempotencyKey: "idempotency-1",
        hostId: target.hostId, profileId: target.profileId, bindingGeneration: 1,
        fenceOwner: "executor-1", fenceGeneration: 1, leaseId: "different-lease", leaseExpiresAt: NOW + 10,
        now: NOW,
      })).toEqual({ outcome: "already_held", leaseId: "lease-1", leaseExpiresAt: NOW + 10 });
      expect(store.isBrowserProfileLeaseCurrent({
        leaseId: "lease-1", installationId: "installation-1", requestId: "request-1",
        hostId: target.hostId, profileId: target.profileId, bindingGeneration: 1,
        fenceOwner: "executor-1", fenceGeneration: 1, now: NOW,
      })).toBe(true);
      expect(store.claimBrowserProfile({
        installationId: "installation-1", requestId: "request-2", idempotencyKey: "idempotency-2",
        hostId: target.hostId, profileId: target.profileId, bindingGeneration: 1,
        fenceOwner: "executor-2", fenceGeneration: 1, leaseId: "lease-2", leaseExpiresAt: NOW + 100,
        now: NOW + 10,
      })).toEqual({ outcome: "claimed", leaseId: "lease-2", leaseExpiresAt: NOW + 100 });
      expect(store.isBrowserProfileLeaseCurrent({
        leaseId: "lease-1", installationId: "installation-1", requestId: "request-1",
        hostId: target.hostId, profileId: target.profileId, bindingGeneration: 1,
        fenceOwner: "executor-1", fenceGeneration: 1, now: NOW + 10,
      })).toBe(false);
      const restarted = new BrokerProtectedConnectorStore(fixture.db, { dataKey, clock: () => NOW });
      expect(restarted.claimBrowserProfile({
        installationId: "installation-1", requestId: "request-2", idempotencyKey: "idempotency-2",
        hostId: target.hostId, profileId: target.profileId, bindingGeneration: 1,
        fenceOwner: "executor-2", fenceGeneration: 1, leaseId: "different-lease", leaseExpiresAt: NOW + 100,
        now: NOW,
      })).toEqual({ outcome: "already_held", leaseId: "lease-2", leaseExpiresAt: NOW + 100 });
    } finally {
      fixture.close();
    }
  });
});
