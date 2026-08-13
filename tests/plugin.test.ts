import { createFakePluginHost, makeThreadResponse } from "@bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import plugin from "../server";
import { hashSecret } from "../src/crypto";
import { BbControllerAdapter, controllerSpawnTitle } from "../src/controller/bb-controller";
import { CONTROLLER_INSTRUCTION_SENTINEL, CONTROLLER_INSTRUCTIONS } from "../src/controller/instructions";
import { CONTROLLER_TOOL_NAMES } from "../src/controller/tools";
import { DEFAULT_CONTROLLER_EXECUTION_PROFILE } from "../src/controller/execution-profile";
import { ApprovalService } from "../src/services/approval-service";
import { openStore } from "../src/storage/store";
import { policyFixture, sha } from "./helpers";

let pluginNumber = 0;

function countOccurrences(text: string, needle: string): number {
  return needle.length === 0 ? 0 : text.split(needle).length - 1;
}

async function loadPlugin() {
  const { bb, harness } = createFakePluginHost({
    pluginId: `telegram-agent-task10-plugin-${pluginNumber++}`,
  });
  await plugin(bb);
  return { bb, harness };
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
      description: "Fresh controller turns default to auto; supported BB-native approvals are routed to Telegram as one-use Allow once/Deny choices, while BB and the execution machine continue to enforce their permission limits.",
    },
  });
});

it("retains executable controller operating guidance alongside the trust boundaries", () => {
  const guidance = CONTROLLER_INSTRUCTIONS.toLowerCase();
  for (const behavior of [
    /open a new thread.*message a running thread.*stop or retry/s,
    /guarded job.*list projects.*start, inspect, retry, or cancel/s,
    /independent pieces.*send them out together/s,
    /choose_job.*bounded candidate ids.*do not .*guess/s,
    /awaiting_confirmation.*awaitingowner.*false.*queued/s,
    /set one instead of promising/s,
    /fired monitor.*do it.*message the owner/s,
    /future self in full.*only that text/s,
    /project.*recall.*project id/s,
    /bb <command> --help.*--json.*--machine/s,
    /do the bb work yourself.*never send the owner into the bb app/s,
    /routine tool narration out.*opaque third-party/s,
  ]) {
    expect(guidance).toMatch(behavior);
  }
  expect(guidance).not.toContain("full permissions");
  expect(guidance).not.toContain("install and configure it");
  expect(guidance).toContain("one-use allow once/deny");
});

it("keeps standing instructions in configuration and owner content in the first input", async () => {
  const { bb, harness } = await loadPlugin();
  await harness.behavior.setSettings({ botToken: "123:test-token" });
  const store = openStore(bb.storage);
  const now = Date.now();
  const pairingSecret = "controller-trust-kernel-pair";
  store.createPairingCode(hashSecret(pairingSecret), now, now + 60_000);
  expect(store.pairOwnerWithCode(hashSecret(pairingSecret), "7", "7", now)).toEqual({ ok: true });
  const overlay = "Always show me the PR link.";
  store.setControllerOverlay({ text: overlay, now });
  expect(store.getControllerOverlay()).toBe(overlay);
  const turn = store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 12_001,
    inputText: "What is running right now?",
    now,
  });
  const lease = store.acquireExecutorLease("controller-trust-kernel-test", now, 30_000);
  if (!lease.acquired) throw new Error("missing controller test lease");
  const fence = { ownerId: "controller-trust-kernel-test", generation: lease.generation, now };
  expect(store.claimNextControllerTurn(fence)?.id).toBe(turn.id);
  const controller = store.getControllerForOwner("7", "7");
  if (!controller) throw new Error("missing controller record");

  harness.sdk.stub("projects.list", async () => [{
    id: "proj_personal",
    kind: "personal",
    name: "Personal",
    gitRemoteUrl: null,
    sources: [{ id: "src_personal", isDefault: true, hostId: "host_personal" }],
  }]);
  let preReturnTools: string[] | null = null;
  let preReturnSkills: string[] | null = null;
  let preReturnInstructions: string | null = null;
  harness.sdk.stub("threads.spawn", async (request) => {
    const requestedTitle = (request as { title?: unknown }).title;
    const title = typeof requestedTitle === "string" ? requestedTitle : null;
    if (title === null) throw new Error("missing tokenized controller spawn title");
    const preReturn = await harness.behavior.resolveAgentConfiguration({
      thread: { id: "thr_trust_kernel", title, parentThreadId: null, sourceThreadId: null },
      project: { id: "proj_personal", kind: "personal", name: "Personal", gitRemoteUrl: null },
      environment: { id: "env_personal", name: null, path: "/personal", workspaceProvisionType: "personal", branchName: null },
      host: { id: "host_personal", name: "Personal host" },
      provider: { id: "claude-code", model: "claude-opus-5[1m]" },
      origin: { kind: null, pluginId: bb.pluginId },
    });
    preReturnTools = preReturn.tools.map((tool) => tool.name);
    preReturnSkills = [...preReturn.skills];
    preReturnInstructions = preReturn.instructions;
    expect(store.getControllerForOwner("7", "7")).toMatchObject({
      threadId: null,
      state: "pending_spawn",
      projectId: "proj_personal",
      hostId: "host_personal",
    });
    return { id: "thr_trust_kernel", environmentId: "env_personal" };
  });
  const adapter = new BbControllerAdapter({
    sdk: bb.sdk,
    pluginId: bb.pluginId,
    executionProfile: () => DEFAULT_CONTROLLER_EXECUTION_PROFILE,
    now: () => now,
    reserveSpawn: (input) => store.reserveControllerSpawn(input),
  });
  const location = await adapter.spawn(turn, controller, AbortSignal.timeout(1_000));
  expect(preReturnTools).toEqual(CONTROLLER_TOOL_NAMES);
  expect(preReturnSkills).toEqual([]);
  expect(preReturnInstructions).toContain(CONTROLLER_INSTRUCTION_SENTINEL);
  expect(preReturnInstructions).toContain(overlay);
  expect(store.markControllerSpawned({ ...fence, turnId: turn.id, ...location })).toBe(true);

  const configured = await harness.behavior.resolveAgentConfiguration({
    thread: { id: location.threadId, title: controllerSpawnTitle(controller.controllerKey, turn.id, "proj_personal", "host_personal", "claude-code"), parentThreadId: null, sourceThreadId: null },
    project: { id: location.projectId, kind: "personal", name: "Personal", gitRemoteUrl: null },
    environment: { id: "env_personal", name: null, path: "/personal", workspaceProvisionType: "personal", branchName: null },
    host: { id: location.hostId, name: "Personal host" },
    provider: { id: "claude-code", model: "claude-opus-5[1m]" },
    origin: { kind: null, pluginId: bb.pluginId },
  });
  if (configured.instructions === null) throw new Error("missing controller instructions");
  expect(configured.instructions).toContain(overlay);
  const spawnCall = harness.inspection.sdk.callsTo("threads.spawn").at(-1)?.[0];
  if (!spawnCall || typeof spawnCall !== "object" || !("input" in spawnCall) || !("title" in spawnCall)) {
    throw new Error("missing controller spawn input");
  }
  expect(spawnCall.title).toBe(controllerSpawnTitle(controller.controllerKey, turn.id, "proj_personal", "host_personal", "claude-code"));
  const firstInput = (spawnCall as { input: Array<{ type: string; text?: string; mentions?: string[] }> }).input;

  expect(countOccurrences(`${configured.instructions}\n${turn.inputText}`, CONTROLLER_INSTRUCTION_SENTINEL)).toBe(1);
  expect(countOccurrences(configured.instructions, overlay)).toBe(1);
  expect(firstInput).toEqual([{ type: "text", text: turn.inputText, mentions: [] }]);
  expect(firstInput[0]?.text).not.toContain(CONTROLLER_INSTRUCTION_SENTINEL);
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

it("adopts one exact tokenized controller title and rejects spoofed or ambiguous candidates", async () => {
  const { bb, harness } = await loadPlugin();
  harness.sdk.stub("projects.list", async () => [{
    id: "proj_personal",
    kind: "personal",
    name: "Personal",
    gitRemoteUrl: null,
    sources: [{ id: "src_personal", isDefault: true, hostId: "host_personal" }],
  }]);
  const exactTitle = controllerSpawnTitle("owner-7-controller", "controller-turn-2", "proj_personal", "host_personal", "claude-code");
  const candidate = {
    id: "thr_tokenized",
    projectId: "proj_personal",
    providerId: "claude-code",
    status: "idle",
    title: exactTitle,
    visibility: "hidden",
    originPluginId: bb.pluginId,
    environmentHostId: "host_personal",
    archivedAt: null,
    deletedAt: null,
  };
  harness.sdk.stub("threads.list", async () => [candidate]);
  const adapter = new BbControllerAdapter({
    sdk: bb.sdk,
    pluginId: bb.pluginId,
    executionProfile: () => DEFAULT_CONTROLLER_EXECUTION_PROFILE,
  });
  await expect(adapter.findSpawnCandidate("owner-7-controller", "controller-turn-2", AbortSignal.timeout(1_000))).resolves.toMatchObject({
    threadId: "thr_tokenized",
    projectId: "proj_personal",
    hostId: "host_personal",
  });

  harness.sdk.stub("threads.list", async () => [{
    ...candidate,
    title: "Telegram Codex controller owner-7-controller",
  }]);
  await expect(adapter.findSpawnCandidate("owner-7-controller", "controller-turn-2", AbortSignal.timeout(1_000))).resolves.toBeNull();

  harness.sdk.stub("threads.list", async () => [{ ...candidate, title: `${exactTitle}-suffix-spoof` }]);
  await expect(adapter.findSpawnCandidate("owner-7-controller", "controller-turn-2", AbortSignal.timeout(1_000))).resolves.toBeNull();

  harness.sdk.stub("threads.list", async () => [candidate, { ...candidate, id: "thr_tokenized_other" }]);
  await expect(adapter.findSpawnCandidate("owner-7-controller", "controller-turn-2", AbortSignal.timeout(1_000)))
    .rejects.toThrow(/multiple|ambiguous/i);

  harness.sdk.stub("threads.list", async () => [{ ...candidate, providerId: "codex" }]);
  await expect(adapter.findSpawnCandidate("owner-7-controller", "controller-turn-2", AbortSignal.timeout(1_000))).resolves.toBeNull();
  harness.sdk.stub("threads.list", async () => [{ ...candidate, environmentHostId: "host_other" }]);
  await expect(adapter.findSpawnCandidate("owner-7-controller", "controller-turn-2", AbortSignal.timeout(1_000))).resolves.toBeNull();

  harness.sdk.stub("threads.list", async () => [{
    ...candidate,
    title: controllerSpawnTitle("owner-7-controller", "controller-turn-1", "proj_personal", "host_personal", "claude-code"),
  }]);
  await expect(adapter.findSpawnCandidate("owner-7-controller", "controller-turn-2", AbortSignal.timeout(1_000))).resolves.toBeNull();
});

it("keeps the Telegram polling timeout out of user-facing settings", async () => {
  const { harness } = await loadPlugin();

  expect(harness.registrations.settingsDescriptors).not.toHaveProperty("pollTimeoutSeconds");
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
  const accepted = store.proposeControllerFinalization({
    ownerId: "setup",
    generation: lease.generation,
    now: Date.now(),
    turnId: turn.id,
    controllerKey: "owner-7-controller",
    candidate: {
      disposition: "answered",
      segments: [{ type: "text", text: "Hello from Luna." }],
      obligationRefs: [],
    },
  });
  expect(accepted.outcome).toBe("accepted");
  expect(store.releaseExecutorLease("setup", lease.generation, Date.now())).toBe(true);
  harness.sdk.stub("threads.get", async () => makeThreadResponse({
    id: "thr_controller",
    projectId: "proj_personal",
    environmentId: "env_personal",
    status: "idle",
    providerId: "claude-code",
  }));
  harness.sdk.stub("environments.get", async () => ({
    id: "env_personal",
    projectId: "proj_personal",
    hostId: "host_personal",
    status: "ready",
    workspaceProvisionType: "personal",
    path: "/personal",
  }));
  harness.sdk.stub("threads.timeline", async () => ({ maxSeq: 0 }));
  harness.sdk.stub("threads.events.list", async () => []);

  const run = harness.behavior.runService("job-executor");
  await vi.waitFor(() => expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).toBe(
    accepted.outcome === "accepted" ? accepted.finalization.renderedMessage : undefined,
  ));
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
    status: "active",
    providerId: "claude-code",
    runtime: { displayStatus: "active", hostReconnectGraceExpiresAt: null },
  }));

  const run = harness.behavior.runService("job-executor");
  try {
    await vi.waitFor(() => expect(telegramMethods).toContain("sendChatAction"));
    await vi.waitFor(() => expect(telegramMethods).toContain("sendMessageDraft"));
    await vi.waitFor(() => expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
      status: "sent",
      messageId: null,
      payload: { text: "Hanoon is connecting…" },
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
