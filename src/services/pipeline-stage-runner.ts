import {
  buildCritiqueArtifact,
  buildDocsReportArtifact,
  buildPlanArtifact,
  parseCritiqueResult,
  parseDocsReport,
  parseVerificationPlan,
  type DocsObservation,
} from "../bb/pipeline-handoffs";
import { recordDocumentationCapabilityOutcomes } from "../capabilities/outcomes";
import type { Job, JobEvent } from "../domain/models";
import type { PipelineStageAttempt, TelegramAgentStore } from "../storage/store";

export type PipelineStageFence = {
  ownerId: string;
  generation: number;
};

export type PipelineStageSettlement =
  | { outcome: "advanced"; nextState: "critiquing" | "creating_implementation" | "planning" | "blocked" | "resolving_docs_head" }
  | { outcome: "ignored" }
  | { outcome: "invalid"; error: string };

function invalidStageOutput(
  store: TelegramAgentStore,
  job: Job,
  attempt: PipelineStageAttempt,
  fence: PipelineStageFence,
  now: number,
): PipelineStageSettlement {
  const label = attempt.role === "PLAN" ? "plan" : attempt.role === "CRITIQUE" ? "critique" : "docs";
  const error = `${label} returned invalid bounded output`;
  if (!store.failPipelineStageAttempt({ id: attempt.id, error, ...fence, now })) {
    return { outcome: "ignored" };
  }
  const latest = store.getJob(job.id);
  const expectedState = attempt.role === "PLAN" ? "planning" : attempt.role === "CRITIQUE" ? "critiquing" : "documenting";
  if (latest?.state === expectedState && latest.cancelRequestedAt === null) {
    if (!applyExecutorEvent(store, job.id, latest.version, { type: "FAILED", error }, fence, now)) {
      return { outcome: "ignored" };
    }
  }
  return { outcome: "invalid", error };
}

function failCapabilityStage(
  store: TelegramAgentStore,
  job: Job,
  attempt: PipelineStageAttempt,
  fence: PipelineStageFence,
  now: number,
): PipelineStageSettlement {
  const error = "Mandatory capability evidence is incomplete";
  if (!store.failPipelineStageAttempt({ id: attempt.id, error, ...fence, now })) {
    return { outcome: "ignored" };
  }
  const latest = store.getJob(job.id);
  if (latest?.state === "documenting" && latest.cancelRequestedAt === null) {
    if (!applyExecutorEvent(store, job.id, latest.version, { type: "FAILED", error }, fence, now)) {
      return { outcome: "ignored" };
    }
  }
  return { outcome: "invalid", error };
}

function applyExecutorEvent(
  store: TelegramAgentStore,
  jobId: string,
  expectedVersion: number,
  event: JobEvent,
  fence: PipelineStageFence,
  now: number,
): Job | null {
  return store.applyExecutorJobEvent({ jobId, expectedVersion, event, ...fence, now });
}

export function settlePipelineStageOutput(input: {
  store: TelegramAgentStore;
  job: Job;
  attempt: PipelineStageAttempt;
  output: string;
  docsObservation?: DocsObservation;
  fence: PipelineStageFence;
  now: number;
}): PipelineStageSettlement {
  const { store, job, attempt, output, docsObservation, fence, now } = input;
  const expectedRole = job.state === "planning" ? "PLAN"
    : job.state === "critiquing" ? "CRITIQUE"
    : job.state === "documenting" ? "DOCS"
    : null;
  if (expectedRole === null || attempt.jobId !== job.id || attempt.role !== expectedRole) return { outcome: "ignored" };

  if (attempt.role === "PLAN") {
    let artifact;
    let verification;
    try {
      artifact = buildPlanArtifact(output);
      if (!job.policy) throw new TypeError("Plan requires immutable project policy");
      verification = parseVerificationPlan(new TextDecoder().decode(artifact.bytes), job.policy);
    } catch {
      return invalidStageOutput(store, job, attempt, fence, now);
    }
    const completed = store.completePipelineStageAttempt({
      id: attempt.id,
      outputText: new TextDecoder().decode(artifact.bytes),
      outputSha256: artifact.sha256,
      outcome: { verdict: "success", verification },
      ...fence,
      now,
    });
    if (!completed) return { outcome: "ignored" };
    const latest = store.getJob(job.id);
    if (!latest || latest.state !== "planning" || latest.cancelRequestedAt !== null) return { outcome: "ignored" };
    const advanced = applyExecutorEvent(store, job.id, latest.version, { type: "PLAN_READY", attemptId: attempt.id }, fence, now);
    if (!advanced) return { outcome: "ignored" };
    return { outcome: "advanced", nextState: advanced.state as "critiquing" };
  }

  if (attempt.role === "DOCS") {
    let artifact;
    let documentation;
    try {
      artifact = buildDocsReportArtifact(output);
      if (!docsObservation) throw new TypeError("Docs settlement requires observed worktree evidence");
      documentation = parseDocsReport(new TextDecoder().decode(artifact.bytes), docsObservation);
    } catch {
      return invalidStageOutput(store, job, attempt, fence, now);
    }
    if (job.routingMode !== "legacy") {
      const profile = store.getLatestCapabilityProfile("worker_attempt", attempt.id);
      const profileMatches = profile !== null && profile.subjectId === attempt.id &&
        profile.recipeId === job.taskRecipe && profile.recipeVersion === job.recipeVersion &&
        profile.mode === job.routingMode;
      if (!profileMatches) {
        if (job.routingMode === "active") return failCapabilityStage(store, job, attempt, fence, now);
      } else {
        const settlement = recordDocumentationCapabilityOutcomes({
          store,
          profileId: profile.id,
          reportSha256: artifact.sha256,
          report: documentation,
          observation: docsObservation,
          now,
        });
        if (!settlement.satisfied && job.routingMode === "active") {
          return failCapabilityStage(store, job, attempt, fence, now);
        }
      }
    }
    const completed = store.completePipelineStageAttempt({
      id: attempt.id,
      outputText: new TextDecoder().decode(artifact.bytes),
      outputSha256: artifact.sha256,
      outcome: { verdict: "success", documentation },
      ...fence,
      now,
    });
    if (!completed) return { outcome: "ignored" };
    const latest = store.getJob(job.id);
    if (!latest || latest.state !== "documenting" || latest.cancelRequestedAt !== null) return { outcome: "ignored" };
    const advanced = applyExecutorEvent(store, job.id, latest.version, { type: "DOCS_IDLE" }, fence, now);
    if (!advanced) return { outcome: "ignored" };
    return { outcome: "advanced", nextState: advanced.state as "resolving_docs_head" };
  }

  let verdict;
  try {
    verdict = parseCritiqueResult(output);
  } catch {
    verdict = {
      verdict: "needs_revision" as const,
      summary: "Critique output was not valid JSON; rewrite the plan so it is concrete and testable.",
    };
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
  const advanced = applyExecutorEvent(store, job.id, latest.version, verdict.verdict === "pass"
    ? { type: "CRITIQUE_PASSED", attemptId: attempt.id }
    : { type: "CRITIQUE_NEEDS_REVISION", attemptId: attempt.id, summary: verdict.summary }, fence, now);
  if (!advanced) return { outcome: "ignored" };
  return {
    outcome: "advanced",
    nextState: advanced.state as "creating_implementation" | "planning" | "blocked",
  };
}
