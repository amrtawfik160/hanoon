import { buildCritiqueArtifact, buildPlanArtifact, parseCritiqueResult } from "../bb/pipeline-handoffs";
import type { Job } from "../domain/models";
import type { PipelineStageAttempt, TelegramAgentStore } from "../storage/store";

export type PipelineStageFence = {
  ownerId: string;
  generation: number;
};

export type PipelineStageSettlement =
  | { outcome: "advanced"; nextState: "critiquing" | "creating_implementation" | "planning" | "blocked" }
  | { outcome: "ignored" }
  | { outcome: "invalid"; error: string };

function invalidStageOutput(
  store: TelegramAgentStore,
  job: Job,
  attempt: PipelineStageAttempt,
  fence: PipelineStageFence,
  now: number,
): PipelineStageSettlement {
  const error = `${attempt.role === "PLAN" ? "plan" : "critique"} returned invalid bounded output`;
  store.failPipelineStageAttempt({ id: attempt.id, error, ...fence, now });
  const latest = store.getJob(job.id);
  const expectedState = attempt.role === "PLAN" ? "planning" : "critiquing";
  if (latest?.state === expectedState && latest.cancelRequestedAt === null) {
    store.applyJobEvent(job.id, latest.version, { type: "FAILED", error }, now);
  }
  return { outcome: "invalid", error };
}

export function settlePipelineStageOutput(input: {
  store: TelegramAgentStore;
  job: Job;
  attempt: PipelineStageAttempt;
  output: string;
  fence: PipelineStageFence;
  now: number;
}): PipelineStageSettlement {
  const { store, job, attempt, output, fence, now } = input;
  const expectedRole = job.state === "planning" ? "PLAN" : job.state === "critiquing" ? "CRITIQUE" : null;
  if (expectedRole === null || attempt.jobId !== job.id || attempt.role !== expectedRole) return { outcome: "ignored" };

  if (attempt.role === "PLAN") {
    let artifact;
    try {
      artifact = buildPlanArtifact(output);
    } catch {
      return invalidStageOutput(store, job, attempt, fence, now);
    }
    const completed = store.completePipelineStageAttempt({
      id: attempt.id,
      outputText: new TextDecoder().decode(artifact.bytes),
      outputSha256: artifact.sha256,
      outcome: { verdict: "success" },
      ...fence,
      now,
    });
    if (!completed) return { outcome: "ignored" };
    const latest = store.getJob(job.id);
    if (!latest || latest.state !== "planning" || latest.cancelRequestedAt !== null) return { outcome: "ignored" };
    const advanced = store.applyJobEvent(job.id, latest.version, { type: "PLAN_READY", attemptId: attempt.id }, now);
    return { outcome: "advanced", nextState: advanced.state as "critiquing" };
  }

  let verdict;
  try {
    verdict = parseCritiqueResult(output);
  } catch {
    return invalidStageOutput(store, job, attempt, fence, now);
  }
  const artifact = buildCritiqueArtifact(verdict);
  const completed = store.completePipelineStageAttempt({
    id: attempt.id,
    outputText: new TextDecoder().decode(artifact.bytes),
    outputSha256: artifact.sha256,
    outcome: verdict,
    ...fence,
    now,
  });
  if (!completed) return { outcome: "ignored" };
  const latest = store.getJob(job.id);
  if (!latest || latest.state !== "critiquing" || latest.cancelRequestedAt !== null) return { outcome: "ignored" };
  const advanced = store.applyJobEvent(job.id, latest.version, verdict.verdict === "pass"
    ? { type: "CRITIQUE_PASSED", attemptId: attempt.id }
    : { type: "CRITIQUE_NEEDS_REVISION", attemptId: attempt.id, summary: verdict.summary }, now);
  return {
    outcome: "advanced",
    nextState: advanced.state as "creating_implementation" | "planning" | "blocked",
  };
}
