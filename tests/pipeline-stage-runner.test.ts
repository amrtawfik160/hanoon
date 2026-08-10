import type { BbPluginApi } from "@bb/plugin-sdk";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { BbRunner } from "../src/bb/runner";
import {
  buildCritiquePacket,
  buildPlanArtifact,
  parseCritiqueResult,
} from "../src/bb/pipeline-handoffs";
import { openStore } from "../src/storage/store";
import { settlePipelineStageOutput } from "../src/services/pipeline-stage-runner";
import { jobFixture, policyFixture } from "./helpers";

function pipelineSdk() {
  const spawns: Array<Record<string, unknown>> = [];
  const uploads: Array<{ filename: string; clientFile: Uint8Array }> = [];
  const sdk = {
    projects: {
      list: vi.fn(async () => [{
        id: "proj_1",
        kind: "standard",
        name: "Project One",
        sources: [{ id: "src_1", isDefault: true, hostId: "host_1", path: "/project" }],
      }]),
      attachments: {
        upload: vi.fn(async (input: { filename: string; clientFile: Uint8Array; mimeType: string }) => {
          uploads.push(input);
          return { type: "localFile", path: `attachments/${input.filename}`, name: input.filename };
        }),
      },
    },
    threads: {
      spawn: vi.fn(async (input: Record<string, unknown>) => {
        spawns.push(input);
        return { id: `thr_${spawns.length}`, environmentId: "env_plan" };
      }),
      output: vi.fn(async () => ({ output: "# Plan\n\n1. Add the regression.\n" })),
    },
  } as unknown as BbPluginApi["sdk"];
  return { runner: new BbRunner(sdk), spawns, uploads };
}

const plannedJob = jobFixture({
  state: "planning",
  projectId: "proj_1",
  policyVersion: 1,
  policy: policyFixture(),
});

describe("pipeline handoffs", () => {
  it("turns bounded planner output into a hashed plan attachment and validates strict critique JSON", () => {
    const plan = buildPlanArtifact("# Plan\n\n1. Add the regression.\n");
    const critique = buildCritiquePacket(plannedJob, plan);

    expect(plan).toMatchObject({ filename: "plan.md", mimeType: "text/markdown" });
    expect(plan.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new TextDecoder().decode(critique.bytes)).toContain(plan.sha256);
    expect(parseCritiqueResult('{"verdict":"pass","summary":"Complete and testable"}')).toEqual({
      verdict: "pass",
      summary: "Complete and testable",
    });
    expect(() => parseCritiqueResult("```json\n{}\n```")).toThrow(/strict JSON/i);
    expect(() => buildPlanArtifact("  \n")).toThrow(/non-empty/i);
    expect(() => buildPlanArtifact("x".repeat(65_537))).toThrow(/bounded/i);
  });
});

describe("fresh planner, critic, and builder conversations", () => {
  it("hands critique revisions to a fresh planner as a file in the same worktree", async () => {
    const { runner, spawns, uploads } = pipelineSdk();
    await runner.spawnPlanner(
      { ...plannedJob, environmentId: "env_plan", planCycle: 1 },
      { id: "stage_plan_2", role: "PLAN", ordinal: 2 },
      '{"verdict":"needs_revision","summary":"Add rollback evidence"}',
    );

    expect(spawns[0]).toMatchObject({
      environment: { type: "reuse", environmentId: "env_plan" },
      input: [
        { type: "text", text: expect.stringContaining("critique artifact") },
        { type: "localFile", path: "attachments/work-order.md" },
        { type: "localFile", path: "attachments/critique.json" },
      ],
    });
    expect(JSON.stringify(spawns[0])).not.toContain("Add rollback evidence");
    expect(uploads.map((upload) => upload.filename)).toEqual(["work-order.md", "critique.json"]);
  });

  it("uses Luna Max for fresh plan and critique spawns, then hands only files to the builder", async () => {
    const { runner, spawns, uploads } = pipelineSdk();
    const planAttempt = { id: "stage_plan_1", role: "PLAN" as const, ordinal: 1 };
    const planThread = await runner.spawnPlanner(plannedJob, planAttempt);
    const plan = buildPlanArtifact(await runner.getThreadOutput(planThread.id));
    const critiqueAttempt = { id: "stage_critique_1", role: "CRITIQUE" as const, ordinal: 1 };
    await runner.spawnCritic(
      { ...plannedJob, state: "critiquing", environmentId: "env_plan" },
      critiqueAttempt,
      { ...planAttempt, threadId: planThread.id, environmentId: "env_plan", outputText: new TextDecoder().decode(plan.bytes) },
    );
    await runner.spawnBuilderFromPlan(
      { ...plannedJob, state: "creating_implementation", environmentId: "env_plan" },
      { id: "attempt_impl_1" },
      { ...planAttempt, threadId: planThread.id, environmentId: "env_plan", outputText: new TextDecoder().decode(plan.bytes) },
    );

    expect(spawns).toHaveLength(3);
    for (const spawn of spawns.slice(0, 2)) {
      expect(spawn).toMatchObject({
        providerId: "codex",
        model: "gpt-5.6-luna",
        reasoningLevel: "max",
        serviceTier: "fast",
        permissionMode: "auto",
      });
      expect(spawn).not.toHaveProperty("sourceThreadId");
    }
    expect(spawns[0]).toMatchObject({
      environment: {
        type: "host",
        hostId: "host_1",
        workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "main" } },
      },
    });
    expect(spawns[1]).toMatchObject({ environment: { type: "reuse", environmentId: "env_plan" } });
    expect(spawns[2]).toMatchObject({
      environment: { type: "reuse", environmentId: "env_plan" },
      model: "implementation-model",
      input: [
        { type: "text", text: expect.stringMatching(/read the attached.*work order.*plan/i) },
        { type: "localFile", path: "attachments/work-order.md" },
        { type: "localFile", path: "attachments/plan.md" },
      ],
    });
    expect(uploads.map((upload) => upload.filename)).toEqual([
      "work-order.md",
      "work-order.md",
      "plan.md",
      "critique-packet.json",
      "work-order.md",
      "plan.md",
    ]);
  });

  it("persists stage identity and output under an active executor fence", () => {
    const { bb } = createFakePluginHost({ pluginId: "telegram-agent-pipeline-storage" });
    const store = openStore(bb.storage);
    store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "work", now: 1_000 });
    const lease = store.acquireExecutorLease("executor", 1_001, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    const attempt = store.createPipelineStageAttempt({
      id: "stage_plan_1",
      jobId: "job_1",
      role: "PLAN",
      ordinal: 1,
      inputSha256: "a".repeat(64),
      now: 1_002,
      ownerId: "executor",
      generation: lease.generation,
    });

    expect(store.bindPipelineStageThread({
      id: attempt.id,
      threadId: "thr_plan",
      environmentId: "env_plan",
      now: 1_003,
      ownerId: "executor",
      generation: lease.generation,
    })).toBe(true);
    expect(store.completePipelineStageAttempt({
      id: attempt.id,
      outputText: "# Plan\n",
      outputSha256: "b".repeat(64),
      outcome: { verdict: "success" },
      now: 1_004,
      ownerId: "executor",
      generation: lease.generation,
    })).toBe(true);
    expect(store.getLatestPipelineStageAttempt("job_1", "PLAN")).toMatchObject({
      threadId: "thr_plan",
      environmentId: "env_plan",
      state: "completed",
      outputText: "# Plan\n",
      outputSha256: "b".repeat(64),
    });
    expect(store.findJobByThreadId("thr_plan")?.id).toBe("job_1");
  });

  it("settles durable plan and critique output into the canonical job transitions", () => {
    const { bb } = createFakePluginHost({ pluginId: "telegram-agent-pipeline-settlement" });
    const store = openStore(bb.storage);
    const draft = store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "work", now: 1_000 });
    const selected = store.applyJobEvent(draft.id, draft.version, {
      type: "PROJECT_SELECTED",
      projectId: "proj_1",
      policyVersion: 1,
      policy: policyFixture(),
    }, 1_001);
    let job = store.applyJobEvent(draft.id, selected.version, { type: "CONFIRMED" }, 1_002);
    const lease = store.acquireExecutorLease("executor", 1_003, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    const fence = { ownerId: "executor", generation: lease.generation };
    let attempt = store.createPipelineStageAttempt({
      id: "stage_plan_1",
      jobId: job.id,
      role: "PLAN",
      ordinal: 1,
      inputSha256: "a".repeat(64),
      ...fence,
      now: 1_004,
    });
    expect(store.bindPipelineStageThread({
      id: attempt.id,
      threadId: "thr_plan",
      environmentId: "env_plan",
      ...fence,
      now: 1_005,
    })).toBe(true);
    job = store.applyJobEvent(job.id, job.version, {
      type: "PLAN_CREATED",
      attemptId: attempt.id,
      threadId: "thr_plan",
      environmentId: "env_plan",
    }, 1_005);
    attempt = store.getPipelineStageAttempt(attempt.id)!;

    expect(settlePipelineStageOutput({
      store,
      job,
      attempt,
      output: "# Plan\n\n1. Add a regression test.\n",
      fence,
      now: 1_006,
    })).toEqual({ outcome: "advanced", nextState: "critiquing" });

    job = store.getJob(job.id)!;
    let critique = store.createPipelineStageAttempt({
      id: "stage_critique_1",
      jobId: job.id,
      role: "CRITIQUE",
      ordinal: 1,
      inputSha256: "b".repeat(64),
      ...fence,
      now: 1_007,
    });
    expect(store.bindPipelineStageThread({
      id: critique.id,
      threadId: "thr_critique",
      environmentId: "env_plan",
      ...fence,
      now: 1_008,
    })).toBe(true);
    critique = store.getPipelineStageAttempt(critique.id)!;

    expect(settlePipelineStageOutput({
      store,
      job,
      attempt: critique,
      output: '{"verdict":"pass","summary":"Complete and testable"}',
      fence,
      now: 1_009,
    })).toEqual({ outcome: "advanced", nextState: "creating_implementation" });
    expect(store.getJob(job.id)?.state).toBe("creating_implementation");
  });
});
