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

it("projects fresh-gate validation terminal observations into liveness", async () => {
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
    await vi.waitFor(() => expect(store.getWorkerLiveness(job.id)).toMatchObject({
      workerKind: "validation",
      resourceKind: "bb_terminal",
      state: "failed",
    }));
  } finally {
    run.controller.abort();
    await run.done;
  }
});
