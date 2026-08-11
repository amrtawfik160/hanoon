import { createFakePluginHost, makeThreadResponse } from "@bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import plugin from "../server";
import { hashSecret } from "../src/crypto";
import { ApprovalService } from "../src/services/approval-service";
import { openStore } from "../src/storage/store";
import { policyFixture, sha } from "./helpers";

let pluginNumber = 0;

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
      default: "full",
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
  expect(store.releaseExecutorLease("setup", lease.generation, Date.now())).toBe(true);
  harness.sdk.stub("threads.get", async () => makeThreadResponse({
    id: "thr_controller",
    projectId: "proj_personal",
    status: "idle",
    providerId: "claude-code",
  }));
  harness.sdk.stub("threads.output", async () => ({ output: "Hello from Luna." }));

  const run = harness.behavior.runService("job-executor");
  await vi.waitFor(() => expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).toBe("Hello from Luna."));
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
      payload: { text: "Connecting to Luna Max…" },
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
