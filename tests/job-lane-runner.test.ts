import { describe, expect, it, vi } from "vitest";
import {
  JobLaneRunner,
  type JobLaneKind,
  type JobLaneOperation,
} from "../src/services/job-lane-runner";

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function operation(
  jobId: string,
  operationKey: string,
  kind: JobLaneKind,
  work: Deferred,
  onSignal?: (signal: AbortSignal) => void,
): JobLaneOperation {
  return {
    jobId,
    operationKey,
    kind,
    run: async (signal) => {
      onSignal?.(signal);
      await work.promise;
    },
  };
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("JobLaneRunner", () => {
  it("allows different jobs to overlap while sharing one guard across lane kinds", () => {
    const lanes = new JobLaneRunner({
      maxPipelineLanes: () => 2,
      maxControlLanes: 8,
    });
    const slowA = deferred();
    const slowB = deferred();
    const fastControl = deferred();

    expect(lanes.tryStart(operation("job_a", "reconcile", "pipeline", slowA))).toBe(true);
    expect(lanes.tryStart(operation("job_b", "effect:spawn_plan", "pipeline", slowB))).toBe(true);
    expect(lanes.tryStart(operation("job_a", "effect:render_status", "control", fastControl))).toBe(false);
    expect(lanes.snapshot()).toMatchObject({ pipelineActive: 2, controlActive: 0 });
    expect(lanes.snapshot().busyJobIds).toEqual(["job_a", "job_b"]);
  });

  it("bounds control operations separately from pipeline operations", () => {
    const lanes = new JobLaneRunner({
      maxPipelineLanes: () => 1,
      maxControlLanes: 8,
    });
    const pipeline = deferred();
    expect(lanes.tryStart(operation("pipeline_job", "pipeline", "pipeline", pipeline))).toBe(true);

    const controls = Array.from({ length: 9 }, (_, index) => deferred());
    for (let index = 0; index < 8; index += 1) {
      expect(lanes.tryStart(operation(`control_job_${index}`, `control_${index}`, "control", controls[index]))).toBe(true);
    }
    expect(lanes.tryStart(operation("control_job_8", "control_8", "control", controls[8]))).toBe(false);
    expect(lanes.snapshot()).toMatchObject({ pipelineActive: 1, controlActive: 8 });
  });

  it("collects rejection once and nudges the executor without an unhandled rejection", async () => {
    const onCompletion = vi.fn();
    const lanes = new JobLaneRunner({
      maxPipelineLanes: () => 1,
      maxControlLanes: 8,
      onCompletion,
    });
    const failure = new Error("provider token must not be persisted");
    const rejected = {
      jobId: "job_rejected",
      operationKey: "effect:spawn_plan",
      kind: "pipeline" as const,
      run: async () => { throw failure; },
    } satisfies JobLaneOperation;

    expect(lanes.tryStart(rejected)).toBe(true);
    await settleMicrotasks();

    expect(lanes.drainCompletions()).toEqual([{
      jobId: "job_rejected",
      operationKey: "effect:spawn_plan",
      kind: "pipeline",
      outcome: "rejected",
      error: failure,
    }]);
    expect(onCompletion).toHaveBeenCalledOnce();
    expect(lanes.snapshot()).toMatchObject({ pipelineActive: 0, controlActive: 0, busyJobIds: [] });
  });

  it("signals every live operation and ignores a late old completion when the job restarts", async () => {
    const lanes = new JobLaneRunner({
      maxPipelineLanes: () => 2,
      maxControlLanes: 8,
    });
    const oldOperation = deferred();
    const siblingOperation = deferred();
    const currentOperation = deferred();
    const signals: AbortSignal[] = [];
    const old = operation("job_takeover", "generation_1", "pipeline", oldOperation, (signal) => signals.push(signal));
    const sibling = operation("job_sibling", "sibling", "pipeline", siblingOperation, (signal) => signals.push(signal));
    const current = operation("job_takeover", "generation_2", "pipeline", currentOperation);

    expect(lanes.tryStart(old)).toBe(true);
    expect(lanes.tryStart(sibling)).toBe(true);
    const reason = new Error("singleton lease was lost");
    lanes.abortAll(reason);
    expect(signals).toHaveLength(2);
    for (const signal of signals) {
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBe(reason);
    }
    expect(lanes.snapshot()).toMatchObject({ pipelineActive: 0, controlActive: 0, busyJobIds: [] });
    expect(lanes.tryStart(current)).toBe(true);

    oldOperation.resolve();
    siblingOperation.resolve();
    await settleMicrotasks();
    expect(lanes.drainCompletions()).toEqual(expect.arrayContaining([{
      jobId: "job_takeover",
      operationKey: "generation_1",
      kind: "pipeline",
      outcome: "fulfilled",
      error: null,
    }, {
      jobId: "job_sibling",
      operationKey: "sibling",
      kind: "pipeline",
      outcome: "fulfilled",
      error: null,
    }]));
    expect(lanes.hasJob("job_takeover")).toBe(true);
    expect(lanes.snapshot()).toMatchObject({ pipelineActive: 1, controlActive: 0 });

    currentOperation.resolve();
    await settleMicrotasks();
    expect(lanes.drainCompletions()).toEqual([{
      jobId: "job_takeover",
      operationKey: "generation_2",
      kind: "pipeline",
      outcome: "fulfilled",
      error: null,
    }]);
    expect(lanes.hasJob("job_takeover")).toBe(false);
  });
});
