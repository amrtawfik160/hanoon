import { describe, expect, it } from "vitest";
import {
  createProtectedConnectorExecutor,
  type ProtectedConnectorCredentialResolver,
  type ProtectedConnectorProviderHttpPort,
} from "../broker/src/provider-connectors";
import type { ConvexProjectTarget, VercelProjectTarget } from "../src/credentials/connector-policy";

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
            account: { id: "team-id", slug: "team-slug" },
            framework: "nextjs",
            latestDeployments: [{ state: "READY" }],
          }),
        };
      },
    };
    const executor = createProtectedConnectorExecutor({ http, credentials: resolver(), connectorVersion: "vercel-1" });

    const result = await executor.inspectVercel({ target: vercelTarget, credentialReference: "broker-ref" });

    expect(result).toMatchObject({ outcome: "succeeded", identity: { projectId: "vercel-project-id", status: "ready" } });
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
});
