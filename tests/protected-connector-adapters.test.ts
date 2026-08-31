import { describe, expect, it } from "vitest";
import https from "node:https";
import {
  createProtectedConnectorExecutor,
  createProtectedConnectorProviderHttpPort,
  type ProtectedConnectorCredentialResolver,
  type ProtectedConnectorProviderHttpPort,
} from "../broker/src/provider-connectors";
import type { ConvexProjectTarget, VercelProjectTarget } from "../src/credentials/connector-policy";
import { createMtlsFixture } from "./support/mtls-fixtures";

const TOKEN = "provider-token-canary";

const convexTarget: ConvexProjectTarget = {
  operation: "convex.project.inspect.v1",
  teamIdOrSlug: "team-slug",
  projectSlug: "hanoon",
};

const vercelTarget: VercelProjectTarget = {
  operation: "vercel.project.inspect.v1",
  teamId: "team-id",
  projectIdOrName: "hanoon",
};

function resolver(): ProtectedConnectorCredentialResolver {
  return { resolve: async () => ({ outcome: "resolved", token: TOKEN }) };
}

describe("protected provider identity adapters", () => {
  it("uses the fixed local TLS transport and terminates a stalled provider request", async () => {
    const tls = createMtlsFixture();
    let server: https.Server | null = null;
    try {
      server = https.createServer({ key: tls.serverPrivateKeyPem, cert: tls.serverCertificatePem }, (request, response) => {
        if (request.url !== "/v1/teams/team-slug/projects/hanoon") {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          id: "convex-project-id",
          slug: "hanoon",
          teamId: "team-id",
          teamSlug: "team-slug",
          status: "active",
        }));
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("provider_test_address_missing");
      const executor = createProtectedConnectorExecutor({
        http: createProtectedConnectorProviderHttpPort({
          port: address.port,
          caCertificatePem: tls.caCertificatePem,
          servername: "broker.test",
          lookup: (_hostname, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]),
          timeoutMs: 5_000,
        }),
        credentials: resolver(),
      });
      const result = await executor.inspectConvex({ target: convexTarget, credentialReference: "broker-ref" });
      expect(result).toMatchObject({ outcome: "succeeded", identity: { projectId: "convex-project-id" } });

      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
      server = https.createServer({ key: tls.serverPrivateKeyPem, cert: tls.serverCertificatePem }, () => {
        // Deliberately hold the response open; the adapter must destroy it at its deadline.
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const stalledAddress = server.address();
      if (!stalledAddress || typeof stalledAddress === "string") throw new Error("provider_test_address_missing");
      const stalledExecutor = createProtectedConnectorExecutor({
        http: createProtectedConnectorProviderHttpPort({
          port: stalledAddress.port,
          caCertificatePem: tls.caCertificatePem,
          servername: "broker.test",
          lookup: (_hostname, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]),
          timeoutMs: 25,
        }),
        credentials: resolver(),
      });
      await expect(stalledExecutor.inspectConvex({ target: convexTarget, credentialReference: "broker-ref" }))
        .resolves.toMatchObject({ outcome: "failed", failureClass: "provider_unavailable" });
    } finally {
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
      tls.cleanup();
    }
  });

  it("uses the fixed local TLS transport for Vercel and rejects a bad SNI", async () => {
    const tls = createMtlsFixture();
    let server: https.Server | null = null;
    try {
      server = https.createServer({ key: tls.serverPrivateKeyPem, cert: tls.serverCertificatePem }, (request, response) => {
        if (request.url !== "/v9/projects/hanoon?teamId=team-id") {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          id: "vercel-project-id",
          name: "hanoon",
          accountId: "team-id",
          framework: "nextjs",
          latestDeployments: [{ readyState: "READY" }],
        }));
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("provider_test_address_missing");
      const options = {
        port: address.port,
        caCertificatePem: tls.caCertificatePem,
        servername: "broker.test",
        lookup: (_hostname: string, _options: object, callback: (error: null, addresses: { address: string; family: number }[]) => void) =>
          callback(null, [{ address: "127.0.0.1", family: 4 }]),
      };
      const executor = createProtectedConnectorExecutor({
        http: createProtectedConnectorProviderHttpPort(options),
        credentials: resolver(),
      });
      await expect(executor.inspectVercel({ target: vercelTarget, credentialReference: "broker-ref" }))
        .resolves.toMatchObject({ outcome: "succeeded", identity: { projectId: "vercel-project-id", teamId: "team-id" } });

      const badSniExecutor = createProtectedConnectorExecutor({
        http: createProtectedConnectorProviderHttpPort({ ...options, servername: "wrong.test" }),
        credentials: resolver(),
      });
      await expect(badSniExecutor.inspectVercel({ target: vercelTarget, credentialReference: "broker-ref" }))
        .resolves.toMatchObject({ outcome: "failed", failureClass: "provider_unavailable" });
    } finally {
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
      tls.cleanup();
    }
  });

  it("calls the fixed Convex operation and returns only the bounded identity", async () => {
    const calls: unknown[] = [];
    const http: ProtectedConnectorProviderHttpPort = {
      getConvexProject: async (input) => {
        calls.push(input);
        return {
          statusCode: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: "convex-project-id",
            slug: "hanoon",
            teamId: "team-id",
            teamSlug: "team-slug",
            deploymentStatus: "active",
            secret: TOKEN,
          }),
        };
      },
      getVercelProject: async () => { throw new Error("unused"); },
    };
    const executor = createProtectedConnectorExecutor({ http, credentials: resolver(), connectorVersion: "convex-1" });

    const result = await executor.inspectConvex({ target: convexTarget, credentialReference: "broker-ref" });

    expect(result).toMatchObject({
      outcome: "succeeded",
      identity: {
        projectId: "convex-project-id",
        projectSlug: "hanoon",
        teamId: "team-id",
        teamSlug: "team-slug",
        status: "active",
        connectorVersion: "convex-1",
      },
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(calls).toEqual([{
      path: "/v1/teams/team-slug/projects/hanoon",
      authorization: `Bearer ${TOKEN}`,
    }]);
  });

  it("calls the fixed Vercel operation with the enrolled team query", async () => {
    const calls: unknown[] = [];
    const http: ProtectedConnectorProviderHttpPort = {
      getConvexProject: async () => { throw new Error("unused"); },
      getVercelProject: async (input) => {
        calls.push(input);
        return {
          statusCode: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: "vercel-project-id",
            name: "hanoon",
            accountId: "team-id",
            framework: "nextjs",
            latestDeployments: [{ readyState: "READY" }],
          }),
        };
      },
    };
    const executor = createProtectedConnectorExecutor({ http, credentials: resolver(), connectorVersion: "vercel-1" });

    const result = await executor.inspectVercel({ target: vercelTarget, credentialReference: "broker-ref" });

    expect(result).toMatchObject({
      outcome: "succeeded",
      identity: { projectId: "vercel-project-id", teamId: "team-id", status: "ready" },
    });
    expect(JSON.stringify(result)).not.toContain("teamSlug");
    expect(calls).toEqual([{
      path: "/v9/projects/hanoon?teamId=team-id",
      authorization: `Bearer ${TOKEN}`,
    }]);
  });

  it.each([
    [401, "credential_invalid"],
    [403, "scope_insufficient"],
    [404, "destination_denied"],
    [302, "destination_denied"],
    [429, "provider_rate_limited"],
    [503, "provider_unavailable"],
  ] as const)("maps provider status %s to %s without returning the body", async (statusCode, failureClass) => {
    const http: ProtectedConnectorProviderHttpPort = {
      getConvexProject: async () => ({
        statusCode,
        contentType: "application/json",
        body: JSON.stringify({ error: TOKEN }),
      }),
      getVercelProject: async () => { throw new Error("unused"); },
    };
    const executor = createProtectedConnectorExecutor({ http, credentials: resolver() });

    const result = await executor.inspectConvex({ target: convexTarget, credentialReference: "broker-ref" });

    expect(result).toMatchObject({ outcome: "failed", failureClass });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("rejects malformed and oversized success bodies as ambiguous identity", async () => {
    const http: ProtectedConnectorProviderHttpPort = {
      getConvexProject: async () => ({
        statusCode: 200,
        contentType: "application/json",
        body: "{" + "x".repeat(64 * 1024),
      }),
      getVercelProject: async () => { throw new Error("unused"); },
    };
    const executor = createProtectedConnectorExecutor({ http, credentials: resolver(), clock: () => 1_800_000_000_000 });

    const result = await executor.inspectConvex({ target: convexTarget, credentialReference: "broker-ref" });

    expect(result).toMatchObject({ outcome: "failed", failureClass: "result_ambiguous" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("returns stable resolver failures before provider I/O", async () => {
    let calls = 0;
    const http: ProtectedConnectorProviderHttpPort = {
      getConvexProject: async () => { calls += 1; throw new Error("must not call"); },
      getVercelProject: async () => { throw new Error("unused"); },
    };
    const credentials: ProtectedConnectorCredentialResolver = {
      resolve: async () => ({
        outcome: "failed",
        failureClass: "credential_expired",
        retryable: false,
        retryAfterMs: null,
      }),
    };
    const executor = createProtectedConnectorExecutor({ http, credentials });

    const result = await executor.inspectConvex({ target: convexTarget, credentialReference: "broker-ref" });

    expect(result).toMatchObject({ outcome: "failed", failureClass: "credential_expired" });
    expect(calls).toBe(0);
  });

  it("bounds credential resolution with the same cancellation as transport", async () => {
    let providerCalls = 0;
    const http: ProtectedConnectorProviderHttpPort = {
      getConvexProject: async () => { providerCalls += 1; throw new Error("must not call"); },
      getVercelProject: async () => { throw new Error("unused"); },
    };
    const credentials: ProtectedConnectorCredentialResolver = {
      resolve: () => new Promise(() => undefined),
    };
    const executor = createProtectedConnectorExecutor({ http, credentials });
    const controller = new AbortController();
    const pending = executor.inspectConvex({
      target: convexTarget,
      credentialReference: "broker-ref",
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      outcome: "failed",
      failureClass: "provider_unavailable",
    });
    expect(providerCalls).toBe(0);
  });
});
