import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { CONTROLLER_STALL_MS } from "../controller/service";
import { isUnsafeProviderText } from "../controller/credential-policy";
import { assertSafeFailureSummary } from "../domain/state-machine";
import type { ModelRoute } from "../capabilities/models";

export const SELF_DIAGNOSIS_INTERVAL_MS = 15 * 60_000;
export const SELF_DIAGNOSIS_COOLDOWN_MS = 24 * 60 * 60_000;
export const SELF_DIAGNOSIS_SERVICE_NAME = "self-diagnosis";
export const SELF_DIAGNOSIS_PR_TITLE_PREFIX = "Self-diagnosis candidate fix";

const MAX_CANDIDATES = 10;
const MAX_LEDGER_RECORDS = 100;
const MAX_WORKER_OUTPUT = 16_000;

export type SelfDiagnosisFailureKind =
  | "failed_turn"
  | "missing_finalization"
  | "stalled_turn"
  | "failed_thread";

export type SelfDiagnosisCandidate = {
  sourceId: string;
  turnId: string | null;
  kind: SelfDiagnosisFailureKind;
  state: string;
  threadState: string;
  updatedAt: number;
  ageMs: number;
  lastError: string | null;
  streamPhase: string | null;
  acceptedFinalization: boolean;
  completionContinuations: number;
  eventSeq: number;
  evidenceSeq: number;
  toolCalls: number;
  commandFailures: number;
};

export type StructuredSelfDiagnosis = {
  whatFailed: string;
  evidence: string[];
  hypothesis: string;
  candidateFix: string;
};

export type SelfDiagnosisLedgerRecord = {
  sourceId: string;
  diagnosisId: string;
  kind: SelfDiagnosisFailureKind;
  attemptedAt: number;
  outcome: "started" | "failed" | "published";
  diagnosis: StructuredSelfDiagnosis | null;
  prUrl: string | null;
};

export type SelfDiagnosisLedgerState = {
  version: 1;
  lastAttemptAt: number | null;
  records: SelfDiagnosisLedgerRecord[];
};

export type SelfDiagnosisLedger = {
  get(): Promise<SelfDiagnosisLedgerState | undefined>;
  set(state: SelfDiagnosisLedgerState): Promise<void>;
};

export type SelfDiagnosisTarget = {
  projectId: string;
  baseBranch: string;
  hostId: string;
  cwd: string | null;
};

export type SelfDiagnosisOpenPullRequest = {
  number: number;
  url: string;
};

export type SelfDiagnosisAnalysisResult = {
  diagnosis: unknown;
  environmentId: string;
  environmentStatus: unknown;
};

export type SelfDiagnosisPublishResult =
  | { outcome: "published"; number: number; url: string }
  | { outcome: "missing"; reason: string };

export type SelfDiagnosisServiceDependencies = {
  enabled(): boolean;
  readCandidates(): SelfDiagnosisCandidate[];
  resolveTarget(): Promise<SelfDiagnosisTarget | null>;
  ledger: SelfDiagnosisLedger;
  github: {
    listOpen(target: SelfDiagnosisTarget): Promise<readonly SelfDiagnosisOpenPullRequest[] | null>;
  };
  analyze(input: {
    candidate: SelfDiagnosisCandidate;
    target: SelfDiagnosisTarget;
    diagnosisId: string;
    prompt: string;
    modelRoute: ModelRoute;
    signal: AbortSignal;
  }): Promise<SelfDiagnosisAnalysisResult>;
  publish(input: {
    candidate: SelfDiagnosisCandidate;
    diagnosisId: string;
    diagnosis: StructuredSelfDiagnosis;
    target: SelfDiagnosisTarget;
    environmentId: string;
    environmentStatus: unknown;
    signal: AbortSignal;
  }): Promise<SelfDiagnosisPublishResult>;
  modelRoute(): ModelRoute;
  clock: { now(): number };
  warn?: (message: string) => void;
  idFactory?: () => string;
};

export type SelfDiagnosisRunResult =
  | { outcome: "disabled" | "no-failure" | "cooldown" | "open-pr" | "already-attempted" }
  | { outcome: "target-unavailable" | "github-unavailable" | "failed-open"; reason: string }
  | { outcome: "failed"; reason: string }
  | { outcome: "published"; number: number; url: string };

const structuredDiagnosisSchema = z.object({
  whatFailed: z.string().trim().min(1).max(600),
  evidence: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
  hypothesis: z.string().trim().min(1).max(800),
  candidateFix: z.string().trim().min(1).max(800),
}).strict();

function emptyLedger(): SelfDiagnosisLedgerState {
  return { version: 1, lastAttemptAt: null, records: [] };
}

function parseLedgerRecord(raw: unknown): SelfDiagnosisLedgerRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Partial<SelfDiagnosisLedgerRecord>;
  if (
    typeof candidate.sourceId !== "string" || candidate.sourceId.length === 0 || candidate.sourceId.length > 200 ||
    typeof candidate.diagnosisId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(candidate.diagnosisId) ||
    typeof candidate.kind !== "string" || !isFailureKind(candidate.kind) ||
    typeof candidate.attemptedAt !== "number" || !Number.isFinite(candidate.attemptedAt) ||
    (candidate.outcome !== "started" && candidate.outcome !== "failed" && candidate.outcome !== "published") ||
    (candidate.prUrl !== null && typeof candidate.prUrl !== "string")
  ) return null;
  const diagnosis = candidate.diagnosis === null || candidate.diagnosis === undefined
    ? null
    : normalizeStructuredDiagnosis(candidate.diagnosis);
  return {
    sourceId: candidate.sourceId,
    diagnosisId: candidate.diagnosisId,
    kind: candidate.kind,
    attemptedAt: candidate.attemptedAt,
    outcome: candidate.outcome,
    diagnosis,
    prUrl: candidate.prUrl ?? null,
  };
}

function validLedger(value: unknown): SelfDiagnosisLedgerState {
  if (typeof value !== "object" || value === null) return emptyLedger();
  const record = value as Partial<SelfDiagnosisLedgerState>;
  if (record.version !== 1 || !Array.isArray(record.records)) return emptyLedger();
  const lastAttemptAt = typeof record.lastAttemptAt === "number" && Number.isFinite(record.lastAttemptAt)
    ? record.lastAttemptAt
    : null;
  const records: SelfDiagnosisLedgerRecord[] = [];
  for (const raw of record.records) {
    if (records.length >= MAX_LEDGER_RECORDS) break;
    const parsedRecord = parseLedgerRecord(raw);
    if (parsedRecord) records.push(parsedRecord);
  }
  return { version: 1, lastAttemptAt, records };
}

function isFailureKind(value: string): value is SelfDiagnosisFailureKind {
  return value === "failed_turn" || value === "missing_finalization" || value === "stalled_turn" || value === "failed_thread";
}

function safePersistedError(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const compact = value.replace(/\s+/g, " ").trim().slice(0, 500);
  try {
    assertSafeFailureSummary(compact);
    if (isUnsafeProviderText(compact)) return null;
    return compact;
  } catch {
    return null;
  }
}

function integerOrZero(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function rowCandidate(row: Record<string, unknown>, now: number): SelfDiagnosisCandidate | null {
  const sourceId = typeof row.source_id === "string" ? row.source_id : null;
  const kind = typeof row.kind === "string" && isFailureKind(row.kind) ? row.kind : null;
  const updatedAt = typeof row.updated_at === "number" && Number.isSafeInteger(row.updated_at)
    ? row.updated_at
    : null;
  if (!sourceId || !kind || updatedAt === null) return null;
  return {
    sourceId,
    turnId: typeof row.turn_id === "string" ? row.turn_id : null,
    kind,
    state: typeof row.turn_state === "string" ? row.turn_state : "unknown",
    threadState: typeof row.thread_state === "string" ? row.thread_state : "unknown",
    updatedAt,
    ageMs: Math.max(0, now - updatedAt),
    lastError: safePersistedError(row.last_error),
    streamPhase: typeof row.stream_phase === "string" ? row.stream_phase : null,
    acceptedFinalization: row.accepted_finalization_id !== null && row.accepted_finalization_id !== undefined,
    completionContinuations: integerOrZero(row.completion_continuations),
    eventSeq: integerOrZero(row.bb_event_seq),
    evidenceSeq: integerOrZero(row.evidence_seq),
    toolCalls: integerOrZero(row.tool_calls),
    commandFailures: integerOrZero(row.command_failures),
  };
}

const SELF_DIAGNOSIS_QUERY = `
  SELECT * FROM (
    SELECT CASE
             WHEN turn.state = 'failed' OR turn.last_error IS NOT NULL THEN 'failed_turn'
             WHEN turn.state = 'completed' THEN 'missing_finalization'
             ELSE 'stalled_turn'
           END AS kind,
           turn.id AS source_id,
           turn.id AS turn_id,
           turn.state AS turn_state,
           controller.state AS thread_state,
           turn.updated_at AS updated_at,
           turn.last_error AS last_error,
           turn.stream_phase AS stream_phase,
           turn.accepted_finalization_id AS accepted_finalization_id,
           turn.completion_continuations AS completion_continuations,
           turn.bb_event_seq AS bb_event_seq,
           COALESCE((SELECT MAX(evidence.id) FROM controller_evidence AS evidence WHERE evidence.turn_id = turn.id), 0) AS evidence_seq,
           turn.tool_calls AS tool_calls,
           turn.command_failures AS command_failures
      FROM controller_turns AS turn
      JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
     WHERE turn.state = 'failed'
        OR turn.last_error IS NOT NULL
        OR (turn.state = 'completed' AND turn.accepted_finalization_id IS NULL)
        OR (
          turn.state IN ('dispatching', 'submitted')
          AND turn.accepted_finalization_id IS NULL
          AND turn.updated_at <= @stalledBefore
        )

    UNION ALL

    SELECT 'failed_thread' AS kind,
           controller.controller_key AS source_id,
           NULL AS turn_id,
           'none' AS turn_state,
           controller.state AS thread_state,
           controller.updated_at AS updated_at,
           controller.last_error AS last_error,
           NULL AS stream_phase,
           NULL AS accepted_finalization_id,
           0 AS completion_continuations,
           0 AS bb_event_seq,
           0 AS evidence_seq,
           0 AS tool_calls,
           0 AS command_failures
      FROM controller_threads AS controller
     WHERE controller.last_error IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM controller_turns AS turn
          WHERE turn.controller_key = controller.controller_key
            AND turn.state = 'failed'
       )
  ) AS candidates
  ORDER BY updated_at ASC, source_id ASC, kind ASC
  LIMIT @limit`;

/** Read only the already-persisted controller state. No hot-path hooks write to
 * this feature and no user message or provider response is selected. */
export function findSelfDiagnosisCandidates(
  db: Database.Database,
  now: number,
  limit = MAX_CANDIDATES,
): SelfDiagnosisCandidate[] {
  const boundedLimit = Math.max(1, Math.min(MAX_CANDIDATES, Math.floor(limit)));
  const rows = db.prepare(SELF_DIAGNOSIS_QUERY).all({
    stalledBefore: now - CONTROLLER_STALL_MS,
    limit: boundedLimit,
  }) as Record<string, unknown>[];
  return rows
    .map((row) => rowCandidate(row, now))
    .filter((value): value is SelfDiagnosisCandidate => value !== null);
}

function candidateEvidenceLines(candidate: SelfDiagnosisCandidate): string[] {
  return [
    `failure_kind=${candidate.kind}`,
    `turn_state=${candidate.state}`,
    `thread_state=${candidate.threadState}`,
    `age_ms=${candidate.ageMs}`,
    `stream_phase=${candidate.streamPhase ?? "none"}`,
    `accepted_finalization=${candidate.acceptedFinalization ? "true" : "false"}`,
    `completion_continuations=${candidate.completionContinuations}`,
    `bb_event_seq=${candidate.eventSeq}`,
    `evidence_seq=${candidate.evidenceSeq}`,
    `tool_calls=${candidate.toolCalls}`,
    `command_failures=${candidate.commandFailures}`,
    `last_error=${candidate.lastError ?? "unavailable"}`,
  ];
}

export function buildSelfDiagnosisPrompt(candidate: SelfDiagnosisCandidate): string {
  const evidence = candidateEvidenceLines(candidate);
  return `You are an out-of-band maintainer diagnosing one persisted controller failure. Work only in this repository's fresh managed worktree. Inspect the code and make the smallest candidate fix with focused tests when the cause is clear.

The following evidence comes from persisted controller state. It contains no owner message, Telegram identifiers, conversation transcript, or provider output:
${evidence.join("\n")}

Do not inspect, copy, or generate chat contents, personal data, credentials, tokens, callback material, or identifiers belonging to a user. Do not commit, push, open, modify, merge, or close a pull request. Do not change controller storage or runtime behavior outside the candidate code fix.

Return strict JSON and nothing else:
{"whatFailed":"code-level description","evidence":["code-level evidence"],"hypothesis":"code-level cause","candidateFix":"minimal code and test change"}

Every field must describe repository behavior only. Do not include raw error text when it could contain anything other than a safe failure summary.`;
}

export function parseSelfDiagnosisOutput(output: string): StructuredSelfDiagnosis | null {
  if (typeof output !== "string" || output.length > MAX_WORKER_OUTPUT) return null;
  const trimmed = output.trim();
  if (trimmed.length === 0 || trimmed.startsWith("```") || trimmed.endsWith("```")) return null;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return normalizeStructuredDiagnosis(parsedJson);
}

function normalizeStructuredDiagnosis(value: unknown): StructuredSelfDiagnosis | null {
  const parsed = structuredDiagnosisSchema.safeParse(value);
  if (!parsed.success) return null;
  const diagnosis = {
    whatFailed: parsed.data.whatFailed.replace(/\s+/g, " ").trim(),
    evidence: parsed.data.evidence.map((item) => item.replace(/\s+/g, " ").trim()),
    hypothesis: parsed.data.hypothesis.replace(/\s+/g, " ").trim(),
    candidateFix: parsed.data.candidateFix.replace(/\s+/g, " ").trim(),
  };
  if ([diagnosis.whatFailed, diagnosis.hypothesis, diagnosis.candidateFix, ...diagnosis.evidence]
    .some((item) => isUnsafeProviderText(item))) return null;
  return diagnosis;
}

/** The PR body deliberately contains no model prose. The full structured
 * diagnosis is retained in the bounded ledger and represented here by a digest
 * so no chat-like or personal text can cross into GitHub output. */
export function buildSelfDiagnosisPullRequestBody(input: {
  diagnosisId: string;
  candidate: SelfDiagnosisCandidate;
  diagnosis: StructuredSelfDiagnosis;
}): string {
  const diagnosisDigest = diagnosisDigestHex(input.diagnosis);
  const evidence = candidateEvidenceLines(input.candidate).slice(1, -1);
  return [
    "<!-- bb-self-diagnosis -->",
    "Automated candidate fix from a persisted controller failure.",
    `Diagnosis ID: ${input.diagnosisId}`,
    `Failure kind: ${input.candidate.kind}`,
    "",
    "What failed: a persisted controller state crossed the failure boundary above.",
    "Evidence:",
    ...evidence.map((evidenceLine) => `- ${evidenceLine}`),
    "",
    "Hypothesis: the controller reached this persisted boundary without a safe accepted finalization.",
    "Candidate fix: review the minimal code and tests in this draft.",
    `Structured diagnosis digest: ${diagnosisDigest}`,
  ].join("\n").slice(0, 2_000);
}

function diagnosisDigestHex(diagnosis: StructuredSelfDiagnosis): string {
  return createHash("sha256")
    .update(JSON.stringify(diagnosis), "utf8")
    .digest("hex")
    .slice(0, 16);
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type SelectedSelfDiagnosis = {
  candidate: SelfDiagnosisCandidate;
  ledgerState: SelfDiagnosisLedgerState;
  attemptedAt: number;
};

type ClaimedSelfDiagnosis = SelectedSelfDiagnosis & {
  target: SelfDiagnosisTarget;
  diagnosisId: string;
};

type AnalyzedSelfDiagnosis = ClaimedSelfDiagnosis & {
  analysis: SelfDiagnosisAnalysisResult;
  diagnosis: StructuredSelfDiagnosis;
};

export class SelfDiagnosisService {
  private running = false;

  public constructor(private readonly dependencies: SelfDiagnosisServiceDependencies) {}

  public async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (!this.dependencies.enabled()) return;
      try {
        await this.runOnce(signal);
      } catch {
        this.dependencies.warn?.("Self-diagnosis pass failed open");
      }
      if (signal.aborted || !this.dependencies.enabled()) return;
      await abortableDelay(SELF_DIAGNOSIS_INTERVAL_MS, signal);
    }
  }

  public async runOnce(signal = new AbortController().signal): Promise<SelfDiagnosisRunResult> {
    if (this.running) return { outcome: "already-attempted" };
    this.running = true;
    try {
      return await this.runOnceGuarded(signal);
    } finally {
      this.running = false;
    }
  }

  private async runOnceGuarded(signal: AbortSignal): Promise<SelfDiagnosisRunResult> {
    if (!this.dependencies.enabled() || signal.aborted) return { outcome: "disabled" };
    const selected = await this.selectCandidate();
    if (!this.isSelectedSelfDiagnosis(selected)) return selected;
    const claimed = await this.claimAttempt(selected, signal);
    if (!this.isClaimedSelfDiagnosis(claimed)) return claimed;
    const analyzed = await this.analyzeAttempt(claimed, signal);
    if (!this.isAnalyzedSelfDiagnosis(analyzed)) return analyzed;
    return this.publishAttempt(analyzed, signal);
  }

  private async selectCandidate(): Promise<SelectedSelfDiagnosis | SelfDiagnosisRunResult> {
    try {
      const candidates = this.dependencies.readCandidates();
      const ledgerState = validLedger(await this.dependencies.ledger.get());
      const selected = candidates.find((candidate) => !ledgerState.records.some(
        (record) => record.sourceId === candidate.sourceId,
      ));
      if (!selected) return { outcome: candidates.length > 0 ? "already-attempted" : "no-failure" };
      const attemptedAt = this.dependencies.clock.now();
      if (ledgerState.lastAttemptAt !== null && attemptedAt - ledgerState.lastAttemptAt < SELF_DIAGNOSIS_COOLDOWN_MS) {
        return { outcome: "cooldown" };
      }
      return { candidate: selected, ledgerState, attemptedAt };
    } catch {
      this.dependencies.warn?.("Self-diagnosis could not read persisted state");
      return { outcome: "failed-open", reason: "persisted state unavailable" };
    }
  }

  private async claimAttempt(
    selected: SelectedSelfDiagnosis,
    signal: AbortSignal,
  ): Promise<ClaimedSelfDiagnosis | SelfDiagnosisRunResult> {
    if (!this.dependencies.enabled() || signal.aborted) return { outcome: "disabled" };
    let target: SelfDiagnosisTarget | null;
    try {
      target = await this.dependencies.resolveTarget();
    } catch {
      return { outcome: "target-unavailable", reason: "diagnosis project unavailable" };
    }
    if (!target) return { outcome: "target-unavailable", reason: "diagnosis project unavailable" };
    let openPullRequests: readonly SelfDiagnosisOpenPullRequest[] | null;
    try {
      openPullRequests = await this.dependencies.github.listOpen(target);
    } catch {
      return { outcome: "github-unavailable", reason: "open pull requests could not be checked" };
    }
    if (openPullRequests === null) return { outcome: "github-unavailable", reason: "open pull requests could not be checked" };
    if (openPullRequests.length > 0) return { outcome: "open-pr" };
    if (!this.dependencies.enabled() || signal.aborted) return { outcome: "disabled" };
    const diagnosisId = createDiagnosisId(this.dependencies.idFactory);
    if (!diagnosisId) return { outcome: "failed-open", reason: "diagnosis id unavailable" };
    const claimedState = addLedgerAttempt(selected, diagnosisId);
    try {
      await this.dependencies.ledger.set(claimedState);
    } catch {
      this.dependencies.warn?.("Self-diagnosis could not claim its bounded attempt");
      return { outcome: "failed-open", reason: "attempt ledger unavailable" };
    }
    return { ...selected, target, diagnosisId, ledgerState: claimedState };
  }

  private async analyzeAttempt(
    claimed: ClaimedSelfDiagnosis,
    signal: AbortSignal,
  ): Promise<AnalyzedSelfDiagnosis | SelfDiagnosisRunResult> {
    if (!this.dependencies.enabled() || signal.aborted) return { outcome: "disabled" };
    let analysis: SelfDiagnosisAnalysisResult;
    try {
      analysis = await this.dependencies.analyze({
        candidate: claimed.candidate,
        target: claimed.target,
        diagnosisId: claimed.diagnosisId,
        prompt: buildSelfDiagnosisPrompt(claimed.candidate),
        modelRoute: this.dependencies.modelRoute(),
        signal,
      });
    } catch {
      if (signal.aborted) return { outcome: "disabled" };
      this.dependencies.warn?.("Self-diagnosis analysis failed open");
      await this.recordFailure(claimed.ledgerState, claimed.diagnosisId, null);
      return { outcome: "failed", reason: "analysis failed" };
    }
    if (!this.dependencies.enabled() || signal.aborted) return { outcome: "disabled" };
    const diagnosis = normalizeStructuredDiagnosis(analysis.diagnosis);
    if (!diagnosis) {
      await this.recordFailure(claimed.ledgerState, claimed.diagnosisId, null);
      return { outcome: "failed", reason: "analysis did not return a safe structured diagnosis" };
    }
    try {
      await this.updateRecord(claimed.ledgerState, claimed.diagnosisId, { outcome: "started", diagnosis, prUrl: null });
    } catch {
      this.dependencies.warn?.("Self-diagnosis could not retain its diagnosis");
      return { outcome: "failed-open", reason: "diagnosis ledger unavailable" };
    }
    return { ...claimed, analysis, diagnosis };
  }

  private async publishAttempt(
    analyzed: AnalyzedSelfDiagnosis,
    signal: AbortSignal,
  ): Promise<SelfDiagnosisRunResult> {
    if (!this.dependencies.enabled() || signal.aborted) return { outcome: "disabled" };
    let openPullRequests: readonly SelfDiagnosisOpenPullRequest[] | null;
    try {
      openPullRequests = await this.dependencies.github.listOpen(analyzed.target);
    } catch {
      await this.recordFailure(analyzed.ledgerState, analyzed.diagnosisId, analyzed.diagnosis);
      return { outcome: "github-unavailable", reason: "open pull requests could not be checked" };
    }
    if (openPullRequests === null) {
      await this.recordFailure(analyzed.ledgerState, analyzed.diagnosisId, analyzed.diagnosis);
      return { outcome: "github-unavailable", reason: "open pull requests could not be checked" };
    }
    if (openPullRequests.length > 0) {
      await this.recordFailure(analyzed.ledgerState, analyzed.diagnosisId, analyzed.diagnosis);
      return { outcome: "open-pr" };
    }
    let published: SelfDiagnosisPublishResult;
    try {
      published = await this.dependencies.publish({
        candidate: analyzed.candidate,
        diagnosisId: analyzed.diagnosisId,
        diagnosis: analyzed.diagnosis,
        target: analyzed.target,
        environmentId: analyzed.analysis.environmentId,
        environmentStatus: analyzed.analysis.environmentStatus,
        signal,
      });
    } catch {
      if (signal.aborted) return { outcome: "disabled" };
      this.dependencies.warn?.("Self-diagnosis pull-request publish failed open");
      await this.recordFailure(analyzed.ledgerState, analyzed.diagnosisId, analyzed.diagnosis);
      return { outcome: "failed", reason: "publish failed" };
    }
    if (published.outcome !== "published") {
      await this.recordFailure(analyzed.ledgerState, analyzed.diagnosisId, analyzed.diagnosis);
      return { outcome: "failed", reason: published.reason };
    }
    await this.recordPublished(analyzed, published);
    return published;
  }

  private async recordPublished(
    analyzed: AnalyzedSelfDiagnosis,
    published: Extract<SelfDiagnosisPublishResult, { outcome: "published" }>,
  ): Promise<void> {
    try {
      await this.updateRecord(analyzed.ledgerState, analyzed.diagnosisId, {
        outcome: "published",
        diagnosis: analyzed.diagnosis,
        prUrl: published.url,
      });
    } catch {
      this.dependencies.warn?.("Self-diagnosis could not record its pull request");
    }
  }

  private async updateRecord(
    state: SelfDiagnosisLedgerState,
    diagnosisId: string,
    update: Pick<SelfDiagnosisLedgerRecord, "outcome" | "diagnosis" | "prUrl">,
  ): Promise<void> {
    const records = state.records.map((record) => record.diagnosisId === diagnosisId ? { ...record, ...update } : record);
    await this.dependencies.ledger.set({ ...state, records });
  }

  private async recordFailure(
    state: SelfDiagnosisLedgerState,
    diagnosisId: string,
    diagnosis: StructuredSelfDiagnosis | null,
  ): Promise<void> {
    try {
      await this.updateRecord(state, diagnosisId, { outcome: "failed", diagnosis, prUrl: null });
    } catch {
      this.dependencies.warn?.("Self-diagnosis failure could not be recorded");
    }
  }

  private isSelectedSelfDiagnosis(
    value: SelectedSelfDiagnosis | SelfDiagnosisRunResult,
  ): value is SelectedSelfDiagnosis {
    return "candidate" in value;
  }

  private isClaimedSelfDiagnosis(
    value: ClaimedSelfDiagnosis | SelfDiagnosisRunResult,
  ): value is ClaimedSelfDiagnosis {
    return "target" in value;
  }

  private isAnalyzedSelfDiagnosis(
    value: AnalyzedSelfDiagnosis | SelfDiagnosisRunResult,
  ): value is AnalyzedSelfDiagnosis {
    return "diagnosis" in value;
  }
}

function createDiagnosisId(idFactory?: () => string): string | null {
  const candidate = (idFactory?.() ?? randomBytes(8).toString("hex"))
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 80);
  return candidate.length > 0 ? candidate : null;
}

function addLedgerAttempt(selected: SelectedSelfDiagnosis, diagnosisId: string): SelfDiagnosisLedgerState {
  const attempt: SelfDiagnosisLedgerRecord = {
    sourceId: selected.candidate.sourceId,
    diagnosisId,
    kind: selected.candidate.kind,
    attemptedAt: selected.attemptedAt,
    outcome: "started",
    diagnosis: null,
    prUrl: null,
  };
  return {
    version: 1,
    lastAttemptAt: selected.attemptedAt,
    records: [...selected.ledgerState.records, attempt].slice(-MAX_LEDGER_RECORDS),
  };
}
