import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { BbRunner, type PipelineThreadAttempt } from "../src/bb/runner";
import { jobStageExecution } from "../src/domain/stage-routing";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { summariseStageSpend } from "../src/storage/stage-execution-repository";
import { settleStageLedger } from "../src/services/stage-ledger";
import { jobFixture, policyFixture } from "./helpers";

function ledgerStore(): TelegramAgentStore {
  const { bb } = createFakePluginHost({ pluginId: "telegram-agent" });
  return openStore(bb.storage);
}

const dispatched = {
  jobId: "job_1",
  attemptId: "stage:job_1:1:spawn_plan",
  stage: "plan" as const,
  attemptOrdinal: 1,
  threadId: "thr_plan",
  baseTier: "strong" as const,
  tier: "strong" as const,
  escalationSteps: 0,
  source: "default" as const,
  providerId: "codex",
  modelId: "gpt-5.6-sol",
  reasoningLevel: "xhigh" as const,
  serviceTier: "default" as const,
  now: 1_000,
};

const usage = {
  inputTokens: 900,
  cachedInputTokens: 100,
  outputTokens: 300,
  reasoningOutputTokens: 120,
  totalTokens: 1_200,
};

describe("the stage ledger", () => {
  it("records what a stage attempt was dispatched on", () => {
    const store = ledgerStore();
    const record = store.recordStageExecution(dispatched);
    expect(record).toMatchObject({
      jobId: "job_1",
      stage: "plan",
      providerId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "xhigh",
      serviceTier: "default",
      escalated: false,
      outcome: null,
      durationMs: null,
      usage: null,
    });
    expect(store.listStageExecutions("job_1")).toHaveLength(1);
  });

  it("settles with measured tokens and duration", () => {
    const store = ledgerStore();
    store.recordStageExecution(dispatched);
    const settled = store.settleStageExecution({
      jobId: "job_1",
      attemptId: dispatched.attemptId,
      stage: "plan",
      outcome: "succeeded",
      usage,
      now: 4_500,
    });
    expect(settled).toMatchObject({
      outcome: "succeeded",
      durationMs: 3_500,
      usage,
      // gpt-5.6-sol has no published rate entered yet, so spend is unmeasured
      // rather than reported as zero.
      costMicroUsd: null,
    });
  });

  it("keeps the first measurement when an observation is retried", () => {
    const store = ledgerStore();
    store.recordStageExecution(dispatched);
    store.settleStageExecution({
      jobId: "job_1", attemptId: dispatched.attemptId, stage: "plan", outcome: "succeeded", usage, now: 4_500,
    });
    const again = store.settleStageExecution({
      jobId: "job_1", attemptId: dispatched.attemptId, stage: "plan", outcome: "failed", usage: null, now: 9_000,
    });
    expect(again).toMatchObject({ outcome: "succeeded", durationMs: 3_500 });
  });

  it("keeps one row per attempt when a dispatch is replayed", () => {
    const store = ledgerStore();
    store.recordStageExecution(dispatched);
    store.recordStageExecution({ ...dispatched, tier: "fast", modelId: "gpt-5.6-luna", now: 8_000 });
    const records = store.listStageExecutions("job_1");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ modelId: "gpt-5.6-sol", startedAt: 1_000 });
  });

  it("ignores a settlement for an attempt it never recorded", () => {
    const store = ledgerStore();
    expect(store.settleStageExecution({
      jobId: "job_1", attemptId: "missing", stage: "plan", outcome: "succeeded", usage: null, now: 10,
    })).toBeNull();
  });

  it("summarises a job's attempts, escalations, and tokens", () => {
    const store = ledgerStore();
    store.recordStageExecution(dispatched);
    store.settleStageExecution({
      jobId: "job_1", attemptId: dispatched.attemptId, stage: "plan", outcome: "succeeded", usage, now: 2_000,
    });
    store.recordStageExecution({
      ...dispatched,
      attemptId: "stage:job_1:2:spawn_docs",
      stage: "docs",
      attemptOrdinal: 2,
      baseTier: "fast",
      tier: "standard",
      escalationSteps: 1,
      modelId: "gpt-5.6-terra",
      reasoningLevel: "high",
      now: 3_000,
    });
    store.settleStageExecution({
      jobId: "job_1", attemptId: "stage:job_1:2:spawn_docs", stage: "docs", outcome: "succeeded", usage, now: 5_000,
    });
    expect(summariseStageSpend(store.listStageExecutions("job_1"))).toEqual({
      attempts: 2,
      escalatedAttempts: 1,
      totalTokens: 2_400,
      costMicroUsd: null,
      durationMs: 3_000,
    });
  });
});

describe("settling a stopped worker", () => {
  it("records the usage the provider reported", async () => {
    const store = ledgerStore();
    store.recordStageExecution(dispatched);
    const settled = await settleStageLedger({
      store,
      readUsage: async () => usage,
      jobId: "job_1",
      attemptId: dispatched.attemptId,
      stage: "plan",
      threadId: "thr_plan",
      outcome: "succeeded",
      now: 3_000,
    });
    expect(settled).toMatchObject({ outcome: "succeeded", usage, durationMs: 2_000 });
  });

  it("still settles when the provider cannot report usage", async () => {
    const store = ledgerStore();
    store.recordStageExecution(dispatched);
    const settled = await settleStageLedger({
      store,
      readUsage: async () => { throw new Error("provider unavailable"); },
      jobId: "job_1",
      attemptId: dispatched.attemptId,
      stage: "plan",
      threadId: "thr_plan",
      outcome: "failed",
      now: 3_000,
    });
    expect(settled).toMatchObject({ outcome: "failed", usage: null, costMicroUsd: null, durationMs: 2_000 });
  });

  it("does nothing for a worker with no ledger row of its own", async () => {
    const store = ledgerStore();
    const readUsage = vi.fn(async () => usage);
    expect(await settleStageLedger({
      store,
      readUsage,
      jobId: "job_1",
      attemptId: undefined,
      stage: "plan",
      threadId: "thr_adopted",
      outcome: "succeeded",
      now: 3_000,
    })).toBeNull();
    expect(readUsage).not.toHaveBeenCalled();
  });
});

function runnerSdk() {
  const spawns: Array<Record<string, unknown>> = [];
  const sdk = {
    projects: {
      list: vi.fn(async () => [{
        id: "proj_1",
        kind: "standard",
        name: "Project One",
        sources: [{ id: "src_1", isDefault: true, hostId: "host_1", path: "/project" }],
      }]),
      attachments: {
        upload: vi.fn(async (input: { filename: string }) => ({
          type: "localFile",
          path: `attachments/${input.filename}`,
          name: input.filename,
        })),
      },
    },
    threads: {
      spawn: vi.fn(async (input: Record<string, unknown>) => {
        spawns.push(input);
        return { id: `thr_${spawns.length}`, environmentId: "env_plan" };
      }),
      events: {
        list: vi.fn(async () => [
          {
            seq: 1,
            type: "thread/tokenUsage/updated",
            data: { tokenUsage: { total: { ...usage, totalTokens: 500 } } },
          },
          {
            seq: 2,
            type: "thread/tokenUsage/updated",
            data: { tokenUsage: { total: usage } },
          },
        ]),
      },
    },
  } as unknown as BbPluginApi["sdk"];
  return { runner: new BbRunner(sdk), spawns };
}

describe("the runner reports what each stage ran on", () => {
  it("escalates a repeated plan cycle onto a stronger tier and says so", async () => {
    const { runner, spawns } = runnerSdk();
    const job = jobFixture({
      state: "planning",
      projectId: "proj_1",
      policyVersion: 1,
      policy: policyFixture({ stageExecution: { plan: { tier: "fast" } } }),
      planCycle: 1,
    });
    const attempt: PipelineThreadAttempt = { id: "stage:job_1:2:spawn_plan", role: "PLAN", ordinal: 2 };
    await runner.spawnPlanner(job, attempt);

    expect(spawns[0]).toMatchObject({ model: "gpt-5.6-terra", reasoningLevel: "high", serviceTier: "default" });
    expect(jobStageExecution({ job, policy: job.policy!, stage: "plan", attemptOrdinal: attempt.ordinal })).toMatchObject({
      stage: "plan",
      baseTier: "fast",
      tier: "standard",
      escalationSteps: 1,
      source: "stage-policy",
      model: "gpt-5.6-terra",
    });
  });

  it("reports the tuple a first-pass plan ran on", async () => {
    const { runner, spawns } = runnerSdk();
    const job = jobFixture({
      state: "planning",
      projectId: "proj_1",
      policyVersion: 1,
      policy: policyFixture(),
    });
    const attempt: PipelineThreadAttempt = { id: "stage:job_1:1:spawn_plan", role: "PLAN", ordinal: 1 };
    await runner.spawnPlanner(job, attempt);

    expect(spawns[0]).toMatchObject({ model: "gpt-5.6-sol", serviceTier: "default" });
    expect(jobStageExecution({ job, policy: job.policy!, stage: "plan", attemptOrdinal: attempt.ordinal }))
      .toMatchObject({ tier: "strong", escalationSteps: 0, source: "default", model: "gpt-5.6-sol" });
  });

  it("reads a worker thread's total token usage", async () => {
    const { runner } = runnerSdk();
    expect(await runner.readThreadUsage("thr_1")).toEqual(usage);
  });
});
