import { describe, expect, it, vi } from "vitest";

import {
  PROTECTED_CONNECTOR_POLICY_DIGEST,
  VERCEL_BROWSER_ORIGIN,
  type ProtectedConnectorBindingProjection,
} from "../src/credentials/connector-policy";
import {
  protectedConnectorCapabilityFor,
  protectedConnectorResponseDigest,
  type ProtectedConnectorRequestEnvelope,
  type ProtectedConnectorResponseEnvelope,
} from "../src/credentials/connector-protocol";
import {
  CAPABILITY_GRAPH_DIGEST,
  CAPABILITY_REGISTRY_DIGEST,
  capabilityDescriptorById,
} from "../src/capabilities/catalog";
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

function operationBinding(operation: ProtectedConnectorBindingProjection["operation"]): ProtectedConnectorBindingProjection {
  if (operation === "convex.project.inspect.v1") return binding;
  if (operation === "vercel.project.inspect.v1") return {
    ...binding,
    bindingId: "binding-vercel",
    operation,
    authorityProvider: "vercel",
    capabilityIds: [protectedConnectorCapabilityFor(operation)],
    audiences: ["api.vercel.com"],
  };
  return {
    ...binding,
    bindingId: "binding-browser",
    operation,
    bindingKind: "browser_session",
    authorityProvider: "bb_browser",
    secretProvider: "broker_session",
    capabilityIds: [protectedConnectorCapabilityFor(operation)],
    audiences: [],
    origins: [VERCEL_BROWSER_ORIGIN],
    scopes: [],
    mfaMode: "human_presence",
    state: "pending",
  };
}

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
    capabilityProfileRevision: 1,
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

  it("denies when the current full broker readiness is unavailable before dispatch", async () => {
    const call = vi.fn();
    const store = { listProtectedConnectorBindings: () => [binding] } as unknown as ProtectedConnectorAccessStore;
    const service = new ProtectedConnectorAccessService({
      store,
      client: () => ({ call }),
      config: () => config,
      trustKernelReady: () => true,
      topologyReady: () => true,
      browserAdministrationIsolated: () => false,
      auditWritable: () => true,
      projectPolicyDigest: () => PROTECTED_CONNECTOR_POLICY_DIGEST,
      fullReadiness: async () => ({ state: "unavailable" as const }),
      now: () => NOW,
    });

    const result = await service.inspect({
      operation: binding.operation,
      projectId: "project-1",
      bindingId: binding.bindingId,
      authorized,
    });

    expect(result).toEqual({ outcome: "denied", reason: "unavailable" });
    expect(call).not.toHaveBeenCalled();
  });

  it("uses one broker response and returns only the receipted identity", async () => {
    let current = binding;
    let preparedRequest: ProtectedConnectorRequestEnvelope | null = null;
    const events: string[] = [];
    const descriptor = capabilityDescriptorById("telegram_agent_convex_project_inspect")!;
    const profile = {
      id: "profile-1", subjectKind: "controller_turn" as const, subjectId: "turn-1", threadId: "thread-1",
      revision: 1, recipeId: "architectural", recipeVersion: 1,
      registryDigest: CAPABILITY_REGISTRY_DIGEST, graphDigest: CAPABILITY_GRAPH_DIGEST,
      mode: "active" as const, model: { pool: "standard" as const, providerId: "claude-code", modelId: "model", reasoning: "xhigh" as const, serviceTier: "default" as const },
      reasonCodes: [], traits: [], assignments: [{
        capabilityId: "telegram_agent_convex_project_inspect", capabilityKind: "connector" as const,
        descriptorDigest: descriptor.digest, mandatory: true,
      }], createdAt: NOW,
    };
    const selection = {
      id: "selection-1",
      profileId: "profile-1", profileRevision: 1, subjectKind: "controller_turn" as const, subjectId: "turn-1",
      capabilityId: "telegram_agent_convex_project_inspect", capabilityKind: "connector" as const, descriptorDigest: descriptor.digest,
      eventType: "selected" as const, reasonCode: "profile_selected", mandatory: true,
      outcome: null, evidenceRefs: [], createdAt: NOW,
    };
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
      getCapabilityProfileById: () => profile,
      listCapabilityReceipts: () => [selection],
      runControllerMutation: (_fence, mutation) => ({ outcome: "applied", mutationValue: mutation(NOW) }),
    };
    const service = new ProtectedConnectorAccessService({
      store,
      client: () => ({
        attestExecutorFence: async () => true,
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

  it("reuses the persisted envelope after an ambiguous broker call", async () => {
    let current = binding;
    let persisted: {
      request: ProtectedConnectorRequestEnvelope;
      state: "prepared" | "ambiguous" | "completed";
      receiptId: string | null;
      createdAt: number;
      updatedAt: number;
    } | null = null;
    const sent: ProtectedConnectorRequestEnvelope[] = [];
    const descriptor = capabilityDescriptorById("telegram_agent_convex_project_inspect")!;
    const profile = {
      id: "profile-1", subjectKind: "controller_turn" as const, subjectId: "turn-1", threadId: "thread-1",
      revision: 1, recipeId: "architectural", recipeVersion: 1,
      registryDigest: CAPABILITY_REGISTRY_DIGEST, graphDigest: CAPABILITY_GRAPH_DIGEST,
      mode: "active" as const, model: { pool: "standard" as const, providerId: "claude-code", modelId: "model", reasoning: "xhigh" as const, serviceTier: "default" as const },
      reasonCodes: [], traits: [], assignments: [{
        capabilityId: "telegram_agent_convex_project_inspect", capabilityKind: "connector" as const,
        descriptorDigest: descriptor.digest, mandatory: true,
      }], createdAt: NOW,
    };
    const selection = {
      id: "selection-1",
      profileId: "profile-1", profileRevision: 1, subjectKind: "controller_turn" as const, subjectId: "turn-1",
      capabilityId: "telegram_agent_convex_project_inspect", capabilityKind: "connector" as const, descriptorDigest: descriptor.digest,
      eventType: "selected" as const, reasonCode: "profile_selected", mandatory: true,
      outcome: null, evidenceRefs: [], createdAt: NOW,
    };
    const store: ProtectedConnectorAccessStore = {
      listProtectedConnectorBindings: () => [current],
      getProtectedConnectorBinding: () => current,
      getProtectedConnectorOperation: () => persisted,
      prepareProtectedConnectorOperation: ({ request }) => {
        persisted ??= { request, state: "prepared", receiptId: null, createdAt: NOW, updatedAt: NOW };
        return { outcome: persisted.state, operation: persisted };
      },
      completeProtectedConnectorOperation: ({ response }) => {
        persisted = { ...persisted!, state: "completed", receiptId: response.receiptId, updatedAt: NOW + 1 };
        current = { ...current, state: "active", verifiedAt: NOW + 1 };
        return {
          outcome: "completed",
          operation: persisted,
          receipt: {
            receiptId: response.receiptId!,
            installationId: response.installationId,
            requestId: response.requestId,
            idempotencyKey: persisted.request.idempotencyKey,
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
      markProtectedConnectorOperationAmbiguous: () => {
        persisted = persisted ? { ...persisted, state: "ambiguous" } : null;
        return persisted;
      },
      getProtectedConnectorReceipt: () => null,
      getCapabilityProfileById: () => profile,
      listCapabilityReceipts: () => [selection],
      runControllerMutation: (_fence, mutation) => ({ outcome: "applied", mutationValue: mutation(NOW) }),
    };
    let calls = 0;
    const service = new ProtectedConnectorAccessService({
      store,
      client: () => ({
        attestExecutorFence: async () => true,
        call: vi.fn(async (request: ProtectedConnectorRequestEnvelope) => {
          sent.push(request);
          calls += 1;
          return calls === 1
            ? { outcome: "ambiguous" as const }
            : { outcome: "succeeded" as const, response: requestFrom(request) };
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

    await expect(service.inspect({ operation: binding.operation, projectId: "project-1", bindingId: binding.bindingId, authorized }))
      .resolves.toMatchObject({ outcome: "ambiguous" });
    await expect(service.inspect({ operation: binding.operation, projectId: "project-1", bindingId: binding.bindingId, authorized }))
      .resolves.toMatchObject({ outcome: "succeeded" });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });

  it("denies missing selected connector evidence before the broker caller", async () => {
    const call = vi.fn();
    const store = {
      listProtectedConnectorBindings: () => [binding],
      getCapabilityProfileById: () => null,
      listCapabilityReceipts: () => [],
    } as unknown as ProtectedConnectorAccessStore;
    const service = new ProtectedConnectorAccessService({
      store,
      client: () => ({ call }),
      config: () => config,
      trustKernelReady: () => true,
      topologyReady: () => true,
      browserAdministrationIsolated: () => false,
      auditWritable: () => true,
      projectPolicyDigest: () => PROTECTED_CONNECTOR_POLICY_DIGEST,
      now: () => NOW,
    });

    await expect(service.inspect({
      operation: binding.operation,
      projectId: "project-1",
      bindingId: binding.bindingId,
      authorized,
    })).resolves.toEqual({ outcome: "denied", reason: "capability_evidence_missing" });
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", "convex.project.inspect.v1"],
    ["stale", "convex.project.inspect.v1"],
    ["missing", "vercel.project.inspect.v1"],
    ["stale", "vercel.project.inspect.v1"],
    ["missing", "browser.vercel_project.inspect.v1"],
    ["stale", "browser.vercel_project.inspect.v1"],
  ] as const)("requires a %s selected receipt for the operation-specific %s assignment", async (evidenceState, operation) => {
    const candidate = operationBinding(operation);
    const call = vi.fn();
    const selectedReceipts = evidenceState === "missing" ? [] : [{
      id: "stale-selection",
      profileId: "profile-1",
      profileRevision: 0,
      subjectKind: "controller_turn" as const,
      subjectId: "turn-1",
      capabilityId: protectedConnectorCapabilityFor(operation),
      capabilityKind: "connector" as const,
      descriptorDigest: capabilityDescriptorById(protectedConnectorCapabilityFor(operation))!.digest,
      eventType: "selected" as const,
      reasonCode: "profile_selected",
      mandatory: true,
      outcome: null,
      evidenceRefs: [],
      createdAt: NOW,
    }];
    const store = {
      listProtectedConnectorBindings: () => [candidate],
      getCapabilityProfileById: () => ({
        id: "profile-1",
        subjectKind: "controller_turn" as const,
        subjectId: "turn-1",
        revision: 1,
        mode: "active" as const,
        registryDigest: CAPABILITY_REGISTRY_DIGEST,
        graphDigest: CAPABILITY_GRAPH_DIGEST,
        assignments: [{
          capabilityId: protectedConnectorCapabilityFor(operation),
          capabilityKind: "connector" as const,
          descriptorDigest: capabilityDescriptorById(protectedConnectorCapabilityFor(operation))!.digest,
          mandatory: true,
        }],
      }),
      listCapabilityReceipts: () => selectedReceipts,
    } as unknown as ProtectedConnectorAccessStore;
    const service = new ProtectedConnectorAccessService({
      store,
      client: () => ({ call }),
      config: () => config,
      trustKernelReady: () => true,
      topologyReady: () => true,
      browserAdministrationIsolated: () => operation === "browser.vercel_project.inspect.v1",
      auditWritable: () => true,
      projectPolicyDigest: () => PROTECTED_CONNECTOR_POLICY_DIGEST,
      now: () => NOW,
    });

    await expect(service.inspect({
      operation,
      projectId: "project-1",
      bindingId: candidate.bindingId,
      authorized,
    })).resolves.toEqual({ outcome: "denied", reason: "capability_evidence_missing" });
    expect(call).not.toHaveBeenCalled();
  });
});
