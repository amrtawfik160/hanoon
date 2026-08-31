import { describe, expect, it, vi } from "vitest";

import {
  PROTECTED_CONNECTOR_POLICY_DIGEST,
  type ProtectedConnectorBindingProjection,
} from "../src/credentials/connector-policy";
import {
  protectedConnectorCapabilityFor,
  protectedConnectorResponseDigest,
  type ProtectedConnectorRequestEnvelope,
  type ProtectedConnectorResponseEnvelope,
} from "../src/credentials/connector-protocol";
import { ProtectedConnectorAccessService, type ProtectedConnectorAccessStore } from "../src/credentials/protected-connector-service";
import type { CredentialBrokerConfigResult } from "../src/credentials/config";

const NOW = 1_800_000_000_000;

const binding: ProtectedConnectorBindingProjection = {
  schemaVersion: 2,
  installationId: "installation-1",
  bindingId: "binding-convex",
  operation: "convex.project.inspect.v1",
  bindingKind: "workload_identity",
  authorityProvider: "convex",
  secretProvider: "provider_native",
  principalLabel: "Employee",
  capabilityIds: ["telegram_agent_convex_project_inspect"],
  audiences: ["api.convex.dev"],
  origins: [],
  scopes: ["project:read"],
  riskClass: "low",
  mfaMode: "workload_identity",
  approvalMode: "standing_policy",
  state: "vault_verified",
  generation: 1,
  verifiedAt: null,
  expiresAt: null,
};

const config = {
  state: "isolated",
  value: { installationId: "installation-1" },
} as CredentialBrokerConfigResult;

const authorized = {
  controller: { controllerKey: "controller-1", threadId: "thread-1", projectId: "project-1" },
  turn: {
    id: "turn-1",
    origin: "owner",
    submittedAt: NOW,
    capabilityProfileId: "profile-1",
  },
  fence: { ownerId: "executor-1", generation: 1, now: NOW },
} as never;

function requestFrom(responseRequest: ProtectedConnectorRequestEnvelope): ProtectedConnectorResponseEnvelope {
  return {
    schemaVersion: 2,
    installationId: responseRequest.installationId,
    requestId: responseRequest.requestId,
    operation: responseRequest.operation,
    outcome: "succeeded",
    result: {
      projectId: "convex-project-id",
      projectSlug: "hanoon",
      teamId: "team-id",
      teamSlug: "team-slug",
      status: "active",
      connectorVersion: "convex-1",
      observedAt: NOW + 1,
    },
    failureClass: null,
    retryable: false,
    retryAfterMs: null,
    receiptId: "receipt-1",
    completedAt: NOW + 1,
  } as ProtectedConnectorResponseEnvelope;
}

describe("protected connector Hanoon boundary", () => {
  it("denies unsafe readiness before asking the broker", async () => {
    const call = vi.fn();
    const store = { listProtectedConnectorBindings: () => [binding] } as unknown as ProtectedConnectorAccessStore;
    const service = new ProtectedConnectorAccessService({
      store,
      client: () => ({ call }),
      config: () => config,
      trustKernelReady: () => false,
      topologyReady: () => true,
      browserAdministrationIsolated: () => false,
      auditWritable: () => true,
      projectPolicyDigest: () => PROTECTED_CONNECTOR_POLICY_DIGEST,
      now: () => NOW,
    });

    const result = await service.inspect({
      operation: binding.operation,
      projectId: "project-1",
      bindingId: binding.bindingId,
      authorized,
    });

    expect(result).toEqual({ outcome: "denied", reason: "unsafe_topology" });
    expect(call).not.toHaveBeenCalled();
  });

  it("uses one broker response and returns only the receipted identity", async () => {
    let current = binding;
    let preparedRequest: ProtectedConnectorRequestEnvelope | null = null;
    const events: string[] = [];
    const store: ProtectedConnectorAccessStore = {
      listProtectedConnectorBindings: () => [current],
      getProtectedConnectorBinding: () => current,
      prepareProtectedConnectorOperation: ({ request }) => {
        preparedRequest = request;
        return {
          outcome: "prepared",
          operation: { request, state: "prepared", receiptId: null, createdAt: NOW, updatedAt: NOW },
        };
      },
      completeProtectedConnectorOperation: ({ response }) => {
        events.push("complete");
        current = { ...current, state: "active", verifiedAt: NOW + 1 };
        return {
          outcome: "completed",
          operation: { request: preparedRequest!, state: "completed", receiptId: response.receiptId, createdAt: NOW, updatedAt: NOW + 1 },
          receipt: {
            receiptId: response.receiptId!,
            installationId: response.installationId,
            requestId: response.requestId,
            idempotencyKey: preparedRequest?.idempotencyKey ?? "",
            operation: response.operation,
            bindingId: binding.bindingId,
            bindingGeneration: 1,
            taskId: "turn-1",
            projectId: "project-1",
            capabilityId: protectedConnectorCapabilityFor(binding.operation),
            policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
            fenceOwner: "executor-1",
            fenceGeneration: 1,
            outcome: "succeeded",
            failureClass: null,
            retryable: false,
            retryAfterMs: null,
            identity: response.result,
            responseSha256: protectedConnectorResponseDigest(response),
            completedAt: response.completedAt,
            createdAt: NOW + 1,
          },
        };
      },
      markProtectedConnectorOperationAmbiguous: () => null,
      getProtectedConnectorReceipt: () => null,
      runControllerMutation: (_fence, mutation) => ({ outcome: "applied", mutationValue: mutation(NOW) }),
    };
    const service = new ProtectedConnectorAccessService({
      store,
      client: () => ({
        call: vi.fn(async (request: ProtectedConnectorRequestEnvelope) => {
          events.push("provider-response");
          return { outcome: "succeeded", response: requestFrom(request) } as const;
        }),
      }),
      config: () => config,
      trustKernelReady: () => true,
      topologyReady: () => true,
      browserAdministrationIsolated: () => false,
      auditWritable: () => true,
      projectPolicyDigest: () => PROTECTED_CONNECTOR_POLICY_DIGEST,
      now: () => NOW,
    });

    const result = await service.inspect({
      operation: binding.operation,
      projectId: "project-1",
      bindingId: binding.bindingId,
      authorized,
    });

    expect(result).toMatchObject({ outcome: "succeeded", receiptId: "receipt-1", identity: { projectSlug: "hanoon" } });
    expect(events).toEqual(["provider-response", "complete"]);
    expect(JSON.stringify(result)).not.toContain("token");
  });
});
