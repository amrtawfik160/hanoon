import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupProtectedConnectorIntegrationFixtures,
  createProtectedConnectorIntegrationHarness,
  INTEGRATION_BINDING_ID,
  INTEGRATION_PROJECT_ID,
} from "./support/protected-connector-integration-harness";
import { ProtectedConnectorAuthorityService } from "../broker/src/connector-authority-service";
import { PROTECTED_CONNECTOR_POLICY_DIGEST } from "../src/credentials/connector-policy";
import { protectedConnectorRequestDigest } from "../src/credentials/connector-protocol";
import { assertCanaryAbsent, sqliteCanarySurfaces } from "./support/credential-broker-fixtures";

afterAll(() => cleanupProtectedConnectorIntegrationFixtures());

describe("protected connector production composition", () => {
  const inspect = (harness: Awaited<ReturnType<typeof createProtectedConnectorIntegrationHarness>>, signal: AbortSignal) =>
    harness.hostHarness.behavior.callAgentTool(
      "telegram_agent_connector_inspect",
      {
        projectId: INTEGRATION_PROJECT_ID,
        operation: "convex.project.inspect.v1",
        bindingId: INTEGRATION_BINDING_ID,
      },
      { threadId: harness.controllerThreadId, projectId: INTEGRATION_PROJECT_ID, signal },
    );

  const parsed = (raw: unknown): { outcome: string; failureClass?: string } =>
    (typeof raw === "string" ? JSON.parse(raw) : raw) as { outcome: string; failureClass?: string };

  it("crosses the selected controller receipt, authenticated projection, broker TLS, provider TLS, and one-effect replay", async () => {
    const harness = await createProtectedConnectorIntegrationHarness();
    try {
      const turn = harness.hanoon.getControllerTurn(harness.turnId);
      if (!turn?.capabilityProfileId) throw new Error("integration_profile_missing");
      const profile = harness.hanoon.getCapabilityProfileById(turn.capabilityProfileId);
      expect(profile?.assignments).toEqual(expect.arrayContaining([
        expect.objectContaining({
          capabilityId: "telegram_agent_convex_project_inspect",
          mandatory: true,
        }),
      ]));
      expect(harness.hanoon.listCapabilityReceipts(turn.capabilityProfileId, 64)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          capabilityId: "telegram_agent_convex_project_inspect",
          eventType: "selected",
        }),
      ]));
      expect(harness.hanoon.getProtectedConnectorBinding(
        "installation-integration",
        INTEGRATION_BINDING_ID,
      )).toMatchObject({ bindingId: INTEGRATION_BINDING_ID, state: "vault_verified" });

      const firstRaw = await inspect(harness, new AbortController().signal);
      const first = (typeof firstRaw === "string" ? JSON.parse(firstRaw) : firstRaw) as {
        outcome: string;
        identity?: { projectId: string };
        receiptId?: string;
      };
      expect(first).toMatchObject({
        outcome: "succeeded",
        identity: { projectId: "convex-project-id" },
      });
      expect(first.receiptId).toBeTruthy();
      expect(harness.providerCalls).toEqual(["GET /v1/teams/team-slug/projects/hanoon"]);

      const secondRaw = await inspect(harness, new AbortController().signal);
      const second = (typeof secondRaw === "string" ? JSON.parse(secondRaw) : secondRaw) as {
        outcome: string;
        receiptId?: string;
      };
      expect(second).toMatchObject({ outcome: "succeeded", receiptId: first.receiptId });
      expect(harness.providerCalls).toHaveLength(1);
      expect(harness.hanoon.getProtectedConnectorBinding(
        "installation-integration",
        INTEGRATION_BINDING_ID,
      )).toMatchObject({ state: "active" });
      expect(harness.brokerDatabase.db.prepare(
        "SELECT count(*) AS count FROM broker_connector_receipts WHERE installation_id = ?",
      ).get("installation-integration")).toEqual({ count: 1 });
    } finally {
      await harness.close();
    }
  });

  it("persists a provider failure and reuses one ambiguous envelope across broker restart", async () => {
    const failedHarness = await createProtectedConnectorIntegrationHarness({ providerMode: "failure" });
    try {
      const failed = parsed(await inspect(failedHarness, new AbortController().signal));
      expect(failed).toMatchObject({ outcome: "failed", failureClass: "provider_unavailable" });
      expect(failedHarness.providerCalls).toHaveLength(1);
    } finally {
      await failedHarness.close();
    }

    const harness = await createProtectedConnectorIntegrationHarness({ providerMode: "stall" });
    try {
      const controller = new AbortController();
      const call = inspect(harness, controller.signal);
      const deadline = Date.now() + 2_000;
      while (harness.providerCalls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(harness.providerCalls).toHaveLength(1);
      controller.abort();
      expect(parsed(await call).outcome).toBe("ambiguous");
      const beforeRestart = harness.hanoon.getProtectedConnectorOperation?.({
        installationId: "installation-integration",
        bindingId: INTEGRATION_BINDING_ID,
        operation: "convex.project.inspect.v1",
        bindingGeneration: 1,
        taskId: harness.turnId,
        projectId: INTEGRATION_PROJECT_ID,
        fenceOwner: "executor-integration",
        fenceGeneration: 1,
      });
      const brokerRequestBeforeRestart = harness.brokerDatabase.db.prepare(
        "SELECT request_id, idempotency_key, request_digest FROM broker_connector_requests WHERE installation_id = ?",
      ).get("installation-integration");
      if (!beforeRestart) throw new Error("integration_operation_missing_before_restart");
      expect(brokerRequestBeforeRestart).toEqual({
        request_id: beforeRestart.request.requestId,
        idempotency_key: beforeRestart.request.idempotencyKey,
        request_digest: protectedConnectorRequestDigest(beforeRestart.request),
      });

      await harness.restartBrokerAuthority();
      const restarted = parsed(await inspect(harness, new AbortController().signal));
      expect(restarted).toMatchObject({ outcome: "failed", failureClass: "result_ambiguous" });
      expect(harness.providerCalls).toHaveLength(1);
      const brokerRequestAfterRestart = harness.brokerDatabase.db.prepare(
        "SELECT request_id, idempotency_key, request_digest FROM broker_connector_requests WHERE installation_id = ?",
      ).get("installation-integration");
      expect(brokerRequestAfterRestart).toEqual(brokerRequestBeforeRestart);
      expect(harness.hanoon.getProtectedConnectorOperation?.({
        installationId: "installation-integration",
        bindingId: INTEGRATION_BINDING_ID,
        operation: "convex.project.inspect.v1",
        bindingGeneration: 1,
        taskId: harness.turnId,
        projectId: INTEGRATION_PROJECT_ID,
        fenceOwner: "executor-integration",
        fenceGeneration: 1,
      })?.request).toEqual(beforeRestart.request);
    } finally {
      harness.releaseStalledProvider();
      await harness.close();
    }
  });

  it("denies a claimed request until the independently attested fence exists", async () => {
    const harness = await createProtectedConnectorIntegrationHarness();
    try {
      const request = {
        schemaVersion: 2 as const,
        installationId: "installation-integration",
        requestId: "request-without-fence",
        idempotencyKey: "idempotency-without-fence",
        nonce: "nonce-without-fence",
        operation: "convex.project.inspect.v1" as const,
        bindingId: INTEGRATION_BINDING_ID,
        bindingGeneration: 1,
        taskId: "task-without-fence",
        projectId: INTEGRATION_PROJECT_ID,
        capabilityId: "telegram_agent_convex_project_inspect" as const,
        policyDigest: PROTECTED_CONNECTOR_POLICY_DIGEST,
        fenceOwner: "unattested-executor",
        fenceGeneration: 1,
        issuedAt: 1_800_000_000_000,
        deadlineAt: 1_800_000_010_000,
      };
      const result = await new ProtectedConnectorAuthorityService({
        foundationStore: harness.broker,
        connectorStore: harness.connectors,
        executor: {
          inspectConvex: async () => { throw new Error("must not dispatch"); },
          inspectVercel: async () => { throw new Error("unused"); },
        },
        authority: {
          topologyReady: () => true,
          auditWritable: () => true,
          fenceCurrent: (input) => harness.broker.isExecutorFenceCurrent({ ...input, now: 1_800_000_000_000 }),
        },
        clock: () => 1_800_000_000_000,
      }).execute({
        certificateFingerprint: harness.broker.getInstallation("installation-integration")!.clientCertificateFingerprint,
        request,
        now: 1_800_000_000_000,
      });
      expect(result).toMatchObject({ outcome: "failed", failureClass: "request_rejected" });
      expect(harness.providerCalls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("keeps a provider-token canary out of controller, receipts, stores, and transport evidence", async () => {
    const canary = "TOK-INTEGRATION-CANARY-68";
    const harness = await createProtectedConnectorIntegrationHarness({ credentialToken: canary });
    const errorHarness = await createProtectedConnectorIntegrationHarness({ credentialToken: canary, credentialError: canary });
    const artifactDirectory = mkdtempSync(join(tmpdir(), "protected-connector-canary-"));
    try {
      const result = await inspect(harness, new AbortController().signal);
      const errorResult = await inspect(errorHarness, new AbortController().signal);
      const artifactPath = join(artifactDirectory, "canary-evidence.json");
      writeFileSync(artifactPath, JSON.stringify({
        argv: process.argv,
        result,
        errorResult,
        providerTransport: harness.providerCalls,
        resolverErrorTransport: errorHarness.providerCalls,
        logs: harness.hostHarness.inspection.logEntries,
        errors: [errorResult],
        threadOutput: [result, errorResult],
        receipts: {
          broker: harness.brokerDatabase.db.prepare("SELECT * FROM broker_connector_receipts").all(),
          hanoon: harness.bb.storage.database().prepare("SELECT * FROM credential_connector_receipts").all(),
        },
      }));
      assertCanaryAbsent([
        { name: "controller-result", value: typeof result === "string" ? result : JSON.stringify(result) },
        { name: "resolver-error-result", value: typeof errorResult === "string" ? errorResult : JSON.stringify(errorResult) },
        { name: "argv", value: JSON.stringify(process.argv) },
        { name: "provider-evidence", value: JSON.stringify(harness.providerCalls) },
        { name: "resolver-error-provider-evidence", value: JSON.stringify(errorHarness.providerCalls) },
        { name: "logs", value: JSON.stringify(harness.hostHarness.inspection.logEntries) },
        { name: "resolver-error-logs", value: JSON.stringify(errorHarness.hostHarness.inspection.logEntries) },
        { name: "errors", value: JSON.stringify([errorResult]) },
        { name: "thread-output", value: JSON.stringify([result, errorResult]) },
        { name: "receipts", value: JSON.stringify({
          broker: harness.brokerDatabase.db.prepare("SELECT * FROM broker_connector_receipts").all(),
          hanoon: harness.bb.storage.database().prepare("SELECT * FROM credential_connector_receipts").all(),
        }) },
        { name: "test-artifact", path: artifactPath },
        ...sqliteCanarySurfaces(harness.brokerDatabase.databasePath, "broker"),
        ...sqliteCanarySurfaces(harness.bb.storage.database().name, "hanoon"),
      ], [canary]);
      expect(parsed(errorResult)).toMatchObject({ outcome: "failed", failureClass: "provider_unavailable" });
      expect(errorHarness.providerCalls).toHaveLength(0);
      expect(typeof result).toBe("string");
    } finally {
      await harness.close();
      await errorHarness.close();
      rmSync(artifactDirectory, { recursive: true, force: true });
    }
  });

  it("closes the real composed path on audit failure before provider I/O and on receipt persistence failure", async () => {
    const auditHarness = await createProtectedConnectorIntegrationHarness({ auditWritable: false });
    try {
      const denied = parsed(await inspect(auditHarness, new AbortController().signal));
      expect(denied).toMatchObject({ outcome: "failed", failureClass: "receipt_persistence_failed" });
      expect(auditHarness.providerCalls).toHaveLength(0);
    } finally {
      await auditHarness.close();
    }

    const persistenceHarness = await createProtectedConnectorIntegrationHarness();
    try {
      persistenceHarness.brokerDatabase.db.exec(`
        CREATE TRIGGER fail_connector_receipt BEFORE INSERT ON broker_connector_receipts
        BEGIN SELECT RAISE(ABORT, 'receipt persistence test'); END
      `);
      const failed = parsed(await inspect(persistenceHarness, new AbortController().signal));
      expect(failed).toMatchObject({ outcome: "failed", failureClass: "receipt_persistence_failed" });
      expect(persistenceHarness.providerCalls).toHaveLength(1);
      expect(persistenceHarness.brokerDatabase.db.prepare(
        "SELECT count(*) AS count FROM broker_connector_receipts",
      ).get()).toEqual({ count: 0 });
    } finally {
      await persistenceHarness.close();
    }
  });
});
