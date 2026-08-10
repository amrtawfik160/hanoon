import { createFakePluginHost, makeThreadResponse } from "@bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import plugin from "../server";
import { openStore } from "../src/storage/store";

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
