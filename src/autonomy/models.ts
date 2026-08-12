import type {
  JobEffect,
  JobState,
  ProjectPolicy,
  WorkerLiveness,
} from "../domain/models";

export const DEFAULT_MAX_CONCURRENT_JOBS = 5;
export const MAX_CONCURRENT_JOBS = 8;

export type MaxConcurrentJobs = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type AdmissionState = "queued" | "admitted" | "draining" | "released";
export type AdmissionResumeEvent = "CONFIRMED" | "CONTINUE_REVIEW";
export type ResourceKind = "project" | "repository_merge" | "production_target";

export const RELEASE_CANDIDATE_JOB_STATES: readonly JobState[] = [
  "blocked",
  "cancelled",
  "merged",
  "production_failed",
  "complete",
];

export type JobAdmission = Readonly<{
  jobId: string;
  projectId: string;
  queueSeq: number;
  state: AdmissionState;
  resumeEvent: AdmissionResumeEvent;
  queuedAt: number;
  admittedAt: number | null;
  drainingAt: number | null;
  releasedAt: number | null;
  releaseReason: string | null;
}>;

export type JobResourceClaim = Readonly<{
  claimId: number;
  jobId: string;
  resourceKey: string;
  resourceKind: ResourceKind;
  state: "held" | "released";
  ownerId: string;
  generation: number;
  leaseExpiresAt: number;
  acquiredAt: number;
  renewedAt: number;
  releasedAt: number | null;
  releaseReason: string | null;
}>;

const RELEASE_CANDIDATE_STATES = new Set<JobState>(RELEASE_CANDIDATE_JOB_STATES);

const SAFE_CONTROL_EFFECTS = new Set<JobEffect["kind"]>([
  "render_status",
  "revoke_approvals",
]);

export function projectResourceKey(projectId: string): string {
  return `project:${projectId}:pipeline`;
}

export function repositoryMergeResourceKey(repository: string): string {
  return `repository:${repository.toLowerCase()}:merge`;
}

export function productionResourceKey(policy: ProjectPolicy): string {
  return `production:${policy.production?.targetKey ?? policy.projectId}`;
}

export function isReleaseCandidate(state: JobState): boolean {
  return RELEASE_CANDIDATE_STATES.has(state);
}

export function isSafeControlEffect(kind: JobEffect["kind"]): boolean {
  return SAFE_CONTROL_EFFECTS.has(kind);
}

function matchesDurableWorker(
  admission: JobAdmission,
  effect: JobEffect,
  worker: WorkerLiveness | null | undefined,
): boolean {
  if (!worker || effect.kind !== "stop_thread" || worker.jobId !== admission.jobId) return false;
  return effect.payload.generation === worker.generation &&
    effect.payload.resourceId === worker.resourceId &&
    effect.payload.resourceKind === worker.resourceKind &&
    effect.payload.workerKind === worker.workerKind;
}

export function admissionAllowsEffect(
  admission: JobAdmission,
  effect: JobEffect,
  worker: WorkerLiveness | null | undefined,
): boolean {
  if (effect.jobId !== admission.jobId) return false;
  if (admission.state === "released") return false;
  if (admission.state === "queued") return isSafeControlEffect(effect.kind);
  if (admission.state === "admitted") return true;
  return isSafeControlEffect(effect.kind) || matchesDurableWorker(admission, effect, worker);
}
