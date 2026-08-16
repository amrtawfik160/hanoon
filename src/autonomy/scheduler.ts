import { MAX_CONCURRENT_JOBS, projectResourceKey } from "./models";
import type {
  AdmissionAttempt,
  AdmissionAttemptInput,
  AutonomyRepository,
} from "../storage/autonomy-repository";

export type AdmissionCandidate = Readonly<{
  jobId: string;
  projectId: string;
  queueSeq: number;
}>;

export type AdmissionSelectionInput = Readonly<{
  candidates: readonly AdmissionCandidate[];
  heldProjectKeys: ReadonlySet<string>;
  availableSlots: number;
  /**
   * Projects whose work is on hold because the same failure kept repeating.
   * Their queued jobs stay queued rather than being cancelled: the owner is
   * deciding, and the work should still be there when they do.
   */
  pausedProjectIds?: ReadonlySet<string>;
}>;

export type SchedulerRunInput = Readonly<Omit<AdmissionAttemptInput, "jobId">>;

export type SchedulerRunResult = Readonly<{
  occupiedCount: number;
  availableSlots: number;
  admissions: readonly AdmissionAttempt[];
}>;

function compareCandidates(left: AdmissionCandidate, right: AdmissionCandidate): number {
  if (left.queueSeq !== right.queueSeq) return left.queueSeq - right.queueSeq;
  if (left.jobId < right.jobId) return -1;
  if (left.jobId > right.jobId) return 1;
  return 0;
}

export function selectOldestEligibleAdmissions(
  input: AdmissionSelectionInput,
): AdmissionCandidate[] {
  if (
    !Number.isInteger(input.availableSlots) ||
    input.availableSlots < 0 ||
    input.availableSlots > MAX_CONCURRENT_JOBS
  ) {
    throw new TypeError("availableSlots must be an integer from 0 through 8");
  }

  const orderedCandidates = [...input.candidates].sort(compareCandidates);
  const selected: AdmissionCandidate[] = [];
  const seenProjects = new Set<string>();
  for (const candidate of orderedCandidates) {
    if (selected.length >= input.availableSlots) break;
    if (input.pausedProjectIds?.has(candidate.projectId)) continue;
    if (seenProjects.has(candidate.projectId)) continue;
    seenProjects.add(candidate.projectId);
    if (input.heldProjectKeys.has(projectResourceKey(candidate.projectId))) continue;
    selected.push(candidate);
  }
  return selected;
}

function assertSchedulerInput(input: SchedulerRunInput): void {
  if (!Number.isSafeInteger(input.maxConcurrentJobs) || input.maxConcurrentJobs < 1 || input.maxConcurrentJobs > MAX_CONCURRENT_JOBS) {
    throw new TypeError("maxConcurrentJobs must be an integer from 1 through 8");
  }
  if (typeof input.ownerId !== "string" || input.ownerId.length === 0 || input.ownerId.length > 256) {
    throw new TypeError("ownerId must be a bounded non-empty string");
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new TypeError("generation must be a positive safe integer");
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw new TypeError("now must be a non-negative safe integer");
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) throw new TypeError("leaseMs must be a positive safe integer");
}

function heldProjectKeys(repository: AutonomyRepository, limit: number): ReadonlySet<string> {
  return new Set(
    repository.listCurrentHeldProjectClaims(limit)
      .map((claim) => claim.resourceKey),
  );
}

export type PausedProjectSource = { listPausedProjectAdmissions(): { projectId: string }[] };

export class AutonomyScheduler {
  public constructor(
    private readonly repository: AutonomyRepository,
    private readonly pauses?: PausedProjectSource,
  ) {}

  /**
   * null means the pause list could not be read. Admitting nothing for one tick
   * is recoverable; admitting into a project that is paused because it keeps
   * failing is not, so an unreadable list must never look like "nothing paused".
   */
  private pausedProjectIds(): ReadonlySet<string> | null {
    if (!this.pauses) return new Set();
    try {
      return new Set(this.pauses.listPausedProjectAdmissions().map((entry) => entry.projectId));
    } catch {
      return null;
    }
  }

  public run(input: SchedulerRunInput): SchedulerRunResult {
    assertSchedulerInput(input);
    const occupiedCount = this.repository.countOccupiedAdmissions();
    const availableSlots = Math.max(0, input.maxConcurrentJobs - occupiedCount);
    if (availableSlots === 0) return { occupiedCount, availableSlots, admissions: [] };
    const pausedProjectIds = this.pausedProjectIds();
    if (pausedProjectIds === null) return { occupiedCount, availableSlots, admissions: [] };

    const candidateLimit = occupiedCount + availableSlots;
    const candidates = this.repository.listOldestQueuedPerProject(candidateLimit).map((admission) => ({
      jobId: admission.jobId,
      projectId: admission.projectId,
      queueSeq: admission.queueSeq,
    }));
    const selected = selectOldestEligibleAdmissions({
      candidates,
      heldProjectKeys: heldProjectKeys(this.repository, Math.min(100, Math.max(1, candidateLimit))),
      availableSlots,
      pausedProjectIds,
    });
    const admissions = selected.map((candidate) => this.repository.tryAdmit({ ...input, jobId: candidate.jobId }));
    return { occupiedCount, availableSlots, admissions };
  }
}
