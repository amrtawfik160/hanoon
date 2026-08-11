export type JobLaneKind = "pipeline" | "control";

export type JobLaneOperation = Readonly<{
  jobId: string;
  operationKey: string;
  kind: JobLaneKind;
  run(signal: AbortSignal): Promise<void>;
}>;

export type JobLaneCompletion = Readonly<{
  jobId: string;
  operationKey: string;
  kind: JobLaneKind;
  outcome: "fulfilled" | "rejected";
  error: unknown | null;
}>;

export type JobLaneSnapshot = Readonly<{
  pipelineActive: number;
  controlActive: number;
  busyJobIds: readonly string[];
}>;

const EMPTY_SNAPSHOT: JobLaneSnapshot = Object.freeze({
  pipelineActive: 0,
  controlActive: 0,
  busyJobIds: Object.freeze([]) as readonly string[],
});

export type ReadonlyJobLaneSnapshotProvider = {
  snapshot(): JobLaneSnapshot;
};

export class JobLaneSnapshotProvider {
  private source: JobLaneRunner | null = null;

  public attach(source: JobLaneRunner): void {
    this.source = source;
  }

  public detach(source: JobLaneRunner): void {
    if (this.source === source) this.source = null;
  }

  public snapshot(): JobLaneSnapshot {
    return this.source?.snapshot() ?? EMPTY_SNAPSHOT;
  }
}

export type JobLaneRunnerOptions = Readonly<{
  maxPipelineLanes: () => number;
  maxControlLanes: number;
  onCompletion?: () => void;
}>;

type LiveOperation = Readonly<{
  identity: symbol;
  operation: JobLaneOperation;
  controller: AbortController;
}>;

const HARD_LANE_LIMIT = 8;

function validLaneLimit(limit: number): number | null {
  if (!Number.isSafeInteger(limit) || limit < 1) return null;
  return Math.min(limit, HARD_LANE_LIMIT);
}

export class JobLaneRunner {
  private readonly liveOperations = new Map<symbol, LiveOperation>();
  private readonly currentByJob = new Map<string, LiveOperation>();
  private readonly completions: JobLaneCompletion[] = [];
  private readonly maxPipelineLanes: () => number;
  private readonly maxControlLanes: number;
  private readonly onCompletion: () => void;

  public constructor(options: JobLaneRunnerOptions) {
    this.maxPipelineLanes = options.maxPipelineLanes;
    this.maxControlLanes = options.maxControlLanes;
    this.onCompletion = options.onCompletion ?? (() => undefined);
  }

  public tryStart(operation: JobLaneOperation): boolean {
    if (this.currentByJob.has(operation.jobId)) return false;
    if (!this.hasCapacity(operation.kind)) return false;

    const live: LiveOperation = {
      identity: Symbol(operation.operationKey),
      operation,
      controller: new AbortController(),
    };
    this.liveOperations.set(live.identity, live);
    this.currentByJob.set(operation.jobId, live);
    void this.runOperation(live);
    return true;
  }

  public hasJob(jobId: string): boolean {
    return this.currentByJob.has(jobId);
  }

  public drainCompletions(): JobLaneCompletion[] {
    const drained = this.completions.splice(0, this.completions.length);
    return drained;
  }

  public snapshot(): JobLaneSnapshot {
    let pipelineActive = 0;
    let controlActive = 0;
    for (const live of this.liveOperations.values()) {
      if (live.operation.kind === "pipeline") pipelineActive += 1;
      else controlActive += 1;
    }
    return {
      pipelineActive,
      controlActive,
      busyJobIds: [...this.currentByJob.keys()].sort(),
    };
  }

  public abortAll(reason: Error): void {
    for (const live of this.liveOperations.values()) live.controller.abort(reason);
    this.liveOperations.clear();
    this.currentByJob.clear();
  }

  private hasCapacity(kind: JobLaneKind): boolean {
    const limit = kind === "pipeline"
      ? validLaneLimit(this.maxPipelineLanes())
      : validLaneLimit(this.maxControlLanes);
    if (limit === null) return false;
    return this.activeCount(kind) < limit;
  }

  private activeCount(kind: JobLaneKind): number {
    let active = 0;
    for (const live of this.liveOperations.values()) {
      if (live.operation.kind === kind) active += 1;
    }
    return active;
  }

  private async runOperation(live: LiveOperation): Promise<void> {
    let outcome: JobLaneCompletion["outcome"] = "fulfilled";
    let error: unknown | null = null;
    try {
      await live.operation.run(live.controller.signal);
    } catch (operationError) {
      outcome = "rejected";
      error = operationError;
    }
    this.completions.push({
      jobId: live.operation.jobId,
      operationKey: live.operation.operationKey,
      kind: live.operation.kind,
      outcome,
      error,
    });
    this.removeIfCurrent(live);
    try {
      this.onCompletion();
    } catch {
      // Completion nudges are advisory; an observer must not create an
      // unhandled rejection after the lane result has been collected.
    }
  }

  private removeIfCurrent(live: LiveOperation): void {
    this.liveOperations.delete(live.identity);
    const current = this.currentByJob.get(live.operation.jobId);
    if (current?.identity === live.identity) this.currentByJob.delete(live.operation.jobId);
  }
}
