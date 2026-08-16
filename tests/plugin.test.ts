import { createFakePluginHost, makeThreadResponse } from "@bb/plugin-sdk/testing";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import plugin from "../server";
import { projectResourceKey } from "../src/autonomy/models";
import { CONTROLLER_PHASE_TEXT } from "../src/controller/models";
import { hashSecret } from "../src/crypto";
import { ApprovalService } from "../src/services/approval-service";
import {
  CAPABILITY_GRAPH_DIGEST,
  CAPABILITY_REGISTRY_DIGEST,
} from "../src/capabilities/catalog";
import { selectCapabilityProfile } from "../src/capabilities/profiles";
import { openStore } from "../src/storage/store";
import { policyFixture, sha } from "./helpers";

let pluginNumber = 0;

function recordingSdkSubscribe() {
  const listeners = new Map<string, Array<(event: { id?: string; changes: readonly string[] }) => void>>();
  return {
    subscribe(args: { event: string; callback: (event: never) => void }) {
      const existing = listeners.get(args.event) ?? [];
      existing.push(args.callback as (event: { id?: string; changes: readonly string[] }) => void);
      listeners.set(args.event, existing);
      return () => {
        listeners.set(args.event, (listeners.get(args.event) ?? []).filter((listener) => listener !== args.callback));
      };
    },
    emit(event: string, payload: { id?: string; changes: readonly string[] }) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
  };
}

async function loadPlugin() {
  const realtime = recordingSdkSubscribe();
  const { bb, harness } = createFakePluginHost({
    pluginId: `telegram-agent-task10-plugin-${pluginNumber++}`,
    sdk: { subscribe: realtime.subscribe },
  });
  await plugin(bb);
  return { bb, harness, realtime };
}

it("requests the secret bot token when configuration is absent", async () => {
  const { harness } = await loadPlugin();

  expect(harness.registrations.settingsDescriptors.botToken).toMatchObject({ secret: true });
  expect(harness.needsConfigurationMessages).toEqual([
    "Set the Telegram bot token in Extensions → Plugins → Telegram Agent.",
  ]);
});

it("registers configurable controller execution settings with safe defaults", async () => {
  const { harness } = await loadPlugin();

  expect(harness.registrations.settingsDescriptors).toMatchObject({
    controllerModel: {
      type: "select",
      options: [
        "claude-opus-5[1m]",
        "claude-opus-4-8[1m]",
        "claude-sonnet-5",
        "claude-fable-5",
        "gpt-5.6-luna",
        "gpt-5.6-terra",
        "gpt-5.6-sol",
      ],
      default: "claude-opus-5[1m]",
    },
    controllerFallbackModel1: {
      type: "select",
      options: [
        "disabled",
        "claude-opus-5[1m]",
        "claude-opus-4-8[1m]",
        "claude-sonnet-5",
        "claude-fable-5",
        "gpt-5.6-luna",
        "gpt-5.6-terra",
        "gpt-5.6-sol",
      ],
      default: "gpt-5.6-sol",
    },
    controllerFallbackModel2: {
      type: "select",
      options: [
        "disabled",
        "claude-opus-5[1m]",
        "claude-opus-4-8[1m]",
        "claude-sonnet-5",
        "claude-fable-5",
        "gpt-5.6-luna",
        "gpt-5.6-terra",
        "gpt-5.6-sol",
      ],
      default: "disabled",
    },
    controllerReasoningLevel: {
      type: "select",
      options: ["low", "medium", "high", "xhigh", "max"],
      default: "xhigh",
    },
    controllerServiceTier: {
      type: "select",
      options: ["fast", "default"],
      default: "default",
    },
    controllerPermissionMode: {
      type: "select",
      options: ["auto", "accept-edits", "full"],
      default: "auto",
    },
  });
});

it("registers the bounded concurrent job cap as a select setting", async () => {
  const { harness } = await loadPlugin();

  expect(harness.registrations.settingsDescriptors.maxConcurrentJobs).toMatchObject({
    type: "select",
    description: "Independent projects may run together; each project remains serialized.",
    options: ["1", "2", "3", "4", "5", "6", "7", "8"],
    default: "5",
  });
});

it("keeps the Telegram polling timeout out of user-facing settings", async () => {
  const { harness } = await loadPlugin();

  expect(harness.registrations.settingsDescriptors).not.toHaveProperty("pollTimeoutSeconds");
});

it("keeps self-diagnosis disabled and completely unregistered by default", async () => {
  const realtime = recordingSdkSubscribe();
  const { bb, harness } = createFakePluginHost({
    pluginId: `telegram-agent-self-diagnosis-off-${pluginNumber++}`,
    settings: { botToken: "123:test-token" },
    sdk: { subscribe: realtime.subscribe },
  });
  await plugin(bb);

  expect(harness.registrations.settingsDescriptors.selfDiagnosisEnabled).toMatchObject({
    type: "boolean",
    default: false,
  });
  expect(harness.registrations.settingsDescriptors.selfDiagnosisProjectId).toMatchObject({ default: "" });
  expect(harness.registrations.services.map((service) => service.name)).not.toContain("self-diagnosis");
  expect(harness.inspection.sdk.callsTo("projects.list")).toEqual([]);
});

it("registers self-diagnosis only when explicitly enabled", async () => {
  const realtime = recordingSdkSubscribe();
  const { bb, harness } = createFakePluginHost({
    pluginId: `telegram-agent-self-diagnosis-on-${pluginNumber++}`,
    settings: {
      botToken: "123:test-token",
      selfDiagnosisEnabled: true,
      selfDiagnosisProjectId: "project-1",
    },
    sdk: { subscribe: realtime.subscribe },
  });
  await plugin(bb);

  expect(harness.registrations.services.map((service) => service.name)).toContain("self-diagnosis");
});

it("applies a changed concurrency cap to later admissions", async () => {
  const { bb, harness } = await loadPlugin();
  await harness.behavior.setSettings({ botToken: "123:test-token", maxConcurrentJobs: "1" });
  const store = openStore(bb.storage);
  for (let index = 1; index <= 2; index += 1) {
    const projectPolicy = policyFixture({
      projectId: `proj_${index}`,
      alias: `project-${index}`,
      githubRepository: `acme/project-${index}`,
      production: undefined,
    });
    store.upsertProjectPolicy(projectPolicy, 1_000);
    const job = store.createJob({
      id: `plugin-cap-job-${index}`,
      sourceUpdateId: 100 + index,
      requestText: `job ${index}`,
      now: 1_000,
    });
    store.selectProjectAndQueueAdmission({
      jobId: job.id,
      expectedVersion: job.version,
      projectId: projectPolicy.projectId,
      policyVersion: 1,
      policy: projectPolicy,
      now: 1_001,
    });
  }
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 900 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })));
  const run = harness.behavior.runService("job-executor");
  try {
    await vi.waitFor(() => expect(store.listAdmissions(["admitted", "draining"], 10)).toHaveLength(1));
    await harness.behavior.setSettings({ maxConcurrentJobs: "2" });
    await vi.waitFor(() => expect(store.listAdmissions(["admitted", "draining"], 10)).toHaveLength(2));
  } finally {
    run.controller.abort();
    await run.done;
    vi.unstubAllGlobals();
  }
});

it("re-arms a completed worker reconcile from a live BB thread change", async () => {
  const { bb, realtime } = await loadPlugin();
  const store = openStore(bb.storage);
  const job = store.createJob({ id: "abcdefghijklmnopqrstuv", sourceUpdateId: 4, requestText: "work", now: 1_000 });
  bb.storage.database().prepare(
    "UPDATE jobs SET state = 'implementing', implementation_thread_id = ?, environment_id = ?, version = ?, updated_at = ? WHERE id = ?",
  ).run("thr_live", "env_live", job.version + 1, 1_001, job.id);
  expect(store.enqueueReconcileForThread("thr_live", 2_000)).toBe(true);
  bb.storage.database().prepare("UPDATE effects SET status = 'done' WHERE idempotency_key = ?")
    .run("reconcile:abcdefghijklmnopqrstuv:thr_live");

  realtime.emit("thread:changed", { id: "thr_live", changes: ["events-appended"] });

  expect(store.getEffect(job.id, "reconcile:abcdefghijklmnopqrstuv:thr_live")).toMatchObject({
    status: "pending",
  });
});

it("registers both background services and all enqueue-only thread lifecycle handlers", async () => {
  const { bb, harness } = await loadPlugin();
  const serviceNames = harness.registrations.services.map((service) => service.name);
  expect(serviceNames).toEqual(expect.arrayContaining(["telegram-ingress", "job-executor"]));
  expect(harness.registrations.threadEventHandlers).toMatchObject({
    "thread.created": 1,
    "thread.active": 1,
    "thread.idle": 1,
    "thread.failed": 1,
    "thread.archived": 1,
    "thread.deleted": 1,
  });

  const store = openStore(bb.storage);
  const job = store.createJob({ id: "abcdefghijklmnopqrstuv", sourceUpdateId: 1, requestText: "work", now: 1_000 });
  bb.storage.database().prepare("UPDATE jobs SET implementation_thread_id = ? WHERE id = ?").run("thr_plugin", job.id);
  const thread = makeThreadResponse({ id: "thr_plugin" });

  expect((await harness.behavior.emitThreadEvent("thread.idle", {
    thread,
    lastAssistantText: null,
  })).errors).toEqual([]);
  expect(store.listEffectsForJob(job.id).map((effect) => effect.kind)).toEqual(["reconcile_job"]);

  expect((await harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: "unrelated" }),
    lastAssistantText: null,
  })).errors).toEqual([]);
  expect(store.listEffectsForJob(job.id).map((effect) => effect.kind)).toEqual(["reconcile_job"]);
});

it("runs read-only capability discovery at startup and registers its bounded refresh service", async () => {
  const providersList = vi.fn(async () => [{
    id: "codex",
    displayName: "Codex",
    available: true,
    capabilities: { supportsServiceTier: true },
  }]);
  const providerModels = vi.fn(async () => ({
    providers: [],
    permissionCeiling: "full",
    models: [{
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      displayName: "Sol",
      routeProviderId: "codex",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [],
      description: "",
      isDefault: false,
    }],
    selectedOnlyModels: [],
    modelLoadError: null,
  }));
  const pluginsList = vi.fn(async () => ({ plugins: [{
    id: "docs-plugin",
    version: "1.0.0",
    enabled: true,
    status: "running",
  }] }));
  const skillsList = vi.fn(async () => ({ skills: [{
    id: "docs-guard",
    name: "Docs Guard",
    provider: "codex",
    scope: "plugin",
    pluginId: "docs-plugin",
    manageable: false,
  }] }));
  const realtime = recordingSdkSubscribe();
  const { bb, harness } = createFakePluginHost({
    pluginId: `telegram-agent-inventory-${pluginNumber++}`,
    sdk: {
      providers: { list: providersList as never, models: providerModels as never },
      plugins: { list: pluginsList as never },
      skills: { list: skillsList as never },
      subscribe: realtime.subscribe,
    },
  });
  openStore(bb.storage).upsertProjectPolicy(policyFixture({ production: undefined }), 1_000);

  await plugin(bb);

  expect(providersList).toHaveBeenCalledOnce();
  expect(providerModels).toHaveBeenCalledOnce();
  expect(pluginsList).toHaveBeenCalledOnce();
  expect(skillsList).toHaveBeenCalledWith({
    projectId: "proj_1",
    environmentId: null,
    signal: expect.any(AbortSignal),
  });
  expect(openStore(bb.storage).listExternalCapabilityInventory("project:proj_1", 20).length).toBe(4);
  expect(harness.registrations.services.map((service) => service.name)).toContain("capability-inventory");
});

it("wires submitted controller turns through the leased job executor", async () => {
  const { bb, harness } = await loadPlugin();
  await harness.behavior.setSettings({ botToken: "123:test-token" });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 901 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })));
  const store = openStore(bb.storage);
  store.createPairingCode(hashSecret("controller-pair"), 1_000, Date.now() + 60_000);
  expect(store.pairOwnerWithCode(hashSecret("controller-pair"), "7", "7", Date.now())).toEqual({ ok: true });
  const turn = store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 800,
    inputText: "hello",
    now: Date.now(),
  });
  const lease = store.acquireExecutorLease("setup", Date.now(), 30_000);
  if (!lease.acquired) throw new Error("missing setup lease");
  expect(store.claimNextControllerTurn({ ownerId: "setup", generation: lease.generation, now: Date.now() })?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: "setup",
    generation: lease.generation,
    now: Date.now(),
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: turn.id, ownerId: "setup", generation: lease.generation, now: Date.now() })).toBe(true);
  expect(store.proposeControllerFinalization({
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    ownerId: "setup",
    generation: lease.generation,
    now: Date.now(),
    candidate: {
      disposition: "answered",
      segments: [{ type: "text", text: "Hello from accepted finalization." }],
      obligationRefs: [],
    },
  })).toMatchObject({ outcome: "accepted" });
  expect(store.releaseExecutorLease("setup", lease.generation, Date.now())).toBe(true);
  harness.sdk.stub("threads.get", async () => makeThreadResponse({
    id: "thr_controller",
    projectId: "proj_personal",
    environmentId: "env_controller",
    status: "idle",
    providerId: "claude-code",
  }));
  harness.sdk.stub("environments.get", async () => ({
    id: "env_controller",
    projectId: "proj_personal",
    hostId: "host_personal",
    path: "/workspace/personal",
    status: "ready",
    workspaceProvisionType: "personal",
  }));
  harness.sdk.stub("threads.timeline", async () => ({ maxSeq: 0 }));
  harness.sdk.stub("threads.events.list", async () => []);

  const run = harness.behavior.runService("job-executor");
  await vi.waitFor(() => expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text)
    .toBe("Hello from accepted finalization."));
  run.controller.abort();
  await run.done;
  vi.unstubAllGlobals();
});

it("shows native Telegram draft streaming and typing while a Luna controller turn is active", async () => {
  const { bb, harness } = await loadPlugin();
  await harness.behavior.setSettings({ botToken: "123:test-token" });
  const telegramMethods: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const method = String(input).split("/").at(-1) ?? "";
    telegramMethods.push(method);
    const result = method === "sendMessage" ? { message_id: 902 } : true;
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }));
  const store = openStore(bb.storage);
  const now = Date.now();
  store.createPairingCode(hashSecret("presence-pair"), now, now + 60_000);
  expect(store.pairOwnerWithCode(hashSecret("presence-pair"), "7", "7", now)).toEqual({ ok: true });
  const turn = store.enqueueControllerTurn({
    controllerKey: "owner-presence-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 801,
    inputText: "explain this",
    now,
  });
  const lease = store.acquireExecutorLease("presence-setup", now, 30_000);
  if (!lease.acquired) throw new Error("missing setup lease");
  const fence = { ownerId: "presence-setup", generation: lease.generation, now };
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    ...fence,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_presence_controller",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, turnId: turn.id })).toBe(true);
  expect(store.releaseExecutorLease(fence.ownerId, fence.generation, now)).toBe(true);
  harness.sdk.stub("threads.get", async () => makeThreadResponse({
    id: "thr_presence_controller",
    projectId: "proj_personal",
    environmentId: "env_presence_controller",
    status: "active",
    providerId: "claude-code",
    runtime: { displayStatus: "active", hostReconnectGraceExpiresAt: null },
  }));
  harness.sdk.stub("environments.get", async () => ({
    id: "env_presence_controller",
    projectId: "proj_personal",
    hostId: "host_personal",
    path: "/workspace/personal",
    status: "ready",
    workspaceProvisionType: "personal",
  }));
  harness.sdk.stub("threads.timeline", async () => ({ maxSeq: 0 }));
  harness.sdk.stub("threads.events.list", async () => []);

  const run = harness.behavior.runService("job-executor");
  try {
    await vi.waitFor(() => expect(telegramMethods).toContain("sendChatAction"));
    await vi.waitFor(() => expect(telegramMethods).toContain("sendMessageDraft"));
    await vi.waitFor(() => expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
      status: "sent",
      messageId: null,
      payload: { text: CONTROLLER_PHASE_TEXT.connecting },
    }));
  } finally {
    run.controller.abort();
    await run.done;
    vi.unstubAllGlobals();
  }
});

it("reconciles an authoritative implementation idle observation into the job state", async () => {
  const { bb, harness } = await loadPlugin();
  const store = openStore(bb.storage);
  const job = store.createJob({ id: "abcdefghijklmnopqrstuv", sourceUpdateId: 2, requestText: "work", now: 1_000 });
  bb.storage.database().prepare(
    "UPDATE jobs SET state = 'implementing', implementation_thread_id = ?, version = ?, updated_at = ? WHERE id = ?",
  ).run("thr_plugin", job.version + 1, 1_001, job.id);
  harness.sdk.stub("threads.get", async () => makeThreadResponse({
    id: "thr_plugin",
    status: "idle",
    updatedAt: 2_000,
  }));

  const run = harness.behavior.runService("job-executor");
  await vi.waitFor(() => expect(store.listEffectsForJob(job.id).some((effect) => effect.kind === "inspect_implementation")).toBe(true));
  expect(store.getJob(job.id)?.state).not.toBe("implementing");
  run.controller.abort();
  await run.done;
});

it.each([
  ["with observed test and command evidence", true],
  ["without observed test evidence", false],
] as const)("gates active implementation completion %s", async (_label, completeEvidence) => {
  const { bb, harness } = await loadPlugin();
  const store = openStore(bb.storage);
  const db = bb.storage.database();
  const now = Date.now();
  const policy = policyFixture({ production: undefined });
  const job = store.createJob({
    id: completeEvidence ? "activeproofpassjobabcde" : "activeprooffailjobabcde",
    sourceUpdateId: completeEvidence ? 31 : 32,
    requestText: "change the feature and its regression test",
    now,
  });
  db.prepare(
    `UPDATE jobs SET state = 'implementing', project_id = ?, policy_version = 1, policy_json = ?,
       environment_id = 'env_active', implementation_thread_id = 'thr_active_impl',
       routing_mode = 'active', task_recipe = 'bounded', task_traits_json = ?,
       task_reason_codes_json = '[]', version = 2, updated_at = ? WHERE id = ?`,
  ).run(
    policy.projectId,
    JSON.stringify(policy),
    JSON.stringify([{ id: "existing-flow", provenance: ["owner"] }]),
    now,
    job.id,
  );
  const attemptId = `attempt:${job.id}:2:spawn_implementation`;
  store.createAttempt({ id: attemptId, jobId: job.id, kind: "implementation", ordinal: 1, now });
  store.updateAttempt(attemptId, {
    threadId: "thr_active_impl",
    handoffPath: "/bounded/work-order.md",
    handoffSha256: "a".repeat(64),
  });
  const selected = selectCapabilityProfile({
    role: "implementation",
    recipe: "bounded",
    stage: "implementation",
    traits: ["behavioral-change"],
  });
  const profile = store.createCapabilityProfile({
    subjectKind: "worker_attempt",
    subjectId: attemptId,
    threadId: null,
    recipeId: "bounded",
    recipeVersion: 1,
    registryDigest: CAPABILITY_REGISTRY_DIGEST,
    graphDigest: CAPABILITY_GRAPH_DIGEST,
    mode: "active",
    model: { pool: "standard", providerId: "codex", modelId: "model", reasoning: "high", serviceTier: "fast" },
    assignments: selected.assignments.map((assignment) => ({
      capabilityId: assignment.capabilityId,
      descriptorDigest: assignment.descriptorDigest,
      capabilityKind: "skill",
      mandatory: assignment.mandatory,
    })),
    reasonCodes: [],
    traits: ["behavioral-change"],
    now,
  });
  harness.sdk.stub("threads.get", async () => makeThreadResponse({
    id: "thr_active_impl",
    projectId: policy.projectId,
    status: "idle",
    updatedAt: now + 1,
  }));
  harness.sdk.stub("environments.status", async () => ({
    outcome: "available",
    available: true,
    workingTree: { state: "dirty", hasUncommittedChanges: true },
    checkout: { kind: "branch", branchName: "feature/active", headSha: sha() },
  }));
  harness.sdk.stub("environments.diff", async () => ({
    outcome: "available",
    diff: {
      diff: completeEvidence
        ? "diff --git a/src/feature.ts b/src/feature.ts\n+++ b/src/feature.ts\ndiff --git a/tests/feature.test.ts b/tests/feature.test.ts\n+++ b/tests/feature.test.ts"
        : "diff --git a/src/feature.ts b/src/feature.ts\n+++ b/src/feature.ts",
      truncated: false,
    },
  }));
  const terminalOutput = new Map<string, string>();
  harness.sdk.stub("terminals.create", async ({ start }: { start: { command: string } }) => {
    const id = "terminal_active_validation";
    const marker = start.command.match(/__BB_TELEGRAM_AGENT_RESULT_[0-9a-f]+__/)?.[0];
    if (!marker) throw new Error("terminal marker missing");
    terminalOutput.set(id, `tests passed\n${marker}:0\n`);
    return { id };
  });
  harness.sdk.stub("terminals.get", async () => ({ status: "running", exitCode: null }));
  harness.sdk.stub("terminals.output", async ({ terminalId }: { terminalId: string }) => ({
    chunks: [{ seq: 0, dataBase64: Buffer.from(terminalOutput.get(terminalId) ?? "").toString("base64") }],
  }));
  harness.sdk.stub("terminals.close", async () => undefined);
  expect(store.enqueueReconcileForThread("thr_active_impl", now + 2)).toBe(true);

  const run = harness.behavior.runService("job-executor");
  try {
    await vi.waitFor(() => {
      const current = store.getJob(job.id);
      expect(current?.state).not.toBe("implementing");
    });
    expect(store.listSkillReceiptProjection(profile.id, 10)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        capabilityId: "test-driven-development",
        outcome: completeEvidence ? "passed" : "blocked",
      }),
      expect.objectContaining({ capabilityId: "verification-before-completion", outcome: "passed" }),
    ]));
    if (completeEvidence) {
      expect(store.listEffectsForJob(job.id).some((effect) => effect.kind === "inspect_implementation")).toBe(true);
    } else {
      expect(store.getJob(job.id)).toMatchObject({
        state: "failed",
        lastError: "Mandatory capability evidence is incomplete",
      });
      expect(store.listEffectsForJob(job.id).some((effect) => effect.kind === "inspect_implementation")).toBe(false);
    }
  } finally {
    run.controller.abort();
    await run.done;
  }
});

it("waits for both full-job reviewer threads before advancing", async () => {
  const { bb, harness } = await loadPlugin();
  const store = openStore(bb.storage);
  const db = bb.storage.database();
  const now = Date.now();
  const headSha = sha();
  const policy = policyFixture({ production: undefined });
  store.upsertProjectPolicy(policy, now);
  const job = store.createJob({ id: "reviewlensjobabcdefghijk", sourceUpdateId: 20, requestText: "review this", now });
  db.prepare(
    `UPDATE jobs SET state = 'reviewing', project_id = ?, policy_version = 1, policy_json = ?,
       environment_id = 'env_review', implementation_thread_id = 'thr_impl', review_thread_id = 'thr_quality',
       pr_number = 17, pr_url = 'https://github.com/acme/cyndra/pull/17', pr_head_sha = ?,
       delivery_mode = 'full', routing_mode = 'shadow', task_recipe = 'bounded',
       task_traits_json = '[]', task_reason_codes_json = '[]', version = 2, updated_at = ? WHERE id = ?`,
  ).run(policy.projectId, JSON.stringify(policy), headSha, now, job.id);
  db.prepare(
    `INSERT INTO job_admissions (
       job_id, project_id, queue_seq, state, resume_event, queued_at, admitted_at
     ) VALUES (?, ?, 1, 'admitted', 'CONFIRMED', ?, ?)`,
  ).run(job.id, policy.projectId, now, now);
  db.prepare(
    `INSERT INTO job_resource_claims (
       job_id, resource_key, resource_kind, state, owner_id, generation,
       lease_expires_at, acquired_at, renewed_at, released_at, release_reason
     ) VALUES (?, ?, 'project', 'held', 'fixture-executor', 1, ?, ?, ?, NULL, NULL)`,
  ).run(job.id, projectResourceKey(policy.projectId), now + 60_000, now, now);
  const quality = store.createAttempt({
    id: "attempt_review_quality",
    jobId: job.id,
    kind: "review",
    ordinal: 1,
    headSha,
    now,
  });
  store.updateAttempt(quality.id, { threadId: "thr_quality" });
  db.prepare("UPDATE attempts SET review_stage = 'review', review_lens = 'quality' WHERE id = ?").run(quality.id);
  db.prepare(
    `INSERT INTO attempts (
       id, job_id, kind, review_lens, review_stage, ordinal, thread_id, head_sha, created_at
     ) VALUES ('attempt_review_risk', ?, 'review', 'risk', 'review', 1, 'thr_risk', ?, ?)`,
  ).run(job.id, headSha, now);
  expect(store.enqueueReconcileForThread("thr_risk", now + 1)).toBe(true);
  expect(store.shouldWakeForThread("thr_risk")).toBe(true);

  harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({
    id: threadId,
    projectId: policy.projectId,
    parentThreadId: "thr_impl",
    status: "idle",
    updatedAt: now + 2,
  }));
  harness.sdk.stub("threads.output", async () => ({
    output: JSON.stringify({
      verdict: "pass",
      reviewedHeadSha: headSha,
      summary: "No actionable findings.",
      findings: [],
      checks: [],
    }),
  }));
  harness.sdk.stub("environments.status", async () => ({
    available: true,
    clean: true,
    workingTree: { state: "clean", hasUncommittedChanges: false },
    checkout: { kind: "branch", branchName: "feature/review", headSha },
  }));

  const run = harness.behavior.runService("job-executor");
  try {
    await vi.waitFor(() => expect(store.getJob(job.id)?.state).not.toBe("reviewing"));
    expect(store.listReviewAttempts(job.id, "review", 1)).toMatchObject([
      { reviewLens: "quality", completedAt: expect.any(Number) },
      { reviewLens: "risk", completedAt: expect.any(Number) },
    ]);
  } finally {
    run.controller.abort();
    await run.done;
  }
});

it("persists every selected active guard outcome before advancing the review group", async () => {
  const { bb, harness } = await loadPlugin();
  const store = openStore(bb.storage);
  const db = bb.storage.database();
  const now = Date.now();
  const headSha = sha();
  const diff = "diff --git a/src/feature.ts b/src/feature.ts\n+++ b/src/feature.ts";
  const policy = policyFixture({ production: undefined, requiredChecks: [] });
  store.upsertProjectPolicy(policy, now);
  const job = store.createJob({ id: "activeguardreviewjobabc", sourceUpdateId: 41, requestText: "review this", now });
  db.prepare(
    `UPDATE jobs SET state = 'reviewing', project_id = ?, policy_version = 1, policy_json = ?,
       environment_id = 'env_guard_review', implementation_thread_id = 'thr_impl', review_thread_id = 'thr_guard_quality',
       pr_number = 19, pr_url = 'https://github.com/acme/cyndra/pull/19', pr_head_sha = ?,
       delivery_mode = 'small_fix', routing_mode = 'active', task_recipe = 'bounded',
       task_traits_json = '[]', task_reason_codes_json = '[]', version = 2, updated_at = ? WHERE id = ?`,
  ).run(policy.projectId, JSON.stringify(policy), headSha, now, job.id);
  db.prepare(
    `INSERT INTO job_admissions (
       job_id, project_id, queue_seq, state, resume_event, queued_at, admitted_at
     ) VALUES (?, ?, 1, 'admitted', 'CONFIRMED', ?, ?)`,
  ).run(job.id, policy.projectId, now, now);
  db.prepare(
    `INSERT INTO job_resource_claims (
       job_id, resource_key, resource_kind, state, owner_id, generation,
       lease_expires_at, acquired_at, renewed_at, released_at, release_reason
     ) VALUES (?, ?, 'project', 'held', 'fixture-executor', 1, ?, ?, ?, NULL, NULL)`,
  ).run(job.id, projectResourceKey(policy.projectId), now + 60_000, now, now);
  const attempt = store.createAttempt({
    id: "attempt_active_guard_quality",
    jobId: job.id,
    kind: "review",
    ordinal: 1,
    headSha,
    now,
  });
  store.updateAttempt(attempt.id, { threadId: "thr_guard_quality" });
  db.prepare("UPDATE attempts SET review_stage = 'review', review_lens = 'quality' WHERE id = ?").run(attempt.id);
  const selected = selectCapabilityProfile({
    role: "review",
    recipe: "bounded",
    stage: "review",
    traits: ["strict-json", "quality-lens", "code-changed"],
  });
  const profile = store.createCapabilityProfile({
    subjectKind: "worker_attempt",
    subjectId: attempt.id,
    threadId: null,
    recipeId: "bounded",
    recipeVersion: 1,
    registryDigest: CAPABILITY_REGISTRY_DIGEST,
    graphDigest: CAPABILITY_GRAPH_DIGEST,
    mode: "active",
    model: { pool: "standard", providerId: "codex", modelId: "model", reasoning: "high", serviceTier: "fast" },
    assignments: selected.assignments.map((assignment) => ({
      capabilityId: assignment.capabilityId,
      descriptorDigest: assignment.descriptorDigest,
      capabilityKind: "skill",
      mandatory: assignment.mandatory,
    })),
    reasonCodes: [],
    traits: ["code-changed", "quality-lens", "strict-json"],
    now,
  });
  const guard = profile.assignments[0];
  if (!guard) throw new Error("guard assignment missing");
  harness.sdk.stub("threads.get", async () => makeThreadResponse({
    id: "thr_guard_quality",
    projectId: policy.projectId,
    parentThreadId: "thr_impl",
    status: "idle",
    updatedAt: now + 1,
  }));
  harness.sdk.stub("threads.output", async () => ({
    output: JSON.stringify({
      schemaVersion: 1,
      profileId: profile.id,
      profileRevision: profile.revision,
      reviewedHeadSha: headSha,
      diffDigest: createHash("sha256").update(diff).digest("hex"),
      guards: [{
        capabilityId: guard.capabilityId,
        descriptorDigest: guard.descriptorDigest,
        outcome: "passed",
        findings: [],
      }],
    }),
  }));
  harness.sdk.stub("environments.status", async () => ({
    outcome: "available",
    available: true,
    clean: true,
    workingTree: { state: "clean", hasUncommittedChanges: false },
    checkout: { kind: "branch", branchName: "feature/guard", headSha },
  }));
  harness.sdk.stub("environments.diff", async () => ({
    outcome: "available",
    diff: { diff, truncated: false },
  }));
  expect(store.enqueueReconcileForThread("thr_guard_quality", now + 2)).toBe(true);

  const run = harness.behavior.runService("job-executor");
  try {
    await vi.waitFor(() => expect(store.getJob(job.id)?.state).not.toBe("reviewing"));
    expect(store.listCapabilityReceipts(profile.id, 20)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        capabilityId: guard.capabilityId,
        eventType: "outcome",
        outcome: "passed",
      }),
    ]));
  } finally {
    run.controller.abort();
    await run.done;
  }
});

it("does not execute a merge effect without its held project claim", async () => {
  const { bb, harness } = await loadPlugin();
  const store = openStore(bb.storage);
  const db = bb.storage.database();
  const now = Date.now();
  const headSha = sha();
  const policy = policyFixture();
  store.createPairingCode(hashSecret("pair"), now, now + 60_000);
  expect(store.pairOwnerWithPrivateChatCode(hashSecret("pair"), "7", "70", now)).toEqual({ ok: true });
  store.upsertProjectPolicy(policy, now);
  const job = store.createJob({ id: "abcdefghijklmnopqrstuv", sourceUpdateId: 3, requestText: "merge this", now });
  db.prepare(
    `UPDATE jobs SET state = 'awaiting_merge_approval', project_id = ?,
       policy_version = 1, policy_json = ?, environment_id = ?, pr_number = ?,
       pr_url = ?, pr_head_sha = ?, version = 7, updated_at = ? WHERE id = ?`,
  ).run(policy.projectId, JSON.stringify(policy), "env_1", 17, "https://github.com/acme/cyndra/pull/17", headSha, now, job.id);
  db.prepare(
    `INSERT INTO job_admissions (
       job_id, project_id, queue_seq, state, resume_event, queued_at, admitted_at
     ) VALUES (?, ?, 1, 'admitted', 'CONFIRMED', ?, ?)`,
  ).run(job.id, policy.projectId, now, now);

  const approvals = new ApprovalService(store, {
    now: () => Date.now(),
    randomBytes: () => Buffer.alloc(24, 2),
  });
  const issued = approvals.issue(job.id, headSha, now);
  expect(approvals.accept(
    issued.nonce,
    7,
    { idempotencyKey: `${job.id}:8:merge_pr`, jobId: job.id, kind: "merge_pr", payload: { headSha } },
    now,
    { userId: "7", chatId: "70" },
  )).toMatchObject({ ok: true });

  harness.sdk.stub("environments.status", async () => ({
    available: true,
    clean: true,
    workingTree: { state: "clean", hasUncommittedChanges: false },
    checkout: { kind: "branch", branchName: "feature/telegram", headSha },
  }));
  const commands = new Map<string, string>();
  let terminalNumber = 0;
  harness.sdk.stub("terminals.create", async ({ start }: { start: { command: string } }) => {
    const id = `fresh-terminal-${++terminalNumber}`;
    commands.set(id, start.command);
    return { id };
  });
  harness.sdk.stub("terminals.get", async ({ terminalId }: { terminalId: string }) => ({
    status: "exited",
    exitCode: commands.get(terminalId)?.includes("git remote") ? 1 : 0,
  }));
  harness.sdk.stub("terminals.output", async () => ({ chunks: [] }));
  harness.sdk.stub("terminals.close", async () => undefined);

  const run = harness.behavior.runService("job-executor");
  try {
    await vi.waitFor(() => expect(store.getEffect(job.id, `${job.id}:8:merge_pr`)).toMatchObject({
      status: "pending",
      attempts: 0,
    }));
    expect(store.getWorkerLiveness(job.id)).toBeNull();
    expect(commands.size).toBe(0);
  } finally {
    run.controller.abort();
    await run.done;
  }
});
