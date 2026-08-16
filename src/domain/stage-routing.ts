import type { ModelRoute } from "../capabilities/models";
import type { Job, ProjectPolicy } from "./models";
import {
  capabilityRouteExecution,
  resolveStageExecution,
  stageEscalationSteps,
  type PipelineStage,
  type ResolvedStageExecution,
} from "./stage-execution";

/**
 * One answer to "what does this stage of this job run on", shared by the code
 * that dispatches the worker and the code that records what it ran on, so the
 * ledger can never disagree with the spawn.
 */

/**
 * A repeated plan or review cycle is the pipeline saying the work was harder
 * than the cheap tier could handle, so it escalates the next attempt the same
 * way a repeated attempt does. The mechanical stages have no repeat counter of
 * their own and escalate on attempt ordinal alone.
 */
function repeatedCycles(job: Job, stage: PipelineStage): number {
  if (stage === "plan" || stage === "critique") return job.planCycle;
  if (stage === "implementation" || stage === "review") return job.reviewCycle;
  return 0;
}

export type JobStageExecutionInput = Readonly<{
  job: Job;
  policy: ProjectPolicy;
  stage: PipelineStage;
  attemptOrdinal?: number;
  /**
   * Set while a job routes through the capability router, which owns model
   * choice for the whole attempt. The stage table still decides permission.
   */
  capabilityRoute?: ModelRoute;
}>;

export function jobStageExecution(input: JobStageExecutionInput): ResolvedStageExecution {
  const configured = resolveStageExecution({
    stage: input.stage,
    stageExecution: input.policy.stageExecution,
    legacy: { implementation: input.policy.implementation, review: input.policy.review },
    escalationSteps: stageEscalationSteps({
      attemptOrdinal: input.attemptOrdinal,
      repeatedCycles: repeatedCycles(input.job, input.stage),
    }),
  });
  if (input.capabilityRoute === undefined) return configured;
  return capabilityRouteExecution({
    stage: input.stage,
    tier: input.capabilityRoute.pool,
    providerId: input.capabilityRoute.providerId,
    model: input.capabilityRoute.modelId,
    reasoningLevel: input.capabilityRoute.reasoning,
    serviceTier: input.capabilityRoute.serviceTier,
    permissionMode: configured.permissionMode,
  });
}
