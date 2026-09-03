import { redactError } from "../errors";
import type { MonitorThreadStatus } from "./monitor-service";
import type { JobMemoryExtractionRecord, MemoryKind, TelegramAgentStore } from "../storage/store";
import type { ModelRoute } from "../capabilities/models";

/**
 * Jobs are the only place this plugin spends inference of its own. A finished
 * job is where the durable lessons live — the command that always fails on this
 * repo, the review finding that keeps coming back — so one short extraction
 * runs per finished job, and nothing runs per chat message.
 */
export const MEMORABLE_JOB_OUTCOMES = ["merged", "complete", "blocked", "production_failed"] as const;

const ENROL_BATCH = 10;
// One extraction thread at a time: this is background learning, and it must
// never compete with the owner's actual work for provider capacity.
const MAX_IN_FLIGHT = 1;
const MAX_ATTEMPTS = 2;
// A thread that hangs `active`, or whose host disappears so every status poll
// throws, would otherwise hold the single in-flight slot forever and silently
// stop the agent ever learning again.
export const EXTRACTION_TIMEOUT_MS = 30 * 60_000;
const MAX_MEMORIES_PER_JOB = 3;
const MAX_EXTRACTION_OUTPUT = 64 * 1024;
const MAX_SUBJECT = 120;
const MAX_BODY = 1_000;
// Extracted memories are a guess about a pattern, not something the owner said,
// so they start below anything stated directly and earn their place by surviving.
const EXTRACTED_CONFIDENCE = 0.5;
const EXTRACTED_IMPORTANCE = 0.4;

export type JobMemoryThreads = {
  spawnHidden(input: { projectId: string; title: string; prompt: string; modelRoute: ModelRoute }): Promise<string>;
  status(threadId: string): Promise<MonitorThreadStatus>;
  output(threadId: string): Promise<string>;
};

export type JobMemoryServiceDependencies = {
  store: Pick<
    TelegramAgentStore,
    | "enrolFinishedJobsForMemory"
    | "listJobMemoryExtractions"
    | "startJobMemoryExtraction"
    | "recordJobMemoryExtractionFailure"
    | "completeJobMemoryExtraction"
    | "recordJobMemorySaved"
    | "failJobMemoryExtraction"
    | "getJob"
    | "rememberMemory"
    | "recordModelRouteSelection"
  >;
  threads: JobMemoryThreads;
  modelRoute(): ModelRoute;
  clock: { now(): number };
  warn?: (message: string) => void;
};

const MEMORY_KINDS: ReadonlySet<string> = new Set<MemoryKind>([
  "preference", "fact", "decision", "correction",
]);

export function buildExtractionPrompt(input: {
  projectId: string;
  outcome: string;
  request: string;
  blockedReason: string | null;
  lastError: string | null;
}): string {
  const context = [
    `Project: ${input.projectId}`,
    `Outcome: ${input.outcome}`,
    `What was asked: ${input.request}`,
    input.blockedReason ? `Why it blocked: ${input.blockedReason}` : null,
    input.lastError ? `Last error: ${input.lastError}` : null,
  ].filter((line): line is string => line !== null).join("\n");
  return `A piece of work on this repository just finished. Read the repository as needed and decide what is worth remembering about *this project* for next time.

${context}

Record only durable, reusable facts: a command that must be run a certain way here, a check that always fails for a known reason, a convention this repo enforces, a place work keeps going wrong. Do not record what happened this once, anything about the person who asked, or anything you could read again in seconds.

Reply with strict JSON and nothing else — no prose, no Markdown fence:

{"memories":[{"kind":"fact","subject":"short label","body":"the durable lesson"}]}

Use at most ${MAX_MEMORIES_PER_JOB} entries, and an empty array when there is genuinely nothing durable to learn. "kind" is one of preference, fact, decision, correction.`;
}

type ParsedMemory = { kind: MemoryKind; subject: string; body: string };

/**
 * The extraction thread is asked for strict JSON, but it is still a model: a
 * fence, a preamble, or a malformed entry must lose that entry rather than the
 * whole extraction, and must never throw into the executor loop.
 */
export function parseExtractedMemories(output: string): ParsedMemory[] {
  // Thread output is unbounded and untrusted. A megabyte of it would make the
  // replace below throw RangeError *outside* any caller's try, unwinding the
  // executor loop; the answer we want is never past the first few hundred bytes.
  if (typeof output !== "string") return [];
  const bounded = output.length > MAX_EXTRACTION_OUTPUT ? output.slice(0, MAX_EXTRACTION_OUTPUT) : output;
  const fenced = bounded.replace(/```(?:json)?/gi, " ");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return [];
  }
  const entries = (parsed as { memories?: unknown })?.memories;
  if (!Array.isArray(entries)) return [];
  const memories: ParsedMemory[] = [];
  // The cap counts usable lessons, not attempts: a malformed entry must not
  // spend a slot a real one could have used.
  for (const entry of entries) {
    if (memories.length >= MAX_MEMORIES_PER_JOB) break;
    if (typeof entry !== "object" || entry === null) continue;
    const { kind, subject, body } = entry as Record<string, unknown>;
    if (typeof subject !== "string" || typeof body !== "string") continue;
    const trimmedSubject = subject.replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT);
    const trimmedBody = body.replace(/\s+/g, " ").trim().slice(0, MAX_BODY);
    if (trimmedSubject.length === 0 || trimmedBody.length === 0) continue;
    memories.push({
      kind: typeof kind === "string" && MEMORY_KINDS.has(kind) ? kind as MemoryKind : "fact",
      subject: trimmedSubject,
      body: trimmedBody,
    });
  }
  return memories;
}

export class JobMemoryService {
  public constructor(private readonly dependencies: JobMemoryServiceDependencies) {}

  public async processDue(): Promise<boolean> {
    const now = this.dependencies.clock.now();
    this.dependencies.store.enrolFinishedJobsForMemory([...MEMORABLE_JOB_OUTCOMES], ENROL_BATCH, now);
    const running = this.dependencies.store.listJobMemoryExtractions("running", MAX_IN_FLIGHT);
    if (running.length > 0) return this.collect(running[0] as JobMemoryExtractionRecord);
    const pending = this.dependencies.store.listJobMemoryExtractions("pending", 1);
    const next = pending[0];
    return next ? await this.start(next) : false;
  }

  private async start(extraction: JobMemoryExtractionRecord): Promise<boolean> {
    const now = this.dependencies.clock.now();
    if (extraction.attempts >= MAX_ATTEMPTS) {
      return this.dependencies.store.failJobMemoryExtraction({
        jobId: extraction.jobId,
        error: "Memory extraction ran out of attempts",
        now,
      });
    }
    const job = this.dependencies.store.getJob(extraction.jobId);
    if (!job) {
      return this.dependencies.store.failJobMemoryExtraction({
        jobId: extraction.jobId,
        error: "Job is no longer available to learn from",
        now,
      });
    }
    let threadId: string;
    try {
      const modelRoute = this.dependencies.modelRoute();
      // This durable selection precedes spawn. Retrying the same extraction
      // attempt with a different tuple is rejected by the repository.
      this.dependencies.store.recordModelRouteSelection({
        subjectKind: "worker_attempt",
        subjectId: `memory:${extraction.jobId}`,
        attempt: extraction.attempts + 1,
        stage: "extraction",
        operation: "spawn-memory",
        route: modelRoute,
        now,
      });
      threadId = await this.dependencies.threads.spawnHidden({
        projectId: extraction.projectId,
        title: `Telegram Agent memory extraction ${extraction.jobId}`,
        prompt: buildExtractionPrompt({
          projectId: extraction.projectId,
          outcome: extraction.outcome,
          request: job.requestText,
          blockedReason: job.blockedReason,
          lastError: job.lastError,
        }),
        modelRoute,
      });
    } catch (error) {
      const detail = redactError(error).slice(0, 200);
      this.dependencies.warn?.(`Memory extraction for ${extraction.jobId} could not start: ${detail}`);
      if (/404|project not found/i.test(detail)) {
        return this.dependencies.store.failJobMemoryExtraction({
          jobId: extraction.jobId,
          error: `Memory extraction could not start: ${detail}`.slice(0, 500),
          now: this.dependencies.clock.now(),
        });
      }
      // Counted, so a project that will never come back stops being retried.
      return this.dependencies.store.recordJobMemoryExtractionFailure({
        jobId: extraction.jobId,
        error: `Memory extraction could not start: ${detail}`,
        now: this.dependencies.clock.now(),
      });
    }
    return this.dependencies.store.startJobMemoryExtraction({
      jobId: extraction.jobId,
      threadId,
      now: this.dependencies.clock.now(),
    });
  }

  private async collect(extraction: JobMemoryExtractionRecord): Promise<boolean> {
    if (!extraction.threadId) {
      return this.dependencies.store.failJobMemoryExtraction({
        jobId: extraction.jobId,
        error: "Memory extraction lost its thread",
        now: this.dependencies.clock.now(),
      });
    }
    const expired = this.dependencies.clock.now() - extraction.updatedAt >= EXTRACTION_TIMEOUT_MS;
    let status: MonitorThreadStatus;
    try {
      status = await this.dependencies.threads.status(extraction.threadId);
    } catch (error) {
      this.dependencies.warn?.(
        `Memory extraction ${extraction.jobId} could not be checked: ${redactError(error).slice(0, 200)}`,
      );
      return expired && this.dependencies.store.failJobMemoryExtraction({
        jobId: extraction.jobId,
        error: "Memory extraction could not be checked before its deadline",
        now: this.dependencies.clock.now(),
      });
    }
    if (status === "active" || status === "pending" || status === "starting" || status === "stopping") {
      return expired && this.dependencies.store.failJobMemoryExtraction({
        jobId: extraction.jobId,
        error: "Memory extraction outlived its deadline",
        now: this.dependencies.clock.now(),
      });
    }
    const now = this.dependencies.clock.now();
    if (status !== "idle") {
      return this.dependencies.store.failJobMemoryExtraction({
        jobId: extraction.jobId,
        error: "Memory extraction thread ended without an answer",
        now,
      });
    }
    let output: string;
    try {
      output = await this.dependencies.threads.output(extraction.threadId);
    } catch {
      return false;
    }
    const lessons = parseExtractedMemories(output);
    // Claim the row before writing anything, the way the monitor and delegation
    // passes do. Writing first leaves the row `running` across every write, so
    // a crash mid-loop replays the whole extraction and supersedes each lesson
    // with an identical copy. Losing a lesson is recoverable; duplicating one
    // churns the scope's eviction cap for nothing.
    if (!this.dependencies.store.completeJobMemoryExtraction({
      jobId: extraction.jobId,
      savedCount: 0,
      now,
    })) return false;
    let saved = 0;
    for (const memory of lessons) {
      try {
        this.dependencies.store.rememberMemory({
          scope: extraction.projectId,
          kind: memory.kind,
          subject: memory.subject,
          body: memory.body,
          importance: EXTRACTED_IMPORTANCE,
          confidence: EXTRACTED_CONFIDENCE,
          source: "agent",
          origin: "job_outcome",
          now,
        });
        saved += 1;
      } catch {
        // One unusable entry — a duplicate subject, an unsafe body — costs that
        // entry, not the rest of what the extraction learned.
      }
    }
    this.dependencies.store.recordJobMemorySaved({ jobId: extraction.jobId, savedCount: saved, now });
    return true;
  }
}
